import {
  DEFAULT_HOOK_STDIN_MAX_BYTES,
  DEFAULT_HOOK_TRACE_POLICY,
  parseHookTracePolicy,
  sanitizeHookTraceData,
  truncateUtf8Prefix,
} from '../hookTracePolicy';

describe('hook trace policy', () => {
  describe('bounded UTF-8 prefixes', () => {
    it('is byte-accurate for ASCII, multibyte, surrogate, and invalid-surrogate boundaries', () => {
      expect(truncateUtf8Prefix('hello', 5)).toEqual({ value: 'hello', truncated: false });
      expect(truncateUtf8Prefix('hello!', 5)).toEqual({ value: 'hello', truncated: true });
      expect(truncateUtf8Prefix('ééé', 4)).toEqual({ value: 'éé', truncated: true });
      expect(truncateUtf8Prefix('😀x', 3)).toEqual({ value: '', truncated: true });
      expect(truncateUtf8Prefix('😀x', 4)).toEqual({ value: '😀', truncated: true });
      expect(truncateUtf8Prefix('\ud800A', 2)).toEqual({ value: '', truncated: true });
      expect(truncateUtf8Prefix('\ud800A', 3)).toEqual({ value: '�', truncated: true });
      expect(truncateUtf8Prefix('', 0)).toEqual({ value: '', truncated: false });
      expect(truncateUtf8Prefix('x', 0)).toEqual({ value: '', truncated: true });
    });

    it.each([
      {
        label: 'ASCII',
        huge: 'x'.repeat(16 * 1024 * 1024 + 17),
        maximumBytes: 512,
        expected: 'x'.repeat(512),
        maximumCodeUnitsCopied: 513,
      },
      {
        label: 'multibyte',
        huge: '😀'.repeat(4 * 1024 * 1024 + 3),
        maximumBytes: 512,
        expected: '😀'.repeat(128),
        maximumCodeUnitsCopied: 513,
      },
    ])('copies only a bounded prefix from a 16 MiB+ $label input', ({
      huge,
      maximumBytes,
      expected,
      maximumCodeUnitsCopied,
    }) => {
      const originalFrom = Buffer.from.bind(Buffer);
      let largestStringInput = 0;
      const from = jest.spyOn(Buffer, 'from').mockImplementation(((value: any, ...args: any[]) => {
        if (typeof value === 'string') largestStringInput = Math.max(largestStringInput, value.length);
        return (originalFrom as any)(value, ...args);
      }) as any);

      const started = performance.now();
      const result = truncateUtf8Prefix(huge, maximumBytes);
      const durationMs = performance.now() - started;
      from.mockRestore();

      expect(result).toEqual({ value: expected, truncated: true });
      expect(largestStringInput).toBeLessThanOrEqual(maximumCodeUnitsCopied);
      expect(Buffer.byteLength(result.value, 'utf8')).toBe(maximumBytes);
      expect(durationMs).toBeLessThan(500);
    });
  });

  it('summarizes a multi-megabyte Write without persisting its source body', () => {
    const content = `private-${'x'.repeat(5 * 1024 * 1024)}`;
    const data = sanitizeHookTraceData('Write', {
      file_path: 'src/large.ts',
      content,
      Authorization: 'Bearer secret-value',
    });
    const serialized = JSON.stringify(data);

    expect(Buffer.byteLength(serialized)).toBeLessThan(16 * 1024);
    expect(serialized).not.toContain('private-');
    expect(serialized).not.toContain('secret-value');
    expect(data).toMatchObject({
      tool_input: {
        filePath: 'src/large.ts',
        contentBytes: Buffer.byteLength(content),
        contentHash: expect.stringMatching(/^sha256:/),
        contentOmitted: true,
      },
      capture: {
        redactedFieldCount: 2,
        truncatedFieldCount: 0,
      },
    });
  });

  it('summarizes Edit bodies and redacts sensitive keys case-insensitively', () => {
    const data = sanitizeHookTraceData('Edit', {
      filePath: 'src/index.ts',
      old_string: 'old secret source',
      newString: 'new secret source',
      start_line: 4,
      end_line: 8,
      apiKEY: 'should-never-appear',
    });
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain('old secret source');
    expect(serialized).not.toContain('new secret source');
    expect(serialized).not.toContain('should-never-appear');
    expect(data).toMatchObject({
      tool_input: {
        filePath: 'src/index.ts',
        oldStringBytes: 17,
        oldStringOmitted: true,
        newStringBytes: 17,
        newStringOmitted: true,
        range: { start_line: 4, end_line: 8 },
      },
      capture: { redactedFieldCount: 3 },
    });
  });

  it('bounds Bash previews and unknown nested structures', () => {
    const bash = sanitizeHookTraceData('Bash', {
      command: `API_TOKEN=top-secret npm test --password hunter2 ${'x'.repeat(2000)}`,
    });
    expect(bash).toMatchObject({
      tool_input: { commandBasename: 'npm' },
      capture: { truncatedFieldCount: 1 },
    });
    expect(Buffer.byteLength(String(bash.tool_input.commandPreview))).toBeLessThan(540);
    expect(JSON.stringify(bash)).not.toContain('top-secret');
    expect(JSON.stringify(bash)).not.toContain('hunter2');

    const unknown = sanitizeHookTraceData('CustomTool', {
      Prompt: 'do not retain',
      metadata: { token: 'secret', ok: true },
      values: Array.from({ length: 50 }, (_, index) => index),
    });
    const serialized = JSON.stringify(unknown);
    expect(serialized).not.toContain('do not retain');
    expect(serialized).not.toContain('secret');
    expect(unknown.capture.redactedFieldCount).toBe(2);
    expect(unknown.capture.truncatedFieldCount).toBe(1);
  });

  it('omits pathological unknown key names and enforces the hook quota before persistence', () => {
    const secretInKey = `secret-key-material-${'private-key-fragment-'.repeat(20_000)}`;
    const data = sanitizeHookTraceData('CustomTool', {
      [secretInKey]: 'private-value-that-must-not-survive',
      stable: true,
    });
    const serialized = JSON.stringify(data);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(DEFAULT_HOOK_TRACE_POLICY.maxSerializedTraceBytes);
    expect(serialized).not.toContain('private-key-fragment');
    expect(serialized).not.toContain('private-value-that-must-not-survive');
    expect(serialized).not.toContain('secret-key-material');
    expect(data.tool_input).toMatchObject({ __redactedKey1: '[REDACTED]', stable: true });
    expect(data.capture).toMatchObject({
      persistedBytes: Buffer.byteLength(serialized, 'utf8'),
      redactedFieldCount: 1,
      quotaStatus: 'within_limit',
    });
  });

  it('collapses deep and wide unknown payloads to stable quota metadata', () => {
    const policy = {
      ...DEFAULT_HOOK_TRACE_POLICY,
      maxStringBytes: 4096,
      maxArrayItems: 100,
      maxObjectDepth: 8,
      maxSerializedTraceBytes: 1024,
    };
    let deep: Record<string, unknown> = { leaf: 'do-not-persist-'.repeat(500) };
    for (let depth = 0; depth < 20; depth += 1) deep = { nested: deep };
    const wide = Object.fromEntries(Array.from(
      { length: 200 },
      (_, index) => [`field-${index}`, { deep, value: 'sensitive-body-'.repeat(500) }]
    ));

    const first = sanitizeHookTraceData('UnknownTool', wide, policy);
    const second = sanitizeHookTraceData('UnknownTool', wide, policy);
    const serialized = JSON.stringify(first);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(policy.maxSerializedTraceBytes);
    expect(serialized).not.toContain('do-not-persist');
    expect(serialized).not.toContain('sensitive-body');
    expect(first.tool_input).toEqual({
      valuesOmitted: true,
      inputKeyCount: 200,
      quota: 'max_serialized_hook_trace_bytes',
    });
    expect(first.capture).toEqual(second.capture);
    expect(first.capture.persistedBytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(first.capture.quotaStatus).toBe('truncated');
    expect(first.capture.truncatedFieldCount).toBeGreaterThan(0);
  });

  it.each(['Write', 'Edit', 'Bash'])('bounds allowlisted metadata for known %s tools', (toolName) => {
    const marker = `must-not-survive-${'x'.repeat(100_000)}`;
    const input = toolName === 'Write'
      ? { file_path: marker, content: 'source body' }
      : toolName === 'Edit'
        ? { file_path: marker, old_string: 'old body', new_string: 'new body' }
        : { command: marker };

    const data = sanitizeHookTraceData(toolName, input);
    const serialized = JSON.stringify(data);

    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(DEFAULT_HOOK_TRACE_POLICY.maxSerializedTraceBytes);
    expect(serialized).not.toContain('x'.repeat(1000));
    expect(data.capture.persistedBytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(data.capture.truncatedFieldCount).toBeGreaterThan(0);
  });

  it('falls back to defaults and clamps malformed or unsafe configuration', () => {
    expect(parseHookTracePolicy({ maxInputBytes: 'huge' }).maxInputBytes)
      .toBe(DEFAULT_HOOK_STDIN_MAX_BYTES);
    const policy = parseHookTracePolicy({
      maxInputBytes: Number.MAX_SAFE_INTEGER,
      maxStringBytes: Number.MAX_SAFE_INTEGER,
      maxObjectDepth: -10,
      trace: { retainedSegments: Number.MAX_SAFE_INTEGER },
    });
    expect(policy.maxInputBytes).toBe(16 * 1024 * 1024);
    expect(policy.maxStringBytes).toBe(4096);
    expect(policy.maxObjectDepth).toBe(1);
    expect(policy.retainedTraceSegments).toBe(16);
    expect(DEFAULT_HOOK_TRACE_POLICY.maxSerializedTraceBytes).toBe(16 * 1024);
  });
});

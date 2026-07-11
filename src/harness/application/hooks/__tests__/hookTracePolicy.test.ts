import {
  DEFAULT_HOOK_STDIN_MAX_BYTES,
  DEFAULT_HOOK_TRACE_POLICY,
  parseHookTracePolicy,
  sanitizeHookTraceData,
} from '../hookTracePolicy';

describe('hook trace policy', () => {
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

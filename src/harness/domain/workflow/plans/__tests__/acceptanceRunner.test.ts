import { runAcceptance } from '../acceptanceRunner';

describe('runAcceptance', () => {
  const ctx = { repoPath: process.cwd() };

  it('passes when command exits 0', async () => {
    const result = await runAcceptance(
      { kind: 'shell', command: ['node', '-e', 'process.exit(0)'] },
      ctx
    );
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('fails when command exits non-zero', async () => {
    const result = await runAcceptance(
      { kind: 'shell', command: ['node', '-e', 'process.exit(3)'] },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('times out when command exceeds timeoutMs', async () => {
    const result = await runAcceptance(
      {
        kind: 'shell',
        command: ['node', '-e', 'setTimeout(()=>{}, 5000)'],
        timeoutMs: 100,
      },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it('returns a failure (no crash) for non-existent commands', async () => {
    const result = await runAcceptance(
      { kind: 'shell', command: ['definitely-not-a-real-binary-xyz'] },
      ctx
    );
    expect(result.passed).toBe(false);
    expect(result.tailStderr).toMatch(/spawn error/i);
  });

  it('captures stdout tail', async () => {
    const result = await runAcceptance(
      {
        kind: 'shell',
        command: ['node', '-e', 'process.stdout.write("hello-tail")'],
      },
      ctx
    );
    expect(result.tailStdout).toContain('hello-tail');
  });

  it('bounds stdout and stderr independently and exposes byte counters', async () => {
    const result = await runAcceptance(
      {
        kind: 'shell',
        command: [
          'node',
          '-e',
          'process.stdout.write("a".repeat(1000)); process.stderr.write("b".repeat(700))',
        ],
      },
      { ...ctx, outputLimits: { tailBytes: 64 } }
    );

    expect(Buffer.byteLength(result.tailStdout)).toBe(64);
    expect(Buffer.byteLength(result.tailStderr)).toBe(64);
    expect(result.stdoutBytes).toBe(1000);
    expect(result.stderrBytes).toBe(700);
    expect(result.stdoutDroppedBytes).toBe(936);
    expect(result.stderrDroppedBytes).toBe(636);
    expect(result.outputTruncated).toBe(true);
  });

  it('clamps an enormous acceptance tail at the domain configuration boundary', async () => {
    const result = await runAcceptance(
      {
        kind: 'shell',
        command: ['node', '-e', 'process.stdout.write("x".repeat(12 * 1024))'],
      },
      { ...ctx, outputLimits: { tailBytes: Number.MAX_SAFE_INTEGER } }
    );

    expect(result.passed).toBe(true);
    expect(Buffer.byteLength(result.tailStdout)).toBe(8 * 1024);
    expect(result.stdoutBytes).toBe(12 * 1024);
    expect(result.stdoutDroppedBytes).toBe(4 * 1024);
    expect(result.outputTruncated).toBe(true);
  });

  it('kills and reaps a child that exceeds the combined hard output limit', async () => {
    const result = await runAcceptance(
      {
        kind: 'shell',
        command: [
          'node',
          '-e',
          'const c="x".repeat(4096); for(let i=0;i<10000;i++) process.stdout.write(c)',
        ],
      },
      { ...ctx, outputLimits: { tailBytes: 128, hardCombinedOutputBytes: 32 * 1024 } }
    );

    expect(result.passed).toBe(false);
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.terminationReason).toBe('outputLimit');
    expect(result.stdoutBytes).toBeGreaterThan(32 * 1024);
    expect(Buffer.byteLength(result.tailStdout)).toBeLessThanOrEqual(128);
  });

  it('rejects an empty command array', async () => {
    await expect(
      runAcceptance({ kind: 'shell', command: [] }, ctx)
    ).rejects.toThrow(/non-empty/);
  });
});

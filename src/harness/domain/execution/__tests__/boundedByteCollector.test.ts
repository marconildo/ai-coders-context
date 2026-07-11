import {
  BoundedByteCollector,
  MAX_SAFE_SUBPROCESS_HARD_OUTPUT_BYTES,
  resolveSubprocessOutputLimits,
} from '../boundedByteCollector';

describe('BoundedByteCollector', () => {
  it('retains only the newest bytes without growing with input volume', () => {
    const collector = new BoundedByteCollector(8);
    const chunk = Buffer.alloc(1024, 'x');
    for (let i = 0; i < 100 * 1024; i += 1) {
      collector.append(chunk);
    }

    expect(collector.totalBytes).toBe(100 * 1024 * 1024);
    expect(collector.retainedBytes).toBe(8);
    expect(collector.droppedBytes).toBe(100 * 1024 * 1024 - 8);
    expect(collector.truncated).toBe(true);
    expect(collector.toString()).toBe('xxxxxxxx');
  });

  it('preserves byte ordering when writes wrap the ring', () => {
    const collector = new BoundedByteCollector(5);
    collector.append(Buffer.from('abc'));
    collector.append(Buffer.from('def'));
    collector.append(Buffer.from('gh'));

    expect(collector.toString()).toBe('defgh');
  });

  it('measures UTF-8 bytes rather than JavaScript characters', () => {
    const collector = new BoundedByteCollector(4);
    collector.append(Buffer.from('ééé', 'utf-8'));

    expect(collector.totalBytes).toBe(6);
    expect(collector.retainedBytes).toBe(4);
    expect(collector.toString()).toBe('éé');
  });

  it('clamps untrusted hard limits to 64 MiB', () => {
    const requested = MAX_SAFE_SUBPROCESS_HARD_OUTPUT_BYTES * 2;
    expect(resolveSubprocessOutputLimits({ hardCombinedOutputBytes: requested }))
      .toEqual(expect.objectContaining({
        hardCombinedOutputBytes: MAX_SAFE_SUBPROCESS_HARD_OUTPUT_BYTES,
      }));
    expect(resolveSubprocessOutputLimits({
      hardCombinedOutputBytes: requested,
      unsafeAllowAboveMaximum: true,
    })).toEqual(expect.objectContaining({ hardCombinedOutputBytes: requested }));
  });
});

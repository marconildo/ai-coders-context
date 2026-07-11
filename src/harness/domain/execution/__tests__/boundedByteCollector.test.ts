import {
  BoundedByteCollector,
  DEFAULT_SUBPROCESS_TAIL_BYTES,
  MAX_SAFE_SUBPROCESS_HARD_OUTPUT_BYTES,
  MAX_SUBPROCESS_TAIL_BYTES,
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

  it('allows callers to lower the tail but never increase it', () => {
    expect(resolveSubprocessOutputLimits({ tailBytes: 128 }).tailBytes).toBe(128);
    expect(resolveSubprocessOutputLimits({ tailBytes: Number.MAX_SAFE_INTEGER }).tailBytes)
      .toBe(MAX_SUBPROCESS_TAIL_BYTES);
    expect(resolveSubprocessOutputLimits({ tailBytes: Number.MAX_VALUE }).tailBytes)
      .toBe(MAX_SUBPROCESS_TAIL_BYTES);
    expect(resolveSubprocessOutputLimits({ tailBytes: Number.POSITIVE_INFINITY }).tailBytes)
      .toBe(DEFAULT_SUBPROCESS_TAIL_BYTES);
    expect(resolveSubprocessOutputLimits({ tailBytes: Number.NaN }).tailBytes)
      .toBe(DEFAULT_SUBPROCESS_TAIL_BYTES);
    expect(resolveSubprocessOutputLimits({ tailBytes: -100 }).tailBytes).toBe(0);
  });

  it('guards its allocation boundary when constructed directly with an enormous tail', () => {
    const collector = new BoundedByteCollector(Number.MAX_SAFE_INTEGER);
    collector.append(Buffer.alloc(DEFAULT_SUBPROCESS_TAIL_BYTES * 2, 'z'));

    expect(collector.tailBytes).toBe(MAX_SUBPROCESS_TAIL_BYTES);
    expect(collector.totalBytes).toBe(DEFAULT_SUBPROCESS_TAIL_BYTES * 2);
    expect(collector.retainedBytes).toBe(MAX_SUBPROCESS_TAIL_BYTES);
    expect(collector.droppedBytes).toBe(DEFAULT_SUBPROCESS_TAIL_BYTES);
    expect(collector.truncated).toBe(true);
    expect(collector.tail()).toHaveLength(MAX_SUBPROCESS_TAIL_BYTES);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects invalid direct-constructor tail value %p before allocation',
    (tailBytes) => {
      expect(() => new BoundedByteCollector(tailBytes)).toThrow(
        'tailBytes must be a non-negative safe integer'
      );
    }
  );
});

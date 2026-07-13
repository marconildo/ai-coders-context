import { BoundedLruCache } from '../boundedLruCache';

describe('BoundedLruCache', () => {
  it('evicts least recently used entries and rejects an oversized entry', () => {
    let now = 0;
    const cache = new BoundedLruCache<string, string>({
      maxEntries: 2,
      maxBytes: 5,
      ttlMs: 100,
      sweepIntervalMs: 0,
      now: () => now,
      estimateBytes: value => value.length,
    });
    cache.set('a', 'aa');
    cache.set('b', 'bb');
    expect(cache.get('a')).toBe('aa');
    cache.set('c', 'cc');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.set('huge', '123456')).toBe(false);
    expect(cache.metrics().estimatedBytes).toBe(4);
    cache.dispose();
  });

  it('sweeps expired entries without reading each key', () => {
    let now = 0;
    const cache = new BoundedLruCache<string, string>({
      maxEntries: 2,
      maxBytes: 10,
      ttlMs: 10,
      sweepIntervalMs: 0,
      now: () => now,
      estimateBytes: value => value.length,
    });
    cache.set('a', 'a');
    now = 11;
    expect(cache.sweepExpired()).toBe(1);
    expect(cache.size).toBe(0);
  });
});

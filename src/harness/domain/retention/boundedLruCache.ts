export type CacheEvictionReason = 'expired' | 'entries' | 'bytes' | 'replaced' | 'cleared';

export interface BoundedLruCacheOptions<K, V> {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  estimateBytes(value: V, key: K): number;
  sweepIntervalMs?: number;
  now?: () => number;
}

interface Entry<V> {
  value: V;
  bytes: number;
  createdAt: number;
  lastAccessedAt: number;
}

export interface BoundedLruCacheMetrics {
  entries: number;
  estimatedBytes: number;
  hits: number;
  misses: number;
  evictions: Record<CacheEvictionReason, number>;
  oldestAgeMs: number;
}

/** A process-local TTL/LRU cache with deterministic entry and byte ceilings. */
export class BoundedLruCache<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly now: () => number;
  private readonly timer?: NodeJS.Timeout;
  private estimatedBytes = 0;
  private hits = 0;
  private misses = 0;
  private readonly evictions: Record<CacheEvictionReason, number> = {
    expired: 0,
    entries: 0,
    bytes: 0,
    replaced: 0,
    cleared: 0,
  };

  constructor(private readonly options: BoundedLruCacheOptions<K, V>) {
    if (options.maxEntries < 1 || options.maxBytes < 1 || options.ttlMs < 1) {
      throw new Error('BoundedLruCache limits must be positive');
    }
    this.now = options.now ?? Date.now;
    const interval = options.sweepIntervalMs ?? Math.min(options.ttlMs, 60_000);
    if (interval > 0) {
      this.timer = setInterval(() => this.sweepExpired(), interval);
      this.timer.unref();
    }
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.now() - entry.lastAccessedAt >= this.options.ttlMs) {
      this.remove(key, 'expired');
      this.misses += 1;
      return undefined;
    }
    entry.lastAccessedAt = this.now();
    // Map insertion order is the LRU order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: K, value: V): boolean {
    this.sweepExpired();
    const bytes = Math.max(0, Math.ceil(this.options.estimateBytes(value, key)));
    if (bytes > this.options.maxBytes) return false;
    if (this.entries.has(key)) this.remove(key, 'replaced');
    const timestamp = this.now();
    this.entries.set(key, { value, bytes, createdAt: timestamp, lastAccessedAt: timestamp });
    this.estimatedBytes += bytes;
    while (this.entries.size > this.options.maxEntries) this.evictOldest('entries');
    while (this.estimatedBytes > this.options.maxBytes) this.evictOldest('bytes');
    return this.entries.has(key);
  }

  delete(key: K): boolean {
    return this.remove(key, 'cleared');
  }

  sweepExpired(): number {
    const startedWith = this.entries.size;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastAccessedAt >= this.options.ttlMs) this.remove(key, 'expired');
    }
    return startedWith - this.entries.size;
  }

  clear(): void {
    for (const key of [...this.entries.keys()]) this.remove(key, 'cleared');
  }

  evictLeastRecentlyUsed(reason: 'entries' | 'bytes'): boolean {
    const before = this.entries.size;
    this.evictOldest(reason);
    return this.entries.size < before;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
  }

  keys(): IterableIterator<K> { return this.entries.keys(); }
  get size(): number { return this.entries.size; }

  metrics(): BoundedLruCacheMetrics {
    const oldest = [...this.entries.values()].reduce(
      (value, entry) => Math.min(value, entry.createdAt),
      this.now(),
    );
    return {
      entries: this.entries.size,
      estimatedBytes: this.estimatedBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: { ...this.evictions },
      oldestAgeMs: this.entries.size ? Math.max(0, this.now() - oldest) : 0,
    };
  }

  private evictOldest(reason: CacheEvictionReason): void {
    const key = this.entries.keys().next().value as K | undefined;
    if (key !== undefined) this.remove(key, reason);
  }

  private remove(key: K, reason: CacheEvictionReason): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.estimatedBytes -= entry.bytes;
    this.evictions[reason] += 1;
    return true;
  }
}

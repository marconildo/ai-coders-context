/**
 * ContextCache - In-memory cache for semantic context with TTL and mtime invalidation.
 *
 * Caches the result of expensive context-building operations (buildDocumentationContext,
 * buildCompactContext) to avoid redundant computation across multiple MCP tool calls.
 *
 * Invalidation strategy:
 * - TTL-based: entries expire after configurable time (default 5 minutes)
 * - Mtime-based: entries are invalidated when source directories are modified
 *
 * Thread safety: Node.js is single-threaded, so no mutex needed.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash } from 'crypto';
import { glob } from 'glob';
import { BoundedLruCache, type BoundedLruCacheMetrics } from '../../../domain/retention/boundedLruCache';
import { loadRuntimeRetentionConfig } from '../../../application/retention/runtimeRetentionConfig';

/**
 * A cached context entry with metadata for invalidation.
 */
interface CacheEntry {
    /** The cached context string */
    content: string;
    /** Modification time hash of source directories at cache time */
    mtimeHash: string;
}

export interface ContextCacheOptions {
    /** Time-to-live in milliseconds (default: 5 minutes) */
    ttlMs?: number;
    /** Directories to monitor for changes (relative to repo root) */
    watchDirs?: string[];
    /** Maximum cached contexts (default: 16) */
    maxEntries?: number;
    /** Estimated UTF-8 byte ceiling (default: 32 MiB) */
    maxBytes?: number;
    /** Proactive expiration sweep interval */
    sweepIntervalMs?: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_WATCH_DIRS = ['src', '.context', 'lib', 'packages'];
const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export class ContextCache {
    private readonly caches = new Map<string, {
        cache: BoundedLruCache<string, CacheEntry>;
        signature: string;
        diagnostics: string[];
    }>();
    private readonly watchDirs: string[];
    private readonly options: ContextCacheOptions;

    constructor(options: ContextCacheOptions = {}) {
        this.options = options;
        this.watchDirs = options.watchDirs ?? DEFAULT_WATCH_DIRS;
    }

    /**
     * Get a cached context entry, or null if not found/expired/invalidated.
     *
     * @param repoPath - Absolute path to the repository root
     * @param contextType - Type of context (e.g., 'documentation', 'compact', 'full')
     * @returns Cached context string or null
     */
    async get(repoPath: string, contextType: string, keyOptions?: unknown): Promise<string | null> {
        const cache = await this.cacheForRepo(repoPath);
        const key = this.buildKey(repoPath, contextType, keyOptions);
        const entry = cache.get(key);

        if (!entry) {
            return null;
        }

        // Check directory mtime invalidation
        const currentMtimeHash = await this.computeMtimeHash(repoPath);
        if (currentMtimeHash !== entry.mtimeHash) {
            cache.delete(key);
            return null;
        }

        return entry.content;
    }

    /**
     * Store a context entry in the cache.
     *
     * @param repoPath - Absolute path to the repository root
     * @param contextType - Type of context
     * @param content - The context string to cache
     */
    async set(repoPath: string, contextType: string, content: string, keyOptions?: unknown): Promise<void> {
        const cache = await this.cacheForRepo(repoPath);
        const key = this.buildKey(repoPath, contextType, keyOptions);
        const mtimeHash = await this.computeMtimeHash(repoPath);

        cache.set(key, {
            content,
            mtimeHash,
        });
        const loaded = await loadRuntimeRetentionConfig(repoPath);
        this.enforceGlobalLimits({
            maxEntries: this.options.maxEntries ?? loaded.config.caches.context.maxEntries,
            maxBytes: this.options.maxBytes ?? loaded.config.caches.context.maxBytes,
        });
    }

    /**
     * Invalidate all entries for a given repository.
     */
    invalidateRepo(repoPath: string): void {
        const normalized = this.normalizeRepoPath(repoPath);
        this.caches.get(normalized)?.cache.clear();
    }

    /**
     * Clear all cached entries.
     */
    clear(): void {
        for (const owner of this.caches.values()) owner.cache.clear();
    }

    /** Stop proactive sweeping and release all entries. */
    dispose(): void {
        for (const owner of this.caches.values()) owner.cache.dispose();
        this.caches.clear();
    }

    metrics(): BoundedLruCacheMetrics {
        const all = [...this.caches.values()].map(owner => owner.cache.metrics());
        return all.reduce<BoundedLruCacheMetrics>((total, metric) => ({
            entries: total.entries + metric.entries,
            estimatedBytes: total.estimatedBytes + metric.estimatedBytes,
            hits: total.hits + metric.hits,
            misses: total.misses + metric.misses,
            evictions: {
                expired: total.evictions.expired + metric.evictions.expired,
                entries: total.evictions.entries + metric.evictions.entries,
                bytes: total.evictions.bytes + metric.evictions.bytes,
                replaced: total.evictions.replaced + metric.evictions.replaced,
                cleared: total.evictions.cleared + metric.evictions.cleared,
            },
            oldestAgeMs: Math.max(total.oldestAgeMs, metric.oldestAgeMs),
        }), { entries: 0, estimatedBytes: 0, hits: 0, misses: 0, evictions: { expired: 0, entries: 0, bytes: 0, replaced: 0, cleared: 0 }, oldestAgeMs: 0 });
    }

    /**
     * Get the number of cached entries (for monitoring/debugging).
     */
    get size(): number {
        return [...this.caches.values()].reduce((total, owner) => total + owner.cache.size, 0);
    }

    configDiagnostics(repoPath: string): string[] {
        return [...(this.caches.get(this.normalizeRepoPath(repoPath))?.diagnostics ?? [])];
    }

    /**
     * Build a unique cache key from repo path and context type.
     */
    private buildKey(repoPath: string, contextType: string, keyOptions?: unknown): string {
        const optionsKey = keyOptions === undefined ? '' : `:${JSON.stringify(keyOptions)}`;
        return `${contextType}${optionsKey}`;
    }

    /**
     * Normalize repo path for consistent cache keys.
     */
    private normalizeRepoPath(repoPath: string): string {
        const resolved = path.resolve(repoPath);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    private async cacheForRepo(repoPath: string): Promise<BoundedLruCache<string, CacheEntry>> {
        const normalized = this.normalizeRepoPath(repoPath);
        for (const [ownerPath, owner] of this.caches) {
            if (ownerPath !== normalized && owner.cache.size === 0) {
                owner.cache.dispose();
                this.caches.delete(ownerPath);
            }
        }
        const loaded = await loadRuntimeRetentionConfig(normalized);
        const configured = loaded.config.caches.context;
        const limits = {
            maxEntries: this.options.maxEntries ?? configured.maxEntries ?? DEFAULT_MAX_ENTRIES,
            maxBytes: this.options.maxBytes ?? configured.maxBytes ?? DEFAULT_MAX_BYTES,
            ttlMs: this.options.ttlMs ?? configured.ttlMs ?? DEFAULT_TTL_MS,
        };
        const signature = JSON.stringify(limits);
        const current = this.caches.get(normalized);
        if (current?.signature === signature) {
            this.caches.delete(normalized);
            this.caches.set(normalized, current);
            return current.cache;
        }
        current?.cache.dispose();
        const cache = new BoundedLruCache<string, CacheEntry>({
            ...limits,
            sweepIntervalMs: this.options.sweepIntervalMs,
            estimateBytes: (entry, key) => Buffer.byteLength(key) + Buffer.byteLength(entry.content) + Buffer.byteLength(entry.mtimeHash),
        });
        this.caches.set(normalized, { cache, signature, diagnostics: loaded.diagnostics });
        return cache;
    }

    private enforceGlobalLimits(limits: { maxEntries: number; maxBytes: number }): void {
        const totalEntries = () => [...this.caches.values()].reduce((sum, owner) => sum + owner.cache.size, 0);
        const totalBytes = () => [...this.caches.values()].reduce((sum, owner) => sum + owner.cache.metrics().estimatedBytes, 0);
        while (totalEntries() > limits.maxEntries || totalBytes() > limits.maxBytes) {
            const oldestOwnerKey = this.caches.keys().next().value as string | undefined;
            if (!oldestOwnerKey) break;
            const owner = this.caches.get(oldestOwnerKey)!;
            const reason = totalEntries() > limits.maxEntries ? 'entries' : 'bytes';
            owner.cache.evictLeastRecentlyUsed(reason);
            if (owner.cache.size === 0) {
                owner.cache.dispose();
                this.caches.delete(oldestOwnerKey);
            }
        }
    }

    /**
     * Compute a lightweight hash based on directory modification times.
     * Uses mtime of watched directories as a fast approximation
     * of whether source files have changed.
     */
    private async computeMtimeHash(repoPath: string): Promise<string> {
        const hash = createHash('sha256');

        for (const dir of this.watchDirs) {
            const dirPath = path.join(repoPath, dir);
            try {
                const files = await glob('**/*', {
                    cwd: dirPath,
                    absolute: true,
                    nodir: true,
                    dot: true,
                    ignore: dir === '.context' ? ['runtime/**', 'cache/**'] : [],
                });
                for (const file of files.sort()) {
                    const stat = await fs.stat(file);
                    hash.update(`${dir}/${path.relative(dirPath, file)}:${stat.size}:${stat.mtimeMs}\n`);
                }
            } catch {
                hash.update(`${dir}:missing\n`);
            }
        }

        return hash.digest('hex');
    }
}

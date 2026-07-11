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
    private readonly cache: BoundedLruCache<string, CacheEntry>;
    private readonly ttlMs: number;
    private readonly watchDirs: string[];

    constructor(options: ContextCacheOptions = {}) {
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
        this.watchDirs = options.watchDirs ?? DEFAULT_WATCH_DIRS;
        this.cache = new BoundedLruCache({
            maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
            maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
            ttlMs: this.ttlMs,
            sweepIntervalMs: options.sweepIntervalMs,
            estimateBytes: (entry, key) => Buffer.byteLength(key) + Buffer.byteLength(entry.content) + Buffer.byteLength(entry.mtimeHash),
        });
    }

    /**
     * Get a cached context entry, or null if not found/expired/invalidated.
     *
     * @param repoPath - Absolute path to the repository root
     * @param contextType - Type of context (e.g., 'documentation', 'compact', 'full')
     * @returns Cached context string or null
     */
    async get(repoPath: string, contextType: string, keyOptions?: unknown): Promise<string | null> {
        const key = this.buildKey(repoPath, contextType, keyOptions);
        const entry = this.cache.get(key);

        if (!entry) {
            return null;
        }

        // Check directory mtime invalidation
        const currentMtimeHash = await this.computeMtimeHash(repoPath);
        if (currentMtimeHash !== entry.mtimeHash) {
            this.cache.delete(key);
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
        const key = this.buildKey(repoPath, contextType, keyOptions);
        const mtimeHash = await this.computeMtimeHash(repoPath);

        this.cache.set(key, {
            content,
            mtimeHash,
        });
    }

    /**
     * Invalidate all entries for a given repository.
     */
    invalidateRepo(repoPath: string): void {
        const prefix = this.normalizeRepoPath(repoPath) + ':';
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Clear all cached entries.
     */
    clear(): void {
        this.cache.clear();
    }

    /** Stop proactive sweeping and release all entries. */
    dispose(): void {
        this.cache.dispose();
    }

    metrics(): BoundedLruCacheMetrics {
        return this.cache.metrics();
    }

    /**
     * Get the number of cached entries (for monitoring/debugging).
     */
    get size(): number {
        return this.cache.size;
    }

    /**
     * Build a unique cache key from repo path and context type.
     */
    private buildKey(repoPath: string, contextType: string, keyOptions?: unknown): string {
        const optionsKey = keyOptions === undefined ? '' : `:${JSON.stringify(keyOptions)}`;
        return `${this.normalizeRepoPath(repoPath)}:${contextType}${optionsKey}`;
    }

    /**
     * Normalize repo path for consistent cache keys.
     */
    private normalizeRepoPath(repoPath: string): string {
        return path.resolve(repoPath).toLowerCase();
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

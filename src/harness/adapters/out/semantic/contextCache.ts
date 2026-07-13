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

import * as path from 'path';
import { BoundedLruCache, type BoundedLruCacheMetrics } from '../../../domain/retention/boundedLruCache';
import { loadRuntimeRetentionConfig } from '../../../application/retention/runtimeRetentionConfig';
import {
    discoverBoundedFiles,
    isBoundedSnapshotFresh,
    type BoundedFreshnessSnapshot,
} from './discovery';
import { SemanticSnapshotService } from './semanticSnapshotService';

/**
 * A cached context entry with metadata for invalidation.
 */
interface CacheEntry {
    /** The cached context string */
    content: string;
    freshnessFingerprint?: string;
    freshnessSnapshot?: BoundedFreshnessSnapshot;
    /** Content-aware identity that catches same-size writes with restored mtimes. */
    contentFingerprint?: string;
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
    /** Maximum relevant files selected while establishing freshness (default: 128). */
    freshnessMaxFiles?: number;
    /** Maximum directories visited while establishing freshness (default: 256). */
    freshnessMaxDirectories?: number;
    /** Maximum raw directory entries inspected while establishing freshness. */
    freshnessMaxEntriesScanned?: number;
    /** Optional operation-provided source fingerprint that avoids local discovery. */
    fingerprintProvider?: (repoPath: string) => Promise<string>;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_WATCH_DIRS = ['src', '.context', 'lib', 'packages'];
const DEFAULT_MAX_ENTRIES = 16;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const CONTEXT_RELEVANT_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.cs',
    '.php', '.rb', '.md', '.mdx', '.json', '.yaml', '.yml', '.toml', '.xml', '.graphql', '.gql', '.proto',
    '.sql', '.sh', '.bash', '.zsh', '.css', '.scss', '.html', '.vue', '.svelte',
];

export interface ContextCacheFreshnessMetrics {
    discoveries: number;
    filesSelected: number;
    directoriesVisited: number;
    entriesScanned: number;
    partialDiscoveries: number;
    entryLimitDiscoveries: number;
    signalsChecked: number;
    invalidations: number;
}

export class ContextCache {
    private readonly caches = new Map<string, {
        cache: BoundedLruCache<string, CacheEntry>;
        signature: string;
        diagnostics: string[];
        maxEntriesScanned: number;
    }>();
    private readonly watchDirs: string[];
    private readonly options: ContextCacheOptions;
    private readonly fingerprintService = new SemanticSnapshotService(true);
    private readonly freshness: ContextCacheFreshnessMetrics = {
        discoveries: 0,
        filesSelected: 0,
        directoriesVisited: 0,
        entriesScanned: 0,
        partialDiscoveries: 0,
        entryLimitDiscoveries: 0,
        signalsChecked: 0,
        invalidations: 0,
    };

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

        const fresh = await this.isFresh(repoPath, entry);
        if (!fresh) {
            cache.delete(key);
            this.freshness.invalidations += 1;
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
        const freshness = await this.captureFreshness(repoPath);

        // Without an injected strong fingerprint, partial discovery cannot
        // observe changes outside its selected prefix. Do not retain an entry
        // that could later authorize a stale hit.
        if (!this.options.fingerprintProvider && freshness.freshnessSnapshot?.partial) {
            cache.delete(key);
            return;
        }

        cache.set(key, {
            content,
            ...freshness,
            contentFingerprint: this.options.fingerprintProvider
                ? undefined
                : await this.fingerprintService.captureRepoFingerprint(repoPath),
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

    freshnessMetrics(): ContextCacheFreshnessMetrics {
        return { ...this.freshness };
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
            maxEntriesScanned: this.options.freshnessMaxEntriesScanned ?? configured.maxEntriesScanned,
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
            maxEntries: limits.maxEntries,
            maxBytes: limits.maxBytes,
            ttlMs: limits.ttlMs,
            sweepIntervalMs: this.options.sweepIntervalMs,
            estimateBytes: (entry, key) => Buffer.byteLength(key) + Buffer.byteLength(entry.content)
                + Buffer.byteLength(JSON.stringify(entry.freshnessSnapshot ?? entry.freshnessFingerprint ?? ''))
                + Buffer.byteLength(entry.contentFingerprint ?? ''),
        });
        this.caches.set(normalized, {
            cache,
            signature,
            diagnostics: loaded.diagnostics,
            maxEntriesScanned: limits.maxEntriesScanned,
        });
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

    private async captureFreshness(repoPath: string): Promise<Pick<CacheEntry, 'freshnessFingerprint' | 'freshnessSnapshot'>> {
        if (this.options.fingerprintProvider) {
            return { freshnessFingerprint: await this.options.fingerprintProvider(repoPath) };
        }
        const discovery = await discoverBoundedFiles(repoPath, {
            roots: this.watchDirs,
            maxFiles: this.options.freshnessMaxFiles ?? 128,
            maxDirectories: this.options.freshnessMaxDirectories ?? 256,
            maxEntriesScanned: this.caches.get(this.normalizeRepoPath(repoPath))?.maxEntriesScanned,
            extensions: CONTEXT_RELEVANT_EXTENSIONS,
            excludeRelativePrefixes: ['.context/runtime', '.context/cache'],
        });
        this.freshness.discoveries += 1;
        this.freshness.filesSelected += discovery.metrics.filesSelected;
        this.freshness.directoriesVisited += discovery.metrics.directoriesVisited;
        this.freshness.entriesScanned += discovery.metrics.entriesScanned;
        if (discovery.metrics.partial) this.freshness.partialDiscoveries += 1;
        if (discovery.metrics.stopReason === 'maxEntriesScanned') this.freshness.entryLimitDiscoveries += 1;
        return { freshnessFingerprint: discovery.fingerprint, freshnessSnapshot: discovery.snapshot };
    }

    private async isFresh(repoPath: string, entry: CacheEntry): Promise<boolean> {
        if (entry.freshnessFingerprint !== undefined && this.options.fingerprintProvider) {
            return await this.options.fingerprintProvider(repoPath) === entry.freshnessFingerprint;
        }
        if (!entry.freshnessSnapshot) return false;
        if (entry.freshnessSnapshot.partial) return false;
        const result = await isBoundedSnapshotFresh(entry.freshnessSnapshot);
        this.freshness.signalsChecked += result.signalsChecked;
        if (result.fresh) {
            return entry.contentFingerprint === undefined
                || await this.fingerprintService.captureRepoFingerprint(repoPath) === entry.contentFingerprint;
        }
        const refreshed = await this.captureFreshness(repoPath);
        if (refreshed.freshnessSnapshot?.partial) return false;
        if (refreshed.freshnessFingerprint === entry.freshnessFingerprint && refreshed.freshnessSnapshot) {
            entry.freshnessSnapshot = refreshed.freshnessSnapshot;
            return true;
        }
        return false;
    }
}

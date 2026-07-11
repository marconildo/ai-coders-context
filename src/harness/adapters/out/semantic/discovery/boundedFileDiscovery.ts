import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface BoundedFileSignal {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface BoundedDirectorySignal {
  path: string;
  mtimeMs: number;
}

/**
 * A configured discovery root, including roots which did not exist when the
 * snapshot was captured. Keeping absence as an explicit signal prevents a
 * newly-created source root from authorizing a stale cache hit.
 */
export interface BoundedRootSignal {
  path: string;
  exists: boolean;
  mtimeMs?: number;
}

export interface BoundedFreshnessSnapshot {
  rootPath: string;
  roots: BoundedRootSignal[];
  files: BoundedFileSignal[];
  directories: BoundedDirectorySignal[];
  partial: boolean;
}

export interface BoundedDiscoveryMetrics {
  filesSelected: number;
  directoriesVisited: number;
  entriesScanned: number;
  statsAttempted: number;
  partial: boolean;
  stopReason?: BoundedDiscoveryStopReason;
  durationMs: number;
}

export type BoundedDiscoveryStopReason = 'maxFiles' | 'maxDirectories' | 'maxEntriesScanned';

export interface BoundedFileDiscoveryResult {
  files: string[];
  fingerprint: string;
  snapshot: BoundedFreshnessSnapshot;
  metrics: BoundedDiscoveryMetrics;
}

export interface BoundedFileDiscoveryOptions {
  roots?: string[];
  maxFiles: number;
  maxDirectories?: number;
  maxEntriesScanned?: number;
  extensions?: Iterable<string>;
  include?: string[];
  excludeDirectoryNames?: Iterable<string>;
  excludeRelativePrefixes?: Iterable<string>;
}

const DEFAULT_EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', 'vendor', '__pycache__',
]);

export const DEFAULT_MAX_ENTRIES_SCANNED = 100_000;
export const ABSOLUTE_MAX_ENTRIES_SCANNED = 1_000_000;

function boundedEntriesLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_ENTRIES_SCANNED;
  return Math.min(ABSOLUTE_MAX_ENTRIES_SCANNED, Math.max(1, Math.floor(value)));
}

function normalizedRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join('/');
}

function fingerprintSnapshot(snapshot: BoundedFreshnessSnapshot): string {
  const hash = createHash('sha256');
  for (const root of snapshot.roots) {
    // Mtime is a cheap rescan sentinel, not source identity: excluded runtime
    // churn may touch a watched parent without changing relevant source.
    hash.update(`r:${root.path}:${root.exists}\n`);
  }
  for (const file of snapshot.files) {
    hash.update(`f:${file.path}:${file.size}:${file.mtimeMs}\n`);
  }
  hash.update(`partial:${snapshot.partial}`);
  return hash.digest('hex');
}

/** Stream directory entries and stop as soon as either discovery budget is reached. */
export async function discoverBoundedFiles(
  rootPath: string,
  options: BoundedFileDiscoveryOptions,
): Promise<BoundedFileDiscoveryResult> {
  const started = Date.now();
  const root = path.resolve(rootPath);
  const maxFiles = Math.max(1, Math.floor(options.maxFiles));
  const maxDirectories = Math.max(1, Math.floor(options.maxDirectories ?? Math.min(10_000, maxFiles * 2 + 32)));
  const maxEntriesScanned = boundedEntriesLimit(options.maxEntriesScanned);
  const extensions = options.extensions ? new Set([...options.extensions].map(value => value.toLowerCase())) : undefined;
  const excludedNames = new Set([...DEFAULT_EXCLUDED_DIRECTORIES, ...(options.excludeDirectoryNames ?? [])]);
  const excludedPrefixes = [...(options.excludeRelativePrefixes ?? [])]
    .map(value => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
  let statsAttempted = 0;
  const configuredRoots = (options.roots?.length ? options.roots : ['.'])
    .map(relative => path.resolve(root, relative))
    .filter(candidate => candidate === root || candidate.startsWith(`${root}${path.sep}`));
  // Always observe the repository root as well as every configured watch root.
  // De-duplication keeps the default `.` case to one signal/stat.
  const rootCandidates = [...new Set([root, ...configuredRoots])];
  const rootSignals: BoundedRootSignal[] = [];
  for (const candidate of rootCandidates) {
    statsAttempted += 1;
    try {
      const stat = await fs.stat(candidate);
      rootSignals.push({
        path: normalizedRelative(root, candidate) || '.',
        exists: true,
        mtimeMs: stat.mtimeMs,
      });
    } catch {
      rootSignals.push({ path: normalizedRelative(root, candidate) || '.', exists: false });
    }
  }
  rootSignals.sort((left, right) => left.path.localeCompare(right.path));
  const queue = [...configuredRoots];
  const queued = new Set(queue);
  const files: BoundedFileSignal[] = [];
  const directories: BoundedDirectorySignal[] = [];
  let entriesScanned = 0;
  let partial = false;
  let stopReason: BoundedDiscoveryStopReason | undefined;
  const stopPartial = (reason: BoundedDiscoveryStopReason) => {
    partial = true;
    stopReason ??= reason;
  };

  while (
    queue.length > 0
    && files.length < maxFiles
    && directories.length < maxDirectories
    && entriesScanned < maxEntriesScanned
  ) {
    const directoryPath = queue.shift()!;
    const relativeDirectory = normalizedRelative(root, directoryPath);
    if (excludedPrefixes.some(prefix => relativeDirectory === prefix || relativeDirectory.startsWith(`${prefix}/`))) continue;
    try {
      statsAttempted += 1;
      const directoryStat = await fs.stat(directoryPath);
      directories.push({ path: relativeDirectory || '.', mtimeMs: directoryStat.mtimeMs });
      const directory = await fs.opendir(directoryPath);
      for await (const entry of directory) {
        entriesScanned += 1;
        const absolute = path.join(directoryPath, entry.name);
        const relative = normalizedRelative(root, absolute);
        if (entry.isDirectory()) {
          const excluded = excludedNames.has(entry.name)
            || excludedPrefixes.some(prefix => relative === prefix || relative.startsWith(`${prefix}/`));
          if (!excluded && queued.size >= maxDirectories) {
            stopPartial('maxDirectories');
          } else if (!excluded && !queued.has(absolute)) {
            queued.add(absolute);
            queue.push(absolute);
          }
        } else if (
          entry.isFile()
          && (!extensions || extensions.has(path.extname(entry.name).toLowerCase()))
          && (!options.include?.length || options.include.some(pattern => relative.includes(pattern)))
        ) {
          try {
            statsAttempted += 1;
            const stat = await fs.stat(absolute);
            files.push({ path: relative, size: stat.size, mtimeMs: stat.mtimeMs });
          } catch { /* file changed during discovery */ }
        }
        if (entriesScanned >= maxEntriesScanned) {
          stopPartial('maxEntriesScanned');
          break;
        }
        if (files.length >= maxFiles) {
          stopPartial('maxFiles');
          break;
        }
      }
    } catch { /* missing or unreadable roots are represented by their absence */ }
  }
  if (entriesScanned >= maxEntriesScanned) stopPartial('maxEntriesScanned');
  else if (files.length >= maxFiles) stopPartial('maxFiles');
  else if (queue.length > 0 || directories.length >= maxDirectories) stopPartial('maxDirectories');
  files.sort((left, right) => left.path.localeCompare(right.path));
  directories.sort((left, right) => left.path.localeCompare(right.path));
  const snapshot: BoundedFreshnessSnapshot = { rootPath: root, roots: rootSignals, files, directories, partial };
  return {
    files: files.map(file => path.join(root, file.path)),
    fingerprint: fingerprintSnapshot(snapshot),
    snapshot,
    metrics: {
      filesSelected: files.length,
      directoriesVisited: directories.length,
      entriesScanned,
      statsAttempted,
      partial,
      stopReason,
      durationMs: Date.now() - started,
    },
  };
}

/** Validate only previously selected signals; no glob, tree walk, or stat-all occurs on a hit. */
export async function isBoundedSnapshotFresh(snapshot: BoundedFreshnessSnapshot): Promise<{
  fresh: boolean;
  signalsChecked: number;
  durationMs: number;
}> {
  const started = Date.now();
  // A partial snapshot has no signal for unvisited directories/files, so it
  // can never prove that the complete source identity is still fresh.
  if (snapshot.partial) {
    return { fresh: false, signalsChecked: 0, durationMs: Date.now() - started };
  }
  let signalsChecked = 0;
  for (const root of snapshot.roots ?? []) {
    try {
      const stat = await fs.stat(path.join(snapshot.rootPath, root.path));
      signalsChecked += 1;
      if (!root.exists || stat.mtimeMs !== root.mtimeMs) {
        return { fresh: false, signalsChecked, durationMs: Date.now() - started };
      }
    } catch {
      signalsChecked += 1;
      if (root.exists) return { fresh: false, signalsChecked, durationMs: Date.now() - started };
    }
  }
  for (const directory of snapshot.directories) {
    try {
      const stat = await fs.stat(path.join(snapshot.rootPath, directory.path));
      signalsChecked += 1;
      if (stat.mtimeMs !== directory.mtimeMs) return { fresh: false, signalsChecked, durationMs: Date.now() - started };
    } catch {
      return { fresh: false, signalsChecked, durationMs: Date.now() - started };
    }
  }
  for (const file of snapshot.files) {
    try {
      const stat = await fs.stat(path.join(snapshot.rootPath, file.path));
      signalsChecked += 1;
      if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) {
        return { fresh: false, signalsChecked, durationMs: Date.now() - started };
      }
    } catch {
      return { fresh: false, signalsChecked, durationMs: Date.now() - started };
    }
  }
  return { fresh: true, signalsChecked, durationMs: Date.now() - started };
}

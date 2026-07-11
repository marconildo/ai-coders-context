import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { minimatch } from 'minimatch';

import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  queryBinding,
} from '../history/runtimeHistory';

export const DEFAULT_EXPLORE_FILE_BYTES = 1024 * 1024;
export const MAX_EXPLORE_SEARCH_FILES = 5_000;
export const MAX_EXPLORE_SEARCH_ENTRIES = 20_000;
export const MAX_EXPLORE_SEARCH_DIRECTORIES = 2_000;
export const MAX_EXPLORE_SEARCH_RESULT_BYTES = 512 * 1024;

export interface BoundedExploreReadResult extends Record<string, unknown> {
  success: boolean;
  path: string;
  content?: string;
  size?: number;
  errorCode?: 'EXPLORE_FILE_TOO_LARGE';
  error?: string;
  budgetBytes?: number;
  contentOmitted?: boolean;
}

export interface BoundedExploreSearchOptions {
  maxFiles?: number;
  maxEntries?: number;
  maxDirectories?: number;
  maxFileBytes?: number;
  maxResultBytes?: number;
}

export interface BoundedExploreSearchInput {
  pattern: string;
  fileGlob?: string;
  maxResults?: number;
  cwd: string;
  cursor?: string;
}

interface SearchCursor {
  fileOffset: number;
  lineOffset: number;
}

interface DiscoveryMetrics {
  entriesScanned: number;
  directoriesScanned: number;
  matchingFiles: number;
  partial: boolean;
  limitReason?: 'entry-limit' | 'directory-limit' | 'file-limit';
}

interface SearchMatch {
  file: string;
  line: number;
  match: string;
  context: string;
}

const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);
const DEFAULT_SEARCH_GLOB = '**/*.{ts,tsx,js,jsx,py,go,rs,java}';

function positiveLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`explore search limit must be between 1 and ${maximum}`);
  }
  return value;
}

function typedFileTooLarge(filePath: string, size: number, budgetBytes: number): BoundedExploreReadResult {
  return {
    success: false,
    path: filePath,
    size,
    budgetBytes,
    contentOmitted: true,
    errorCode: 'EXPLORE_FILE_TOO_LARGE',
    error: 'The requested file exceeds the bounded explore read budget.',
  };
}

/** Read at most budget + 1 bytes so a file growth race cannot bypass stat. */
export async function readBoundedExploreFile(
  filePath: string,
  encoding: BufferEncoding = 'utf-8',
  budgetBytes = DEFAULT_EXPLORE_FILE_BYTES
): Promise<BoundedExploreReadResult> {
  budgetBytes = positiveLimit(
    budgetBytes,
    DEFAULT_EXPLORE_FILE_BYTES,
    DEFAULT_EXPLORE_FILE_BYTES
  );
  const stat = await fs.stat(filePath);
  if (stat.size > budgetBytes) return typedFileTooLarge(filePath, stat.size, budgetBytes);

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(budgetBytes + 1);
    let totalBytes = 0;
    while (totalBytes < buffer.length) {
      const read = await handle.read(buffer, totalBytes, buffer.length - totalBytes, totalBytes);
      if (read.bytesRead === 0) break;
      totalBytes += read.bytesRead;
    }
    if (totalBytes > budgetBytes) {
      return typedFileTooLarge(filePath, Math.max(stat.size, totalBytes), budgetBytes);
    }
    const content = buffer.subarray(0, totalBytes).toString(encoding);
    if (Buffer.byteLength(content, 'utf8') > budgetBytes) {
      return typedFileTooLarge(filePath, totalBytes, budgetBytes);
    }
    return { success: true, content, path: filePath, size: totalBytes };
  } finally {
    await handle.close();
  }
}

async function* discoverSearchFiles(
  cwd: string,
  fileGlob: string,
  limits: Required<Pick<BoundedExploreSearchOptions, 'maxFiles' | 'maxEntries' | 'maxDirectories'>>,
  metrics: DiscoveryMetrics
): AsyncGenerator<{ absolutePath: string; relativePath: string; fileOffset: number }> {
  const queue: string[] = [cwd];
  let directoriesQueued = 1;

  while (queue.length > 0) {
    if (metrics.directoriesScanned >= limits.maxDirectories) {
      metrics.partial = true;
      metrics.limitReason = 'directory-limit';
      return;
    }
    const directoryPath = queue.shift()!;
    metrics.directoriesScanned += 1;
    let directory;
    try {
      directory = await fs.opendir(directoryPath);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (metrics.entriesScanned >= limits.maxEntries) {
        metrics.partial = true;
        metrics.limitReason = 'entry-limit';
        return;
      }
      metrics.entriesScanned += 1;
      const absolutePath = path.join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (directoriesQueued >= limits.maxDirectories) {
          metrics.partial = true;
          metrics.limitReason = 'directory-limit';
          continue;
        }
        directoriesQueued += 1;
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(cwd, absolutePath).split(path.sep).join('/');
      if (!minimatch(relativePath, fileGlob, { dot: true })) continue;
      if (metrics.matchingFiles >= limits.maxFiles) {
        metrics.partial = true;
        metrics.limitReason = 'file-limit';
        return;
      }
      const fileOffset = metrics.matchingFiles;
      metrics.matchingFiles += 1;
      yield { absolutePath, relativePath, fileOffset };
    }
  }
}

/** Search line-by-line over a bounded, streaming repository discovery. */
export async function searchBoundedCode(
  input: BoundedExploreSearchInput,
  options: BoundedExploreSearchOptions = {}
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const cwd = path.resolve(input.cwd);
  const fileGlob = input.fileGlob || DEFAULT_SEARCH_GLOB;
  const maxResults = positiveLimit(input.maxResults, 50, 1_000);
  const limits = {
    maxFiles: positiveLimit(options.maxFiles, MAX_EXPLORE_SEARCH_FILES, MAX_EXPLORE_SEARCH_FILES),
    maxEntries: positiveLimit(options.maxEntries, MAX_EXPLORE_SEARCH_ENTRIES, MAX_EXPLORE_SEARCH_ENTRIES),
    maxDirectories: positiveLimit(
      options.maxDirectories,
      MAX_EXPLORE_SEARCH_DIRECTORIES,
      MAX_EXPLORE_SEARCH_DIRECTORIES
    ),
  };
  const maxFileBytes = positiveLimit(
    options.maxFileBytes,
    DEFAULT_EXPLORE_FILE_BYTES,
    DEFAULT_EXPLORE_FILE_BYTES
  );
  const maxResultBytes = positiveLimit(
    options.maxResultBytes,
    MAX_EXPLORE_SEARCH_RESULT_BYTES,
    MAX_EXPLORE_SEARCH_RESULT_BYTES
  );
  const binding = queryBinding({ cwd, fileGlob, pattern: input.pattern });
  const boundary = decodeHistoryCursor<SearchCursor>(input.cursor, 'explore-search', binding)
    ?? { fileOffset: 0, lineOffset: 0 };
  const regex = new RegExp(input.pattern, 'gm');
  const matches: SearchMatch[] = [];
  const metrics: DiscoveryMetrics = {
    entriesScanned: 0,
    directoriesScanned: 0,
    matchingFiles: 0,
    partial: false,
  };
  let filesScanned = 0;
  let linesScanned = 0;
  let bytesScanned = 0;
  let oversizedFilesSkipped = 0;
  let hasMore = false;
  let pageByteLimited = false;
  let nextCursor: string | undefined;
  let returnedBytes = 2;

  outer: for await (const file of discoverSearchFiles(cwd, fileGlob, limits, metrics)) {
    if (file.fileOffset < boundary.fileOffset) continue;
    let stat;
    try {
      stat = await fs.stat(file.absolutePath);
    } catch {
      continue;
    }
    if (stat.size > maxFileBytes) {
      oversizedFilesSkipped += 1;
      metrics.partial = true;
      continue;
    }
    filesScanned += 1;
    const startLine = file.fileOffset === boundary.fileOffset ? boundary.lineOffset : 0;
    const stream = createReadStream(file.absolutePath, {
      encoding: 'utf8',
      highWaterMark: 64 * 1024,
      // Guard a growth race after stat: the stream itself can never consume
      // more than the per-file budget.
      start: 0,
      end: maxFileBytes - 1,
    });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    let previousLine: string | undefined;
    let pending: { lineNumber: number; line: string; previousLine?: string } | undefined;
    const appendPending = (nextLine?: string): boolean => {
      if (!pending) return true;
      const context = [pending.previousLine, pending.line, nextLine]
        .filter((value): value is string => value !== undefined)
        .join('\n')
        .slice(0, 500);
      const candidate: SearchMatch = {
        file: file.relativePath,
        line: pending.lineNumber,
        match: pending.line.trim().slice(0, 200),
        context,
      };
      const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
      const candidateTotal = returnedBytes + candidateBytes + (matches.length > 0 ? 1 : 0);
      if (matches.length === maxResults || candidateTotal > maxResultBytes) {
        hasMore = true;
        pageByteLimited = matches.length < maxResults;
        nextCursor = encodeHistoryCursor('explore-search', binding, {
          fileOffset: file.fileOffset,
          lineOffset: pending.lineNumber - 1,
        });
        return false;
      }
      matches.push(candidate);
      returnedBytes = candidateTotal;
      pending = undefined;
      return true;
    };
    try {
      for await (const line of lines) {
        lineNumber += 1;
        bytesScanned += Buffer.byteLength(line, 'utf8') + 1;
        if (lineNumber <= startLine) {
          previousLine = line;
          continue;
        }
        linesScanned += 1;
        if (pending && !appendPending(line)) break outer;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          pending = { lineNumber, line, previousLine };
        }
        previousLine = line;
      }
      if (pending && !appendPending()) break outer;
    } finally {
      lines.close();
      stream.destroy();
    }
    const finalSize = await fs.stat(file.absolutePath).then(value => value.size).catch(() => stat.size);
    if (finalSize > maxFileBytes) {
      oversizedFilesSkipped += 1;
      metrics.partial = true;
    }
  }

  const partial = hasMore || metrics.partial || oversizedFilesSkipped > 0;
  return {
    success: true,
    pattern: input.pattern,
    matches,
    totalMatches: matches.length,
    truncated: partial,
    page: {
      nextCursor,
      hasMore,
      recordsReturned: matches.length,
      filesScanned,
      linesScanned,
      bytesScanned,
      resultBytes: returnedBytes,
      resultByteBudget: maxResultBytes,
      pageByteLimited,
      entriesScanned: metrics.entriesScanned,
      directoriesScanned: metrics.directoriesScanned,
      matchingFilesScanned: metrics.matchingFiles,
      oversizedFilesSkipped,
      discoveryLimitReason: metrics.limitReason,
      partial,
      cursorVersion: 1,
      durationMs: Date.now() - startedAt,
    },
  };
}

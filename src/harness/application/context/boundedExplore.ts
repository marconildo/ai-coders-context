import { createReadStream, promises as fs } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Worker } from 'worker_threads';
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
export const DEFAULT_EXPLORE_REGEX_TIMEOUT_MS = 100;

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
  regexTimeoutMs?: number;
}

export interface BoundedExploreListInput {
  pattern: string;
  cwd: string;
  ignore?: string[];
  limit: number;
  cursor?: string;
}

export interface BoundedExploreListOptions {
  maxFiles?: number;
  maxEntries?: number;
  maxDirectories?: number;
}

export interface BoundedExploreListResult {
  success: boolean;
  files: string[];
  count: number;
  pattern: string;
  page: {
    nextCursor?: string;
    hasMore: boolean;
    recordsReturned: number;
    recordsScanned: number;
    entriesScanned: number;
    directoriesScanned: number;
    matchingFilesScanned: number;
    discoveryLimitReason?: DiscoveryMetrics['limitReason'];
    continuationAvailable: boolean;
    continuationUnavailableReason?: 'discovery-limit-reached';
    cursorVersion: 1;
    partial: boolean;
    durationMs: number;
  };
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

interface ListCursor {
  fileOffset: number;
}

interface SearchMatch {
  file: string;
  line: number;
  match: string;
  context: string;
}

const IGNORED_DIRECTORY_NAMES = new Set(['node_modules', '.git', 'dist', 'build']);
const DEFAULT_SEARCH_GLOB = '**/*.{ts,tsx,js,jsx,py,go,rs,java}';

const REGEX_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require('worker_threads');
  let regex;
  try {
    regex = new RegExp(workerData.pattern, 'gm');
    parentPort.postMessage({ type: 'ready' });
  } catch (error) {
    parentPort.postMessage({ type: 'compile-error', message: error instanceof Error ? error.message : String(error) });
  }
  parentPort.on('message', ({ id, line }) => {
    regex.lastIndex = 0;
    parentPort.postMessage({ type: 'result', id, matched: regex.test(line) });
  });
`;

class RegexDeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Regex evaluation exceeded the ${timeoutMs}ms CPU deadline.`);
    this.name = 'RegexDeadlineError';
  }
}

/**
 * Runs caller-controlled regexes outside the main event loop. A pathological
 * expression can consume at most one worker until the hard per-line deadline,
 * after which the worker is terminated.
 */
class BoundedRegexMatcher {
  private readonly worker: Worker;
  private requestId = 0;
  private pending: {
    id: number;
    resolve: (matched: boolean) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | undefined;
  private closed = false;
  private termination: Promise<number> | undefined;

  private constructor(
    pattern: string,
    private readonly timeoutMs: number,
    ready: { resolve: () => void; reject: (error: Error) => void }
  ) {
    this.worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      workerData: { pattern },
    });
    this.worker.on('message', (message: {
      type: 'ready' | 'compile-error' | 'result';
      id?: number;
      matched?: boolean;
      message?: string;
    }) => {
      if (message.type === 'ready') {
        ready.resolve();
        return;
      }
      if (message.type === 'compile-error') {
        ready.reject(new SyntaxError(message.message || 'Invalid regular expression'));
        return;
      }
      if (message.type === 'result' && this.pending?.id === message.id) {
        const pending = this.pending!;
        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(Boolean(message.matched));
      }
    });
    this.worker.on('error', (error) => {
      ready.reject(error);
      this.rejectPending(error);
    });
    this.worker.on('exit', (code) => {
      if (!this.closed && code !== 0) {
        this.rejectPending(new Error(`Regex worker exited with code ${code}`));
      }
    });
  }

  static async create(pattern: string, timeoutMs: number): Promise<BoundedRegexMatcher> {
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const matcher = new BoundedRegexMatcher(pattern, timeoutMs, {
      resolve: resolveReady,
      reject: rejectReady,
    });
    const compileTimer = setTimeout(() => {
      rejectReady(new RegexDeadlineError(Math.max(timeoutMs, 500)));
      void matcher.close();
    }, Math.max(timeoutMs, 500));
    try {
      await readyPromise;
      return matcher;
    } catch (error) {
      await matcher.close();
      throw error;
    } finally {
      clearTimeout(compileTimer);
    }
  }

  async test(line: string): Promise<boolean> {
    if (this.closed) throw new Error('Regex worker is closed.');
    const id = ++this.requestId;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = undefined;
        const error = new RegexDeadlineError(this.timeoutMs);
        reject(error);
        void this.close();
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.worker.postMessage({ id, line });
    });
  }

  async close(): Promise<void> {
    if (!this.termination) {
      this.closed = true;
      this.rejectPending(new Error('Regex worker was terminated.'));
      this.termination = this.worker.terminate();
    }
    await this.termination;
  }

  private rejectPending(error: Error): void {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
}

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

function matchesAnyIgnore(relativePath: string, isDirectory: boolean, ignore: string[]): boolean {
  return ignore.some((pattern) => {
    if (minimatch(relativePath, pattern, { dot: true })) return true;
    return isDirectory && minimatch(`${relativePath}/`, pattern, { dot: true });
  });
}

/**
 * List files through the same bounded opendir strategy used by search. Unlike
 * globIterate, this walker caps work even when a caller explicitly disables
 * the default node_modules/.git ignores.
 */
export async function listBoundedExploreFiles(
  input: BoundedExploreListInput,
  options: BoundedExploreListOptions = {}
): Promise<BoundedExploreListResult> {
  const startedAt = Date.now();
  const cwd = path.resolve(input.cwd);
  const ignore = input.ignore ?? [];
  const pageLimit = positiveLimit(input.limit, 100, 1_000);
  const limits = {
    maxFiles: positiveLimit(options.maxFiles, MAX_EXPLORE_SEARCH_FILES, MAX_EXPLORE_SEARCH_FILES),
    maxEntries: positiveLimit(options.maxEntries, MAX_EXPLORE_SEARCH_ENTRIES, MAX_EXPLORE_SEARCH_ENTRIES),
    maxDirectories: positiveLimit(
      options.maxDirectories,
      MAX_EXPLORE_SEARCH_DIRECTORIES,
      MAX_EXPLORE_SEARCH_DIRECTORIES
    ),
  };
  const binding = queryBinding({ pattern: input.pattern, cwd, ignore });
  const boundary = decodeHistoryCursor<ListCursor>(input.cursor, 'explore-files', binding)
    ?? { fileOffset: 0 };
  if (!Number.isInteger(boundary.fileOffset) || boundary.fileOffset < 0) {
    throw new RangeError('explore files cursor offset must be a non-negative integer');
  }

  const files: string[] = [];
  const queue: string[] = [cwd];
  let directoriesQueued = 1;
  let directoriesScanned = 0;
  let entriesScanned = 0;
  let matchingFiles = 0;
  let limitReason: DiscoveryMetrics['limitReason'];
  let resultPageLimited = false;

  outer: while (queue.length > 0) {
    if (directoriesScanned >= limits.maxDirectories) {
      limitReason = 'directory-limit';
      break;
    }
    const directoryPath = queue.shift()!;
    directoriesScanned += 1;
    let directory;
    try {
      directory = await fs.opendir(directoryPath);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (entriesScanned >= limits.maxEntries) {
        limitReason = 'entry-limit';
        break outer;
      }
      entriesScanned += 1;
      const absolutePath = path.join(directoryPath, entry.name);
      const relativePath = path.relative(cwd, absolutePath).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (matchesAnyIgnore(relativePath, true, ignore)) continue;
        if (directoriesQueued >= limits.maxDirectories) {
          limitReason = 'directory-limit';
          continue;
        }
        directoriesQueued += 1;
        queue.push(absolutePath);
        continue;
      }
      if (!entry.isFile() || matchesAnyIgnore(relativePath, false, ignore)) continue;
      if (!minimatch(relativePath, input.pattern, { dot: true })) continue;
      if (matchingFiles >= limits.maxFiles) {
        limitReason = 'file-limit';
        break outer;
      }
      const fileOffset = matchingFiles;
      matchingFiles += 1;
      if (fileOffset < boundary.fileOffset) continue;
      if (files.length === pageLimit) {
        resultPageLimited = true;
        break outer;
      }
      files.push(relativePath);
    }
  }

  const discoveryPartial = limitReason !== undefined;
  const hasMore = resultPageLimited;
  const nextCursor = hasMore
    ? encodeHistoryCursor('explore-files', binding, {
        fileOffset: boundary.fileOffset + files.length,
      })
    : undefined;

  return {
    success: true,
    files,
    count: files.length,
    pattern: input.pattern,
    page: {
      nextCursor,
      hasMore,
      recordsReturned: files.length,
      recordsScanned: entriesScanned,
      entriesScanned,
      directoriesScanned,
      matchingFilesScanned: matchingFiles,
      discoveryLimitReason: limitReason,
      continuationAvailable: Boolean(nextCursor),
      continuationUnavailableReason: discoveryPartial && !nextCursor
        ? 'discovery-limit-reached'
        : undefined,
      cursorVersion: 1,
      partial: hasMore || discoveryPartial,
      durationMs: Date.now() - startedAt,
    },
  };
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
  const regexTimeoutMs = positiveLimit(
    options.regexTimeoutMs,
    DEFAULT_EXPLORE_REGEX_TIMEOUT_MS,
    1_000
  );
  const binding = queryBinding({ cwd, fileGlob, pattern: input.pattern });
  const boundary = decodeHistoryCursor<SearchCursor>(input.cursor, 'explore-search', binding)
    ?? { fileOffset: 0, lineOffset: 0 };
  const matcher = await BoundedRegexMatcher.create(input.pattern, regexTimeoutMs);
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
  let regexTimedOut = false;
  let nextCursor: string | undefined;
  let returnedBytes = 2;

  try {
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
          try {
            if (await matcher.test(line)) {
              pending = { lineNumber, line, previousLine };
            }
          } catch (error) {
            if (error instanceof RegexDeadlineError) {
              regexTimedOut = true;
              metrics.partial = true;
              break outer;
            }
            throw error;
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
  } finally {
    await matcher.close();
  }

  const partial = hasMore || metrics.partial || oversizedFilesSkipped > 0 || regexTimedOut;
  return {
    success: !regexTimedOut,
    errorCode: regexTimedOut ? 'EXPLORE_REGEX_TIMEOUT' : undefined,
    error: regexTimedOut
      ? `Regex evaluation exceeded the ${regexTimeoutMs}ms CPU deadline.`
      : undefined,
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
      regexTimedOut,
      regexTimeoutMs,
      discoveryLimitReason: metrics.limitReason,
      partial,
      cursorVersion: 1,
      durationMs: Date.now() - startedAt,
    },
  };
}

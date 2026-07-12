/**
 * Harness Runtime State Service
 *
 * Transport-agnostic persistence for sessions, artifacts, traces, and checkpoints.
 * State lives under .context/runtime/sessions, one folder per session, so future
 * adapters can share it. Paths are resolved through the shared runtime layout.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { promises as nodeFs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { resolveRuntimeLayout, type RuntimeLayout } from '../../../../shared/fs/pathHelpers';
import {
  boundGenericTraceRecord,
  loadGenericTraceEventMaxBytes,
  loadHookTracePolicy,
} from '../../../application/hooks/hookTracePolicy';
import {
  boundedPageBytes,
  boundedLimit,
  decodeHistoryCursor,
  encodeHistoryCursor,
  queryBinding,
  serializedHistoryItemBytes,
  RuntimeHistoryCursorError,
  type RuntimeHistoryDirection,
  type RuntimeHistoryPage,
  type RuntimeHistoryQuery,
} from '../../../application/history/runtimeHistory';

const traceWriteQueues = new Map<string, Promise<void>>();
const TRACE_LOCK_STALE_MS = 60_000;
const ROTATION_EVENT_RESERVE_BYTES = 2 * 1024;

interface TraceLockIdentity {
  pid: number;
  token: string;
  createdAt?: string;
}

interface TraceFileLock extends TraceLockIdentity {
  lockFile: string;
  handle: FileHandle;
  inode: bigint | number;
  device: bigint | number;
}

interface TraceLockSnapshot extends TraceLockIdentity {
  inode: bigint | number;
  device: bigint | number;
  mtimeMs: number;
}

interface TraceTakeoverDocument extends TraceLockIdentity {
  createdAt: string;
  inode: string;
  device: string;
  target: {
    inode: string;
    device: string;
    token: string;
  };
}

interface CurrentTraceTakeoverSnapshot extends TraceTakeoverDocument {
  format: 'current';
  actualInode: bigint | number;
  actualDevice: bigint | number;
  mtimeMs: number;
}

interface LegacyTraceTakeoverSnapshot extends TraceLockIdentity {
  format: 'legacy';
  createdAt: string;
  actualInode: bigint | number;
  actualDevice: bigint | number;
  mtimeMs: number;
}

type TraceTakeoverSnapshot = CurrentTraceTakeoverSnapshot | LegacyTraceTakeoverSnapshot;

function waitForLock(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseTraceLockIdentity(value: string): TraceLockIdentity {
  try {
    const parsed = JSON.parse(value) as Partial<TraceLockIdentity>;
    return {
      pid: typeof parsed.pid === 'number' ? parsed.pid : Number.NaN,
      token: typeof parsed.token === 'string' ? parsed.token : '',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : undefined,
    };
  } catch {
    // Preserve takeover compatibility with locks written by the first F-02
    // implementation (`pid timestamp`).
    return { pid: Number.parseInt(value.split(/\s/, 1)[0], 10), token: value.trim() };
  }
}

async function sameLockIdentity(
  file: string,
  expected: {
    inode: bigint | number;
    device: bigint | number;
    token: string;
    pid?: number;
    createdAt?: string;
  }
): Promise<boolean> {
  try {
    const handle = await nodeFs.open(file, 'r');
    try {
      const [stat, contents] = await Promise.all([
        handle.stat({ bigint: true }),
        handle.readFile('utf8'),
      ]);
      const identity = parseTraceLockIdentity(contents);
      return stat.ino === expected.inode
        && stat.dev === expected.device
        && identity.token === expected.token
        && (expected.pid === undefined || identity.pid === expected.pid)
        && (expected.createdAt === undefined || identity.createdAt === expected.createdAt);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function readTraceLockSnapshot(lockFile: string): Promise<TraceLockSnapshot | undefined> {
  try {
    const handle = await nodeFs.open(lockFile, 'r');
    try {
      const [stat, contents] = await Promise.all([
        handle.stat({ bigint: true }),
        handle.readFile('utf8'),
      ]);
      return {
        ...parseTraceLockIdentity(contents),
        inode: stat.ino,
        device: stat.dev,
        mtimeMs: Number(stat.mtimeMs),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

function parseTraceTakeoverDocument(value: string): TraceTakeoverDocument | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<TraceTakeoverDocument>;
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.token !== 'string'
      || typeof parsed.createdAt !== 'string'
      || typeof parsed.inode !== 'string'
      || typeof parsed.device !== 'string'
      || !parsed.target
      || typeof parsed.target.inode !== 'string'
      || typeof parsed.target.device !== 'string'
      || typeof parsed.target.token !== 'string'
    ) return undefined;
    return parsed as TraceTakeoverDocument;
  } catch {
    return undefined;
  }
}

async function readTraceTakeoverSnapshot(takeoverFile: string): Promise<TraceTakeoverSnapshot | undefined> {
  try {
    const handle = await nodeFs.open(takeoverFile, 'r');
    try {
      const [stat, contents] = await Promise.all([
        handle.stat({ bigint: true }),
        handle.readFile('utf8'),
      ]);
      const document = parseTraceTakeoverDocument(contents);
      if (document) {
        if (document.inode !== String(stat.ino) || document.device !== String(stat.dev)) return undefined;
        return {
          ...document,
          format: 'current',
          actualInode: stat.ino,
          actualDevice: stat.dev,
          mtimeMs: Number(stat.mtimeMs),
        };
      }
      const legacy = parseTraceLockIdentity(contents);
      if (!Number.isInteger(legacy.pid) || !legacy.token || !legacy.createdAt) return undefined;
      return {
        ...legacy,
        format: 'legacy',
        createdAt: legacy.createdAt,
        actualInode: stat.ino,
        actualDevice: stat.dev,
        mtimeMs: Number(stat.mtimeMs),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function sameTakeoverIdentity(file: string, expected: TraceTakeoverSnapshot): Promise<boolean> {
  const current = await readTraceTakeoverSnapshot(file);
  return current !== undefined
    && current.format === expected.format
    && current.actualInode === expected.actualInode
    && current.actualDevice === expected.actualDevice
    && current.pid === expected.pid
    && current.token === expected.token
    && current.createdAt === expected.createdAt;
}

function takeoverCandidateFile(takeoverFile: string, pid: number, token: string): string {
  return `${takeoverFile}.${pid}.${token}.candidate`;
}

async function publishTraceTakeover(
  takeoverFile: string,
  target: TraceLockSnapshot
): Promise<CurrentTraceTakeoverSnapshot | undefined> {
  const token = randomUUID();
  const candidateFile = takeoverCandidateFile(takeoverFile, process.pid, token);
  let handle: FileHandle | undefined;
  try {
    handle = await nodeFs.open(candidateFile, 'wx');
    const stat = await handle.stat({ bigint: true });
    const document: TraceTakeoverDocument = {
      pid: process.pid,
      token,
      createdAt: new Date().toISOString(),
      inode: String(stat.ino),
      device: String(stat.dev),
      target: {
        inode: String(target.inode),
        device: String(target.device),
        token: target.token,
      },
    };
    await handle.writeFile(JSON.stringify(document), 'utf8');
    await handle.sync();
    try {
      // Publish a fully-written identity atomically. The candidate and fixed
      // election name refer to the same inode, so a crash cannot expose a
      // partially initialized takeover owner.
      await nodeFs.link(candidateFile, takeoverFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOENT') return undefined;
      throw error;
    }
    const published = await readTraceTakeoverSnapshot(takeoverFile);
    return published?.format === 'current' ? published : undefined;
  } finally {
    await handle?.close().catch(() => undefined);
    await nodeFs.unlink(candidateFile).catch(() => undefined);
  }
}

async function recoverOrphanedTraceTakeover(takeoverFile: string): Promise<boolean> {
  const takeover = await readTraceTakeoverSnapshot(takeoverFile);
  if (!takeover) return false;
  const age = Date.now() - takeover.mtimeMs;
  if (age <= TRACE_LOCK_STALE_MS || isProcessAlive(takeover.pid)) return false;
  if (!(await sameTakeoverIdentity(takeoverFile, takeover))) return false;

  if (takeover.format === 'legacy') {
    const lockFile = takeoverFile.slice(0, -'.takeover'.length);
    const target = await readTraceLockSnapshot(lockFile);
    if (
      !target
      || target.inode !== takeover.actualInode
      || target.device !== takeover.actualDevice
      || target.pid !== takeover.pid
      || target.token !== takeover.token
      || target.createdAt !== takeover.createdAt
    ) return false;
    // Legacy elections from the previous branch head were hard links to the
    // target lock. Re-open both names immediately before unlinking only the
    // election name, so a replacement identity survives the race.
    if (!(await sameLockIdentity(lockFile, target))) return false;
    if (!(await sameTakeoverIdentity(takeoverFile, takeover))) return false;
    await nodeFs.unlink(takeoverFile).catch(() => undefined);
    return true;
  }

  const candidateFile = takeoverCandidateFile(takeoverFile, takeover.pid, takeover.token);
  if (await sameTakeoverIdentity(candidateFile, takeover)) {
    await nodeFs.unlink(candidateFile).catch(() => undefined);
  }
  // Revalidate immediately before removal: a waiter that inspected an old
  // election must not unlink a replacement published under the fixed name.
  if (!(await sameTakeoverIdentity(takeoverFile, takeover))) return false;
  await nodeFs.unlink(takeoverFile).catch(() => undefined);
  return true;
}

async function tryTakeOverStaleTraceLock(lockFile: string): Promise<boolean> {
  const takeoverFile = `${lockFile}.takeover`;
  const target = await readTraceLockSnapshot(lockFile);
  if (!target || Date.now() - target.mtimeMs <= TRACE_LOCK_STALE_MS || isProcessAlive(target.pid)) return false;
  const takeover = await publishTraceTakeover(takeoverFile, target);
  if (!takeover) return false;

  try {
    if (!(await sameTakeoverIdentity(takeoverFile, takeover))) return false;
    if (!(await sameLockIdentity(lockFile, {
      inode: target.inode,
      device: target.device,
      token: target.token,
    }))) return false;
    await nodeFs.unlink(lockFile);
    return true;
  } finally {
    if (await sameTakeoverIdentity(takeoverFile, takeover)) {
      await nodeFs.unlink(takeoverFile).catch(() => undefined);
    }
  }
}

async function acquireTraceFileLock(traceFile: string): Promise<TraceFileLock> {
  const lockFile = `${traceFile}.lock`;
  const takeoverFile = `${lockFile}.takeover`;
  const deadline = Date.now() + 10_000;
  while (true) {
    if (await nodeFs.stat(takeoverFile).then(() => true).catch(() => false)) {
      if (await recoverOrphanedTraceTakeover(takeoverFile)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for trace lock takeover: ${path.basename(traceFile)}`);
      }
      await waitForLock(10 + Math.floor(Math.random() * 20));
      continue;
    }
    try {
      const handle = await nodeFs.open(lockFile, 'wx');
      const token = randomUUID();
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }), 'utf8');
      const stat = await handle.stat({ bigint: true });
      return { lockFile, handle, inode: stat.ino, device: stat.dev, pid: process.pid, token };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      if (await tryTakeOverStaleTraceLock(lockFile)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for trace lock: ${path.basename(traceFile)}`);
      }
      await waitForLock(10 + Math.floor(Math.random() * 20));
    }
  }
}

async function withCrossProcessTraceLock<T>(traceFile: string, operation: () => Promise<T>): Promise<T> {
  const lock = await acquireTraceFileLock(traceFile);
  try {
    return await operation();
  } finally {
    await lock.handle.close().catch(() => undefined);
    if (await sameLockIdentity(lock.lockFile, lock)) {
      await nodeFs.unlink(lock.lockFile).catch(() => undefined);
    }
  }
}

async function withTraceWriteLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = traceWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  traceWriteQueues.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await withCrossProcessTraceLock(key, operation);
  } finally {
    release();
    if (traceWriteQueues.get(key) === tail) {
      traceWriteQueues.delete(key);
    }
  }
}

export type HarnessSessionStatus = 'active' | 'paused' | 'completed' | 'failed';
export type HarnessTraceLevel = 'debug' | 'info' | 'warn' | 'error';
export type HarnessArtifactKind = 'text' | 'json' | 'file';

export interface HarnessRuntimeStateServiceOptions {
  repoPath: string;
}

export interface HarnessSessionCheckpoint {
  id: string;
  note?: string;
  data?: unknown;
  artifactIds: string[];
  createdAt: string;
}

export interface HarnessSessionRecord {
  id: string;
  name: string;
  status: HarnessSessionStatus;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  completedAt?: string;
  failedAt?: string;
  lastTraceAt?: string;
  lastCheckpointAt?: string;
  traceCount: number;
  artifactCount: number;
  checkpointCount: number;
  checkpoints: HarnessSessionCheckpoint[];
  metadata?: Record<string, unknown>;
}

export interface HarnessTraceRecord {
  id: string;
  sessionId: string;
  level: HarnessTraceLevel;
  event: string;
  message: string;
  createdAt: string;
  data?: Record<string, unknown>;
}

export interface HarnessArtifactRecord {
  id: string;
  sessionId: string;
  name: string;
  kind: HarnessArtifactKind;
  createdAt: string;
  content?: unknown;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessRuntimeStatePort {
  getSession(sessionId: string): Promise<HarnessSessionRecord>;
  listSessions(): Promise<HarnessSessionRecord[]>;
  appendTrace(sessionId: string, input: AppendTraceInput): Promise<HarnessTraceRecord>;
  listTraces(sessionId: string): Promise<HarnessTraceRecord[]>;
  addArtifact(sessionId: string, input: AddArtifactInput): Promise<HarnessArtifactRecord>;
  listArtifacts(sessionId: string): Promise<HarnessArtifactRecord[]>;
  checkpointSession(sessionId: string, input?: CheckpointInput): Promise<HarnessSessionRecord>;
  listCheckpoints(sessionId: string): Promise<HarnessSessionCheckpoint[]>;
  listTracePage(sessionId: string, query?: HarnessTracePageQuery): Promise<RuntimeHistoryPage<HarnessTraceRecord>>;
  listSessionPage(query?: RuntimeHistoryQuery): Promise<RuntimeHistoryPage<HarnessSessionRecord>>;
  listArtifactPage(sessionId: string, query?: RuntimeHistoryQuery): Promise<RuntimeHistoryPage<HarnessArtifactRecord>>;
  getSensorSummary(sessionId: string): Promise<HarnessSensorSummary>;
}

export interface HarnessTracePageQuery extends RuntimeHistoryQuery {
  event?: string;
  level?: HarnessTraceLevel;
  createdAfter?: string;
  createdBefore?: string;
}

export interface HarnessSensorSummary {
  version: 1;
  updatedAt: string;
  latestBySensor: Record<string, unknown>;
  runCount?: number;
}

export const MAX_SENSOR_SUMMARY_ENTRIES = 256;
export const MAX_SENSOR_SUMMARY_BYTES = 1024 * 1024;
export const MAX_SENSOR_SUMMARY_ENTRY_BYTES = 64 * 1024;

interface HarnessSensorSummaryShard {
  version: 1;
  sensorId: string;
  updatedAt: string;
  run: Record<string, unknown>;
}

interface TraceCursorPosition {
  file: string;
  offset: number;
  fingerprint: string;
}

interface TraceLine {
  line: string;
  nextOffset: number;
  bytesRead: number;
  oversized: boolean;
}

const TRACE_READ_CHUNK_BYTES = 64 * 1024;
export const MAX_STREAMED_TRACE_LINE_BYTES = 1024 * 1024;

async function* readLinesForward(file: string, startOffset = 0): AsyncGenerator<TraceLine> {
  const handle = await nodeFs.open(file, 'r');
  const chunk = Buffer.allocUnsafe(TRACE_READ_CHUNK_BYTES);
  let position = startOffset;
  let carry = Buffer.alloc(0);
  let discardingOversized = false;
  let unreportedBytes = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      unreportedBytes += bytesRead;
      let segmentStart = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        const segment = chunk.subarray(segmentStart, index);
        const oversized = discardingOversized || carry.length + segment.length > MAX_STREAMED_TRACE_LINE_BYTES;
        const line = oversized
          ? ''
          : (carry.length ? Buffer.concat([carry, segment]) : Buffer.from(segment))
            .toString('utf8')
            .replace(/\r$/, '');
        yield {
          line,
          nextOffset: position + index + 1,
          bytesRead: unreportedBytes,
          oversized,
        };
        unreportedBytes = 0;
        carry = Buffer.alloc(0);
        discardingOversized = false;
        segmentStart = index + 1;
      }

      const trailing = chunk.subarray(segmentStart, bytesRead);
      if (!discardingOversized) {
        if (carry.length + trailing.length > MAX_STREAMED_TRACE_LINE_BYTES) {
          carry = Buffer.alloc(0);
          discardingOversized = true;
        } else if (trailing.length > 0) {
          carry = carry.length ? Buffer.concat([carry, trailing]) : Buffer.from(trailing);
        }
      }
      position += bytesRead;
    }
    if (discardingOversized || carry.length > 0) {
      yield {
        line: discardingOversized ? '' : carry.toString('utf8').replace(/\r$/, ''),
        nextOffset: position,
        bytesRead: unreportedBytes,
        oversized: discardingOversized,
      };
    }
  } finally {
    await handle.close();
  }
}

async function* readLinesReverse(file: string, startOffset?: number): AsyncGenerator<TraceLine> {
  const handle = await nodeFs.open(file, 'r');
  const size = (await handle.stat()).size;
  let position = Math.min(startOffset ?? size, size);
  let carry = Buffer.alloc(0);
  let discardingOversized = false;
  let unreportedBytes = 0;
  try {
    while (position > 0) {
      const length = Math.min(TRACE_READ_CHUNK_BYTES, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      unreportedBytes += bytesRead;
      const newlines: number[] = [];
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] === 0x0a) newlines.push(index);
      }
      if (newlines.length === 0) {
        if (!discardingOversized) {
          if (bytesRead + carry.length > MAX_STREAMED_TRACE_LINE_BYTES) {
            carry = Buffer.alloc(0);
            discardingOversized = true;
          } else {
            carry = carry.length
              ? Buffer.concat([chunk.subarray(0, bytesRead), carry])
              : Buffer.from(chunk.subarray(0, bytesRead));
          }
        }
        continue;
      }

      let lineEnd = bytesRead;
      for (let index = newlines.length - 1; index >= 0; index -= 1) {
        const lineStart = newlines[index] + 1;
        const segment = chunk.subarray(lineStart, lineEnd);
        const usesCarry = index === newlines.length - 1;
        const oversized = usesCarry
          ? discardingOversized || segment.length + carry.length > MAX_STREAMED_TRACE_LINE_BYTES
          : segment.length > MAX_STREAMED_TRACE_LINE_BYTES;
        const framed = oversized
          ? Buffer.alloc(0)
          : usesCarry && carry.length
            ? Buffer.concat([segment, carry])
            : Buffer.from(segment);
        yield {
          line: oversized ? '' : framed.toString('utf8').replace(/\r$/, ''),
          nextOffset: position + lineStart,
          bytesRead: unreportedBytes,
          oversized,
        };
        unreportedBytes = 0;
        lineEnd = newlines[index];
      }
      carry = Buffer.from(chunk.subarray(0, newlines[0]));
      discardingOversized = false;
    }
    if (discardingOversized || carry.length > 0) {
      yield {
        line: discardingOversized ? '' : carry.toString('utf8').replace(/\r$/, ''),
        nextOffset: 0,
        bytesRead: unreportedBytes,
        oversized: discardingOversized,
      };
    }
  } finally {
    await handle.close();
  }
}

export interface CreateSessionInput {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface AppendTraceInput {
  level: HarnessTraceLevel;
  event: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AddArtifactInput {
  name: string;
  kind?: HarnessArtifactKind;
  content?: unknown;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckpointInput {
  note?: string;
  data?: unknown;
  artifactIds?: string[];
  pause?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeContent(content: unknown): unknown {
  if (content === undefined) {
    return undefined;
  }

  if (typeof content === 'string') {
    return content;
  }

  return content;
}

export class HarnessRuntimeStateService {
  constructor(private readonly options: HarnessRuntimeStateServiceOptions) {}

  private get repoPath(): string {
    return this.options.repoPath || process.cwd();
  }

  private get contextPath(): string {
    return path.join(this.repoPath, '.context');
  }

  private _layout?: RuntimeLayout;
  private get layout(): RuntimeLayout {
    return (this._layout ??= resolveRuntimeLayout(this.contextPath));
  }

  private get sessionsPath(): string {
    return this.layout.sessionsDir;
  }

  private sessionFile(sessionId: string): string {
    return this.layout.sessionFile(sessionId);
  }

  private traceFile(sessionId: string): string {
    return this.layout.sessionTraceFile(sessionId);
  }

  private traceSegmentPrefix(sessionId: string): string {
    return path.join(this.layout.sessionDir(sessionId), 'trace.');
  }

  private artifactFile(sessionId: string, artifactId: string): string {
    return this.layout.sessionArtifactFile(sessionId, artifactId);
  }

  private sensorSummaryFile(sessionId: string): string {
    return path.join(this.layout.sessionDir(sessionId), 'sensor-summary.json');
  }

  private sensorSummaryDir(sessionId: string): string {
    return path.join(this.layout.sessionDir(sessionId), 'sensor-summary');
  }

  private sensorSummaryShardFile(sessionId: string, sensorId: string): string {
    const key = createHash('sha256').update(sensorId).digest('hex');
    return path.join(this.sensorSummaryDir(sessionId), `${key}.json`);
  }

  private sensorSummaryMetadataFile(sessionId: string): string {
    return path.join(this.sensorSummaryDir(sessionId), 'meta.json');
  }

  private async ensureSessionDir(sessionId: string): Promise<void> {
    await fs.ensureDir(this.layout.sessionDir(sessionId));
  }

  private async ensureLayout(): Promise<void> {
    await fs.ensureDir(this.sessionsPath);
  }

  private async readSession(sessionId: string): Promise<HarnessSessionRecord> {
    const file = this.sessionFile(sessionId);
    if (!(await fs.pathExists(file))) {
      throw new Error(`Harness session not found: ${sessionId}`);
    }

    return fs.readJson(file) as Promise<HarnessSessionRecord>;
  }

  private async saveSession(session: HarnessSessionRecord): Promise<void> {
    await this.ensureSessionDir(session.id);
    const sessionFile = this.sessionFile(session.id);
    const tmpFile = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeJson(tmpFile, session, { spaces: 2 });
      await fs.rename(tmpFile, sessionFile);
    } finally {
      await fs.remove(tmpFile).catch(() => undefined);
    }
  }

  private async listTraceSegmentFiles(sessionId: string): Promise<string[]> {
    const sessionDir = this.layout.sessionDir(sessionId);
    if (!(await fs.pathExists(sessionDir))) {
      return [];
    }
    const entries = (await fs.readdir(sessionDir)).filter((entry) => /^trace\..+\.jsonl$/.test(entry));
    const segments = await Promise.all(entries.map(async (entry) => {
      const file = path.join(sessionDir, entry);
      const stat = await fs.stat(file);
      const sequence = /^trace\.(\d{12})\./.exec(entry)?.[1];
      return { file, entry, mtimeMs: stat.mtimeMs, sequence: sequence ? Number(sequence) : undefined };
    }));
    return segments.sort((a, b) => {
      if (a.sequence !== undefined && b.sequence !== undefined) return a.sequence - b.sequence;
      return a.mtimeMs - b.mtimeMs || (a.sequence ?? 0) - (b.sequence ?? 0) || a.entry.localeCompare(b.entry);
    }).map(({ file }) => file);
  }

  private async nextTraceSegmentSequence(sessionId: string): Promise<number> {
    const sequenceFile = path.join(this.layout.sessionDir(sessionId), 'trace.sequence');
    const configured = await fs.readFile(sequenceFile, 'utf8')
      .then((value) => Number.parseInt(value, 10))
      .catch(() => 0);
    const existing = await this.listTraceSegmentFiles(sessionId);
    const maximumExisting = existing.reduce((maximum, file) => {
      const sequence = Number(/^trace\.(\d{12})\./.exec(path.basename(file))?.[1] ?? 0);
      return Math.max(maximum, sequence);
    }, 0);
    const next = Math.max(Number.isSafeInteger(configured) ? configured : 0, maximumExisting) + 1;
    const temporary = `${sequenceFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, `${next}\n`, 'utf8');
      await fs.rename(temporary, sequenceFile);
    } finally {
      await fs.remove(temporary).catch(() => undefined);
    }
    return next;
  }

  private async pruneTraceSegments(sessionId: string): Promise<void> {
    const policy = loadHookTracePolicy(this.repoPath);
    const activeFile = this.traceFile(sessionId);
    const activeBytes = await fs.stat(activeFile).then((stat) => stat.size).catch(() => 0);
    const segments = await this.listTraceSegmentFiles(sessionId);
    const segmentStats = await Promise.all(segments.map(async (file) => ({
      file,
      bytes: await fs.stat(file).then((stat) => stat.size).catch(() => 0),
    })));
    let totalBytes = activeBytes + segmentStats.reduce((sum, item) => sum + item.bytes, 0);
    let retained = segmentStats.length;
    for (const segment of segmentStats) {
      if (retained <= policy.retainedTraceSegments && totalBytes <= policy.maxSessionTraceBytes) {
        break;
      }
      await fs.remove(segment.file);
      retained -= 1;
      totalBytes -= segment.bytes;
    }
  }

  private async appendTraceLine(
    sessionId: string,
    trace: HarnessTraceRecord
  ): Promise<HarnessTraceRecord | undefined> {
    await this.ensureSessionDir(sessionId);
    const activeFile = this.traceFile(sessionId);
    const serialized = `${JSON.stringify(trace)}\n`;
    const activeBytes = await fs.stat(activeFile).then((stat) => stat.size).catch(() => 0);
    const policy = loadHookTracePolicy(this.repoPath);
    let rotationTrace: HarnessTraceRecord | undefined;

    if (activeBytes > 0 && activeBytes + Buffer.byteLength(serialized, 'utf8') > policy.traceRotationBytes) {
      const sequence = await this.nextTraceSegmentSequence(sessionId);
      const rotationId = `${String(sequence).padStart(12, '0')}.${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
      const segmentFile = `${this.traceSegmentPrefix(sessionId)}${rotationId}.jsonl`;
      await fs.rename(activeFile, segmentFile);
      rotationTrace = boundGenericTraceRecord<HarnessTraceRecord>({
        id: randomUUID(),
        sessionId,
        level: 'info',
        event: 'trace.rotated',
        message: 'Trace segment rotated',
        createdAt: nowIso(),
        data: {
          segment: path.basename(segmentFile),
          rotationCount: (await this.listTraceSegmentFiles(sessionId)).length,
          quotaStatus: 'within_limit',
        },
      }, loadGenericTraceEventMaxBytes(this.repoPath));
      await fs.appendFile(activeFile, `${JSON.stringify(rotationTrace)}\n`, 'utf8');
    }

    await fs.appendFile(activeFile, serialized, 'utf8');
    await this.updateSensorSummary(sessionId, trace);
    await this.pruneTraceSegments(sessionId);
    return rotationTrace;
  }

  private async updateSensorSummary(sessionId: string, trace: HarnessTraceRecord): Promise<void> {
    if (trace.event !== 'sensor.run' || !trace.data?.run || typeof trace.data.run !== 'object') return;
    const run = trace.data.run as Record<string, unknown>;
    if (typeof run.sensorId !== 'string') return;
    const sensorId = run.sensorId;
    let boundedRun = run;
    if (Buffer.byteLength(JSON.stringify(run), 'utf8') > MAX_SENSOR_SUMMARY_ENTRY_BYTES) {
      boundedRun = {
        id: run.id,
        sensorId,
        sessionId: run.sessionId,
        contractId: run.contractId,
        severity: run.severity,
        blocking: run.blocking,
        createdAt: run.createdAt,
        status: run.status,
        summary: typeof run.summary === 'string' ? run.summary.slice(0, 8 * 1024) : String(run.summary ?? ''),
        truncated: true,
      };
    }
    const shard: HarnessSensorSummaryShard = {
      version: 1,
      sensorId,
      updatedAt: trace.createdAt,
      run: boundedRun,
    };
    await fs.ensureDir(this.sensorSummaryDir(sessionId));
    const target = this.sensorSummaryShardFile(sessionId, sensorId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeJson(temporary, shard);
    await fs.rename(temporary, target);
    const metadataFile = this.sensorSummaryMetadataFile(sessionId);
    const metadata = await nodeFs.stat(metadataFile).then(stat => stat.size <= 4096 ? fs.readJson(metadataFile) : undefined).catch(() => undefined) as { runCount?: number } | undefined;
    const metadataTemporary = `${metadataFile}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeJson(metadataTemporary, { version: 1, updatedAt: trace.createdAt, runCount: Math.max(0, metadata?.runCount ?? 0) + 1 });
    await fs.rename(metadataTemporary, metadataFile);
    await this.pruneSensorSummaryShards(sessionId);
  }

  private async pruneSensorSummaryShards(sessionId: string): Promise<void> {
    const directoryPath = this.sensorSummaryDir(sessionId);
    if (!(await fs.pathExists(directoryPath))) return;
    const entries: Array<{ file: string; bytes: number; mtime: number }> = [];
    const directory = await nodeFs.opendir(directoryPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'meta.json') continue;
      const file = path.join(directoryPath, entry.name);
      const stat = await nodeFs.stat(file);
      entries.push({ file, bytes: stat.size, mtime: stat.mtimeMs });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    let retainedBytes = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (index >= MAX_SENSOR_SUMMARY_ENTRIES || entry.bytes > MAX_SENSOR_SUMMARY_ENTRY_BYTES || retainedBytes + entry.bytes > MAX_SENSOR_SUMMARY_BYTES) {
        await fs.remove(entry.file);
      } else {
        retainedBytes += entry.bytes;
      }
    }
  }

  private async readShardedSensorSummary(sessionId: string): Promise<HarnessSensorSummary | undefined> {
    const directoryPath = this.sensorSummaryDir(sessionId);
    if (!(await fs.pathExists(directoryPath))) return undefined;
    const entries: Array<{ file: string; bytes: number; mtime: number }> = [];
    const directory = await nodeFs.opendir(directoryPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name === 'meta.json') continue;
      const file = path.join(directoryPath, entry.name);
      const stat = await nodeFs.stat(file);
      if (stat.size <= MAX_SENSOR_SUMMARY_ENTRY_BYTES) entries.push({ file, bytes: stat.size, mtime: stat.mtimeMs });
    }
    entries.sort((a, b) => b.mtime - a.mtime);
    const latestBySensor: Record<string, unknown> = {};
    let totalBytes = 0;
    let updatedAt = '';
    for (const entry of entries.slice(0, MAX_SENSOR_SUMMARY_ENTRIES)) {
      if (totalBytes + entry.bytes > MAX_SENSOR_SUMMARY_BYTES) break;
      try {
        const shard = await fs.readJson(entry.file) as HarnessSensorSummaryShard;
        if (typeof shard.sensorId !== 'string' || !shard.run) continue;
        latestBySensor[shard.sensorId] = shard.run;
        updatedAt = updatedAt > shard.updatedAt ? updatedAt : shard.updatedAt;
        totalBytes += entry.bytes;
      } catch { /* skip a corrupt shard */ }
    }
    const metadataFile = this.sensorSummaryMetadataFile(sessionId);
    const metadata = await nodeFs.stat(metadataFile).then(stat => stat.size <= 4096 ? fs.readJson(metadataFile) : undefined).catch(() => undefined) as { runCount?: number; updatedAt?: string } | undefined;
    return { version: 1, updatedAt: metadata?.updatedAt ?? (updatedAt || nowIso()), latestBySensor, runCount: Math.max(Object.keys(latestBySensor).length, metadata?.runCount ?? 0) };
  }

  async getSensorSummary(sessionId: string): Promise<HarnessSensorSummary> {
    const sharded = await this.readShardedSensorSummary(sessionId);
    if (sharded) return sharded;
    const target = this.sensorSummaryFile(sessionId);
    let legacyFallback: HarnessSensorSummary | undefined;
    if (await fs.pathExists(target)) {
      try {
        const stat = await nodeFs.stat(target);
        if (stat.size <= MAX_SENSOR_SUMMARY_BYTES) {
          legacyFallback = await fs.readJson(target) as HarnessSensorSummary;
          await fs.remove(target);
        }
      } catch { /* migrate from bounded trace records below */ }
    }
    const latestBySensor: Record<string, unknown> = {};
    let retainedBytes = 0;
    let runCount = 0;
    for await (const trace of this.iterateTraces(sessionId)) {
      const run = trace.data?.run as Record<string, unknown> | undefined;
      if (trace.event !== 'sensor.run' || typeof run?.sensorId !== 'string') continue;
      runCount += 1;
      const bytes = Buffer.byteLength(JSON.stringify(run), 'utf8');
      if (!(run.sensorId in latestBySensor) && Object.keys(latestBySensor).length >= MAX_SENSOR_SUMMARY_ENTRIES) continue;
      if (bytes > MAX_SENSOR_SUMMARY_ENTRY_BYTES || retainedBytes + bytes > MAX_SENSOR_SUMMARY_BYTES) continue;
      const previous = latestBySensor[run.sensorId];
      if (previous) retainedBytes -= Buffer.byteLength(JSON.stringify(previous), 'utf8');
      latestBySensor[run.sensorId] = run;
      retainedBytes += bytes;
    }
    if (runCount === 0 && legacyFallback) {
      for (const [sensorId, run] of Object.entries(legacyFallback.latestBySensor).slice(0, MAX_SENSOR_SUMMARY_ENTRIES)) {
        latestBySensor[sensorId] = run;
      }
      runCount = Math.max(Object.keys(latestBySensor).length, legacyFallback.runCount ?? 0);
    }
    const summary: HarnessSensorSummary = { version: 1, updatedAt: nowIso(), latestBySensor, runCount };
    await this.ensureSessionDir(sessionId);
    await fs.ensureDir(this.sensorSummaryDir(sessionId));
    for (const [sensorId, run] of Object.entries(latestBySensor)) {
      await this.updateSensorSummary(sessionId, {
        id: randomUUID(), sessionId, level: 'info', event: 'sensor.run', message: 'sensor summary migration',
        createdAt: (run as Record<string, unknown>).createdAt as string ?? summary.updatedAt, data: { run: run as Record<string, unknown> },
      });
    }
    await fs.writeJson(this.sensorSummaryMetadataFile(sessionId), { version: 1, updatedAt: summary.updatedAt, runCount });
    return (await this.readShardedSensorSummary(sessionId)) ?? summary;
  }

  private async recordTrace(sessionId: string, trace: HarnessTraceRecord): Promise<HarnessTraceRecord> {
    // Preserve the established missing/corrupt-session error contract before creating a lock file.
    if (!fs.pathExistsSync(this.sessionFile(sessionId))) {
      throw new Error(`Harness session not found: ${sessionId}`);
    }
    return withTraceWriteLock(this.traceFile(sessionId), async () => {
      const session = await this.readSession(sessionId);
      const policy = loadHookTracePolicy(this.repoPath);
      const traceBudget = Math.max(
        1024,
        Math.min(
          loadGenericTraceEventMaxBytes(this.repoPath),
          policy.traceRotationBytes - ROTATION_EVENT_RESERVE_BYTES,
          policy.maxSessionTraceBytes - ROTATION_EVENT_RESERVE_BYTES
        )
      );
      const boundedTrace = boundGenericTraceRecord(trace, traceBudget);
      const rotationTrace = await this.appendTraceLine(sessionId, boundedTrace);

      session.traceCount += rotationTrace ? 2 : 1;
      session.lastTraceAt = boundedTrace.createdAt;
      session.updatedAt = boundedTrace.createdAt;
      await this.saveSession(session);

      return boundedTrace;
    });
  }

  async createSession(input: CreateSessionInput): Promise<HarnessSessionRecord> {
    const createdAt = nowIso();
    const session: HarnessSessionRecord = {
      id: randomUUID(),
      name: input.name,
      status: 'active',
      repoPath: this.repoPath,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      traceCount: 0,
      artifactCount: 0,
      checkpointCount: 0,
      checkpoints: [],
      metadata: input.metadata,
    };

    await this.saveSession(session);
    await this.recordTrace(session.id, {
      id: randomUUID(),
      sessionId: session.id,
      level: 'info',
      event: 'session.created',
      message: `Session created: ${input.name}`,
      createdAt,
      data: input.metadata ? { metadata: input.metadata } : undefined,
    });

    return this.readSession(session.id);
  }

  async listSessions(): Promise<HarnessSessionRecord[]> {
    const sessions: HarnessSessionRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listSessionPage({ limit: 200, cursor });
      sessions.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  async listSessionPage(query: RuntimeHistoryQuery = {}): Promise<RuntimeHistoryPage<HarnessSessionRecord>> {
    const started = Date.now();
    const limit = boundedLimit(query.limit, 50, 200, 'sessions');
    const byteBudget = boundedPageBytes(query.maxBytes, 'sessions');
    const direction = query.direction ?? 'newest';
    const binding = queryBinding({ direction });
    const boundary = decodeHistoryCursor<{ updatedAt: string; id: string }>(query.cursor, 'sessions', binding);
    await this.ensureLayout();
    const selected: Array<{ file: string; updatedAt: string; id: string; bytes: number }> = [];
    let recordsScanned = 0;
    let eligibleRecords = 0;
    let oversizedRecordsSkipped = 0;
    const directory = await nodeFs.opendir(this.sessionsPath);
    for await (const entry of directory) {
      if (!entry.isDirectory()) continue;
      try {
        const file = this.sessionFile(entry.name);
        const stat = await nodeFs.stat(file);
        if (stat.size + 2 > byteBudget) {
          oversizedRecordsSkipped += 1;
          continue;
        }
        const session = JSON.parse(await nodeFs.readFile(file, 'utf8')) as HarnessSessionRecord;
        recordsScanned += 1;
        const key = `${session.updatedAt}\0${session.id}`;
        const boundaryKey = boundary ? `${boundary.updatedAt}\0${boundary.id}` : undefined;
        if (boundaryKey && (direction === 'newest' ? key >= boundaryKey : key <= boundaryKey)) continue;
        const bytes = serializedHistoryItemBytes(session);
        if (bytes + 2 > byteBudget) {
          oversizedRecordsSkipped += 1;
          continue;
        }
        eligibleRecords += 1;
        selected.push({ file, updatedAt: session.updatedAt, id: session.id, bytes });
        selected.sort((a, b) => direction === 'newest'
          ? b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)
          : a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
        if (selected.length > limit + 1) selected.pop();
      } catch { /* skip corrupt legacy records */ }
    }
    const chosen: typeof selected = [];
    let returnedBytes = 2;
    let byteLimited = false;
    for (const candidate of selected) {
      if (chosen.length === limit) break;
      const candidateTotal = returnedBytes + candidate.bytes + (chosen.length > 0 ? 1 : 0);
      if (candidateTotal > byteBudget) {
        byteLimited = true;
        break;
      }
      chosen.push(candidate);
      returnedBytes = candidateTotal;
    }
    const items: HarnessSessionRecord[] = [];
    for (const candidate of chosen) {
      items.push(JSON.parse(await nodeFs.readFile(candidate.file, 'utf8')) as HarnessSessionRecord);
    }
    const hasMore = eligibleRecords > chosen.length;
    const last = chosen.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeHistoryCursor('sessions', binding, { updatedAt: last.updatedAt, id: last.id }) : undefined,
      hasMore,
      recordsReturned: items.length,
      recordsScanned,
      returnedBytes,
      byteBudget,
      byteLimited,
      oversizedRecordsSkipped,
      cursorVersion: 1,
      partial: hasMore || oversizedRecordsSkipped > 0,
      durationMs: Date.now() - started,
    };
  }

  async getSession(sessionId: string): Promise<HarnessSessionRecord> {
    return this.readSession(sessionId);
  }

  async appendTrace(sessionId: string, input: AppendTraceInput): Promise<HarnessTraceRecord> {
    const createdAt = nowIso();
    const trace: HarnessTraceRecord = {
      id: randomUUID(),
      sessionId,
      level: input.level,
      event: input.event,
      message: input.message,
      createdAt,
      data: input.data,
    };

    return this.recordTrace(sessionId, trace);
  }

  async addArtifact(sessionId: string, input: AddArtifactInput): Promise<HarnessArtifactRecord> {
    const session = await this.readSession(sessionId);
    const createdAt = nowIso();
    const artifact: HarnessArtifactRecord = {
      id: randomUUID(),
      sessionId,
      name: input.name,
      kind: input.kind || 'text',
      createdAt,
      content: normalizeContent(input.content),
      path: input.path,
      metadata: input.metadata,
    };

    await fs.ensureDir(path.dirname(this.artifactFile(sessionId, artifact.id)));
    await fs.writeJson(this.artifactFile(sessionId, artifact.id), artifact, { spaces: 2 });

    session.artifactCount += 1;
    session.updatedAt = createdAt;
    await this.saveSession(session);
    await this.recordTrace(sessionId, {
      id: randomUUID(),
      sessionId,
      level: 'info',
      event: 'artifact.added',
      message: `Artifact recorded: ${input.name}`,
      createdAt,
      data: {
        artifactId: artifact.id,
        kind: artifact.kind,
        path: artifact.path,
      },
    });

    return artifact;
  }

  async listCheckpoints(sessionId: string): Promise<HarnessSessionCheckpoint[]> {
    const session = await this.readSession(sessionId);
    return [...session.checkpoints].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listArtifacts(sessionId: string): Promise<HarnessArtifactRecord[]> {
    const artifacts: HarnessArtifactRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listArtifactPage(sessionId, { limit: 200, cursor, direction: 'oldest' });
      artifacts.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return artifacts;
  }

  async listArtifactPage(sessionId: string, query: RuntimeHistoryQuery = {}): Promise<RuntimeHistoryPage<HarnessArtifactRecord>> {
    const started = Date.now();
    const limit = boundedLimit(query.limit, 50, 200, 'artifacts');
    const byteBudget = boundedPageBytes(query.maxBytes, 'artifacts');
    const direction = query.direction ?? 'newest';
    const binding = queryBinding({ sessionId, direction });
    const boundary = decodeHistoryCursor<{ createdAt: string; id: string }>(query.cursor, 'artifacts', binding);
    const dir = this.layout.sessionArtifactsDir(sessionId);
    const selected: Array<{ file: string; createdAt: string; id: string; bytes: number }> = [];
    let recordsScanned = 0;
    let eligibleRecords = 0;
    let oversizedRecordsSkipped = 0;
    if (await fs.pathExists(dir)) {
      const directory = await nodeFs.opendir(dir);
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const file = path.join(dir, entry.name);
          const stat = await nodeFs.stat(file);
          if (stat.size + 2 > byteBudget) {
            oversizedRecordsSkipped += 1;
            continue;
          }
          const artifact = JSON.parse(await nodeFs.readFile(file, 'utf8')) as HarnessArtifactRecord;
          recordsScanned += 1;
          const key = `${artifact.createdAt}\0${artifact.id}`;
          const boundaryKey = boundary ? `${boundary.createdAt}\0${boundary.id}` : undefined;
          if (boundaryKey && (direction === 'newest' ? key >= boundaryKey : key <= boundaryKey)) continue;
          const bytes = serializedHistoryItemBytes(artifact);
          if (bytes + 2 > byteBudget) {
            oversizedRecordsSkipped += 1;
            continue;
          }
          eligibleRecords += 1;
          selected.push({ file, createdAt: artifact.createdAt, id: artifact.id, bytes });
          selected.sort((a, b) => direction === 'newest'
            ? b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
            : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          if (selected.length > limit + 1) selected.pop();
        } catch { /* skip corrupt legacy records */ }
      }
    }
    const chosen: typeof selected = [];
    let returnedBytes = 2;
    let byteLimited = false;
    for (const candidate of selected) {
      if (chosen.length === limit) break;
      const candidateTotal = returnedBytes + candidate.bytes + (chosen.length > 0 ? 1 : 0);
      if (candidateTotal > byteBudget) {
        byteLimited = true;
        break;
      }
      chosen.push(candidate);
      returnedBytes = candidateTotal;
    }
    const items: HarnessArtifactRecord[] = [];
    for (const candidate of chosen) {
      items.push(JSON.parse(await nodeFs.readFile(candidate.file, 'utf8')) as HarnessArtifactRecord);
    }
    const hasMore = eligibleRecords > chosen.length;
    const last = chosen.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeHistoryCursor('artifacts', binding, { createdAt: last.createdAt, id: last.id }) : undefined,
      hasMore,
      recordsReturned: items.length,
      recordsScanned,
      returnedBytes,
      byteBudget,
      byteLimited,
      oversizedRecordsSkipped,
      cursorVersion: 1,
      partial: hasMore || oversizedRecordsSkipped > 0,
      durationMs: Date.now() - started,
    };
  }

  async listTraces(sessionId: string): Promise<HarnessTraceRecord[]> {
    const traces: HarnessTraceRecord[] = [];
    for await (const trace of this.iterateTraces(sessionId)) traces.push(trace);
    return traces;
  }

  async *iterateTraces(sessionId: string): AsyncGenerator<HarnessTraceRecord> {
    const files = [...await this.listTraceSegmentFiles(sessionId)];
    const active = this.traceFile(sessionId);
    if (await fs.pathExists(active)) files.push(active);
    for (const file of files) {
      for await (const item of readLinesForward(file)) {
        if (item.oversized || !item.line.trim()) continue;
        try { yield JSON.parse(item.line) as HarnessTraceRecord; } catch { /* bounded malformed diagnostic in pages */ }
      }
    }
  }

  async listTracePage(sessionId: string, query: HarnessTracePageQuery = {}): Promise<RuntimeHistoryPage<HarnessTraceRecord>> {
    const started = Date.now();
    const limit = boundedLimit(query.limit, 100, 1000, 'traces');
    const byteBudget = boundedPageBytes(query.maxBytes, 'traces');
    const direction: RuntimeHistoryDirection = query.direction ?? 'newest';
    const filters = { sessionId, direction, event: query.event, level: query.level, createdAfter: query.createdAfter, createdBefore: query.createdBefore };
    const binding = queryBinding(filters);
    const cursor = decodeHistoryCursor<TraceCursorPosition>(query.cursor, 'traces', binding);
    const active = this.traceFile(sessionId);
    const chronological = [...await this.listTraceSegmentFiles(sessionId), ...(await fs.pathExists(active) ? [active] : [])];
    const stats = await Promise.all(chronological.map(async file => {
      const stat = await nodeFs.stat(file);
      return { file, size: stat.size, mtime: stat.mtimeMs };
    }));
    const fingerprint = queryBinding(stats.map(item => [path.basename(item.file), item.size, item.mtime]));
    if (cursor && cursor.fingerprint !== fingerprint) {
      throw new RuntimeHistoryCursorError('Invalid or stale runtime history cursor: trace segments changed');
    }
    const files = direction === 'newest' ? [...chronological].reverse() : chronological;
    let startIndex = cursor ? files.findIndex(file => path.basename(file) === cursor.file) : 0;
    if (cursor && startIndex < 0) {
      throw new RuntimeHistoryCursorError('Invalid or stale runtime history cursor: segment no longer exists');
    }
    const items: HarnessTraceRecord[] = [];
    let recordsScanned = 0;
    let scannedBytes = 0;
    let malformedCount = 0;
    let returnedBytes = 2;
    let oversizedRecordsSkipped = 0;
    let byteLimited = false;
    let hasMore = false;
    let nextPosition: TraceCursorPosition | undefined;
    outer: for (let index = startIndex; index < files.length; index += 1) {
      const file = files[index];
      const initialOffset = index === startIndex ? cursor?.offset : undefined;
      const iterator = direction === 'newest' ? readLinesReverse(file, initialOffset) : readLinesForward(file, initialOffset ?? 0);
      for await (const line of iterator) {
        scannedBytes += line.bytesRead;
        if (line.oversized) { malformedCount += 1; continue; }
        if (!line.line.trim()) continue;
        let trace: HarnessTraceRecord;
        try { trace = JSON.parse(line.line) as HarnessTraceRecord; } catch { malformedCount += 1; continue; }
        recordsScanned += 1;
        if (query.event && trace.event !== query.event) continue;
        if (query.level && trace.level !== query.level) continue;
        if (query.createdAfter && trace.createdAt <= query.createdAfter) continue;
        if (query.createdBefore && trace.createdAt >= query.createdBefore) continue;
        if (items.length === limit) { hasMore = true; break outer; }
        const traceBytes = serializedHistoryItemBytes(trace);
        const candidateBytes = returnedBytes + traceBytes + (items.length > 0 ? 1 : 0);
        if (candidateBytes > byteBudget) {
          if (items.length > 0) {
            hasMore = true;
            byteLimited = true;
            break outer;
          }
          // A record larger than an otherwise empty page can never be returned
          // under this budget. Consume it, report the typed skip, and continue
          // so a cursor can never loop forever on the same valid line.
          oversizedRecordsSkipped += 1;
          byteLimited = true;
          nextPosition = { file: path.basename(file), offset: line.nextOffset, fingerprint };
          continue;
        }
        items.push(trace);
        returnedBytes = candidateBytes;
        nextPosition = { file: path.basename(file), offset: line.nextOffset, fingerprint };
      }
      if (items.length > 0) nextPosition = { file: path.basename(files[index + 1] ?? file), offset: direction === 'newest' ? Number.MAX_SAFE_INTEGER : 0, fingerprint };
    }
    return {
      items,
      nextCursor: hasMore && nextPosition ? encodeHistoryCursor('traces', binding, nextPosition) : undefined,
      hasMore,
      recordsReturned: items.length,
      recordsScanned,
      scannedBytes,
      returnedBytes,
      byteBudget,
      byteLimited,
      oversizedRecordsSkipped,
      malformedCount,
      cursorVersion: 1,
      partial: hasMore || oversizedRecordsSkipped > 0,
      durationMs: Date.now() - started,
    };
  }

  async checkpointSession(sessionId: string, input: CheckpointInput = {}): Promise<HarnessSessionRecord> {
    const session = await this.readSession(sessionId);
    const createdAt = nowIso();
    const checkpoint: HarnessSessionCheckpoint = {
      id: randomUUID(),
      note: input.note,
      data: input.data,
      artifactIds: input.artifactIds || [],
      createdAt,
    };

    session.checkpoints.push(checkpoint);
    session.checkpointCount = session.checkpoints.length;
    session.lastCheckpointAt = createdAt;
    session.updatedAt = createdAt;
    session.status = input.pause ? 'paused' : session.status;

    await this.saveSession(session);
    await this.recordTrace(sessionId, {
      id: randomUUID(),
      sessionId,
      level: 'info',
      event: input.pause ? 'session.paused' : 'session.checkpointed',
      message: input.note ? `Checkpoint recorded: ${input.note}` : 'Checkpoint recorded',
      createdAt,
      data: {
        checkpointId: checkpoint.id,
        artifactIds: checkpoint.artifactIds,
        payload: input.data,
      },
    });

    return this.readSession(sessionId);
  }

  async resumeSession(sessionId: string): Promise<HarnessSessionRecord> {
    const session = await this.readSession(sessionId);
    const createdAt = nowIso();

    if (session.status === 'completed' || session.status === 'failed') {
      throw new Error(`Cannot resume a ${session.status} session: ${sessionId}`);
    }

    session.status = 'active';
    session.updatedAt = createdAt;
    await this.saveSession(session);
    await this.recordTrace(sessionId, {
      id: randomUUID(),
      sessionId,
      level: 'info',
      event: 'session.resumed',
      message: 'Session resumed',
      createdAt,
    });

    return this.readSession(sessionId);
  }

  async completeSession(sessionId: string, note?: string): Promise<HarnessSessionRecord> {
    const session = await this.readSession(sessionId);
    const createdAt = nowIso();
    session.status = 'completed';
    session.completedAt = createdAt;
    session.updatedAt = createdAt;
    await this.saveSession(session);
    await this.recordTrace(sessionId, {
      id: randomUUID(),
      sessionId,
      level: 'info',
      event: 'session.completed',
      message: note ? `Session completed: ${note}` : 'Session completed',
      createdAt,
    });
    return this.readSession(sessionId);
  }

  async failSession(sessionId: string, message: string): Promise<HarnessSessionRecord> {
    const session = await this.readSession(sessionId);
    const createdAt = nowIso();
    session.status = 'failed';
    session.failedAt = createdAt;
    session.updatedAt = createdAt;
    await this.saveSession(session);
    await this.recordTrace(sessionId, {
      id: randomUUID(),
      sessionId,
      level: 'error',
      event: 'session.failed',
      message,
      createdAt,
    });
    return this.readSession(sessionId);
  }
}

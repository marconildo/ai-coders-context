/**
 * Harness Runtime State Service
 *
 * Transport-agnostic persistence for sessions, artifacts, traces, and checkpoints.
 * State lives under .context/runtime/sessions, one folder per session, so future
 * adapters can share it. Paths are resolved through the shared runtime layout.
 */

import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { promises as nodeFs } from 'fs';
import type { FileHandle } from 'fs/promises';
import { resolveRuntimeLayout, type RuntimeLayout } from '../../../../shared/fs/pathHelpers';
import {
  boundGenericTraceRecord,
  loadGenericTraceEventMaxBytes,
  loadHookTracePolicy,
} from '../../../application/hooks/hookTracePolicy';

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
    await this.pruneTraceSegments(sessionId);
    return rotationTrace;
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
    await this.ensureLayout();
    const entries = await fs.readdir(this.sessionsPath, { withFileTypes: true });
    const sessions: HarnessSessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const file = this.sessionFile(entry.name);
        sessions.push((await fs.readJson(file)) as HarnessSessionRecord);
      } catch {
        // Skip sessions with missing or unparseable session.json.
        continue;
      }
    }

    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
    const dir = this.layout.sessionArtifactsDir(sessionId);
    if (!(await fs.pathExists(dir))) {
      return [];
    }

    const entries = await fs.readdir(dir);
    const artifacts: HarnessArtifactRecord[] = [];
    for (const entry of entries.filter((entry) => entry.endsWith('.json'))) {
      try {
        artifacts.push((await fs.readJson(path.join(dir, entry))) as HarnessArtifactRecord);
      } catch {
        // Skip missing or unparseable artifact files.
        continue;
      }
    }

    return artifacts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listTraces(sessionId: string): Promise<HarnessTraceRecord[]> {
    const activeFile = this.traceFile(sessionId);
    const files = [
      ...(await this.listTraceSegmentFiles(sessionId)),
      ...(await fs.pathExists(activeFile) ? [activeFile] : []),
    ];
    if (files.length === 0) {
      return [];
    }

    const contents = await Promise.all(files.map((file) => fs.readFile(file, 'utf8')));
    return contents.join('')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HarnessTraceRecord];
        } catch {
          // Drop malformed/partially-written trace lines.
          return [];
        }
      });
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

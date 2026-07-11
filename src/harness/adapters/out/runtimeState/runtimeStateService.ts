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
import {
  boundedLimit,
  RUNTIME_HISTORY_LIMITS,
  decodeHistoryCursor,
  encodeHistoryCursor,
  queryBinding,
  RuntimeHistoryCursorError,
  type RuntimeHistoryDirection,
  type RuntimeHistoryPage,
  type RuntimeHistoryQuery,
} from '../../../application/history/runtimeHistory';

const traceWriteQueues = new Map<string, Promise<void>>();

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

async function acquireTraceFileLock(
  traceFile: string
): Promise<{ lockFile: string; handle: FileHandle; inode: bigint | number }> {
  const lockFile = `${traceFile}.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await nodeFs.open(lockFile, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, 'utf8');
      const stat = await handle.stat({ bigint: true });
      return { lockFile, handle, inode: stat.ino };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      const [age, ownerPid] = await Promise.all([
        nodeFs.stat(lockFile).then((stat) => Date.now() - stat.mtimeMs).catch(() => 0),
        nodeFs.readFile(lockFile, 'utf8')
          .then((value) => Number.parseInt(value.split(/\s/, 1)[0], 10))
          .catch(() => Number.NaN),
      ]);
      if (age > 60_000 && !isProcessAlive(ownerPid)) {
        await nodeFs.unlink(lockFile).catch(() => undefined);
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
    const currentInode = await nodeFs.stat(lock.lockFile, { bigint: true })
      .then((stat) => stat.ino)
      .catch(() => undefined);
    if (currentInode === lock.inode) {
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
}

async function* readLinesForward(file: string, startOffset = 0): AsyncGenerator<TraceLine> {
  const handle = await nodeFs.open(file, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = startOffset;
  let carry = Buffer.alloc(0);
  let carryStart = startOffset;
  try {
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : Buffer.from(chunk.subarray(0, bytesRead));
      let lineStart = 0;
      for (let index = 0; index < data.length; index += 1) {
        if (data[index] !== 0x0a) continue;
        const nextOffset = carryStart + index + 1;
        yield { line: data.subarray(lineStart, index).toString('utf8').replace(/\r$/, ''), nextOffset, bytesRead };
        lineStart = index + 1;
      }
      carry = Buffer.from(data.subarray(lineStart));
      carryStart += lineStart;
      position += bytesRead;
    }
    if (carry.length > 0) yield { line: carry.toString('utf8').replace(/\r$/, ''), nextOffset: position, bytesRead: 0 };
  } finally {
    await handle.close();
  }
}

async function* readLinesReverse(file: string, startOffset?: number): AsyncGenerator<TraceLine> {
  const handle = await nodeFs.open(file, 'r');
  const size = (await handle.stat()).size;
  let position = Math.min(startOffset ?? size, size);
  let carry = Buffer.alloc(0);
  try {
    while (position > 0) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      const data = carry.length ? Buffer.concat([chunk.subarray(0, bytesRead), carry]) : Buffer.from(chunk.subarray(0, bytesRead));
      const newlines: number[] = [];
      for (let index = 0; index < data.length; index += 1) if (data[index] === 0x0a) newlines.push(index);
      if (newlines.length === 0) { carry = data; continue; }
      for (let index = newlines.length - 1; index >= 0; index -= 1) {
        const lineStart = newlines[index] + 1;
        const lineEnd = index + 1 < newlines.length ? newlines[index + 1] : data.length;
        const line = data.subarray(lineStart, lineEnd).toString('utf8').replace(/\r?\n$/, '').replace(/\r$/, '');
        if (line.length > 0) yield { line, nextOffset: position + lineStart, bytesRead: index === newlines.length - 1 ? bytesRead : 0 };
      }
      carry = Buffer.from(data.subarray(0, newlines[0]));
    }
    if (carry.length > 0) yield { line: carry.toString('utf8').replace(/\r$/, ''), nextOffset: 0, bytesRead: 0 };
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
    const entries = await fs.readdir(sessionDir);
    return entries
      .filter((entry) => /^trace\..+\.jsonl$/.test(entry))
      .sort()
      .map((entry) => path.join(sessionDir, entry));
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
      const rotationId = `${new Date().toISOString().replace(/[:.]/g, '-')}.${randomUUID()}`;
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
    const current = await this.getSensorSummary(sessionId);
    current.latestBySensor[run.sensorId] = run;
    current.updatedAt = trace.createdAt;
    const target = this.sensorSummaryFile(sessionId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeJson(temporary, current, { spaces: 2 });
    await fs.rename(temporary, target);
  }

  async getSensorSummary(sessionId: string): Promise<HarnessSensorSummary> {
    const target = this.sensorSummaryFile(sessionId);
    if (await fs.pathExists(target)) {
      try { return await fs.readJson(target) as HarnessSensorSummary; } catch { /* migrate below */ }
    }
    const latestBySensor: Record<string, unknown> = {};
    for await (const trace of this.iterateTraces(sessionId)) {
      const run = trace.data?.run as Record<string, unknown> | undefined;
      if (trace.event === 'sensor.run' && typeof run?.sensorId === 'string') latestBySensor[run.sensorId] = run;
    }
    const summary: HarnessSensorSummary = { version: 1, updatedAt: nowIso(), latestBySensor };
    await this.ensureSessionDir(sessionId);
    await fs.writeJson(target, summary, { spaces: 2 });
    return summary;
  }

  private async recordTrace(sessionId: string, trace: HarnessTraceRecord): Promise<HarnessTraceRecord> {
    // Preserve the established missing/corrupt-session error contract before creating a lock file.
    if (!fs.pathExistsSync(this.sessionFile(sessionId))) {
      throw new Error(`Harness session not found: ${sessionId}`);
    }
    return withTraceWriteLock(this.traceFile(sessionId), async () => {
      const session = await this.readSession(sessionId);
      const boundedTrace = boundGenericTraceRecord(trace, loadGenericTraceEventMaxBytes(this.repoPath));
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
    const limit = boundedLimit(query.limit, RUNTIME_HISTORY_LIMITS.sessions.default, RUNTIME_HISTORY_LIMITS.sessions.maximum, 'sessions');
    const direction = query.direction ?? 'newest';
    const binding = queryBinding({ direction });
    const boundary = decodeHistoryCursor<{ updatedAt: string; id: string }>(query.cursor, 'sessions', binding);
    await this.ensureLayout();
    const selected: HarnessSessionRecord[] = [];
    let recordsScanned = 0;
    const directory = await nodeFs.opendir(this.sessionsPath);
    for await (const entry of directory) {
      if (!entry.isDirectory()) continue;
      try {
        const session = await fs.readJson(this.sessionFile(entry.name)) as HarnessSessionRecord;
        recordsScanned += 1;
        const key = `${session.updatedAt}\0${session.id}`;
        const boundaryKey = boundary ? `${boundary.updatedAt}\0${boundary.id}` : undefined;
        if (boundaryKey && (direction === 'newest' ? key >= boundaryKey : key <= boundaryKey)) continue;
        selected.push(session);
        selected.sort((a, b) => direction === 'newest'
          ? b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)
          : a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
        if (selected.length > limit + 1) selected.pop();
      } catch { /* skip corrupt legacy records */ }
    }
    const hasMore = selected.length > limit;
    const items = selected.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeHistoryCursor('sessions', binding, { updatedAt: last.updatedAt, id: last.id }) : undefined,
      hasMore,
      recordsReturned: items.length,
      recordsScanned,
      cursorVersion: 1,
      partial: hasMore,
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
    const limit = boundedLimit(query.limit, RUNTIME_HISTORY_LIMITS.artifacts.default, RUNTIME_HISTORY_LIMITS.artifacts.maximum, 'artifacts');
    const direction = query.direction ?? 'newest';
    const binding = queryBinding({ sessionId, direction });
    const boundary = decodeHistoryCursor<{ createdAt: string; id: string }>(query.cursor, 'artifacts', binding);
    const dir = this.layout.sessionArtifactsDir(sessionId);
    const selected: HarnessArtifactRecord[] = [];
    let recordsScanned = 0;
    if (await fs.pathExists(dir)) {
      const directory = await nodeFs.opendir(dir);
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const artifact = await fs.readJson(path.join(dir, entry.name)) as HarnessArtifactRecord;
          recordsScanned += 1;
          const key = `${artifact.createdAt}\0${artifact.id}`;
          const boundaryKey = boundary ? `${boundary.createdAt}\0${boundary.id}` : undefined;
          if (boundaryKey && (direction === 'newest' ? key >= boundaryKey : key <= boundaryKey)) continue;
          selected.push(artifact);
          selected.sort((a, b) => direction === 'newest'
            ? b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
            : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          if (selected.length > limit + 1) selected.pop();
        } catch { /* skip corrupt legacy records */ }
      }
    }
    const hasMore = selected.length > limit;
    const items = selected.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeHistoryCursor('artifacts', binding, { createdAt: last.createdAt, id: last.id }) : undefined,
      hasMore,
      recordsReturned: items.length,
      recordsScanned,
      cursorVersion: 1,
      partial: hasMore,
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
        if (!item.line.trim()) continue;
        try { yield JSON.parse(item.line) as HarnessTraceRecord; } catch { /* bounded malformed diagnostic in pages */ }
      }
    }
  }

  async listTracePage(sessionId: string, query: HarnessTracePageQuery = {}): Promise<RuntimeHistoryPage<HarnessTraceRecord>> {
    const started = Date.now();
    const limit = boundedLimit(query.limit, RUNTIME_HISTORY_LIMITS.traces.default, RUNTIME_HISTORY_LIMITS.traces.maximum, 'traces');
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
    let hasMore = false;
    let nextPosition: TraceCursorPosition | undefined;
    outer: for (let index = startIndex; index < files.length; index += 1) {
      const file = files[index];
      const initialOffset = index === startIndex ? cursor?.offset : undefined;
      const iterator = direction === 'newest' ? readLinesReverse(file, initialOffset) : readLinesForward(file, initialOffset ?? 0);
      for await (const line of iterator) {
        scannedBytes += line.bytesRead;
        if (!line.line.trim()) continue;
        let trace: HarnessTraceRecord;
        try { trace = JSON.parse(line.line) as HarnessTraceRecord; } catch { malformedCount += 1; continue; }
        recordsScanned += 1;
        if (query.event && trace.event !== query.event) continue;
        if (query.level && trace.level !== query.level) continue;
        if (query.createdAfter && trace.createdAt <= query.createdAfter) continue;
        if (query.createdBefore && trace.createdAt >= query.createdBefore) continue;
        if (items.length === limit) { hasMore = true; break outer; }
        items.push(trace);
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
      malformedCount,
      cursorVersion: 1,
      partial: hasMore,
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

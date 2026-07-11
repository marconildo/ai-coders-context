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
import { resolveRuntimeLayout, type RuntimeLayout } from '../../../../shared/fs/pathHelpers';
import { loadRuntimeRetentionConfig } from '../../../application/retention/runtimeRetentionConfig';

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

export interface ListCheckpointsOptions {
  /** Opaque cursor returned by the preceding page. */
  cursor?: string;
  /** Records per page. Clamped to 1..200 (default 100). */
  limit?: number;
}

export interface HarnessCheckpointPage {
  records: HarnessSessionCheckpoint[];
  nextCursor?: string;
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
  lastCheckpointId?: string;
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
  listCheckpointsPage(sessionId: string, options?: ListCheckpointsOptions): Promise<HarnessCheckpointPage>;
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

function encodeCheckpointCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCheckpointCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^\d+$/.test(decoded)) throw new Error('Invalid checkpoint cursor');
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid checkpoint cursor');
  return offset;
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

  private artifactFile(sessionId: string, artifactId: string): string {
    return this.layout.sessionArtifactFile(sessionId, artifactId);
  }

  private checkpointFile(sessionId: string, checkpointId: string): string {
    return this.layout.sessionCheckpointFile(sessionId, checkpointId);
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

    const session = await fs.readJson(file) as HarnessSessionRecord;
    return { ...session, checkpoints: Array.isArray(session.checkpoints) ? session.checkpoints : [] };
  }

  private async saveSession(session: HarnessSessionRecord): Promise<void> {
    await this.ensureSessionDir(session.id);
    const sessionFile = this.sessionFile(session.id);
    const tmpFile = `${sessionFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      // Preserve legacy inline records until checkpointSession has copied them.
      // New-format sessions carry an empty in-memory array and persist only the summary.
      if (session.checkpoints.length > 0) {
        await fs.writeJson(tmpFile, session, { spaces: 2 });
      } else {
        const { checkpoints: _checkpointPayloads, ...document } = session;
        await fs.writeJson(tmpFile, document, { spaces: 2 });
      }
      await fs.rename(tmpFile, sessionFile);
    } finally {
      await fs.remove(tmpFile).catch(() => undefined);
    }
  }

  private async appendTraceLine(sessionId: string, trace: HarnessTraceRecord): Promise<void> {
    await this.ensureSessionDir(sessionId);
    await fs.appendFile(this.traceFile(sessionId), `${JSON.stringify(trace)}\n`, 'utf8');
  }

  private async recordTrace(sessionId: string, trace: HarnessTraceRecord): Promise<HarnessTraceRecord> {
    const session = await this.readSession(sessionId);
    await this.appendTraceLine(sessionId, trace);

    session.traceCount += 1;
    session.lastTraceAt = trace.createdAt;
    session.updatedAt = trace.createdAt;
    await this.saveSession(session);

    return trace;
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

    return this.getSession(session.id);
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
    // Session lookup is a hot path for trace logging. The record already
    // carries checkpointCount/lastCheckpoint*, so never materialize payload
    // history here. Call listCheckpointsPage() when records are required.
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

  async listCheckpointsPage(
    sessionId: string,
    options: ListCheckpointsOptions = {},
  ): Promise<HarnessCheckpointPage> {
    const session = await this.readSession(sessionId);
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 100)));
    const offset = decodeCheckpointCursor(options.cursor);
    const records: HarnessSessionCheckpoint[] = [];
    let visited = 0;
    let hasMore = false;
    const legacyIds = new Set((session.checkpoints ?? []).map(checkpoint => checkpoint.id));

    const consider = (checkpoint: HarnessSessionCheckpoint): boolean => {
      if (visited < offset) {
        visited += 1;
        return true;
      }
      if (records.length >= limit) {
        hasMore = true;
        return false;
      }
      records.push(checkpoint);
      visited += 1;
      return true;
    };

    for (const checkpoint of session.checkpoints ?? []) {
      if (!consider(checkpoint)) break;
    }

    const dir = this.layout.sessionCheckpointsDir(sessionId);
    if (!hasMore && await fs.pathExists(dir)) {
      const directory = await fs.opendir(dir);
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        try {
          const checkpoint = await fs.readJson(path.join(dir, entry.name)) as HarnessSessionCheckpoint;
          // An interrupted legacy migration can temporarily leave the same
          // record inline and external. It still occupies one logical slot.
          if (legacyIds.has(checkpoint.id)) continue;
          if (!consider(checkpoint)) break;
        } catch {
          // Preserve availability when one record is corrupt or partially written.
        }
      }
    }
    records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      records,
      ...(hasMore ? { nextCursor: encodeCheckpointCursor(visited) } : {}),
    };
  }

  /** Compatibility helper for explicit callers that need the complete history. */
  async listCheckpoints(sessionId: string): Promise<HarnessSessionCheckpoint[]> {
    const checkpoints = new Map<string, HarnessSessionCheckpoint>();
    let cursor: string | undefined;
    do {
      const page = await this.listCheckpointsPage(sessionId, { cursor, limit: 200 });
      for (const checkpoint of page.records) checkpoints.set(checkpoint.id, checkpoint);
      cursor = page.nextCursor;
    } while (cursor);
    return [...checkpoints.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    const file = this.traceFile(sessionId);
    if (!(await fs.pathExists(file))) {
      return [];
    }

    const content = await fs.readFile(file, 'utf8');
    return content
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
    const { config } = await loadRuntimeRetentionConfig(this.repoPath);
    let serializedData = '';
    try {
      if (input.data !== undefined) {
        const encoded = JSON.stringify(input.data);
        if (encoded === undefined) throw new Error('unsupported value');
        serializedData = encoded;
      }
    } catch {
      throw new Error('Checkpoint data must be JSON serializable');
    }
    const dataBytes = Buffer.byteLength(serializedData);
    if (dataBytes > config.checkpoints.maxDataBytes) {
      throw new Error(`Checkpoint data exceeds ${config.checkpoints.maxDataBytes} byte limit`);
    }
    if (input.note !== undefined) {
      if (typeof input.note !== 'string' || Buffer.byteLength(input.note) > config.checkpoints.maxNoteBytes) {
        throw new Error(`Checkpoint note exceeds ${config.checkpoints.maxNoteBytes} byte limit`);
      }
    }
    if ((input.artifactIds?.length ?? 0) > config.checkpoints.maxArtifactIds) {
      throw new Error(`Checkpoint artifactIds exceed ${config.checkpoints.maxArtifactIds} item limit`);
    }
    for (const artifactId of input.artifactIds ?? []) {
      if (typeof artifactId !== 'string' || Buffer.byteLength(artifactId) > config.checkpoints.maxArtifactIdBytes) {
        throw new Error(`Checkpoint artifactId exceeds ${config.checkpoints.maxArtifactIdBytes} byte limit`);
      }
    }
    const createdAt = nowIso();
    const checkpoint: HarnessSessionCheckpoint = {
      id: randomUUID(),
      note: input.note,
      data: input.data,
      artifactIds: input.artifactIds || [],
      createdAt,
    };
    const serializedCheckpoint = JSON.stringify(checkpoint);
    const serializedBytes = Buffer.byteLength(serializedCheckpoint);
    if (serializedBytes > config.checkpoints.maxSerializedBytes) {
      throw new Error(`Checkpoint record exceeds ${config.checkpoints.maxSerializedBytes} byte limit`);
    }

    // Lazy, lossless migration: legacy inline records are copied before the
    // next new-write strips the embedded array from session.json.
    for (const legacy of session.checkpoints ?? []) {
      const file = this.checkpointFile(sessionId, legacy.id);
      if (!await fs.pathExists(file)) {
        await fs.ensureDir(path.dirname(file));
        await fs.writeJson(file, legacy, { spaces: 2 });
      }
    }
    await fs.ensureDir(this.layout.sessionCheckpointsDir(sessionId));
    await fs.writeFile(this.checkpointFile(sessionId, checkpoint.id), serializedCheckpoint, 'utf8');
    const storedCount = Number.isSafeInteger(session.checkpointCount) && session.checkpointCount >= 0
      ? session.checkpointCount
      : 0;
    session.checkpointCount = Math.max(storedCount, session.checkpoints.length) + 1;
    session.checkpoints = [];
    session.lastCheckpointAt = createdAt;
    session.lastCheckpointId = checkpoint.id;
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
        payloadBytes: serializedBytes,
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

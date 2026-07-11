import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';

import type {
  HarnessArtifactRecord,
  HarnessSessionCheckpoint,
  HarnessSessionRecord,
  HarnessTraceRecord,
  HarnessRuntimeStatePort,
} from '../../adapters/out/runtimeState/runtimeStateService';
import { resolveRuntimeLayoutFromRepo } from '../../../shared/fs/pathHelpers';
import { HarnessRuntimeStateService as DefaultHarnessRuntimeStateService } from '../../adapters/out/runtimeState/runtimeStateService';
import { HarnessSensorsService, type HarnessSensorRun } from '../sensors/sensorsService';
import {
  HarnessTaskContractsService,
  type HarnessHandoffContract,
  type HarnessTaskContract,
} from '../contracts/taskContractsService';
import {
  boundedPageBytes,
  boundedLimit,
  decodeHistoryCursor,
  encodeHistoryCursor,
  queryBinding,
  serializedHistoryItemBytes,
  MAX_RUNTIME_HISTORY_PAGE_BYTES,
  type RuntimeHistoryPage,
  type RuntimeHistoryQuery,
} from '../history/runtimeHistory';

export type HarnessReplayEventSource =
  | 'session'
  | 'trace'
  | 'artifact'
  | 'checkpoint'
  | 'sensor'
  | 'task'
  | 'handoff';

export interface HarnessReplayEvent {
  id: string;
  sessionId: string;
  createdAt: string;
  source: HarnessReplayEventSource;
  label: string;
  payload?: Record<string, unknown>;
  record?: HarnessArtifactRecord | HarnessSessionCheckpoint | HarnessTraceRecord | HarnessSensorRun | HarnessTaskContract | HarnessHandoffContract;
}

export interface HarnessReplayRecord {
  id: string;
  sessionId: string;
  repoPath: string;
  createdAt: string;
  replayedAt: string;
  fidelity: 'complete' | 'partial';
  eventCount: number;
  sourceCounts: Record<HarnessReplayEventSource, number>;
  omittedCounts: Record<HarnessReplayEventSource, number>;
  nextCursor?: string;
  summary: string;
  events: HarnessReplayEvent[];
  session: Omit<HarnessSessionRecord, 'checkpoints'> & { checkpoints?: never };
}

export interface HarnessReplayServiceOptions {
  repoPath: string;
  dependencies?: Partial<HarnessReplayDependencies>;
}

export interface ReplaySessionOptions {
  includePayloads?: boolean;
  maxEvents?: number;
  maxBytes?: number;
  cursor?: string;
}

export interface HarnessReplaySummary {
  id: string;
  sessionId: string;
  createdAt: string;
  fidelity: 'complete' | 'partial';
  eventCount: number;
  summary: string;
}

export interface HarnessReplayDependencies {
  stateService: HarnessRuntimeStatePort;
  sensorsService: Pick<HarnessSensorsService, 'getSessionSensorRunPage'>;
  contractsService: Pick<
    HarnessTaskContractsService,
    'listSessionTaskContracts' | 'listSessionHandoffContracts'
  >;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

interface ReplayCursorPosition {
  createdAt: string;
  source: HarnessReplayEventSource;
  id: string;
}

const REPLAY_SOURCE_ORDER: Record<HarnessReplayEventSource, number> = {
  session: 0, trace: 1, artifact: 2, checkpoint: 3, sensor: 4, task: 5, handoff: 6,
};

function replayEventKey(event: Pick<HarnessReplayEvent, 'createdAt' | 'source' | 'id'>): string {
  return `${event.createdAt}\0${String(REPLAY_SOURCE_ORDER[event.source]).padStart(2, '0')}\0${event.id}`;
}

function replayCursorKey(position: ReplayCursorPosition): string {
  return `${position.createdAt}\0${String(REPLAY_SOURCE_ORDER[position.source]).padStart(2, '0')}\0${position.id}`;
}

export class HarnessReplayService {
  private readonly stateService: HarnessReplayDependencies['stateService'];
  private readonly sensorsService: HarnessReplayDependencies['sensorsService'];
  private readonly contractsService: HarnessReplayDependencies['contractsService'];

  constructor(private readonly options: HarnessReplayServiceOptions) {
    const stateService = options.dependencies?.stateService
      ?? new DefaultHarnessRuntimeStateService({ repoPath: options.repoPath });
    const sensorsService = options.dependencies?.sensorsService
      ?? new HarnessSensorsService({ stateService });
    const contractsService = options.dependencies?.contractsService
      ?? new HarnessTaskContractsService({
        repoPath: options.repoPath,
        stateService,
      });

    this.stateService = stateService;
    this.sensorsService = sensorsService;
    this.contractsService = contractsService;
  }

  private get repoPath(): string {
    return path.resolve(this.options.repoPath);
  }

  private get replaysPath(): string {
    return resolveRuntimeLayoutFromRepo(this.repoPath).replaysDir;
  }

  private replayFile(replayId: string): string {
    return path.join(this.replaysPath, `${replayId}.json`);
  }

  private replayMetadataFile(replayId: string): string {
    return path.join(this.replaysPath, `${replayId}.meta.json`);
  }

  private async ensureLayout(): Promise<void> {
    await fs.ensureDir(this.replaysPath);
  }

  private async saveReplay(replay: HarnessReplayRecord): Promise<void> {
    await this.ensureLayout();
    await fs.writeJson(this.replayFile(replay.id), replay, { spaces: 2 });
    await fs.writeJson(this.replayMetadataFile(replay.id), {
      version: 1,
      id: replay.id,
      sessionId: replay.sessionId,
      createdAt: replay.createdAt,
      fidelity: replay.fidelity,
      eventCount: replay.eventCount,
      summary: replay.summary,
    });
  }

  private async readReplay(replayId: string): Promise<HarnessReplayRecord> {
    const filePath = this.replayFile(replayId);
    if (!(await fs.pathExists(filePath))) {
      throw new Error(`Replay not found: ${replayId}`);
    }

    return fs.readJson(filePath) as Promise<HarnessReplayRecord>;
  }

  async buildReplay(
    sessionId: string,
    options: ReplaySessionOptions = {}
  ): Promise<HarnessReplayRecord> {
    const maxEvents = boundedLimit(options.maxEvents, 100, 1000, 'replay events');
    const byteBudget = boundedPageBytes(options.maxBytes, 'replay events');
    const session = await this.stateService.getSession(sessionId);
    const binding = queryBinding({ sessionId, direction: 'oldest', includePayloads: options.includePayloads !== false });
    const boundary = decodeHistoryCursor<ReplayCursorPosition>(options.cursor, 'replay-events', binding);
    const boundaryKey = boundary ? replayCursorKey(boundary) : undefined;
    const pageSize = Math.min(32, maxEvents);
    const sourceTotals: Record<HarnessReplayEventSource, number> = {
      session: 1,
      trace: session.traceCount,
      artifact: session.artifactCount,
      checkpoint: session.checkpointCount,
      sensor: 0,
      task: 0,
      handoff: 0,
    };

    const afterBoundary = (event: HarnessReplayEvent) => !boundaryKey || replayEventKey(event) > boundaryKey;
    const recordFor = <T extends NonNullable<HarnessReplayEvent['record']>>(record: T): T | undefined =>
      options.includePayloads === false ? undefined : record;
    const paged = async function* <T>(
      fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
      map: (item: T) => HarnessReplayEvent
    ): AsyncGenerator<HarnessReplayEvent> {
      let cursor: string | undefined;
      do {
        const page = await fetch(cursor);
        for (const item of page.items) {
          const event = map(item);
          if (afterBoundary(event)) yield event;
        }
        cursor = page.nextCursor;
      } while (cursor);
    };

    const sessionSource = async function* (): AsyncGenerator<HarnessReplayEvent> {
      const event: HarnessReplayEvent = {
        id: `session:${session.id}`, sessionId, createdAt: session.createdAt, source: 'session', label: `session:${session.name}`,
        payload: options.includePayloads === false ? undefined : { id: session.id, status: session.status, metadata: session.metadata ?? null },
      };
      if (afterBoundary(event)) yield event;
    };
    const traceSource = paged(
      cursor => this.stateService.listTracePage(sessionId, { limit: pageSize, cursor, direction: 'oldest', maxBytes: byteBudget }),
      trace => ({ id: trace.id, sessionId, createdAt: trace.createdAt, source: 'trace', label: trace.event, record: recordFor(trace) })
    );
    const artifactSource = paged(
      cursor => this.stateService.listArtifactPage(sessionId, { limit: pageSize, cursor, direction: 'oldest', maxBytes: byteBudget }),
      artifact => ({ id: artifact.id, sessionId, createdAt: artifact.createdAt, source: 'artifact', label: artifact.name, record: recordFor(artifact) })
    );
    const checkpointSource = (async function* (): AsyncGenerator<HarnessReplayEvent> {
      for (const checkpoint of sortByCreatedAt(session.checkpoints)) {
        const event: HarnessReplayEvent = { id: checkpoint.id, sessionId, createdAt: checkpoint.createdAt, source: 'checkpoint', label: checkpoint.note || checkpoint.id, record: recordFor(checkpoint) };
        if (afterBoundary(event)) yield event;
      }
    })();
    const sensorSource = paged(
      cursor => this.sensorsService.getSessionSensorRunPage(sessionId, { limit: pageSize, cursor, direction: 'oldest', maxBytes: byteBudget }),
      run => {
        sourceTotals.sensor += 1;
        return { id: run.id, sessionId, createdAt: run.createdAt, source: 'sensor', label: run.sensorId, record: recordFor(run) };
      }
    );
    const taskSource = paged(
      async cursor => {
        const page = await this.contractsService.listSessionTaskContracts(sessionId, pageSize, byteBudget, cursor);
        sourceTotals.task = page.total;
        return page;
      },
      task => ({ id: task.id, sessionId, createdAt: task.createdAt, source: 'task', label: task.title, record: recordFor(task) })
    );
    const handoffSource = paged(
      async cursor => {
        const page = await this.contractsService.listSessionHandoffContracts(sessionId, pageSize, byteBudget, cursor);
        sourceTotals.handoff = page.total;
        return page;
      },
      handoff => ({ id: handoff.id, sessionId, createdAt: handoff.createdAt, source: 'handoff', label: `${handoff.from} -> ${handoff.to}`, record: recordFor(handoff) })
    );

    const iterators = [sessionSource(), traceSource, artifactSource, checkpointSource, sensorSource, taskSource, handoffSource];
    const heads = await Promise.all(iterators.map(iterator => iterator.next()));
    const orderedEvents: HarnessReplayEvent[] = [];
    let returnedBytes = 2;
    let byteLimited = false;
    let lastConsumed: HarnessReplayEvent | undefined;
    while (orderedEvents.length < maxEvents) {
      let selectedIndex = -1;
      for (let index = 0; index < heads.length; index += 1) {
        if (heads[index].done) continue;
        if (selectedIndex < 0 || replayEventKey(heads[index].value) < replayEventKey(heads[selectedIndex].value)) selectedIndex = index;
      }
      if (selectedIndex < 0) break;
      const candidate = heads[selectedIndex].value;
      const bytes = serializedHistoryItemBytes(candidate);
      const candidateTotal = returnedBytes + bytes + (orderedEvents.length > 0 ? 1 : 0);
      if (candidateTotal > byteBudget && orderedEvents.length > 0) {
        byteLimited = true;
        break;
      }
      lastConsumed = candidate;
      heads[selectedIndex] = await iterators[selectedIndex].next();
      if (candidateTotal > byteBudget) {
        byteLimited = true;
        continue;
      }
      orderedEvents.push(candidate);
      returnedBytes = candidateTotal;
    }
    const hasMore = heads.some(head => !head.done);
    const sourceCounts: Record<HarnessReplayEventSource, number> = {
      ...sourceTotals,
      sensor: sourceTotals.sensor,
    };
    const includedCounts = orderedEvents.reduce((counts, event) => {
      counts[event.source] += 1;
      return counts;
    }, { session: 0, trace: 0, artifact: 0, checkpoint: 0, sensor: 0, task: 0, handoff: 0 } as Record<HarnessReplayEventSource, number>);
    const omittedCounts = Object.fromEntries(Object.entries(sourceCounts).map(([source, count]) => [
      source,
      Math.max(0, count - includedCounts[source as HarnessReplayEventSource]),
    ])) as Record<HarnessReplayEventSource, number>;
    const { checkpoints: _embeddedCheckpoints, ...boundedSession } = session;
    const partial = hasMore || byteLimited || Object.values(omittedCounts).some(count => count > 0);
    const replay: HarnessReplayRecord = {
      id: randomUUID(),
      sessionId,
      repoPath: this.repoPath,
      createdAt: nowIso(),
      replayedAt: nowIso(),
      fidelity: partial ? 'partial' : 'complete',
      eventCount: orderedEvents.length,
      sourceCounts,
      omittedCounts,
      nextCursor: hasMore && lastConsumed
        ? encodeHistoryCursor('replay-events', binding, { createdAt: lastConsumed.createdAt, source: lastConsumed.source, id: lastConsumed.id })
        : undefined,
      summary: `Replayed ${orderedEvents.length} events for session ${session.name}`,
      events: orderedEvents,
      session: boundedSession,
    };

    return replay;
  }

  async replaySession(
    sessionId: string,
    options: ReplaySessionOptions = {}
  ): Promise<HarnessReplayRecord> {
    const replay = await this.buildReplay(sessionId, options);
    await this.saveReplay(replay);
    return replay;
  }

  async listReplays(filter?: { sessionId?: string }): Promise<HarnessReplayRecord[]> {
    const page = await this.listReplayPage({ limit: 25, sessionId: filter?.sessionId });
    const records: HarnessReplayRecord[] = [];
    for (const summary of page.items) records.push(await this.readReplay(summary.id));
    return records;
  }

  async listReplayPage(query: RuntimeHistoryQuery & { sessionId?: string } = {}): Promise<RuntimeHistoryPage<HarnessReplaySummary>> {
    const started = Date.now();
    const limit = boundedLimit(query.limit, 25, 100, 'replay summaries');
    const byteBudget = boundedPageBytes(query.maxBytes, 'replay summaries');
    const binding = queryBinding({ sessionId: query.sessionId });
    const boundary = decodeHistoryCursor<{ createdAt: string; id: string }>(query.cursor, 'replays', binding);
    await this.ensureLayout();
    const selected: HarnessReplaySummary[] = [];
    let recordsScanned = 0;
    let oversizedRecordsSkipped = 0;
    const directory = await fs.opendir(this.replaysPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.meta.json')) continue;
      try {
        const file = path.join(this.replaysPath, entry.name);
        const metadataFile = this.replayMetadataFile(entry.name.slice(0, -'.json'.length));
        const metadataBytes = await fs.stat(metadataFile).then(stat => stat.size).catch(() => Number.POSITIVE_INFINITY);
        const replay = metadataBytes <= MAX_RUNTIME_HISTORY_PAGE_BYTES
          ? await fs.readJson(metadataFile) as HarnessReplayRecord
          : (await fs.stat(file)).size <= MAX_RUNTIME_HISTORY_PAGE_BYTES
              ? await fs.readJson(file) as HarnessReplayRecord
              : undefined;
        if (!replay) { oversizedRecordsSkipped += 1; continue; }
        recordsScanned += 1;
        if (query.sessionId && replay.sessionId !== query.sessionId) continue;
        const key = `${replay.createdAt}\0${replay.id}`;
        if (boundary && key >= `${boundary.createdAt}\0${boundary.id}`) continue;
        selected.push({ id: replay.id, sessionId: replay.sessionId, createdAt: replay.createdAt, fidelity: replay.fidelity, eventCount: replay.eventCount, summary: replay.summary });
        selected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        if (selected.length > limit + 1) selected.pop();
      } catch { /* skip corrupt records */ }
    }
    const items: HarnessReplaySummary[] = [];
    let returnedBytes = 2;
    let byteLimited = false;
    for (const candidate of selected.slice(0, limit + 1)) {
      if (items.length === limit) break;
      const bytes = serializedHistoryItemBytes(candidate);
      const candidateTotal = returnedBytes + bytes + (items.length > 0 ? 1 : 0);
      if (candidateTotal > byteBudget) {
        if (items.length > 0) {
          byteLimited = true;
          break;
        }
        oversizedRecordsSkipped += 1;
        byteLimited = true;
        continue;
      }
      items.push(candidate);
      returnedBytes = candidateTotal;
    }
    const hasMore = selected.length > items.length;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeHistoryCursor('replays', binding, { createdAt: last.createdAt, id: last.id }) : undefined, hasMore, recordsReturned: items.length, recordsScanned, returnedBytes, byteBudget, byteLimited, oversizedRecordsSkipped, cursorVersion: 1, partial: hasMore || oversizedRecordsSkipped > 0, durationMs: Date.now() - started };
  }

  async getReplay(replayId: string): Promise<HarnessReplayRecord> {
    return this.readReplay(replayId);
  }
}

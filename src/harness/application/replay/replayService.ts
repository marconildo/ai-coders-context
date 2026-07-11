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
  boundedLimit,
  decodeHistoryCursor,
  encodeHistoryCursor,
  queryBinding,
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
  artifacts: HarnessArtifactRecord[];
  checkpoints: HarnessSessionCheckpoint[];
  traces: HarnessTraceRecord[];
  sensorRuns: HarnessSensorRun[];
  tasks: HarnessTaskContract[];
  handoffs: HarnessHandoffContract[];
}

export interface HarnessReplayServiceOptions {
  repoPath: string;
  dependencies?: Partial<HarnessReplayDependencies>;
}

export interface ReplaySessionOptions {
  includePayloads?: boolean;
  maxEvents?: number;
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
  sensorsService: Pick<HarnessSensorsService, 'getSessionSensorRuns'>;
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

  private async ensureLayout(): Promise<void> {
    await fs.ensureDir(this.replaysPath);
  }

  private async saveReplay(replay: HarnessReplayRecord): Promise<void> {
    await this.ensureLayout();
    await fs.writeJson(this.replayFile(replay.id), replay, { spaces: 2 });
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
    const session = await this.stateService.getSession(sessionId);
    const [tracePage, artifactPage, allSensorRuns, taskScan, handoffScan] = await Promise.all([
      this.stateService.listTracePage(sessionId, { limit: maxEvents, direction: 'oldest' }),
      this.stateService.listArtifactPage(sessionId, { limit: Math.min(maxEvents, 200), direction: 'oldest' }),
      this.sensorsService.getSessionSensorRuns(sessionId),
      this.contractsService.listSessionTaskContracts(sessionId, maxEvents),
      this.contractsService.listSessionHandoffContracts(sessionId, maxEvents),
    ]);

    const traces = tracePage.items;
    const artifacts = artifactPage.items;
    const checkpoints = session.checkpoints.slice(0, maxEvents);
    const sensorRuns = sortByCreatedAt(allSensorRuns).slice(0, maxEvents);
    const sessionTasks = taskScan.items;
    const sessionHandoffs = handoffScan.items;

    const events: HarnessReplayEvent[] = [
      {
        id: randomUUID(),
        sessionId,
        createdAt: session.createdAt,
        source: 'session',
        label: `session:${session.name}`,
        payload: options.includePayloads === false
          ? undefined
          : {
              id: session.id,
              status: session.status,
              metadata: session.metadata ?? null,
            },
      },
      ...traces.map((trace) => ({
        id: randomUUID(),
        sessionId,
        createdAt: trace.createdAt,
        source: 'trace' as const,
        label: trace.event,
        payload: options.includePayloads === false
          ? undefined
          : {
              level: trace.level,
              message: trace.message,
              data: trace.data ?? null,
            },
      })),
      ...artifacts.map((artifact) => ({
        id: randomUUID(),
        sessionId,
        createdAt: artifact.createdAt,
        source: 'artifact' as const,
        label: artifact.name,
        payload: options.includePayloads === false
          ? undefined
          : {
              kind: artifact.kind,
              path: artifact.path ?? null,
              metadata: artifact.metadata ?? null,
            },
      })),
      ...checkpoints.map((checkpoint) => ({
        id: randomUUID(),
        sessionId,
        createdAt: checkpoint.createdAt,
        source: 'checkpoint' as const,
        label: checkpoint.note || checkpoint.id,
        payload: options.includePayloads === false
          ? undefined
          : {
              artifactIds: checkpoint.artifactIds,
              data: checkpoint.data ?? null,
            },
      })),
      ...sensorRuns.map((run) => ({
        id: randomUUID(),
        sessionId,
        createdAt: run.createdAt,
        source: 'sensor' as const,
        label: run.sensorId,
        payload: options.includePayloads === false
          ? undefined
          : {
              status: run.status,
              summary: run.summary,
              severity: run.severity,
              blocking: run.blocking,
            },
      })),
      ...sessionTasks.map((task) => ({
        id: randomUUID(),
        sessionId,
        createdAt: task.createdAt,
        source: 'task' as const,
        label: task.title,
        payload: options.includePayloads === false
          ? undefined
          : {
              status: task.status,
              requiredSensors: task.requiredSensors,
              requiredArtifacts: task.requiredArtifacts,
              acceptanceCriteria: task.acceptanceCriteria,
            },
      })),
      ...sessionHandoffs.map((handoff) => ({
        id: randomUUID(),
        sessionId,
        createdAt: handoff.createdAt,
        source: 'handoff' as const,
        label: `${handoff.from} -> ${handoff.to}`,
        payload: options.includePayloads === false
          ? undefined
          : {
              artifacts: handoff.artifacts,
              evidence: handoff.evidence,
            },
      })),
    ];

    const orderedEvents = sortByCreatedAt(events).slice(0, maxEvents);
    const sourceCounts: Record<HarnessReplayEventSource, number> = {
      session: 1,
      trace: session.traceCount,
      artifact: session.artifactCount,
      checkpoint: session.checkpointCount,
      sensor: allSensorRuns.length,
      task: taskScan.total,
      handoff: handoffScan.total,
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
    const partial = Object.values(omittedCounts).some(count => count > 0);
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
      nextCursor: tracePage.nextCursor,
      summary: `Replayed ${orderedEvents.length} events for session ${session.name}`,
      events: orderedEvents,
      session: boundedSession,
      artifacts: artifacts.slice(0, maxEvents),
      checkpoints: checkpoints.slice(0, maxEvents),
      traces: traces.slice(0, maxEvents),
      sensorRuns: sensorRuns.slice(0, maxEvents),
      tasks: sessionTasks.slice(0, maxEvents),
      handoffs: sessionHandoffs.slice(0, maxEvents),
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
    const binding = queryBinding({ sessionId: query.sessionId });
    const boundary = decodeHistoryCursor<{ createdAt: string; id: string }>(query.cursor, 'replays', binding);
    await this.ensureLayout();
    const selected: HarnessReplaySummary[] = [];
    let recordsScanned = 0;
    const directory = await fs.opendir(this.replaysPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const replay = await fs.readJson(path.join(this.replaysPath, entry.name)) as HarnessReplayRecord;
        recordsScanned += 1;
        if (query.sessionId && replay.sessionId !== query.sessionId) continue;
        const key = `${replay.createdAt}\0${replay.id}`;
        if (boundary && key >= `${boundary.createdAt}\0${boundary.id}`) continue;
        selected.push({ id: replay.id, sessionId: replay.sessionId, createdAt: replay.createdAt, fidelity: replay.fidelity, eventCount: replay.eventCount, summary: replay.summary });
        selected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        if (selected.length > limit + 1) selected.pop();
      } catch { /* skip corrupt records */ }
    }
    const hasMore = selected.length > limit;
    const items = selected.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeHistoryCursor('replays', binding, { createdAt: last.createdAt, id: last.id }) : undefined, hasMore, recordsReturned: items.length, recordsScanned, cursorVersion: 1, partial: hasMore, durationMs: Date.now() - started };
  }

  async getReplay(replayId: string): Promise<HarnessReplayRecord> {
    return this.readReplay(replayId);
  }
}

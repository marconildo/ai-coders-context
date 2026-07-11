import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { resolveRuntimeLayoutFromRepo } from '../../../shared/fs/pathHelpers';
import { HarnessRuntimeStateService, type HarnessRuntimeStatePort } from '../../adapters/out/runtimeState/runtimeStateService';
import { HarnessReplayService, type HarnessReplayRecord } from '../replay/replayService';
import { HarnessSensorsService } from '../sensors/sensorsService';
import { HarnessTaskContractsService } from '../contracts/taskContractsService';
import { boundedLimit, decodeHistoryCursor, encodeHistoryCursor, queryBinding, type RuntimeHistoryPage, type RuntimeHistoryQuery } from '../history/runtimeHistory';

export type HarnessFailureKind = 'sensor' | 'task' | 'session' | 'trace';

export interface HarnessFailureRecord {
  id: string;
  kind: HarnessFailureKind;
  sessionId: string;
  replayId: string;
  signature: string;
  message: string;
  severity: 'warning' | 'critical';
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessFailureCluster {
  signature: string;
  count: number;
  sessionIds: string[];
  exampleMessages: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface HarnessFailureDataset {
  id: string;
  createdAt: string;
  repoPath: string;
  sessionCount: number;
  replayCount: number;
  failureCount: number;
  clusterCount: number;
  failures: HarnessFailureRecord[];
  clusters: HarnessFailureCluster[];
  partial: boolean;
  omittedFailureCount: number;
}

export interface HarnessDatasetServiceOptions {
  repoPath: string;
  dependencies?: Partial<HarnessDatasetDependencies>;
}

export interface BuildHarnessDatasetOptions {
  sessionIds?: string[];
  includeSuccessfulSessions?: boolean;
  concurrency?: number;
  maxFailures?: number;
}

export interface HarnessDatasetSummary {
  id: string;
  createdAt: string;
  sessionCount: number;
  failureCount: number;
  clusterCount: number;
  partial: boolean;
}

export interface HarnessDatasetDependencies {
  stateService: HarnessRuntimeStatePort;
  replayService: Pick<HarnessReplayService, 'buildReplay'>;
  taskContractsService: Pick<HarnessTaskContractsService, 'evaluateTaskCompletion'>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ':uuid')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSensorFailures(replay: HarnessReplayRecord): HarnessFailureRecord[] {
  return replay.sensorRuns
    .filter(run => run.status === 'failed' || run.status === 'blocked')
    .map(run => ({
      id: randomUUID(),
      kind: 'sensor' as const,
      sessionId: replay.sessionId,
      replayId: replay.id,
      signature: normalizeSignature(`sensor:${run.sensorId}:${run.summary}`),
      message: run.summary,
      severity: run.blocking ? 'critical' : 'warning',
      createdAt: run.createdAt,
      metadata: {
        sensorId: run.sensorId,
        status: run.status,
        blocking: run.blocking,
      },
    }));
}

async function buildTaskFailures(
  replay: HarnessReplayRecord,
  taskContractsService: Pick<HarnessTaskContractsService, 'evaluateTaskCompletion'>
): Promise<HarnessFailureRecord[]> {
  const taskFailures: HarnessFailureRecord[] = [];

  for (const task of replay.tasks.filter(item => item.sessionId === replay.sessionId)) {
    const result = await taskContractsService.evaluateTaskCompletion(task.id, replay.sessionId);
    if (result.canComplete) {
      continue;
    }

    taskFailures.push({
      id: randomUUID(),
      kind: 'task',
      sessionId: replay.sessionId,
      replayId: replay.id,
      signature: normalizeSignature(`task:${result.missingSensors.join(',')}:${result.missingArtifacts.join(',')}`),
      message: result.blockingFindings.join('; ') || `Task contract blocked: ${task.title}`,
      severity: 'critical',
      createdAt: task.updatedAt,
      metadata: {
        taskId: task.id,
        missingSensors: result.missingSensors,
        missingArtifacts: result.missingArtifacts,
        blockingFindings: result.blockingFindings,
      },
    });
  }

  return taskFailures;
}

function buildSessionFailure(replay: HarnessReplayRecord): HarnessFailureRecord[] {
  if (replay.session.status !== 'failed') {
    return [];
  }

  const lastErrorTrace = [...replay.traces].reverse().find(trace => trace.level === 'error' || trace.event.includes('failed'));
  const message = lastErrorTrace?.message || `Session failed: ${replay.session.name}`;

  return [{
    id: randomUUID(),
    kind: 'session',
    sessionId: replay.sessionId,
    replayId: replay.id,
    signature: normalizeSignature(`session:${message}`),
    message,
    severity: 'critical',
    createdAt: replay.session.failedAt || replay.session.updatedAt,
    metadata: {
      status: replay.session.status,
      lastErrorTrace: lastErrorTrace?.event ?? null,
    },
  }];
}

function buildTraceFailures(replay: HarnessReplayRecord): HarnessFailureRecord[] {
  return replay.traces
    .filter(trace => trace.event !== 'sensor.run')
    .filter(trace => trace.level === 'error' || /failed|blocked/i.test(trace.event) || /failed|blocked/i.test(trace.message))
    .map(trace => ({
      id: randomUUID(),
      kind: 'trace' as const,
      sessionId: replay.sessionId,
      replayId: replay.id,
      signature: normalizeSignature(`trace:${trace.event}:${trace.message}`),
      message: trace.message,
      severity: 'warning' as const,
      createdAt: trace.createdAt,
      metadata: {
        event: trace.event,
        level: trace.level,
      },
    }));
}

function clusterFailures(failures: HarnessFailureRecord[]): HarnessFailureCluster[] {
  const clusterMap = new Map<string, HarnessFailureCluster>();

  for (const failure of failures) {
    const existing = clusterMap.get(failure.signature);
    if (!existing) {
      clusterMap.set(failure.signature, {
        signature: failure.signature,
        count: 1,
        sessionIds: [failure.sessionId],
        exampleMessages: [failure.message],
        firstSeenAt: failure.createdAt,
        lastSeenAt: failure.createdAt,
      });
      continue;
    }

    existing.count += 1;
    if (!existing.sessionIds.includes(failure.sessionId)) {
      existing.sessionIds.push(failure.sessionId);
    }
    if (existing.exampleMessages.length < 3) {
      existing.exampleMessages.push(failure.message);
    }
    if (failure.createdAt < existing.firstSeenAt) {
      existing.firstSeenAt = failure.createdAt;
    }
    if (failure.createdAt > existing.lastSeenAt) {
      existing.lastSeenAt = failure.createdAt;
    }
  }

  return [...clusterMap.values()].sort((left, right) => right.count - left.count || left.signature.localeCompare(right.signature));
}

export class HarnessDatasetService {
  private readonly stateService: HarnessDatasetDependencies['stateService'];
  private readonly replayService: HarnessDatasetDependencies['replayService'];
  private readonly taskContractsService: HarnessDatasetDependencies['taskContractsService'];

  constructor(private readonly options: HarnessDatasetServiceOptions) {
    const stateService = options.dependencies?.stateService
      ?? new HarnessRuntimeStateService({ repoPath: options.repoPath });
    const replayService = options.dependencies?.replayService
      ?? new HarnessReplayService({
        repoPath: options.repoPath,
        dependencies: {
          stateService,
          sensorsService: new HarnessSensorsService({ stateService }),
          contractsService: new HarnessTaskContractsService({
            repoPath: options.repoPath,
            stateService,
          }),
        },
      });
    const taskContractsService = options.dependencies?.taskContractsService
      ?? new HarnessTaskContractsService({
        repoPath: options.repoPath,
        stateService,
      });

    this.stateService = stateService;
    this.replayService = replayService;
    this.taskContractsService = taskContractsService;
  }

  private get repoPath(): string {
    return path.resolve(this.options.repoPath);
  }

  private get datasetsPath(): string {
    return resolveRuntimeLayoutFromRepo(this.repoPath).datasetsDir;
  }

  private datasetFile(datasetId: string): string {
    return path.join(this.datasetsPath, `${datasetId}.json`);
  }

  private async ensureLayout(): Promise<void> {
    await fs.ensureDir(this.datasetsPath);
  }

  async buildFailureDataset(options: BuildHarnessDatasetOptions = {}): Promise<HarnessFailureDataset> {
    const concurrency = boundedLimit(options.concurrency, 1, 4, 'dataset concurrency');
    const maxFailures = boundedLimit(options.maxFailures, 10_000, 10_000, 'dataset failures');
    const sessions = [];
    if (options.sessionIds?.length) {
      for (const sessionId of options.sessionIds) sessions.push(await this.stateService.getSession(sessionId));
    } else {
      let cursor: string | undefined;
      do {
        const page = await this.stateService.listSessionPage({ limit: 200, cursor });
        sessions.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
    }

    const selectedSessions = options.includeSuccessfulSessions
      ? sessions
      : sessions.filter(session => session.status !== 'completed');

    const failures: HarnessFailureRecord[] = [];
    let omittedFailureCount = 0;
    let nextIndex = 0;
    const retain = (records: HarnessFailureRecord[]) => {
      const available = Math.max(0, maxFailures - failures.length);
      failures.push(...records.slice(0, available));
      omittedFailureCount += Math.max(0, records.length - available);
    };
    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= selectedSessions.length) return;
        const replay = await this.replayService.buildReplay(selectedSessions[index].id, { includePayloads: false, maxEvents: 1000 });
        retain(buildSensorFailures(replay));
        retain(await buildTaskFailures(replay, this.taskContractsService));
        retain(buildSessionFailure(replay));
        retain(buildTraceFailures(replay));
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, selectedSessions.length) }, () => worker()));
    const clusters = clusterFailures(failures);
    const dataset: HarnessFailureDataset = {
      id: randomUUID(),
      createdAt: nowIso(),
      repoPath: this.repoPath,
      sessionCount: selectedSessions.length,
      replayCount: selectedSessions.length,
      failureCount: failures.length,
      clusterCount: clusters.length,
      failures,
      clusters,
      partial: omittedFailureCount > 0,
      omittedFailureCount,
    };

    await this.ensureLayout();
    await fs.writeJson(this.datasetFile(dataset.id), dataset, { spaces: 2 });
    return dataset;
  }

  async listDatasets(): Promise<HarnessFailureDataset[]> {
    const page = await this.listDatasetPage();
    const datasets: HarnessFailureDataset[] = [];
    for (const summary of page.items) datasets.push(await this.getDataset(summary.id));
    return datasets;
  }

  async listDatasetPage(query: RuntimeHistoryQuery = {}): Promise<RuntimeHistoryPage<HarnessDatasetSummary>> {
    const started = Date.now();
    const limit = boundedLimit(query.limit, 25, 100, 'dataset summaries');
    const binding = queryBinding({ resource: 'datasets' });
    const boundary = decodeHistoryCursor<{ createdAt: string; id: string }>(query.cursor, 'datasets', binding);
    await this.ensureLayout();
    const selected: HarnessDatasetSummary[] = [];
    let recordsScanned = 0;
    const directory = await fs.opendir(this.datasetsPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const dataset = await fs.readJson(path.join(this.datasetsPath, entry.name)) as HarnessFailureDataset;
        recordsScanned += 1;
        const key = `${dataset.createdAt}\0${dataset.id}`;
        if (boundary && key >= `${boundary.createdAt}\0${boundary.id}`) continue;
        selected.push({ id: dataset.id, createdAt: dataset.createdAt, sessionCount: dataset.sessionCount, failureCount: dataset.failureCount, clusterCount: dataset.clusterCount, partial: dataset.partial ?? false });
        selected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        if (selected.length > limit + 1) selected.pop();
      } catch { /* skip corrupt records */ }
    }
    const hasMore = selected.length > limit;
    const items = selected.slice(0, limit);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeHistoryCursor('datasets', binding, { createdAt: last.createdAt, id: last.id }) : undefined, hasMore, recordsReturned: items.length, recordsScanned, cursorVersion: 1, partial: hasMore, durationMs: Date.now() - started };
  }

  async getDataset(datasetId: string): Promise<HarnessFailureDataset> {
    const filePath = this.datasetFile(datasetId);
    if (!(await fs.pathExists(filePath))) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    return fs.readJson(filePath) as Promise<HarnessFailureDataset>;
  }

  async getFailureClusters(datasetId: string): Promise<HarnessFailureCluster[]> {
    const dataset = await this.getDataset(datasetId);
    return dataset.clusters;
  }
}

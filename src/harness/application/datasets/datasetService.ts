import * as fs from 'fs-extra';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

import { resolveRuntimeLayoutFromRepo } from '../../../shared/fs/pathHelpers';
import {
  HarnessRuntimeStateService,
  type HarnessRuntimeStatePort,
  type HarnessSessionRecord,
} from '../../adapters/out/runtimeState/runtimeStateService';
import { HarnessReplayService, type HarnessReplayRecord } from '../replay/replayService';
import { HarnessSensorsService } from '../sensors/sensorsService';
import { HarnessTaskContractsService } from '../contracts/taskContractsService';
import { boundedPageBytes, boundedLimit, decodeHistoryCursor, encodeHistoryCursor, MAX_RUNTIME_HISTORY_PAGE_BYTES, queryBinding, serializedHistoryItemBytes, type RuntimeHistoryPage, type RuntimeHistoryQuery } from '../history/runtimeHistory';

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
  maxFailureBytes?: number;
  maxBytes?: number;
}

export const DEFAULT_DATASET_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_DATASET_BYTES = 64 * 1024 * 1024;
export const DEFAULT_FAILURE_RECORD_MAX_BYTES = 64 * 1024;
export const MAX_FAILURE_RECORD_BYTES = 1024 * 1024;

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
  const normalized = value
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ':uuid')
    .replace(/\s+/g, ' ')
    .trim();
  if (Buffer.byteLength(normalized, 'utf8') <= 512) return normalized;
  return `${normalized.slice(0, 384)}:sha256:${createHash('sha256').update(normalized).digest('hex')}`;
}

function replayRecords<T>(replay: HarnessReplayRecord, source: HarnessReplayRecord['events'][number]['source']): T[] {
  const events = replay.events ?? [];
  const current = events
    .filter(event => event.source === source && event.record)
    .map(event => event.record as T);
  if (current.length > 0 || events.length > 0) return current;
  const legacyKey = ({ trace: 'traces', artifact: 'artifacts', checkpoint: 'checkpoints', sensor: 'sensorRuns', task: 'tasks', handoff: 'handoffs' } as const)[source as Exclude<typeof source, 'session'>];
  return legacyKey ? (((replay as unknown as Record<string, unknown>)[legacyKey] as T[] | undefined) ?? []) : [];
}

function buildSensorFailures(replay: HarnessReplayRecord): HarnessFailureRecord[] {
  return replayRecords<import('../sensors/sensorsService').HarnessSensorRun>(replay, 'sensor')
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

  for (const task of replayRecords<import('../contracts/taskContractsService').HarnessTaskContract>(replay, 'task').filter(item => item.sessionId === replay.sessionId)) {
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

  const lastErrorTrace = replayRecords<import('../../adapters/out/runtimeState/runtimeStateService').HarnessTraceRecord>(replay, 'trace').reverse().find(trace => trace.level === 'error' || trace.event.includes('failed'));
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
  return replayRecords<import('../../adapters/out/runtimeState/runtimeStateService').HarnessTraceRecord>(replay, 'trace')
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
        exampleMessages: [failure.message.slice(0, 1024)],
        firstSeenAt: failure.createdAt,
        lastSeenAt: failure.createdAt,
      });
      continue;
    }

    existing.count += 1;
    if (existing.sessionIds.length < 100 && !existing.sessionIds.includes(failure.sessionId)) {
      existing.sessionIds.push(failure.sessionId);
    }
    if (existing.exampleMessages.length < 3) {
      existing.exampleMessages.push(failure.message.slice(0, 1024));
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

  private datasetMetadataFile(datasetId: string): string {
    return path.join(this.datasetsPath, `${datasetId}.meta.json`);
  }

  private async ensureLayout(): Promise<void> {
    await fs.ensureDir(this.datasetsPath);
  }

  async buildFailureDataset(options: BuildHarnessDatasetOptions = {}): Promise<HarnessFailureDataset> {
    const concurrency = boundedLimit(options.concurrency, 1, 4, 'dataset concurrency');
    const maxFailures = boundedLimit(options.maxFailures, 10_000, 10_000, 'dataset failures');
    const maxDatasetBytes = boundedPageBytes(options.maxBytes, 'dataset persistence', DEFAULT_DATASET_MAX_BYTES, MAX_DATASET_BYTES);
    const maxFailureBytes = boundedPageBytes(options.maxFailureBytes, 'dataset failure records', DEFAULT_FAILURE_RECORD_MAX_BYTES, MAX_FAILURE_RECORD_BYTES);
    const aggregateFailureByteBudget = Math.floor(maxDatasetBytes / 2);
    const failures: HarnessFailureRecord[] = [];
    let retainedFailureBytes = 2;
    let failureByteLimited = false;
    let omittedFailureCount = 0;
    let sessionCount = 0;
    let replayCount = 0;
    const retain = (records: HarnessFailureRecord[]) => {
      for (const record of records) {
        if (failures.length >= maxFailures || failureByteLimited) {
          omittedFailureCount += 1;
          continue;
        }
        const bytes = serializedHistoryItemBytes(record);
        if (bytes > maxFailureBytes || retainedFailureBytes + bytes + (failures.length > 0 ? 1 : 0) > aggregateFailureByteBudget) {
          omittedFailureCount += 1;
          failureByteLimited = true;
          continue;
        }
        failures.push(record);
        retainedFailureBytes += bytes + (failures.length > 1 ? 1 : 0);
      }
    };

    const processSession = async (session: HarnessSessionRecord): Promise<void> => {
      if (!options.includeSuccessfulSessions && session.status === 'completed') return;
      sessionCount += 1;
      const replay = await this.replayService.buildReplay(session.id, {
        includePayloads: true,
        maxEvents: 1000,
        maxBytes: Math.min(maxDatasetBytes, MAX_RUNTIME_HISTORY_PAGE_BYTES),
      });
      replayCount += 1;
      retain(buildSensorFailures(replay));
      retain(await buildTaskFailures(replay, this.taskContractsService));
      retain(buildSessionFailure(replay));
      retain(buildTraceFailures(replay));
    };

    const processBatch = async <T>(
      batch: T[],
      resolveSession: (item: T) => Promise<HarnessSessionRecord>
    ): Promise<void> => {
      let nextIndex = 0;
      const worker = async () => {
        while (true) {
          const index = nextIndex++;
          if (index >= batch.length) return;
          await processSession(await resolveSession(batch[index]));
        }
      };
      await Promise.all(Array.from(
        { length: Math.min(concurrency, batch.length) },
        () => worker()
      ));
    };

    if (options.sessionIds?.length) {
      for (let start = 0; start < options.sessionIds.length; start += 200) {
        await processBatch(
          options.sessionIds.slice(start, start + 200),
          (sessionId) => this.stateService.getSession(sessionId)
        );
      }
    } else {
      let cursor: string | undefined;
      do {
        const page = await this.stateService.listSessionPage({ limit: 200, cursor });
        await processBatch(page.items, async (session) => session);
        cursor = page.nextCursor;
      } while (cursor);
    }

    const clusters = clusterFailures(failures);
    const dataset: HarnessFailureDataset = {
      id: randomUUID(),
      createdAt: nowIso(),
      repoPath: this.repoPath,
      sessionCount,
      replayCount,
      failureCount: failures.length,
      clusterCount: clusters.length,
      failures,
      clusters,
      partial: omittedFailureCount > 0,
      omittedFailureCount,
    };

    let serialized = JSON.stringify(dataset);
    while (Buffer.byteLength(serialized, 'utf8') > maxDatasetBytes && dataset.clusters.length > 0) {
      dataset.clusters.pop();
      dataset.clusterCount = dataset.clusters.length;
      dataset.partial = true;
      serialized = JSON.stringify(dataset);
    }
    if (Buffer.byteLength(serialized, 'utf8') > maxDatasetBytes) {
      throw new Error(`Dataset persistence budget exceeded after bounded compaction (${maxDatasetBytes} bytes)`);
    }
    await this.ensureLayout();
    await fs.writeFile(this.datasetFile(dataset.id), serialized, 'utf8');
    await fs.writeJson(this.datasetMetadataFile(dataset.id), {
      version: 1,
      id: dataset.id,
      createdAt: dataset.createdAt,
      sessionCount: dataset.sessionCount,
      failureCount: dataset.failureCount,
      clusterCount: dataset.clusterCount,
      partial: dataset.partial,
    });
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
    const byteBudget = boundedPageBytes(query.maxBytes, 'dataset summaries');
    const binding = queryBinding({ resource: 'datasets' });
    const boundary = decodeHistoryCursor<{ createdAt: string; id: string }>(query.cursor, 'datasets', binding);
    await this.ensureLayout();
    const selected: HarnessDatasetSummary[] = [];
    let recordsScanned = 0;
    let oversizedRecordsSkipped = 0;
    const directory = await fs.opendir(this.datasetsPath);
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.meta.json')) continue;
      try {
        const file = path.join(this.datasetsPath, entry.name);
        const metadataFile = this.datasetMetadataFile(entry.name.slice(0, -'.json'.length));
        const metadataBytes = await fs.stat(metadataFile).then(stat => stat.size).catch(() => Number.POSITIVE_INFINITY);
        const dataset = metadataBytes <= MAX_RUNTIME_HISTORY_PAGE_BYTES
          ? await fs.readJson(metadataFile) as HarnessFailureDataset
          : (await fs.stat(file)).size <= MAX_RUNTIME_HISTORY_PAGE_BYTES
              ? await fs.readJson(file) as HarnessFailureDataset
              : undefined;
        if (!dataset) { oversizedRecordsSkipped += 1; continue; }
        recordsScanned += 1;
        const key = `${dataset.createdAt}\0${dataset.id}`;
        if (boundary && key >= `${boundary.createdAt}\0${boundary.id}`) continue;
        selected.push({ id: dataset.id, createdAt: dataset.createdAt, sessionCount: dataset.sessionCount, failureCount: dataset.failureCount, clusterCount: dataset.clusterCount, partial: dataset.partial ?? false });
        selected.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        if (selected.length > limit + 1) selected.pop();
      } catch { /* skip corrupt records */ }
    }
    const items: HarnessDatasetSummary[] = [];
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
    return { items, nextCursor: hasMore && last ? encodeHistoryCursor('datasets', binding, { createdAt: last.createdAt, id: last.id }) : undefined, hasMore, recordsReturned: items.length, recordsScanned, returnedBytes, byteBudget, byteLimited, oversizedRecordsSkipped, cursorVersion: 1, partial: hasMore || oversizedRecordsSkipped > 0, durationMs: Date.now() - started };
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

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { HarnessExecutionService } from '../../execution/executionService';
import { HarnessDatasetService } from '../datasetService';
import { HarnessReplayService } from '../../replay/replayService';

describe('HarnessDatasetService', () => {
  let tempDir: string;
  let execution: HarnessExecutionService;
  let service: HarnessDatasetService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-dataset-'));
    execution = new HarnessExecutionService({ repoPath: tempDir });
    service = new HarnessDatasetService({ repoPath: tempDir });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('builds failure datasets and clusters repeated signatures', async () => {
    const first = await execution.createSession({ name: 'first-failure' });
    const second = await execution.createSession({ name: 'second-failure' });

    await execution.runSensor({
      id: 'lint',
      name: 'Lint',
      severity: 'critical',
      blocking: true,
      execute: async () => ({
        status: 'failed',
        summary: 'Lint failed',
        evidence: ['lint output'],
      }),
    }, { sessionId: first.id });

    await execution.runSensor({
      id: 'lint',
      name: 'Lint',
      severity: 'critical',
      blocking: true,
      execute: async () => ({
        status: 'failed',
        summary: 'Lint failed',
        evidence: ['lint output'],
      }),
    }, { sessionId: second.id });

    const dataset = await service.buildFailureDataset({ includeSuccessfulSessions: true });
    const datasets = await service.listDatasets();

    expect(dataset.sessionCount).toBe(2);
    expect(dataset.replayCount).toBe(2);
    expect(dataset.failureCount).toBe(2);
    expect(dataset.clusterCount).toBe(1);
    expect(dataset.failures).toHaveLength(2);
    expect(dataset.clusters[0]?.count).toBe(2);
    expect(datasets).toHaveLength(1);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'evaluations', 'replays'))).toBe(false);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'evaluations', 'datasets', `${dataset.id}.json`))).toBe(true);
  });

  it('bounds session concurrency and caps retained failure records', async () => {
    const sessions = [];
    for (let index = 0; index < 6; index += 1) {
      const session = await execution.createSession({ name: `failure-${index}` });
      await execution.appendTrace(session.id, { level: 'error', event: 'task.failed', message: `failed-${index}` });
      sessions.push(session);
    }
    const replay = new HarnessReplayService({ repoPath: tempDir });
    let active = 0;
    let peak = 0;
    const bounded = new HarnessDatasetService({
      repoPath: tempDir,
      dependencies: {
        replayService: {
          buildReplay: async (...args) => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            try { return await replay.buildReplay(...args); } finally { active -= 1; }
          },
        },
      },
    });

    const dataset = await bounded.buildFailureDataset({ sessionIds: sessions.map(item => item.id), includeSuccessfulSessions: true, concurrency: 2, maxFailures: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(dataset.failures).toHaveLength(2);
    expect(dataset.partial).toBe(true);
    expect(dataset.omittedFailureCount).toBe(4);
  });

  it('processes one bounded session page before requesting the next page', async () => {
    const sessions = ['one', 'two', 'three'].map((id) => ({
      id,
      name: id,
      status: 'failed',
      repoPath: tempDir,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:00:00.000Z',
      traceCount: 0,
      artifactCount: 0,
      checkpointCount: 0,
      checkpoints: [],
    }));
    const processed = new Set<string>();
    const listSessionPage = jest.fn(async ({ cursor }: { cursor?: string }) => {
      if (!cursor) {
        return { items: sessions.slice(0, 2), nextCursor: 'page-2', hasMore: true };
      }
      expect(processed).toEqual(new Set(['one', 'two']));
      return { items: sessions.slice(2), hasMore: false };
    });
    const buildReplay = jest.fn(async (sessionId: string) => {
      processed.add(sessionId);
      const session = sessions.find(item => item.id === sessionId)!;
      return {
        id: `replay-${sessionId}`,
        sessionId,
        session,
        sensorRuns: [],
        tasks: [],
        traces: [],
      } as any;
    });
    const paged = new HarnessDatasetService({
      repoPath: tempDir,
      dependencies: {
        stateService: { listSessionPage } as any,
        replayService: { buildReplay },
        taskContractsService: { evaluateTaskCompletion: jest.fn() },
      },
    });

    const dataset = await paged.buildFailureDataset({
      includeSuccessfulSessions: true,
      concurrency: 1,
    });

    expect(listSessionPage).toHaveBeenCalledTimes(2);
    expect(buildReplay).toHaveBeenCalledTimes(3);
    expect(dataset.sessionCount).toBe(3);
    expect(dataset.replayCount).toBe(3);
  });
});

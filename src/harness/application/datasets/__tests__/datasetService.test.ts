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
});

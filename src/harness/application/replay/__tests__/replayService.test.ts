import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { HarnessExecutionService } from '../../execution/executionService';
import { HarnessTaskContractsService } from '../../contracts/taskContractsService';
import { HarnessReplayService } from '../replayService';

describe('HarnessReplayService', () => {
  let tempDir: string;
  let execution: HarnessExecutionService;
  let service: HarnessReplayService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-replay-'));
    execution = new HarnessExecutionService({ repoPath: tempDir });
    service = new HarnessReplayService({ repoPath: tempDir });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(tempDir);
  });

  it('builds a replay without persisting it', async () => {
    const session = await execution.createSession({ name: 'transient-replay' });
    await execution.appendTrace(session.id, {
      level: 'info',
      event: 'custom.step',
      message: 'Step one',
    });

    const replay = await service.buildReplay(session.id);

    expect(replay.sessionId).toBe(session.id);
    expect(replay.eventCount).toBeGreaterThan(0);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'evaluations', 'replays', `${replay.id}.json`))).toBe(false);
    expect(await service.listReplays({ sessionId: session.id })).toHaveLength(0);
  });

  it('replays a session into a durable ordered event log', async () => {
    const session = await execution.createSession({ name: 'replay-run' });
    await execution.appendTrace(session.id, {
      level: 'info',
      event: 'custom.step',
      message: 'Step one',
    });
    await execution.addArtifact(session.id, {
      name: 'evidence.txt',
      kind: 'file',
      path: 'evidence.txt',
    });
    await execution.checkpointSession(session.id, { note: 'checkpoint' });

    const replay = await service.replaySession(session.id);
    const list = await service.listReplays({ sessionId: session.id });

    expect(replay.eventCount).toBeGreaterThanOrEqual(4);
    expect(replay.events.map(event => event.source)).toContain('checkpoint');
    expect(list).toHaveLength(1);
    expect(list[0].sessionId).toBe(session.id);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'evaluations', 'replays', `${replay.id}.json`))).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'evaluations', 'replays', `${replay.id}.meta.json`))).toBe(true);
  });

  it('applies maxEvents to materialization, response, and persistence', async () => {
    const session = await execution.createSession({ name: 'bounded-replay' });
    for (let index = 0; index < 20; index += 1) {
      await execution.appendTrace(session.id, { level: 'info', event: 'step', message: `step-${index}` });
    }

    const replay = await service.replaySession(session.id, { maxEvents: 10 });
    const persisted = await fs.readJson(path.join(tempDir, '.context', 'runtime', 'evaluations', 'replays', `${replay.id}.json`));
    expect(replay.events).toHaveLength(10);
    expect(replay.fidelity).toBe('partial');
    expect(replay.omittedCounts.trace).toBeGreaterThan(0);
    expect(Object.keys(replay)).not.toEqual(expect.arrayContaining(['artifacts', 'checkpoints', 'traces', 'sensorRuns', 'tasks', 'handoffs']));
    expect(Object.keys(persisted)).not.toEqual(expect.arrayContaining(['artifacts', 'checkpoints', 'traces', 'sensorRuns', 'tasks', 'handoffs']));
    expect(Buffer.byteLength(JSON.stringify(persisted.events))).toBeLessThanOrEqual(1024 * 1024);
  });

  it('reads bounded session-scoped contracts without global materialization', async () => {
    const target = await execution.createSession({ name: 'bounded-contracts' });
    const other = await execution.createSession({ name: 'unrelated-contracts' });
    for (let index = 0; index < 5; index += 1) {
      await execution.createTaskContract({ title: `target-${index}`, sessionId: target.id });
      await execution.createTaskContract({ title: `other-${index}`, sessionId: other.id });
      await execution.createHandoffContract({ from: 'a', to: `target-${index}`, sessionId: target.id });
      await execution.createHandoffContract({ from: 'a', to: `other-${index}`, sessionId: other.id });
    }
    const listTasks = jest.spyOn(HarnessTaskContractsService.prototype, 'listTaskContracts');
    const listHandoffs = jest.spyOn(HarnessTaskContractsService.prototype, 'listHandoffContracts');
    const scopedTasks = jest.spyOn(HarnessTaskContractsService.prototype, 'listSessionTaskContracts');
    const scopedHandoffs = jest.spyOn(HarnessTaskContractsService.prototype, 'listSessionHandoffContracts');

    const replay = await service.buildReplay(target.id, { maxEvents: 30 });

    expect(listTasks).not.toHaveBeenCalled();
    expect(listHandoffs).not.toHaveBeenCalled();
    expect(scopedTasks).toHaveBeenCalledWith(target.id, 30, 1024 * 1024, undefined);
    expect(scopedHandoffs).toHaveBeenCalledWith(target.id, 30, 1024 * 1024, undefined);
    expect(replay.events.filter(event => event.source === 'task')).toHaveLength(5);
    expect(replay.events.filter(event => event.source === 'handoff')).toHaveLength(5);
    expect(replay.sourceCounts.task).toBe(5);
    expect(replay.sourceCounts.handoff).toBe(5);
  });

  it('continues every merged source with one global cursor and no duplicates', async () => {
    const session = await execution.createSession({ name: 'merged-cursor' });
    await execution.addArtifact(session.id, { name: 'evidence', kind: 'text', content: 'ok' });
    await execution.checkpointSession(session.id, { note: 'checkpoint' });
    await execution.createTaskContract({ title: 'task', sessionId: session.id });
    await execution.createHandoffContract({ from: 'author', to: 'reviewer', sessionId: session.id });
    await execution.runSensor({ id: 'tests', name: 'Tests', execute: () => ({ status: 'passed', summary: 'ok' }) }, { sessionId: session.id });

    const seen = new Set<string>();
    const sources = new Set<string>();
    let cursor: string | undefined;
    let pageIndex = 0;
    do {
      const page = await service.buildReplay(session.id, { maxEvents: 3, cursor });
      expect(page.events.length).toBeLessThanOrEqual(3);
      for (const event of page.events) {
        const key = `${event.createdAt}:${event.source}:${event.id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        sources.add(event.source);
      }
      if (pageIndex === 0) expect(page.nextCursor).toBeDefined();
      cursor = page.nextCursor;
      pageIndex += 1;
    } while (cursor);

    expect([...sources]).toEqual(expect.arrayContaining(['session', 'trace', 'artifact', 'checkpoint', 'sensor', 'task', 'handoff']));
  });

  it('reports the complete sensor history count when the replay page stops early', async () => {
    const session = await execution.createSession({ name: 'sensor-count' });
    for (let index = 0; index < 5; index += 1) {
      await execution.runSensor({
        id: 'tests',
        name: 'Tests',
        execute: () => ({ status: 'passed', summary: `run-${index}` }),
      }, { sessionId: session.id });
    }

    const replay = await service.buildReplay(session.id, { maxEvents: 1 });

    expect(replay.sourceCounts.sensor).toBe(5);
    expect(replay.omittedCounts.sensor).toBe(5);
  });
});

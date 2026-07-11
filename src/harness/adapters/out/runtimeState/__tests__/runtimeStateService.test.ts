import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  HarnessRuntimeStateService,
} from '../runtimeStateService';

describe('HarnessRuntimeStateService', () => {
  let tempDir: string;
  let service: HarnessRuntimeStateService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-runtime-'));
    service = new HarnessRuntimeStateService({ repoPath: tempDir });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('persists sessions, traces, artifacts, checkpoints, and resume state', async () => {
    const session = await service.createSession({
      name: 'feature-run',
      metadata: { source: 'test' },
    });

    const trace = await service.appendTrace(session.id, {
      level: 'info',
      event: 'task.started',
      message: 'Task started',
      data: { step: 1 },
    });

    const artifact = await service.addArtifact(session.id, {
      name: 'design-note',
      kind: 'text',
      content: 'hello world',
      metadata: { author: 'agent' },
    });

    const checkpointed = await service.checkpointSession(session.id, {
      note: 'after first pass',
      artifactIds: [artifact.id],
      pause: true,
      data: { stage: 'review' },
    });

    const resumed = await service.resumeSession(session.id);
    const completed = await service.completeSession(session.id, 'done');

    const storedSession = await service.getSession(session.id);
    const traces = await service.listTraces(session.id);
    const artifacts = await service.listArtifacts(session.id);

    expect(session.status).toBe('active');
    expect(trace.event).toBe('task.started');
    expect(artifact.name).toBe('design-note');
    expect(checkpointed.checkpoints).toHaveLength(1);
    expect(resumed.status).toBe('active');
    expect(completed.status).toBe('completed');
    expect(storedSession.status).toBe('completed');
    expect(storedSession.checkpointCount).toBe(1);
    expect(traces.map((entry) => entry.event)).toEqual([
      'session.created',
      'task.started',
      'artifact.added',
      'session.paused',
      'session.resumed',
      'session.completed',
    ]);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].content).toBe('hello world');

    const sessionFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'session.json');
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const artifactFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'artifacts');

    expect(await fs.pathExists(sessionFile)).toBe(true);
    expect(await fs.pathExists(traceFile)).toBe(true);
    expect(await fs.pathExists(artifactFile)).toBe(true);
    const sessionDocument = await fs.readJson(sessionFile);
    expect(sessionDocument.checkpoints).toBeUndefined();
    expect(sessionDocument.lastCheckpointId).toBe(checkpointed.checkpoints[0].id);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'checkpoints', `${checkpointed.checkpoints[0].id}.json`))).toBe(true);
  });

  it('reads legacy inline checkpoints and migrates them losslessly on the next write', async () => {
    const session = await service.createSession({ name: 'legacy' });
    const file = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'session.json');
    const document = await fs.readJson(file);
    document.checkpoints = [{
      id: 'legacy-checkpoint',
      note: 'legacy note',
      data: { retained: true },
      artifactIds: ['artifact-1'],
      createdAt: '2020-01-01T00:00:00.000Z',
    }];
    document.checkpointCount = 1;
    await fs.writeJson(file, document);

    const before = await service.listCheckpoints(session.id);
    expect(before.map(item => item.id)).toEqual(['legacy-checkpoint']);
    await service.checkpointSession(session.id, { note: 'new checkpoint' });
    const after = await service.listCheckpoints(session.id);
    expect(after).toHaveLength(2);
    expect(after.find(item => item.id === 'legacy-checkpoint')?.data).toEqual({ retained: true });
    expect((await fs.readJson(file)).checkpoints).toBeUndefined();
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'checkpoints', 'legacy-checkpoint.json'))).toBe(true);
  });

  it('enforces checkpoint payload and artifact limits from safe runtime config', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'runtime.json'), {
      version: 1,
      checkpoints: { maxDataBytes: 1024, maxArtifactIds: 1 },
    });
    const session = await service.createSession({ name: 'bounded' });
    await expect(service.checkpointSession(session.id, { data: 'x'.repeat(2048) }))
      .rejects.toThrow('Checkpoint data exceeds');
    await expect(service.checkpointSession(session.id, { artifactIds: ['a', 'b'] }))
      .rejects.toThrow('Checkpoint artifactIds exceed');
  });

  it('lists sessions sorted by recency', async () => {
    const first = await service.createSession({ name: 'first' });
    await service.completeSession(first.id);
    const second = await service.createSession({ name: 'second' });

    const sessions = await service.listSessions();
    expect(sessions.map((item) => item.name)).toEqual(['second', 'first']);
  });

  it('rejects resuming completed sessions', async () => {
    const session = await service.createSession({ name: 'finished' });
    await service.completeSession(session.id);

    await expect(service.resumeSession(session.id)).rejects.toThrow('Cannot resume a completed session');
  });
});

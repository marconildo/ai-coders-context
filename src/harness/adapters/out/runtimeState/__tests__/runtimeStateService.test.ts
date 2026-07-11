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

  it('bounds oversized generic trace events before writing them', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'runtime.json'), {
      trace: { maxSerializedBytes: 1024 },
    });
    const session = await service.createSession({ name: 'bounded-traces' });
    const secretMarker = `large-marker-${'x'.repeat(10 * 1024)}`;

    const trace = await service.appendTrace(session.id, {
      level: 'info',
      event: 'large.event',
      message: 'large trace',
      data: { body: secretMarker },
    });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const persisted = await fs.readFile(traceFile, 'utf8');

    expect(trace.data).toMatchObject({ traceDataOmitted: true, quota: 'max_serialized_trace_bytes' });
    expect(persisted).not.toContain(secretMarker);
    expect(persisted.trim().split('\n').every((line) => Buffer.byteLength(line) <= 1024)).toBe(true);
  });

  it('rotates traces atomically and reads retained segments in chronological order', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'hooks.json'), {
      trace: {
        rotationBytes: 64 * 1024,
        retainedSegments: 4,
        maxSessionBytes: 512 * 1024,
      },
    });
    const session = await service.createSession({ name: 'rotating-traces' });
    await Promise.all(Array.from({ length: 12 }, (_, index) => service.appendTrace(session.id, {
      level: 'info',
      event: 'concurrent.event',
      message: `event-${index}`,
      data: { index, payload: 'x'.repeat(10 * 1024) },
    })));

    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const files = (await fs.readdir(sessionDir)).filter((entry) => entry.endsWith('.jsonl'));
    expect(files).toContain('trace.jsonl');
    expect(files.some((entry) => /^trace\..+\.jsonl$/.test(entry))).toBe(true);

    const traces = await service.listTraces(session.id);
    expect(traces.filter((trace) => trace.event === 'concurrent.event')).toHaveLength(12);
    expect(traces.some((trace) => trace.event === 'trace.rotated')).toBe(true);
    expect(traces.filter((trace) => trace.event === 'concurrent.event').map((trace) => trace.data?.index))
      .toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect((await service.getSession(session.id)).traceCount).toBe(traces.length);
  });
});

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
  HarnessRuntimeStateService,
  MAX_SENSOR_SUMMARY_ENTRIES,
  MAX_SENSOR_SUMMARY_ENTRY_BYTES,
  MAX_STREAMED_TRACE_LINE_BYTES,
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
    const checkpointPage = await service.listCheckpointsPage(session.id, { limit: 10 });
    const traces = await service.listTraces(session.id);
    const artifacts = await service.listArtifacts(session.id);

    expect(session.status).toBe('active');
    expect(trace.event).toBe('task.started');
    expect(artifact.name).toBe('design-note');
    expect(checkpointed.checkpoints).toEqual([]);
    expect(checkpointPage.records).toHaveLength(1);
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
    expect(sessionDocument.lastCheckpointId).toBe(checkpointPage.records[0].id);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'checkpoints', `${checkpointPage.records[0].id}.json`))).toBe(true);
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
      checkpoints: { maxDataBytes: 1024, maxSerializedBytes: 1024, maxArtifactIds: 1 },
    });
    const session = await service.createSession({ name: 'bounded' });
    await expect(service.checkpointSession(session.id, { data: 'x'.repeat(2048) }))
      .rejects.toThrow('Checkpoint data exceeds');
    await expect(service.checkpointSession(session.id, { artifactIds: ['a', 'b'] }))
      .rejects.toThrow('Checkpoint artifactIds exceed');
    await expect(service.checkpointSession(session.id, { data: 'x'.repeat(950) }))
      .rejects.toThrow('Checkpoint record exceeds');
    await expect(service.checkpointSession(session.id, { note: 'n'.repeat(2 * 1024 * 1024) }))
      .rejects.toThrow('Checkpoint note exceeds');
    await expect(service.checkpointSession(session.id, { artifactIds: ['a'.repeat(2 * 1024 * 1024)] }))
      .rejects.toThrow('Checkpoint artifactId exceeds');
  });

  it('keeps session lookup and checkpoint writes independent of total checkpoint history', async () => {
    const session = await service.createSession({ name: 'many-checkpoints' });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const checkpointDir = path.join(sessionDir, 'checkpoints');
    await fs.ensureDir(checkpointDir);
    for (let index = 0; index < 250; index += 1) {
      const checkpoint = {
        id: `existing-${String(index).padStart(3, '0')}`,
        note: `checkpoint ${index}`,
        artifactIds: [],
        createdAt: new Date(index * 1000).toISOString(),
      };
      await fs.writeJson(path.join(checkpointDir, `${checkpoint.id}.json`), checkpoint);
    }
    const document = await fs.readJson(path.join(sessionDir, 'session.json'));
    document.checkpointCount = 250;
    document.lastCheckpointId = 'existing-249';
    await fs.writeJson(path.join(sessionDir, 'session.json'), document);

    const fullHistory = jest.spyOn(service, 'listCheckpoints');
    const summary = await service.getSession(session.id);
    expect(summary.checkpointCount).toBe(250);
    expect(summary.checkpoints).toEqual([]);
    expect(fullHistory).not.toHaveBeenCalled();

    const firstPage = await service.listCheckpointsPage(session.id, { limit: 25 });
    expect(firstPage.records).toHaveLength(25);
    expect(firstPage.nextCursor).toBeDefined();
    const secondPage = await service.listCheckpointsPage(session.id, {
      cursor: firstPage.nextCursor,
      limit: 25,
    });
    expect(secondPage.records).toHaveLength(25);
    expect(new Set([...firstPage.records, ...secondPage.records].map(item => item.id)).size).toBe(50);

    await service.checkpointSession(session.id, { note: 'incremental' });
    expect((await service.getSession(session.id)).checkpointCount).toBe(251);
    expect(fullHistory).not.toHaveBeenCalled();
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
    expect(await fs.pathExists(path.join(sessionDir, 'trace.jsonl.lock'))).toBe(false);
  });

  it('recovers a stale cross-process trace lock', async () => {
    const session = await service.createSession({ name: 'stale-lock' });
    const lockFile = path.join(
      tempDir,
      '.context',
      'runtime',
      'sessions',
      session.id,
      'trace.jsonl.lock'
    );
    await fs.writeFile(lockFile, '999999 2000-01-01T00:00:00.000Z\n', 'utf8');
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    await expect(service.appendTrace(session.id, {
      level: 'info',
      event: 'after.stale.lock',
      message: 'continued',
    })).resolves.toMatchObject({ event: 'after.stale.lock' });
    expect(await fs.pathExists(lockFile)).toBe(false);
  });

  it('streams bounded newest-first trace pages across rotated segments', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'hooks.json'), {
      trace: { rotationBytes: 64 * 1024, retainedSegments: 8, maxSessionBytes: 1024 * 1024 },
    });
    const session = await service.createSession({ name: 'paged' });
    for (let index = 0; index < 18; index += 1) {
      await service.appendTrace(session.id, { level: 'info', event: 'page.event', message: `event-${index}`, data: { index, payload: 'x'.repeat(8 * 1024) } });
    }

    const first = await service.listTracePage(session.id, { limit: 5, event: 'page.event' });
    const second = await service.listTracePage(session.id, { limit: 5, event: 'page.event', cursor: first.nextCursor });

    expect(first.items.map(item => item.data?.index)).toEqual([17, 16, 15, 14, 13]);
    expect(second.items.map(item => item.data?.index)).toEqual([12, 11, 10, 9, 8]);
    expect(first).toMatchObject({ hasMore: true, recordsReturned: 5, cursorVersion: 1, malformedCount: 0 });
    expect(first.scannedBytes).toBeLessThan(256 * 1024);
  });

  it('skips malformed terminal trace lines and rejects oversized pages', async () => {
    const session = await service.createSession({ name: 'malformed' });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    await fs.appendFile(traceFile, '{"partial":', 'utf8');

    const page = await service.listTracePage(session.id, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.malformedCount).toBe(1);
    await expect(service.listTracePage(session.id, { limit: 1001 })).rejects.toThrow('between 1 and 1000');
    await expect(service.listTracePage(session.id, { maxBytes: 1023 })).rejects.toThrow('between 1024');
    await expect(service.listTracePage(session.id, { maxBytes: 16 * 1024 * 1024 + 1 }))
      .rejects.toThrow('between 1024');
    await expect(service.listSessionPage({ limit: 201 })).rejects.toThrow('between 1 and 200');
    await expect(service.listTracePage(session.id, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'INVALID_RUNTIME_HISTORY_CURSOR',
    });
  });

  it('discards oversized JSONL frames with bounded memory in both directions', async () => {
    const session = await service.createSession({ name: 'oversized-lines' });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const oldest = {
      id: 'oldest', sessionId: session.id, level: 'info', event: 'valid',
      message: 'oldest', createdAt: '2026-01-01T00:00:00.000Z',
    };
    const newest = {
      id: 'newest', sessionId: session.id, level: 'info', event: 'valid',
      message: 'newest', createdAt: '2026-01-02T00:00:00.000Z',
    };
    const oversized = `{"payload":"${'x'.repeat(MAX_STREAMED_TRACE_LINE_BYTES + 1)}"}`;
    const contents = `${JSON.stringify(oldest)}\n${oversized}\n${JSON.stringify(newest)}\n`;
    await fs.writeFile(traceFile, contents, 'utf8');

    const forward = await service.listTracePage(session.id, { limit: 10, direction: 'oldest' });
    const reverse = await service.listTracePage(session.id, { limit: 10, direction: 'newest' });

    expect(forward.items.map(item => item.id)).toEqual(['oldest', 'newest']);
    expect(reverse.items.map(item => item.id)).toEqual(['newest', 'oldest']);
    expect(forward.malformedCount).toBe(1);
    expect(reverse.malformedCount).toBe(1);
    expect(forward.scannedBytes).toBe(Buffer.byteLength(contents));
    expect(reverse.scannedBytes).toBe(Buffer.byteLength(contents));
  });

  it('limits aggregate trace page bytes and continues every record by cursor', async () => {
    const session = await service.createSession({ name: 'byte-pages' });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const records = Array.from({ length: 100 }, (_, index) => ({
      id: `large-${index}`,
      sessionId: session.id,
      level: 'info',
      event: 'large.page',
      message: `record-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      data: { index, payload: 'x'.repeat(64 * 1024) },
    }));
    await fs.writeFile(traceFile, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.listTracePage(session.id, {
        direction: 'oldest',
        limit: 100,
        maxBytes: 256 * 1024,
        cursor,
      });
      expect(page.returnedBytes).toBeLessThanOrEqual(256 * 1024);
      expect(page.items.length).toBeLessThan(100);
      seen.push(...page.items.map(record => record.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual(records.map(record => record.id));
  });

  it('skips a single valid record larger than the byte budget without looping', async () => {
    const session = await service.createSession({ name: 'single-oversize' });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const oversized = {
      id: 'oversized-valid', sessionId: session.id, level: 'info', event: 'valid',
      message: 'x'.repeat(2048), createdAt: '2026-01-01T00:00:00.000Z',
    };
    const small = {
      id: 'small', sessionId: session.id, level: 'info', event: 'valid',
      message: 'small', createdAt: '2026-01-02T00:00:00.000Z',
    };
    await fs.writeFile(traceFile, `${JSON.stringify(oversized)}\n${JSON.stringify(small)}\n`);

    const page = await service.listTracePage(session.id, {
      direction: 'oldest',
      limit: 10,
      maxBytes: 1024,
    });

    expect(page.items.map(record => record.id)).toEqual(['small']);
    expect(page).toMatchObject({
      byteLimited: true,
      oversizedRecordsSkipped: 1,
      returnedBytes: expect.any(Number),
    });
    expect(page.returnedBytes).toBeLessThanOrEqual(1024);
  });

  it('maintains a latest sensor summary without scanning trace history', async () => {
    const session = await service.createSession({ name: 'sensor-summary' });
    await service.appendTrace(session.id, { level: 'error', event: 'sensor.run', message: 'first', data: { run: { sensorId: 'tests', status: 'failed', createdAt: '2025-01-01' } } });
    await service.appendTrace(session.id, { level: 'info', event: 'sensor.run', message: 'second', data: { run: { sensorId: 'tests', status: 'passed', createdAt: '2025-01-02' } } });

    const summary = await service.getSensorSummary(session.id);
    expect(summary.latestBySensor.tests).toMatchObject({ status: 'passed' });
    expect(await fs.pathExists(path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'sensor-summary'))).toBe(true);
  });

  it('shards and caps sensor summaries by entry count and bytes', async () => {
    const session = await service.createSession({ name: 'bounded-sensor-summary' });
    for (let index = 0; index < MAX_SENSOR_SUMMARY_ENTRIES + 4; index += 1) {
      await service.appendTrace(session.id, {
        level: 'error', event: 'sensor.run', message: `sensor-${index}`,
        data: { run: { id: `run-${index}`, sensorId: `sensor-${index}`, sessionId: session.id, status: 'failed', createdAt: new Date(1_700_000_000_000 + index).toISOString(), output: 'x'.repeat(80 * 1024) } },
      });
    }
    const summaryDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'sensor-summary');
    const files = (await fs.readdir(summaryDir)).filter(file => file.endsWith('.json') && file !== 'meta.json');
    expect(files.length).toBeLessThanOrEqual(MAX_SENSOR_SUMMARY_ENTRIES);
    for (const file of files) expect((await fs.stat(path.join(summaryDir, file))).size).toBeLessThanOrEqual(MAX_SENSOR_SUMMARY_ENTRY_BYTES);
    expect(Object.keys((await service.getSensorSummary(session.id)).latestBySensor).length).toBeLessThanOrEqual(MAX_SENSOR_SUMMARY_ENTRIES);
  }, 15_000);
});

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { promises as nodeFs } from 'fs';
import { pathToFileURL } from 'url';
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
    await service.createSession({ name: 'second' });

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

  it('serializes multiprocess writers racing to take over the same stale lock', async () => {
    const session = await service.createSession({ name: 'stale-lock-race' });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const lockFile = path.join(sessionDir, 'trace.jsonl.lock');
    await fs.writeJson(lockFile, {
      pid: 999999,
      token: 'stale-owner-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../runtimeStateService.ts')).href;
    const worker = `
      (async () => {
        const loaded = await import(${JSON.stringify(moduleUrl)});
        const HarnessRuntimeStateService = loaded.HarnessRuntimeStateService ?? loaded.default?.HarnessRuntimeStateService;
        const runtime = new HarnessRuntimeStateService({ repoPath: process.argv[1] });
        await runtime.appendTrace(process.argv[2], {
          level: 'info', event: 'worker.event', message: 'worker-' + process.argv[3],
          data: { worker: Number(process.argv[3]), payload: 'x'.repeat(8192) }
        });
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const runWorker = (index: number): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', worker, tempDir, session.id, String(index)], {
        cwd: path.resolve(__dirname, '../../../../../..'),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker ${index} failed: ${stderr}`)));
    });

    await Promise.all(Array.from({ length: 8 }, (_, index) => runWorker(index)));

    const traceText = await fs.readFile(path.join(sessionDir, 'trace.jsonl'), 'utf8');
    const lines = traceText.trim().split('\n');
    expect(() => lines.forEach((line) => JSON.parse(line))).not.toThrow();
    const traces = await service.listTraces(session.id);
    expect(traces.filter((trace) => trace.event === 'worker.event')).toHaveLength(8);
    expect(new Set(traces.filter((trace) => trace.event === 'worker.event').map((trace) => trace.data?.worker)).size)
      .toBe(8);
    expect(await fs.pathExists(lockFile)).toBe(false);
    expect(await fs.pathExists(`${lockFile}.takeover`)).toBe(false);
  }, 30_000);

  it('recovers an aged legacy takeover hardlink owned by a dead process', async () => {
    const session = await service.createSession({ name: 'legacy-takeover' });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const lockFile = path.join(sessionDir, 'trace.jsonl.lock');
    const takeoverFile = `${lockFile}.takeover`;
    await fs.writeJson(lockFile, {
      pid: 999999,
      token: 'legacy-dead-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    await fs.link(lockFile, takeoverFile);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    await expect(service.appendTrace(session.id, {
      level: 'info', event: 'legacy.recovered', message: 'continued safely',
    })).resolves.toMatchObject({ event: 'legacy.recovered' });
    expect(await fs.pathExists(lockFile)).toBe(false);
    expect(await fs.pathExists(takeoverFile)).toBe(false);
  });

  it('does not steal an aged legacy takeover while its owner is alive', async () => {
    const session = await service.createSession({ name: 'legacy-live-owner' });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const lockFile = path.join(sessionDir, 'trace.jsonl.lock');
    const takeoverFile = `${lockFile}.takeover`;
    const identity = {
      pid: process.pid,
      token: 'legacy-live-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    };
    await fs.writeJson(lockFile, identity);
    await fs.link(lockFile, takeoverFile);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    const pending = service.appendTrace(session.id, {
      level: 'info', event: 'after.live.legacy', message: 'waited for owner',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await fs.readJson(takeoverFile)).toEqual(identity);

    await fs.unlink(takeoverFile);
    await fs.unlink(lockFile);
    await expect(pending).resolves.toMatchObject({ event: 'after.live.legacy' });
  });

  it('preserves a replacement takeover published during legacy recovery', async () => {
    const session = await service.createSession({ name: 'legacy-replacement-race' });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const lockFile = path.join(sessionDir, 'trace.jsonl.lock');
    const takeoverFile = `${lockFile}.takeover`;
    await fs.writeJson(lockFile, {
      pid: 999999,
      token: 'legacy-replaced-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    await fs.link(lockFile, takeoverFile);
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    const replacement = {
      pid: process.pid,
      token: 'live-replacement-token',
      createdAt: new Date().toISOString(),
    };
    let takeoverOpens = 0;
    let publishReplacement!: () => void;
    const replacementPublished = new Promise<void>((resolve) => { publishReplacement = resolve; });
    const originalOpen = nodeFs.open.bind(nodeFs);
    const openSpy = jest.spyOn(nodeFs, 'open').mockImplementation(async (...args: Parameters<typeof nodeFs.open>) => {
      if (String(args[0]) === takeoverFile && ++takeoverOpens === 2) {
        const replacementFile = `${takeoverFile}.replacement`;
        await fs.writeJson(replacementFile, replacement);
        await fs.rename(replacementFile, takeoverFile);
        publishReplacement();
      }
      return originalOpen(...args);
    });

    const pending = service.appendTrace(session.id, {
      level: 'info', event: 'after.replacement.race', message: 'replacement survived',
    });
    try {
      await replacementPublished;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await fs.readJson(takeoverFile)).toEqual(replacement);
    } finally {
      openSpy.mockRestore();
      await fs.unlink(takeoverFile).catch(() => undefined);
      await fs.unlink(lockFile).catch(() => undefined);
    }
    await expect(pending).resolves.toMatchObject({ event: 'after.replacement.race' });
  });

  it('recovers when a takeover owner crashes after publishing its election identity', async () => {
    const session = await service.createSession({ name: 'orphaned-takeover-race' });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const lockFile = path.join(sessionDir, 'trace.jsonl.lock');
    const takeoverFile = `${lockFile}.takeover`;
    await fs.writeJson(lockFile, {
      pid: 999999,
      token: 'stale-target-token',
      createdAt: '2000-01-01T00:00:00.000Z',
    });
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lockFile, old, old);

    const moduleUrl = pathToFileURL(path.resolve(__dirname, '../runtimeStateService.ts')).href;
    const holderScript = `
      const fs = require('fs');
      const originalLink = fs.promises.link.bind(fs.promises);
      fs.promises.link = async (source, destination) => {
        await originalLink(source, destination);
        if (destination.endsWith('.takeover')) {
          process.stdout.write('TAKEOVER_READY\\n');
          await new Promise(() => {});
        }
      };
      (async () => {
        const loaded = await import(${JSON.stringify(moduleUrl)});
        const Runtime = loaded.HarnessRuntimeStateService ?? loaded.default?.HarnessRuntimeStateService;
        await new Runtime({ repoPath: process.argv[1] }).appendTrace(process.argv[2], {
          level: 'info', event: 'holder.event', message: 'must-not-complete'
        });
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const holder = spawn(process.execPath, ['--import', 'tsx', '-e', holderScript, tempDir, session.id], {
      cwd: path.resolve(__dirname, '../../../../../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      holder.stdout.setEncoding('utf8');
      holder.stderr.setEncoding('utf8');
      holder.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('TAKEOVER_READY')) resolve();
      });
      holder.stderr.on('data', (chunk) => { stderr += chunk; });
      holder.once('error', reject);
      holder.once('exit', (code) => reject(new Error(`takeover holder exited early (${code}): ${stderr}`)));
    });
    const holderPid = holder.pid;
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));

    const orphaned = await fs.readJson(takeoverFile) as Record<string, unknown>;
    expect(orphaned).toMatchObject({
      pid: holderPid,
      token: expect.any(String),
      createdAt: expect.any(String),
      inode: expect.any(String),
      device: expect.any(String),
      target: {
        token: 'stale-target-token',
        inode: expect.any(String),
        device: expect.any(String),
      },
    });
    await fs.utimes(takeoverFile, old, old);

    const writerScript = `
      (async () => {
        const loaded = await import(${JSON.stringify(moduleUrl)});
        const Runtime = loaded.HarnessRuntimeStateService ?? loaded.default?.HarnessRuntimeStateService;
        await new Runtime({ repoPath: process.argv[1] }).appendTrace(process.argv[2], {
          level: 'info', event: 'recovered.worker', message: 'worker-' + process.argv[3],
          data: { worker: Number(process.argv[3]) }
        });
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const runWriter = (index: number): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', '-e', writerScript, tempDir, session.id, String(index)], {
        cwd: path.resolve(__dirname, '../../../../../..'),
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`writer ${index} failed: ${stderr}`)));
    });
    await Promise.all(Array.from({ length: 8 }, (_, index) => runWriter(index)));

    const traceText = await fs.readFile(path.join(sessionDir, 'trace.jsonl'), 'utf8');
    expect(() => traceText.trim().split('\n').forEach((line) => JSON.parse(line))).not.toThrow();
    const traces = await service.listTraces(session.id);
    const recovered = traces.filter((trace) => trace.event === 'recovered.worker');
    expect(recovered).toHaveLength(8);
    expect(new Set(recovered.map((trace) => trace.data?.worker)).size).toBe(8);
    expect(traces.some((trace) => trace.event === 'holder.event')).toBe(false);
    expect((await fs.readdir(sessionDir)).filter((entry) => entry.includes('.takeover'))).toEqual([]);
    expect(await fs.pathExists(lockFile)).toBe(false);
  }, 30_000);

  it('uses monotonic segment sequences for same-millisecond rotation and pruning', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'hooks.json'), {
      trace: {
        rotationBytes: 64 * 1024,
        retainedSegments: 2,
        maxSessionBytes: 512 * 1024,
      },
    });
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout'] });
    jest.setSystemTime(new Date('2026-07-11T20:00:00.123Z'));
    try {
      const session = await service.createSession({ name: 'same-ms-rotation' });
      for (let index = 0; index < 6; index += 1) {
        await service.appendTrace(session.id, {
          level: 'info',
          event: 'same-ms.event',
          message: `event-${index}`,
          data: { index, payload: 'x'.repeat(60 * 1024) },
        });
      }

      const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
      const segments = (await fs.readdir(sessionDir))
        .filter((entry) => /^trace\.\d{12}\..+\.jsonl$/.test(entry))
        .sort();
      expect(segments).toHaveLength(2);
      const sequences = segments.map((entry) => Number(/^trace\.(\d{12})\./.exec(entry)?.[1]));
      expect(sequences[1]).toBe(sequences[0] + 1);

      const traces = await service.listTraces(session.id);
      const retainedIndexes = traces
        .filter((trace) => trace.event === 'same-ms.event')
        .map((trace) => trace.data?.index);
      expect(retainedIndexes).toEqual([...retainedIndexes].sort((a, b) => Number(a) - Number(b)));
      expect(retainedIndexes).toContain(5);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a single oversized event and active trace within a smaller session quota', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'hooks.json'), {
      trace: {
        rotationBytes: 64 * 1024 * 1024,
        retainedSegments: 16,
        maxSessionBytes: 64 * 1024,
      },
    });
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'runtime.json'), {
      trace: { maxSerializedBytes: 1024 * 1024 },
    });
    const session = await service.createSession({ name: 'cross-limit-budget' });
    const marker = `must-not-persist-${'x'.repeat(512 * 1024)}`;

    const trace = await service.appendTrace(session.id, {
      level: 'info', event: 'oversized.single', message: marker, data: { marker },
    });
    const sessionDir = path.join(tempDir, '.context', 'runtime', 'sessions', session.id);
    const traceFiles = (await fs.readdir(sessionDir)).filter((entry) => entry.endsWith('.jsonl'));
    const totalBytes = (await Promise.all(traceFiles.map((entry) => fs.stat(path.join(sessionDir, entry)))))
      .reduce((sum, stat) => sum + stat.size, 0);

    expect(totalBytes).toBeLessThanOrEqual(64 * 1024);
    expect(trace.data).toMatchObject({ traceDataOmitted: true });
    expect((await fs.readFile(path.join(sessionDir, 'trace.jsonl'), 'utf8'))).not.toContain(marker);
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

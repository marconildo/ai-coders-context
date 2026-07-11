import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { promises as nodeFs } from 'fs';
import { pathToFileURL } from 'url';
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
});

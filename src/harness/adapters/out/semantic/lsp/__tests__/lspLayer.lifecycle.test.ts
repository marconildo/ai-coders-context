import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { ChildProcess } from 'child_process';
import { LSPLayer, LSPLayerOptions, LSPLifecycleEvent } from '../lspLayer';
import type { LSPServerConfig } from '../../types';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-lsp-server.js');
const TIMEOUT_MS = 150;

function server(mode: string, pidFile: string, attackSize?: number): LSPServerConfig {
  const args = [FIXTURE, mode, pidFile];
  if (attackSize !== undefined) args.push(String(attackSize));
  return { command: process.execPath, args };
}

interface InspectableHandle {
  process: ChildProcess;
  pendingRequests: Map<number, unknown>;
  timers: Set<NodeJS.Timeout>;
  buffer: Buffer;
}

function currentHandle(subject: LSPLayer): InspectableHandle {
  const handles = (subject as unknown as { handles: Map<string, InspectableHandle> }).handles;
  const [handle] = [...handles.values()];
  if (!handle) throw new Error('expected an active LSP handle');
  return handle;
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition did not become true before timeout');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPids(pidFile: string): Promise<number[]> {
  try {
    return (await fs.readFile(pidFile, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

describe('LSPLayer process lifecycle', () => {
  let projectPath: string;
  let pidFile: string;
  let layer: LSPLayer | undefined;

  beforeEach(async () => {
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dotcontext-lsp-'));
    pidFile = path.join(projectPath, 'pids');
  });

  afterEach(async () => {
    await layer?.shutdown();
    const pids = await readPids(pidFile);
    await Promise.all(pids.map((pid) => waitUntil(() => !processIsAlive(pid))));
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  function createLayer(
    configs: Record<string, LSPServerConfig>,
    overrides: LSPLayerOptions = {}
  ): LSPLayer {
    layer = new LSPLayer({
      serverConfigs: configs,
      requestTimeoutMs: TIMEOUT_MS,
      shutdownTimeoutMs: TIMEOUT_MS,
      terminationGraceMs: TIMEOUT_MS,
      ...overrides,
    });
    return layer;
  }

  it('terminates the child after initialize rejection and suppresses retries', async () => {
    const subject = createLayer({ typescript: server('reject-initialize', pidFile) });

    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(false);
    const [pid] = await readPids(pidFile);
    expect(pid).toBeDefined();
    await waitUntil(() => !processIsAlive(pid));

    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(false);
    await expect(subject.getTypeInfo(path.join(projectPath, 'a.ts'), 1, 0, projectPath)).resolves.toBeNull();
    expect(await readPids(pidFile)).toEqual([pid]);
  });

  it('terminates the child after initialize timeout', async () => {
    const subject = createLayer({ typescript: server('timeout-initialize', pidFile) });

    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(false);
    const [pid] = await readPids(pidFile);
    expect(pid).toBeDefined();
    await waitUntil(() => !processIsAlive(pid));
  });

  it('cleans up when the child crashes during initialization', async () => {
    const subject = createLayer({ typescript: server('crash-after-spawn', pidFile) });

    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(false);
    const [pid] = await readPids(pidFile);
    expect(pid).toBeDefined();
    await waitUntil(() => !processIsAlive(pid));
  });

  it.each([
    {
      name: 'incomplete huge header',
      mode: 'incomplete-huge-header',
      attackSize: 4096,
      overrides: { maxHeaderBytes: 1024, maxReceiveBufferBytes: 8192 },
      reason: /header limit exceeded/,
    },
    {
      name: 'incomplete huge body',
      mode: 'incomplete-huge-body',
      attackSize: 4096,
      overrides: { maxBodyBytes: 8192, maxReceiveBufferBytes: 2048 },
      reason: /receive buffer limit exceeded|frame exceeds receive buffer limit/,
    },
    {
      name: 'abusive Content-Length',
      mode: 'abusive-content-length',
      attackSize: 4096,
      overrides: { maxBodyBytes: 8192 },
      reason: /Content-Length exceeds body limit/,
    },
    {
      name: 'caller attempt to raise the absolute header maximum',
      mode: 'incomplete-huge-header',
      attackSize: 32 * 1024,
      overrides: { maxHeaderBytes: Number.MAX_SAFE_INTEGER },
      reason: /header limit exceeded/,
    },
  ])('terminates and opens the circuit for $name', async ({
    mode,
    attackSize,
    overrides,
    reason,
  }) => {
    const events: LSPLifecycleEvent[] = [];
    const subject = createLayer(
      { typescript: server(mode, pidFile, attackSize) },
      { ...overrides, onLifecycleEvent: (event) => events.push(event) }
    );

    const initialization = subject.ensureServer('typescript', projectPath);
    const handle = currentHandle(subject);
    await expect(initialization).resolves.toBe(false);
    const [pid] = await readPids(pidFile);
    expect(pid).toBeDefined();
    await waitUntil(() => !processIsAlive(pid));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'failed', reason: expect.stringMatching(reason) }),
      expect.objectContaining({ state: 'stopped', pendingRequestCount: 0 }),
    ]));
    expect(handle.pendingRequests.size).toBe(0);
    expect(handle.timers.size).toBe(0);
    expect(handle.buffer).toHaveLength(0);

    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(false);
    expect(await readPids(pidFile)).toEqual([pid]);
  });

  it('deduplicates concurrent initialization for the same language and project', async () => {
    const subject = createLayer({ typescript: server('normal', pidFile) });

    await expect(
      Promise.all([
        subject.ensureServer('typescript', projectPath),
        subject.ensureServer('typescript', projectPath),
        subject.ensureServer('typescript', projectPath),
      ])
    ).resolves.toEqual([true, true, true]);
    expect(await readPids(pidFile)).toHaveLength(1);
  });

  it('does not reject another language request when one server crashes', async () => {
    const subject = createLayer({
      typescript: server('crash-on-hover', pidFile),
      javascript: server('normal', pidFile),
    });
    await Promise.all([
      subject.ensureServer('typescript', projectPath),
      subject.ensureServer('javascript', projectPath),
    ]);

    const [failedResult, healthyResult] = await Promise.all([
      subject.getTypeInfo(path.join(projectPath, 'a.ts'), 1, 0, projectPath),
      subject.getTypeInfo(path.join(projectPath, 'a.js'), 1, 0, projectPath),
    ]);

    expect(failedResult).toBeNull();
    expect(healthyResult?.name).toBe('FakeType');
  });

  it('forces termination and waits for child exit when shutdown is ignored', async () => {
    const events: LSPLifecycleEvent[] = [];
    const subject = createLayer(
      { typescript: server('ignore-shutdown', pidFile) },
      { onLifecycleEvent: (event) => events.push(event) }
    );
    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(true);
    const [pid] = await readPids(pidFile);
    expect(processIsAlive(pid)).toBe(true);

    await subject.shutdown();

    expect(processIsAlive(pid)).toBe(false);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          language: 'typescript',
          state: 'stopped',
          forcedKill: true,
          exitSignal: 'SIGKILL',
        }),
      ])
    );
    await expect(subject.shutdown()).resolves.toBeUndefined();
  });

  it('is safe when shutdown races with initialization', async () => {
    const subject = createLayer({ typescript: server('timeout-initialize', pidFile) });

    const initialization = subject.ensureServer('typescript', projectPath);
    await waitUntil(async () => (await readPids(pidFile)).length === 1);
    const [pid] = await readPids(pidFile);
    const handle = currentHandle(subject);

    await expect(Promise.all([initialization, subject.shutdown()])).resolves.toEqual([
      false,
      undefined,
    ]);
    expect(processIsAlive(pid)).toBe(false);
    expect(handle.pendingRequests.size).toBe(0);
    expect(handle.timers.size).toBe(0);
  });

  it('removes final listeners, timers, buffers, and process handles after shutdown', async () => {
    const subject = createLayer({ typescript: server('normal', pidFile) });
    await expect(subject.ensureServer('typescript', projectPath)).resolves.toBe(true);
    const [pid] = await readPids(pidFile);
    const handle = currentHandle(subject);

    await subject.shutdown();

    expect(processIsAlive(pid)).toBe(false);
    expect(handle.pendingRequests.size).toBe(0);
    expect(handle.timers.size).toBe(0);
    expect(handle.buffer).toHaveLength(0);
    expect(handle.process.eventNames()).toEqual([]);
    expect(handle.process.stdin?.eventNames()).toEqual([]);
    expect(handle.process.stdout?.eventNames()).toEqual([]);
    expect(handle.process.stderr?.eventNames()).toEqual([]);
  });
});

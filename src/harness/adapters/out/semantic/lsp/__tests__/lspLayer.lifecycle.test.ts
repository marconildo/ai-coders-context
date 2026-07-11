import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LSPLayer, LSPLayerOptions, LSPLifecycleEvent } from '../lspLayer';
import type { LSPServerConfig } from '../../types';

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-lsp-server.js');
const TIMEOUT_MS = 150;

function server(mode: string, pidFile: string): LSPServerConfig {
  return { command: process.execPath, args: [FIXTURE, mode, pidFile] };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
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
});

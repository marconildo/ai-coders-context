import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { promises as nativeFs } from 'fs';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';

import { createHarnessHookAdapter } from '../../../harness';
import {
  CLAUDE_CODE_HOOK_DISPATCH_COMMAND,
  CODEX_HOOK_DISPATCH_COMMAND,
} from '../hookDispatchCommands';
import {
  ensureHookHarnessSession,
  getHookHarnessSessionId,
  pruneHookSessionBindings,
  saveHookHarnessSession,
} from '../hookSessionStore';

describe('hookDispatchCommands', () => {
  it('uses npx for shell hook dispatch', () => {
    expect(CLAUDE_CODE_HOOK_DISPATCH_COMMAND).toContain('npx -y @dotcontext/cli@latest');
    expect(CODEX_HOOK_DISPATCH_COMMAND).toContain('npx -y @dotcontext/cli@latest');
  });
});

describe('hookSessionStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotcontext-hook-session-'));
    await fs.ensureDir(path.join(tempDir, '.context', 'runtime', 'sessions'));
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('creates and reuses harness session bindings per host session', async () => {
    const adapter = createHarnessHookAdapter({ repoPath: tempDir, source: 'claude-code' });
    const hostSessionId = 'claude-host-1';

    const first = await ensureHookHarnessSession(adapter, {
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId,
    });

    const second = await ensureHookHarnessSession(adapter, {
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId,
    });

    expect(second).toBe(first);

    const stored = await getHookHarnessSessionId({
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId,
    });

    expect(stored).toBe(first);
  });

  it('prunes expired and missing harness-session bindings during explicit maintenance', async () => {
    const old = '2020-01-01T00:00:00.000Z';
    await saveHookHarnessSession({
      repoPath: tempDir,
      source: 'codex',
      hostSessionId: 'expired',
      harnessSessionId: 'missing-expired',
      createdAt: old,
      updatedAt: old,
    });
    await saveHookHarnessSession({
      repoPath: tempDir,
      source: 'codex',
      hostSessionId: 'missing',
      harnessSessionId: 'missing-current',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const result = await pruneHookSessionBindings(tempDir);
    expect(result.removedExpired).toBe(1);
    expect(result.removedMissing).toBe(1);
    expect(result.remaining).toBe(0);
  });

  it('caps host-sessions.json at the configured repository limit', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'runtime.json'), {
      version: 1,
      bindings: { maxEntries: 2 },
    });
    for (let index = 0; index < 3; index += 1) {
      const timestamp = new Date(Date.now() + index * 1000).toISOString();
      await saveHookHarnessSession({
        repoPath: tempDir,
        source: 'claude-code',
        hostSessionId: `host-${index}`,
        harnessSessionId: `harness-${index}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    const store = await fs.readJson(path.join(tempDir, '.context', 'runtime', 'hooks', 'host-sessions.json'));
    expect(Object.keys(store.bindings['claude-code'])).toHaveLength(2);
    expect(store.bindings['claude-code']['host-0']).toBeUndefined();
  });

  it('serializes concurrent save and prune mutations without losing bindings', async () => {
    const now = new Date().toISOString();
    const saves = Array.from({ length: 30 }, async (_, index) => {
      const harnessSessionId = `concurrent-harness-${index}`;
      await fs.outputJson(
        path.join(tempDir, '.context', 'runtime', 'sessions', harnessSessionId, 'session.json'),
        { id: harnessSessionId, status: 'active' },
      );
      await saveHookHarnessSession({
        repoPath: tempDir,
        source: index % 2 === 0 ? 'claude-code' : 'codex',
        hostSessionId: `concurrent-host-${index}`,
        harnessSessionId,
        createdAt: now,
        updatedAt: now,
      });
    });

    await Promise.all([
      ...saves,
      pruneHookSessionBindings(tempDir),
      pruneHookSessionBindings(tempDir),
      pruneHookSessionBindings(tempDir),
    ]);

    const storePath = path.join(tempDir, '.context', 'runtime', 'hooks', 'host-sessions.json');
    const store = await fs.readJson(storePath);
    const bindings = Object.values(store.bindings)
      .flatMap(source => Object.values(source as Record<string, unknown>));
    expect(bindings).toHaveLength(30);
    expect(await fs.pathExists(`${storePath}.lock`)).toBe(false);
  });

  it('reclaims an aged lock whose owner process crashed', async () => {
    const storePath = path.join(tempDir, '.context', 'runtime', 'hooks', 'host-sessions.json');
    const lockPath = `${storePath}.lock`;
    await fs.ensureDir(path.dirname(lockPath));
    const childScript = [
      "const fs = require('fs');",
      "const { randomUUID } = require('crypto');",
      'const lockPath = process.argv[1];',
      'fs.writeFileSync(lockPath, JSON.stringify({',
      '  version: 1,',
      '  pid: process.pid,',
      '  token: randomUUID(),',
      '  createdAt: Date.now() - 60000',
      '}));',
      'process.exit(73);',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', childScript, lockPath], { stdio: 'ignore' });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    expect(await fs.pathExists(lockPath)).toBe(true);

    const now = new Date().toISOString();
    await saveHookHarnessSession({
      repoPath: tempDir,
      source: 'codex',
      hostSessionId: 'after-crash',
      harnessSessionId: 'replacement-session',
      createdAt: now,
      updatedAt: now,
    });

    expect(await getHookHarnessSessionId({
      repoPath: tempDir,
      source: 'codex',
      hostSessionId: 'after-crash',
    })).toBe('replacement-session');
    expect(await fs.pathExists(lockPath)).toBe(false);
  });

  it('does not unlink a replacement lock with a different inode and token', async () => {
    const storePath = path.join(tempDir, '.context', 'runtime', 'hooks', 'host-sessions.json');
    const lockPath = `${storePath}.lock`;
    await fs.outputJson(storePath, { bindings: {} });
    let unblockRead!: () => void;
    const readUnblocked = new Promise<void>(resolve => { unblockRead = resolve; });
    let lockAcquired!: () => void;
    const acquired = new Promise<void>(resolve => { lockAcquired = resolve; });
    const fsExtraModule = require('fs-extra') as typeof fs;
    const originalReadJson = fsExtraModule.readJson.bind(fsExtraModule);
    let blocked = false;
    const readSpy = jest.spyOn(fsExtraModule, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
      if (!blocked && path.resolve(String(args[0])) === storePath) {
        blocked = true;
        lockAcquired();
        await readUnblocked;
      }
      return originalReadJson(...args);
    });

    const now = new Date().toISOString();
    const saving = saveHookHarnessSession({
      repoPath: tempDir,
      source: 'claude-code',
      hostSessionId: 'replacement-race',
      harnessSessionId: 'replacement-race-session',
      createdAt: now,
      updatedAt: now,
    });
    await acquired;
    const replacement = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    await nativeFs.unlink(lockPath);
    await nativeFs.writeFile(lockPath, JSON.stringify(replacement), 'utf8');
    unblockRead();
    await saving;
    readSpy.mockRestore();

    expect(await fs.readJson(lockPath)).toEqual(replacement);
    await nativeFs.unlink(lockPath);
  });
});

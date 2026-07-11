import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

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
});

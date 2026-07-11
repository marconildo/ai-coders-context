import * as fs from 'fs-extra';
import * as path from 'path';
import { promises as nativeFs } from 'fs';
import { randomUUID } from 'crypto';

import { getContextRootPath } from '../../shared/context';
import type { HarnessHookResponse } from '../../harness';
import { loadRuntimeRetentionConfig } from '../../harness/application/retention/runtimeRetentionConfig';

import { extractHarnessSessionId } from './extractHarnessSessionId';

export type ShellHookSource = 'claude-code' | 'codex';

export interface HookSessionBinding {
  harnessSessionId: string;
  hostSessionId: string;
  source: ShellHookSource;
  repoPath: string;
  createdAt: string;
  updatedAt: string;
}

interface HookSessionStoreDocument {
  bindings: Record<string, Record<string, HookSessionBinding>>;
}

const mutationTails = new Map<string, Promise<void>>();
const LOCK_WAIT_MS = 10_000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 5_000;

interface HookSessionLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: number;
}

interface HookSessionLockSnapshot {
  owner?: HookSessionLockOwner;
  device: number;
  inode: number;
  mtimeMs: number;
}

export interface HookSessionPruneResult {
  removedExpired: number;
  removedMissing: number;
  removedOverLimit: number;
  remaining: number;
  durationMs: number;
}

export interface HookSessionAdapter {
  handle(event: {
    tool: 'harness';
    params: {
      action: 'createSession';
      name: string;
      metadata?: Record<string, unknown>;
    };
    source?: string;
  }): Promise<HarnessHookResponse>;
}

function storeKey(source: ShellHookSource, hostSessionId: string): string {
  return `${source}:${hostSessionId}`;
}

async function getStorePath(repoPath: string): Promise<string> {
  const contextRoot = await getContextRootPath(repoPath);
  return path.join(contextRoot, 'runtime', 'hooks', 'host-sessions.json');
}

async function readStore(repoPath: string): Promise<HookSessionStoreDocument> {
  const storePath = await getStorePath(repoPath);
  if (!await fs.pathExists(storePath)) {
    return { bindings: {} };
  }

  try {
    const document = await fs.readJson(storePath) as HookSessionStoreDocument;
    if (!document.bindings || typeof document.bindings !== 'object') {
      return { bindings: {} };
    }
    return document;
  } catch {
    return { bindings: {} };
  }
}

async function writeStore(repoPath: string, document: HookSessionStoreDocument): Promise<void> {
  const storePath = await getStorePath(repoPath);
  await fs.ensureDir(path.dirname(storePath));
  const temporary = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeJson(temporary, document, { spaces: 2 });
    await fs.rename(temporary, storePath);
  } finally {
    await fs.remove(temporary).catch(() => undefined);
  }
}

function parseLockOwner(value: string): HookSessionLockOwner | undefined {
  try {
    const candidate = JSON.parse(value) as Partial<HookSessionLockOwner>;
    if (
      candidate.version !== 1
      || !Number.isSafeInteger(candidate.pid)
      || (candidate.pid ?? 0) <= 0
      || typeof candidate.token !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(candidate.token)
      || !Number.isFinite(candidate.createdAt)
      || (candidate.createdAt ?? 0) <= 0
    ) return undefined;
    return candidate as HookSessionLockOwner;
  } catch {
    return undefined;
  }
}

async function readLockSnapshot(lockPath: string): Promise<HookSessionLockSnapshot> {
  const handle = await nativeFs.open(lockPath, 'r');
  try {
    const [stat, content] = await Promise.all([
      handle.stat(),
      handle.readFile('utf8'),
    ]);
    return {
      owner: parseLockOwner(content),
      device: stat.dev,
      inode: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameLock(left: HookSessionLockSnapshot, right: HookSessionLockSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.owner?.token === right.owner?.token
    && left.owner?.pid === right.owner?.pid
    && left.owner?.createdAt === right.owner?.createdAt;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function reclaimStaleLock(lockPath: string): Promise<boolean> {
  let observed: HookSessionLockSnapshot;
  try {
    observed = await readLockSnapshot(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    return false;
  }

  const createdAt = observed.owner?.createdAt ?? observed.mtimeMs;
  if (Date.now() - createdAt < LOCK_STALE_MS) return false;
  if (observed.owner && processIsAlive(observed.owner.pid)) return false;

  // Re-open immediately before unlinking. Both inode and the unguessable
  // owner token must still match, so a replacement lock is never removed on
  // the basis of an earlier stale observation.
  let current: HookSessionLockSnapshot;
  try {
    current = await readLockSnapshot(lockPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  if (!sameLock(observed, current)) return false;

  try {
    await nativeFs.unlink(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owned: HookSessionLockSnapshot,
): Promise<void> {
  let current: HookSessionLockSnapshot;
  try {
    current = await readLockSnapshot(lockPath);
  } catch {
    return;
  }
  if (!sameLock(owned, current)) return;
  await nativeFs.unlink(lockPath).catch(() => undefined);
}

async function withInterProcessLock<T>(storePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${storePath}.lock`;
  await fs.ensureDir(path.dirname(lockPath));
  const deadline = Date.now() + LOCK_WAIT_MS;
  let handle: Awaited<ReturnType<typeof nativeFs.open>> | undefined;
  const token = randomUUID();

  while (!handle) {
    try {
      handle = await nativeFs.open(lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reclaimStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for hook session store lock: ${path.basename(storePath)}`);
      }
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }

  const owner: HookSessionLockOwner = {
    version: 1,
    pid: process.pid,
    token,
    createdAt: Date.now(),
  };
  try {
    await handle.writeFile(JSON.stringify(owner), 'utf8');
    await handle.sync();
  } catch (error) {
    const stat = await handle.stat().catch(() => undefined);
    await handle.close().catch(() => undefined);
    if (stat) {
      await releaseOwnedLock(lockPath, {
        owner,
        device: stat.dev,
        inode: stat.ino,
        mtimeMs: stat.mtimeMs,
      });
    }
    throw error;
  }

  const stat = await handle.stat();
  const owned: HookSessionLockSnapshot = {
    owner,
    device: stat.dev,
    inode: stat.ino,
    mtimeMs: stat.mtimeMs,
  };

  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await releaseOwnedLock(lockPath, owned);
  }
}

async function mutateStore<T>(repoPath: string, operation: () => Promise<T>): Promise<T> {
  const normalizedRepoPath = path.resolve(repoPath);
  const storePath = await getStorePath(normalizedRepoPath);
  const predecessor = mutationTails.get(storePath) ?? Promise.resolve();
  let release!: () => void;
  const completed = new Promise<void>(resolve => { release = resolve; });
  const tail = predecessor.catch(() => undefined).then(() => completed);
  mutationTails.set(storePath, tail);

  await predecessor.catch(() => undefined);
  try {
    return await withInterProcessLock(storePath, () => operation());
  } finally {
    release();
    if (mutationTails.get(storePath) === tail) mutationTails.delete(storePath);
  }
}

export async function getHookHarnessSessionId(options: {
  repoPath: string;
  source: ShellHookSource;
  hostSessionId: string;
}): Promise<string | undefined> {
  const document = await readStore(options.repoPath);
  const binding = document.bindings[options.source]?.[options.hostSessionId];
  return binding?.harnessSessionId;
}

export async function saveHookHarnessSession(binding: HookSessionBinding): Promise<void> {
  const normalizedRepoPath = path.resolve(binding.repoPath);
  await mutateStore(normalizedRepoPath, async () => {
    const document = await readStore(normalizedRepoPath);
    const sourceBindings = document.bindings[binding.source] ?? {};
    sourceBindings[binding.hostSessionId] = { ...binding, repoPath: normalizedRepoPath };
    document.bindings[binding.source] = sourceBindings;
    const { config } = await loadRuntimeRetentionConfig(normalizedRepoPath);
    capBindings(document, config.bindings.maxEntries);
    await writeStore(normalizedRepoPath, document);
  });
}

function allBindings(document: HookSessionStoreDocument): Array<{ source: string; hostSessionId: string; binding: HookSessionBinding }> {
  return Object.entries(document.bindings).flatMap(([source, sourceBindings]) =>
    Object.entries(sourceBindings).map(([hostSessionId, binding]) => ({ source, hostSessionId, binding })),
  );
}

function capBindings(document: HookSessionStoreDocument, maxEntries: number): number {
  const bindings = allBindings(document).sort((a, b) => b.binding.updatedAt.localeCompare(a.binding.updatedAt));
  let removed = 0;
  for (const entry of bindings.slice(maxEntries)) {
    delete document.bindings[entry.source]?.[entry.hostSessionId];
    removed += 1;
  }
  return removed;
}

/** Explicit maintenance used at SessionStart, never on each PostToolUse. */
export async function pruneHookSessionBindings(repoPath: string): Promise<HookSessionPruneResult> {
  const startedAt = Date.now();
  const normalizedRepoPath = path.resolve(repoPath);
  const contextRoot = await getContextRootPath(normalizedRepoPath);
  return mutateStore(normalizedRepoPath, async () => {
    const document = await readStore(normalizedRepoPath);
    const { config } = await loadRuntimeRetentionConfig(normalizedRepoPath);
    const cutoff = Date.now() - config.bindings.maxAgeMs;
    let removedExpired = 0;
    let removedMissing = 0;

    for (const { source, hostSessionId, binding } of allBindings(document)) {
      const updatedAt = Date.parse(binding.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) {
        delete document.bindings[source]?.[hostSessionId];
        removedExpired += 1;
        continue;
      }
      const sessionFile = path.join(contextRoot, 'runtime', 'sessions', binding.harnessSessionId, 'session.json');
      if (!await fs.pathExists(sessionFile)) {
        delete document.bindings[source]?.[hostSessionId];
        removedMissing += 1;
      }
    }
    const removedOverLimit = capBindings(document, config.bindings.maxEntries);
    await writeStore(normalizedRepoPath, document);
    return {
      removedExpired,
      removedMissing,
      removedOverLimit,
      remaining: allBindings(document).length,
      durationMs: Date.now() - startedAt,
    };
  });
}

export async function ensureHookHarnessSession(
  adapter: HookSessionAdapter,
  options: {
    repoPath: string;
    source: ShellHookSource;
    hostSessionId: string;
  }
): Promise<string> {
  await pruneHookSessionBindings(options.repoPath);
  const existing = await getHookHarnessSessionId(options);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const response = await adapter.handle({
    tool: 'harness',
    params: {
      action: 'createSession',
      name: `hook:${options.source}:${options.hostSessionId.slice(0, 12)}`,
      metadata: {
        host: options.source,
        hostSessionId: options.hostSessionId,
      },
    },
    source: options.source,
  });

  const harnessSessionId = extractHarnessSessionId(response);
  if (!response.ok || !harnessSessionId) {
    const message = !response.ok ? response.error.message : 'Harness session id missing from createSession response';
    throw new Error(message);
  }

  await saveHookHarnessSession({
    harnessSessionId,
    hostSessionId: options.hostSessionId,
    source: options.source,
    repoPath: options.repoPath,
    createdAt: now,
    updatedAt: now,
  });

  return harnessSessionId;
}

export function hookSessionStoreKey(source: ShellHookSource, hostSessionId: string): string {
  return storeKey(source, hostSessionId);
}

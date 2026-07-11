import * as fs from 'fs-extra';
import * as path from 'path';

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
  await fs.writeJson(storePath, document, { spaces: 2 });
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
  const document = await readStore(normalizedRepoPath);
  const sourceBindings = document.bindings[binding.source] ?? {};
  sourceBindings[binding.hostSessionId] = { ...binding, repoPath: normalizedRepoPath };
  document.bindings[binding.source] = sourceBindings;
  const { config } = await loadRuntimeRetentionConfig(normalizedRepoPath);
  capBindings(document, config.bindings.maxEntries);
  await writeStore(normalizedRepoPath, document);
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

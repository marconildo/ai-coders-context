/**
 * MCP Action Logger
 *
 * Records MCP tool activity into harness session traces instead of maintaining
 * a separate workflow-local actions.jsonl log.
 */

import * as fs from 'fs-extra';
import * as path from 'path';

import { HarnessRuntimeStateService } from '../../harness/adapters/out/runtimeState/runtimeStateService';
import { BoundedLruCache, type BoundedLruCacheMetrics } from '../../harness/domain/retention/boundedLruCache';
import { loadRuntimeRetentionConfig } from '../../harness/application/retention/runtimeRetentionConfig';
import { HarnessWorkflowStateService } from '../../harness/adapters/out/workflowState/workflowStateService';
import { resolveContextRoot } from '../../shared/context/contextRootResolver';

type ActionStatus = 'success' | 'error';

export interface MCPActionLogEntry {
  timestamp: string;
  tool: string;
  action: string;
  status: ActionStatus;
  details?: Record<string, unknown>;
  error?: string;
}

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'token',
  'secret',
  'password',
  'authorization',
  'prompt',
  'content',
  'messages',
  'semanticContext',
]);

const MAX_DEPTH = 4;
const MAX_ARRAY = 20;
const MAX_STRING = 200;
const MCP_ACTIVITY_NAME = 'mcp-activity';

const sessionCaches = new Map<string, {
  cache: BoundedLruCache<string, string>;
  signature: string;
}>();

function normalizeRepoPath(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function sessionCacheForRepo(repoPath: string): Promise<BoundedLruCache<string, string>> {
  const normalized = normalizeRepoPath(repoPath);
  for (const [ownerPath, owner] of sessionCaches) {
    if (owner.cache.size === 0) {
      owner.cache.dispose();
      sessionCaches.delete(ownerPath);
    }
  }
  const loaded = await loadRuntimeRetentionConfig(normalized);
  const limits = loaded.config.caches.mcpSessions;
  const signature = JSON.stringify(limits);
  const current = sessionCaches.get(normalized);
  if (current?.signature === signature) {
    sessionCaches.delete(normalized);
    sessionCaches.set(normalized, current);
    return current.cache;
  }
  current?.cache.dispose();
  const cache = new BoundedLruCache<string, string>({
    maxEntries: limits.maxEntries,
    maxBytes: 64 * 1024,
    ttlMs: limits.ttlMs,
    estimateBytes: (sessionId, key) => Buffer.byteLength(sessionId) + Buffer.byteLength(key),
  });
  sessionCaches.set(normalized, { cache, signature });
  while (sessionCaches.size > limits.maxEntries) {
    const oldest = sessionCaches.keys().next().value as string | undefined;
    if (!oldest) break;
    sessionCaches.get(oldest)?.cache.dispose();
    sessionCaches.delete(oldest);
  }
  return cache;
}

export function clearMcpActionSessionCache(): void {
  for (const owner of sessionCaches.values()) owner.cache.dispose();
  sessionCaches.clear();
}

export function getMcpActionSessionCacheSize(): number {
  return [...sessionCaches.values()].reduce((total, owner) => total + owner.cache.size, 0);
}

export function getMcpActionSessionCacheMetrics(repoPath: string): BoundedLruCacheMetrics | undefined {
  return sessionCaches.get(normalizeRepoPath(repoPath))?.cache.metrics();
}

async function resolveContextPath(repoPath: string): Promise<string> {
  const resolution = await resolveContextRoot({
    startPath: repoPath,
    validate: false,
  });
  return resolution.contextPath;
}

function sanitizeValue(value: unknown, depth: number = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (typeof value === 'string') {
    if (value.length <= MAX_STRING) return value;
    return `${value.slice(0, MAX_STRING)}...`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const trimmed = value.slice(0, MAX_ARRAY).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY) {
      trimmed.push(`...(${value.length - MAX_ARRAY} more items)`);
    }
    return trimmed;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = sanitizeValue(entryValue, depth + 1);
      }
    }
    return result;
  }

  return String(value);
}

function sanitizeDetails(details?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!details) return undefined;
  return sanitizeValue(details) as Record<string, unknown>;
}

async function resolveWorkflowSessionId(contextPath: string): Promise<string | null> {
  const workflowState = new HarnessWorkflowStateService({ contextPath });
  if (!(await workflowState.exists())) {
    return null;
  }

  try {
    const binding = await workflowState.getBinding();
    return binding?.sessionId ?? null;
  } catch {
    return null;
  }
}

async function resolveMcpActivitySessionId(
  repoPath: string,
  state: HarnessRuntimeStateService
): Promise<string> {
  const cacheKey = 'mcp-activity';
  const sessionCache = await sessionCacheForRepo(repoPath);
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    try {
      const session = await state.getSession(cached);
      if (session.status === 'active' || session.status === 'paused') return cached;
      sessionCache.delete(cacheKey);
    } catch {
      sessionCache.delete(cacheKey);
    }
  }

  let existing;
  let cursor: string | undefined;
  do {
    const page = await state.listSessionPage({ limit: 50, cursor });
    existing = page.items.find((session) =>
      session.name === MCP_ACTIVITY_NAME &&
      session.metadata?.transport === 'mcp' &&
      (session.status === 'active' || session.status === 'paused')
    );
    cursor = existing ? undefined : page.nextCursor;
  } while (!existing && cursor);

  if (existing) {
    sessionCache.set(cacheKey, existing.id);
    return existing.id;
  }

  const created = await state.createSession({
    name: MCP_ACTIVITY_NAME,
    metadata: {
      transport: 'mcp',
      purpose: 'tool-audit',
    },
  });
  sessionCache.set(cacheKey, created.id);
  return created.id;
}

export async function logMcpAction(
  repoPath: string,
  entry: Omit<MCPActionLogEntry, 'timestamp'> & { timestamp?: string }
): Promise<void> {
  try {
    const contextPath = await resolveContextPath(repoPath);
    if (!(await fs.pathExists(contextPath))) {
      return;
    }

    const state = new HarnessRuntimeStateService({ repoPath });
    const workflowSessionId = await resolveWorkflowSessionId(contextPath);
    let sessionId = workflowSessionId;
    if (sessionId) {
      try {
        await state.getSession(sessionId);
      } catch {
        sessionId = null;
      }
    }
    if (!sessionId) {
      sessionId = await resolveMcpActivitySessionId(repoPath, state);
    }
    const timestamp = entry.timestamp || new Date().toISOString();

    await state.appendTrace(sessionId, {
      level: entry.status === 'error' ? 'error' : 'info',
      event: entry.status === 'error' ? 'mcp.tool.failed' : 'mcp.tool.succeeded',
      message: `${entry.tool}.${entry.action} ${entry.status}`,
      data: {
        transport: 'mcp',
        tool: entry.tool,
        action: entry.action,
        status: entry.status,
        timestamp,
        ...(entry.details ? { details: sanitizeDetails(entry.details) } : {}),
        ...(entry.error ? { error: entry.error } : {}),
      },
    });
  } catch {
    // Logging should never block tool execution.
  }
}

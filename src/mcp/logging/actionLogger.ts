/**
 * MCP Action Logger
 *
 * Records MCP tool activity into harness session traces instead of maintaining
 * a separate workflow-local actions.jsonl log.
 */

import * as fs from 'fs-extra';
import * as path from 'path';

import { HarnessRuntimeStateService } from '../../harness/adapters/out/runtimeState/runtimeStateService';
import { BoundedLruCache } from '../../harness/domain/retention/boundedLruCache';
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

const sessionCache = new BoundedLruCache<string, string>({
  maxEntries: 64,
  maxBytes: 64 * 1024,
  ttlMs: 30 * 60 * 1000,
  estimateBytes: (sessionId, repoPath) => Buffer.byteLength(sessionId) + Buffer.byteLength(repoPath),
});

function normalizeRepoPath(repoPath: string): string {
  return path.resolve(repoPath).toLowerCase();
}

export function clearMcpActionSessionCache(): void {
  sessionCache.dispose();
}

export function getMcpActionSessionCacheSize(): number {
  return sessionCache.size;
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
  const cacheKey = normalizeRepoPath(repoPath);
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

  const existing = (await state.listSessions()).find((session) =>
    session.name === MCP_ACTIVITY_NAME &&
    session.metadata?.transport === 'mcp'
  );

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

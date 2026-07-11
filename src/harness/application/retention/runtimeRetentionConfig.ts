import * as fs from 'fs-extra';
import * as path from 'path';

export interface RuntimeRetentionConfig {
  version: 1;
  traces: { maxBytes: number };
  sessions: { maxEntries: number };
  replays: { maxEntries: number };
  datasets: { maxEntries: number };
  checkpoints: { maxDataBytes: number; maxArtifactIds: number };
  bindings: { maxEntries: number; maxAgeMs: number };
  caches: {
    context: { maxEntries: number; maxBytes: number; ttlMs: number };
    semantic: { maxEntries: number; maxBytes: number };
    mcpSessions: { maxEntries: number; ttlMs: number };
    fileAnalysis: { maxEntries: number; maxBytes: number };
  };
}

export interface RuntimeRetentionConfigResult {
  config: RuntimeRetentionConfig;
  diagnostics: string[];
  clamps: number;
}

export const DEFAULT_RUNTIME_RETENTION_CONFIG: RuntimeRetentionConfig = {
  version: 1,
  traces: { maxBytes: 64 * 1024 * 1024 },
  sessions: { maxEntries: 1_000 },
  replays: { maxEntries: 100 },
  datasets: { maxEntries: 100 },
  checkpoints: { maxDataBytes: 64 * 1024, maxArtifactIds: 200 },
  bindings: { maxEntries: 1_000, maxAgeMs: 30 * 24 * 60 * 60 * 1000 },
  caches: {
    context: { maxEntries: 16, maxBytes: 32 * 1024 * 1024, ttlMs: 5 * 60 * 1000 },
    semantic: { maxEntries: 1, maxBytes: 64 * 1024 * 1024 },
    mcpSessions: { maxEntries: 64, ttlMs: 30 * 60 * 1000 },
    fileAnalysis: { maxEntries: 5_000, maxBytes: 128 * 1024 * 1024 },
  },
};

const KNOWN_TOP_LEVEL = new Set(['version', 'traces', 'sessions', 'replays', 'datasets', 'checkpoints', 'bindings', 'caches']);

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  absoluteMaximum: number,
  name: string,
  diagnostics: string[],
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    if (value !== undefined) diagnostics.push(`${name} was invalid and reset to ${fallback}`);
    return fallback;
  }
  if (value > absoluteMaximum) {
    diagnostics.push(`${name} was clamped to the absolute safety ceiling ${absoluteMaximum}`);
    return absoluteMaximum;
  }
  return Math.floor(value);
}

/** Load `.context/config/runtime.json`, ignoring unknown keys and clamping unsafe limits. */
export async function loadRuntimeRetentionConfig(repoPath: string): Promise<RuntimeRetentionConfigResult> {
  const diagnostics: string[] = [];
  const file = path.join(path.resolve(repoPath), '.context', 'config', 'runtime.json');
  let input: Record<string, any> = {};
  if (await fs.pathExists(file)) {
    try {
      const parsed = await fs.readJson(file);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
      else diagnostics.push('runtime.json root must be an object; defaults applied');
    } catch {
      diagnostics.push('runtime.json could not be parsed; defaults applied');
    }
  }
  for (const key of Object.keys(input)) {
    if (!KNOWN_TOP_LEVEL.has(key)) diagnostics.push(`Unknown runtime configuration key ignored: ${key}`);
  }
  const d = DEFAULT_RUNTIME_RETENTION_CONFIG;
  const number = (value: unknown, fallback: number, min: number, max: number, name: string) =>
    boundedNumber(value, fallback, min, max, name, diagnostics);
  const config: RuntimeRetentionConfig = {
    version: 1,
    traces: { maxBytes: number(input.traces?.maxBytes, d.traces.maxBytes, 1_024, 1024 ** 3, 'traces.maxBytes') },
    sessions: { maxEntries: number(input.sessions?.maxEntries, d.sessions.maxEntries, 1, 100_000, 'sessions.maxEntries') },
    replays: { maxEntries: number(input.replays?.maxEntries, d.replays.maxEntries, 1, 10_000, 'replays.maxEntries') },
    datasets: { maxEntries: number(input.datasets?.maxEntries, d.datasets.maxEntries, 1, 10_000, 'datasets.maxEntries') },
    checkpoints: {
      maxDataBytes: number(input.checkpoints?.maxDataBytes, d.checkpoints.maxDataBytes, 1_024, 1024 ** 2, 'checkpoints.maxDataBytes'),
      maxArtifactIds: number(input.checkpoints?.maxArtifactIds, d.checkpoints.maxArtifactIds, 1, 1_000, 'checkpoints.maxArtifactIds'),
    },
    bindings: {
      maxEntries: number(input.bindings?.maxEntries, d.bindings.maxEntries, 1, 10_000, 'bindings.maxEntries'),
      maxAgeMs: number(input.bindings?.maxAgeMs, d.bindings.maxAgeMs, 60_000, 365 * 24 * 60 * 60 * 1000, 'bindings.maxAgeMs'),
    },
    caches: {
      context: {
        maxEntries: number(input.caches?.context?.maxEntries, d.caches.context.maxEntries, 1, 256, 'caches.context.maxEntries'),
        maxBytes: number(input.caches?.context?.maxBytes, d.caches.context.maxBytes, 1_024, 256 * 1024 * 1024, 'caches.context.maxBytes'),
        ttlMs: number(input.caches?.context?.ttlMs, d.caches.context.ttlMs, 1_000, 24 * 60 * 60 * 1000, 'caches.context.ttlMs'),
      },
      semantic: {
        maxEntries: number(input.caches?.semantic?.maxEntries, d.caches.semantic.maxEntries, 1, 4, 'caches.semantic.maxEntries'),
        maxBytes: number(input.caches?.semantic?.maxBytes, d.caches.semantic.maxBytes, 1_024, 256 * 1024 * 1024, 'caches.semantic.maxBytes'),
      },
      mcpSessions: {
        maxEntries: number(input.caches?.mcpSessions?.maxEntries, d.caches.mcpSessions.maxEntries, 1, 1_000, 'caches.mcpSessions.maxEntries'),
        ttlMs: number(input.caches?.mcpSessions?.ttlMs, d.caches.mcpSessions.ttlMs, 1_000, 24 * 60 * 60 * 1000, 'caches.mcpSessions.ttlMs'),
      },
      fileAnalysis: {
        maxEntries: number(input.caches?.fileAnalysis?.maxEntries, d.caches.fileAnalysis.maxEntries, 1, 20_000, 'caches.fileAnalysis.maxEntries'),
        maxBytes: number(input.caches?.fileAnalysis?.maxBytes, d.caches.fileAnalysis.maxBytes, 1_024, 512 * 1024 * 1024, 'caches.fileAnalysis.maxBytes'),
      },
    },
  };
  return { config, diagnostics, clamps: diagnostics.length };
}

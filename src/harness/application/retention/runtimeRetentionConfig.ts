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
    context: { maxEntries: number; maxBytes: number; ttlMs: number; maxEntriesScanned: number };
    semantic: { maxEntries: number; maxBytes: number; maxEntriesScanned: number };
    mcpSessions: { maxEntries: number; ttlMs: number };
    fileAnalysis: { maxEntries: number; maxBytes: number };
  };
}

export interface RuntimeRetentionConfigMetrics {
  invalidVersion: number;
  unknownKeys: number;
  invalidValues: number;
  clampedValues: number;
  diagnosticsDropped: number;
}

export interface RuntimeRetentionConfigResult {
  config: RuntimeRetentionConfig;
  diagnostics: string[];
  clamps: number;
  metrics: RuntimeRetentionConfigMetrics;
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
    context: { maxEntries: 16, maxBytes: 32 * 1024 * 1024, ttlMs: 5 * 60 * 1000, maxEntriesScanned: 20_000 },
    semantic: { maxEntries: 1, maxBytes: 64 * 1024 * 1024, maxEntriesScanned: 100_000 },
    mcpSessions: { maxEntries: 64, ttlMs: 30 * 60 * 1000 },
    fileAnalysis: { maxEntries: 5_000, maxBytes: 128 * 1024 * 1024 },
  },
};

const MAX_DIAGNOSTICS = 32;
const KNOWN_KEYS: Record<string, readonly string[]> = {
  root: ['version', 'traces', 'sessions', 'replays', 'datasets', 'checkpoints', 'bindings', 'caches'],
  traces: ['maxBytes'],
  sessions: ['maxEntries'],
  replays: ['maxEntries'],
  datasets: ['maxEntries'],
  checkpoints: ['maxDataBytes', 'maxArtifactIds'],
  bindings: ['maxEntries', 'maxAgeMs'],
  caches: ['context', 'semantic', 'mcpSessions', 'fileAnalysis'],
  'caches.context': ['maxEntries', 'maxBytes', 'ttlMs', 'maxEntriesScanned'],
  'caches.semantic': ['maxEntries', 'maxBytes', 'maxEntriesScanned'],
  'caches.mcpSessions': ['maxEntries', 'ttlMs'],
  'caches.fileAnalysis': ['maxEntries', 'maxBytes'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeKey(key: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key)
    ? key
    : `<omitted:${Buffer.byteLength(key, 'utf8')} bytes>`;
}

function addDiagnostic(
  diagnostics: string[],
  metrics: RuntimeRetentionConfigMetrics,
  message: string,
): void {
  if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(message.slice(0, 200));
  else metrics.diagnosticsDropped += 1;
}

function diagnoseShape(
  value: unknown,
  section: string,
  diagnostics: string[],
  metrics: RuntimeRetentionConfigMetrics,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    metrics.invalidValues += 1;
    addDiagnostic(diagnostics, metrics, `${section} must be an object; defaults applied`);
    return {};
  }
  const known = new Set(KNOWN_KEYS[section] ?? []);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      metrics.unknownKeys += 1;
      addDiagnostic(diagnostics, metrics, `Unknown runtime configuration key ignored: ${section}.${safeKey(key)}`);
    }
  }
  return value;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  absoluteMaximum: number,
  name: string,
  diagnostics: string[],
  metrics: RuntimeRetentionConfigMetrics,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    if (value !== undefined) {
      metrics.invalidValues += 1;
      addDiagnostic(diagnostics, metrics, `${name} was invalid; safe default applied`);
    }
    return fallback;
  }
  if (value > absoluteMaximum) {
    metrics.clampedValues += 1;
    addDiagnostic(diagnostics, metrics, `${name} was clamped to the absolute safety ceiling ${absoluteMaximum}`);
    return absoluteMaximum;
  }
  return Math.floor(value);
}

/** Load a repository-scoped, versioned runtime policy without logging caller content. */
export async function loadRuntimeRetentionConfig(repoPath: string): Promise<RuntimeRetentionConfigResult> {
  const diagnostics: string[] = [];
  const metrics: RuntimeRetentionConfigMetrics = {
    invalidVersion: 0,
    unknownKeys: 0,
    invalidValues: 0,
    clampedValues: 0,
    diagnosticsDropped: 0,
  };
  const file = path.join(path.resolve(repoPath), '.context', 'config', 'runtime.json');
  let input: Record<string, unknown> = {};
  let fileExists = false;
  if (await fs.pathExists(file)) {
    fileExists = true;
    try {
      const parsed = await fs.readJson(file) as unknown;
      if (isRecord(parsed)) input = parsed;
      else {
        metrics.invalidValues += 1;
        addDiagnostic(diagnostics, metrics, 'runtime.json root must be an object; defaults applied');
      }
    } catch {
      metrics.invalidValues += 1;
      addDiagnostic(diagnostics, metrics, 'runtime.json could not be parsed; defaults applied');
    }
  }

  diagnoseShape(input, 'root', diagnostics, metrics);
  if (fileExists && input.version !== 1) {
    metrics.invalidVersion += 1;
    addDiagnostic(diagnostics, metrics, 'runtime.json version is unsupported; safe defaults applied');
    return {
      config: structuredClone(DEFAULT_RUNTIME_RETENTION_CONFIG),
      diagnostics,
      clamps: metrics.invalidValues + metrics.clampedValues,
      metrics,
    };
  }

  const traces = diagnoseShape(input.traces, 'traces', diagnostics, metrics);
  const sessions = diagnoseShape(input.sessions, 'sessions', diagnostics, metrics);
  const replays = diagnoseShape(input.replays, 'replays', diagnostics, metrics);
  const datasets = diagnoseShape(input.datasets, 'datasets', diagnostics, metrics);
  const checkpoints = diagnoseShape(input.checkpoints, 'checkpoints', diagnostics, metrics);
  const bindings = diagnoseShape(input.bindings, 'bindings', diagnostics, metrics);
  const caches = diagnoseShape(input.caches, 'caches', diagnostics, metrics);
  const context = diagnoseShape(caches.context, 'caches.context', diagnostics, metrics);
  const semantic = diagnoseShape(caches.semantic, 'caches.semantic', diagnostics, metrics);
  const mcpSessions = diagnoseShape(caches.mcpSessions, 'caches.mcpSessions', diagnostics, metrics);
  const fileAnalysis = diagnoseShape(caches.fileAnalysis, 'caches.fileAnalysis', diagnostics, metrics);
  const d = DEFAULT_RUNTIME_RETENTION_CONFIG;
  const number = (value: unknown, fallback: number, min: number, max: number, name: string) =>
    boundedNumber(value, fallback, min, max, name, diagnostics, metrics);
  const config: RuntimeRetentionConfig = {
    version: 1,
    traces: { maxBytes: number(traces.maxBytes, d.traces.maxBytes, 1_024, 1024 ** 3, 'traces.maxBytes') },
    sessions: { maxEntries: number(sessions.maxEntries, d.sessions.maxEntries, 1, 100_000, 'sessions.maxEntries') },
    replays: { maxEntries: number(replays.maxEntries, d.replays.maxEntries, 1, 10_000, 'replays.maxEntries') },
    datasets: { maxEntries: number(datasets.maxEntries, d.datasets.maxEntries, 1, 10_000, 'datasets.maxEntries') },
    checkpoints: {
      maxDataBytes: number(checkpoints.maxDataBytes, d.checkpoints.maxDataBytes, 1_024, 1024 ** 2, 'checkpoints.maxDataBytes'),
      maxArtifactIds: number(checkpoints.maxArtifactIds, d.checkpoints.maxArtifactIds, 1, 1_000, 'checkpoints.maxArtifactIds'),
    },
    bindings: {
      maxEntries: number(bindings.maxEntries, d.bindings.maxEntries, 1, 10_000, 'bindings.maxEntries'),
      maxAgeMs: number(bindings.maxAgeMs, d.bindings.maxAgeMs, 60_000, 365 * 24 * 60 * 60 * 1000, 'bindings.maxAgeMs'),
    },
    caches: {
      context: {
        maxEntries: number(context.maxEntries, d.caches.context.maxEntries, 1, 256, 'caches.context.maxEntries'),
        maxBytes: number(context.maxBytes, d.caches.context.maxBytes, 1_024, 256 * 1024 * 1024, 'caches.context.maxBytes'),
        ttlMs: number(context.ttlMs, d.caches.context.ttlMs, 1_000, 24 * 60 * 60 * 1000, 'caches.context.ttlMs'),
        maxEntriesScanned: number(context.maxEntriesScanned, d.caches.context.maxEntriesScanned, 1, 1_000_000, 'caches.context.maxEntriesScanned'),
      },
      semantic: {
        maxEntries: number(semantic.maxEntries, d.caches.semantic.maxEntries, 1, 4, 'caches.semantic.maxEntries'),
        maxBytes: number(semantic.maxBytes, d.caches.semantic.maxBytes, 1_024, 256 * 1024 * 1024, 'caches.semantic.maxBytes'),
        maxEntriesScanned: number(semantic.maxEntriesScanned, d.caches.semantic.maxEntriesScanned, 1, 1_000_000, 'caches.semantic.maxEntriesScanned'),
      },
      mcpSessions: {
        maxEntries: number(mcpSessions.maxEntries, d.caches.mcpSessions.maxEntries, 1, 1_000, 'caches.mcpSessions.maxEntries'),
        ttlMs: number(mcpSessions.ttlMs, d.caches.mcpSessions.ttlMs, 1_000, 24 * 60 * 60 * 1000, 'caches.mcpSessions.ttlMs'),
      },
      fileAnalysis: {
        maxEntries: number(fileAnalysis.maxEntries, d.caches.fileAnalysis.maxEntries, 1, 20_000, 'caches.fileAnalysis.maxEntries'),
        maxBytes: number(fileAnalysis.maxBytes, d.caches.fileAnalysis.maxBytes, 1_024, 512 * 1024 * 1024, 'caches.fileAnalysis.maxBytes'),
      },
    },
  };
  return { config, diagnostics, clamps: metrics.invalidValues + metrics.clampedValues, metrics };
}

import * as fs from 'fs-extra';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { resolveRuntimeLayoutFromRepo } from '../../../shared/fs/pathHelpers';
import type { HarnessSessionRecord } from '../../adapters/out/runtimeState/runtimeStateService';

export interface RuntimePruneReport {
  dryRun: boolean;
  candidates: Array<{ path: string; kind: 'session' | 'replay' | 'dataset'; bytes: number; reason: string }>;
  protectedSessionIds: string[];
  pruneBytes: number;
  runtimeBytes: number;
  durationMs: number;
}

export interface RuntimePruneOptions {
  dryRun?: boolean;
  now?: Date;
  sessionRetentionDays?: number;
  replayRetentionDays?: number;
  datasetRetentionDays?: number;
  replayLimitPerSession?: number;
  datasetLimit?: number;
  quotaBytes?: number;
}

async function fileBytes(target: string): Promise<number> {
  const stat = await fs.stat(target);
  if (stat.isFile()) return stat.size;
  let total = 0;
  const directory = await fs.opendir(target);
  for await (const entry of directory) total += await fileBytes(path.join(target, entry.name));
  return total;
}

export class HarnessRuntimeRetentionService {
  constructor(private readonly repoPath: string) {}

  async prune(options: RuntimePruneOptions = {}): Promise<RuntimePruneReport> {
    const started = Date.now();
    const layout = resolveRuntimeLayoutFromRepo(this.repoPath);
    const now = (options.now ?? new Date()).getTime();
    const activeBinding = await fs.readJson(layout.prevcFile)
      .then(value => typeof value?.binding?.sessionId === 'string' ? value.binding.sessionId as string : undefined)
      .catch(() => undefined);
    const protectedSessionIds = new Set<string>(activeBinding ? [activeBinding] : []);
    const candidates: RuntimePruneReport['candidates'] = [];

    if (await fs.pathExists(layout.sessionsDir)) {
      const directory = await fs.opendir(layout.sessionsDir);
      for await (const entry of directory) {
        if (!entry.isDirectory() || entry.name.startsWith('.prune-')) continue;
        const target = layout.sessionDir(entry.name);
        try {
          const session = await fs.readJson(layout.sessionFile(entry.name)) as HarnessSessionRecord;
          if (session.status === 'active' || session.status === 'paused' || protectedSessionIds.has(session.id)) {
            protectedSessionIds.add(session.id);
            continue;
          }
          const cutoff = (options.sessionRetentionDays ?? 30) * 86_400_000;
          if (now - new Date(session.updatedAt).getTime() > cutoff) {
            candidates.push({ path: target, kind: 'session', bytes: await fileBytes(target), reason: 'age' });
          }
        } catch { /* corrupt state is retained for manual recovery */ }
      }
    }

    const collectEvaluations = async (dir: string, kind: 'replay' | 'dataset', days: number, keep: number) => {
      if (!(await fs.pathExists(dir))) return;
      const records: Array<{ path: string; createdAt: string; sessionId?: string; bytes: number }> = [];
      const directory = await fs.opendir(dir);
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const target = path.join(dir, entry.name);
        try {
          const value = await fs.readJson(target) as { createdAt: string; sessionId?: string };
          records.push({ path: target, createdAt: value.createdAt, sessionId: value.sessionId, bytes: (await fs.stat(target)).size });
        } catch { /* retain malformed files */ }
      }
      records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const counts = new Map<string, number>();
      for (const record of records) {
        const group = kind === 'replay' ? record.sessionId ?? 'unknown' : 'datasets';
        const position = (counts.get(group) ?? 0) + 1;
        counts.set(group, position);
        const expired = now - new Date(record.createdAt).getTime() > days * 86_400_000;
        if (expired || position > keep) candidates.push({ path: record.path, kind, bytes: record.bytes, reason: expired ? 'age' : 'count' });
      }
    };
    await collectEvaluations(layout.replaysDir, 'replay', options.replayRetentionDays ?? 30, options.replayLimitPerSession ?? 10);
    await collectEvaluations(layout.datasetsDir, 'dataset', options.datasetRetentionDays ?? 30, options.datasetLimit ?? 20);

    const runtimeBytes = await fs.pathExists(layout.runtimeDir) ? await fileBytes(layout.runtimeDir) : 0;
    const quota = options.quotaBytes ?? 256 * 1024 * 1024;
    if (runtimeBytes > quota) {
      const already = new Set(candidates.map(item => item.path));
      const eligible: Array<{ path: string; kind: 'session' | 'replay' | 'dataset'; bytes: number; mtime: number }> = [];
      for (const dir of [layout.replaysDir, layout.datasetsDir]) {
        if (!(await fs.pathExists(dir))) continue;
        for (const name of await fs.readdir(dir)) {
          const target = path.join(dir, name);
          if (already.has(target) || !name.endsWith('.json')) continue;
          const stat = await fs.stat(target);
          eligible.push({ path: target, kind: dir === layout.replaysDir ? 'replay' : 'dataset', bytes: stat.size, mtime: stat.mtimeMs });
        }
      }
      eligible.sort((a, b) => a.mtime - b.mtime);
      let projected = runtimeBytes - candidates.reduce((sum, item) => sum + item.bytes, 0);
      for (const item of eligible) {
        if (projected <= quota) break;
        candidates.push({ path: item.path, kind: item.kind, bytes: item.bytes, reason: 'quota' });
        projected -= item.bytes;
      }
    }

    if (options.dryRun === false) {
      for (const candidate of candidates) {
        if (!(await fs.pathExists(candidate.path))) continue;
        const tombstone = path.join(path.dirname(candidate.path), `.prune-${randomUUID()}-${path.basename(candidate.path)}`);
        await fs.rename(candidate.path, tombstone);
        await fs.remove(tombstone);
      }
    }
    return { dryRun: options.dryRun !== false, candidates, protectedSessionIds: [...protectedSessionIds], pruneBytes: candidates.reduce((sum, item) => sum + item.bytes, 0), runtimeBytes, durationMs: Date.now() - started };
  }
}

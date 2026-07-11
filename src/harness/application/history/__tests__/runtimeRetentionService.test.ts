import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { HarnessRuntimeStateService } from '../../../adapters/out/runtimeState/runtimeStateService';
import { HarnessRuntimeRetentionService } from '../runtimeRetentionService';

describe('HarnessRuntimeRetentionService', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-retention-')); });
  afterEach(async () => { await fs.remove(tempDir); });

  it('reports dry-run bytes and never prunes active or workflow-bound sessions', async () => {
    const state = new HarnessRuntimeStateService({ repoPath: tempDir });
    const active = await state.createSession({ name: 'active' });
    const bound = await state.createSession({ name: 'bound' });
    await state.completeSession(bound.id);
    const old = '2020-01-01T00:00:00.000Z';
    const boundFile = path.join(tempDir, '.context', 'runtime', 'sessions', bound.id, 'session.json');
    await fs.writeJson(boundFile, { ...await fs.readJson(boundFile), updatedAt: old });
    await fs.outputJson(path.join(tempDir, '.context', 'runtime', 'workflows', 'prevc.json'), { binding: { sessionId: bound.id } });
    const expired = await state.createSession({ name: 'expired' });
    await state.completeSession(expired.id);
    const expiredFile = path.join(tempDir, '.context', 'runtime', 'sessions', expired.id, 'session.json');
    await fs.writeJson(expiredFile, { ...await fs.readJson(expiredFile), updatedAt: old });

    const retention = new HarnessRuntimeRetentionService(tempDir);
    const report = await retention.prune({ dryRun: true, now: new Date('2026-01-01T00:00:00.000Z') });
    expect(report.candidates.map(item => item.path)).toContain(path.dirname(expiredFile));
    expect(report.candidates.map(item => item.path)).not.toContain(path.dirname(boundFile));
    expect(report.protectedSessionIds).toEqual(expect.arrayContaining([active.id, bound.id]));
    expect(report.pruneBytes).toBeGreaterThan(0);
    expect(await fs.pathExists(expiredFile)).toBe(true);

    await retention.prune({ dryRun: false, now: new Date('2026-01-01T00:00:00.000Z') });
    expect(await fs.pathExists(expiredFile)).toBe(false);
    expect(await fs.pathExists(boundFile)).toBe(true);
  });
});

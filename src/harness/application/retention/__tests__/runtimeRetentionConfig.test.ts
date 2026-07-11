import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { loadRuntimeRetentionConfig } from '../runtimeRetentionConfig';

describe('loadRuntimeRetentionConfig', () => {
  it('ignores unknown keys and clamps values that could disable safety ceilings', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-retention-'));
    await fs.outputJson(path.join(repo, '.context', 'config', 'runtime.json'), {
      version: 1,
      unknown: true,
      bindings: { maxEntries: Number.MAX_SAFE_INTEGER },
      checkpoints: { maxDataBytes: 0, maxArtifactIds: -1 },
    });
    const result = await loadRuntimeRetentionConfig(repo);
    expect(result.config.bindings.maxEntries).toBe(10_000);
    expect(result.config.checkpoints.maxDataBytes).toBe(64 * 1024);
    expect(result.config.checkpoints.maxArtifactIds).toBe(200);
    expect(result.diagnostics.some(item => item.includes('Unknown'))).toBe(true);
    expect(result.clamps).toBeGreaterThan(0);
    await fs.remove(repo);
  });
});

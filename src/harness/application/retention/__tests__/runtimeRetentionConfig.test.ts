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

  it('diagnoses invalid versions and nested unknown keys without exposing key content', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-retention-version-'));
    const secretKey = `secret-config-${'private'.repeat(100)}`;
    await fs.outputJson(path.join(repo, '.context', 'config', 'runtime.json'), {
      version: 1,
      caches: {
        context: { maxEntries: 2, unknownNested: true, [secretKey]: 'never-log-this-value' },
        unknownCache: { body: 'never-log-this-value' },
      },
    });
    const nested = await loadRuntimeRetentionConfig(repo);
    expect(nested.config.caches.context.maxEntries).toBe(2);
    expect(nested.metrics.unknownKeys).toBe(3);
    expect(nested.diagnostics.join('\n')).toContain('caches.context.unknownNested');
    expect(nested.diagnostics.join('\n')).not.toContain('privateprivate');
    expect(nested.diagnostics.join('\n')).not.toContain('never-log-this-value');
    expect(nested.diagnostics.every(item => item.length <= 200)).toBe(true);

    await fs.outputJson(path.join(repo, '.context', 'config', 'runtime.json'), {
      version: 999,
      caches: { context: { maxEntries: 1 } },
    });
    const invalidVersion = await loadRuntimeRetentionConfig(repo);
    expect(invalidVersion.metrics.invalidVersion).toBe(1);
    expect(invalidVersion.config.caches.context.maxEntries).toBe(16);
    expect(invalidVersion.diagnostics).toContain('runtime.json version is unsupported; safe defaults applied');
    await fs.remove(repo);
  });
});

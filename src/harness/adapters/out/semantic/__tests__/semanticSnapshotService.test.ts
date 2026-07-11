import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FileMapper } from '../../../../../utils/fileMapper';
import {
  RepositoryChangingError,
  SemanticFingerprintCache,
  SemanticSnapshotService,
} from '../semanticSnapshotService';

describe('SemanticSnapshotService', () => {
  let tempDir: string;
  let repoPath: string;
  let outputDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dotcontext-semantic-snapshot-'));
    repoPath = path.join(tempDir, 'repo');
    outputDir = path.join(repoPath, '.context');

    await fs.ensureDir(path.join(repoPath, 'src'));
    await fs.writeJson(path.join(repoPath, 'package.json'), {
      name: 'snapshot-test',
      version: '1.0.0',
      main: 'dist/index.js',
      types: 'dist/index.d.ts',
    }, { spaces: 2 });
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const run = () => true;\n', 'utf-8');
    await fs.writeFile(path.join(repoPath, 'src', 'auth.ts'), 'export const login = () => "ok";\n', 'utf-8');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(tempDir);
  });

  it('writes a symbol-free semantic snapshot and current summary into the semantic cache', async () => {
    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();
    await fs.ensureDir(path.join(outputDir, 'docs'));
    await fs.writeJson(path.join(outputDir, 'docs', 'codebase-map.json'), { legacy: true }, { spaces: 2 });

    const result = await service.writeSnapshot(repoStructure, { outputDir });
    const manifestPath = path.join(outputDir, 'cache', 'semantic', 'manifest.json');
    const manifest = await fs.readJson(manifestPath);

    expect(result.summary.functionalPatterns.hasAuthPattern).toBe(true);
    expect(result.summary).not.toHaveProperty('symbols');
    expect(result.summary).not.toHaveProperty('publicAPI');

    const snapshotDir = path.join(outputDir, 'cache', 'semantic');
    expect(await fs.pathExists(manifestPath)).toBe(true);
    expect(await fs.pathExists(path.join(snapshotDir, 'summary.json'))).toBe(true);
    expect(await fs.pathExists(path.join(snapshotDir, manifest.sections.functionalPatterns))).toBe(true);
    expect(await fs.pathExists(path.join(snapshotDir, manifest.sections.summary))).toBe(true);
    expect(await fs.pathExists(path.join(outputDir, 'docs', 'codebase-map.json'))).toBe(false);
    expect(manifest.publishedSummary).toBe(path.posix.join('cache', 'semantic', 'summary.json'));

    const publishedSummary = await fs.readJson(path.join(snapshotDir, 'summary.json'));
    expect(publishedSummary).not.toHaveProperty('symbols');
    expect(publishedSummary).not.toHaveProperty('publicAPI');
    expect(publishedSummary.meta.analyzer.includesSymbolPayload).toBe(false);
  });

  it('auto-builds a missing snapshot on demand', async () => {
    const service = new SemanticSnapshotService();

    const result = await service.ensureFreshSummary(repoPath, { outputDir });

    expect(result.refreshed).toBe(true);
    expect(result.refreshReason).toBe('missing');
    expect(result.fresh).toBe(true);
    expect(result.summary.functionalPatterns.hasAuthPattern).toBe(true);
    expect(await fs.pathExists(path.join(outputDir, 'cache', 'semantic', 'manifest.json'))).toBe(true);
  });

  it('invalidates the snapshot when hidden config files change', async () => {
    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();

    await fs.ensureDir(path.join(repoPath, '.github', 'workflows'));
    await fs.writeFile(path.join(repoPath, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf-8');

    await service.writeSnapshot(repoStructure, { outputDir });
    const before = await service.readSummary(repoPath, { allowStale: false });
    expect(before).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(repoPath, '.github', 'workflows', 'ci.yml'), 'name: changed\n', 'utf-8');

    const after = await service.readSummary(repoPath, { allowStale: false });
    expect(after).toBeNull();
  });

  it('invalidates the snapshot when file contents change without size or mtime changes', async () => {
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const run = () => 1;\n', 'utf-8');

    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();

    await service.writeSnapshot(repoStructure, { outputDir });
    const targetPath = path.join(repoPath, 'src', 'index.ts');
    const originalStats = await fs.stat(targetPath);

    await fs.writeFile(targetPath, 'export const run = () => 2;\n', 'utf-8');
    await fs.utimes(targetPath, originalStats.atime, originalStats.mtime);

    const stale = await service.readSummary(repoPath, { outputDir, allowStale: false });
    expect(stale).toBeNull();
  });

  it('reuses cached content hashes when file metadata is unchanged', async () => {
    const service = new SemanticSnapshotService(true);

    const initial = await service.captureRepoFingerprintWithMetrics(repoPath);
    const repeated = await service.captureRepoFingerprintWithMetrics(repoPath);

    expect(repeated.fingerprint).toBe(initial.fingerprint);
    expect(initial.bytesRead).toBeGreaterThan(0);
    expect(repeated.bytesRead).toBe(0);
    expect(repeated.cacheHits).toBe(repeated.files);
  });

  it('reuses bounded content hashes across short-lived service operations', async () => {
    const cache = new SemanticFingerprintCache(100, 60_000);
    const mapper = new FileMapper();
    const firstDiscovery = await mapper.mapRepository(repoPath);
    const initial = await new SemanticSnapshotService(true, cache)
      .captureRepoFingerprintWithMetrics(repoPath, firstDiscovery);

    const secondDiscovery = await mapper.mapRepository(repoPath);
    const repeated = await new SemanticSnapshotService(true, cache)
      .captureRepoFingerprintWithMetrics(repoPath, secondDiscovery);

    expect(initial.discoveries).toBe(0);
    expect(initial.contentReads).toBe(initial.files);
    expect(repeated.fingerprint).toBe(initial.fingerprint);
    expect(repeated.discoveries).toBe(0);
    expect(repeated.contentReads).toBe(0);
    expect(repeated.bytesRead).toBe(0);
    expect(repeated.cacheHits).toBe(repeated.files);
    expect(cache.size).toBe(repeated.files);
  });

  it('produces the same fingerprint from shared discovery and fallback discovery', async () => {
    const mapper = new FileMapper();
    const discovery = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();

    const shared = await service.captureRepoFingerprintWithMetrics(repoPath, discovery);
    const fallback = await service.captureRepoFingerprintWithMetrics(repoPath);

    expect(shared.discoveries).toBe(0);
    expect(fallback.discoveries).toBe(1);
    expect(fallback.fingerprint).toBe(shared.fingerprint);
  });

  it('keeps shared hashes correct for dirty, new, and deleted files', async () => {
    const cache = new SemanticFingerprintCache(100, 60_000);
    const mapper = new FileMapper();
    const capture = async () => new SemanticSnapshotService(true, cache)
      .captureRepoFingerprintWithMetrics(repoPath, await mapper.mapRepository(repoPath));

    const initial = await capture();
    const targetPath = path.join(repoPath, 'src', 'index.ts');
    const targetStats = await fs.stat(targetPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(targetPath, 'export const run = () => fals;\n', 'utf-8');
    await fs.utimes(targetPath, targetStats.atime, targetStats.mtime);
    const dirty = await capture();
    expect(dirty.fingerprint).not.toBe(initial.fingerprint);
    expect(dirty.contentReads).toBe(1);

    await fs.writeFile(path.join(repoPath, 'src', 'new.ts'), 'export const added = true;\n');
    const withNewFile = await capture();
    expect(withNewFile.fingerprint).not.toBe(dirty.fingerprint);
    expect(withNewFile.contentReads).toBe(1);

    await fs.remove(path.join(repoPath, 'src', 'auth.ts'));
    const withDeletedFile = await capture();
    expect(withDeletedFile.fingerprint).not.toBe(withNewFile.fingerprint);
    expect(withDeletedFile.contentReads).toBe(0);
    expect(withDeletedFile.cacheHits).toBe(withDeletedFile.files);
    expect(cache.size).toBe(withDeletedFile.files);
  });

  it('does not use or populate an injected cache when caching is disabled', async () => {
    const cache = new SemanticFingerprintCache(100, 60_000);
    const mapper = new FileMapper();
    const discovery = await mapper.mapRepository(repoPath);
    const first = await new SemanticSnapshotService(false, cache)
      .captureRepoFingerprintWithMetrics(repoPath, discovery);
    const repeated = await new SemanticSnapshotService(false, cache)
      .captureRepoFingerprintWithMetrics(repoPath, discovery);

    expect(first.contentReads).toBe(first.files);
    expect(repeated.contentReads).toBe(repeated.files);
    expect(repeated.cacheHits).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('stats but never opens an oversized sparse source file', async () => {
    const hugePath = path.join(repoPath, 'src', 'huge.ts');
    const handle = await nativeFs.open(hugePath, 'w');
    await handle.truncate(3 * 1024 * 1024);
    await handle.close();
    const discovery = await new FileMapper().mapRepository(repoPath);
    expect(discovery.files.some((file) => file.path === hugePath)).toBe(false);
    expect(discovery.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: hugePath, reason: 'file-too-large' }),
    ]));

    // Defense in depth: even a caller-provided discovery containing the huge
    // record is checked before the content stream is opened.
    const stats = await fs.stat(hugePath);
    discovery.files.push({
      path: hugePath,
      relativePath: 'src/huge.ts',
      extension: '.ts',
      size: stats.size,
      type: 'file',
    });
    const open = jest.spyOn(nativeFs, 'open');
    const result = await new SemanticSnapshotService()
      .captureRepoFingerprintWithMetrics(repoPath, discovery);

    expect(open.mock.calls.some(([file]) => file === hugePath)).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: hugePath, reason: 'file-too-large' }),
    ]));
  });

  it('stops fingerprint content reads at the aggregate byte budget', async () => {
    await fs.remove(path.join(repoPath, 'package.json'));
    await fs.remove(path.join(repoPath, 'src', 'auth.ts'));
    await fs.writeFile(path.join(repoPath, 'src', 'a.ts'), '123456');
    await fs.writeFile(path.join(repoPath, 'src', 'b.ts'), '123456');
    await fs.remove(path.join(repoPath, 'src', 'index.ts'));
    const discovery = await new FileMapper().mapRepository(repoPath);
    const result = await new SemanticSnapshotService(
      true,
      new SemanticFingerprintCache(),
      { maxTotalBytes: 10, maxFileBytes: 100 }
    ).captureRepoFingerprintWithMetrics(repoPath, discovery);

    expect(result.contentReads).toBe(1);
    expect(result.bytesRead).toBe(6);
    expect(result.partial).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'total-byte-limit' }),
    ]));
  });

  it('bounds shared cache entries, expires them, and supports explicit disposal', () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const cache = new SemanticFingerprintCache(2, 10);
    const cachePrefix = path.resolve(repoPath).toLowerCase();
    try {
      cache.set(`${cachePrefix}\0a.ts`, 'm1', 'h1');
      cache.set(`${cachePrefix}\0b.ts`, 'm2', 'h2');
      cache.set(`${cachePrefix}\0c.ts`, 'm3', 'h3');
      expect(cache.size).toBe(2);

      now += 11;
      expect(cache.get(`${cachePrefix}\0c.ts`, 'm3')).toBeUndefined();
      cache.dispose(repoPath);
      expect(cache.size).toBe(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('honors disabled fingerprint caching', async () => {
    const service = new SemanticSnapshotService(false);

    const initial = await service.captureRepoFingerprintWithMetrics(repoPath);
    const repeated = await service.captureRepoFingerprintWithMetrics(repoPath);

    expect(repeated.fingerprint).toBe(initial.fingerprint);
    expect(repeated.bytesRead).toBeGreaterThan(0);
    expect(repeated.cacheHits).toBe(0);
  });

  it('auto-refreshes a stale snapshot on demand', async () => {
    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();

    const initial = await service.writeSnapshot(repoStructure, { outputDir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const run = () => false;\n', 'utf-8');

    const refreshed = await service.ensureFreshSummary(repoPath, { outputDir });

    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.refreshReason).toBe('stale');
    expect(refreshed.fresh).toBe(true);
    expect(refreshed.manifest?.repoFingerprint).not.toBe(initial.manifest.repoFingerprint);
  });

  it('deduplicates concurrent refreshes for the same repo', async () => {
    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();
    await service.writeSnapshot(repoStructure, { outputDir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const run = () => false;\n', 'utf-8');

    const originalBuildSnapshotArtifacts = (service as any).buildSnapshotArtifacts.bind(service);
    const buildSpy = jest.spyOn(service as any, 'buildSnapshotArtifacts').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return originalBuildSnapshotArtifacts(...args);
    });

    const [first, second] = await Promise.all([
      service.ensureFreshSummary(repoPath, { outputDir }),
      service.ensureFreshSummary(repoPath, { outputDir }),
    ]);

    expect(buildSpy).toHaveBeenCalledTimes(1);
    expect(first.refreshReason).toBe('stale');
    expect(second.refreshReason).toBe('stale');
    expect(first.manifest?.repoFingerprint).toBe(second.manifest?.repoFingerprint);
  });

  it('retries refresh until the repo state is stable', async () => {
    await fs.remove(path.join(repoPath, 'src', 'auth.ts'));

    const service = new SemanticSnapshotService();
    let mutationInjected = false;
    const originalBuildSnapshotArtifacts = (service as any).buildSnapshotArtifacts.bind(service);
    const buildSpy = jest.spyOn(service as any, 'buildSnapshotArtifacts').mockImplementation(async (...args) => {
      if (!mutationInjected) {
        mutationInjected = true;
        await fs.writeFile(path.join(repoPath, 'src', 'auth.ts'), 'export const login = () => "ok";\n', 'utf-8');
      }

      return originalBuildSnapshotArtifacts(...args);
    });

    const refreshed = await service.ensureFreshSummary(repoPath, { outputDir });

    expect(buildSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.summary.functionalPatterns.hasAuthPattern).toBe(true);
    expect(refreshed.refreshReason).toBe('missing');
  });

  it('keeps the previous snapshot readable until the new manifest is promoted', async () => {
    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();
    const reader = new SemanticSnapshotService();

    const initial = await service.writeSnapshot(repoStructure, { outputDir });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const run = () => false;\n', 'utf-8');

    let observedDuringPublish: { manifest?: { generatedAt?: string } } | null = null;
    const originalPromoteFile = (service as any).promoteFile.bind(service);
    jest.spyOn(service as any, 'promoteFile').mockImplementation(async (...args: unknown[]) => {
      const [sourcePath, targetPath] = args as [string, string];
      if (targetPath === path.join(outputDir, 'cache', 'semantic', 'manifest.json')) {
        observedDuringPublish = await reader.readSummary(repoPath, { outputDir, allowStale: true });
      }

      return originalPromoteFile(sourcePath, targetPath);
    });

    await service.ensureFreshSummary(repoPath, { outputDir });

    expect(observedDuringPublish).not.toBeNull();
    const observedGeneratedAt =
      (observedDuringPublish as { manifest?: { generatedAt?: string } } | null)?.manifest?.generatedAt ?? null;
    expect(observedGeneratedAt).toBe(initial.manifest.generatedAt);
  });

  it('stops after two unstable attempts with a typed error and retains the previous snapshot', async () => {
    const mapper = new FileMapper();
    const repoStructure = await mapper.mapRepository(repoPath);
    const service = new SemanticSnapshotService();
    const initial = await service.writeSnapshot(repoStructure, { outputDir });
    await fs.writeFile(path.join(repoPath, 'src', 'index.ts'), 'export const run = () => false;\n');

    let mutation = 0;
    const originalBuild = (service as any).buildSnapshotArtifacts.bind(service);
    const buildSpy = jest.spyOn(service as any, 'buildSnapshotArtifacts').mockImplementation(async (...args) => {
      const artifacts = await originalBuild(...args);
      mutation += 1;
      await fs.writeFile(
        path.join(repoPath, 'src', 'auth.ts'),
        `export const login = () => ${mutation};\n`
      );
      return artifacts;
    });

    await expect(service.ensureFreshSummary(repoPath, { outputDir }))
      .rejects.toBeInstanceOf(RepositoryChangingError);
    expect(buildSpy).toHaveBeenCalledTimes(2);

    const retained = await new SemanticSnapshotService().readSummary(repoPath, {
      outputDir,
      allowStale: true,
    });
    expect(retained?.manifest?.generatedAt).toBe(initial.manifest.generatedAt);
  });

  it('does not load a legacy docs/codebase-map.json without a snapshot manifest', async () => {
    const service = new SemanticSnapshotService();
    await fs.ensureDir(path.join(outputDir, 'docs'));
    await fs.writeJson(path.join(outputDir, 'docs', 'codebase-map.json'), {
      version: '1.0.0',
      generated: new Date().toISOString(),
    }, { spaces: 2 });

    const result = await service.readSummary(repoPath, { allowStale: true });
    expect(result).toBeNull();
  });
});

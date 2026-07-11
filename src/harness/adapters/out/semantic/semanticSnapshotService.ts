import { createHash } from 'crypto';
import { promises as nativeFs } from 'fs';
import * as fs from 'fs-extra';
import * as path from 'path';

import { RepoStructure, type RepoDiscoverySkip } from '../../../../types';
import { CodebaseMapGenerator } from '../../../application/context/scaffolding/generators/documentation/codebaseMapGenerator';
import type {
  CodebaseMap,
  SemanticSnapshotMetadata,
} from '../../../application/context/scaffolding/generators/documentation/codebaseMapGenerator';
import {
  DEFAULT_FILE_MAPPING_LIMITS,
  FileMapper,
  type FileMappingLimits,
} from '../../../../utils/fileMapper';
import { CodebaseAnalyzer } from './codebaseAnalyzer';
import type { AnalyzerOptions, DetectedFunctionalPatterns, SemanticContext } from './types';
import { StackDetector } from '../../../application/context/intelligence/stack/stackDetector';
import type { StackInfo } from '../../../application/context/intelligence/stack/stackDetector';

export type SemanticSnapshotSection =
  | 'all'
  | 'meta'
  | 'stack'
  | 'structure'
  | 'architecture'
  | 'functionalPatterns'
  | 'dependencies'
  | 'stats'
  | 'keyFiles'
  | 'navigation';

type SnapshotFileSection = Exclude<SemanticSnapshotSection, 'all' | 'meta'>;

export interface SemanticSnapshotManifest extends SemanticSnapshotMetadata {
  sections: Record<SnapshotFileSection | 'summary', string>;
  publishedSummary: string;
}

export interface SemanticSnapshotWriteOptions {
  outputDir?: string;
  semantics?: SemanticContext;
  stackInfo?: StackInfo;
  functionalPatterns?: DetectedFunctionalPatterns;
  analyzerOptions?: AnalyzerOptions;
  repoFingerprint?: string;
}

export interface SemanticSnapshotWriteResult {
  summary: CodebaseMap;
  manifest: SemanticSnapshotManifest;
  snapshotDir: string;
  publishedSummaryPath: string;
  metrics: {
    generationMs: number;
    publicationMs: number;
    stabilizationAttempts: number;
  };
}

export interface SemanticSnapshotReadOptions {
  outputDir?: string;
  allowStale?: boolean;
}

export interface SemanticSnapshotSectionResult {
  data: unknown;
  fresh: boolean;
  source: 'snapshot';
  path: string;
  manifest?: SemanticSnapshotManifest;
}

export type SemanticSnapshotRefreshReason = 'fresh' | 'stale' | 'missing';

export interface SemanticSnapshotEnsureSummaryResult {
  summary: CodebaseMap;
  fresh: true;
  source: 'snapshot';
  path: string;
  manifest?: SemanticSnapshotManifest;
  refreshed: boolean;
  refreshReason: SemanticSnapshotRefreshReason;
}

export interface SemanticSnapshotEnsureSectionResult extends SemanticSnapshotSectionResult {
  fresh: true;
  refreshed: boolean;
  refreshReason: SemanticSnapshotRefreshReason;
}

interface SnapshotArtifacts {
  summary: CodebaseMap;
  manifest: SemanticSnapshotManifest;
}

const SNAPSHOT_SCHEMA_VERSION = '2.0.0';
const SNAPSHOT_DIRNAME = path.join('cache', 'semantic');
const MANIFEST_FILENAME = 'manifest.json';
const SUMMARY_FILENAME = 'summary.json';
const VERSIONS_DIRNAME = 'versions';
const MAX_REFRESH_ATTEMPTS = 2;
const MAX_VERSION_HISTORY = 3;
const MAX_FINGERPRINT_CACHE_ENTRIES = 10_000;
const DEFAULT_FINGERPRINT_CACHE_TTL_MS = 5 * 60_000;

const SECTION_FILENAMES: Record<SnapshotFileSection, string> = {
  stack: 'stack.json',
  structure: 'structure.json',
  architecture: 'architecture.json',
  functionalPatterns: 'functional-patterns.json',
  dependencies: 'dependencies.json',
  stats: 'stats.json',
  keyFiles: 'key-files.json',
  navigation: 'navigation.json',
};

const LEGACY_CODEBASE_MAP_PATH = path.join('docs', 'codebase-map.json');

interface FingerprintCacheEntry {
  metadata: string;
  contentHash: string;
  lastUsedAt: number;
}

/**
 * Bounded metadata/content-hash cache that may be injected into short-lived
 * snapshot services. It never stores file contents or semantic analyses.
 */
export class SemanticFingerprintCache {
  private readonly entries = new Map<string, FingerprintCacheEntry>();

  constructor(
    private readonly maxEntries = MAX_FINGERPRINT_CACHE_ENTRIES,
    private readonly ttlMs = DEFAULT_FINGERPRINT_CACHE_TTL_MS
  ) {}

  get(cacheKey: string, metadata: string): string | undefined {
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    const now = Date.now();
    if (now - entry.lastUsedAt > this.ttlMs) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    if (entry.metadata !== metadata) return undefined;
    entry.lastUsedAt = now;
    return entry.contentHash;
  }

  set(cacheKey: string, metadata: string, contentHash: string): void {
    this.entries.set(cacheKey, { metadata, contentHash, lastUsedAt: Date.now() });
    this.prune();
  }

  reconcileRepo(repoPrefix: string, liveCacheKeys: Set<string>): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(repoPrefix) && !liveCacheKeys.has(key)) this.entries.delete(key);
    }
    this.prune();
  }

  dispose(repoPath?: string): void {
    if (!repoPath) {
      this.entries.clear();
      return;
    }
    const prefix = `${path.resolve(repoPath).toLowerCase()}\0`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.ttlMs) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const stale = [...this.entries.entries()]
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)
      .slice(0, this.entries.size - this.maxEntries);
    for (const [key] of stale) this.entries.delete(key);
  }
}

export interface RepoFingerprintResult {
  fingerprint: string;
  files: number;
  bytesRead: number;
  contentReads: number;
  cacheHits: number;
  discoveries: number;
  partial: boolean;
  skipped: RepoDiscoverySkip[];
  durationMs: number;
}

export class RepositoryChangingError extends Error {
  readonly code = 'repositoryChanging';

  constructor(readonly repoPath: string, readonly attempts: number) {
    super(
      `Semantic snapshot refresh could not stabilize for ${repoPath}; ` +
      `repository changed during ${attempts} refresh attempts.`
    );
    this.name = 'RepositoryChangingError';
  }
}

export class SemanticSnapshotService {
  private static readonly inFlightRefreshes = new Map<string, Promise<SemanticSnapshotWriteResult>>();

  constructor(
    private readonly cacheEnabled = true,
    private readonly fingerprintCache = new SemanticFingerprintCache(),
    fingerprintLimits: Partial<FileMappingLimits> = {}
  ) {
    this.fingerprintLimits = {
      maxFiles: Math.min(
        DEFAULT_FILE_MAPPING_LIMITS.maxFiles,
        Math.max(0, Math.floor(fingerprintLimits.maxFiles ?? DEFAULT_FILE_MAPPING_LIMITS.maxFiles))
      ),
      maxTotalBytes: Math.min(
        DEFAULT_FILE_MAPPING_LIMITS.maxTotalBytes,
        Math.max(
          0,
          Math.floor(fingerprintLimits.maxTotalBytes ?? DEFAULT_FILE_MAPPING_LIMITS.maxTotalBytes)
        )
      ),
      maxFileBytes: Math.min(
        DEFAULT_FILE_MAPPING_LIMITS.maxFileBytes,
        Math.max(
          0,
          Math.floor(fingerprintLimits.maxFileBytes ?? DEFAULT_FILE_MAPPING_LIMITS.maxFileBytes)
        )
      ),
    };
  }

  private readonly fingerprintLimits: FileMappingLimits;

  async captureRepoFingerprint(repoPath: string, discovery?: RepoStructure): Promise<string> {
    return (await this.computeRepoFingerprint(repoPath, discovery)).fingerprint;
  }

  async captureRepoFingerprintWithMetrics(
    repoPath: string,
    discovery?: RepoStructure
  ): Promise<RepoFingerprintResult> {
    return this.computeRepoFingerprint(repoPath, discovery);
  }

  async writeSnapshot(
    repoStructure: RepoStructure,
    options: SemanticSnapshotWriteOptions = {}
  ): Promise<SemanticSnapshotWriteResult> {
    const outputDir = this.resolveOutputDir(repoStructure.rootPath, options.outputDir);
    const snapshotDir = this.getSnapshotDir(outputDir);
    const publishedSummaryPath = path.join(snapshotDir, SUMMARY_FILENAME);

    const repoFingerprint =
      options.repoFingerprint ?? (await this.computeRepoFingerprint(repoStructure.rootPath)).fingerprint;

    const generationStartedAt = Date.now();
    const artifacts = await this.buildSnapshotArtifacts(repoStructure, {
      ...options,
      repoFingerprint,
    });
    const generationMs = Date.now() - generationStartedAt;
    const publicationStartedAt = Date.now();
    const manifest = await this.publishSnapshotArtifacts({
      outputDir,
      snapshotDir,
      publishedSummaryPath,
      artifacts,
    });
    const publicationMs = Date.now() - publicationStartedAt;

    return {
      summary: artifacts.summary,
      manifest,
      snapshotDir,
      publishedSummaryPath,
      metrics: { generationMs, publicationMs, stabilizationAttempts: 1 },
    };
  }

  async ensureFreshSummary(
    repoPath: string,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<SemanticSnapshotEnsureSummaryResult> {
    const current = await this.inspectSummary(repoPath, options);
    if (current?.fresh) {
      return {
        summary: current.summary,
        fresh: true,
        source: 'snapshot',
        path: current.path,
        manifest: current.manifest,
        refreshed: false,
        refreshReason: 'fresh',
      };
    }

    const refreshed = await this.refreshSnapshot(repoPath, options);
    return {
      summary: refreshed.summary,
      fresh: true,
      source: 'snapshot',
      path: path.join(refreshed.snapshotDir, refreshed.manifest.sections.summary),
      manifest: refreshed.manifest,
      refreshed: true,
      refreshReason: current ? 'stale' : 'missing',
    };
  }

  async ensureFreshSection(
    repoPath: string,
    section: SemanticSnapshotSection,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<SemanticSnapshotEnsureSectionResult> {
    const current = await this.inspectSection(repoPath, section, options);
    if (current?.fresh) {
      return {
        ...current,
        fresh: true,
        refreshed: false,
        refreshReason: 'fresh',
      };
    }

    const refreshed = await this.refreshSnapshot(repoPath, options);
    const result = this.buildSectionResult(refreshed, section);
    return {
      ...result,
      fresh: true,
      refreshed: true,
      refreshReason: current ? 'stale' : 'missing',
    };
  }

  async readSummary(
    repoPath: string,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<{
    summary: CodebaseMap;
    fresh: boolean;
    source: 'snapshot';
    path: string;
    manifest?: SemanticSnapshotManifest;
  } | null> {
    const current = await this.inspectSummary(repoPath, options);
    if (!current) {
      return null;
    }

    if (options.allowStale === false && !current.fresh) {
      return null;
    }

    return current;
  }

  async readSection(
    repoPath: string,
    section: SemanticSnapshotSection,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<SemanticSnapshotSectionResult | null> {
    const current = await this.inspectSection(repoPath, section, options);
    if (!current) {
      return null;
    }

    if (options.allowStale === false && !current.fresh) {
      return null;
    }

    return current;
  }

  private async refreshSnapshot(
    repoPath: string,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<SemanticSnapshotWriteResult> {
    const outputDir = this.resolveOutputDir(repoPath, options.outputDir);
    const refreshKey = `${path.resolve(repoPath).toLowerCase()}::${path.resolve(outputDir).toLowerCase()}`;
    const existing = SemanticSnapshotService.inFlightRefreshes.get(refreshKey);
    if (existing) {
      return existing;
    }

    const refreshPromise = (async () => {
      const fileMapper = new FileMapper();
      const snapshotDir = this.getSnapshotDir(outputDir);
      const publishedSummaryPath = path.join(snapshotDir, SUMMARY_FILENAME);

      for (let attempt = 1; attempt <= MAX_REFRESH_ATTEMPTS; attempt += 1) {
        const repoStructure = await fileMapper.mapRepository(repoPath);
        const repoFingerprint = (await this.computeRepoFingerprint(repoPath, repoStructure)).fingerprint;
        const generationStartedAt = Date.now();
        const artifacts = await this.buildSnapshotArtifacts(repoStructure, {
          outputDir,
          repoFingerprint,
        });
        const generationMs = Date.now() - generationStartedAt;
        const verificationStructure = await fileMapper.mapRepository(repoPath);
        const currentFingerprint = (
          await this.computeRepoFingerprint(repoPath, verificationStructure)
        ).fingerprint;

        if (currentFingerprint !== repoFingerprint) {
          continue;
        }

        const publicationStartedAt = Date.now();
        const manifest = await this.publishSnapshotArtifacts({
          outputDir,
          snapshotDir,
          publishedSummaryPath,
          artifacts,
        });
        const publicationMs = Date.now() - publicationStartedAt;
        return {
          summary: artifacts.summary,
          manifest,
          snapshotDir,
          publishedSummaryPath,
          metrics: { generationMs, publicationMs, stabilizationAttempts: attempt },
        };
      }

      throw new RepositoryChangingError(repoPath, MAX_REFRESH_ATTEMPTS);
    })();

    SemanticSnapshotService.inFlightRefreshes.set(refreshKey, refreshPromise);

    try {
      return await refreshPromise;
    } finally {
      SemanticSnapshotService.inFlightRefreshes.delete(refreshKey);
    }
  }

  private async inspectSummary(
    repoPath: string,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<{
    summary: CodebaseMap;
    fresh: boolean;
    source: 'snapshot';
    path: string;
    manifest?: SemanticSnapshotManifest;
  } | null> {
    const outputDir = this.resolveOutputDir(repoPath, options.outputDir);
    const snapshotDir = this.getSnapshotDir(outputDir);
    const manifestPath = path.join(snapshotDir, MANIFEST_FILENAME);

    if (!(await fs.pathExists(manifestPath))) {
      return null;
    }

    const manifest = await fs.readJson(manifestPath) as SemanticSnapshotManifest;
    const summaryPath = path.join(snapshotDir, manifest.sections.summary);
    if (!(await fs.pathExists(summaryPath))) {
      return null;
    }

    const fresh = await this.isFresh(repoPath, manifest.repoFingerprint);
    if (options.allowStale === false && !fresh) {
      return null;
    }

    const summary = await fs.readJson(summaryPath) as CodebaseMap;
    return {
      summary,
      fresh,
      source: 'snapshot',
      path: summaryPath,
      manifest,
    };
  }

  private async inspectSection(
    repoPath: string,
    section: SemanticSnapshotSection,
    options: SemanticSnapshotReadOptions = {}
  ): Promise<SemanticSnapshotSectionResult | null> {
    const outputDir = this.resolveOutputDir(repoPath, options.outputDir);
    const snapshotDir = this.getSnapshotDir(outputDir);
    const manifestPath = path.join(snapshotDir, MANIFEST_FILENAME);

    if (!(await fs.pathExists(manifestPath))) {
      return null;
    }

    const manifest = await fs.readJson(manifestPath) as SemanticSnapshotManifest;
    const fresh = await this.isFresh(repoPath, manifest.repoFingerprint);
    if (options.allowStale === false && !fresh) {
      return null;
    }

    return await this.buildSectionResultFromManifest(snapshotDir, manifest, section, fresh);
  }

  private async buildSnapshotArtifacts(
    repoStructure: RepoStructure,
    options: SemanticSnapshotWriteOptions = {}
  ): Promise<SnapshotArtifacts> {
    let analyzer: CodebaseAnalyzer | null = null;
    let semantics = options.semantics;
    let functionalPatterns = options.functionalPatterns;
    let stackInfo = options.stackInfo;

    try {
      if (!semantics || !functionalPatterns) {
        analyzer = new CodebaseAnalyzer(options.analyzerOptions);
        const bundle = await analyzer.analyzeBundle(
          repoStructure.rootPath,
          repoStructure.files
        );
        semantics ??= bundle.context;
        functionalPatterns ??= bundle.functionalPatterns;
      }

      if (!stackInfo) {
        const stackDetector = new StackDetector();
        stackInfo = await stackDetector.detect(repoStructure.rootPath);
      }
    } finally {
      if (analyzer) {
        await analyzer.shutdown();
      }
    }

    const metadata: SemanticSnapshotMetadata = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoFingerprint:
        options.repoFingerprint ?? (await this.computeRepoFingerprint(repoStructure.rootPath)).fingerprint,
      analyzer: {
        useLSP: !!options.analyzerOptions?.useLSP,
        includesSymbolPayload: false,
      },
    };

    const generator = new CodebaseMapGenerator();
    const summary = generator.generate(
      repoStructure,
      semantics,
      stackInfo,
      functionalPatterns,
      metadata
    );

    const manifest: SemanticSnapshotManifest = {
      ...metadata,
      sections: {
        summary: SUMMARY_FILENAME,
        stack: SECTION_FILENAMES.stack,
        structure: SECTION_FILENAMES.structure,
        architecture: SECTION_FILENAMES.architecture,
        functionalPatterns: SECTION_FILENAMES.functionalPatterns,
        dependencies: SECTION_FILENAMES.dependencies,
        stats: SECTION_FILENAMES.stats,
        keyFiles: SECTION_FILENAMES.keyFiles,
        navigation: SECTION_FILENAMES.navigation,
      },
      publishedSummary: path.join(SNAPSHOT_DIRNAME, SUMMARY_FILENAME),
    };

    return { summary, manifest };
  }

  private async publishSnapshotArtifacts(params: {
    outputDir: string;
    snapshotDir: string;
    publishedSummaryPath: string;
    artifacts: SnapshotArtifacts;
  }): Promise<SemanticSnapshotManifest> {
    const { outputDir, snapshotDir, publishedSummaryPath, artifacts } = params;
    const tempSummaryPath = `${publishedSummaryPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tempManifestPath = path.join(
      snapshotDir,
      `${MANIFEST_FILENAME}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const versionId = this.createVersionId();
    const versionDir = path.join(snapshotDir, VERSIONS_DIRNAME, versionId);
    const versionPrefix = path.posix.join(VERSIONS_DIRNAME, versionId);
    const manifest = this.buildPublishedManifest(artifacts.manifest, versionPrefix);

    await fs.ensureDir(outputDir);
    await fs.ensureDir(snapshotDir);
    await fs.ensureDir(path.dirname(versionDir));
    await fs.remove(versionDir);
    await fs.ensureDir(versionDir);

    try {
      const sectionData = this.getSectionData(artifacts.summary);
      await fs.writeJson(path.join(versionDir, SUMMARY_FILENAME), artifacts.summary, { spaces: 2 });
      await Promise.all(
        Object.entries(SECTION_FILENAMES).map(([section, filename]) =>
          fs.writeJson(path.join(versionDir, filename), sectionData[section as SnapshotFileSection], {
            spaces: 2,
          })
        )
      );
      await fs.writeJson(tempSummaryPath, artifacts.summary, { spaces: 2 });
      await fs.writeJson(tempManifestPath, manifest, { spaces: 2 });

      await this.promoteFile(tempSummaryPath, publishedSummaryPath);
      await this.promoteFile(tempManifestPath, path.join(snapshotDir, MANIFEST_FILENAME));
      await fs.remove(path.join(outputDir, LEGACY_CODEBASE_MAP_PATH));
    } catch (error) {
      await fs.remove(tempSummaryPath);
      await fs.remove(tempManifestPath);
      await fs.remove(versionDir);
      throw error;
    }

    void this.pruneSnapshotVersions(snapshotDir).catch(() => {
      // Snapshot version pruning is best-effort; stale versions are harmless.
    });

    return manifest;
  }

  private buildSectionResult(
    snapshot: SemanticSnapshotWriteResult,
    section: SemanticSnapshotSection
  ): SemanticSnapshotSectionResult {
    if (section === 'meta') {
      return {
        data: snapshot.manifest,
        fresh: true,
        source: 'snapshot',
        path: path.join(snapshot.snapshotDir, MANIFEST_FILENAME),
        manifest: snapshot.manifest,
      };
    }

    const relativeFile = section === 'all'
      ? snapshot.manifest.sections.summary
      : snapshot.manifest.sections[section as SnapshotFileSection];

    return {
      data: this.extractSectionData(snapshot.summary, section),
      fresh: true,
      source: 'snapshot',
      path: path.join(snapshot.snapshotDir, relativeFile),
      manifest: snapshot.manifest,
    };
  }

  private async buildSectionResultFromManifest(
    snapshotDir: string,
    manifest: SemanticSnapshotManifest,
    section: SemanticSnapshotSection,
    fresh: boolean
  ): Promise<SemanticSnapshotSectionResult | null> {
    if (section === 'meta') {
      return {
        data: manifest,
        fresh,
        source: 'snapshot',
        path: path.join(snapshotDir, MANIFEST_FILENAME),
        manifest,
      };
    }

    const relativeFile = section === 'all'
      ? manifest.sections.summary
      : manifest.sections[section as SnapshotFileSection];
    const sectionPath = path.join(snapshotDir, relativeFile);

    if (!(await fs.pathExists(sectionPath))) {
      return null;
    }

    return {
      data: await fs.readJson(sectionPath),
      fresh,
      source: 'snapshot',
      path: sectionPath,
      manifest,
    };
  }

  private extractSectionData(map: CodebaseMap, section: SemanticSnapshotSection): unknown {
    switch (section) {
      case 'all':
        return map;
      case 'meta':
        return map.meta ?? null;
      case 'stack':
        return map.stack;
      case 'structure':
        return map.structure;
      case 'architecture':
        return map.architecture;
      case 'functionalPatterns':
        return map.functionalPatterns;
      case 'dependencies':
        return map.dependencies;
      case 'stats':
        return map.stats;
      case 'keyFiles':
        return map.keyFiles ?? [];
      case 'navigation':
        return map.navigation ?? {};
    }
  }

  private getSectionData(summary: CodebaseMap): Record<SnapshotFileSection, unknown> {
    return {
      stack: summary.stack,
      structure: summary.structure,
      architecture: summary.architecture,
      functionalPatterns: summary.functionalPatterns,
      dependencies: summary.dependencies,
      stats: summary.stats,
      keyFiles: summary.keyFiles ?? [],
      navigation: summary.navigation ?? {},
    };
  }

  private async replaceFile(targetPath: string, sourcePath: string): Promise<void> {
    const backupPath = `${targetPath}.bak-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const targetExists = await fs.pathExists(targetPath);

    if (targetExists) {
      await fs.rename(targetPath, backupPath);
    }

    try {
      await fs.rename(sourcePath, targetPath);
    } catch (error) {
      if (targetExists && await fs.pathExists(backupPath)) {
        await fs.rename(backupPath, targetPath);
      }
      throw error;
    }

    if (targetExists) {
      await fs.remove(backupPath);
    }
  }

  private async promoteFile(sourcePath: string, targetPath: string): Promise<void> {
    try {
      await fs.rename(sourcePath, targetPath);
    } catch {
      await this.replaceFile(targetPath, sourcePath);
    }
  }

  private getSnapshotDir(outputDir: string): string {
    return path.join(outputDir, SNAPSHOT_DIRNAME);
  }

  private buildPublishedManifest(
    manifest: SemanticSnapshotManifest,
    versionPrefix: string
  ): SemanticSnapshotManifest {
    return {
      ...manifest,
      publishedSummary: path.posix.join(SNAPSHOT_DIRNAME, SUMMARY_FILENAME),
      sections: {
        summary: path.posix.join(versionPrefix, SUMMARY_FILENAME),
        stack: path.posix.join(versionPrefix, SECTION_FILENAMES.stack),
        structure: path.posix.join(versionPrefix, SECTION_FILENAMES.structure),
        architecture: path.posix.join(versionPrefix, SECTION_FILENAMES.architecture),
        functionalPatterns: path.posix.join(versionPrefix, SECTION_FILENAMES.functionalPatterns),
        dependencies: path.posix.join(versionPrefix, SECTION_FILENAMES.dependencies),
        stats: path.posix.join(versionPrefix, SECTION_FILENAMES.stats),
        keyFiles: path.posix.join(versionPrefix, SECTION_FILENAMES.keyFiles),
        navigation: path.posix.join(versionPrefix, SECTION_FILENAMES.navigation),
      },
    };
  }

  private createVersionId(): string {
    return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  }

  private async pruneSnapshotVersions(snapshotDir: string): Promise<void> {
    const versionsDir = path.join(snapshotDir, VERSIONS_DIRNAME);
    if (!(await fs.pathExists(versionsDir))) {
      return;
    }

    const entries = await fs.readdir(versionsDir);
    const versions = await Promise.all(
      entries.map(async (entry) => {
        const absolutePath = path.join(versionsDir, entry);
        const stats = await fs.stat(absolutePath);
        return stats.isDirectory()
          ? { entry, absolutePath, mtimeMs: stats.mtimeMs }
          : null;
      })
    );

    const staleVersions = versions
      .filter((entry): entry is { entry: string; absolutePath: string; mtimeMs: number } => entry !== null)
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(MAX_VERSION_HISTORY);

    await Promise.all(staleVersions.map((entry) => fs.remove(entry.absolutePath)));
  }

  private resolveOutputDir(repoPath: string, outputDir?: string): string {
    return outputDir
      ? path.resolve(outputDir)
      : path.resolve(repoPath, '.context');
  }

  private async isFresh(repoPath: string, expectedFingerprint: string): Promise<boolean> {
    return expectedFingerprint === (await this.computeRepoFingerprint(repoPath)).fingerprint;
  }

  private async computeRepoFingerprint(
    repoPath: string,
    discovery?: RepoStructure
  ): Promise<RepoFingerprintResult> {
    const startedAt = Date.now();
    const boundedDiscovery = discovery ?? await new FileMapper([], this.fingerprintLimits)
      .mapRepository(repoPath);
    const discoveries = discovery ? 0 : 1;
    const relevantFiles = [...boundedDiscovery.files]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const skipped = [...(boundedDiscovery.skipped ?? [])];
    let partial = !!boundedDiscovery.partial;
    const hash = createHash('sha256');
    let bytesRead = 0;
    let contentReads = 0;
    let cacheHits = 0;
    let filesHashed = 0;
    let selectedBytes = 0;
    const liveCacheKeys = new Set<string>();
    const repoPrefix = `${path.resolve(repoPath).toLowerCase()}\0`;
    for (const discoveredFile of relevantFiles) {
      const relativePath = discoveredFile.relativePath.split(path.sep).join('/');
      if (filesHashed >= this.fingerprintLimits.maxFiles) {
        partial = true;
        this.recordFingerprintSkip(skipped, {
          file: discoveredFile.path,
          reason: 'file-limit',
          size: discoveredFile.size,
        });
        break;
      }
      const absolutePath = discoveredFile.path;
      const cacheKey = `${repoPrefix}${relativePath}`;
      try {
        const stats = await nativeFs.stat(absolutePath, { bigint: true });
        const size = Number(stats.size);
        if (stats.size > BigInt(this.fingerprintLimits.maxFileBytes)) {
          partial = true;
          this.recordFingerprintSkip(skipped, {
            file: absolutePath,
            reason: 'file-too-large',
            size,
            mtimeMs: Number(stats.mtimeNs) / 1_000_000,
            ctimeMs: Number(stats.ctimeNs) / 1_000_000,
          });
          hash.update(`${relativePath}\0${stats.size}\0${stats.mtimeNs}\0skipped:file-too-large\n`);
          continue;
        }
        if (selectedBytes + size > this.fingerprintLimits.maxTotalBytes) {
          partial = true;
          this.recordFingerprintSkip(skipped, {
            file: absolutePath,
            reason: 'total-byte-limit',
            size,
          });
          hash.update(`${relativePath}\0${stats.size}\0${stats.mtimeNs}\0skipped:total-byte-limit\n`);
          break;
        }

        liveCacheKeys.add(cacheKey);
        const metadata = `${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
        let contentHash: string;
        const cachedHash = this.cacheEnabled
          ? this.fingerprintCache.get(cacheKey, metadata)
          : undefined;
        if (cachedHash) {
          contentHash = cachedHash;
          cacheHits += 1;
        } else {
          const boundedHash = await this.hashFileContentBounded(
            absolutePath,
            Math.min(
              this.fingerprintLimits.maxFileBytes,
              this.fingerprintLimits.maxTotalBytes - selectedBytes
            )
          );
          bytesRead += boundedHash.bytesRead;
          contentReads += 1;
          if (boundedHash.exceeded) {
            partial = true;
            const reason = selectedBytes + boundedHash.bytesRead > this.fingerprintLimits.maxTotalBytes
              ? 'total-byte-limit'
              : 'file-too-large';
            this.recordFingerprintSkip(skipped, { file: absolutePath, reason, size });
            hash.update(`${relativePath}\0${stats.size}\0${stats.mtimeNs}\0skipped:${reason}\n`);
            continue;
          }
          contentHash = boundedHash.contentHash!;
          if (this.cacheEnabled) {
            this.fingerprintCache.set(cacheKey, metadata, contentHash);
          }
        }
        hash.update(`${relativePath}\0${stats.size}\0${stats.mtimeNs}\0${contentHash}\n`);
        filesHashed += 1;
        selectedBytes += size;
      } catch {
        hash.update(`${relativePath}:missing\n`);
        partial = true;
        this.recordFingerprintSkip(skipped, { file: absolutePath, reason: 'stat-failed' });
      }
    }

    for (const skip of skipped) {
      const relativePath = path.relative(repoPath, skip.file).split(path.sep).join('/');
      hash.update(`discovery-skip:${relativePath}:${skip.reason}:${skip.size ?? 'unknown'}\n`);
    }

    // Git index identity is an additional signal only; dirty files are still
    // represented by their independently hashed metadata/content above.
    try {
      const gitIndex = await fs.stat(path.join(repoPath, '.git', 'index'));
      hash.update(`git-index:${gitIndex.size}:${gitIndex.mtimeMs}\n`);
    } catch {
      // Non-git repositories are fully supported.
    }

    if (this.cacheEnabled) {
      this.fingerprintCache.reconcileRepo(repoPrefix, liveCacheKeys);
    }

    return {
      fingerprint: hash.digest('hex'),
      files: filesHashed,
      bytesRead,
      contentReads,
      cacheHits,
      discoveries,
      partial,
      skipped,
      durationMs: Date.now() - startedAt,
    };
  }

  private recordFingerprintSkip(
    skipped: RepoDiscoverySkip[],
    skip: RepoDiscoverySkip
  ): void {
    if (skipped.length < 1_000) skipped.push(skip);
  }

  private async hashFileContentBounded(
    filePath: string,
    maxBytes: number
  ): Promise<{ contentHash?: string; bytesRead: number; exceeded: boolean }> {
    const handle = await nativeFs.open(filePath, 'r');
    const contentHash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, maxBytes)));
    let bytesRead = 0;
    try {
      while (bytesRead < maxBytes) {
        const length = Math.min(chunk.length, maxBytes - bytesRead);
        const read = await handle.read(chunk, 0, length, null);
        if (read.bytesRead === 0) {
          return { contentHash: contentHash.digest('hex'), bytesRead, exceeded: false };
        }
        contentHash.update(chunk.subarray(0, read.bytesRead));
        bytesRead += read.bytesRead;
      }
      const probe = Buffer.allocUnsafe(1);
      const extra = await handle.read(probe, 0, 1, null);
      if (extra.bytesRead > 0) return { bytesRead: bytesRead + 1, exceeded: true };
      return { contentHash: contentHash.digest('hex'), bytesRead, exceeded: false };
    } finally {
      await handle.close();
    }
  }

}

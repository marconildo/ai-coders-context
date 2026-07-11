import * as fs from 'fs-extra';
import { promises as nativeFs, type Stats } from 'fs';
import * as path from 'path';
import { globStream } from 'glob';
import {
  FileInfo,
  RepoStructure,
  TopLevelDirectoryStats,
  type RepoDiscoverySkip,
} from '../types';
import { GitIgnoreManager } from './gitignoreManager';

export interface FileMappingLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
}

export const DEFAULT_FILE_MAPPING_LIMITS: FileMappingLimits = Object.freeze({
  maxFiles: 5_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
});

export const REPOSITORY_RELEVANT_EXTENSIONS = [
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyw', 'pyi',
  'go', 'json', 'yaml', 'yml', 'toml',
] as const;

export const REPOSITORY_ROOT_FILES = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'tsconfig.json', 'tsconfig.build.json', 'jest.config.js', 'jest.config.ts',
  'vitest.config.ts', 'vite.config.ts', 'webpack.config.js', 'next.config.js',
  'next.config.ts', 'nest-cli.json', '.eslintrc', '.eslintrc.js',
  '.eslintrc.json', '.prettierrc', '.prettierrc.json', '.nvmrc', '.node-version',
] as const;

const DEFAULT_RELEVANT_PATTERNS = [
  `{src,lib,bin,app,packages,scripts}/**/*.{${REPOSITORY_RELEVANT_EXTENSIONS.join(',')}}`,
  `*.{${REPOSITORY_RELEVANT_EXTENSIONS.join(',')}}`,
  ...REPOSITORY_ROOT_FILES,
  '.github/workflows/**/*.{yml,yaml}',
  'README*',
  'LICENSE*',
  'Dockerfile*',
  'Makefile',
];

const RELEVANT_SOURCE_ROOTS = new Set(['src', 'lib', 'bin', 'app', 'packages', 'scripts']);

export function isRepositoryRelevantFile(relativePath: string): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  const basename = path.posix.basename(normalized);
  const extension = path.posix.extname(normalized).slice(1).toLowerCase();
  const segments = normalized.split('/');
  if ((REPOSITORY_ROOT_FILES as readonly string[]).includes(normalized)) return true;
  if (segments.length === 1 && /^(README|LICENSE|Dockerfile|Makefile)/i.test(basename)) return true;
  if (segments[0] === '.github' && segments[1] === 'workflows') {
    return extension === 'yml' || extension === 'yaml';
  }
  if (segments.length === 1 || RELEVANT_SOURCE_ROOTS.has(segments[0])) {
    return (REPOSITORY_RELEVANT_EXTENSIONS as readonly string[]).includes(extension);
  }
  return false;
}

const MAX_RECORDED_SKIPS = 1_000;

export class FileMapper {
  private excludePatterns: string[] = [
    'node_modules',
    '**/node_modules',
    '**/node_modules/**',
    '.git/**',
    '.git',
    'dist/**',
    'build/**',
    '.context/**',
    '.context',
    '*.log',
    '.env*',
    '*.tmp',
    '**/.DS_Store'
  ];

  private readonly gitIgnoreManager: GitIgnoreManager;

  private readonly limits: FileMappingLimits;

  constructor(
    customExcludes: string[] = [],
    limits: Partial<FileMappingLimits> = {}
  ) {
    this.excludePatterns = [...this.excludePatterns, ...customExcludes];
    this.gitIgnoreManager = new GitIgnoreManager({ extraPatterns: customExcludes });
    this.limits = {
      maxFiles: Math.max(0, Math.floor(limits.maxFiles ?? DEFAULT_FILE_MAPPING_LIMITS.maxFiles)),
      maxTotalBytes: Math.max(
        0,
        Math.floor(limits.maxTotalBytes ?? DEFAULT_FILE_MAPPING_LIMITS.maxTotalBytes)
      ),
      maxFileBytes: Math.max(
        0,
        Math.floor(limits.maxFileBytes ?? DEFAULT_FILE_MAPPING_LIMITS.maxFileBytes)
      ),
    };
  }

  private async loadGitignorePatterns(repoPath: string): Promise<string[]> {
    const gitignorePath = path.join(repoPath, '.gitignore');
    if (!await fs.pathExists(gitignorePath)) {
      return [];
    }
    const content = await fs.readFile(gitignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  }

  async mapRepository(repoPath: string, includePatterns?: string[]): Promise<RepoStructure> {
    const absolutePath = path.resolve(repoPath);

    if (!await fs.pathExists(absolutePath)) {
      throw new Error(`Repository path does not exist: ${absolutePath}`);
    }

    const gitignorePatterns = await this.loadGitignorePatterns(absolutePath);
    const ignorePatterns = [...this.excludePatterns, ...gitignorePatterns];

    await this.gitIgnoreManager.loadFromRepo(absolutePath);
    const usesDefaultPatterns = !includePatterns?.length;
    const patterns = usesDefaultPatterns ? DEFAULT_RELEVANT_PATTERNS : includePatterns!;
    const fileInfos: FileInfo[] = [];
    const skipped: RepoDiscoverySkip[] = [];
    const seen = new Set<string>();
    let totalSize = 0;
    let entriesVisited = 0;
    let statCalls = 0;
    let stoppedEarly = false;
    const topLevelStats = new Map<string, { fileCount: number; totalSize: number }>();
    const stream = globStream(patterns, {
      cwd: absolutePath,
      ignore: ignorePatterns,
      dot: true,
      absolute: false,
      nodir: true,
    });

    for await (const entry of stream) {
      const rawPath = String(entry);
      const relativePath = (path.isAbsolute(rawPath)
        ? path.relative(absolutePath, rawPath)
        : rawPath).split(path.sep).join('/');
      if (seen.has(relativePath) || this.gitIgnoreManager.shouldIgnore(relativePath)) continue;
      if (usesDefaultPatterns && !isRepositoryRelevantFile(relativePath)) continue;
      seen.add(relativePath);
      entriesVisited += 1;

      if (entriesVisited > this.limits.maxFiles) {
        this.recordSkip(skipped, { file: relativePath, reason: 'file-limit' });
        stoppedEarly = true;
        stream.destroy();
        break;
      }

      const fullPath = path.join(absolutePath, relativePath);
      let stats: Stats;
      try {
        statCalls += 1;
        stats = await nativeFs.stat(fullPath);
      } catch {
        this.recordSkip(skipped, { file: relativePath, reason: 'stat-failed' });
        continue;
      }
      if (!stats.isFile()) continue;

      const skipMetadata = {
        file: fullPath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
      };
      if (stats.size > this.limits.maxFileBytes) {
        this.recordSkip(skipped, { ...skipMetadata, reason: 'file-too-large' });
        continue;
      }
      if (totalSize + stats.size > this.limits.maxTotalBytes) {
        this.recordSkip(skipped, { ...skipMetadata, reason: 'total-byte-limit' });
        stoppedEarly = true;
        stream.destroy();
        break;
      }

      fileInfos.push({
        path: fullPath,
        relativePath,
        extension: path.extname(relativePath),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        type: 'file',
      });
      totalSize += stats.size;

      const topLevelSegment = this.extractTopLevelSegment(relativePath);
      if (topLevelSegment) {
        const current = topLevelStats.get(topLevelSegment) ?? { fileCount: 0, totalSize: 0 };
        current.fileCount += 1;
        current.totalSize += stats.size;
        topLevelStats.set(topLevelSegment, current);
      }
    }

    fileInfos.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const directories = this.deriveDirectories(absolutePath, fileInfos);

    const topLevelDirectoryStats: TopLevelDirectoryStats[] = Array.from(topLevelStats.entries())
      .map(([name, stats]) => ({ name, fileCount: stats.fileCount, totalSize: stats.totalSize }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      rootPath: absolutePath,
      files: fileInfos,
      directories,
      totalFiles: fileInfos.length,
      totalSize,
      topLevelDirectoryStats,
      partial: skipped.length > 0 || stoppedEarly,
      skipped,
      discoveryMetrics: { entriesVisited, statCalls, stoppedEarly },
    };
  }

  private recordSkip(skipped: RepoDiscoverySkip[], skip: RepoDiscoverySkip): void {
    if (skipped.length < MAX_RECORDED_SKIPS) skipped.push(skip);
  }

  private deriveDirectories(repoPath: string, files: FileInfo[]): FileInfo[] {
    const relativeDirectories = new Set<string>();
    for (const file of files) {
      let directory = path.posix.dirname(file.relativePath);
      while (directory !== '.') {
        relativeDirectories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
    return [...relativeDirectories]
      .sort()
      .map((relativePath) => ({
        path: path.join(repoPath, relativePath),
        relativePath,
        extension: '',
        size: 0,
        type: 'directory' as const,
      }));
  }

  async readFileContent(filePath: string): Promise<string> {
    try {
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      return `Error reading file: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  getFilesByExtension(files: FileInfo[], extension: string): FileInfo[] {
    return files.filter(file => file.extension === extension);
  }

  isTextFile(filePath: string): boolean {
    const textExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.cpp', '.c', '.h',
      '.css', '.scss', '.sass', '.html', '.xml', '.json', '.yaml', '.yml',
      '.md', '.txt', '.sql', '.sh', '.bat', '.ps1', '.php', '.rb', '.go',
      '.rs', '.swift', '.kt', '.scala', '.r', '.m', '.pl', '.lua', '.vim',
      '.dockerfile', '.gitignore', '.env'
    ];

    const ext = path.extname(filePath).toLowerCase();
    return textExtensions.includes(ext) || !ext;
  }

  private extractTopLevelSegment(relativePath: string): string | null {
    const parts = relativePath.split(/[/\\]/).filter(Boolean);
    return parts.length > 0 ? parts[0] : null;
  }
}

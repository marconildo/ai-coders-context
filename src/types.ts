export interface FileInfo {
  path: string;
  relativePath: string;
  extension: string;
  size: number;
  /** Filesystem metadata captured during bounded repository discovery. */
  mtimeMs?: number;
  ctimeMs?: number;
  content?: string;
  type: 'file' | 'directory';
}

export interface TopLevelDirectoryStats {
  name: string;
  fileCount: number;
  totalSize: number;
}

export type RepoDiscoverySkipReason =
  | 'file-limit'
  | 'total-byte-limit'
  | 'file-too-large'
  | 'directory-limit'
  | 'entry-limit'
  | 'stat-failed';

export interface RepoDiscoverySkip {
  file: string;
  reason: RepoDiscoverySkipReason;
  size?: number;
  mtimeMs?: number;
  ctimeMs?: number;
}

export interface RepoDiscoveryMetrics {
  /** Raw directory entries inspected, including irrelevant files. */
  entriesScanned: number;
  /** Directories opened by the bounded repository walker. */
  directoriesScanned: number;
  /** Relevant file candidates considered after path filtering. */
  entriesVisited: number;
  statCalls: number;
  stoppedEarly: boolean;
}

export interface RepoStructure {
  rootPath: string;
  files: FileInfo[];
  directories: FileInfo[];
  totalFiles: number;
  totalSize: number;
  topLevelDirectoryStats: TopLevelDirectoryStats[];
  partial?: boolean;
  skipped?: RepoDiscoverySkip[];
  discoveryMetrics?: RepoDiscoveryMetrics;
}

export type AIProvider = 'openrouter' | 'openai' | 'anthropic' | 'google';

export interface LLMConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  provider: AIProvider;
}

export interface CLIOptions {
  repoPath: string;
  outputDir?: string;
  model?: string;
  apiKey?: string;
  provider?: LLMConfig['provider'];
  exclude?: string[];
  include?: string[];
  verbose?: boolean;
  since?: string;
  staged?: boolean;
  force?: boolean;
}

export interface AgentPrompt {
  name: string;
  description: string;
  systemPrompt: string;
  context: string;
  examples?: string[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface UsageStats {
  totalCalls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  model: string;
}

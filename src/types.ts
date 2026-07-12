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

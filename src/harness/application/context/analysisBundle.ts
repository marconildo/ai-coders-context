import type { RepoStructure } from '../../../types';
import type {
  AnalysisLimits,
  AnalysisMetrics as SemanticAnalysisMetrics,
  DetectedFunctionalPatterns,
  SemanticContext,
  SkippedAnalysisFile,
} from '../../adapters/out/semantic';
import type { StackInfo } from './intelligence/stack';

/** Default safety budgets for one context operation. */
export const DEFAULT_ANALYSIS_LIMITS: AnalysisLimits = Object.freeze({
  maxFiles: 5_000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  concurrency: 16,
});

export interface AnalysisMetrics extends SemanticAnalysisMetrics {
  fingerprint: {
    files: number;
    bytesRead: number;
    contentReads: number;
    cacheHits: number;
    discoveries: number;
    durationMs: number;
  };
}

/**
 * Operation-scoped repository view shared by all context-init consumers.
 * It deliberately contains summaries, never the parser's full FileAnalysis map.
 */
export interface AnalysisBundle {
  repoPath: string;
  discoveredFiles: string[];
  repoStructure: RepoStructure;
  semanticContext: SemanticContext;
  functionalPatterns: DetectedFunctionalPatterns;
  stackInfo?: StackInfo;
  repoFingerprint: string;
  limits: AnalysisLimits;
  partial: boolean;
  skipped: SkippedAnalysisFile[];
  metrics: AnalysisMetrics;
}

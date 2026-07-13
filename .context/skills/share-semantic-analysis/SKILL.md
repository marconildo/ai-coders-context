---
name: share-semantic-analysis
description: Consolidate or review repository discovery, semantic parsing, functional-pattern detection, codebase fingerprints, and snapshot generation. Use for context init, DocumentationGenerator, AgentGenerator, SemanticSnapshotService, CodebaseAnalyzer, FileMapper, analysis caching, or large-monorepo performance work.
---

# Share Semantic Analysis

Compute one bounded analysis bundle per operation and reuse it.

## Workflow

1. Map every repository scan, glob, file read, parse, fingerprint, and derived output in the operation.
2. Define one AnalysisBundle owner at the harness application boundary.
3. Discover relevant files once with shared ignores.
4. Parse each selected file once and derive symbols, architecture, and functional patterns from the same analyses.
5. Pass the same bundle to documentation, agent, plan, and snapshot consumers.
6. Apply file-count, per-file byte, total-byte, and concurrency limits.
7. Mark partial analysis and skipped reasons explicitly.
8. Release operation-scoped caches in finally.

## Fingerprinting

Enumerate only relevant files. Reuse content hashes when path, size, and mtime are unchanged. Include dirty files when using git identity. Limit stabilization retries and keep the previous snapshot readable until publication succeeds.

## Required invariants

- Never perform a second semantic read only to derive functional patterns.
- Never let generators silently create independent analyzers in the main context-init path.
- Never glob the entire repository and filter relevance only afterward.
- Never call an analysis complete after a configured limit was hit.
- Honor cacheEnabled.
- Keep snapshot publication atomic.

## Dotcontext routing

- Own AnalysisBundle in src/harness/application/context.
- Keep parsing in semantic adapters.
- Inject data into generators instead of importing transport state.
- Follow [F-05](../../../specs/performance/f-05-shared-semantic-analysis.md).

## Review gate

Instrument tests to count discovery calls, file reads, parse calls, maximum concurrency, bytes read, and fingerprint attempts. Require one parse per selected file in default type=both context init.


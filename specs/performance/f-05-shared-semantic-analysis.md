# F-05 — Share semantic analysis work

Status: Proposed  
Priority: P1  
Boundary owner: harness context application  
Preventive skill: [share-semantic-analysis](../../.context/skills/share-semantic-analysis/SKILL.md)

## Problem

The default context init maps the repository, analyzes documentation semantics, analyzes functional patterns with another analyzer, and analyzes agents with a third analyzer. Snapshot refresh can hash repository contents three times per attempt and retry three times.

Affected code:

- [contextTools.ts](../../src/harness/application/context/contextTools.ts)
- [documentationGenerator.ts](../../src/harness/application/context/scaffolding/generators/documentation/documentationGenerator.ts)
- [agentGenerator.ts](../../src/harness/application/context/scaffolding/generators/agents/agentGenerator.ts)
- [semanticSnapshotService.ts](../../src/harness/adapters/out/semantic/semanticSnapshotService.ts)
- [codebaseAnalyzer.ts](../../src/harness/adapters/out/semantic/codebaseAnalyzer.ts)
- [fileMapper.ts](../../src/utils/fileMapper.ts)

## Goals

- Perform one bounded repository discovery per context operation.
- Parse each selected source file at most once per analysis bundle.
- Reuse semantics, functional patterns, stack info, and fingerprint.
- Avoid content rehash when the repository has not changed.
- Make partial analysis explicit when limits apply.

## Non-goals

- Persist full symbol graphs as a public format.
- Guarantee a perfectly fresh snapshot during continuous writes.
- Analyze more than the configured file and byte budget.

## Analysis bundle

Add an operation-scoped AnalysisBundle in src/harness/application/context:

- repoPath;
- discovered files and RepoStructure;
- SemanticContext;
- DetectedFunctionalPatterns;
- StackInfo;
- repo fingerprint;
- limits and partial metadata;
- metrics: filesDiscovered, filesParsed, bytesRead, duration by stage.

Create the bundle once in HarnessContextService and inject it into generators and snapshot publication.

CodebaseAnalyzer must expose one analyzeBundle pass that derives architecture and functional patterns from the same FileAnalysis Map.

## Limits

Defaults:

| Limit | Default |
| --- | ---: |
| code files parsed | 5,000 |
| total source bytes parsed | 256 MiB |
| single source file | 2 MiB |
| directories scanned | 10,000 (absolute maximum 50,000) |
| raw directory entries scanned | 100,000 (absolute maximum 500,000) |
| file analysis concurrency | 16 (absolute maximum 64) |
| fingerprint attempts | 2 |

Skip oversized files with a reason and mark partial=true.

## Fingerprinting

Use a staged fingerprint:

1. enumerate only relevant paths with shared ignores;
2. hash path, size, and mtime for a fast candidate;
3. reuse cached content hashes for unchanged metadata;
4. hash content only for new or changed candidates;
5. use git index/tree identity as an additional fast signal when safe, never as the sole signal for dirty files.

Do not glob every file and filter relevance afterward.

Snapshot stabilization computes the initial fingerprint and one verification fingerprint. A second attempt is allowed; further instability returns a typed repositoryChanging error with the previous snapshot left readable.

## Cache behavior

- AnalysisBundle is operation-scoped and released after completion.
- Persistent cache stores bounded summary sections, not full FileAnalysis objects.
- Honor cacheEnabled.
- Invalidate by fingerprint, not only repository path.

## Compatibility

- Preserve current context init output and generated files.
- Keep SemanticContextBuilder public methods.
- Allow generators to construct their own bundle only for direct legacy calls; log a deprecation metric.

## Work breakdown

1. Define AnalysisLimits, AnalysisMetrics, and AnalysisBundle.
2. Unify file discovery and ignore rules.
3. Derive functional patterns from existing analyses.
4. Inject the bundle into docs and agent generators.
5. Refactor snapshot publication to consume the bundle.
6. Add incremental fingerprint cache.
7. Honor cacheEnabled and clear operation state in finally.

## Acceptance criteria

- Default type=both semantic init calls file parsing once per selected file.
- Functional pattern detection performs no second file read.
- Documentation and agent generators receive the same SemanticContext identity.
- A 3,000-file fixture remains within configured concurrency and byte limits.
- Oversized files are skipped and reported without crashing.
- Snapshot refresh performs no more than two stabilization attempts.
- Previous snapshots remain readable during refresh failure.
- Tests count analyzer calls, file reads, and maximum in-flight analysis.

## Rollout and rollback

Introduce AnalysisBundle behind the existing context service while legacy direct generator calls remain supported. Roll back individual consumers without changing the snapshot format.

## Observability

Record discovery, parsing, fingerprint, generation and publication durations; file and byte counts; cache hits; skipped file reasons; partial status; and stabilization attempts.

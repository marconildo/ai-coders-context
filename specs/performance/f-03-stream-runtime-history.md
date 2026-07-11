# F-03 — Stream runtime history

Status: Proposed  
Priority: P0  
Boundary owner: harness, with MCP adaptation in F-06  
Preventive skill: [stream-runtime-history](../../.context/skills/stream-runtime-history/SKILL.md)

## Problem

Runtime APIs load complete traces, artifacts, sessions, replays, and datasets. Replay creates a second full event graph and applies maxEvents only after materialization, while still returning complete source arrays. Dataset builds every selected replay concurrently.

Affected code:

- [runtimeStateService.ts](../../src/harness/adapters/out/runtimeState/runtimeStateService.ts)
- [replayService.ts](../../src/harness/application/replay/replayService.ts)
- [datasetService.ts](../../src/harness/application/datasets/datasetService.ts)
- [taskContractsService.ts](../../src/harness/application/contracts/taskContractsService.ts)
- [sensorsService.ts](../../src/harness/application/sensors/sensorsService.ts)

## Goals

- Make memory proportional to page size, not history size.
- Give every list operation a bounded default and maximum.
- Make replay limits constrain reads, transformations, response, and persistence.
- Build datasets with bounded concurrency.
- Add retention without deleting active workflow evidence.

## Non-goals

- Introduce a database dependency.
- Preserve unlimited list behavior.
- Reconstruct source content removed by F-02.

## Query contracts

Introduce opaque cursor-based queries:

| Resource | Default | Maximum |
| --- | ---: | ---: |
| traces | 100 | 1,000 |
| sessions | 50 | 200 |
| artifacts | 50 | 200 |
| replay summaries | 25 | 100 |
| dataset summaries | 25 | 100 |

Every page returns items, nextCursor, hasMore, and scannedBytes where applicable. Support trace filters for event, level, createdAfter, and createdBefore.

Cursor payloads must be versioned and encoded; invalid or stale cursors return a typed error. Do not expose raw file offsets as a public guarantee.

## Streaming trace reader

Add a runtime-state port that iterates JSONL records across legacy and rotated segments:

- read line-by-line;
- stop after the requested page;
- skip malformed terminal lines and report malformedCount;
- support newest-first without reading the entire file into a string;
- expose an internal async iterator for consumers that need full scans.

Task evaluation and sensor quality must not scan every trace. Maintain a bounded session summary with the latest run per sensor and update it during appendTrace.

## Replay contract

Replace the current mixed full/partial record with:

- bounded events;
- source counts by type;
- omitted counts;
- nextCursor for additional events;
- fidelity;
- bounded session summary.

When maxEvents is 10, no source array may contain more than those 10 materialized events. Full export, if retained, must stream to a file artifact and return its path/metadata rather than the payload.

## Dataset execution

- default concurrency: 1 session;
- configurable maximum: 4;
- process replay summaries incrementally;
- retain only failure records required for clustering;
- cap failures per dataset at 10,000 by default;
- return partial=true and omittedFailureCount when capped.

## Runtime retention

Default policy:

- active sessions: never age-delete;
- completed/failed sessions: retain 30 days;
- replays: retain 10 per session and 30 days;
- datasets: retain 20 and 30 days;
- repository runtime quota: 256 MiB;
- prune oldest eligible data first;
- dry-run prune report required.

F-07 owns configuration lifecycle and binding/checkpoint retention.

## Compatibility

- Keep point reads by ID.
- Read legacy trace.jsonl and existing replay/dataset JSON.
- Add summary-only list APIs before changing MCP defaults.
- Mark unlimited methods deprecated for one minor release, but make internal hot paths use paginated APIs immediately.

## Work breakdown

1. Define page and cursor types in harness.
2. Implement streaming trace reader and segment merge.
3. Add paginated state ports.
4. Add sensor summary index and migration-on-read.
5. Redesign replay result and persistence.
6. Bound dataset concurrency and records.
7. Add prune service with dry-run.
8. Adapt CLI and MCP consumers.

## Acceptance criteria

- Reading 100 records from a 1 GiB trace stays within 32 MiB incremental RSS in a dedicated benchmark.
- maxEvents=10 returns and persists at most 10 event payloads.
- Task evaluation reads the sensor summary rather than listTraces.
- Dataset processing never exceeds configured concurrency.
- List APIs reject limits above their maximum.
- Legacy runtime fixtures remain readable.
- Prune never deletes active sessions or the active workflow binding.
- Crash during rotation/prune leaves a readable previous state.
- Load tests cover one million trace lines and 1,000 sessions.

## Rollout and rollback

Ship readers before writers and summary indexes before hot-path migration. Keep legacy fallback for one release. Roll back consumers independently while preserving new files; never require destructive downgrade migration.

## Observability

Expose recordsReturned, recordsScanned, bytesRead, cursorVersion, malformedCount, partial, pruneBytes, and per-operation duration.


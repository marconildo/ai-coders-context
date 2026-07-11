---
name: stream-runtime-history
description: Implement or review bounded runtime-history storage and retrieval. Use for traces, sessions, artifacts, sensor summaries, replays, datasets, cursor pagination, JSONL streaming, pruning, retention, or any harness API whose cost can grow with historical records.
---

# Stream Runtime History

Make memory and response size proportional to a requested page.

## Workflow

1. Identify the cardinality and byte growth of every source collection.
2. Define default and maximum page sizes before changing an API.
3. Read JSONL incrementally and stop as soon as the page is complete.
4. Return an opaque, versioned cursor and explicit partial metadata.
5. Replace hot-path historical scans with bounded summary indexes.
6. Limit replay materialization at the source, transformation, response, and persistence layers.
7. Process multi-session work with bounded concurrency.
8. Add retention with dry-run, active-session protection, and crash-safe writes.

## Required invariants

- Never implement pagination by loading everything and slicing afterward.
- Never return complete source arrays inside a partial replay.
- Never use Promise.all over an unbounded set of sessions or files.
- Keep point reads by ID available.
- Read legacy runtime files without destructive migration.
- Keep active workflow evidence immune from age-based pruning.
- Treat malformed final JSONL lines as bounded diagnostics.

## Cursor rules

Keep cursors opaque to callers, include a version, bind them to the query direction and filters, and return a typed error for invalid or stale values. Do not promise raw byte offsets as a stable public contract.

## Dotcontext routing

- Define pagination and retention in harness ports/application.
- Keep MCP cursor adaptation thin.
- Coordinate trace segments with the hook payload skill.
- Follow [F-03](../../../specs/performance/f-03-stream-runtime-history.md).

## Review gate

Require load evidence for a large trace and many sessions. Verify page-size memory, maxEvents semantics, dataset concurrency, legacy reads, prune safety, and cursor boundary cases.


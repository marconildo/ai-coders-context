# F-07 — Govern cache and persistent retention

Status: Proposed  
Priority: P1  
Boundary owners: harness, MCP logging, integrations  
Preventive skill: [govern-cache-retention](../../.context/skills/govern-cache-retention/SKILL.md)

## Problem

Several caches and persistent indexes have no maximum size, complete invalidation, or cleanup lifecycle. ContextCache expires only on access, SemanticContextBuilder retains a full graph without file invalidation, MCP sessionCache has no TTL, host session bindings never expire, and checkpoints grow inside session.json that is rewritten on every trace.

Affected code:

- [contextCache.ts](../../src/harness/adapters/out/semantic/contextCache.ts)
- [contextBuilder.ts](../../src/harness/adapters/out/semantic/contextBuilder.ts)
- [actionLogger.ts](../../src/mcp/logging/actionLogger.ts)
- [hookSessionStore.ts](../../src/integrations/shared/hookSessionStore.ts)
- [runtimeStateService.ts](../../src/harness/adapters/out/runtimeState/runtimeStateService.ts)

## Goals

- Give every in-memory cache entry, byte, and age limits.
- Make expiration proactive at safe lifecycle points.
- Keep cache freshness tied to source identity.
- Bound host bindings and checkpoint persistence.
- Centralize runtime retention configuration with safe defaults.

## Non-goals

- Share caches between OS processes.
- Guarantee exact memory accounting.
- Delete active workflow data.

## Cache contract

Every cache must declare:

- key normalization;
- maximum entries;
- estimated maximum bytes;
- TTL;
- freshness signal;
- eviction order;
- cleanup trigger;
- stop/dispose behavior;
- metrics.

Defaults:

| Cache | Entries | Estimated bytes | TTL |
| --- | ---: | ---: | ---: |
| ContextCache | 16 | 32 MiB | 5 minutes |
| SemanticContextBuilder | 1 | 64 MiB | fingerprint-bound |
| MCP session cache | 64 | negligible | 30 minutes idle |
| Tree-sitter FileAnalysis | 5,000 | 128 MiB | analysis lifecycle |

Use LRU within TTL. Reject a single entry larger than its cache byte budget.

### Context cache

- sweep expired entries on set and at a bounded interval;
- unref the sweep timer;
- clear on MCP stop;
- include target file and relevant options in the key;
- use fingerprint/mtime for freshness.

### Semantic builder and tree-sitter

- honor cacheEnabled;
- invalidate full SemanticContext when repository fingerprint changes;
- evict removed file paths;
- release analysis cache after operation-scoped use from F-05.

### Session cache and host bindings

- normalize repoPath before using it as a key;
- LRU/idle-expire MCP session entries;
- remove cache entry when the session completes or disappears;
- expire host bindings after 30 days or when the bound harness session is missing;
- cap bindings at 1,000 per repository;
- prune during SessionStart and explicit maintenance, not every PostToolUse.

### Checkpoints

Move checkpoints from the growing session.json array to append-only checkpoint records or individual files. Keep only checkpointCount, lastCheckpointAt, and lastCheckpointId in session.json.

Read legacy embedded checkpoints and migrate lazily on the next checkpoint write. Cap checkpoint data at 64 KiB and artifactIds at 200.

## Runtime configuration

Create .context/config/runtime.json with versioned sections for traces, sessions, replays, datasets, checkpoints, bindings, and caches. Defaults apply when absent. Unknown keys are ignored with a diagnostic; invalid unsafe values are clamped.

## Work breakdown

1. Define reusable LRU byte-budget utility.
2. Apply it to ContextCache and MCP session cache.
3. Honor semantic cacheEnabled and fingerprint freshness.
4. Add host binding prune and cap.
5. Externalize checkpoints with legacy migration.
6. Add runtime config schema and maintenance service.
7. Connect repository retention to F-03 prune.

## Acceptance criteria

- Inserting more than maxEntries evicts the least recently used entry.
- Expired entries disappear without being accessed individually.
- MCP stop leaves cache size zero and no referenced sweep timer.
- cacheEnabled=false stores no FileAnalysis or SemanticContext.
- Changing a source fingerprint invalidates semantic context.
- host-sessions.json never exceeds the configured binding cap.
- Missing harness sessions cause stale binding removal.
- Adding a checkpoint does not grow session.json with checkpoint payload history.
- Legacy embedded checkpoints remain readable and migrate without loss.
- Runtime config invalid values cannot disable absolute safety ceilings.

## Rollout and rollback

Land cache bounds independently. Migrate checkpoints with dual-read/new-write behavior. Keep legacy fields readable for at least one minor release. Rollback must not discard new checkpoint files.

## Observability

Expose entries, estimatedBytes, hit, miss, eviction reason, oldest age, stale binding count, checkpoint migration count, config clamps, and cleanup duration.


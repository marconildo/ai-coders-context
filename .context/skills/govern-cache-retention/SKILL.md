---
name: govern-cache-retention
description: Design, implement, or review bounded cache and persistent-index lifecycle. Use for ContextCache, SemanticContextBuilder, tree-sitter analysis cache, MCP session cache, hook host-session bindings, checkpoints, TTL, LRU, byte budgets, invalidation, cleanup timers, disposal, migration, or runtime retention configuration.
---

# Govern Cache Retention

Require every cache and persistent index to declare how it stops growing and becomes fresh again.

## Workflow

1. Inventory keys, values, entry count, estimated bytes, and ownership lifetime.
2. Define maximum entries, maximum estimated bytes, TTL, and single-entry behavior.
3. Choose a freshness signal tied to the source, not only elapsed time.
4. Use LRU within TTL and evict proactively on set and lifecycle cleanup.
5. Make timers unref, bounded, and disposable.
6. Clear process-local caches on server stop.
7. Add lazy, dual-read migration for persistent shape changes.
8. Protect active sessions and preserve rollback readability.

## Required cache contract

Document:

- normalized key;
- entry and byte limits;
- TTL;
- freshness signal;
- eviction order;
- sweep trigger;
- dispose behavior;
- metrics;
- behavior when one entry exceeds budget.

Reject a cache implementation that omits any item.

## Persistent indexes

Avoid one ever-growing JSON document on a hot path. Partition bindings or records when lookup and rewrite cost scale with total history. Keep summaries in session.json and move growing checkpoint payloads to append-only or individual records.

## Required invariants

- Never expire only when the exact stale key is read again.
- Never leave a referenced interval after stop.
- Never retain stale semantic context after source identity changes.
- Never ignore cacheEnabled.
- Never prune active workflow state.
- Never require destructive migration to roll back.
- Clamp unsafe configuration values.

## Dotcontext routing

- Put generic LRU/retention rules in harness domain/application.
- Keep MCP and integration caches owned and disposed by their surfaces.
- Coordinate repository pruning with runtime history.
- Follow [F-07](../../../specs/performance/f-07-cache-retention.md).

## Review gate

Test entry eviction, byte eviction, TTL sweep, freshness invalidation, stop cleanup, stale binding removal, checkpoint migration, unsafe config clamps, and legacy reads.


# Memory and Performance Remediation Specifications

Status: Proposed  
Source audit: [MEMORY_PERFORMANCE_AUDIT.md](../../MEMORY_PERFORMANCE_AUDIT.md)

## Objective

Turn every confirmed audit finding into an independently deliverable change with explicit resource bounds, compatibility rules, observability, rollback, and regression tests.

## Specification map

| Finding | Specification | Preventive skill | Priority |
| --- | --- | --- | --- |
| F-01 | [Bound subprocess output](./f-01-bound-subprocess-output.md) | [bound-subprocess-output](../../.context/skills/bound-subprocess-output/SKILL.md) | P0 |
| F-02 | [Sanitize hook payloads and rotate traces](./f-02-sanitize-hook-payloads.md) | [sanitize-hook-payloads](../../.context/skills/sanitize-hook-payloads/SKILL.md) | P0 |
| F-03 | [Stream runtime history](./f-03-stream-runtime-history.md) | [stream-runtime-history](../../.context/skills/stream-runtime-history/SKILL.md) | P0 |
| F-04 | [Own the LSP process lifecycle](./f-04-lsp-process-lifecycle.md) | [manage-lsp-process-lifecycle](../../.context/skills/manage-lsp-process-lifecycle/SKILL.md) | P0 |
| F-05 | [Share semantic analysis work](./f-05-shared-semantic-analysis.md) | [share-semantic-analysis](../../.context/skills/share-semantic-analysis/SKILL.md) | P1 |
| F-06 | [Bound MCP payloads](./f-06-bound-mcp-payloads.md) | [bound-mcp-payloads](../../.context/skills/bound-mcp-payloads/SKILL.md) | P0/P1 |
| F-07 | [Govern cache and persistent retention](./f-07-cache-retention.md) | [govern-cache-retention](../../.context/skills/govern-cache-retention/SKILL.md) | P1 |

## Delivery order

1. F-01 and F-04 can proceed independently.
2. F-02 establishes safe trace writes.
3. F-03 establishes bounded reads, replay, dataset, and runtime retention.
4. F-06 consumes the pagination contracts from F-03.
5. F-05 consolidates semantic work without coupling to runtime history.
6. F-07 finishes lifecycle policy across caches, bindings, checkpoints, and indexes.

F-02, F-03, and F-06 must agree on cursor and truncation metadata before implementation. Do not ship a response limit that merely rejects the current unpaginated runtime APIs.

## Global engineering constraints

- Preserve the cli -> harness <- mcp and integrations boundary.
- Put reusable execution behavior in src/harness/application or reusable rules in src/harness/domain.
- Keep transport validation and response shaping in src/mcp/gateway or src/mcp/server.
- Keep host event mapping and hook templates in src/integrations.
- Do not add code under src/services.
- Keep default behavior safe without requiring configuration.
- Never use a larger Node heap as the primary mitigation.

## Global quality gates

Every implementation must:

1. add a failing regression test before the fix;
2. define the bound in bytes, entries, concurrency, or time;
3. expose truncation or partial-result metadata;
4. keep active workflows and existing runtime files readable;
5. avoid logging captured content;
6. run npm run build and npm test -- --runInBand;
7. run package build and smoke tests if a public package contract changes.

## Shared terminology

- Hard limit: input above the threshold is rejected or terminated.
- Soft limit: older data is evicted or output is truncated while the operation continues.
- Cursor: opaque continuation token; callers must not infer file offsets from it.
- Summary record: bounded metadata without the original payload.
- Partial result: a successful, explicitly incomplete response with a continuation path.


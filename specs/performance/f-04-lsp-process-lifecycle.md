# F-04 — Own the LSP process lifecycle

Status: Proposed  
Priority: P0 when useLSP is enabled  
Boundary owner: harness semantic adapter  
Preventive skill: [manage-lsp-process-lifecycle](../../.context/skills/manage-lsp-process-lifecycle/SKILL.md)

## Problem

LSPLayer returns false after initialize failure without terminating the spawned process. A later request spawns another process and overwrites the tracked Map entry. cleanup removes bookkeeping but never kills the child, and shutdown has the same leak when the protocol request fails or times out.

Affected code:

- [lspLayer.ts](../../src/harness/adapters/out/semantic/lsp/lspLayer.ts)
- [codebaseAnalyzer.ts](../../src/harness/adapters/out/semantic/codebaseAnalyzer.ts)

## Goals

- Give every spawned process exactly one tracked owner.
- Deduplicate concurrent initialization per language and project.
- Guarantee termination after initialization failure and shutdown.
- Scope requests, buffers, and cleanup to a concrete server instance.
- Avoid retry storms while preserving regex/tree-sitter fallback.

## Non-goals

- Implement a general LSP client framework.
- Automatically install language servers.
- Keep a failed server alive for debugging.

## Proposed state model

Track a ServerHandle per language and project:

- process;
- state: starting, ready, stopping, stopped, failed;
- initialization Promise;
- pending request IDs;
- receive buffer;
- projectPath;
- startedAt;
- termination reason.

Do not store process, buffer, and initialized state in separate Maps.

### Initialization

1. Return the ready handle when available.
2. Return the existing initialization Promise while starting.
3. After a failure, open a circuit for the current analysis.
4. On failure, reject only requests owned by that handle.
5. Close stdin, send SIGTERM, wait up to 2 seconds, then SIGKILL.
6. Wait for close before deleting the handle.

Use a spawn confirmation based on spawn/error events rather than a 100 ms timer.

### Shutdown

For each handle:

1. request protocol shutdown with a 2-second timeout;
2. send exit when shutdown succeeds;
3. close stdin;
4. wait for process exit;
5. send SIGTERM, then SIGKILL after 2 seconds if necessary;
6. clear timers, listeners, buffers, and pending requests.

shutdown must be idempotent and safe during initialization.

### Retry policy

- one initialization attempt per language/project per CodebaseAnalyzer;
- no per-symbol retries after failure;
- a new analyzer may retry;
- optional explicit retry method for diagnostics only.

## Compatibility

- Keep public LSPLayer semantic methods and fallback return values.
- Preserve useLSP=false behavior.
- Do not expose ChildProcess through public harness APIs.

## Work breakdown

1. Introduce ServerHandle and typed state transitions.
2. Replace Maps with handle ownership.
3. Add spawn and initialization deduplication.
4. Implement terminateProcess with grace and kill escalation.
5. Scope pending requests by handle.
6. Add circuit breaker to semantic enhancement.
7. Add fake-server fixtures for rejection, timeout, crash, and ignored shutdown.

## Acceptance criteria

- Initialize rejection leaves zero child processes.
- Initialize timeout leaves zero child processes.
- Two concurrent ensureServer calls spawn exactly one child.
- Repeated symbol enhancement after failure performs no new spawn.
- shutdown leaves zero children when the server ignores protocol shutdown.
- cleanup of one language does not reject another language's requests.
- All timers and listeners are removed after shutdown.
- Tests assert child exit, not only empty Maps.

## Rollout and rollback

Ship without a flag because the current behavior leaks processes. If an LSP implementation needs more shutdown time, adjust the bounded grace period by config; do not revert process ownership.

## Observability

Record language, project hash, PID, state transition, initialize duration, exit code/signal, forcedKill, pending request count, and retry suppression. Do not log source payloads returned by LSP.


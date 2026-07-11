---
name: manage-lsp-process-lifecycle
description: Implement or review language-server child-process ownership and cleanup. Use for LSPLayer, optional semantic LSP mode, spawn initialization, request timeouts, buffers, pending requests, retries, circuit breakers, graceful shutdown, SIGTERM/SIGKILL escalation, or orphan-process regressions.
---

# Manage LSP Process Lifecycle

Give every process one owner and a terminal state.

## Workflow

1. Model one handle containing process, state, buffer, pending requests, timers, and project identity.
2. Deduplicate initialization with one Promise per language/project.
3. Treat initialize rejection, timeout, spawn error, and early exit as terminal failures.
4. Terminate the child on every failed initialization path.
5. Suppress retries for the current analysis after failure.
6. Make shutdown idempotent during starting, ready, failed, and stopping states.
7. Escalate from protocol shutdown to exit, SIGTERM, and bounded SIGKILL.
8. Wait for close and remove listeners/timers before releasing ownership.

## Required invariants

- Never overwrite a tracked process handle with a new child.
- Never let cleanup mean only deleting Maps.
- Never reject requests owned by another server handle.
- Never retry initialization once per symbol.
- Never resolve shutdown while a managed child remains alive.
- Preserve the useLSP=false fallback and non-LSP semantic behavior.

## Testing

Use executable fake servers that:

- reject initialize;
- never answer initialize;
- crash after spawn;
- ignore protocol shutdown;
- answer normally;
- run concurrently for different languages.

Assert OS child exit, spawn count, pending request cleanup, timer cleanup, and forced-kill metadata. Checking Map size alone is insufficient.

## Dotcontext routing

Keep ownership in src/harness/adapters/out/semantic/lsp and keep CodebaseAnalyzer responsible only for choosing whether to use LSP. Follow [F-04](../../../specs/performance/f-04-lsp-process-lifecycle.md).

## Review gate

Reject any change that lacks a zero-child assertion for failure and shutdown, or that introduces an unbounded retry path.


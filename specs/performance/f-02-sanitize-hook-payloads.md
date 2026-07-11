# F-02 — Sanitize hook payloads and rotate traces

Status: Proposed  
Priority: P0  
Boundary owners: integrations, cli, harness  
Preventive skill: [sanitize-hook-payloads](../../.context/skills/sanitize-hook-payloads/SKILL.md)

## Problem

Shell hook dispatch reads all stdin into memory and PostToolUse persists tool_input unchanged. Write and Edit can therefore duplicate complete source content into trace.jsonl. Traces have no event limit, byte quota, rotation, or automatic retention.

Affected code:

- [hookDispatchService.ts](../../src/cli/services/hookDispatchService.ts)
- [bashClassification.ts](../../src/harness/application/hooks/bashClassification.ts)
- [resolveHarnessHookFromHostEvent.ts](../../src/integrations/shared/resolveHarnessHookFromHostEvent.ts)
- [runtimeStateService.ts](../../src/harness/adapters/out/runtimeState/runtimeStateService.ts)

## Goals

- Bound hook stdin before concatenation and JSON parsing.
- Persist useful tool metadata without source bodies or secrets.
- Enforce a defense-in-depth maximum serialized trace event size.
- Rotate and retain trace segments without breaking active sessions.
- Make redaction and truncation observable.

## Non-goals

- Persist diffs for later reconstruction.
- Rewrite historical traces during the first release.
- Change host hook configuration shapes.

## Proposed design

### Bounded stdin

Implement incremental byte counting in CLI hook dispatch:

- default maximum: 8 MiB;
- stop reading and return a non-blocking diagnostic when exceeded;
- do not Buffer.concat after the limit;
- never echo the rejected input.

The dispatcher must remain non-blocking for host operations, but must record a bounded trace-failure diagnostic.

### Hook trace policy

Add a reusable policy in src/harness/application/hooks. Normalize known tools:

| Tool | Persist |
| --- | --- |
| Write | file path, declared byte length, content hash, contentOmitted=true |
| Edit | file path, old/new byte lengths, hashes, range metadata when present |
| Bash | classification, command basename, bounded command preview |
| Unknown | keys, scalar metadata, bounded structural summary |

Always redact keys matching content, old_string, new_string, patch, apiKey, token, secret, password, authorization, messages, and prompt, case-insensitively.

Defaults:

- maximum string field: 512 bytes;
- maximum array items: 20;
- maximum object depth: 4;
- maximum serialized hook trace data: 16 KiB;
- maximum serialized generic trace event: 256 KiB.

### Trace write quota and rotation

Store trace segments under the existing session directory:

- active trace.jsonl remains the write target;
- rotate at 8 MiB;
- retain 4 closed segments per active session;
- retain at most 32 MiB per session by default;
- never delete the active segment;
- write a bounded trace.rotated event after rotation.

F-03 defines streaming reads across segments and repository-wide retention.

## Configuration

Use .context/config/hooks.json for hook-specific limits and .context/config/runtime.json for generic trace limits. Clamp all configured values to safe global maxima.

## Compatibility and migration

- Existing unsegmented trace.jsonl remains readable.
- New readers must merge legacy and rotated segments in chronological order.
- Existing hook installation docs and templates remain unchanged.
- No historical source payload is rewritten automatically.

## Work breakdown

1. Add tool-input sanitizer and tests for every host envelope.
2. Add bounded stdin reader.
3. Add serialized event size guard to runtime state.
4. Add atomic trace rotation.
5. Add config parsing and clamping.
6. Update README, dotcontext.dev hook guide, and CHANGELOG because hook behavior changes.

## Acceptance criteria

- A 5 MiB Write content produces a trace event below 16 KiB.
- No raw Write/Edit content appears in persisted traces.
- Sensitive keys are redacted regardless of case.
- Hook stdin above 8 MiB does not cause Buffer.concat or process failure.
- A trace rotates after the configured threshold and active writes continue.
- Concurrent appends do not corrupt or misorder a segment.
- Old trace.jsonl files remain readable.
- Hook round-trip tests cover Claude Code, Codex, and Pi.
- Build, full tests, package build, and package smoke pass.

## Rollout and rollback

Enable sanitization immediately. Roll out rotation after F-03 readers understand segments. Rollback may disable rotation, but must never restore raw content capture.

## Observability

Record inputBytes, persistedBytes, redactedFieldCount, truncatedFieldCount, rotationCount, and quota status. Never log redacted values or hashes of known secrets.


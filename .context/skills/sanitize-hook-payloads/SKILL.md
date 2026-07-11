---
name: sanitize-hook-payloads
description: Design, implement, or review safe lifecycle-hook payload capture and trace persistence. Use for Claude Code, Codex, or Pi hook dispatch; PostToolUse Write/Edit/Bash mapping; stdin parsing; trace redaction; trace quotas; rotation; or hook privacy and performance changes.
---

# Sanitize Hook Payloads

Treat host hook envelopes as untrusted, potentially huge, and potentially secret-bearing.

## Workflow

1. Trace the envelope from host stdin through normalization, mapping, and appendTrace.
2. Set an input byte ceiling before parsing JSON.
3. Reduce tool input to an allowlisted metadata summary before it reaches runtime state.
4. Apply recursive redaction and serialized-size limits as defense in depth.
5. Rotate traces by bytes and preserve atomic append behavior.
6. Keep host hooks non-blocking while recording a bounded failure reason.
7. Test equivalent envelopes for Claude Code, Codex, and Pi.

## Tool summaries

- Write: keep path, byte length, hash, and contentOmitted.
- Edit: keep path, old/new lengths, hashes, and range metadata.
- Bash: keep classification, basename, and a bounded preview.
- Unknown: keep scalar metadata and key names only.

Redact content, old_string, new_string, patch, prompt, messages, authorization, tokens, passwords, secrets, and API keys case-insensitively.

## Required invariants

- Never persist raw Write or Edit bodies.
- Never echo rejected stdin.
- Never rely only on host-provided sizes.
- Measure the serialized trace before writing.
- Keep trace rotation compatible with legacy trace.jsonl.
- Never delete the active segment.
- Keep safety ceilings effective even when configuration is malformed.

## Dotcontext routing

- Keep host field mapping in src/integrations.
- Keep stdin limits in src/cli.
- Keep reusable sanitization and trace policy in src/harness.
- Update hook installer tests and public hook docs when observable behavior changes.
- Follow [F-02](../../../specs/performance/f-02-sanitize-hook-payloads.md).

## Review gate

Verify a multi-megabyte Write produces a small trace, sensitive fixtures never appear on disk, oversized stdin stays non-blocking, rotation survives concurrent appends, and package smoke tests pass.


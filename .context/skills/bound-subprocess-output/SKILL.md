---
name: bound-subprocess-output
description: Implement or review child-process execution with bounded stdout and stderr memory. Use for Node spawn wrappers, sensors, test runners, acceptance commands, timeout handling, output tails, truncation, or any change that captures subprocess output in the dotcontext harness.
---

# Bound Subprocess Output

Keep memory proportional to configured diagnostics, never to total child output.

## Workflow

1. Identify what the caller actually needs: exit code, a tail, structured output, or a durable export.
2. Define separate byte limits for stdout, stderr, structured result files, and combined output before editing code.
3. Retain data online with a ring/tail buffer. Do not collect all chunks and trim at process exit.
4. Track total, retained, and dropped bytes without logging content.
5. Define explicit behavior for timeout, output ceiling, spawn error, non-zero exit, and malformed structured output.
6. Preserve shell:false and argv-array execution.
7. Add volume tests that exceed every limit.

## Required invariants

- Never let an array of chunks scale with total output.
- Never call Buffer.concat over the full historical stream.
- Measure limits in UTF-8 bytes, not JavaScript string length.
- Bound stdout and stderr independently.
- Apply hard ceilings while the process is running.
- Kill and reap the child when a hard ceiling or timeout fires.
- Expose truncated, droppedBytes, and termination reason.
- Persist only bounded tails in traces and plan tracking.

## Structured test output

Write large machine-readable results to a temporary file when a parser needs more than a tail. Check file size before reading, parse only required fields, and remove the file in finally. Keep console streams bounded even when using a result file.

## Dotcontext routing

- Put pure bounding rules in src/harness/domain.
- Keep subprocess orchestration in the existing harness execution or adapter boundary.
- Apply the same collector to sensors and plan acceptance.
- Follow [F-01](../../../specs/performance/f-01-bound-subprocess-output.md).

## Review gate

Reject the change if any answer is no:

- Is there a documented default and absolute maximum?
- Does memory stay bounded before process exit?
- Does every failure path reap the child?
- Are truncation counters visible?
- Does a 100 MiB-output regression test pass without retaining 100 MiB?
- Do npm run build and npm test -- --runInBand pass?


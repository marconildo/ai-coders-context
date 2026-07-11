# F-01 — Bound subprocess output

Status: Proposed  
Priority: P0  
Boundary owner: harness  
Preventive skill: [bound-subprocess-output](../../.context/skills/bound-subprocess-output/SKILL.md)

## Problem

Sensor and acceptance subprocesses retain every stdout and stderr chunk. Tail limits are applied only after Buffer.concat, and Jest output is converted into another full string before parsing. Memory therefore scales with child output instead of the configured diagnostic tail.

Affected code:

- [testsPassing.ts](../../src/harness/adapters/out/sensors/testsPassing.ts)
- [typecheckClean.ts](../../src/harness/adapters/out/sensors/typecheckClean.ts)
- [acceptanceRunner.ts](../../src/harness/domain/workflow/plans/acceptanceRunner.ts)

## Goals

- Bound in-memory child output independently for stdout and stderr.
- Preserve an 8 KiB diagnostic tail by default.
- Support Jest summary extraction without retaining terminal output.
- Make truncation visible to callers and traces.
- Terminate commands that exceed a configurable hard output ceiling when requested.

## Non-goals

- Replace Node child_process.
- Stream live output to the MCP client.
- Store complete test output in runtime traces.

## Proposed design

### Bounded collector

Add a pure bounded byte collector under src/harness/domain/execution. It must:

- accept Buffer chunks;
- retain only the newest tailBytes;
- track totalBytes and droppedBytes;
- expose truncated;
- avoid Buffer.concat over all historical chunks;
- cap the number of retained segments or compact incrementally.

Default limits:

| Setting | Default |
| --- | ---: |
| tailBytes per stream | 8 KiB |
| soft capture limit per stream | 1 MiB |
| hard combined output limit | 16 MiB |
| hard-limit behavior | terminate child and return outputLimitExceeded |

The caller may lower limits. Raising a hard limit above 64 MiB must require an explicit unsafe override in application code, not only user input.

### Sensor execution

Replace runShell raw strings with a result containing bounded tails and counters:

- stdoutTail;
- stderrTail;
- stdoutBytes;
- stderrBytes;
- stdoutDroppedBytes;
- stderrDroppedBytes;
- outputTruncated;
- outputLimitExceeded.

For default Jest execution:

1. write JSON results to a temporary file using Jest outputFile;
2. keep console stdout/stderr bounded;
3. reject a JSON result file above 32 MiB before reading;
4. parse only fields required for TestsPassingReport;
5. remove the temporary file in finally.

Custom exit-code sensors never need complete output.

### Acceptance execution

Use the same collector. A plan acceptance run persists only tails and counters. Exceeding the hard limit fails the acceptance predicate with a stable reason.

## Compatibility

- Keep existing tailStdout and tailStderr fields.
- Add optional counters so older persisted plan tracking remains readable.
- Preserve timeout and exit-code semantics.
- Keep testCommand arrays and shell:false behavior.

## Work breakdown

1. Implement and unit-test the bounded collector.
2. Refactor acceptance runner.
3. Refactor shared sensor runner.
4. Move Jest JSON to a temporary result file.
5. Add output-limit configuration with clamped values.
6. Add observability fields to sensor and acceptance traces.

## Acceptance criteria

- A child that emits 100 MiB does not retain more than configured tails plus 8 MiB process overhead attributable to capture.
- No array grows with the total number of output chunks.
- Acceptance returns at most tailBytes per stream.
- Typecheck and exit-code sensor paths never materialize full output strings.
- Jest result files above 32 MiB fail with resultFileTooLarge.
- Timeout, spawn error, non-zero exit, malformed Jest JSON, and output-limit paths have regression tests.
- npm run build and the complete Jest suite pass.

## Rollout and rollback

Ship behind internal defaults, not a user-facing feature flag. Preserve legacy result fields. Roll back by restoring the old runner only if bounded capture breaks command completion; never roll back the hard ceiling without an incident-specific patch.

## Observability

Record byte counters, truncation, termination reason, duration, and command basename. Never record full command output.


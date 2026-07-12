/**
 * Built-in `typecheck-clean` sensor.
 *
 * Runs `npx tsc --noEmit` (or a configured `command` argv array) and passes
 * iff exit code is 0. On failure, captures the tail of stderr (last 50 lines)
 * as `output.tail`.
 *
 * Shell safety: spawn(..., { shell: false }) with explicit argv array.
 *
 * Boundary: this sensor lives under `src/harness/adapters/out/sensors` and may
 * not import workflow internals.
 */

import type {
  HarnessSensorDefinition,
  HarnessSensorExecutionInput,
  HarnessSensorExecutionResult,
} from '../../../application/sensors/sensorsService';
import {
  DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
  DEFAULT_SUBPROCESS_TAIL_BYTES,
} from '../../../domain/execution';
import { runShell, subprocessDetails } from './testsPassing';

export interface TypecheckCleanOptions {
  command?: string[];
  timeoutMs?: number;
  tailLines?: number;
  tailBytes?: number;
  hardOutputLimitBytes?: number;
}

const DEFAULT_COMMAND: string[] = ['npx', 'tsc', '--noEmit'];
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TAIL_LINES = 50;

function readOptions(input: HarnessSensorExecutionInput): Required<TypecheckCleanOptions> {
  const ctx = (input.context && typeof input.context === 'object' ? input.context : {}) as TypecheckCleanOptions;
  const meta = (input.metadata && typeof input.metadata === 'object'
    ? (input.metadata as Record<string, unknown>)
    : {}) as TypecheckCleanOptions;
  const cmd = ctx.command ?? meta.command;
  return {
    command: Array.isArray(cmd) && cmd.length > 0 ? cmd : DEFAULT_COMMAND,
    timeoutMs: ctx.timeoutMs ?? meta.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tailLines: ctx.tailLines ?? meta.tailLines ?? DEFAULT_TAIL_LINES,
    tailBytes: ctx.tailBytes ?? meta.tailBytes ?? DEFAULT_SUBPROCESS_TAIL_BYTES,
    hardOutputLimitBytes:
      ctx.hardOutputLimitBytes ?? meta.hardOutputLimitBytes ?? DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
  };
}

function tailLines(s: string, n: number): string {
  if (!s) return '';
  const lines = s.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export async function executeTypecheckClean(
  repoPath: string,
  input: HarnessSensorExecutionInput
): Promise<HarnessSensorExecutionResult> {
  const opts = readOptions(input);

  const result = await runShell(opts.command, repoPath, opts.timeoutMs, {
    tailBytes: opts.tailBytes,
    hardCombinedOutputBytes: opts.hardOutputLimitBytes,
  });
  const details = subprocessDetails(result, opts.command);

  if (result.spawnError) {
    return {
      status: 'failed',
      summary: `typecheck-clean: spawn error: ${result.spawnError}`,
      evidence: [`command: ${opts.command.join(' ')}`],
      details,
    };
  }

  if (result.outputLimitExceeded) {
    return {
      status: 'failed',
      summary: 'typecheck-clean: outputLimitExceeded',
      evidence: [`command: ${opts.command.join(' ')}`, result.stderrTail].filter(Boolean),
      details,
    };
  }

  if (result.timedOut) {
    return {
      status: 'failed',
      summary: `typecheck-clean: timed out after ${opts.timeoutMs}ms`,
      evidence: [
        `command: ${opts.command.join(' ')}`,
        tailLines(result.stderrTail, opts.tailLines),
      ].filter(Boolean),
      details,
    };
  }

  if (result.exitCode === 0) {
    return {
      status: 'passed',
      summary: 'typecheck-clean: tsc reported no errors',
      evidence: [`command: ${opts.command.join(' ')}`],
      details,
    };
  }

  // tsc writes diagnostics to stdout, errors are typically there. Capture
  // both tails so the operator sees what went wrong regardless of where
  // they landed.
  const stderrTail = tailLines(result.stderrTail, opts.tailLines);
  const stdoutTail = tailLines(result.stdoutTail, opts.tailLines);
  const combinedTail = [stdoutTail, stderrTail].filter(Boolean).join('\n');

  return {
    status: 'failed',
    summary: `typecheck-clean: tsc exit ${result.exitCode}`,
    evidence: [`command: ${opts.command.join(' ')}`, combinedTail].filter(Boolean) as string[],
    output: { exitCode: result.exitCode, tail: combinedTail },
    details,
  };
}

export function createTypecheckCleanSensor(repoPath: string): HarnessSensorDefinition {
  return {
    id: 'typecheck-clean',
    name: 'Typecheck Clean',
    description: 'Runs the TypeScript compiler in --noEmit mode and requires zero errors.',
    severity: 'critical',
    blocking: true,
    execute: (input) => executeTypecheckClean(repoPath, input),
  };
}

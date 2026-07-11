/**
 * Acceptance Runner
 *
 * Executes a step's acceptance predicate and returns a structured result.
 * Shell safety: we always spawn with `shell: false` and require `command` to
 * be an argv array. No shell interpolation is performed.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import {
  BoundedByteCollector,
  DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
  DEFAULT_SUBPROCESS_TAIL_BYTES,
  resolveSubprocessOutputLimits,
} from '../../execution';
import type { StepAcceptanceRun, StepAcceptanceSpec } from './executionTypes';

export const ACCEPTANCE_TAIL_LIMIT_BYTES = DEFAULT_SUBPROCESS_TAIL_BYTES;
export const ACCEPTANCE_DEFAULT_TIMEOUT_MS = 60_000;

export class AcceptanceFailedError extends Error {
  readonly run: StepAcceptanceRun;
  readonly planSlug?: string;
  readonly phaseId?: string;
  readonly stepIndex?: number;

  constructor(
    message: string,
    run: StepAcceptanceRun,
    ctx?: { planSlug?: string; phaseId?: string; stepIndex?: number }
  ) {
    super(message);
    this.name = 'AcceptanceFailedError';
    this.run = run;
    this.planSlug = ctx?.planSlug;
    this.phaseId = ctx?.phaseId;
    this.stepIndex = ctx?.stepIndex;
  }
}

export interface AcceptanceContext {
  repoPath: string;
  outputLimits?: {
    tailBytes?: number;
    hardCombinedOutputBytes?: number;
  };
}

export async function runAcceptance(
  spec: StepAcceptanceSpec,
  ctx: AcceptanceContext
): Promise<StepAcceptanceRun> {
  if (spec.kind !== 'shell') {
    throw new Error(`Unsupported acceptance kind: ${String(spec.kind)}`);
  }
  if (!Array.isArray(spec.command) || spec.command.length === 0) {
    throw new Error('acceptance.command must be a non-empty string[]');
  }

  const [executable, ...args] = spec.command;
  const timeoutMs = spec.timeoutMs ?? ACCEPTANCE_DEFAULT_TIMEOUT_MS;
  const cwd = spec.workingDir ?? ctx.repoPath;
  const startedAt = Date.now();
  const limits = resolveSubprocessOutputLimits({
    tailBytes: ctx.outputLimits?.tailBytes ?? ACCEPTANCE_TAIL_LIMIT_BYTES,
    hardCombinedOutputBytes:
      ctx.outputLimits?.hardCombinedOutputBytes ?? DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
  });
  const commandBasename = path.basename(executable);

  return new Promise<StepAcceptanceRun>((resolve) => {
    let settled = false;
    let timedOut = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      resolve({
        ran_at: startedAt,
        passed: false,
        exitCode: null,
        tailStdout: '',
        tailStderr: `spawn error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutDroppedBytes: 0,
        stderrDroppedBytes: 0,
        outputTruncated: false,
        outputLimitExceeded: false,
        terminationReason: 'spawnError',
        commandBasename,
      });
      return;
    }

    const stdout = new BoundedByteCollector(limits.tailBytes);
    const stderr = new BoundedByteCollector(limits.tailBytes);
    let outputLimitExceeded = false;
    let spawnError: Error | undefined;

    let timer: NodeJS.Timeout;
    const capture = (collector: BoundedByteCollector, chunk: Buffer) => {
      collector.append(chunk);
      if (
        !outputLimitExceeded &&
        stdout.totalBytes + stderr.totalBytes > limits.hardCombinedOutputBytes
      ) {
        outputLimitExceeded = true;
        clearTimeout(timer);
        child.kill('SIGKILL');
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));

    timer = setTimeout(() => {
      if (outputLimitExceeded) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ran_at: startedAt,
        passed: !timedOut && !outputLimitExceeded && !spawnError && exitCode === 0,
        exitCode,
        tailStdout: stdout.toString(),
        tailStderr: stderr.toString(),
        durationMs: Date.now() - startedAt,
        timedOut,
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutDroppedBytes: stdout.droppedBytes,
        stderrDroppedBytes: stderr.droppedBytes,
        outputTruncated: stdout.truncated || stderr.truncated,
        outputLimitExceeded,
        terminationReason: outputLimitExceeded
          ? 'outputLimit'
          : timedOut
            ? 'timeout'
            : spawnError
              ? 'spawnError'
              : undefined,
        commandBasename,
      });
    };

    // Keep the error diagnostic inside the same bounded stderr collector and
    // wait for close so failed and killed children are reaped.
    child.on('error', (err) => {
      spawnError = err;
      stderr.append(Buffer.from(`spawn error: ${err.message}`));
    });
    child.on('close', (code) => finish(code));
  });
}

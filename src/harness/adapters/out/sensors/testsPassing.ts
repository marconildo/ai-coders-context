/**
 * Built-in `tests-passing` sensor.
 *
 * Two modes:
 *   - `kind: 'jest'` (default): runs `npm test -- --runInBand --json`, writes
 *     structured results to a size-checked temporary file, and keeps console
 *     output bounded. Configured commands spool structured stdout to disk.
 *     Passes iff exit code 0 AND `numFailedTests === 0`.
 *   - `kind: 'exit-code'`: runs the configured `testCommand` argv array and
 *     passes iff the process exits with code 0. Use this for non-jest test
 *     runners.
 *
 * Shell safety: spawn(..., { shell: false }) with an explicit argv array.
 *
 * Boundary: this sensor lives under `src/harness/adapters/out/sensors` and may
 * not import workflow internals.
 */

import { spawn } from 'child_process';
import { closeSync, openSync, promises as fs, writeSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  HarnessSensorDefinition,
  HarnessSensorExecutionInput,
  HarnessSensorExecutionResult,
} from '../../../application/sensors/sensorsService';
import {
  BoundedByteCollector,
  DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
  DEFAULT_SUBPROCESS_TAIL_BYTES,
  resolveSubprocessOutputLimits,
  subprocessSpawnOptions,
  terminateProcessTree,
  type SubprocessOutputLimitsInput,
} from '../../../domain/execution';
import { projectJestResultFile, type ProjectedJestResultRead } from './jestResultProjector';

export interface TestsPassingOptions {
  kind?: 'jest' | 'exit-code';
  testCommand?: string[];
  timeoutMs?: number;
  tailBytes?: number;
  hardOutputLimitBytes?: number;
}

export interface TestsPassingReport {
  numPassedTests: number;
  numFailedTests: number;
  numTotalTestSuites: number;
  failures: Array<{ name: string; message: string }>;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_JEST_COMMAND: string[] = ['npm', 'test', '--', '--runInBand', '--json'];

interface ResolvedTestsPassingOptions extends Required<TestsPassingOptions> {
  usesDefaultCommand: boolean;
}

function readOptions(input: HarnessSensorExecutionInput): ResolvedTestsPassingOptions {
  const ctx = (input.context && typeof input.context === 'object' ? input.context : {}) as TestsPassingOptions;
  const meta = (input.metadata && typeof input.metadata === 'object'
    ? (input.metadata as Record<string, unknown>)
    : {}) as TestsPassingOptions;
  const kind = (ctx.kind ?? meta.kind ?? 'jest') as 'jest' | 'exit-code';
  const cmd = ctx.testCommand ?? meta.testCommand;
  return {
    kind,
    testCommand: Array.isArray(cmd) && cmd.length > 0 ? cmd : DEFAULT_JEST_COMMAND,
    timeoutMs: ctx.timeoutMs ?? meta.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tailBytes: ctx.tailBytes ?? meta.tailBytes ?? DEFAULT_SUBPROCESS_TAIL_BYTES,
    hardOutputLimitBytes:
      ctx.hardOutputLimitBytes ?? meta.hardOutputLimitBytes ?? DEFAULT_SUBPROCESS_HARD_OUTPUT_BYTES,
    usesDefaultCommand: !Array.isArray(cmd) || cmd.length === 0,
  };
}

export interface SpawnResult {
  exitCode: number | null;
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutDroppedBytes: number;
  stderrDroppedBytes: number;
  outputTruncated: boolean;
  outputLimitExceeded: boolean;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
  terminationReason?: 'timeout' | 'outputLimit' | 'spawnError';
}

function writeComplete(fd: number, chunk: Buffer): void {
  let offset = 0;
  while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
}

function emptySpawnResult(startedAt: number, spawnError: string): SpawnResult {
  return {
    exitCode: null,
    stdoutTail: '',
    stderrTail: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0,
    outputTruncated: false,
    outputLimitExceeded: false,
    timedOut: false,
    durationMs: Date.now() - startedAt,
    spawnError,
    terminationReason: 'spawnError',
  };
}

export function runShell(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  outputLimits: SubprocessOutputLimitsInput = {},
  structuredStdoutPath?: string
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const [executable, ...args] = argv;
    const limits = resolveSubprocessOutputLimits(outputLimits);
    let structuredStdoutFd: number | undefined;
    if (structuredStdoutPath) {
      try {
        structuredStdoutFd = openSync(structuredStdoutPath, 'w');
      } catch (err) {
        resolve(emptySpawnResult(startedAt, err instanceof Error ? err.message : String(err)));
        return;
      }
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
        ...subprocessSpawnOptions(),
      });
    } catch (err) {
      if (structuredStdoutFd !== undefined) closeSync(structuredStdoutFd);
      resolve(emptySpawnResult(startedAt, err instanceof Error ? err.message : String(err)));
      return;
    }

    const stdout = new BoundedByteCollector(limits.tailBytes);
    const stderr = new BoundedByteCollector(limits.tailBytes);
    let timedOut = false;
    let outputLimitExceeded = false;
    let settled = false;
    let spawnError: Error | undefined;
    let exitCodeSeen: number | null = null;
    let termination: Promise<void> | undefined;

    let timer: NodeJS.Timeout;
    const requestTermination = () => {
      if (termination) return;
      clearTimeout(timer);
      termination = terminateProcessTree(child);
      void termination.then(() => {
        // A hostile descendant may keep inherited pipes open. Once the whole
        // tree has received the forced signal, stop waiting on those streams.
        child.stdout?.destroy();
        child.stderr?.destroy();
        void finish(exitCodeSeen);
      });
    };
    const capture = (collector: BoundedByteCollector, chunk: Buffer) => {
      collector.append(chunk);
      if (collector === stdout && structuredStdoutFd !== undefined) {
        try {
          writeComplete(structuredStdoutFd, chunk);
        } catch (err) {
          spawnError = err instanceof Error ? err : new Error(String(err));
          requestTermination();
        }
      }
      if (
        !outputLimitExceeded &&
        stdout.totalBytes + stderr.totalBytes > limits.hardCombinedOutputBytes
      ) {
        outputLimitExceeded = true;
        requestTermination();
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));

    timer = setTimeout(() => {
      if (outputLimitExceeded) return;
      timedOut = true;
      requestTermination();
    }, timeoutMs);

    const finish = async (exitCode: number | null) => {
      if (settled) return;
      if (termination) await termination;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (structuredStdoutFd !== undefined) {
        closeSync(structuredStdoutFd);
        structuredStdoutFd = undefined;
      }
      resolve({
        exitCode,
        stdoutTail: stdout.toString(),
        stderrTail: stderr.toString(),
        stdoutBytes: stdout.totalBytes,
        stderrBytes: stderr.totalBytes,
        stdoutDroppedBytes: stdout.droppedBytes,
        stderrDroppedBytes: stderr.droppedBytes,
        outputTruncated: stdout.truncated || stderr.truncated,
        outputLimitExceeded,
        timedOut,
        durationMs: Date.now() - startedAt,
        spawnError: spawnError?.message,
        terminationReason: outputLimitExceeded
          ? 'outputLimit'
          : timedOut
            ? 'timeout'
            : spawnError
              ? 'spawnError'
              : undefined,
      });
    };

    // Wait for close after error/kill so the child is always reaped before the
    // promise resolves.
    child.on('error', (err) => { spawnError = err; });
    child.on('exit', (code) => { exitCodeSeen = code; });
    child.on('close', (code) => { void finish(code); });
  });
}

export type JestResultFileRead = ProjectedJestResultRead;

export async function readJestResultFile(resultPath: string): Promise<JestResultFileRead> {
  return projectJestResultFile(resultPath);
}

export function subprocessDetails(result: SpawnResult, argv: string[]): Record<string, unknown> {
  return {
    command: path.basename(argv[0] ?? ''),
    durationMs: result.durationMs,
    stdoutBytes: result.stdoutBytes,
    stderrBytes: result.stderrBytes,
    stdoutDroppedBytes: result.stdoutDroppedBytes,
    stderrDroppedBytes: result.stderrDroppedBytes,
    outputTruncated: result.outputTruncated,
    outputLimitExceeded: result.outputLimitExceeded,
    terminationReason: result.terminationReason,
  };
}

export async function executeTestsPassing(
  repoPath: string,
  input: HarnessSensorExecutionInput
): Promise<HarnessSensorExecutionResult> {
  const opts = readOptions(input);
  let resultDirectory: string | undefined;
  let resultPath: string | undefined;
  let command = opts.testCommand;
  let structuredStdoutPath: string | undefined;
  if (opts.kind === 'jest') {
    resultDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dotcontext-jest-'));
    resultPath = path.join(resultDirectory, 'result.json');
    if (opts.usesDefaultCommand) command = [...DEFAULT_JEST_COMMAND, '--outputFile', resultPath];
    else structuredStdoutPath = resultPath;
  }

  try {
    const result = await runShell(command, repoPath, opts.timeoutMs, {
      tailBytes: opts.tailBytes,
      hardCombinedOutputBytes: opts.hardOutputLimitBytes,
    }, structuredStdoutPath);

    const details = subprocessDetails(result, command);

    if (result.spawnError) {
      return {
        status: 'failed',
        summary: `tests-passing: spawn error: ${result.spawnError}`,
        evidence: [`command: ${command.join(' ')}`],
        details,
      };
    }

    if (result.outputLimitExceeded) {
      return {
        status: 'failed',
        summary: 'tests-passing: outputLimitExceeded',
        evidence: [`command: ${command.join(' ')}`, result.stderrTail].filter(Boolean),
        details,
      };
    }

    if (result.timedOut) {
      return {
        status: 'failed',
        summary: `tests-passing: timed out after ${opts.timeoutMs}ms`,
        evidence: [`command: ${command.join(' ')}`, result.stderrTail].filter(Boolean),
        details,
      };
    }

    if (opts.kind === 'exit-code') {
      if (result.exitCode === 0) {
        return {
          status: 'passed',
          summary: 'tests-passing: exit 0',
          evidence: [`command: ${command.join(' ')}`],
          details,
        };
      }
      return {
        status: 'failed',
        summary: `tests-passing: exit ${result.exitCode}`,
        evidence: [`command: ${command.join(' ')}`, result.stderrTail].filter(Boolean),
        details,
      };
    }

    // Default Jest writes with --outputFile; custom Jest commands have stdout
    // spooled directly to the same size-checked structured-output path.
    const fileRead = resultPath ? await readJestResultFile(resultPath) : undefined;
    if (fileRead?.status === 'resultFileTooLarge') {
      return {
        status: 'failed',
        summary: 'tests-passing: resultFileTooLarge',
        evidence: [`command: ${command.join(' ')}`],
        details,
      };
    }
    if (fileRead?.status !== 'ok') {
      return {
        status: 'failed',
        summary: 'tests-passing: could not parse jest --json output',
        evidence: [
          `command: ${command.join(' ')}`,
          `exitCode: ${result.exitCode}`,
          result.stdoutTail,
          result.stderrTail,
        ].filter(Boolean),
        details,
      };
    }

    const report: TestsPassingReport = fileRead.value;
    const { numPassedTests, numFailedTests, numTotalTestSuites, failures } = report;

    const passed = result.exitCode === 0 && numFailedTests === 0;
    if (passed) {
      return {
        status: 'passed',
        summary: `tests-passing: ${numPassedTests} passed across ${numTotalTestSuites} suites`,
        evidence: [`command: ${command.join(' ')}`],
        output: report,
        details,
      };
    }

    return {
      status: 'failed',
      summary: `tests-passing: ${numFailedTests} failed (exit ${result.exitCode})`,
      evidence: failures.slice(0, 10).map((f) => `${f.name}: ${f.message.split('\n')[0]}`),
      output: report,
      details,
    };
  } finally {
    if (resultDirectory) await fs.rm(resultDirectory, { recursive: true, force: true });
  }
}

export function createTestsPassingSensor(repoPath: string): HarnessSensorDefinition {
  return {
    id: 'tests-passing',
    name: 'Tests Passing',
    description: 'Runs the project test suite and verifies zero failures.',
    severity: 'critical',
    blocking: true,
    execute: (input) => executeTestsPassing(repoPath, input),
  };
}

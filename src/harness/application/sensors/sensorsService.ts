/**
 * Harness Sensors Service
 *
 * Registers and executes quality sensors, then persists the run as a trace
 * entry in the shared harness runtime state.
 */

import { randomUUID } from 'crypto';
import type {
  AppendTraceInput,
  HarnessRuntimeStatePort,
} from '../../adapters/out/runtimeState/runtimeStateService';
import type { RuntimeHistoryPage, RuntimeHistoryQuery } from '../history/runtimeHistory';

export type HarnessSensorSeverity = 'info' | 'warning' | 'critical';
export type HarnessSensorStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

export interface HarnessSensorExecutionInput {
  sessionId: string;
  contractId?: string;
  context?: unknown;
  metadata?: Record<string, unknown>;
}

export interface HarnessSensorExecutionResult {
  status: HarnessSensorStatus;
  summary: string;
  evidence?: string[];
  output?: unknown;
  details?: Record<string, unknown>;
}

export interface HarnessSensorDefinition {
  id: string;
  name: string;
  description?: string;
  severity?: HarnessSensorSeverity;
  blocking?: boolean;
  execute: (input: HarnessSensorExecutionInput) => Promise<HarnessSensorExecutionResult> | HarnessSensorExecutionResult;
}

export interface HarnessSensorRun extends HarnessSensorExecutionResult {
  id: string;
  sensorId: string;
  sessionId: string;
  contractId?: string;
  severity: HarnessSensorSeverity;
  blocking: boolean;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessBackpressurePolicy {
  blockOnWarnings?: boolean;
  requireEvidence?: boolean;
}

export interface HarnessBackpressureResult {
  blocked: boolean;
  reasons: string[];
  blockingRuns: HarnessSensorRun[];
}

export interface HarnessSensorsServiceOptions {
  stateService: HarnessRuntimeStatePort;
}

export class HarnessSensorsService {
  private readonly definitions = new Map<string, HarnessSensorDefinition>();

  constructor(private readonly options: HarnessSensorsServiceOptions) {}

  registerSensor(definition: HarnessSensorDefinition): HarnessSensorDefinition {
    this.definitions.set(definition.id, definition);
    return definition;
  }

  listSensors(): HarnessSensorDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  getSensor(sensorId: string): HarnessSensorDefinition | undefined {
    return this.definitions.get(sensorId);
  }

  async runSensor(
    sensorId: string,
    input: HarnessSensorExecutionInput
  ): Promise<HarnessSensorRun> {
    const definition = this.getSensor(sensorId);
    if (!definition) {
      throw new Error(`Sensor not found: ${sensorId}`);
    }

    const createdAt = new Date().toISOString();
    const result = await definition.execute(input);
    const severity = definition.severity ?? 'critical';
    const run: HarnessSensorRun = {
      id: randomUUID(),
      sensorId,
      sessionId: input.sessionId,
      contractId: input.contractId,
      severity,
      blocking: definition.blocking ?? severity === 'critical',
      createdAt,
      status: result.status,
      summary: result.summary,
      evidence: result.evidence,
      output: result.output,
      details: result.details,
      metadata: input.metadata,
    };

    const traceInput: AppendTraceInput = {
      level: result.status === 'passed' ? 'info' : result.status === 'skipped' ? 'debug' : result.status === 'blocked' ? 'warn' : severity === 'critical' ? 'error' : 'warn',
      event: 'sensor.run',
      message: `${definition.name}: ${result.summary}`,
      data: { run },
    };

    await this.options.stateService.appendTrace(input.sessionId, traceInput);
    return run;
  }

  async getLatestSessionSensorRuns(sessionId: string): Promise<HarnessSensorRun[]> {
    const summary = await this.options.stateService.getSensorSummary(sessionId);
    return Object.values(summary.latestBySensor) as HarnessSensorRun[];
  }

  async getSessionSensorRunCount(sessionId: string): Promise<number> {
    const summary = await this.options.stateService.getSensorSummary(sessionId);
    return Math.max(Object.keys(summary.latestBySensor).length, summary.runCount ?? 0);
  }

  async getSessionSensorRunPage(
    sessionId: string,
    query: RuntimeHistoryQuery = {}
  ): Promise<RuntimeHistoryPage<HarnessSensorRun>> {
    const page = await this.options.stateService.listTracePage(sessionId, {
      ...query,
      event: 'sensor.run',
    });
    const items = page.items
      .map((trace) => trace.data?.run)
      .filter((run): run is HarnessSensorRun => Boolean(run && typeof run === 'object'));
    return {
      ...page,
      items,
      recordsReturned: items.length,
    };
  }

  /** @deprecated Use getSessionSensorRunPage for history or getLatestSessionSensorRuns for status. */
  async getSessionSensorRuns(sessionId: string): Promise<HarnessSensorRun[]> {
    const runs: HarnessSensorRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.getSessionSensorRunPage(sessionId, {
        limit: 1000,
        cursor,
        direction: 'oldest',
      });
      runs.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return runs;
  }

  evaluateBackpressure(
    runs: HarnessSensorRun[],
    policy: HarnessBackpressurePolicy = {}
  ): HarnessBackpressureResult {
    const blockingRuns = runs.filter((run) => {
      if (run.status === 'blocked') {
        return true;
      }
      if (run.status === 'failed' && run.blocking) {
        return true;
      }
      if (policy.blockOnWarnings && run.severity === 'warning' && run.status !== 'passed') {
        return true;
      }
      if (policy.requireEvidence && run.status !== 'passed' && (!run.evidence || run.evidence.length === 0)) {
        return true;
      }
      return false;
    });

    return {
      blocked: blockingRuns.length > 0,
      reasons: blockingRuns.map((run) => `${run.sensorId}: ${run.summary}`),
      blockingRuns,
    };
  }
}

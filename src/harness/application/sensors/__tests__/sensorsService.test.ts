import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { HarnessRuntimeStateService } from '../../../adapters/out/runtimeState/runtimeStateService';
import { HarnessSensorsService } from '../sensorsService';

describe('HarnessSensorsService', () => {
  let tempDir: string;
  let stateService: HarnessRuntimeStateService;
  let service: HarnessSensorsService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-sensors-'));
    stateService = new HarnessRuntimeStateService({ repoPath: tempDir });
    service = new HarnessSensorsService({ stateService });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('runs sensors and records traces', async () => {
    service.registerSensor({
      id: 'typecheck',
      name: 'Typecheck',
      severity: 'critical',
      execute: async () => ({
        status: 'failed',
        summary: 'Type errors found',
        evidence: ['tsc output'],
      }),
    });

    const session = await stateService.createSession({ name: 'quality-run' });
    const run = await service.runSensor('typecheck', { sessionId: session.id });
    const traces = await stateService.listTraces(session.id);
    const storedRuns = await service.getSessionSensorRuns(session.id);

    expect(run.status).toBe('failed');
    expect(traces.some((trace) => trace.event === 'sensor.run')).toBe(true);
    expect(storedRuns).toHaveLength(1);
    expect(storedRuns[0].sensorId).toBe('typecheck');
    expect(service.evaluateBackpressure([run]).blocked).toBe(true);
  });

  it('keeps paginated run history separate from the latest summary', async () => {
    const session = await stateService.createSession({ name: 'sensor-history' });
    let index = 0;
    service.registerSensor({ id: 'tests', name: 'Tests', execute: () => ({ status: index++ === 0 ? 'failed' : 'passed', summary: `run-${index}` }) });
    await service.runSensor('tests', { sessionId: session.id });
    await service.runSensor('tests', { sessionId: session.id });

    const first = await service.getSessionSensorRunPage(session.id, { limit: 1, direction: 'oldest' });
    const second = await service.getSessionSensorRunPage(session.id, { limit: 1, direction: 'oldest', cursor: first.nextCursor });
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(await service.getSessionSensorRuns(session.id)).toHaveLength(2);
    expect(await service.getLatestSessionSensorRuns(session.id)).toHaveLength(1);
    expect(await service.getSessionSensorRunCount(session.id)).toBe(2);
  });
});

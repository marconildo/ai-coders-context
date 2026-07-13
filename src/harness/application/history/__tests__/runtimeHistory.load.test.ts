import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { HarnessRuntimeStateService } from '../../../adapters/out/runtimeState/runtimeStateService';
import { HarnessReplayService } from '../../replay/replayService';

const loadDescribe = process.env.DOTCONTEXT_RUNTIME_LOAD_TESTS === '1' ? describe : describe.skip;

loadDescribe('runtime history load acceptance', () => {
  jest.setTimeout(120_000);
  let tempDir: string;
  beforeEach(async () => { tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-history-load-')); });
  afterEach(async () => { await fs.remove(tempDir); });

  it('returns 100 records from one million JSONL lines with bounded incremental RSS', async () => {
    const state = new HarnessRuntimeStateService({ repoPath: tempDir });
    const session = await state.createSession({ name: 'million-lines' });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const line = `${JSON.stringify({ id: 'load', sessionId: session.id, level: 'info', event: 'load', message: 'bounded', createdAt: '2026-01-01T00:00:00.000Z', data: { payload: 'x'.repeat(900) } })}\n`;
    const block = line.repeat(10_000);
    const handle = await fs.open(traceFile, 'w');
    try { for (let index = 0; index < 100; index += 1) await fs.write(handle, block); } finally { await fs.close(handle); }
    global.gc?.();
    const before = process.memoryUsage().rss;
    const page = await state.listTracePage(session.id, { limit: 100 });
    global.gc?.();
    expect(page.items).toHaveLength(100);
    expect(process.memoryUsage().rss - before).toBeLessThan(32 * 1024 * 1024);

    global.gc?.();
    const replayBefore = process.memoryUsage().rss;
    const replay = await new HarnessReplayService({ repoPath: tempDir }).buildReplay(session.id, { maxEvents: 100, includePayloads: false });
    global.gc?.();
    expect(replay.events).toHaveLength(100);
    expect(replay.events.every(event => event.record === undefined)).toBe(true);
    expect(process.memoryUsage().rss - replayBefore).toBeLessThan(32 * 1024 * 1024);
  });

  it('keeps a 1,000-session page bounded', async () => {
    const sessionsDir = path.join(tempDir, '.context', 'runtime', 'sessions');
    for (let index = 0; index < 1000; index += 1) {
      const id = `session-${index.toString().padStart(4, '0')}`;
      await fs.outputJson(path.join(sessionsDir, id, 'session.json'), { id, name: id, status: 'completed', repoPath: tempDir, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: new Date(1_700_000_000_000 + index).toISOString(), startedAt: '2026-01-01T00:00:00.000Z', traceCount: 0, artifactCount: 0, checkpointCount: 0, checkpoints: [] });
    }
    const page = await new HarnessRuntimeStateService({ repoPath: tempDir }).listSessionPage();
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(true);
    expect(page.recordsScanned).toBe(1000);
  });

  it('keeps a page of 100 valid near-limit records within the byte and RSS budgets', async () => {
    const state = new HarnessRuntimeStateService({ repoPath: tempDir });
    const session = await state.createSession({ name: 'large-records' });
    const traceFile = path.join(tempDir, '.context', 'runtime', 'sessions', session.id, 'trace.jsonl');
    const records = Array.from({ length: 100 }, (_, index) => JSON.stringify({
      id: `large-${index}`,
      sessionId: session.id,
      level: 'info',
      event: 'large',
      message: `large-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      data: { payload: 'x'.repeat(900 * 1024) },
    }));
    await fs.writeFile(traceFile, `${records.join('\n')}\n`);
    global.gc?.();
    const before = process.memoryUsage().rss;

    const page = await state.listTracePage(session.id, { limit: 100, direction: 'oldest' });

    global.gc?.();
    expect(page.items).toHaveLength(1);
    expect(page.returnedBytes).toBeLessThanOrEqual(page.byteBudget);
    expect(page.byteLimited).toBe(true);
    expect(page.nextCursor).toBeDefined();
    expect(process.memoryUsage().rss - before).toBeLessThan(32 * 1024 * 1024);
  });
});

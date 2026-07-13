import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { HarnessRuntimeStateService } from '../../../harness/adapters/out/runtimeState/runtimeStateService';
import { WorkflowService } from '../../../harness/application/workflow/workflowService';
import { clearMcpActionSessionCache, getMcpActionSessionCacheMetrics, getMcpActionSessionCacheSize, logMcpAction } from '../actionLogger';

describe('logMcpAction', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-action-logger-'));
    await fs.ensureDir(path.join(tempDir, '.context'));
    await fs.writeJson(path.join(tempDir, 'package.json'), {
      name: 'mcp-action-logger-test',
      version: '1.0.0',
      scripts: {
        build: 'node -e "process.exit(0)"',
      },
    }, { spaces: 2 });
  });

  afterEach(async () => {
    clearMcpActionSessionCache();
    await fs.remove(tempDir);
  });

  it('records MCP activity in a harness session when no workflow binding exists', async () => {
    await logMcpAction(tempDir, {
      tool: 'context',
      action: 'check',
      status: 'success',
      details: {
        prompt: 'sensitive prompt',
        nested: {
          content: 'secret content',
        },
      },
    });

    const state = new HarnessRuntimeStateService({ repoPath: tempDir });
    const sessions = await state.listSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('mcp-activity');
    expect(sessions[0].metadata?.transport).toBe('mcp');

    const traces = await state.listTraces(sessions[0].id);
    const mcpTrace = traces.find((trace) => trace.event === 'mcp.tool.succeeded');
    expect(mcpTrace).toBeDefined();
    expect(mcpTrace?.data?.tool).toBe('context');
    expect((mcpTrace?.data as any).details.prompt).toBe('[redacted]');
    expect((mcpTrace?.data as any).details.nested.content).toBe('[redacted]');

    expect(await fs.pathExists(path.join(tempDir, '.context', 'workflow', 'actions.jsonl'))).toBe(false);
    expect(getMcpActionSessionCacheSize()).toBeLessThanOrEqual(64);
  });

  it('reuses the workflow harness session when one is active', async () => {
    const workflow = new WorkflowService(tempDir);
    await workflow.init({
      name: 'workflow-alpha',
      scale: 'SMALL',
      autonomous: true,
    });

    const before = await workflow.getHarnessStatus();
    expect(before).not.toBeNull();

    await logMcpAction(tempDir, {
      tool: 'workflow-status',
      action: 'read',
      status: 'success',
      details: {
        repoPath: tempDir,
      },
    });

    const after = await workflow.getHarnessStatus();
    expect(after).not.toBeNull();
    expect(after?.session.id).toBe(before?.session.id);
    expect(after?.session.traceCount).toBeGreaterThan(before?.session.traceCount || 0);
    expect(after?.sensorRuns).toEqual(before?.sensorRuns || []);

    const state = new HarnessRuntimeStateService({ repoPath: tempDir });
    const traces = await state.listTraces(after!.session.id);
    expect(traces.some((trace) => trace.event === 'mcp.tool.succeeded')).toBe(true);
    expect(await fs.pathExists(path.join(tempDir, '.context', 'workflow', 'actions.jsonl'))).toBe(false);
  });

  it('applies the repository MCP session TTL and expires without cross-repo cache keys', async () => {
    await fs.outputJson(path.join(tempDir, '.context', 'config', 'runtime.json'), {
      version: 1,
      caches: { mcpSessions: { maxEntries: 1, ttlMs: 1000 } },
    });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const entry = { tool: 'context', action: 'check', status: 'success' as const };
    await logMcpAction(tempDir, entry);
    await logMcpAction(tempDir, entry);
    expect(getMcpActionSessionCacheMetrics(tempDir)?.hits).toBe(1);
    now.mockReturnValue(2_001);
    await logMcpAction(tempDir, entry);
    expect(getMcpActionSessionCacheMetrics(tempDir)?.evictions.expired).toBe(1);
    expect(getMcpActionSessionCacheSize()).toBe(1);
    now.mockRestore();
    clearMcpActionSessionCache();
    expect(getMcpActionSessionCacheSize()).toBe(0);
  });

  it('never reuses a terminal MCP activity session', async () => {
    const state = new HarnessRuntimeStateService({ repoPath: tempDir });
    const terminal = await state.createSession({
      name: 'mcp-activity',
      metadata: { transport: 'mcp', purpose: 'tool-audit' },
    });
    await state.completeSession(terminal.id);

    await logMcpAction(tempDir, {
      tool: 'context',
      action: 'check',
      status: 'success',
    });

    const sessions = await state.listSessions();
    const activity = sessions.filter(session => session.name === 'mcp-activity');
    expect(activity).toHaveLength(2);
    expect(activity.find(session => session.id === terminal.id)?.status).toBe('completed');
    const replacement = activity.find(session => session.id !== terminal.id);
    expect(replacement?.status).toBe('active');
    expect((await state.listTraces(terminal.id)).some(trace => trace.event === 'mcp.tool.succeeded')).toBe(false);
    expect((await state.listTraces(replacement!.id)).some(trace => trace.event === 'mcp.tool.succeeded')).toBe(true);
  });
});

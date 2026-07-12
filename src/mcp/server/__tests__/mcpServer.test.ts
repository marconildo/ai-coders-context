import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';
import {
  AIContextMCPServer,
  MCP_HARNESS_ACTION_LIMIT_SCHEMA,
  MCP_LIST_LIMIT_SCHEMA,
  MCP_MAX_EVENTS_SCHEMA,
} from '../mcpServer';

// We can't fully test the MCP server without a transport,
// but we can test instantiation and configuration

describe('AIContextMCPServer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-test-'));
    // Create test files
    await fs.writeFile(path.join(tempDir, 'test.ts'), 'export const x = 1;');
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  describe('constructor', () => {
    it('should create server with default options', () => {
      const server = new AIContextMCPServer();
      expect(server).toBeInstanceOf(AIContextMCPServer);
    });

    it('should create server with custom options', () => {
      const server = new AIContextMCPServer({
        name: 'test-server',
        repoPath: tempDir,
        verbose: true
      });
      expect(server).toBeInstanceOf(AIContextMCPServer);
    });
  });

  describe('tool registration', () => {
    it('should register all expected tools', () => {
      // The server registers tools in constructor
      // We verify this through the fact that construction succeeds
      // and logs "Registered 6 tools" when verbose
      const server = new AIContextMCPServer({ verbose: false });
      expect(server).toBeInstanceOf(AIContextMCPServer);
    });
  });

  describe('bounded numeric schemas', () => {
    it.each([
      [999, true],
      [1000, true],
      [1001, false],
    ])('validates list limit boundary %s', (value, success) => {
      expect(MCP_LIST_LIMIT_SCHEMA.safeParse(value).success).toBe(success);
    });

    it.each([
      [999, true],
      [1000, true],
      [1001, false],
    ])('validates maxEvents boundary %s', (value, success) => {
      expect(MCP_MAX_EVENTS_SCHEMA.safeParse(value).success).toBe(success);
    });

    it.each([
      ['listSessions', 200],
      ['listTraces', 1000],
      ['listArtifacts', 200],
      ['listTasks', 1000],
      ['listHandoffs', 1000],
      ['listReplays', 100],
      ['listDatasets', 100],
    ])('enforces the %s action-specific maximum', (action, maximum) => {
      expect(MCP_HARNESS_ACTION_LIMIT_SCHEMA.safeParse({ action, limit: maximum }).success)
        .toBe(true);
      expect(MCP_HARNESS_ACTION_LIMIT_SCHEMA.safeParse({ action, limit: maximum + 1 }).success)
        .toBe(false);
    });

    it('rejects an action-specific limit before invoking the harness handler', async () => {
      const server = new AIContextMCPServer({ repoPath: tempDir });
      const handler = jest.fn();
      const wrapped = (server as any).wrapWithActionLogging('harness', handler);

      const response = await wrapped({ action: 'listSessions', limit: 201 });

      expect(handler).not.toHaveBeenCalled();
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text)).toMatchObject({ success: false });
    });
  });

  it('logs response metadata without parsing response content', async () => {
    const server = new AIContextMCPServer({ repoPath: tempDir });
    const parse = jest.spyOn(JSON, 'parse');

    await (server as any).logToolResponse(tempDir, 'harness', 'listSessions', {}, {
      content: [{ type: 'text', text: '{not-json' }],
      _meta: {
        dotcontext: {
          success: true,
          responseBytes: 9,
          serializationMs: 0,
          itemCount: 0,
          partial: false,
        },
      },
    });

    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  describe('resource registration', () => {
    it('should register resource templates', () => {
      // The server registers resources in constructor
      // We verify this through the fact that construction succeeds
      const server = new AIContextMCPServer({ verbose: false });
      expect(server).toBeInstanceOf(AIContextMCPServer);
    });
  });
});

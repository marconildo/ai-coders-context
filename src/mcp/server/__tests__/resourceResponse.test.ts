import * as fs from 'fs-extra';
import { promises as nodeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  createBoundedResourceJson,
  createBoundedResourceText,
  readBoundedFileResource,
} from '../resourceResponse';

describe('bounded MCP resources', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-resource-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(tempDir);
  });

  it('returns resource text at the UTF-8 budget and rejects budget + 1', () => {
    const at = createBoundedResourceText('context://codebase/compact', 'text/plain', 'é'.repeat(64), {
      payloadBudgetBytes: 128,
    });
    const above = createBoundedResourceText('context://codebase/compact', 'text/plain', `${'é'.repeat(64)}x`, {
      payloadBudgetBytes: 128,
    });

    expect(at.contents[0].text).toBe('é'.repeat(64));
    expect(JSON.parse(above.contents[0].text)).toMatchObject({
      success: false,
      errorCode: 'MCP_RESOURCE_TOO_LARGE',
      resourceBytes: 129,
      budgetBytes: 128,
    });
  });

  it('serializes JSON resources compactly through the same budget', () => {
    const response = createBoundedResourceJson('workflow://status', {
      name: 'workflow',
      phases: ['P', 'R', 'E', 'V', 'C'],
    });
    expect(response.contents[0].mimeType).toBe('application/json');
    expect(response.contents[0].text).not.toContain('\n');
  });

  it('rejects a large file from stat without opening or materializing it', async () => {
    const file = path.join(tempDir, 'large.txt');
    await fs.writeFile(file, 'secret-marker-'.repeat(10_000));
    const open = jest.spyOn(nodeFs, 'open');

    const response = await readBoundedFileResource('file://large.txt', file, 'text/plain', {
      payloadBudgetBytes: 1024,
    });

    expect(open).not.toHaveBeenCalled();
    expect(response.contents[0].text).not.toContain('secret-marker');
    expect(JSON.parse(response.contents[0].text)).toMatchObject({
      errorCode: 'MCP_RESOURCE_TOO_LARGE',
      budgetBytes: 1024,
    });
  });

  it('reads at most budget + 1 bytes when the file fits the initial stat', async () => {
    const file = path.join(tempDir, 'exact.txt');
    await fs.writeFile(file, 'x'.repeat(1024));
    const response = await readBoundedFileResource('file://exact.txt', file, 'text/plain', {
      payloadBudgetBytes: 1024,
    });
    expect(response.contents[0].text).toHaveLength(1024);
  });
});

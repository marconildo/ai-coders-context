import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { HarnessExploreActionService } from '../exploreActionService';

describe('HarnessExploreActionService', () => {
  let tempDir: string;
  let service: HarnessExploreActionService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-explore-action-'));
    await fs.outputFile(path.join(tempDir, 'src', 'example.ts'), 'export const value = 1;\n');
    service = new HarnessExploreActionService({ repoPath: tempDir });
  });

  afterEach(async () => {
    await fs.remove(tempDir);
  });

  it('executes file read actions without an MCP response envelope', async () => {
    const result = await service.execute({
      action: 'read',
      filePath: path.join(tempDir, 'src', 'example.ts'),
    });

    expect(Array.isArray(result.content)).toBe(false);
    expect(result.success).toBe(true);
    expect(result.content).toContain('export const value');
  });

  it('uses the configured repo path as the default list cwd', async () => {
    const result = await service.execute({
      action: 'list',
      pattern: 'src/**/*.ts',
    });

    expect(result.success).toBe(true);
    expect(result.files).toEqual(['src/example.ts']);
  });

  it('returns bounded file pages with opaque continuation cursors', async () => {
    for (let index = 0; index < 205; index += 1) {
      await fs.outputFile(
        path.join(tempDir, 'many', `file-${index.toString().padStart(3, '0')}.ts`),
        'export {};\n'
      );
    }

    const first = await service.execute({ action: 'list', pattern: 'many/*.ts', limit: 100 });
    const second = await service.execute({
      action: 'list',
      pattern: 'many/*.ts',
      limit: 100,
      cursor: (first.page as any).nextCursor,
    });
    const third = await service.execute({
      action: 'list',
      pattern: 'many/*.ts',
      limit: 100,
      cursor: (second.page as any).nextCursor,
    });
    const files = [
      ...(first.files as string[]),
      ...(second.files as string[]),
      ...(third.files as string[]),
    ];

    expect(first.page).toMatchObject({ recordsReturned: 100, hasMore: true, partial: true });
    expect(second.page).toMatchObject({ recordsReturned: 100, hasMore: true, partial: true });
    expect(third.page).toMatchObject({ recordsReturned: 5, hasMore: false, partial: false });
    expect(new Set(files).size).toBe(205);
  });
});

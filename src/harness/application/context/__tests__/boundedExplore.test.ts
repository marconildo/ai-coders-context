import * as fsExtra from 'fs-extra';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readBoundedExploreFile,
  searchBoundedCode,
} from '../boundedExplore';

describe('bounded explore I/O', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fsExtra.mkdtemp(path.join(os.tmpdir(), 'bounded-explore-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fsExtra.remove(repo);
  });

  it('preserves small-file read behavior', async () => {
    const file = path.join(repo, 'small.ts');
    await fsExtra.writeFile(file, 'export const value = 1;\n');

    await expect(readBoundedExploreFile(file)).resolves.toMatchObject({
      success: true,
      path: file,
      content: 'export const value = 1;\n',
      size: 24,
    });
  });

  it('rejects a huge sparse file from stat without opening or allocating its body', async () => {
    const file = path.join(repo, 'huge.ts');
    const handle = await fs.open(file, 'w');
    await handle.truncate(128 * 1024 * 1024);
    await handle.close();
    const open = jest.spyOn(fs, 'open');

    const result = await readBoundedExploreFile(file, 'utf-8', 1024 * 1024);

    expect(open).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXPLORE_FILE_TOO_LARGE',
      contentOmitted: true,
      size: 128 * 1024 * 1024,
      budgetBytes: 1024 * 1024,
    });
    expect(result.content).toBeUndefined();
  });

  it('streams small searches with legacy match/context fields and cursor continuation', async () => {
    await fsExtra.outputFile(
      path.join(repo, 'src', 'values.ts'),
      ['before', 'needle one', 'middle', 'needle two', 'needle three', 'after'].join('\n')
    );
    const first = await searchBoundedCode({
      cwd: repo,
      pattern: 'needle',
      maxResults: 2,
    });
    const second = await searchBoundedCode({
      cwd: repo,
      pattern: 'needle',
      maxResults: 2,
      cursor: (first.page as any).nextCursor,
    });
    const matches = [...first.matches as any[], ...second.matches as any[]];

    expect(matches.map(match => match.line)).toEqual([2, 4, 5]);
    expect(matches[0]).toMatchObject({
      file: 'src/values.ts',
      match: 'needle one',
      context: 'before\nneedle one\nmiddle',
    });
    expect(first.page).toMatchObject({ hasMore: true, recordsReturned: 2, partial: true });
    expect(second.page).toMatchObject({ hasMore: false, recordsReturned: 1 });
  });

  it('stops at the raw-entry budget in a huge irrelevant tree', async () => {
    for (let index = 0; index < 40; index += 1) {
      await fsExtra.outputFile(path.join(repo, 'src', `asset-${index}.txt`), 'irrelevant');
    }

    const result = await searchBoundedCode({
      cwd: repo,
      pattern: 'needle',
      fileGlob: '**/*.ts',
    }, {
      maxEntries: 10,
      maxDirectories: 4,
      maxFiles: 4,
    });

    expect(result.matches).toEqual([]);
    expect(result.page).toMatchObject({
      partial: true,
      entriesScanned: 10,
      discoveryLimitReason: 'entry-limit',
    });
  });

  it('skips a huge matching file without whole-file reads', async () => {
    const file = path.join(repo, 'src', 'huge.ts');
    await fsExtra.ensureDir(path.dirname(file));
    const handle = await fs.open(file, 'w');
    await handle.truncate(8 * 1024 * 1024);
    await handle.close();
    const readFile = jest.spyOn(fs, 'readFile');

    const result = await searchBoundedCode({ cwd: repo, pattern: 'needle' }, {
      maxFileBytes: 1024,
    });

    expect(readFile).not.toHaveBeenCalled();
    expect(result.matches).toEqual([]);
    expect(result.page).toMatchObject({
      partial: true,
      oversizedFilesSkipped: 1,
      bytesScanned: 0,
    });
  });

  it('caps serialized result bytes and continues from the deferred match', async () => {
    await fsExtra.outputFile(
      path.join(repo, 'src', 'large-results.ts'),
      Array.from({ length: 8 }, (_, index) => `needle-${index}-${'x'.repeat(400)}`).join('\n')
    );
    const first = await searchBoundedCode({ cwd: repo, pattern: 'needle', maxResults: 100 }, {
      maxResultBytes: 1024,
    });
    const second = await searchBoundedCode({
      cwd: repo,
      pattern: 'needle',
      maxResults: 100,
      cursor: (first.page as any).nextCursor,
    }, {
      maxResultBytes: 1024,
    });

    expect((first.page as any).resultBytes).toBeLessThanOrEqual(1024);
    expect(first.page).toMatchObject({ hasMore: true, pageByteLimited: true });
    expect((second.matches as any[])[0].line).toBe((first.matches as any[]).length + 1);
  });
});

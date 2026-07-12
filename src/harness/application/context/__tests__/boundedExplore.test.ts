import * as fsExtra from 'fs-extra';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  listBoundedExploreFiles,
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

  it('bounds list traversal and reports unavailable continuation when ignore is explicitly empty', async () => {
    for (let index = 0; index < 40; index += 1) {
      await fsExtra.outputFile(
        path.join(repo, 'node_modules', `package-${index}`, 'README.md'),
        'irrelevant'
      );
    }

    const result = await listBoundedExploreFiles({
      cwd: repo,
      pattern: '**/*.ts',
      ignore: [],
      limit: 10,
    }, {
      maxEntries: 12,
      maxDirectories: 8,
      maxFiles: 8,
    });

    expect(result.files).toEqual([]);
    expect(result.page).toMatchObject({
      partial: true,
      recordsScanned: 12,
      entriesScanned: 12,
      discoveryLimitReason: 'entry-limit',
      continuationAvailable: false,
      continuationUnavailableReason: 'discovery-limit-reached',
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

  it('terminates pathological regexes without blocking the main event loop', async () => {
    await fsExtra.outputFile(
      path.join(repo, 'src', 'pathological.ts'),
      `${'a'.repeat(64)}!\n`
    );
    let eventLoopTicked = false;
    const tick = new Promise<void>((resolve) => {
      setTimeout(() => {
        eventLoopTicked = true;
        resolve();
      }, 0);
    });
    const startedAt = Date.now();

    const result = await searchBoundedCode({
      cwd: repo,
      pattern: '^(a+)+$',
    }, {
      regexTimeoutMs: 25,
    });
    await tick;

    expect(eventLoopTicked).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result).toMatchObject({
      success: false,
      errorCode: 'EXPLORE_REGEX_TIMEOUT',
      page: {
        partial: true,
        regexTimedOut: true,
        regexTimeoutMs: 25,
      },
    });
  });
});

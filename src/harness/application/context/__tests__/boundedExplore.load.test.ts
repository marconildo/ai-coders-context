import * as fsExtra from 'fs-extra';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readBoundedExploreFile, searchBoundedCode } from '../boundedExplore';

const loadDescribe = process.env.DOTCONTEXT_EXPLORE_LOAD_TESTS === '1' ? describe : describe.skip;

loadDescribe('bounded explore load acceptance', () => {
  jest.setTimeout(60_000);

  it('does not materialize a 256 MiB sparse read or matching search file', async () => {
    const repo = await fsExtra.mkdtemp(path.join(os.tmpdir(), 'bounded-explore-load-'));
    try {
      const file = path.join(repo, 'src', 'huge.ts');
      await fsExtra.ensureDir(path.dirname(file));
      const handle = await fs.open(file, 'w');
      await handle.truncate(256 * 1024 * 1024);
      await handle.close();
      global.gc?.();
      const before = process.memoryUsage().rss;

      const read = await readBoundedExploreFile(file);
      const search = await searchBoundedCode({ cwd: repo, pattern: 'needle' });

      global.gc?.();
      expect(read).toMatchObject({ errorCode: 'EXPLORE_FILE_TOO_LARGE', contentOmitted: true });
      expect(search.page).toMatchObject({ oversizedFilesSkipped: 1, bytesScanned: 0 });
      expect(process.memoryUsage().rss - before).toBeLessThan(16 * 1024 * 1024);
    } finally {
      await fsExtra.remove(repo);
    }
  });

  it('enforces the CPU deadline for catastrophic regex backtracking', async () => {
    const repo = await fsExtra.mkdtemp(path.join(os.tmpdir(), 'bounded-regex-load-'));
    try {
      await fsExtra.outputFile(
        path.join(repo, 'src', 'pathological.ts'),
        `${'a'.repeat(128)}!\n`
      );
      const startedAt = Date.now();

      const search = await searchBoundedCode({
        cwd: repo,
        pattern: '^(a+)+$',
      }, {
        regexTimeoutMs: 50,
      });

      expect(search).toMatchObject({
        success: false,
        errorCode: 'EXPLORE_REGEX_TIMEOUT',
        page: { regexTimedOut: true, partial: true },
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    } finally {
      await fsExtra.remove(repo);
    }
  });
});

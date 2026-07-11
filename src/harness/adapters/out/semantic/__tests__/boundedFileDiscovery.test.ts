import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';

import { discoverBoundedFiles, isBoundedSnapshotFresh } from '../discovery';

describe('bounded semantic file discovery', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-discovery-'));
  });

  afterEach(async () => fs.remove(repo));

  it('stops streaming before materializing repositories larger than the file limit', async () => {
    await fs.ensureDir(path.join(repo, 'src'));
    for (let index = 0; index < 200; index += 1) {
      await fs.writeFile(path.join(repo, 'src', `${String(index).padStart(3, '0')}.ts`), `export const v${index} = ${index};`);
    }
    const result = await discoverBoundedFiles(repo, {
      maxFiles: 10,
      maxDirectories: 4,
      extensions: ['.ts'],
    });

    expect(result.files).toHaveLength(10);
    expect(result.metrics).toMatchObject({ filesSelected: 10, partial: true });
    expect(result.metrics.entriesScanned).toBeLessThan(200);
    expect(result.snapshot.files).toHaveLength(10);
    await expect(isBoundedSnapshotFresh(result.snapshot)).resolves.toMatchObject({
      fresh: false,
      signalsChecked: 0,
    });
  });

  it('counts irrelevant dirents and stops a huge single directory before stat work beyond the entry cap', async () => {
    const irrelevant = path.join(repo, 'irrelevant');
    await fs.ensureDir(irrelevant);
    for (let index = 0; index < 500; index += 1) {
      await fs.writeFile(path.join(irrelevant, `${String(index).padStart(3, '0')}.txt`), 'ignored');
    }
    const result = await discoverBoundedFiles(repo, {
      maxFiles: 100,
      maxDirectories: 100,
      maxEntriesScanned: 25,
      extensions: ['.ts'],
    });

    expect(result.files).toEqual([]);
    expect(result.metrics).toMatchObject({
      entriesScanned: 25,
      statsAttempted: 2,
      filesSelected: 0,
      partial: true,
      stopReason: 'maxEntriesScanned',
    });
  });

  it('does not visit or stat queued deep directories after the raw-entry budget is exhausted', async () => {
    const tree = path.join(repo, 'tree');
    let cursor = tree;
    for (let depth = 0; depth < 40; depth += 1) {
      cursor = path.join(cursor, `d${depth}`);
      await fs.ensureDir(cursor);
    }
    const result = await discoverBoundedFiles(repo, {
      roots: ['tree'],
      maxFiles: 100,
      maxDirectories: 100,
      maxEntriesScanned: 9,
      extensions: ['.ts'],
    });

    expect(result.metrics).toMatchObject({
      entriesScanned: 9,
      directoriesVisited: 9,
      statsAttempted: 9,
      partial: true,
      stopReason: 'maxEntriesScanned',
    });
    expect(result.snapshot.directories).not.toContainEqual(expect.objectContaining({ path: expect.stringContaining('d8') }));
  });

  it('ignores irrelevant trees and detects dirty, new, and deleted relevant files', async () => {
    await fs.outputFile(path.join(repo, 'src', 'index.ts'), 'export const value = 1;');
    await fs.outputFile(path.join(repo, 'node_modules', 'large.ts'), 'ignored');
    await fs.outputFile(path.join(repo, '.context', 'runtime', 'trace.json'), '{}');
    const result = await discoverBoundedFiles(repo, {
      maxFiles: 20,
      extensions: ['.ts'],
      excludeRelativePrefixes: ['.context/runtime'],
    });
    expect(result.files.map(file => path.relative(repo, file))).toEqual(['src/index.ts']);
    await expect(isBoundedSnapshotFresh(result.snapshot)).resolves.toMatchObject({ fresh: true });

    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'export const value = 22;');
    await expect(isBoundedSnapshotFresh(result.snapshot)).resolves.toMatchObject({ fresh: false });

    const refreshed = await discoverBoundedFiles(repo, { maxFiles: 20, extensions: ['.ts'] });
    await fs.outputFile(path.join(repo, 'src', 'new.ts'), 'export const added = true;');
    await expect(isBoundedSnapshotFresh(refreshed.snapshot)).resolves.toMatchObject({ fresh: false });

    const withNew = await discoverBoundedFiles(repo, { maxFiles: 20, extensions: ['.ts'] });
    await fs.remove(path.join(repo, 'src', 'new.ts'));
    await expect(isBoundedSnapshotFresh(withNew.snapshot)).resolves.toMatchObject({ fresh: false });
  });
});

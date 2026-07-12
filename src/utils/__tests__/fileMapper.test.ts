import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FileMapper } from '../fileMapper';

type FakeEntry = {
  name: string;
  isDirectory: () => boolean;
  isFile: () => boolean;
};

function fakeEntry(name: string, type: 'file' | 'directory' = 'file'): FakeEntry {
  return {
    name,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
  };
}

function fakeDirectory(entries: FakeEntry[]): {
  read: jest.Mock;
  close: jest.Mock;
} {
  let index = 0;
  return {
    read: jest.fn(async () => entries[index++] ?? null),
    close: jest.fn(async () => undefined),
  };
}

function mockFileStats(size: number): jest.Mock {
  return jest.spyOn(nativeFs, 'stat').mockResolvedValue({
    isFile: () => true,
    size,
    mtimeMs: 1,
    ctimeMs: 1,
  } as any) as jest.Mock;
}

describe('FileMapper bounded discovery', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'dotcontext-file-mapper-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(repoPath);
  });

  it('discovers source files under non-standard Python and Go roots', async () => {
    const expected = [
      'custompkg/main.py',
      'cmd/server/main.go',
      'internal/auth/service.go',
      'pkg/client/client.go',
    ];
    await Promise.all(expected.map(async (relativePath) => {
      const filePath = path.join(repoPath, relativePath);
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, '# source\n');
    }));
    await fs.ensureDir(path.join(repoPath, 'assets', 'nested'));
    await fs.writeFile(path.join(repoPath, 'assets', 'nested', 'image.bin'), 'ignored');

    const result = await new FileMapper().mapRepository(repoPath);

    expect(result.files.map((file) => file.relativePath)).toEqual([...expected].sort());
    expect(result.partial).toBe(false);
    expect(result.discoveryMetrics?.directoriesScanned).toBe(10);
    expect(result.discoveryMetrics?.statCalls).toBe(expected.length);
  });

  it('stops before statting file candidates beyond the file cap', async () => {
    const directory = fakeDirectory(
      Array.from({ length: 5_100 }, (_, index) => fakeEntry(`file-${index}.ts`))
    );
    jest.spyOn(nativeFs, 'opendir').mockResolvedValue(directory as any);
    const stat = mockFileStats(1);

    const result = await new FileMapper().mapRepository(repoPath);

    expect(result.files).toHaveLength(5_000);
    expect(result.discoveryMetrics).toEqual({
      entriesScanned: 5_001,
      directoriesScanned: 1,
      entriesVisited: 5_001,
      statCalls: 5_000,
      stoppedEarly: true,
    });
    expect(stat).toHaveBeenCalledTimes(5_000);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'file-limit' }),
    ]));
  });

  it('stops metadata work as soon as the aggregate byte budget is reached', async () => {
    const directory = fakeDirectory([
      fakeEntry('a.ts'),
      fakeEntry('b.ts'),
      fakeEntry('c.ts'),
    ]);
    jest.spyOn(nativeFs, 'opendir').mockResolvedValue(directory as any);
    const stat = mockFileStats(6);

    const result = await new FileMapper([], {
      maxFiles: 5_000,
      maxFileBytes: 100,
      maxTotalBytes: 10,
    }).mapRepository(repoPath);

    expect(result.files.map((file) => file.relativePath)).toEqual(['a.ts']);
    expect(stat).toHaveBeenCalledTimes(2);
    expect(result.discoveryMetrics?.stoppedEarly).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: path.join(repoPath, 'b.ts'), reason: 'total-byte-limit' }),
    ]));
  });

  it('uses targeted defaults and never stats irrelevant paths', async () => {
    const root = fakeDirectory([
      fakeEntry('movie.bin'),
      fakeEntry('src', 'directory'),
    ]);
    const src = fakeDirectory([
      fakeEntry('asset.bin'),
      fakeEntry('index.ts'),
    ]);
    jest.spyOn(nativeFs, 'opendir').mockImplementation(async (directoryPath) => {
      return (path.basename(String(directoryPath)) === 'src' ? src : root) as any;
    });
    const stat = mockFileStats(1);

    const result = await new FileMapper().mapRepository(repoPath);

    expect(result.files.map((file) => file.relativePath)).toEqual(['src/index.ts']);
    expect(result.discoveryMetrics).toEqual({
      entriesScanned: 4,
      directoriesScanned: 2,
      entriesVisited: 1,
      statCalls: 1,
      stoppedEarly: false,
    });
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalledWith(path.join(repoPath, 'movie.bin'));
    expect(stat).not.toHaveBeenCalledWith(path.join(repoPath, 'src', 'asset.bin'));
  });

  it('caps raw scans inside one huge directory of irrelevant entries', async () => {
    const root = fakeDirectory([fakeEntry('src', 'directory')]);
    const src = fakeDirectory(
      Array.from({ length: 100 }, (_, index) => fakeEntry(`asset-${index}.bin`))
    );
    jest.spyOn(nativeFs, 'opendir').mockImplementation(async (directoryPath) => {
      return (path.basename(String(directoryPath)) === 'src' ? src : root) as any;
    });
    const stat = jest.spyOn(nativeFs, 'stat');

    const result = await new FileMapper([], {
      maxEntriesScanned: 10,
      maxDirectoriesScanned: 10,
    }).mapRepository(repoPath);

    expect(result.files).toEqual([]);
    expect(result.partial).toBe(true);
    expect(result.discoveryMetrics).toEqual({
      entriesScanned: 10,
      directoriesScanned: 2,
      entriesVisited: 0,
      statCalls: 0,
      stoppedEarly: true,
    });
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'entry-limit' }),
    ]));
    expect(src.read).toHaveBeenCalledTimes(9);
    expect(stat).not.toHaveBeenCalled();
  });

  it('caps traversal of a deep irrelevant directory tree', async () => {
    const opened: string[] = [];
    jest.spyOn(nativeFs, 'opendir').mockImplementation(async (directoryPath) => {
      const normalized = path.relative(repoPath, String(directoryPath)).split(path.sep).join('/');
      opened.push(normalized || '.');
      const name = normalized ? `level-${normalized.split('/').length}` : 'src';
      return fakeDirectory([fakeEntry(name, 'directory')]) as any;
    });
    const stat = jest.spyOn(nativeFs, 'stat');

    const result = await new FileMapper([], {
      maxDirectoriesScanned: 3,
      maxEntriesScanned: 100,
    }).mapRepository(repoPath);

    expect(opened).toEqual(['.', 'src', 'src/level-1']);
    expect(result.partial).toBe(true);
    expect(result.discoveryMetrics).toEqual({
      entriesScanned: 3,
      directoriesScanned: 3,
      entriesVisited: 0,
      statCalls: 0,
      stoppedEarly: true,
    });
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'directory-limit' }),
    ]));
    expect(stat).not.toHaveBeenCalled();
  });
});

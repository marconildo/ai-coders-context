import * as fs from 'fs-extra';
import { promises as nativeFs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { globStream } from 'glob';
import { FileMapper } from '../fileMapper';

jest.mock('glob', () => ({ globStream: jest.fn() }));

const mockedGlobStream = globStream as jest.MockedFunction<typeof globStream>;

function entryStream(entries: string[]): AsyncIterable<string> & { destroy: jest.Mock } {
  const iterator = (async function* () {
    for (const entry of entries) yield entry;
  })() as unknown as AsyncIterable<string> & { destroy: jest.Mock };
  iterator.destroy = jest.fn();
  return iterator;
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
    mockedGlobStream.mockReset();
    await fs.remove(repoPath);
  });

  it('stops before statting or materializing entries beyond the file cap', async () => {
    const stream = entryStream(
      Array.from({ length: 5_100 }, (_, index) => `src/file-${index}.ts`)
    );
    mockedGlobStream.mockReturnValue(stream as any);
    const stat = mockFileStats(1);

    const result = await new FileMapper().mapRepository(repoPath);

    expect(result.files).toHaveLength(5_000);
    expect(result.discoveryMetrics).toEqual({
      entriesVisited: 5_001,
      statCalls: 5_000,
      stoppedEarly: true,
    });
    expect(stat).toHaveBeenCalledTimes(5_000);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'file-limit' }),
    ]));
    expect(stream.destroy).toHaveBeenCalled();
  });

  it('stops metadata work as soon as the aggregate byte budget is reached', async () => {
    const stream = entryStream(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    mockedGlobStream.mockReturnValue(stream as any);
    const stat = mockFileStats(6);

    const result = await new FileMapper([], {
      maxFiles: 5_000,
      maxFileBytes: 100,
      maxTotalBytes: 10,
    }).mapRepository(repoPath);

    expect(result.files.map((file) => file.relativePath)).toEqual(['src/a.ts']);
    expect(stat).toHaveBeenCalledTimes(2);
    expect(result.discoveryMetrics?.stoppedEarly).toBe(true);
    expect(result.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: path.join(repoPath, 'src/b.ts'), reason: 'total-byte-limit' }),
    ]));
  });

  it('uses targeted defaults and never stats irrelevant emitted paths', async () => {
    const stream = entryStream(['assets/movie.bin', 'src/index.ts']);
    mockedGlobStream.mockReturnValue(stream as any);
    const stat = mockFileStats(1);

    const result = await new FileMapper().mapRepository(repoPath);

    const patterns = mockedGlobStream.mock.calls[0][0] as string[];
    expect(patterns).not.toContain('**/*');
    expect(result.files.map((file) => file.relativePath)).toEqual(['src/index.ts']);
    expect(stat).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalledWith(path.join(repoPath, 'assets/movie.bin'));
  });
});

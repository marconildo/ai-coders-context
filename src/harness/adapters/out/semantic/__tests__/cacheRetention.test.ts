import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SemanticContextBuilder } from '../contextBuilder';
import { CodebaseAnalyzer } from '../codebaseAnalyzer';
import { TreeSitterLayer } from '../treeSitter/treeSitterLayer';

const emptyContext = {
  symbols: { classes: [], interfaces: [], functions: [], types: [], enums: [] },
  dependencies: { graph: new Map(), reverseGraph: new Map() },
  architecture: { layers: [], patterns: [], entryPoints: [], publicAPI: [] },
  stats: { totalFiles: 0, totalSymbols: 0, languageBreakdown: {}, analysisTimeMs: 0 },
};

describe('semantic cache retention', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'semantic-retention-'));
    await fs.outputFile(path.join(repo, 'src', 'index.ts'), 'export const value = 1;');
  });
  afterEach(async () => fs.remove(repo));

  it('does not retain FileAnalysis when cacheEnabled is false', async () => {
    const layer = new TreeSitterLayer({ cacheEnabled: false });
    await layer.analyzeFile(path.join(repo, 'src', 'index.ts'));
    expect(layer.cacheSize).toBe(0);
    layer.dispose();
  });

  it('invalidates semantic context when the repository fingerprint changes', async () => {
    const builder = new SemanticContextBuilder();
    const analyze = jest.fn().mockResolvedValue(emptyContext);
    (builder as any).analyzer.analyze = analyze;
    await builder.analyze(repo);
    await builder.analyze(repo);
    expect(analyze).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'export const value = 22;');
    await builder.analyze(repo);
    expect(analyze).toHaveBeenCalledTimes(2);
    await builder.shutdown();
  });

  it('does not retain SemanticContext when cacheEnabled is false', async () => {
    const builder = new SemanticContextBuilder({ cacheEnabled: false });
    const analyze = jest.fn().mockResolvedValue(emptyContext);
    (builder as any).analyzer.analyze = analyze;
    await builder.analyze(repo);
    await builder.analyze(repo);
    expect(analyze).toHaveBeenCalledTimes(2);
    await builder.shutdown();
  });

  it('applies semantic byte and FileAnalysis entry overrides from this repository only', async () => {
    await fs.outputJson(path.join(repo, '.context', 'config', 'runtime.json'), {
      version: 1,
      caches: {
        semantic: { maxEntries: 1, maxBytes: 1024 },
        fileAnalysis: { maxEntries: 10, maxBytes: 1024 },
      },
    });
    const oversizedContext = {
      ...emptyContext,
      architecture: { ...emptyContext.architecture, entryPoints: ['x'.repeat(4_000)] },
    };
    const builder = new SemanticContextBuilder();
    const analyze = jest.fn().mockResolvedValue(oversizedContext);
    (builder as any).analyzer.analyze = analyze;
    await builder.analyze(repo);
    await builder.analyze(repo);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(builder.semanticCacheMetrics(repo)).toMatchObject({ entries: 0 });
    await builder.shutdown();
    expect(builder.semanticCacheMetrics(repo)).toBeUndefined();

    const largeSource = Array.from({ length: 200 }, (_, index) => `export function fn${index}() { return ${index}; }`).join('\n');
    await fs.outputFile(path.join(repo, 'src', 'index.ts'), largeSource);
    await fs.outputFile(path.join(repo, 'src', 'second.ts'), largeSource);
    const analyzer = new CodebaseAnalyzer({ useLSP: false });
    await analyzer.analyze(repo);
    expect(analyzer.fileAnalysisCacheMetrics()).toMatchObject({ entries: 0, estimatedBytes: 0 });
    await analyzer.shutdown();
    expect(analyzer.fileAnalysisCacheMetrics().entries).toBe(0);
  });

  it('never reuses semantic context from a partial bounded discovery', async () => {
    for (let index = 0; index < 40; index += 1) {
      await fs.outputFile(path.join(repo, 'src', `${index}.ts`), `export const value${index} = ${index};`);
    }
    const builder = new SemanticContextBuilder({ maxFiles: 5 });
    const analyze = jest.fn().mockResolvedValue(emptyContext);
    (builder as any).analyzer.analyze = analyze;

    await builder.analyze(repo);
    await builder.analyze(repo);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(builder.freshnessMetrics(repo)).toMatchObject({
      discoveries: 2,
      filesSelected: 10,
      partialDiscoveries: 2,
    });
    expect(builder.freshnessMetrics(repo)!.entriesScanned).toBeLessThan(40);
    expect(builder.semanticCacheMetrics(repo)).toMatchObject({ entries: 0 });

    await fs.writeFile(path.join(repo, 'src', '39.ts'), 'export const changedBeyondBudget = true;');
    await builder.analyze(repo);
    await fs.outputFile(path.join(repo, 'src', 'added-beyond-budget.ts'), 'export const added = true;');
    await builder.analyze(repo);
    await fs.remove(path.join(repo, 'src', '39.ts'));
    await builder.analyze(repo);
    expect(analyze).toHaveBeenCalledTimes(5);
    await builder.shutdown();
  });

  it('does not retain semantic context when irrelevant entries exhaust the scan policy', async () => {
    for (let index = 0; index < 30; index += 1) {
      await fs.outputFile(path.join(repo, 'src', `${index}.txt`), 'ignored');
    }
    const builder = new SemanticContextBuilder({ maxEntriesScanned: 6 });
    const analyze = jest.fn().mockResolvedValue(emptyContext);
    (builder as any).analyzer.analyze = analyze;

    await builder.analyze(repo);
    await builder.analyze(repo);

    expect(analyze).toHaveBeenCalledTimes(2);
    expect(builder.semanticCacheMetrics(repo)).toMatchObject({ entries: 0 });
    expect(builder.freshnessMetrics(repo)).toMatchObject({
      discoveries: 2,
      entriesScanned: 12,
      partialDiscoveries: 2,
      entryLimitDiscoveries: 2,
    });
    await builder.shutdown();
  });
});

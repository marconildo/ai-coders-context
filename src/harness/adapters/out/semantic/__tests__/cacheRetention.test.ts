import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { SemanticContextBuilder } from '../contextBuilder';
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
});

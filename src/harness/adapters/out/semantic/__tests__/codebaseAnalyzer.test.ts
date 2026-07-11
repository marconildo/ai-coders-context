import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs-extra';

import { CodebaseAnalyzer } from '../codebaseAnalyzer';
import type { SemanticContext, FileAnalysis, ExtractedSymbol } from '../types';

// Mock TreeSitterLayer
jest.mock('../treeSitter/treeSitterLayer', () => ({
  TreeSitterLayer: jest.fn().mockImplementation(() => ({
    analyzeFile: jest.fn().mockImplementation((filePath: string): FileAnalysis => {
      const filename = path.basename(filePath, path.extname(filePath));
      return {
        filePath,
        language: 'typescript',
        symbols: [
          {
            name: `${filename}Class`,
            kind: 'class',
            exported: true,
            location: { file: filePath, line: 1, column: 0 },
          },
          {
            name: `${filename}Function`,
            kind: 'function',
            exported: true,
            location: { file: filePath, line: 10, column: 0 },
          },
        ],
        imports: [],
        exports: [{ name: `${filename}Class`, isDefault: false, isReExport: false }],
      };
    }),
    clearCache: jest.fn(),
  })),
}));

// Mock LSPLayer
const mockGetTypeInfo = jest.fn().mockResolvedValue({
  name: 'TestClass',
  fullType: 'class TestClass { ... }',
  documentation: 'A test class',
});
const mockFindImplementations = jest.fn().mockResolvedValue([
  { file: '/test/impl.ts', line: 5, column: 0 },
]);
const mockFindReferences = jest.fn().mockResolvedValue([
  { file: '/test/usage.ts', line: 10, column: 4 },
  { file: '/test/other.ts', line: 20, column: 8 },
]);
const mockShutdown = jest.fn().mockResolvedValue(undefined);

jest.mock('../lsp/lspLayer', () => ({
  LSPLayer: jest.fn().mockImplementation(() => ({
    getTypeInfo: mockGetTypeInfo,
    findImplementations: mockFindImplementations,
    findReferences: mockFindReferences,
    shutdown: mockShutdown,
  })),
}));

function createTempOutput(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('CodebaseAnalyzer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await createTempOutput('dotcontext-analyzer-');
    await Promise.all([
      'src/services/userService.ts',
      'src/controllers/userController.ts',
      'src/models/user.ts',
      'src/utils/helper.ts',
      'src/index.ts',
      'src/main.ts',
    ].map(async (relativePath) => {
      const filePath = path.join(tempDir, relativePath);
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, 'export const fixture = true;\n');
    }));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.remove(tempDir);
    }
  });

  describe('constructor', () => {
    it('should not create LSPLayer when useLSP is false', () => {
      const { LSPLayer } = require('../lsp/lspLayer');

      new CodebaseAnalyzer({ useLSP: false });

      expect(LSPLayer).not.toHaveBeenCalled();
    });

    it('should create LSPLayer when useLSP is true', () => {
      const { LSPLayer } = require('../lsp/lspLayer');

      new CodebaseAnalyzer({ useLSP: true });

      expect(LSPLayer).toHaveBeenCalled();
    });

    it('should use default options when none provided', () => {
      const { LSPLayer } = require('../lsp/lspLayer');

      // Default useLSP is false
      new CodebaseAnalyzer();

      expect(LSPLayer).not.toHaveBeenCalled();
    });
  });

  describe('analyze', () => {
    it('builds semantic context and functional patterns from one file-analysis pass', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      const internal = analyzer as unknown as {
        findCodeFiles(projectPath: string): Promise<string[]>;
        analyzeFiles(files: string[]): Promise<Map<string, FileAnalysis>>;
      };
      const findSpy = jest.spyOn(internal, 'findCodeFiles');
      const analyzeSpy = jest.spyOn(internal, 'analyzeFiles');

      const bundle = await analyzer.analyzeBundle(tempDir);

      expect(findSpy).toHaveBeenCalledTimes(1);
      expect(analyzeSpy).toHaveBeenCalledTimes(1);
      expect(bundle.context.stats.totalFiles).toBeGreaterThan(0);
      expect(bundle.functionalPatterns).toEqual(expect.objectContaining({
        patterns: expect.any(Array),
      }));
      expect(bundle.files).toHaveLength(bundle.context.stats.totalFiles);
      expect(bundle.metrics.filesParsed).toBe(bundle.files.length);
      expect(bundle.metrics.bytesRead).toBeGreaterThan(0);
      expect(bundle.partial).toBe(false);
    });

    it('uses the documented default analysis limits', async () => {
      const bundle = await new CodebaseAnalyzer().analyzeBundle(tempDir);

      expect(bundle.limits).toEqual({
        maxFiles: 5000,
        maxTotalBytes: 256 * 1024 * 1024,
        maxFileBytes: 2 * 1024 * 1024,
        maxDirectoriesScanned: 10_000,
        maxEntriesScanned: 100_000,
        concurrency: 16,
      });
    });

    it('absolute-clamps configurable repository scan limits', async () => {
      const bundle = await new CodebaseAnalyzer({
        maxDirectoriesScanned: Number.MAX_SAFE_INTEGER,
        maxEntriesScanned: Number.MAX_SAFE_INTEGER,
      }).analyzeBundle(tempDir);

      expect(bundle.limits.maxDirectoriesScanned).toBe(50_000);
      expect(bundle.limits.maxEntriesScanned).toBe(500_000);
      expect(bundle.metrics.directoriesScanned).toBeGreaterThan(0);
      expect(bundle.metrics.entriesScanned).toBeGreaterThan(0);
    });

    it('bounds a 3000-file-equivalent analysis and reports maximum in-flight work', async () => {
      const files = Array.from({ length: 3000 }, (_, index) =>
        path.join(tempDir, 'scale', `file-${index}.ts`)
      );
      await fs.ensureDir(path.join(tempDir, 'scale'));
      for (let index = 0; index < files.length; index += 100) {
        await Promise.all(files.slice(index, index + 100).map((file) =>
          fs.writeFile(file, 'export const value = true;\n')
        ));
      }

      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      let inFlight = 0;
      let maxInFlight = 0;
      const analyzeFile = jest.fn().mockImplementation(async (filePath: string): Promise<FileAnalysis> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { filePath, language: 'typescript', symbols: [], imports: [], exports: [] };
      });
      TreeSitterLayer.mockImplementationOnce(() => ({ analyzeFile, clearCache: jest.fn() }));

      const bundle = await new CodebaseAnalyzer({ concurrency: 16 }).analyzeBundle(tempDir, files);

      expect(bundle.metrics.filesDiscovered).toBe(3000);
      expect(bundle.metrics.filesParsed).toBe(3000);
      expect(bundle.metrics.fileReads).toBe(3000);
      expect(analyzeFile).toHaveBeenCalledTimes(3000);
      expect(bundle.metrics.maxInFlight).toBeLessThanOrEqual(16);
      expect(maxInFlight).toBeLessThanOrEqual(16);
      expect(bundle.metrics.bytesRead).toBeLessThanOrEqual(bundle.limits.maxTotalBytes);
    }, 20_000);

    it('skips oversized files and reports partial analysis without parsing them', async () => {
      const small = path.join(tempDir, 'small.ts');
      const oversized = path.join(tempDir, 'oversized.ts');
      await fs.writeFile(small, 'ok');
      await fs.writeFile(oversized, '0123456789');
      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      const analyzeFile = jest.fn().mockImplementation(async (filePath: string): Promise<FileAnalysis> =>
        ({ filePath, language: 'typescript', symbols: [], imports: [], exports: [] }));
      TreeSitterLayer.mockImplementationOnce(() => ({ analyzeFile, clearCache: jest.fn() }));

      const bundle = await new CodebaseAnalyzer({ maxFileBytes: 5 }).analyzeBundle(
        tempDir,
        [small, oversized]
      );

      expect(bundle.partial).toBe(true);
      expect(bundle.skipped).toContainEqual({
        file: oversized,
        reason: 'file-too-large',
        size: 10,
      });
      expect(analyzeFile).toHaveBeenCalledTimes(1);
      expect(analyzeFile).toHaveBeenCalledWith(small);
    });

    it('honors aggregate byte and file budgets', async () => {
      const files = await Promise.all([0, 1, 2].map(async (index) => {
        const file = path.join(tempDir, `budget-${index}.ts`);
        await fs.writeFile(file, '1234');
        return file;
      }));

      const bundle = await new CodebaseAnalyzer({
        maxFiles: 2,
        maxTotalBytes: 6,
      }).analyzeBundle(tempDir, files);

      expect(bundle.metrics.filesParsed).toBe(1);
      expect(bundle.metrics.bytesRead).toBe(4);
      expect(bundle.partial).toBe(true);
      expect(bundle.skipped.map((item) => item.reason)).toEqual([
        'total-byte-limit',
        'total-byte-limit',
      ]);
    });

    it('does not retain parser cache state when cacheEnabled is false', async () => {
      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      const analyzer = new CodebaseAnalyzer({ cacheEnabled: false });
      const layer = TreeSitterLayer.mock.results.at(-1).value;

      await analyzer.analyzeBundle(tempDir);
      await analyzer.shutdown();

      expect(layer.clearCache).toHaveBeenCalledTimes(3);
    });

    it('should analyze files with Tree-sitter by default', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });

      const context = await analyzer.analyze(tempDir);

      expect(context.stats.totalFiles).toBeGreaterThan(0);
      expect(context.symbols.classes.length).toBeGreaterThan(0);
      expect(context.symbols.functions.length).toBeGreaterThan(0);
    });

    it('should build dependency graph from imports', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });

      const context = await analyzer.analyze(tempDir);

      expect(context.dependencies.graph).toBeDefined();
      expect(context.dependencies.reverseGraph).toBeDefined();
    });

    it('should detect architecture layers', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });

      const context = await analyzer.analyze(tempDir);

      // Should detect layers based on directory patterns
      const layerNames = context.architecture.layers.map(l => l.name);
      expect(layerNames.some(name => ['Services', 'Controllers', 'Models', 'Utils'].includes(name))).toBe(true);
    });

    it('should detect patterns based on naming conventions', async () => {
      // Override the mock to return pattern-matching class names
      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      TreeSitterLayer.mockImplementationOnce(() => ({
        analyzeFile: jest.fn().mockImplementation((filePath: string): FileAnalysis => ({
          filePath,
          language: 'typescript',
          symbols: [
            {
              name: 'UserFactory',
              kind: 'class',
              exported: true,
              location: { file: filePath, line: 1, column: 0 },
            },
            {
              name: 'UserService',
              kind: 'class',
              exported: true,
              location: { file: filePath, line: 20, column: 0 },
            },
            {
              name: 'UserRepository',
              kind: 'class',
              exported: true,
              location: { file: filePath, line: 40, column: 0 },
            },
          ],
          imports: [],
          exports: [],
        })),
        clearCache: jest.fn(),
      }));

      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      const context = await analyzer.analyze(tempDir);

      const patternNames = context.architecture.patterns.map(p => p.name);
      expect(patternNames).toContain('Factory');
      expect(patternNames).toContain('Service Layer');
      expect(patternNames).toContain('Repository');
    });

    it('should find entry points based on file names', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      const context = await analyzer.analyze(tempDir);

      expect(context.architecture.entryPoints.some(ep => ep.includes('index.ts') || ep.includes('main.ts'))).toBe(true);
    });

    it('should calculate analysis time', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });

      const context = await analyzer.analyze(tempDir);

      expect(context.stats.analysisTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('enhanceWithLSP', () => {
    it('should add type info to exported symbols when LSP is enabled', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: true });

      const context = await analyzer.analyze(tempDir);

      // LSP enhancement should have been called for exported symbols
      expect(mockGetTypeInfo).toHaveBeenCalled();
    });

    it('should find implementations for interfaces/classes', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: true });

      await analyzer.analyze(tempDir);

      expect(mockFindImplementations).toHaveBeenCalled();
    });

    it('should find references for exported symbols', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: true });

      await analyzer.analyze(tempDir);

      expect(mockFindReferences).toHaveBeenCalled();
    });

    it('should handle LSP errors gracefully', async () => {
      // Make LSP methods throw errors
      mockGetTypeInfo.mockRejectedValueOnce(new Error('LSP connection lost'));

      const analyzer = new CodebaseAnalyzer({ useLSP: true });

      // Should not throw, but continue with analysis
      const context = await analyzer.analyze(tempDir);

      expect(context).toBeDefined();
      expect(context.stats.totalFiles).toBeGreaterThan(0);
    });

    it('should limit LSP calls to first 100 exported symbols', async () => {
      // Create more than 100 symbols
      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      const manySymbols: ExtractedSymbol[] = [];
      for (let i = 0; i < 150; i++) {
        manySymbols.push({
          name: `Symbol${i}`,
          kind: 'function',
          exported: true,
          location: { file: '/test/file.ts', line: i + 1, column: 0 },
        });
      }

      TreeSitterLayer.mockImplementationOnce(() => ({
        analyzeFile: jest.fn().mockImplementation((filePath: string): FileAnalysis => ({
          filePath,
          language: 'typescript',
          symbols: manySymbols,
          imports: [],
          exports: [],
        })),
        clearCache: jest.fn(),
      }));

      mockGetTypeInfo.mockClear();

      const analyzer = new CodebaseAnalyzer({ useLSP: true });
      await analyzer.analyze(tempDir);

      // Should be limited to 100 * number of files analyzed
      // But each file contributes, so we check it's reasonable
      expect(mockGetTypeInfo.mock.calls.length).toBeLessThanOrEqual(400);
    });
  });

  describe('shutdown', () => {
    it('should call LSPLayer shutdown when LSP is enabled', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: true });

      await analyzer.shutdown();

      expect(mockShutdown).toHaveBeenCalled();
    });

    it('should not throw when LSP is disabled', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });

      // Should not throw
      await expect(analyzer.shutdown()).resolves.not.toThrow();
    });
  });

  describe('getSummary', () => {
    it('should generate markdown summary', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      const context = await analyzer.analyze(tempDir);

      const summary = analyzer.getSummary(context, tempDir);

      expect(summary).toContain('## Codebase Analysis Summary');
      expect(summary).toContain('**Total Files**:');
      expect(summary).toContain('**Total Symbols**:');
      expect(summary).toContain('### Language Breakdown');
    });

    it('should include architecture layers in summary', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      const context = await analyzer.analyze(tempDir);

      const summary = analyzer.getSummary(context, tempDir);

      expect(summary).toContain('### Architecture Layers');
    });

    it('should include detected patterns in summary', async () => {
      // Override to get pattern-matching classes
      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      TreeSitterLayer.mockImplementationOnce(() => ({
        analyzeFile: jest.fn().mockImplementation((filePath: string): FileAnalysis => ({
          filePath,
          language: 'typescript',
          symbols: [
            {
              name: 'UserFactory',
              kind: 'class',
              exported: true,
              location: { file: filePath, line: 1, column: 0 },
            },
          ],
          imports: [],
          exports: [],
        })),
        clearCache: jest.fn(),
      }));

      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      const context = await analyzer.analyze(tempDir);

      const summary = analyzer.getSummary(context, tempDir);

      expect(summary).toContain('### Detected Patterns');
    });
  });

  describe('clearCache', () => {
    it('should call clearCache on TreeSitterLayer', () => {
      const { TreeSitterLayer } = require('../treeSitter/treeSitterLayer');
      const mockClearCache = jest.fn();
      TreeSitterLayer.mockImplementationOnce(() => ({
        analyzeFile: jest.fn().mockResolvedValue({
          filePath: '/test/file.ts',
          language: 'typescript',
          symbols: [],
          imports: [],
          exports: [],
        }),
        clearCache: mockClearCache,
      }));

      const analyzer = new CodebaseAnalyzer({ useLSP: false });
      analyzer.clearCache();

      expect(mockClearCache).toHaveBeenCalled();
    });
  });

  describe('options handling', () => {
    it('should respect maxFiles option', async () => {
      const analyzer = new CodebaseAnalyzer({ useLSP: false, maxFiles: 2 });
      const context = await analyzer.analyze(tempDir);

      expect(context.stats.totalFiles).toBe(2);
    });

    it('should respect languages option', async () => {
      const analyzer = new CodebaseAnalyzer({
        useLSP: false,
        languages: ['typescript', 'python'],
      });

      const context = await analyzer.analyze(tempDir);

      // Should complete without error
      expect(context).toBeDefined();
    });

    it('should respect exclude patterns', async () => {
      const analyzer = new CodebaseAnalyzer({
        useLSP: false,
        exclude: ['node_modules', 'dist', 'build'],
      });

      const context = await analyzer.analyze(tempDir);

      // Should complete without error
      expect(context).toBeDefined();
    });

    it('should respect include patterns', async () => {
      const analyzer = new CodebaseAnalyzer({
        useLSP: false,
        include: ['services'],
      });

      const context = await analyzer.analyze(tempDir);

      expect(context.stats.totalFiles).toBe(1);
    });
  });
});

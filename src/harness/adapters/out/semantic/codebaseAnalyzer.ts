/**
 * CodebaseAnalyzer - Main orchestrator for semantic code analysis
 *
 * Combines Tree-sitter for fast syntactic analysis with optional LSP
 * for deeper semantic understanding.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { FileInfo } from '../../../../types';
import { FileMapper } from '../../../../utils/fileMapper';
import { TreeSitterLayer } from './treeSitter/treeSitterLayer';
import { LSPLayer } from './lsp/lspLayer';
import {
  SemanticContext,
  FileAnalysis,
  ExtractedSymbol,
  ArchitectureLayer,
  DetectedPattern,
  AnalyzerOptions,
  DependencyInfo,
  DEFAULT_EXCLUDE_PATTERNS,
  LANGUAGE_EXTENSIONS,
  FunctionalPattern,
  FunctionalPatternType,
  DetectedFunctionalPatterns,
  PatternIndicator,
  FlowNode,
  FlowEdge,
  ExecutionFlow,
} from './types';

const DEFAULT_OPTIONS: Required<AnalyzerOptions> = {
  useLSP: false,
  languages: ['typescript', 'javascript', 'python', 'go'],
  exclude: DEFAULT_EXCLUDE_PATTERNS,
  include: [],
  maxFiles: 5000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  concurrency: 16,
  cacheEnabled: true,
};

export interface AnalysisLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  concurrency: number;
}

export type AnalysisSkipReason =
  | 'file-limit'
  | 'total-byte-limit'
  | 'file-too-large'
  | 'stat-failed';

export interface SkippedAnalysisFile {
  file: string;
  reason: AnalysisSkipReason;
  size?: number;
}

export interface AnalysisMetrics {
  filesDiscovered: number;
  filesParsed: number;
  fileReads: number;
  bytesRead: number;
  maxInFlight: number;
  cacheHits: number;
  durationsMs: {
    discovery: number;
    parsing: number;
    architecture: number;
    functionalPatterns: number;
    generation: number;
    publication: number;
    total: number;
  };
}

export interface SemanticAnalysisBundle {
  context: SemanticContext;
  functionalPatterns: DetectedFunctionalPatterns;
  files: string[];
  limits: AnalysisLimits;
  partial: boolean;
  skipped: SkippedAnalysisFile[];
  metrics: AnalysisMetrics;
}

type DiscoveredAnalysisFile = string | Pick<FileInfo, 'path' | 'size'>;

export class CodebaseAnalyzer {
  private treeSitter: TreeSitterLayer;
  private lspLayer?: LSPLayer;
  private options: Required<AnalyzerOptions>;

  constructor(options: AnalyzerOptions = {}) {
    this.treeSitter = new TreeSitterLayer();
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.options.maxFiles = Math.max(0, this.options.maxFiles);
    this.options.maxTotalBytes = Math.max(0, this.options.maxTotalBytes);
    this.options.maxFileBytes = Math.max(0, this.options.maxFileBytes);
    this.options.concurrency = Math.max(1, this.options.concurrency);

    // Create LSPLayer if LSP mode is enabled
    if (this.options.useLSP) {
      this.lspLayer = new LSPLayer();
    }
  }

  async analyze(projectPath: string): Promise<SemanticContext> {
    return (await this.analyzeProject(projectPath)).context;
  }

  async analyzeBundle(
    projectPath: string,
    discoveredFiles?: DiscoveredAnalysisFile[]
  ): Promise<SemanticAnalysisBundle> {
    const result = await this.analyzeProject(projectPath, discoveredFiles);
    const functionalStartedAt = Date.now();
    const functionalPatterns = this.detectFunctionalPatternsFromAnalyses(
      result.files,
      result.fileAnalyses
    );
    result.metrics.durationsMs.functionalPatterns = Date.now() - functionalStartedAt;
    result.metrics.durationsMs.total = Date.now() - result.startedAt;
    return {
      context: result.context,
      functionalPatterns,
      files: result.files,
      limits: this.analysisLimits(),
      partial: result.skipped.length > 0,
      skipped: result.skipped,
      metrics: result.metrics,
    };
  }

  private async analyzeProject(projectPath: string, discoveredFiles?: DiscoveredAnalysisFile[]): Promise<{
    context: SemanticContext;
    files: string[];
    fileAnalyses: Map<string, FileAnalysis>;
    skipped: SkippedAnalysisFile[];
    metrics: AnalysisMetrics;
    startedAt: number;
  }> {
    const startTime = Date.now();
    const metrics: AnalysisMetrics = {
      filesDiscovered: 0,
      filesParsed: 0,
      fileReads: 0,
      bytesRead: 0,
      maxInFlight: 0,
      cacheHits: 0,
      durationsMs: {
        discovery: 0,
        parsing: 0,
        architecture: 0,
        functionalPatterns: 0,
        generation: 0,
        publication: 0,
        total: 0,
      },
    };

    // 1. Select source files once, applying byte and count budgets before parsing.
    const discoveryStartedAt = Date.now();
    const discovery = discoveredFiles
      ? { files: this.filterCodeFiles(projectPath, discoveredFiles), skipped: [] }
      : await this.findCodeFiles(projectPath);
    const candidates = discovery.files;
    metrics.filesDiscovered = candidates.length;
    const selected = await this.selectFilesWithinLimits(candidates);
    const files = selected.files;
    const skipped = [...discovery.skipped, ...selected.skipped];
    const bytes = selected.bytes;
    metrics.bytesRead = bytes;
    metrics.durationsMs.discovery = Date.now() - discoveryStartedAt;

    // 2. Analyze with Tree-sitter
    if (!this.options.cacheEnabled) {
      this.treeSitter.clearCache();
    }
    const parsingStartedAt = Date.now();
    const fileAnalyses = await this.analyzeFiles(files, metrics);
    metrics.filesParsed = fileAnalyses.size;
    metrics.durationsMs.parsing = Date.now() - parsingStartedAt;

    // 3. Build base context
    const context = this.buildBaseContext(fileAnalyses, projectPath);

    // 4. Enhance with LSP if enabled (adds type info, references)
    if (this.lspLayer) {
      await this.enhanceWithLSP(context, projectPath);
    }

    // 5. Detect architecture and patterns
    const architectureStartedAt = Date.now();
    context.architecture = this.detectArchitecture(fileAnalyses, projectPath);
    metrics.durationsMs.architecture = Date.now() - architectureStartedAt;

    // 6. Calculate stats
    context.stats.analysisTimeMs = Date.now() - startTime;
    metrics.durationsMs.total = context.stats.analysisTimeMs;

    if (!this.options.cacheEnabled) {
      this.treeSitter.clearCache();
    }

    return {
      context,
      files,
      fileAnalyses,
      skipped,
      metrics,
      startedAt: startTime,
    };
  }

  private analysisLimits(): AnalysisLimits {
    return {
      maxFiles: this.options.maxFiles,
      maxTotalBytes: this.options.maxTotalBytes,
      maxFileBytes: this.options.maxFileBytes,
      concurrency: this.options.concurrency,
    };
  }

  private async findCodeFiles(projectPath: string): Promise<{
    files: Array<{ path: string; size?: number }>;
    skipped: SkippedAnalysisFile[];
  }> {
    try {
      const structure = await new FileMapper(this.options.exclude, {
        maxFiles: this.options.maxFiles,
        maxTotalBytes: this.options.maxTotalBytes,
        maxFileBytes: this.options.maxFileBytes,
      }).mapRepository(projectPath);
      return {
        files: this.filterCodeFiles(projectPath, structure.files),
        skipped: (structure.skipped ?? []).map((skip) => ({
          file: skip.file,
          reason: skip.reason,
          size: skip.size,
        })),
      };
    } catch {
      return { files: [], skipped: [] };
    }
  }

  private filterCodeFiles(
    projectPath: string,
    discoveredFiles: DiscoveredAnalysisFile[]
  ): Array<{ path: string; size?: number }> {
    const supported = new Set(Object.keys(LANGUAGE_EXTENSIONS));
    const unique = new Map<string, { path: string; size?: number }>();
    for (const discovered of discoveredFiles) {
      const file = typeof discovered === 'string' ? discovered : discovered.path;
      const absolutePath = path.isAbsolute(file) ? file : path.resolve(projectPath, file);
      unique.set(absolutePath, {
        path: absolutePath,
        size: typeof discovered === 'string' ? undefined : discovered.size,
      });
    }
    return [...unique.values()]
      .filter((file) => {
        const extension = path.extname(file.path).toLowerCase();
        return supported.has(extension) &&
          this.options.languages.includes(LANGUAGE_EXTENSIONS[extension]);
      })
      .filter((file) => this.options.include.length === 0 ||
        this.options.include.some((pattern) => file.path.includes(pattern)))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  private async selectFilesWithinLimits(
    candidates: Array<{ path: string; size?: number }>
  ): Promise<{
    files: string[];
    skipped: SkippedAnalysisFile[];
    bytes: number;
  }> {
    const selected: string[] = [];
    const skipped: SkippedAnalysisFile[] = [];
    let bytes = 0;

    for (const candidate of candidates) {
      const file = candidate.path;
      let size = candidate.size;
      if (size === undefined) {
        try {
          size = (await fs.stat(file)).size;
        } catch {
          skipped.push({ file, reason: 'stat-failed' });
          continue;
        }
      }

      if (size > this.options.maxFileBytes) {
        skipped.push({ file, reason: 'file-too-large', size });
        continue;
      }
      if (selected.length >= this.options.maxFiles) {
        skipped.push({ file, reason: 'file-limit', size });
        continue;
      }
      if (bytes + size > this.options.maxTotalBytes) {
        skipped.push({ file, reason: 'total-byte-limit', size });
        continue;
      }

      selected.push(file);
      bytes += size;
    }

    return { files: selected, skipped, bytes };
  }

  private async analyzeFiles(
    files: string[],
    metrics?: AnalysisMetrics
  ): Promise<Map<string, FileAnalysis>> {
    const analyses = new Map<string, FileAnalysis>();
    let cursor = 0;
    let inFlight = 0;
    const workerCount = Math.min(this.options.concurrency, files.length);

    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const index = cursor;
        cursor += 1;
        inFlight += 1;
        if (metrics) {
          metrics.maxInFlight = Math.max(metrics.maxInFlight, inFlight);
        }
        try {
          if (metrics) {
            metrics.fileReads += 1;
          }
          const analysis = await this.treeSitter.analyzeFile(files[index]);
          analyses.set(analysis.filePath, analysis);
        } finally {
          inFlight -= 1;
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return analyses;
  }

  private buildBaseContext(
    analyses: Map<string, FileAnalysis>,
    projectPath: string
  ): SemanticContext {
    const symbols = {
      classes: [] as ExtractedSymbol[],
      interfaces: [] as ExtractedSymbol[],
      functions: [] as ExtractedSymbol[],
      types: [] as ExtractedSymbol[],
      enums: [] as ExtractedSymbol[],
    };

    const dependencyGraph = new Map<string, string[]>();
    const reverseDependencyGraph = new Map<string, string[]>();
    const languageCount: Record<string, number> = {};

    for (const [file, analysis] of analyses) {
      // Count by language
      const ext = path.extname(file);
      languageCount[ext] = (languageCount[ext] || 0) + 1;

      // Categorize symbols
      for (const symbol of analysis.symbols) {
        switch (symbol.kind) {
          case 'class':
            symbols.classes.push(symbol);
            break;
          case 'interface':
            symbols.interfaces.push(symbol);
            break;
          case 'function':
            symbols.functions.push(symbol);
            break;
          case 'type':
            symbols.types.push(symbol);
            break;
          case 'enum':
            symbols.enums.push(symbol);
            break;
        }
      }

      // Build dependency graph
      const importedFiles = analysis.imports
        .map((imp) => this.resolveImportPath(file, imp.source, projectPath))
        .filter((f): f is string => f !== null);

      dependencyGraph.set(file, importedFiles);

      for (const importedFile of importedFiles) {
        if (!reverseDependencyGraph.has(importedFile)) {
          reverseDependencyGraph.set(importedFile, []);
        }
        reverseDependencyGraph.get(importedFile)!.push(file);
      }
    }

    return {
      symbols,
      dependencies: {
        graph: dependencyGraph,
        reverseGraph: reverseDependencyGraph,
      },
      architecture: {
        layers: [],
        patterns: [],
        entryPoints: [],
        publicAPI: [],
      },
      stats: {
        totalFiles: analyses.size,
        totalSymbols: Object.values(symbols).flat().length,
        languageBreakdown: languageCount,
        analysisTimeMs: 0,
      },
    };
  }

  private resolveImportPath(
    fromFile: string,
    importSource: string,
    projectPath: string
  ): string | null {
    // Skip external packages
    if (!importSource.startsWith('.') && !importSource.startsWith('/')) {
      return null;
    }

    const dir = path.dirname(fromFile);
    const resolved = path.resolve(dir, importSource);

    // Try common extensions
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js', '.py', '.go'];

    for (const ext of extensions) {
      const withExt = resolved + ext;
      if (this.fileExistsSync(withExt)) {
        return withExt;
      }
    }

    // Try without extension (might already have it)
    if (this.fileExistsSync(resolved)) {
      return resolved;
    }

    return null;
  }

  private fileExistsSync(filePath: string): boolean {
    try {
      require('fs').accessSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private detectArchitecture(
    analyses: Map<string, FileAnalysis>,
    projectPath: string
  ): SemanticContext['architecture'] {
    const layers = this.detectLayers(analyses, projectPath);
    const patterns = this.detectPatterns(analyses);
    const entryPoints = this.findEntryPoints(analyses, projectPath);
    const publicAPI = this.findPublicAPI(analyses);

    // Calculate layer dependencies
    this.calculateLayerDependencies(layers, analyses, projectPath);

    return { layers, patterns, entryPoints, publicAPI };
  }

  private detectLayers(
    analyses: Map<string, FileAnalysis>,
    projectPath: string
  ): ArchitectureLayer[] {
    const layerHeuristics = [
      {
        name: 'Services',
        patterns: [/services?/i, /use-?cases?/i, /application/i],
        description: 'Business logic and orchestration',
      },
      {
        name: 'Controllers',
        patterns: [/controllers?/i, /handlers?/i, /routes?/i, /api/i],
        description: 'Request handling and routing',
      },
      {
        name: 'Models',
        patterns: [/models?/i, /entities/i, /domain/i, /schemas?/i],
        description: 'Data structures and domain objects',
      },
      {
        name: 'Repositories',
        patterns: [/repositor/i, /data/i, /database/i, /persistence/i],
        description: 'Data access and persistence',
      },
      {
        name: 'Utils',
        patterns: [/utils?/i, /helpers?/i, /lib/i, /common/i, /shared/i],
        description: 'Shared utilities and helpers',
      },
      {
        name: 'Generators',
        patterns: [/generators?/i, /builders?/i, /factories?/i],
        description: 'Content and object generation',
      },
      {
        name: 'Components',
        patterns: [/components?/i, /views?/i, /pages?/i, /screens?/i],
        description: 'UI components and views',
      },
      {
        name: 'Config',
        patterns: [/config/i, /settings?/i, /constants?/i],
        description: 'Configuration and constants',
      },
    ];

    const layers: ArchitectureLayer[] = [];
    const filesByLayer = new Map<string, string[]>();

    for (const [file] of analyses) {
      const relativePath = path.relative(projectPath, file);

      for (const heuristic of layerHeuristics) {
        if (heuristic.patterns.some((p) => p.test(relativePath))) {
          if (!filesByLayer.has(heuristic.name)) {
            filesByLayer.set(heuristic.name, []);
          }
          filesByLayer.get(heuristic.name)!.push(file);
          break;
        }
      }
    }

    for (const [layerName, files] of filesByLayer) {
      const heuristic = layerHeuristics.find((h) => h.name === layerName)!;
      const layerSymbols: ExtractedSymbol[] = [];
      const directories = new Set<string>();

      for (const file of files) {
        const analysis = analyses.get(file);
        if (analysis) {
          layerSymbols.push(...analysis.symbols);
          directories.add(path.dirname(path.relative(projectPath, file)));
        }
      }

      if (layerSymbols.length > 0) {
        layers.push({
          name: layerName,
          description: heuristic.description,
          directories: [...directories],
          symbols: layerSymbols,
          dependsOn: [],
        });
      }
    }

    return layers;
  }

  private detectPatterns(analyses: Map<string, FileAnalysis>): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const allSymbols = [...analyses.values()].flatMap((a) => a.symbols);

    // Factory Pattern
    const factories = allSymbols.filter(
      (s) => /Factory$/i.test(s.name) && s.kind === 'class'
    );
    if (factories.length > 0) {
      patterns.push({
        name: 'Factory',
        confidence: 0.9,
        locations: factories.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Creates instances of related objects without specifying concrete classes',
      });
    }

    // Singleton Pattern
    const singletons = allSymbols.filter(
      (s) => s.kind === 'class' && /Singleton|Instance/i.test(s.name)
    );
    if (singletons.length > 0) {
      patterns.push({
        name: 'Singleton',
        confidence: 0.7,
        locations: singletons.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Ensures a class has only one instance',
      });
    }

    // Repository Pattern
    const repositories = allSymbols.filter(
      (s) => /Repository$/i.test(s.name) && (s.kind === 'class' || s.kind === 'interface')
    );
    if (repositories.length > 0) {
      patterns.push({
        name: 'Repository',
        confidence: 0.9,
        locations: repositories.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Abstracts data access logic',
      });
    }

    // Service Layer Pattern
    const services = allSymbols.filter(
      (s) => /Service$/i.test(s.name) && s.kind === 'class'
    );
    if (services.length > 0) {
      patterns.push({
        name: 'Service Layer',
        confidence: 0.85,
        locations: services.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Encapsulates business logic in service classes',
      });
    }

    // Controller Pattern
    const controllers = allSymbols.filter(
      (s) => /Controller$/i.test(s.name) && s.kind === 'class'
    );
    if (controllers.length > 0) {
      patterns.push({
        name: 'Controller',
        confidence: 0.9,
        locations: controllers.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Handles incoming requests and returns responses',
      });
    }

    // Builder Pattern
    const builders = allSymbols.filter(
      (s) => /Builder$/i.test(s.name) && s.kind === 'class'
    );
    if (builders.length > 0) {
      patterns.push({
        name: 'Builder',
        confidence: 0.85,
        locations: builders.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Separates object construction from its representation',
      });
    }

    // Observer Pattern (event emitters)
    const observers = allSymbols.filter(
      (s) =>
        (s.kind === 'class' || s.kind === 'interface') &&
        /Observer|Listener|Emitter|Handler$/i.test(s.name)
    );
    if (observers.length > 0) {
      patterns.push({
        name: 'Observer',
        confidence: 0.75,
        locations: observers.map((s) => ({ file: s.location.file, symbol: s.name })),
        description: 'Defines a subscription mechanism to notify multiple objects',
      });
    }

    return patterns;
  }

  private findEntryPoints(
    analyses: Map<string, FileAnalysis>,
    projectPath: string
  ): string[] {
    const entryPoints: string[] = [];
    const entryPatterns = [
      /^(index|main|app|server|cli)\.(ts|js|tsx|jsx)$/,
      /src\/(index|main|app)\.(ts|js)$/,
      /^bin\//,
    ];

    for (const [file] of analyses) {
      const relativePath = path.relative(projectPath, file);
      const basename = path.basename(file);

      if (entryPatterns.some((p) => p.test(basename) || p.test(relativePath))) {
        entryPoints.push(relativePath);
      }
    }

    return entryPoints;
  }

  private findPublicAPI(analyses: Map<string, FileAnalysis>): ExtractedSymbol[] {
    const publicSymbols: ExtractedSymbol[] = [];

    for (const [, analysis] of analyses) {
      for (const symbol of analysis.symbols) {
        if (
          symbol.exported &&
          (symbol.kind === 'class' ||
            symbol.kind === 'interface' ||
            symbol.kind === 'function' ||
            symbol.kind === 'type')
        ) {
          publicSymbols.push(symbol);
        }
      }
    }

    // Sort by name for consistency
    return publicSymbols.sort((a, b) => a.name.localeCompare(b.name));
  }

  private calculateLayerDependencies(
    layers: ArchitectureLayer[],
    analyses: Map<string, FileAnalysis>,
    projectPath: string
  ): void {
    const fileToLayer = new Map<string, string>();

    for (const layer of layers) {
      for (const dir of layer.directories) {
        for (const [file] of analyses) {
          const relFile = path.relative(projectPath, file);
          if (relFile.startsWith(dir)) {
            fileToLayer.set(file, layer.name);
          }
        }
      }
    }

    for (const layer of layers) {
      const dependsOn = new Set<string>();

      for (const symbol of layer.symbols) {
        const file = symbol.location.file;
        const analysis = analyses.get(file);
        if (!analysis) continue;

        for (const imp of analysis.imports) {
          const resolved = this.resolveImportPath(file, imp.source, projectPath);
          if (resolved) {
            const depLayer = fileToLayer.get(resolved);
            if (depLayer && depLayer !== layer.name) {
              dependsOn.add(depLayer);
            }
          }
        }
      }

      layer.dependsOn = [...dependsOn];
    }
  }

  /**
   * Get a summary suitable for documentation generation
   */
  getSummary(context: SemanticContext, projectPath: string): string {
    const { symbols, architecture, stats } = context;

    const lines: string[] = [
      `## Codebase Analysis Summary\n`,
      `**Total Files**: ${stats.totalFiles}`,
      `**Total Symbols**: ${stats.totalSymbols}`,
      `**Analysis Time**: ${stats.analysisTimeMs}ms\n`,
      `### Language Breakdown\n`,
    ];

    for (const [ext, count] of Object.entries(stats.languageBreakdown)) {
      lines.push(`- ${ext}: ${count} files`);
    }

    if (architecture.layers.length > 0) {
      lines.push(`\n### Architecture Layers\n`);
      for (const layer of architecture.layers) {
        const symbolCount = layer.symbols.length;
        const deps = layer.dependsOn.length > 0 ? ` → ${layer.dependsOn.join(', ')}` : '';
        lines.push(`- **${layer.name}** (${symbolCount} symbols)${deps}`);
        lines.push(`  - ${layer.description}`);
      }
    }

    if (architecture.patterns.length > 0) {
      lines.push(`\n### Detected Patterns\n`);
      for (const pattern of architecture.patterns) {
        const confidence = Math.round(pattern.confidence * 100);
        lines.push(
          `- **${pattern.name}** (${confidence}% confidence): ${pattern.locations.length} occurrences`
        );
      }
    }

    if (architecture.entryPoints.length > 0) {
      lines.push(`\n### Entry Points\n`);
      for (const ep of architecture.entryPoints) {
        lines.push(`- \`${ep}\``);
      }
    }

    return lines.join('\n');
  }

  clearCache(): void {
    this.treeSitter.clearCache();
  }

  /**
   * Shutdown LSP servers gracefully
   */
  async shutdown(): Promise<void> {
    this.treeSitter.clearCache();
    if (this.lspLayer) {
      await this.lspLayer.shutdown();
    }
  }

  /**
   * Enhance Tree-sitter analysis with LSP semantic information
   * Adds type info, references, and implementations to key symbols
   */
  private async enhanceWithLSP(
    context: SemanticContext,
    projectPath: string
  ): Promise<void> {
    const allSymbols = [
      ...context.symbols.classes,
      ...context.symbols.interfaces,
      ...context.symbols.functions,
      ...context.symbols.types,
    ];

    // Prioritize symbols to enhance (exported and important ones first)
    const prioritizedSymbols = allSymbols
      .filter((s) => s.exported)
      .slice(0, 100); // Limit to avoid excessive LSP calls

    for (const symbol of prioritizedSymbols) {
      try {
        // Get type information via LSP hover
        const typeInfo = await this.lspLayer!.getTypeInfo(
          symbol.location.file,
          symbol.location.line,
          symbol.location.column || 0,
          projectPath
        );

        if (typeInfo) {
          symbol.typeInfo = typeInfo;
        }

        // For interfaces and classes, find implementations
        if (symbol.kind === 'interface' || symbol.kind === 'class') {
          const implementations = await this.lspLayer!.findImplementations(
            symbol.location.file,
            symbol.location.line,
            symbol.location.column || 0,
            projectPath
          );

          if (implementations.length > 0) {
            symbol.implementations = implementations;
          }
        }

        // Find references for exported symbols
        const references = await this.lspLayer!.findReferences(
          symbol.location.file,
          symbol.location.line,
          symbol.location.column || 0,
          projectPath
        );

        if (references.length > 0) {
          symbol.references = references;
        }
      } catch {
        // LSP errors are non-fatal, continue with other symbols
      }
    }
  }

  /**
   * Detect functional patterns in the codebase
   * These patterns indicate functional capabilities like auth, database, API, etc.
   */
  async detectFunctionalPatterns(projectPath: string): Promise<DetectedFunctionalPatterns> {
    return (await this.analyzeBundle(projectPath)).functionalPatterns;
  }

  private detectFunctionalPatternsFromAnalyses(
    files: string[],
    analyses: Map<string, FileAnalysis>
  ): DetectedFunctionalPatterns {
    const patterns: FunctionalPattern[] = [];
    const allSymbols = [...analyses.values()].flatMap((a) => a.symbols);
    const allImports = [...analyses.values()].flatMap((a) =>
      a.imports.map((imp) => ({ ...imp, file: a.filePath }))
    );

    // Authentication pattern detection
    const authPattern = this.detectAuthPattern(allSymbols, allImports, files);
    if (authPattern) patterns.push(authPattern);

    // Database pattern detection
    const dbPattern = this.detectDatabasePattern(allSymbols, allImports, files);
    if (dbPattern) patterns.push(dbPattern);

    // API pattern detection
    const apiPattern = this.detectApiPattern(allSymbols, allImports, files);
    if (apiPattern) patterns.push(apiPattern);

    // Cache pattern detection
    const cachePattern = this.detectCachePattern(allSymbols, allImports, files);
    if (cachePattern) patterns.push(cachePattern);

    // Queue/messaging pattern detection
    const queuePattern = this.detectQueuePattern(allSymbols, allImports, files);
    if (queuePattern) patterns.push(queuePattern);

    // WebSocket pattern detection
    const wsPattern = this.detectWebSocketPattern(allSymbols, allImports, files);
    if (wsPattern) patterns.push(wsPattern);

    // Logging pattern detection
    const loggingPattern = this.detectLoggingPattern(allSymbols, allImports, files);
    if (loggingPattern) patterns.push(loggingPattern);

    // Validation pattern detection
    const validationPattern = this.detectValidationPattern(allSymbols, allImports, files);
    if (validationPattern) patterns.push(validationPattern);

    // Error handling pattern detection
    const errorPattern = this.detectErrorHandlingPattern(allSymbols, allImports, files);
    if (errorPattern) patterns.push(errorPattern);

    // Testing pattern detection
    const testingPattern = this.detectTestingPattern(allSymbols, allImports, files);
    if (testingPattern) patterns.push(testingPattern);

    return {
      hasAuthPattern: patterns.some((p) => p.type === 'auth'),
      hasDatabasePattern: patterns.some((p) => p.type === 'database'),
      hasApiPattern: patterns.some((p) => p.type === 'api'),
      hasCachePattern: patterns.some((p) => p.type === 'cache'),
      hasQueuePattern: patterns.some((p) => p.type === 'queue'),
      hasWebSocketPattern: patterns.some((p) => p.type === 'websocket'),
      hasLoggingPattern: patterns.some((p) => p.type === 'logging'),
      hasValidationPattern: patterns.some((p) => p.type === 'validation'),
      hasErrorHandlingPattern: patterns.some((p) => p.type === 'error-handling'),
      hasTestingPattern: patterns.some((p) => p.type === 'testing'),
      patterns,
    };
  }

  private detectAuthPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for auth-related symbols
    const authSymbols = symbols.filter((s) =>
      /^(auth|login|logout|verify|jwt|token|session|password|credential|oauth)/i.test(s.name)
    );
    for (const sym of authSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Auth-related symbol: ${sym.name}`,
      });
    }

    // Check for auth-related imports
    const authImports = imports.filter((imp) =>
      /^(jsonwebtoken|passport|bcrypt|argon2|@auth|next-auth|express-session|cookie-session)/i.test(
        imp.source
      )
    );
    for (const imp of authImports) {
      indicators.push({
        file: imp.file,
        reason: `Auth library import: ${imp.source}`,
      });
    }

    // Check for auth-related files
    const authFiles = files.filter((f) =>
      /\/(auth|login|session|middleware)[\./]/i.test(f)
    );
    for (const f of authFiles) {
      indicators.push({
        file: f,
        reason: 'Auth-related file path',
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'auth',
      confidence: Math.min(1, indicators.length * 0.15),
      indicators: indicators.slice(0, 10),
      description: 'Authentication and authorization functionality',
    };
  }

  private detectDatabasePattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for database-related symbols
    const dbSymbols = symbols.filter((s) =>
      /^(repository|model|entity|schema|migration|query|database|db|prisma|sequelize|mongoose)/i.test(
        s.name
      )
    );
    for (const sym of dbSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Database-related symbol: ${sym.name}`,
      });
    }

    // Check for database-related imports
    const dbImports = imports.filter((imp) =>
      /^(prisma|@prisma|sequelize|mongoose|typeorm|knex|pg|mysql|mysql2|sqlite3|better-sqlite3|drizzle-orm|@supabase)/i.test(
        imp.source
      )
    );
    for (const imp of dbImports) {
      indicators.push({
        file: imp.file,
        reason: `Database library import: ${imp.source}`,
      });
    }

    // Check for database-related files
    const dbFiles = files.filter((f) =>
      /\/(models?|repositories|entities|migrations?|schemas?|database)[\./]/i.test(f)
    );
    for (const f of dbFiles) {
      indicators.push({
        file: f,
        reason: 'Database-related file path',
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'database',
      confidence: Math.min(1, indicators.length * 0.15),
      indicators: indicators.slice(0, 10),
      description: 'Database access and ORM functionality',
    };
  }

  private detectApiPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for API-related symbols
    const apiSymbols = symbols.filter((s) =>
      /^(controller|handler|router|route|endpoint|api|rest|graphql|resolver)/i.test(s.name)
    );
    for (const sym of apiSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `API-related symbol: ${sym.name}`,
      });
    }

    // Check for API framework imports
    const apiImports = imports.filter((imp) =>
      /^(express|fastify|koa|hapi|@nestjs|next|nuxt|graphql|apollo|@apollo|trpc|@trpc)/i.test(
        imp.source
      )
    );
    for (const imp of apiImports) {
      indicators.push({
        file: imp.file,
        reason: `API framework import: ${imp.source}`,
      });
    }

    // Check for API-related files
    const apiFiles = files.filter((f) =>
      /\/(routes?|controllers?|handlers?|api|endpoints?|resolvers?)[\./]/i.test(f)
    );
    for (const f of apiFiles) {
      indicators.push({
        file: f,
        reason: 'API-related file path',
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'api',
      confidence: Math.min(1, indicators.length * 0.15),
      indicators: indicators.slice(0, 10),
      description: 'API endpoints and routing',
    };
  }

  private detectCachePattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    _files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for cache-related symbols
    const cacheSymbols = symbols.filter((s) =>
      /^(cache|redis|memcache|lru|ttl)/i.test(s.name)
    );
    for (const sym of cacheSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Cache-related symbol: ${sym.name}`,
      });
    }

    // Check for cache-related imports
    const cacheImports = imports.filter((imp) =>
      /^(redis|ioredis|memcached|lru-cache|node-cache|cache-manager)/i.test(imp.source)
    );
    for (const imp of cacheImports) {
      indicators.push({
        file: imp.file,
        reason: `Cache library import: ${imp.source}`,
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'cache',
      confidence: Math.min(1, indicators.length * 0.2),
      indicators: indicators.slice(0, 10),
      description: 'Caching and data memoization',
    };
  }

  private detectQueuePattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    _files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for queue-related symbols
    const queueSymbols = symbols.filter((s) =>
      /^(queue|worker|job|task|consumer|producer|message|event)/i.test(s.name)
    );
    for (const sym of queueSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Queue-related symbol: ${sym.name}`,
      });
    }

    // Check for queue-related imports
    const queueImports = imports.filter((imp) =>
      /^(bull|bullmq|bee-queue|agenda|amqplib|rabbitmq|kafka|kafkajs|sqs)/i.test(imp.source)
    );
    for (const imp of queueImports) {
      indicators.push({
        file: imp.file,
        reason: `Queue library import: ${imp.source}`,
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'queue',
      confidence: Math.min(1, indicators.length * 0.2),
      indicators: indicators.slice(0, 10),
      description: 'Message queues and background jobs',
    };
  }

  private detectWebSocketPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    _files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for WebSocket-related symbols
    const wsSymbols = symbols.filter((s) =>
      /^(websocket|socket|ws|realtime|broadcast|subscribe)/i.test(s.name)
    );
    for (const sym of wsSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `WebSocket-related symbol: ${sym.name}`,
      });
    }

    // Check for WebSocket-related imports
    const wsImports = imports.filter((imp) =>
      /^(ws|socket\.io|@socket\.io|sockjs|pusher|ably)/i.test(imp.source)
    );
    for (const imp of wsImports) {
      indicators.push({
        file: imp.file,
        reason: `WebSocket library import: ${imp.source}`,
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'websocket',
      confidence: Math.min(1, indicators.length * 0.2),
      indicators: indicators.slice(0, 10),
      description: 'Real-time WebSocket communication',
    };
  }

  private detectLoggingPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    _files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for logging-related symbols
    const logSymbols = symbols.filter((s) =>
      /^(logger|log|logging|telemetry|metrics)/i.test(s.name)
    );
    for (const sym of logSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Logging-related symbol: ${sym.name}`,
      });
    }

    // Check for logging-related imports
    const logImports = imports.filter((imp) =>
      /^(winston|pino|bunyan|log4js|morgan|@sentry|newrelic|datadog)/i.test(imp.source)
    );
    for (const imp of logImports) {
      indicators.push({
        file: imp.file,
        reason: `Logging library import: ${imp.source}`,
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'logging',
      confidence: Math.min(1, indicators.length * 0.2),
      indicators: indicators.slice(0, 10),
      description: 'Logging and observability',
    };
  }

  private detectValidationPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    _files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for validation-related symbols
    const validSymbols = symbols.filter((s) =>
      /^(valid|schema|sanitize|parse|check|assert)/i.test(s.name)
    );
    for (const sym of validSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Validation-related symbol: ${sym.name}`,
      });
    }

    // Check for validation-related imports
    const validImports = imports.filter((imp) =>
      /^(zod|yup|joi|ajv|class-validator|validator|io-ts|valibot)/i.test(imp.source)
    );
    for (const imp of validImports) {
      indicators.push({
        file: imp.file,
        reason: `Validation library import: ${imp.source}`,
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'validation',
      confidence: Math.min(1, indicators.length * 0.2),
      indicators: indicators.slice(0, 10),
      description: 'Input validation and schema enforcement',
    };
  }

  private detectErrorHandlingPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for error-related symbols
    const errorSymbols = symbols.filter((s) =>
      /^(error|exception|handler|catch|fallback)/i.test(s.name)
    );
    for (const sym of errorSymbols) {
      indicators.push({
        file: sym.location.file,
        symbol: sym.name,
        line: sym.location.line,
        reason: `Error handling symbol: ${sym.name}`,
      });
    }

    // Check for error-related files
    const errorFiles = files.filter((f) =>
      /\/(errors?|exceptions?)[\./]/i.test(f)
    );
    for (const f of errorFiles) {
      indicators.push({
        file: f,
        reason: 'Error handling file path',
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'error-handling',
      confidence: Math.min(1, indicators.length * 0.15),
      indicators: indicators.slice(0, 10),
      description: 'Error handling and exception management',
    };
  }

  private detectTestingPattern(
    symbols: ExtractedSymbol[],
    imports: Array<{ source: string; specifiers: string[]; file: string }>,
    files: string[]
  ): FunctionalPattern | null {
    const indicators: PatternIndicator[] = [];

    // Check for test-related imports
    const testImports = imports.filter((imp) =>
      /^(jest|vitest|mocha|chai|@testing-library|cypress|playwright|supertest)/i.test(imp.source)
    );
    for (const imp of testImports) {
      indicators.push({
        file: imp.file,
        reason: `Test library import: ${imp.source}`,
      });
    }

    // Check for test files
    const testFiles = files.filter((f) =>
      /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f) || /\/__tests__\//.test(f)
    );
    for (const f of testFiles.slice(0, 5)) {
      indicators.push({
        file: f,
        reason: 'Test file',
      });
    }

    if (indicators.length === 0) return null;

    return {
      type: 'testing',
      confidence: Math.min(1, indicators.length * 0.15),
      indicators: indicators.slice(0, 10),
      description: 'Testing infrastructure and test files',
    };
  }

  /**
   * Trace execution flow from an entry point
   * Uses tree-sitter to extract call expressions and build flow graph
   */
  async traceFlow(
    projectPath: string,
    entryFile: string,
    entryFunction?: string
  ): Promise<ExecutionFlow> {
    const absoluteEntryFile = path.isAbsolute(entryFile)
      ? entryFile
      : path.join(projectPath, entryFile);

    const nodes: FlowNode[] = [];
    const edges: FlowEdge[] = [];
    const visited = new Set<string>();

    // Analyze entry file
    const analysis = await this.treeSitter.analyzeFile(absoluteEntryFile);

    // Find entry point
    let entrySymbol = analysis.symbols[0];
    if (entryFunction) {
      const found = analysis.symbols.find(
        (s) => s.name === entryFunction && (s.kind === 'function' || s.kind === 'method')
      );
      if (found) entrySymbol = found;
    }

    if (!entrySymbol) {
      return {
        entryPoint: {
          file: absoluteEntryFile,
          symbol: 'unknown',
          line: 1,
          type: 'entry',
        },
        nodes: [],
        edges: [],
        mermaidDiagram: 'flowchart TD\n    A[Entry] --> B[No symbols found]',
      };
    }

    const entryNode: FlowNode = {
      file: absoluteEntryFile,
      symbol: entrySymbol.name,
      line: entrySymbol.location.line,
      type: 'entry',
    };
    nodes.push(entryNode);

    // Build flow graph using file content analysis
    await this.traceCallsFromFile(
      absoluteEntryFile,
      entryNode,
      nodes,
      edges,
      visited,
      projectPath,
      3 // Max depth
    );

    // Generate Mermaid diagram
    const mermaidDiagram = this.generateMermaidDiagram(nodes, edges);

    return {
      entryPoint: entryNode,
      nodes,
      edges,
      mermaidDiagram,
    };
  }

  private async traceCallsFromFile(
    filePath: string,
    currentNode: FlowNode,
    nodes: FlowNode[],
    edges: FlowEdge[],
    visited: Set<string>,
    projectPath: string,
    maxDepth: number
  ): Promise<void> {
    if (maxDepth <= 0) return;

    const nodeKey = `${filePath}:${currentNode.symbol}`;
    if (visited.has(nodeKey)) return;
    visited.add(nodeKey);

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const analysis = await this.treeSitter.analyzeFile(filePath);

      // Extract function calls using regex (simple approximation)
      // This could be enhanced with tree-sitter AST traversal
      const callPattern = /(\w+)\s*\(/g;
      let match;
      const calls: string[] = [];

      while ((match = callPattern.exec(content)) !== null) {
        const funcName = match[1];
        // Skip common keywords and built-ins
        if (!/^(if|for|while|switch|return|await|async|function|const|let|var|new|typeof|instanceof|import|export|class|interface|type)$/.test(funcName)) {
          if (!calls.includes(funcName)) {
            calls.push(funcName);
          }
        }
      }

      // Match calls to symbols in the analysis
      for (const call of calls.slice(0, 20)) {
        // Check if it's a local symbol
        const localSymbol = analysis.symbols.find((s) => s.name === call);
        if (localSymbol) {
          const callNode: FlowNode = {
            file: filePath,
            symbol: call,
            line: localSymbol.location.line,
            type: 'call',
          };

          if (!nodes.find((n) => n.file === callNode.file && n.symbol === callNode.symbol)) {
            nodes.push(callNode);
            edges.push({ from: currentNode, to: callNode });

            await this.traceCallsFromFile(
              filePath,
              callNode,
              nodes,
              edges,
              visited,
              projectPath,
              maxDepth - 1
            );
          }
        }

        // Check if it's an imported symbol
        for (const imp of analysis.imports) {
          if (imp.specifiers.includes(call)) {
            const resolvedPath = this.resolveImportPath(filePath, imp.source, projectPath);
            if (resolvedPath) {
              const importedAnalysis = await this.treeSitter.analyzeFile(resolvedPath);
              const importedSymbol = importedAnalysis.symbols.find((s) => s.name === call);

              if (importedSymbol) {
                const callNode: FlowNode = {
                  file: resolvedPath,
                  symbol: call,
                  line: importedSymbol.location.line,
                  type: 'call',
                };

                if (!nodes.find((n) => n.file === callNode.file && n.symbol === callNode.symbol)) {
                  nodes.push(callNode);
                  edges.push({ from: currentNode, to: callNode });

                  await this.traceCallsFromFile(
                    resolvedPath,
                    callNode,
                    nodes,
                    edges,
                    visited,
                    projectPath,
                    maxDepth - 1
                  );
                }
              }
            }
          }
        }
      }
    } catch {
      // File read or analysis error, skip
    }
  }

  private generateMermaidDiagram(nodes: FlowNode[], edges: FlowEdge[]): string {
    if (nodes.length === 0) {
      return 'flowchart TD\n    A[No nodes]';
    }

    const lines: string[] = ['flowchart TD'];
    const nodeIds = new Map<string, string>();

    // Assign IDs to nodes
    nodes.forEach((node, index) => {
      const key = `${node.file}:${node.symbol}`;
      nodeIds.set(key, `N${index}`);
    });

    // Add nodes
    for (const node of nodes) {
      const key = `${node.file}:${node.symbol}`;
      const id = nodeIds.get(key)!;
      const label = `${node.symbol}`;
      const shape = node.type === 'entry' ? `([${label}])` : `[${label}]`;
      lines.push(`    ${id}${shape}`);
    }

    // Add edges
    for (const edge of edges) {
      const fromKey = `${edge.from.file}:${edge.from.symbol}`;
      const toKey = `${edge.to.file}:${edge.to.symbol}`;
      const fromId = nodeIds.get(fromKey);
      const toId = nodeIds.get(toKey);

      if (fromId && toId) {
        const label = edge.label ? `|${edge.label}|` : '';
        lines.push(`    ${fromId} -->${label} ${toId}`);
      }
    }

    return lines.join('\n');
  }
}

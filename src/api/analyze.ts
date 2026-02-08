import { loadConfig } from '../config/loadConfig';
import { defaultConfig } from '../config/schema';
import type { TDependConfig } from '../config/schema';
import { scanFiles } from '../parser/fileScanner';
import { parseProject } from '../parser/tsParser';
import { DependencyGraph } from '../graph/dependencyGraph';
import { detectCycles } from '../graph/cycleDetector';
import { computeAllMetrics } from '../metrics';
import { generateReport } from '../analysis/reporter';
import { deepMerge } from '../utils/deepMerge';
import type { AnalysisResult } from '../types/api';

/**
 * Options for the analyze() function.
 * These options are merged with config file settings (if any).
 */
export interface AnalyzeOptions {
  /** Root directory to analyze (default: 'src') */
  rootDir?: string;
  /** Glob patterns for files to include (default: ['src/**\/*.ts', 'src/**\/*.tsx']) */
  include?: string[];
  /** Glob patterns for files to exclude (default: ['**\/*.test.ts', '**\/*.spec.ts', 'dist']) */
  exclude?: string[];
  /** Path to config file. If not provided, looks for tdepend.config.json */
  config?: string;
  /** Fail analysis if cycles are detected (default: false) */
  failOnCycle?: boolean;
  /** Fail analysis if distance threshold is exceeded (default: true) */
  failOnThreshold?: boolean;
}

/**
 * Analyzes a TypeScript project and returns complete dependency analysis.
 *
 * This is the main entry point for programmatic usage of tdepend.
 * It orchestrates the entire analysis pipeline:
 * 1. Load and merge configuration
 * 2. Scan files matching include/exclude patterns
 * 3. Parse TypeScript modules
 * 4. Build dependency graph
 * 5. Detect cycles
 * 6. Compute metrics (coupling, abstractness, instability, distance)
 * 7. Generate report with violations
 *
 * @param options - Analysis options (merged with config file if present)
 * @returns Complete analysis result with modules, graph, metrics, and report
 *
 * @example
 * ```typescript
 * import { analyze } from 'tdepend';
 *
 * const result = await analyze({
 *   rootDir: 'src',
 *   include: ['src/**\/*.ts'],
 *   failOnCycle: true
 * });
 *
 * console.log(`Analyzed ${result.modules.length} modules`);
 * console.log(`Found ${result.cycles.length} cycles`);
 * ```
 */
export async function analyze(options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  // Load config from file (or use defaults if no file exists)
  const baseConfig = options.config ? loadConfig(options.config) : loadConfig();

  // Create partial config from options
  const optionsConfig: Partial<TDependConfig> = {};

  if (options.rootDir !== undefined) {
    optionsConfig.rootDir = options.rootDir;
  }
  if (options.include !== undefined) {
    optionsConfig.include = options.include;
  }
  if (options.exclude !== undefined) {
    optionsConfig.exclude = options.exclude;
  }
  if (options.failOnCycle !== undefined || options.failOnThreshold !== undefined) {
    optionsConfig.ci = {
      ...baseConfig.ci,
      ...(options.failOnCycle !== undefined && { failOnCycle: options.failOnCycle }),
      ...(options.failOnThreshold !== undefined && { failOnThreshold: options.failOnThreshold }),
    };
  }

  // Merge configs (options override file config)
  const config = deepMerge(baseConfig, optionsConfig) as TDependConfig;

  // Run analysis pipeline
  const files = await scanFiles(config);
  const modules = parseProject(files);
  const graph = new DependencyGraph(modules);
  const cycles = detectCycles(graph);
  const metrics = computeAllMetrics(graph, modules, cycles);
  const report = generateReport(modules, metrics, cycles, config);

  return {
    modules,
    graph,
    cycles,
    metrics,
    report,
    config,
  };
}

/**
 * Analyzes a TypeScript project using a provided configuration object.
 *
 * This is useful when you want full control over the configuration
 * without loading from a file or merging with defaults.
 *
 * @param config - Complete TDependConfig object
 * @returns Complete analysis result with modules, graph, metrics, and report
 *
 * @example
 * ```typescript
 * import { analyzeWithConfig, defaultConfig } from 'tdepend';
 *
 * const result = await analyzeWithConfig({
 *   ...defaultConfig,
 *   rootDir: 'src',
 *   ci: {
 *     ...defaultConfig.ci,
 *     failOnCycle: true
 *   }
 * });
 * ```
 */
export async function analyzeWithConfig(config: TDependConfig): Promise<AnalysisResult> {
  const files = await scanFiles(config);
  const modules = parseProject(files);
  const graph = new DependencyGraph(modules);
  const cycles = detectCycles(graph);
  const metrics = computeAllMetrics(graph, modules, cycles);
  const report = generateReport(modules, metrics, cycles, config);

  return {
    modules,
    graph,
    cycles,
    metrics,
    report,
    config,
  };
}

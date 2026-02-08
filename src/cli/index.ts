#!/usr/bin/env node
import { Command } from 'commander';

import { loadConfig } from '../config/loadConfig';
import { generateReport, formatConsoleOutput, formatJsonOutput } from '../analysis/reporter';
import { DependencyGraph } from '../graph/dependencyGraph';
import { detectCycles } from '../graph/cycleDetector';
import { computeAllMetrics } from '../metrics';
import { scanFiles } from '../parser/fileScanner';
import { parseProject } from '../parser/tsParser';
import type { TDependConfig } from '../config/schema';
import { log } from '../utils/log';
import { exportToFile } from '../api/export';
import type { AnalysisResult } from '../types/api';

async function runAnalysis(config: TDependConfig): Promise<AnalysisResult | null> {
  log(config, '✓ Configuration loaded successfully');
  log(config, `  Root directory: ${config.rootDir}`);
  log(config, `  Enabled metrics: ${config.metrics.enabled.join(', ')}`);

  if (config.analysis.target) {
    log(config, `  Analysis scope: ${config.analysis.target} = ${config.analysis.value}`);
  }

  log(config, '\n📁 Scanning files...');
  const files = await scanFiles(config);
  log(config, `✓ Found ${files.length} TypeScript files`);

  if (files.length === 0) {
    log(config, '\n⚠ No files found matching the configured patterns.');
    process.exitCode = 0;
    return null;
  }

  log(config, '\n📝 Parsing modules...');
  const modules = parseProject(files);
  log(config, `✓ Parsed ${modules.length} modules`);

  log(config, '\n🔗 Building dependency graph...');
  const graph = new DependencyGraph(modules);
  log(config, '✓ Dependency graph built');

  log(config, '\n🔄 Detecting cycles...');
  const cycles = detectCycles(graph);
  log(config, `✓ Found ${cycles.length} cycle(s)`);

  if (checkCyclesAndFail(cycles, config.ci.failOnCycle)) {
    if (config.ci.outputFormat !== 'json') {
      process.exitCode = 1;
      return null;
    }
  }

  log(config, '\n📐 Computing metrics...');
  const metrics = computeAllMetrics(graph, modules, cycles);
  log(config, '✓ Metrics computed');

  const report = generateReport(modules, metrics, cycles, config);

  // Create AnalysisResult for potential export
  const result: AnalysisResult = {
    modules,
    graph,
    cycles,
    metrics,
    report,
    config,
  };

  if (config.ci.outputFormat === 'json') {
    console.log(formatJsonOutput(report));
  } else {
    formatConsoleOutput(report, config);
  }

  if (!report.success) {
    if (config.ci.outputFormat !== 'json') {
      console.error(
        report.violations.cycles.length > 0 && config.ci.failOnCycle
          ? '\n❌ Error: Cycles detected in dependency graph'
          : '\n❌ Error: Modules exceed distance threshold',
      );
    }
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }

  return result;
}

function checkCyclesAndFail(cycles: string[][], failOnCycle: boolean): boolean {
  if (cycles.length > 0 && failOnCycle) {
    console.error('\n❌ Error: Cycles detected in dependency graph');
    for (const cycle of cycles) {
      const fileNames = cycle.map((p) => p.split('/').pop()).join(' → ');
      console.error(`  - ${fileNames}`);
    }
    return true;
  }
  return false;
}

interface AnalyzeOptions {
  config?: string;
  class?: string;
  namespace?: string;
  ci?: boolean;
  export?: string;
  output?: string;
}

const program = new Command();

program
  .name('tdepend')
  .description('TDepend: TypeScript dependency analysis tool')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a TypeScript project for dependencies and metrics')
  .option('-c, --config <path>', 'Path to config file (tdepend.config.json)')
  .option('--class <name>', 'Analyze a specific class by name')
  .option('--namespace <name>', 'Analyze a specific namespace by name')
  .option('--ci', 'Run in CI mode with JSON output and strict exit codes')
  .option('-e, --export <path>', 'Export full analysis to JSON file')
  .option('-o, --output <path>', 'Alias for --export')
  .argument('[target]', 'Optional module/file path to analyze')
  .action(async (target: string | undefined, options: AnalyzeOptions) => {
    try {
      const config = loadConfig(options.config);

      if (options.ci) {
        config.ci.outputFormat = 'json';
      }

      if (target) {
        config.analysis.target = 'module';
        config.analysis.value = target;
      }
      if (options.class) {
        config.analysis.target = 'class';
        config.analysis.value = options.class;
      }
      if (options.namespace) {
        config.analysis.target = 'namespace';
        config.analysis.value = options.namespace;
      }

      const result = await runAnalysis(config);

      // Handle export if requested
      if (result && (options.export || options.output)) {
        const exportPath = options.export || options.output;
        await exportToFile(result, exportPath!);
        log(config, `\n✓ Analysis exported to ${exportPath}`);
      }
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.parse();

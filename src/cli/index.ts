#!/usr/bin/env node
import { Command } from 'commander';

import { loadConfig } from '../config/loadConfig';

interface AnalyzeOptions {
  config?: string;
  class?: string;
  namespace?: string;
  ci?: boolean;
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
  .argument('[target]', 'Optional module/file path to analyze')
  .action((target: string | undefined, options: AnalyzeOptions) => {
    try {
      const config = loadConfig(options.config);

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

      console.log('✓ Configuration loaded successfully');
      console.log(`  Root directory: ${config.rootDir}`);
      console.log(`  Enabled metrics: ${config.metrics.enabled.join(', ')}`);

      if (config.analysis.target) {
        console.log(`  Analysis scope: ${config.analysis.target} = ${config.analysis.value}`);
      }

      // TODO: Phase 3+ - Actual analysis implementation
      console.log('\n[Phase 2] Config system ready. Analysis implementation pending.');
      process.exitCode = 0;
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.parse();

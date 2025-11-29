#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();

program
  .name('tdepend')
  .description('TDepend: TypeScript dependency analysis tool')
  .version('0.1.0');

program
  .command('analyze')
  .description('Analyze a TypeScript project for dependencies and metrics')
  .option('-c, --config <path>', 'Path to config file (tdepend.config.json or jdepend.config.json)')
  .option('--class <name>', 'Analyze a specific class by name')
  .option('--namespace <name>', 'Analyze a specific namespace by name')
  .argument('[target]', 'Optional module/file path to analyze')
  .action((_target: string | undefined, _options: Record<string, unknown>) => {
    program.outputHelp();
    process.exitCode = 0;
  });

program.parse();

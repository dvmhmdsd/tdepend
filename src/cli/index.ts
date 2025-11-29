#!/usr/bin/env node
import { Command } from 'commander';

import { loadConfig } from '../config/loadConfig';
import { scanFiles } from '../parser/fileScanner';
import { parseProject } from '../parser/tsParser';

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
  .action(async (target: string | undefined, options: AnalyzeOptions) => {
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

      // Phase 3: Scan and parse files
      console.log('\n📁 Scanning files...');
      const files = await scanFiles(config);
      console.log(`✓ Found ${files.length} TypeScript files`);

      if (files.length === 0) {
        console.log('\n⚠ No files found matching the configured patterns.');
        process.exitCode = 0;
        return;
      }

      console.log('\n📝 Parsing modules...');
      const modules = parseProject(files);
      console.log(`✓ Parsed ${modules.length} modules`);

      // Display summary
      const totalImports = modules.reduce((sum, m) => sum + m.imports.length, 0);
      const totalExports = modules.reduce((sum, m) => sum + m.exports.length, 0);
      const totalClasses = modules.reduce((sum, m) => sum + m.classes.length, 0);
      const totalInterfaces = modules.reduce((sum, m) => sum + m.interfaces, 0);

      console.log('\n📊 Summary:');
      console.log(`  Total imports: ${totalImports}`);
      console.log(`  Total exports: ${totalExports}`);
      console.log(`  Total classes: ${totalClasses}`);
      console.log(`  Total interfaces: ${totalInterfaces}`);

      // Show sample of first few modules
      if (modules.length > 0) {
        console.log('\n📄 Sample modules:');
        for (const mod of modules.slice(0, 3)) {
          const fileName = mod.filePath.split('/').pop();
          console.log(
            `  - ${fileName}: ${mod.imports.length} imports, ${mod.exports.length} exports`,
          );
        }
        if (modules.length > 3) {
          console.log(`  ... and ${modules.length - 3} more`);
        }
      }

      process.exitCode = 0;
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.parse();

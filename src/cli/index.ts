#!/usr/bin/env node
import { Command } from 'commander';

import { loadConfig } from '../config/loadConfig';
import { DependencyGraph } from '../graph/dependencyGraph';
import { detectCycles } from '../graph/cycleDetector';
import { computeCouplingMetrics } from '../metrics/coupling';
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

      console.log('\n🔗 Building dependency graph...');
      const graph = new DependencyGraph(modules);
      console.log('✓ Dependency graph built');

      console.log('\n🔄 Detecting cycles...');
      const cycles = detectCycles(graph);
      console.log(`✓ Found ${cycles.length} cycle(s)`);

      if (cycles.length > 0 && config.ci.failOnCycle) {
        console.error('\n❌ Error: Cycles detected in dependency graph');
        for (const cycle of cycles.slice(0, 5)) {
          const fileNames = cycle.map((p) => p.split('/').pop()).join(' → ');
          console.error(`  - ${fileNames}`);
        }
        if (cycles.length > 5) {
          console.error(`  ... and ${cycles.length - 5} more`);
        }
        process.exitCode = 1;
        return;
      }

      console.log('\n📐 Computing coupling metrics...');
      const metrics = computeCouplingMetrics(graph, cycles);
      console.log('✓ Metrics computed');

      const totalImports = modules.reduce((sum, m) => sum + m.imports.length, 0);
      const totalExports = modules.reduce((sum, m) => sum + m.exports.length, 0);
      const totalClasses = modules.reduce((sum, m) => sum + m.classes.length, 0);
      const totalInterfaces = modules.reduce((sum, m) => sum + m.interfaces, 0);

      console.log('\n📊 Summary:');
      console.log(`  Total imports: ${totalImports}`);
      console.log(`  Total exports: ${totalExports}`);
      console.log(`  Total classes: ${totalClasses}`);
      console.log(`  Total interfaces: ${totalInterfaces}`);
      console.log(`  Cycles detected: ${cycles.length}`);

      if (cycles.length > 0) {
        console.log('\n⚠️  Cycles:');
        for (const cycle of cycles) {
          const fileNames = cycle.map((p) => p.split('/').pop()).join(' → ');
          console.log(`  - ${fileNames}`);
        }
      }

      const sortedByCa = [...metrics].sort((a, b) => b.Ca - a.Ca);
      const sortedByCe = [...metrics].sort((a, b) => b.Ce - a.Ce);
      const topCa = sortedByCa.slice(0, 3);
      const topCe = sortedByCe.slice(0, 3);

      if (topCa.length > 0) {
        console.log('\n📥 Top modules by Ca (Afferent Coupling):');
        for (const m of topCa) {
          const fileName = m.filePath.split('/').pop();
          console.log(`  - ${fileName}: Ca=${m.Ca}, Ce=${m.Ce}`);
        }
      }

      if (topCe.length > 0) {
        console.log('\n📤 Top modules by Ce (Efferent Coupling):');
        for (const m of topCe) {
          const fileName = m.filePath.split('/').pop();
          console.log(`  - ${fileName}: Ca=${m.Ca}, Ce=${m.Ce}`);
        }
      }

      process.exitCode = 0;
    } catch (error) {
      console.error('Error:', error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program.parse();

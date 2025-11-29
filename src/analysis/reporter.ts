import type { ParsedModule } from '../types/parser';
import type { ModuleMetrics } from '../types/graph';
import type { TDependConfig } from '../config/schema';

export interface AnalysisReport {
  summary: {
    totalModules: number;
    totalImports: number;
    totalExports: number;
    totalClasses: number;
    totalInterfaces: number;
    cyclesDetected: number;
  };
  metrics: ModuleMetrics[];
  violations: {
    cycles: string[][];
    thresholdExceeded: ModuleMetrics[];
  };
  success: boolean;
}

export function generateReport(
  modules: ParsedModule[],
  metrics: ModuleMetrics[],
  cycles: string[][],
  config: TDependConfig,
): AnalysisReport {
  const totalImports = modules.reduce((sum, m) => sum + m.imports.length, 0);
  const totalExports = modules.reduce((sum, m) => sum + m.exports.length, 0);
  const totalClasses = modules.reduce((sum, m) => sum + m.classes.length, 0);
  const totalInterfaces = modules.reduce((sum, m) => sum + m.interfaces, 0);

  const thresholdViolations = metrics.filter(
    (m) => m.distance > config.metrics.thresholds.distance,
  );

  const hasCycleViolation = cycles.length > 0 && config.ci.failOnCycle;
  const hasThresholdViolation =
    thresholdViolations.length > 0 && config.ci.failOnThreshold;

  return {
    summary: {
      totalModules: modules.length,
      totalImports,
      totalExports,
      totalClasses,
      totalInterfaces,
      cyclesDetected: cycles.length,
    },
    metrics,
    violations: {
      cycles,
      thresholdExceeded: thresholdViolations,
    },
    success: !hasCycleViolation && !hasThresholdViolation,
  };
}

function getZoneLabel(abstractness: number, instability: number): string {
  if (abstractness < 0.5 && instability < 0.5) return ' (Zone of Pain)';
  if (abstractness > 0.5 && instability > 0.5) return ' (Zone of Uselessness)';
  return '';
}

function displaySummary(summary: AnalysisReport['summary']): void {
  console.log('\n📊 Summary:');
  console.log(`  Total imports: ${summary.totalImports}`);
  console.log(`  Total exports: ${summary.totalExports}`);
  console.log(`  Total classes: ${summary.totalClasses}`);
  console.log(`  Total interfaces: ${summary.totalInterfaces}`);
  console.log(`  Cycles detected: ${summary.cyclesDetected}`);
}

function displayCycles(cycles: string[][]): void {
  if (cycles.length === 0) return;

  console.log('\n⚠️  Cycles:');
  for (const cycle of cycles) {
    const fileNames = cycle.map((p) => p.split('/').pop()).join(' → ');
    console.log(`  - ${fileNames}`);
  }
}

function displayTopMetrics(metrics: ModuleMetrics[]): void {
  const sortedByCa = [...metrics].sort((a, b) => b.Ca - a.Ca);
  const sortedByCe = [...metrics].sort((a, b) => b.Ce - a.Ce);
  const sortedByDistance = [...metrics].sort((a, b) => b.distance - a.distance);

  if (sortedByCa.length > 0) {
    console.log('\n📥 Top modules by Ca (Afferent Coupling):');
    for (const m of sortedByCa.slice(0, 3)) {
      const fileName = m.filePath.split('/').pop();
      console.log(`  - ${fileName}: Ca=${m.Ca}, Ce=${m.Ce}`);
    }
  }

  if (sortedByCe.length > 0) {
    console.log('\n📤 Top modules by Ce (Efferent Coupling):');
    for (const m of sortedByCe.slice(0, 3)) {
      const fileName = m.filePath.split('/').pop();
      console.log(`  - ${fileName}: Ca=${m.Ca}, Ce=${m.Ce}`);
    }
  }

  if (sortedByDistance.length > 0) {
    console.log('\n📏 Modules by Distance from Main Sequence:');
    for (const m of sortedByDistance.slice(0, 5)) {
      const fileName = m.filePath.split('/').pop();
      const zone = getZoneLabel(m.abstractness, m.instability);
      console.log(
        `  - ${fileName}: D=${m.distance.toFixed(2)}, A=${m.abstractness.toFixed(2)}, I=${m.instability.toFixed(2)}${zone}`,
      );
    }
  }
}

function displayThresholdViolations(violations: ModuleMetrics[], threshold: number): void {
  if (violations.length === 0) return;

  console.log(
    `\n⚠️  ${violations.length} module(s) exceed distance threshold (${threshold}):`,
  );
  for (const m of violations.slice(0, 5)) {
    const fileName = m.filePath.split('/').pop();
    console.log(`  - ${fileName}: D=${m.distance.toFixed(2)}`);
  }
  if (violations.length > 5) {
    console.log(`  ... and ${violations.length - 5} more`);
  }
}

export function formatConsoleOutput(report: AnalysisReport, config: TDependConfig): void {
  displaySummary(report.summary);
  displayCycles(report.violations.cycles);
  displayTopMetrics(report.metrics);
  displayThresholdViolations(
    report.violations.thresholdExceeded,
    config.metrics.thresholds.distance,
  );
}

export function formatJsonOutput(report: AnalysisReport): string {
  return JSON.stringify(
    {
      success: report.success,
      summary: report.summary,
      metrics: report.metrics,
      violations: {
        cycles: report.violations.cycles,
        thresholdExceeded: report.violations.thresholdExceeded.map((m) => ({
          filePath: m.filePath,
          distance: m.distance,
          abstractness: m.abstractness,
          instability: m.instability,
        })),
      },
    },
    null,
    2,
  );
}

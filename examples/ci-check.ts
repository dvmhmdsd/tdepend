/**
 * CI Integration Example
 *
 * This example shows how to use tdepend in a CI/CD pipeline
 * with custom quality gates and artifact export.
 */

import { analyze, exportToFile } from 'tdepend';

async function runCiCheck() {
  console.log('Running architecture quality checks...\n');

  // Run analysis with strict settings for CI
  const result = await analyze({
    rootDir: 'src',
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['**/*.test.ts', '**/*.spec.ts', 'dist', 'node_modules'],
    failOnCycle: true,
    failOnThreshold: true,
  });

  // Export full report as CI artifact
  await exportToFile(result, 'tdepend-report.json');
  console.log('✓ Report exported to tdepend-report.json\n');

  // Check for violations
  let hasViolations = false;

  // Check cycles
  if (result.report.violations.cycles.length > 0) {
    hasViolations = true;
    console.error('❌ Circular Dependencies Detected:');
    for (const cycle of result.report.violations.cycles) {
      const fileNames = cycle.map((p) => p.split('/').pop()).join(' → ');
      console.error(`  ${fileNames}`);
    }
    console.error('');
  }

  // Check distance threshold
  if (result.report.violations.thresholdExceeded.length > 0) {
    hasViolations = true;
    console.error('❌ Distance Threshold Violations:');
    console.error(
      `  ${result.report.violations.thresholdExceeded.length} module(s) exceed threshold`,
    );
    for (const violation of result.report.violations.thresholdExceeded.slice(0, 10)) {
      const fileName = violation.filePath.split('/').pop();
      console.error(
        `  ${fileName}: D=${violation.distance.toFixed(2)} (threshold: ${result.config.metrics.thresholds.distance})`,
      );
    }
    if (result.report.violations.thresholdExceeded.length > 10) {
      console.error(
        `  ... and ${result.report.violations.thresholdExceeded.length - 10} more`,
      );
    }
    console.error('');
  }

  // Custom quality gates
  const avgDistance =
    result.metrics.reduce((sum, m) => sum + m.distance, 0) / result.metrics.length;

  if (avgDistance > 0.5) {
    hasViolations = true;
    console.error(`❌ Average distance too high: ${avgDistance.toFixed(2)} (max: 0.5)\n`);
  }

  // Print success message or fail
  if (hasViolations) {
    console.error('Architecture quality checks FAILED');
    process.exit(1);
  } else {
    console.log('✓ All architecture quality checks passed');
    console.log(`  Modules: ${result.modules.length}`);
    console.log(`  Avg Distance: ${avgDistance.toFixed(2)}`);
    console.log(`  Cycles: ${result.cycles.length}`);
    process.exit(0);
  }
}

runCiCheck().catch((error) => {
  console.error('Error running CI check:', error);
  process.exit(1);
});

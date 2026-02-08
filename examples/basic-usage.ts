/**
 * Basic Usage Example
 *
 * This example demonstrates the simplest way to use tdepend as a library.
 */

import { analyze } from 'tdepend';

async function main() {
  // Analyze the project with default settings
  const result = await analyze({
    rootDir: 'src',
    include: ['src/**/*.ts'],
    exclude: ['**/*.test.ts', 'dist'],
  });

  // Print summary
  console.log('\n=== Analysis Summary ===');
  console.log(`Modules analyzed: ${result.modules.length}`);
  console.log(`Total imports: ${result.report.summary.totalImports}`);
  console.log(`Total exports: ${result.report.summary.totalExports}`);
  console.log(`Cycles detected: ${result.cycles.length}`);
  console.log(`Analysis success: ${result.report.success}`);

  // Find modules with high coupling
  console.log('\n=== High Coupling Modules (Ce > 5) ===');
  const highCoupling = result.metrics
    .filter((m) => m.Ce > 5)
    .sort((a, b) => b.Ce - a.Ce)
    .slice(0, 5);

  for (const metric of highCoupling) {
    const fileName = metric.filePath.split('/').pop();
    console.log(`${fileName}: Ce=${metric.Ce}, Ca=${metric.Ca}`);
  }

  // Find modules in "Zone of Pain" (low abstractness, low instability)
  console.log('\n=== Zone of Pain (A < 0.3, I < 0.3) ===');
  const painZone = result.metrics.filter(
    (m) => m.abstractness < 0.3 && m.instability < 0.3,
  );

  for (const metric of painZone) {
    const fileName = metric.filePath.split('/').pop();
    console.log(
      `${fileName}: A=${metric.abstractness.toFixed(2)}, I=${metric.instability.toFixed(2)}`,
    );
  }

  // Find modules exceeding distance threshold
  console.log('\n=== Distance Threshold Violations ===');
  if (result.report.violations.thresholdExceeded.length > 0) {
    console.log(
      `${result.report.violations.thresholdExceeded.length} module(s) exceed threshold`,
    );
    for (const violation of result.report.violations.thresholdExceeded.slice(0, 5)) {
      const fileName = violation.filePath.split('/').pop();
      console.log(`${fileName}: D=${violation.distance.toFixed(2)}`);
    }
  } else {
    console.log('No violations found');
  }
}

main().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

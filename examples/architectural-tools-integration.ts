/**
 * Architectural Tools Integration Example
 *
 * This example demonstrates how tdepend can be used alongside
 * other architectural tools like ts-arch, dependency-cruiser, etc.
 *
 * The key is that tdepend provides:
 * 1. Full dependency graph with serializable format
 * 2. Computed metrics (coupling, abstractness, instability, distance)
 * 3. Cycle detection with normalized IDs
 *
 * Other tools can consume this data for their own rule validation.
 */

import { analyze, exportToJson, toSerializable } from 'tdepend';
import { writeFile } from 'fs/promises';

async function generateArchitectureSnapshot() {
  console.log('Generating architecture snapshot for external tools...\n');

  // Run tdepend analysis
  const result = await analyze({
    rootDir: 'src',
    include: ['src/**/*.ts'],
  });

  // Export full serializable format
  const serialized = toSerializable(result);

  // Save complete snapshot
  await writeFile('architecture-snapshot.json', JSON.stringify(serialized, null, 2));
  console.log('✓ Full snapshot: architecture-snapshot.json');

  // Create simplified dependency map for ts-arch or similar tools
  const dependencyMap = {
    format: 'tdepend-v1',
    timestamp: new Date().toISOString(),
    modules: result.modules.map((m) => ({
      path: m.filePath,
      imports: m.imports,
      exports: m.exports,
      metrics: result.metrics.find((metric) => metric.filePath === m.filePath),
    })),
    violations: {
      cycles: result.report.violations.cycles,
      highCoupling: result.metrics.filter((m) => m.Ce > 10).map((m) => m.filePath),
      highDistance: result.report.violations.thresholdExceeded.map((m) => m.filePath),
    },
  };

  await writeFile('dependency-map.json', JSON.stringify(dependencyMap, null, 2));
  console.log('✓ Dependency map: dependency-map.json');

  // Create metrics summary for dashboards
  const metricsSummary = {
    timestamp: new Date().toISOString(),
    summary: result.report.summary,
    topCoupled: result.metrics
      .sort((a, b) => b.Ce + b.Ca - (a.Ce + a.Ca))
      .slice(0, 10)
      .map((m) => ({
        file: m.filePath.split('/').pop(),
        Ca: m.Ca,
        Ce: m.Ce,
        distance: m.distance,
      })),
    zoneAnalysis: {
      painZone: result.metrics.filter((m) => m.abstractness < 0.3 && m.instability < 0.3)
        .length,
      uselessZone: result.metrics.filter((m) => m.abstractness > 0.7 && m.instability > 0.7)
        .length,
      mainSequence: result.metrics.filter((m) => m.distance < 0.3).length,
    },
  };

  await writeFile('metrics-summary.json', JSON.stringify(metricsSummary, null, 2));
  console.log('✓ Metrics summary: metrics-summary.json');

  console.log('\nGenerated files can be consumed by:');
  console.log('  - ts-arch for rule validation');
  console.log('  - dependency-cruiser for dependency rules');
  console.log('  - Custom dashboards for visualization');
  console.log('  - CI/CD pipelines for quality gates');

  // Example: Check if specific architectural rules are violated
  console.log('\n=== Custom Rule Validation ===');

  // Rule 1: API layer should not depend on implementation details
  const apiModules = result.modules.filter((m) => m.filePath.includes('/api/'));
  const implModules = result.modules.filter(
    (m) => m.filePath.includes('/impl/') || m.filePath.includes('/internal/'),
  );

  for (const apiModule of apiModules) {
    for (const imp of apiModule.imports) {
      if (implModules.some((im) => im.filePath === imp)) {
        console.log(`⚠️  ${apiModule.filePath} should not import ${imp}`);
      }
    }
  }

  // Rule 2: Utilities should have low efferent coupling
  const utilModules = result.metrics.filter((m) => m.filePath.includes('/utils/'));
  for (const util of utilModules) {
    if (util.Ce > 3) {
      console.log(
        `⚠️  Utility ${util.filePath.split('/').pop()} has high Ce: ${util.Ce} (should be ≤ 3)`,
      );
    }
  }

  // Rule 3: Core modules should have high afferent coupling
  const coreModules = result.metrics.filter((m) => m.filePath.includes('/core/'));
  for (const core of coreModules) {
    if (core.Ca < 3) {
      console.log(
        `⚠️  Core module ${core.filePath.split('/').pop()} has low Ca: ${core.Ca} (should be > 3)`,
      );
    }
  }

  console.log('\nArchitecture snapshot complete!');
}

generateArchitectureSnapshot().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

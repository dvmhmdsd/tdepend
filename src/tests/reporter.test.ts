import { describe, expect, it } from 'vitest';

import { generateReport, formatJsonOutput } from '../analysis/reporter';
import { DependencyGraph } from '../graph/dependencyGraph';
import type { ModuleMetrics } from '../types/graph';
import type { ParsedModule } from '../types/parser';
import type { TDependConfig } from '../config/schema';

function createModule(filePath: string, imports: string[] = []): ParsedModule {
  return {
    filePath,
    imports,
    exports: [],
    classes: [],
    namespaces: [],
    interfaces: 0,
    totalTypes: 0,
  };
}

function createConfig(overrides: Partial<TDependConfig> = {}): TDependConfig {
  return {
    rootDir: 'src',
    include: ['**/*.ts'],
    exclude: ['**/*.test.ts'],
    metrics: {
      enabled: ['coupling', 'abstractness', 'distance', 'cycles'],
      thresholds: {
        distance: 0.6,
      },
    },
    analysis: {
      target: null,
      value: null,
    },
    ci: {
      failOnCycle: false,
      failOnThreshold: false,
      outputFormat: 'console',
    },
    ...overrides,
  };
}

function createMetrics(filePath: string, distance: number): ModuleMetrics {
  return {
    filePath,
    Ca: 0,
    Ce: 0,
    abstractness: 0,
    instability: 0,
    distance,
    cycles: [],
  };
}

describe('Report Generation', () => {
  it('generates report with summary statistics', () => {
    const modules = [
      { ...createModule('/a.ts'), imports: ['/b.ts'], exports: ['A'], interfaces: 2 },
      { ...createModule('/b.ts'), imports: [], exports: ['B', 'C'], interfaces: 1 },
    ];

    const graph = new DependencyGraph(modules);
    const metrics = [createMetrics('/a.ts', 0.3), createMetrics('/b.ts', 0.2)];
    const cycles: string[][] = [];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.summary.totalModules).toBe(2);
    expect(report.summary.totalImports).toBe(1);
    expect(report.summary.totalExports).toBe(3);
    expect(report.summary.totalInterfaces).toBe(3);
    expect(report.summary.cyclesDetected).toBe(0);
  });

  it('identifies threshold violations', () => {
    const modules = [createModule('/a.ts'), createModule('/b.ts')];
    const metrics = [createMetrics('/a.ts', 0.8), createMetrics('/b.ts', 0.4)];
    const cycles: string[][] = [];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.violations.thresholdExceeded).toHaveLength(1);
    expect(report.violations.thresholdExceeded[0].filePath).toBe('/a.ts');
  });

  it('includes cycles in violations', () => {
    const modules = [createModule('/a.ts'), createModule('/b.ts')];
    const metrics = [createMetrics('/a.ts', 0.3), createMetrics('/b.ts', 0.2)];
    const cycles = [['/a.ts', '/b.ts']];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.violations.cycles).toHaveLength(1);
    expect(report.summary.cyclesDetected).toBe(1);
  });

  it('marks success as false when cycles detected with failOnCycle', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.3)];
    const cycles = [['/a.ts', '/b.ts']];
    const config = createConfig({
      ci: { failOnCycle: true, failOnThreshold: false, outputFormat: 'console' },
    });

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.success).toBe(false);
  });

  it('marks success as false when thresholds exceeded with failOnThreshold', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.8)];
    const cycles: string[][] = [];
    const config = createConfig({
      ci: { failOnCycle: false, failOnThreshold: true, outputFormat: 'console' },
    });

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.success).toBe(false);
  });

  it('marks success as true when no violations', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.3)];
    const cycles: string[][] = [];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.success).toBe(true);
  });

  it('marks success as true when violations present but CI flags disabled', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.8)];
    const cycles = [['/a.ts', '/b.ts']];
    const config = createConfig({
      ci: { failOnCycle: false, failOnThreshold: false, outputFormat: 'console' },
    });

    const report = generateReport(modules, metrics, cycles, config);

    expect(report.success).toBe(true);
  });
});

describe('JSON Output', () => {
  it('generates valid JSON', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.3)];
    const cycles: string[][] = [];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);
    const json = formatJsonOutput(report);

    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes all required fields in JSON', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.3)];
    const cycles: string[][] = [];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);
    const json = formatJsonOutput(report);
    const parsed = JSON.parse(json);

    expect(parsed).toHaveProperty('success');
    expect(parsed).toHaveProperty('summary');
    expect(parsed).toHaveProperty('metrics');
    expect(parsed).toHaveProperty('violations');
    expect(parsed.violations).toHaveProperty('cycles');
    expect(parsed.violations).toHaveProperty('thresholdExceeded');
  });

  it('includes violation details in JSON', () => {
    const modules = [createModule('/a.ts')];
    const metrics = [createMetrics('/a.ts', 0.8)];
    const cycles = [['/a.ts', '/b.ts']];
    const config = createConfig();

    const report = generateReport(modules, metrics, cycles, config);
    const json = formatJsonOutput(report);
    const parsed = JSON.parse(json);

    expect(parsed.violations.cycles).toHaveLength(1);
    expect(parsed.violations.thresholdExceeded).toHaveLength(1);
    expect(parsed.violations.thresholdExceeded[0]).toHaveProperty('filePath');
    expect(parsed.violations.thresholdExceeded[0]).toHaveProperty('distance');
    expect(parsed.violations.thresholdExceeded[0]).toHaveProperty('abstractness');
    expect(parsed.violations.thresholdExceeded[0]).toHaveProperty('instability');
  });
});

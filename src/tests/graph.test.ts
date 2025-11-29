import { describe, expect, it } from 'vitest';

import { DependencyGraph } from '../graph/dependencyGraph';
import { detectCycles } from '../graph/cycleDetector';
import { computeCouplingMetrics } from '../metrics/coupling';
import type { ParsedModule } from '../types/parser';

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

describe('Dependency Graph', () => {
  it('builds graph from modules', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts']),
      createModule('/src/b.ts', ['/src/c.ts']),
      createModule('/src/c.ts'),
    ];

    const graph = new DependencyGraph(modules);
    const nodeA = graph.getNode('/src/a.ts')!;
    const nodeB = graph.getNode('/src/b.ts')!;
    const nodeC = graph.getNode('/src/c.ts')!;

    expect(nodeA.dependencies.size).toBe(1);
    expect(nodeA.dependencies.has('/src/b.ts')).toBe(true);
    expect(nodeB.dependents.has('/src/a.ts')).toBe(true);
    expect(nodeC.dependents.has('/src/b.ts')).toBe(true);
  });

  it('handles missing imports gracefully', () => {
    const modules: ParsedModule[] = [createModule('/src/a.ts', ['/src/missing.ts'])];

    const graph = new DependencyGraph(modules);
    const nodeA = graph.getNode('/src/a.ts')!;
    const nodeMissing = graph.getNode('/src/missing.ts')!;

    expect(nodeA.dependencies.has('/src/missing.ts')).toBe(true);
    expect(nodeMissing).toBeDefined();
    expect(nodeMissing.dependents.has('/src/a.ts')).toBe(true);
  });
});

describe('Coupling Metrics', () => {
  it('computes Ca and Ce correctly', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts', '/src/c.ts']),
      createModule('/src/b.ts', ['/src/c.ts']),
      createModule('/src/c.ts'),
    ];

    const graph = new DependencyGraph(modules);
    const cycles = detectCycles(graph);
    const metrics = computeCouplingMetrics(graph, cycles);

    const metricsA = metrics.find((m) => m.filePath === '/src/a.ts')!;
    const metricsB = metrics.find((m) => m.filePath === '/src/b.ts')!;
    const metricsC = metrics.find((m) => m.filePath === '/src/c.ts')!;

    expect(metricsA.Ce).toBe(2);
    expect(metricsA.Ca).toBe(0);

    expect(metricsB.Ce).toBe(1);
    expect(metricsB.Ca).toBe(1);

    expect(metricsC.Ce).toBe(0);
    expect(metricsC.Ca).toBe(2);
  });
});

describe('Cycle Detection', () => {
  it('detects no cycles in acyclic graph', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts']),
      createModule('/src/b.ts', ['/src/c.ts']),
      createModule('/src/c.ts'),
    ];

    const graph = new DependencyGraph(modules);
    const cycles = detectCycles(graph);

    expect(cycles.length).toBe(0);
  });

  it('detects simple cycle', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts']),
      createModule('/src/b.ts', ['/src/a.ts']),
    ];

    const graph = new DependencyGraph(modules);
    const cycles = detectCycles(graph);

    expect(cycles.length).toBe(1);
    expect(cycles[0].length).toBe(2);
    expect(cycles[0]).toContain('/src/a.ts');
    expect(cycles[0]).toContain('/src/b.ts');
  });

  it('detects complex cycle', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts']),
      createModule('/src/b.ts', ['/src/c.ts']),
      createModule('/src/c.ts', ['/src/a.ts']),
    ];

    const graph = new DependencyGraph(modules);
    const cycles = detectCycles(graph);

    expect(cycles.length).toBe(1);
    expect(cycles[0].length).toBe(3);
    expect(cycles[0]).toContain('/src/a.ts');
    expect(cycles[0]).toContain('/src/b.ts');
    expect(cycles[0]).toContain('/src/c.ts');
  });

  it('detects multiple independent cycles', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts']),
      createModule('/src/b.ts', ['/src/a.ts']),
      createModule('/src/c.ts', ['/src/d.ts']),
      createModule('/src/d.ts', ['/src/c.ts']),
    ];

    const graph = new DependencyGraph(modules);
    const cycles = detectCycles(graph);

    expect(cycles.length).toBe(2);
  });

  it('associates cycles with module metrics', () => {
    const modules: ParsedModule[] = [
      createModule('/src/a.ts', ['/src/b.ts']),
      createModule('/src/b.ts', ['/src/a.ts']),
      createModule('/src/c.ts'),
    ];

    const graph = new DependencyGraph(modules);
    const cycles = detectCycles(graph);
    const metrics = computeCouplingMetrics(graph, cycles);

    const metricsA = metrics.find((m) => m.filePath === '/src/a.ts')!;
    const metricsC = metrics.find((m) => m.filePath === '/src/c.ts')!;

    expect(metricsA.cycles.length).toBe(1);
    expect(metricsC.cycles.length).toBe(0);
  });
});

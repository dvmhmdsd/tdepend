import type { DependencyGraph } from '../graph/dependencyGraph';
import type { ModuleMetrics } from '../types/graph';

export function computeCouplingMetrics(
  graph: DependencyGraph,
  cycles: string[][],
): ModuleMetrics[] {
  const metrics: ModuleMetrics[] = [];

  for (const node of graph.getAllNodes()) {
    const moduleCycles = cycles.filter((cycle) => cycle.includes(node.filePath));

    metrics.push({
      filePath: node.filePath,
      Ca: node.dependents.size,
      Ce: node.dependencies.size,
      cycles: moduleCycles,
    });
  }

  return metrics;
}

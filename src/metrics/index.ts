import type { DependencyGraph } from '../graph/dependencyGraph';
import type { ParsedModule } from '../types/parser';
import type { ModuleMetrics } from '../types/graph';
import { computeAbstractness } from './abstractness';
import { computeDistance } from './distance';
import { computeInstability } from './instability';

export function computeAllMetrics(
  graph: DependencyGraph,
  modules: ParsedModule[],
  cycles: string[][],
): ModuleMetrics[] {
  const moduleMap = new Map(modules.map((m) => [m.filePath, m]));
  const metrics: ModuleMetrics[] = [];

  for (const node of graph.getAllNodes()) {
    const module = moduleMap.get(node.filePath);
    const moduleCycles = cycles.filter((cycle) => cycle.includes(node.filePath));

    const Ca = node.dependents.size;
    const Ce = node.dependencies.size;
    const abstractness = module ? computeAbstractness(module) : 0;
    const instability = computeInstability(Ca, Ce);
    const distance = computeDistance(abstractness, instability);

    metrics.push({
      filePath: node.filePath,
      Ca,
      Ce,
      cycles: moduleCycles,
      abstractness,
      instability,
      distance,
    });
  }

  return metrics;
}

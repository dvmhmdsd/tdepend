import { createHash } from 'crypto';
import type { DependencyGraph } from '../graph/dependencyGraph';
import type {
  AnalysisResult,
  SerializableAnalysisResult,
  SerializableDependencyGraph,
  SerializableDependencyNode,
  SerializableCycle,
} from '../types/api';

/**
 * Converts a DependencyGraph with Sets to a serializable format with Arrays.
 * @param graph - The dependency graph to serialize
 * @returns Serializable graph with array-based relationships
 */
export function serializeGraph(graph: DependencyGraph): SerializableDependencyGraph {
  const nodes: SerializableDependencyNode[] = graph.getAllNodes().map((node) => ({
    filePath: node.filePath,
    dependencies: Array.from(node.dependencies).sort(),
    dependents: Array.from(node.dependents).sort(),
  }));

  return { nodes };
}

/**
 * Normalizes a cycle for consistent identification across runs.
 * Creates a unique ID based on the cycle's contents and rotates the cycle
 * to start with the lexicographically smallest file path.
 *
 * @param cycle - Array of file paths forming a cycle
 * @returns Normalized cycle with unique ID
 */
export function normalizeCycle(cycle: string[]): SerializableCycle {
  if (cycle.length === 0) {
    return {
      id: '',
      nodes: [],
      length: 0,
    };
  }

  // Create stable ID by hashing sorted paths
  const sorted = [...cycle].sort();
  const id = createHash('sha256').update(sorted.join('|')).digest('hex').slice(0, 16);

  // Rotate cycle to start with lexicographically smallest element
  const minPath = sorted[0];
  const minIndex = cycle.indexOf(minPath);
  const normalized = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];

  return {
    id,
    nodes: normalized,
    length: cycle.length,
  };
}

/**
 * Converts an AnalysisResult with rich objects to a fully serializable format.
 * This includes:
 * - Converting Sets to Arrays in the dependency graph
 * - Normalizing cycles with unique IDs
 * - Adding version and timestamp metadata
 *
 * @param result - The analysis result to serialize
 * @returns Fully serializable result ready for JSON.stringify
 */
export function toSerializable(result: AnalysisResult): SerializableAnalysisResult {
  return {
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config: result.config,
    modules: result.modules,
    graph: serializeGraph(result.graph),
    cycles: result.cycles.map(normalizeCycle),
    metrics: result.metrics,
    report: result.report,
  };
}

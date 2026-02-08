import type { DependencyGraph } from '../graph/dependencyGraph';
import type { ParsedModule } from './parser';
import type { ModuleMetrics } from './graph';
import type { AnalysisReport } from '../analysis/reporter';
import type { TDependConfig } from '../config/schema';

/**
 * Main result returned by the analyze() function.
 * Contains rich objects (DependencyGraph with Sets) suitable for programmatic use.
 */
export interface AnalysisResult {
  /** Parsed modules with imports, exports, classes, etc. */
  modules: ParsedModule[];
  /** Dependency graph with Set-based relationships */
  graph: DependencyGraph;
  /** Detected dependency cycles */
  cycles: string[][];
  /** Computed metrics for each module */
  metrics: ModuleMetrics[];
  /** Generated analysis report with summary and violations */
  report: AnalysisReport;
  /** Configuration used for this analysis */
  config: TDependConfig;
}

/**
 * Serializable version of DependencyNode with Arrays instead of Sets.
 */
export interface SerializableDependencyNode {
  /** File path of this module */
  filePath: string;
  /** Modules that this module depends on (outgoing dependencies) */
  dependencies: string[];
  /** Modules that depend on this module (incoming dependencies) */
  dependents: string[];
}

/**
 * Serializable dependency graph with array-based relationships.
 */
export interface SerializableDependencyGraph {
  /** All nodes in the dependency graph */
  nodes: SerializableDependencyNode[];
}

/**
 * Normalized cycle with stable identification.
 */
export interface SerializableCycle {
  /** Unique identifier (hash of sorted file paths) */
  id: string;
  /** File paths forming the cycle (normalized to start with lexicographically smallest) */
  nodes: string[];
  /** Number of nodes in the cycle */
  length: number;
}

/**
 * Complete serializable analysis result suitable for JSON export.
 * All Sets are converted to Arrays for proper JSON serialization.
 */
export interface SerializableAnalysisResult {
  /** Format version for compatibility checking */
  version: string;
  /** ISO 8601 timestamp of when this analysis was generated */
  timestamp: string;
  /** Configuration used for this analysis */
  config: TDependConfig;
  /** Parsed modules with imports, exports, classes, etc. */
  modules: ParsedModule[];
  /** Serializable dependency graph */
  graph: SerializableDependencyGraph;
  /** Normalized cycles with unique IDs */
  cycles: SerializableCycle[];
  /** Computed metrics for each module */
  metrics: ModuleMetrics[];
  /** Generated analysis report with summary and violations */
  report: AnalysisReport;
}

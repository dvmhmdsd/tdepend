export interface DependencyNode {
  filePath: string;
  dependencies: Set<string>;
  dependents: Set<string>;
}

export interface ModuleMetrics {
  filePath: string;
  Ca: number;
  Ce: number;
  cycles: string[][];
}

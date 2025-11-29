import type { ParsedModule } from '../types/parser';
import type { DependencyNode } from '../types/graph';

export class DependencyGraph {
  private readonly nodes: Map<string, DependencyNode> = new Map();

  constructor(modules: ParsedModule[]) {
    for (const module of modules) {
      this.addNode(module.filePath);
    }

    for (const module of modules) {
      for (const importPath of module.imports) {
        this.addEdge(module.filePath, importPath);
      }
    }
  }

  private addNode(filePath: string): void {
    if (!this.nodes.has(filePath)) {
      this.nodes.set(filePath, {
        filePath,
        dependencies: new Set(),
        dependents: new Set(),
      });
    }
  }

  private addEdge(from: string, to: string): void {
    this.addNode(from);
    this.addNode(to);

    const fromNode = this.nodes.get(from)!;
    const toNode = this.nodes.get(to)!;

    fromNode.dependencies.add(to);
    toNode.dependents.add(from);
  }

  getNode(filePath: string): DependencyNode | undefined {
    return this.nodes.get(filePath);
  }

  getAllNodes(): DependencyNode[] {
    return Array.from(this.nodes.values());
  }
}

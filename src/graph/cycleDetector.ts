import type { DependencyGraph } from './dependencyGraph';

interface TarjanState {
  index: number;
  stack: string[];
  indices: Map<string, number>;
  lowLinks: Map<string, number>;
  onStack: Set<string>;
  components: string[][];
}

function strongConnect(node: string, graph: DependencyGraph, state: TarjanState): void {
  state.indices.set(node, state.index);
  state.lowLinks.set(node, state.index);
  state.index++;
  state.stack.push(node);
  state.onStack.add(node);

  const graphNode = graph.getNode(node);
  if (graphNode) {
    for (const dependency of graphNode.dependencies) {
      if (!state.indices.has(dependency)) {
        strongConnect(dependency, graph, state);
        const currentLow = state.lowLinks.get(node)!;
        const depLow = state.lowLinks.get(dependency)!;
        state.lowLinks.set(node, Math.min(currentLow, depLow));
      } else if (state.onStack.has(dependency)) {
        const currentLow = state.lowLinks.get(node)!;
        const depIndex = state.indices.get(dependency)!;
        state.lowLinks.set(node, Math.min(currentLow, depIndex));
      }
    }
  }

  if (state.lowLinks.get(node) === state.indices.get(node)) {
    const component: string[] = [];
    let w: string;
    do {
      w = state.stack.pop()!;
      state.onStack.delete(w);
      component.push(w);
    } while (w !== node);

    if (component.length > 1) {
      state.components.push(component);
    }
  }
}

export function detectCycles(graph: DependencyGraph): string[][] {
  const state: TarjanState = {
    index: 0,
    stack: [],
    indices: new Map(),
    lowLinks: new Map(),
    onStack: new Set(),
    components: [],
  };

  const allNodes = graph.getAllNodes();
  for (const node of allNodes) {
    if (!state.indices.has(node.filePath)) {
      strongConnect(node.filePath, graph, state);
    }
  }

  return state.components;
}

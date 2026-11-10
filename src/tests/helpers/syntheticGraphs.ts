// Generated graphs for the cycle finder's scale tests. Every generator is seeded,
// so each run builds the same graph and the timings compare like with like.
// Ids are zero-padded, so their sorted order is their numeric order.

export interface SyntheticGraph {
  nodes: string[];
  edges: Array<[string, string]>;
}

export function nodeId(prefix: string, index: number): string {
  return `${prefix}${String(index).padStart(5, '0')}`;
}

// mulberry32: a small seeded generator, good enough to scatter chords.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ring(prefix: string, size: number): SyntheticGraph {
  const nodes = Array.from({ length: size }, (_, index) => nodeId(prefix, index));
  const edges = nodes.map((node, index): [string, string] => [node, nodes[(index + 1) % size]]);
  return { nodes, edges };
}

// One group: a chain whose last node imports the first.
export function chainWithBackEdge(size = 20_000): SyntheticGraph {
  return ring('c', size);
}

// One long group just above the witness cap: a ring with a chord on every tenth
// node, so the group is sparse and has many cycles of different lengths.
export function longSparseScc(size = 3_000, seed = 1): SyntheticGraph {
  const random = seeded(seed);
  const graph = ring('s', size);
  for (let index = 0; index < size; index += 10) {
    const target = Math.floor(random() * size);
    if (target !== index) graph.edges.push([graph.nodes[index], graph.nodes[target]]);
  }
  return graph;
}

// One dense group below the cap: a ring plus `degree` random imports per file.
export function denseScc(size = 300, degree = 30, seed = 2): SyntheticGraph {
  const random = seeded(seed);
  const graph = ring('d', size);
  const seen = new Set(graph.edges.map(([from, to]) => `${from}>${to}`));
  graph.nodes.forEach((from, index) => {
    for (let added = 0; added < degree; added++) {
      const target = Math.floor(random() * size);
      const to = graph.nodes[target];
      if (target === index || seen.has(`${from}>${to}`)) continue;
      seen.add(`${from}>${to}`);
      graph.edges.push([from, to]);
    }
  });
  return graph;
}

// `count` separate groups of 2 to 4 files. Each group is a ring, a group of 4
// also has a chord that makes a shorter cycle, and every group imports the next
// one, which links them without merging them.
export function manySmallSccs(count = 500): SyntheticGraph {
  const nodes: string[] = [];
  const edges: Array<[string, string]> = [];
  let previous: string | undefined;
  for (let group = 0; group < count; group++) {
    const size = 2 + (group % 3);
    const members = ring(`${nodeId('g', group)}-`, size);
    nodes.push(...members.nodes);
    edges.push(...members.edges);
    if (size === 4) edges.push([members.nodes[2], members.nodes[0]]);
    if (previous !== undefined) edges.push([previous, members.nodes[0]]);
    previous = members.nodes[size - 1];
  }
  return { nodes, edges };
}

// A random graph over the given ids, for comparing against brute force.
export function randomGraph(ids: string[], density: number, seed: number): SyntheticGraph {
  const random = seeded(seed);
  const edges: Array<[string, string]> = [];
  for (const from of ids) {
    for (const to of ids) {
      if (from !== to && random() < density) edges.push([from, to]);
    }
  }
  return { nodes: [...ids], edges };
}

// A seeded Fisher–Yates shuffle that leaves the input untouched.
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const random = seeded(seed);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

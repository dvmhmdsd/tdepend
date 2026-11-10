import type * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { assignComponents } from '../components/assignComponents';
import { buildGroupGraph } from '../components/groupGraph';
import {
  CycleCache,
  OPTIMAL_WITNESS_LIMIT,
  fileCycleGraph,
  findCycles,
  groupCycleGraph,
  type Cycle,
  type CycleEdge,
  type CycleFilter,
  type CycleGraph,
  type CycleInput,
} from '../cycles/findCycles';
import type { SiteRecord } from '../graph/buildFileGraph';
import type { EdgeKind } from '../parser/types';
import { buildFixtureParts } from './helpers/fixtureGraph';
import {
  chainWithBackEdge,
  denseScc,
  longSparseScc,
  manySmallSccs,
  randomGraph,
  shuffled,
  type SyntheticGraph,
} from './helpers/syntheticGraphs';

// The `no-cycles` defaults: type-only sites dropped, lazy imports kept.
const RUNTIME: CycleFilter = { ignoreTypeOnly: true, ignoreLazyImports: false };
const EVERY_SITE: CycleFilter = { ignoreTypeOnly: false, ignoreLazyImports: false };
const NO_LAZY: CycleFilter = { ignoreTypeOnly: true, ignoreLazyImports: true };

interface SiteSpec {
  file?: string;
  line?: number;
  column?: number;
  kind?: EdgeKind;
  loads?: boolean;
  deferred?: boolean;
}

// [from, to, ...sites]; an edge without site specs gets one loading static site.
type EdgeSpec = [string, string, ...SiteSpec[]];

function record(from: string, to: string, spec: SiteSpec): SiteRecord {
  return {
    file: spec.file ?? from,
    site: {
      specifier: `./${to}`,
      line: spec.line ?? 1,
      column: spec.column ?? 1,
      kind: spec.kind ?? 'static',
      form: 'declaration',
      bindings: [],
      loadsTarget: spec.loads ?? true,
      deferred: spec.deferred,
      node: undefined as unknown as ts.Node,
    },
    resolution: { class: 'internal', target: { file: to } },
  };
}

function graphOf(edges: EdgeSpec[], nodes?: string[]): CycleGraph {
  const byFrom = new Map<string, CycleEdge[]>();
  for (const [from, to, ...specs] of edges) {
    const sites = (specs.length === 0 ? [{}] : specs).map((spec) => record(from, to, spec));
    const list = byFrom.get(from) ?? [];
    list.push({ to, sites });
    byFrom.set(from, list);
  }
  return {
    nodes: nodes ?? [...new Set(edges.flatMap(([from, to]) => [from, to]))],
    edgesFrom: (id) => byFrom.get(id) ?? [],
  };
}

function syntheticInput(graph: SyntheticGraph): CycleGraph {
  return graphOf(graph.edges, graph.nodes);
}

function input(graph: CycleGraph, overrides: Partial<CycleInput> = {}): CycleInput {
  return { level: 'file', graphId: 'graph-1', scopeId: 'proj:(repo)', ...graph, ...overrides };
}

// The witness as the node sequence it walks, starting at its first hop.
const walk = (cycle: Cycle): string[] => cycle.hops.map((hop) => hop.fromGroup);

// Every hop follows a real edge of the graph through one of that edge's own
// sites, the hops chain into a closed walk, and no member repeats.
function expectValidWitness(cycle: Cycle, graph: CycleGraph): void {
  const members = new Set(cycle.members);
  const nodes = walk(cycle);
  expect(new Set(nodes).size).toBe(nodes.length);
  cycle.hops.forEach((hop, index) => {
    const next = cycle.hops[(index + 1) % cycle.hops.length];
    expect(hop.toGroup).toBe(next.fromGroup);
    expect(members.has(hop.fromGroup)).toBe(true);
    const edge = graph.edgesFrom(hop.fromGroup).find((candidate) => candidate.to === hop.toGroup);
    expect(edge?.sites.some((site) => site.site === hop.site)).toBe(true);
  });
}

// An independent shortest cycle length: plain BFS from every node, no pruning.
function shortestCycleLength(graph: SyntheticGraph): number {
  const successors = new Map<string, string[]>();
  for (const [from, to] of graph.edges) successors.set(from, [...(successors.get(from) ?? []), to]);
  let best = Infinity;
  for (const start of graph.nodes) {
    const distance = new Map<string, number>([[start, 0]]);
    const queue = [start];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head];
      for (const next of successors.get(node) ?? []) {
        if (next === start) best = Math.min(best, distance.get(node)! + 1);
        if (distance.has(next)) continue;
        distance.set(next, distance.get(node)! + 1);
        queue.push(next);
      }
    }
  }
  return best;
}

// Brute force over every simple cycle in the group: the shortest, ties to the
// lexicographically smallest sequence rotated to start at its smallest member.
function bruteForceWitness(graph: SyntheticGraph, members: string[]): string[] {
  const inGroup = new Set(members);
  const successors = new Map<string, string[]>();
  for (const [from, to] of graph.edges) {
    if (inGroup.has(from) && inGroup.has(to)) {
      successors.set(from, [...(successors.get(from) ?? []), to]);
    }
  }
  let best: string[] | undefined;
  const better = (candidate: string[]): boolean => {
    if (best === undefined || candidate.length !== best.length) {
      return best === undefined || candidate.length < best.length;
    }
    for (let index = 0; index < candidate.length; index++) {
      if (candidate[index] !== best[index]) return candidate[index] < best[index];
    }
    return false;
  };
  const extend = (path: string[]): void => {
    const start = path[0];
    for (const next of successors.get(path[path.length - 1]) ?? []) {
      if (next === start && path.length > 1 && better(path)) best = [...path];
      if (next > start && !path.includes(next)) extend([...path, next]);
    }
  };
  for (const start of [...members].sort()) extend([start]);
  return best!;
}

const timings: string[] = [];

function timed<T>(label: string, run: () => T): T {
  const started = performance.now();
  const result = run();
  const elapsed = performance.now() - started;
  timings.push(`${label}: ${elapsed.toFixed(1)} ms`);
  expect(elapsed).toBeLessThan(5_000);
  return result;
}

describe('findCycles: groups and witnesses', () => {
  it('a two-file cycle reports members [a, b] and both hops with their sites', () => {
    const graph = graphOf([
      ['a.ts', 'b.ts', { line: 3, column: 20 }],
      ['b.ts', 'a.ts', { line: 1, column: 15 }],
    ]);
    const [cycle, ...rest] = findCycles(input(graph), RUNTIME);

    expect(rest).toEqual([]);
    expect(cycle.level).toBe('file');
    expect(cycle.members).toEqual(['a.ts', 'b.ts']);
    expect(cycle.optimal).toBe(true);
    expect(
      cycle.hops.map((hop) => [hop.fromGroup, hop.toGroup, hop.fromFile, hop.to, hop.site.line]),
    ).toEqual([
      ['a.ts', 'b.ts', 'a.ts', { file: 'b.ts' }, 3],
      ['b.ts', 'a.ts', 'b.ts', { file: 'a.ts' }, 1],
    ]);
    expectValidWitness(cycle, graph);
  });

  it('a group of 4 with a 2-cycle that avoids the smallest member reports all 4 members and the 2 hops', () => {
    const graph = graphOf([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'a'],
      ['d', 'c'],
    ]);
    const [cycle] = findCycles(input(graph), RUNTIME);

    expect(cycle.members).toEqual(['a', 'b', 'c', 'd']);
    expect(walk(cycle)).toEqual(['c', 'd']);
    expect(cycle.optimal).toBe(true);
  });

  it('equal-length cycles go to the lexicographically smallest sequence, rotated to its smallest member', () => {
    // Two triangles, b→c→d and a→f→e, joined into one group by d→a and e→b.
    const graph = graphOf([
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'b'],
      ['a', 'f'],
      ['f', 'e'],
      ['e', 'a'],
      ['d', 'a'],
      ['e', 'b'],
    ]);
    const [cycle] = findCycles(input(graph), RUNTIME);

    expect(cycle.members).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(walk(cycle)).toEqual(['a', 'f', 'e']);
  });

  it('picks the smallest next member among equally short paths', () => {
    const graph = graphOf([
      ['a', 'c'],
      ['a', 'b'],
      ['b', 'd'],
      ['c', 'd'],
      ['d', 'a'],
    ]);
    expect(walk(findCycles(input(graph), RUNTIME)[0])).toEqual(['a', 'b', 'd']);
  });

  it('matches a brute-force search on 300 random small graphs', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    let compared = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const graph = randomGraph(ids, 0.3, seed);
      for (const cycle of findCycles(input(syntheticInput(graph)), RUNTIME)) {
        expect(walk(cycle), `seed ${seed}`).toEqual(bruteForceWitness(graph, cycle.members));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(250);
  });

  it('reports one cycle per group of two or more, sorted by smallest member, and ignores self-imports and single files', () => {
    const graph = graphOf([
      ['x', 'y'],
      ['y', 'x'],
      ['a', 'a'],
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'b'],
      ['c', 'x'],
    ]);
    const cycles = findCycles(input(graph), RUNTIME);

    expect(cycles.map((cycle) => cycle.members)).toEqual([
      ['b', 'c'],
      ['x', 'y'],
    ]);
  });

  it('ignores edges to nodes outside the input, so a scoped run never widens', () => {
    const graph = graphOf(
      [
        ['a', 'b'],
        ['b', 'outside'],
        ['outside', 'a'],
      ],
      ['a', 'b'],
    );
    expect(findCycles(input(graph), RUNTIME)).toEqual([]);
  });
});

describe('findCycles: site filters', () => {
  it('drops a site with loadsTarget false under ignoreTypeOnly; the edge survives if another site loads, and the witness site is an eligible one', () => {
    const graph = graphOf([
      ['a.ts', 'b.ts', { line: 1, kind: 'type', loads: false }, { line: 2 }],
      ['b.ts', 'a.ts', { line: 1 }],
    ]);
    const [cycle] = findCycles(input(graph), RUNTIME);

    expect(cycle.members).toEqual(['a.ts', 'b.ts']);
    expect(cycle.hops[0].site.line).toBe(2);
    expect(cycle.hops[0].site.loadsTarget).toBe(true);

    const typeOnlyBack = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'a.ts', { kind: 'type', loads: false }],
    ]);
    expect(findCycles(input(typeOnlyBack), RUNTIME)).toEqual([]);
    expect(findCycles(input(typeOnlyBack), EVERY_SITE)).toHaveLength(1);
  });

  it('drops deferred dynamic sites only with ignoreLazyImports', () => {
    const graph = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'a.ts', { kind: 'dynamic', deferred: true }],
    ]);
    expect(findCycles(input(graph), RUNTIME)).toHaveLength(1);
    expect(findCycles(input(graph), NO_LAZY)).toEqual([]);

    const eager = graphOf([
      ['a.ts', 'b.ts'],
      ['b.ts', 'a.ts', { kind: 'dynamic', deferred: false }],
    ]);
    expect(findCycles(input(eager), NO_LAZY)).toHaveLength(1);
  });

  it('the witness site is the earliest eligible site by file, line and column', () => {
    // A component edge: sites from two files, the earliest one filtered out.
    const graph = graphOf([
      [
        'comp:a',
        'comp:b',
        { file: 'src/a/z.ts', line: 1 },
        { file: 'src/a/m.ts', line: 9, column: 3 },
        { file: 'src/a/m.ts', line: 9, column: 1, loads: false },
        { file: 'src/a/m.ts', line: 12 },
      ],
      ['comp:b', 'comp:a', { file: 'src/b/index.ts' }],
    ]);
    const [cycle] = findCycles(input(graph, { level: 'component' }), RUNTIME);

    expect(cycle.hops[0].fromFile).toBe('src/a/m.ts');
    expect([cycle.hops[0].site.line, cycle.hops[0].site.column]).toEqual([9, 3]);
  });
});

describe('findCycles: scale and the witness cap', () => {
  it('a 20,000-node chain with one back edge does not overflow the stack', () => {
    const graph = syntheticInput(chainWithBackEdge());
    const [cycle] = timed('chain 20,000', () => findCycles(input(graph), RUNTIME));

    expect(cycle.members).toHaveLength(20_000);
    expect(cycle.hops).toHaveLength(20_000);
    expect(cycle.optimal).toBe(false);
    expect(cycle.hops[0].fromGroup).toBe('c00000');
  });

  it(`switches to the DFS witness above ${OPTIMAL_WITNESS_LIMIT} members`, () => {
    const atCap = findCycles(
      input(syntheticInput(chainWithBackEdge(OPTIMAL_WITNESS_LIMIT))),
      RUNTIME,
    );
    const aboveCap = findCycles(
      input(syntheticInput(chainWithBackEdge(OPTIMAL_WITNESS_LIMIT + 1))),
      RUNTIME,
    );
    expect(atCap[0].optimal).toBe(true);
    expect(aboveCap[0].optimal).toBe(false);
  });

  it('a 3,000-node sparse group uses the DFS witness with optimal false', () => {
    const synthetic = longSparseScc();
    const graph = syntheticInput(synthetic);
    const cycles = timed('sparse 3,000', () => findCycles(input(graph), RUNTIME));

    expect(cycles).toHaveLength(1);
    expect(cycles[0].members).toHaveLength(3_000);
    expect(cycles[0].optimal).toBe(false);
    expectValidWitness(cycles[0], graph);
  });

  it('a 300-node dense group gets the shortest witness with optimal true', () => {
    const synthetic = denseScc();
    const graph = syntheticInput(synthetic);
    const cycles = timed('dense 300', () => findCycles(input(graph), RUNTIME));

    expect(cycles).toHaveLength(1);
    expect(cycles[0].members).toHaveLength(300);
    expect(cycles[0].optimal).toBe(true);
    expect(cycles[0].hops).toHaveLength(shortestCycleLength(synthetic));
    expectValidWitness(cycles[0], graph);
  });

  it('500 groups of 2 to 4 files each get their own shortest witness', () => {
    const graph = syntheticInput(manySmallSccs());
    const cycles = timed('500 small groups', () => findCycles(input(graph), RUNTIME));

    expect(cycles).toHaveLength(500);
    expect(cycles.map((cycle) => cycle.members.length)).toEqual(
      Array.from({ length: 500 }, (_, group) => 2 + (group % 3)),
    );
    expect(cycles.map((cycle) => cycle.hops.length)).toEqual(
      Array.from({ length: 500 }, (_, group) => [2, 3, 3][group % 3]),
    );
    cycles.forEach((cycle) => expectValidWitness(cycle, graph));
    console.info(`cycles-synthetic timings\n  ${timings.join('\n  ')}`);
  });

  it('output is deterministic over shuffled input', () => {
    const synthetic = randomGraph(
      Array.from({ length: 120 }, (_, index) => `f${String(index).padStart(3, '0')}.ts`),
      0.015,
      7,
    );
    const edges: EdgeSpec[] = synthetic.edges.map(([from, to], index) => [
      from,
      to,
      { line: 1 + (index % 5) },
      { line: 1 + (index % 3), column: 4, loads: index % 2 === 0 },
    ]);
    const summary = (cycles: Cycle[]) =>
      cycles.map((cycle) => [
        cycle.members,
        cycle.hops.map((hop) => [hop.fromGroup, hop.toGroup, hop.site.line, hop.site.column]),
      ]);

    const baseline = summary(findCycles(input(graphOf(edges, synthetic.nodes)), RUNTIME));
    expect(baseline.length).toBeGreaterThan(0);
    for (let seed = 1; seed <= 5; seed++) {
      const reordered = shuffled(edges, seed).map(([from, to, ...sites]): EdgeSpec => [
        from,
        to,
        ...shuffled(sites, seed),
      ]);
      const graph = graphOf(reordered, shuffled(synthetic.nodes, seed));
      expect(summary(findCycles(input(graph), RUNTIME))).toEqual(baseline);
    }
  });
});

describe('CycleCache', () => {
  const graph = graphOf([
    ['a', 'b'],
    ['b', 'a'],
  ]);

  function counted(): { graph: CycleGraph; calls: () => number } {
    let calls = 0;
    return {
      graph: {
        nodes: graph.nodes,
        edgesFrom: (id) => {
          calls += 1;
          return graph.edgesFrom(id);
        },
      },
      calls: () => calls,
    };
  }

  it('hits for the same graphId, scopeId, level and filter', () => {
    const cache = new CycleCache();
    const probe = counted();
    const first = findCycles(input(probe.graph), RUNTIME, cache);
    const callsAfterFirst = probe.calls();
    const second = findCycles(input(probe.graph), RUNTIME, cache);

    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(probe.calls()).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  it('misses when the graphId, scopeId, level or any filter setting differs', () => {
    const variants: Array<[Partial<CycleInput>, CycleFilter]> = [
      [{ graphId: 'graph-2' }, RUNTIME],
      [{ scopeId: 'proj:apps/api' }, RUNTIME],
      [{ level: 'component' }, RUNTIME],
      [{}, EVERY_SITE],
      [{}, NO_LAZY],
    ];
    for (const [overrides, filter] of variants) {
      const cache = new CycleCache();
      const probe = counted();
      findCycles(input(probe.graph), RUNTIME, cache);
      const callsAfterFirst = probe.calls();
      findCycles(input(probe.graph, overrides), filter, cache);
      expect(probe.calls(), JSON.stringify([overrides, filter])).toBeGreaterThan(callsAfterFirst);
    }
  });
});

describe('findCycles on the cycles fixture', () => {
  // Five two-file loops, each closed by a different kind of import.
  const parts = buildFixtureParts('cycles');
  const pairsWith = (filter: CycleFilter): string[] =>
    findCycles(
      {
        level: 'file',
        graphId: parts.graph.id,
        scopeId: 'proj:(repo)',
        ...fileCycleGraph(parts.graph, parts.sites),
      },
      filter,
    ).map((cycle) => cycle.members.map((member) => member.replace(/^src\/|\.ts$/g, '')).join(' '));

  it('runtime cycles leave out loops closed by import type or by an import used only as a type', () => {
    expect(pairsWith(RUNTIME)).toEqual(['eager-a eager-b', 'lazy-a lazy-b', 'runtime-a runtime-b']);
  });

  it('keeping every site brings both type-only loops back', () => {
    expect(pairsWith(EVERY_SITE)).toEqual([
      'eager-a eager-b',
      'lazy-a lazy-b',
      'runtime-a runtime-b',
      'type-a type-b',
      'usage-a usage-b',
    ]);
  });

  it('ignoreLazyImports drops the import() inside a function and keeps the top-level one', () => {
    expect(pairsWith(NO_LAZY)).toEqual(['eager-a eager-b', 'runtime-a runtime-b']);
  });
});

describe('findCycles on the heritage fixture', () => {
  const parts = buildFixtureParts('heritage');
  const fileInput = (filter: CycleFilter) =>
    findCycles(
      {
        level: 'file',
        graphId: parts.graph.id,
        scopeId: 'proj:(repo)',
        ...fileCycleGraph(parts.graph, parts.sites),
      },
      filter,
    );

  it('finds the export * barrel cycle and leaves the type-only edges out of runtime cycles', () => {
    const cycles = fileInput(RUNTIME);

    expect(cycles.map((cycle) => cycle.members)).toEqual([['src/cycle-a.ts', 'src/cycle-b.ts']]);
    expect(
      cycles[0].hops.map((hop) => [
        hop.fromFile,
        hop.to,
        hop.site.kind,
        hop.site.line,
        hop.site.column,
      ]),
    ).toEqual([
      ['src/cycle-a.ts', { file: 'src/cycle-b.ts' }, 're-export', 1, 15],
      ['src/cycle-b.ts', { file: 'src/cycle-a.ts' }, 're-export', 1, 15],
    ]);
  });

  it('finds the same cycle between components through the group graph', () => {
    const assignment = assignComponents(parts.ctx, parts.graph.files(), () => ({ type: 'file' }));
    const component = buildGroupGraph(parts.graph, assignment, 'component', parts.sites);
    const cycles = findCycles(
      {
        level: 'component',
        graphId: parts.graph.id,
        scopeId: 'proj:(repo)',
        ...groupCycleGraph(component),
      },
      RUNTIME,
    );

    expect(cycles.map((cycle) => cycle.members)).toEqual([
      ['file:src/cycle-a.ts', 'file:src/cycle-b.ts'],
    ]);
    expect(cycles[0].hops.map((hop) => [hop.fromGroup, hop.fromFile, hop.to])).toEqual([
      ['file:src/cycle-a.ts', 'src/cycle-a.ts', { file: 'src/cycle-b.ts' }],
      ['file:src/cycle-b.ts', 'src/cycle-b.ts', { file: 'src/cycle-a.ts' }],
    ]);
  });
});

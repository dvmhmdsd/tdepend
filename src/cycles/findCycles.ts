import { isBucket } from '../components/assignComponents';
import type { Group } from '../components/types';
import { compareSiteRecords, siteRecordLookup, type SiteRecord } from '../graph/buildFileGraph';
import type { FileGraph } from '../graph/fileGraph';
import type { ImportSite } from '../parser/types';
import type { Target } from '../resolver/types';

export type CycleLevel = 'file' | 'component' | 'package';

export interface CycleFilter {
  ignoreTypeOnly: boolean;
  ignoreLazyImports: boolean;
}

// One concrete import that carries the cycle from one member to the next. At
// the component and package levels it is a single file import between two
// groups, so consecutive hops need not form a contiguous file path.
export interface CycleHop {
  fromGroup: string;
  toGroup: string;
  fromFile: string;
  to: Target;
  site: ImportSite;
}

export interface Cycle {
  level: CycleLevel;
  members: string[];
  hops: CycleHop[];
  optimal: boolean;
}

export interface CycleEdge {
  to: string;
  sites: SiteRecord[];
}

export interface CycleGraph {
  nodes: string[];
  edgesFrom(id: string): CycleEdge[];
  // A loose node can be part of a cycle but cannot make one alone: a group made
  // only of loose nodes is not reported, and every witness passes through at
  // least one node that isn't loose.
  isLoose?(id: string): boolean;
}

export interface GroupCycleGraph extends CycleGraph {
  nameOf(id: string): string;
}

export interface CycleInput extends CycleGraph {
  level: CycleLevel;
  graphId: string;
  scopeId: string;
}

type CycleKey = Pick<CycleInput, 'graphId' | 'scopeId' | 'level'>;

// A group up to this size gets the exact shortest witness. A larger group gets
// the first cycle a depth-first walk closes, and the cycle says `optimal: false`.
export const OPTIMAL_WITNESS_LIMIT = 2000;

// Results for one analysis, keyed by graph, scope, level and filter. Keep one
// cache per analysis: a FileGraph id leaves site positions out, so two analyses
// with the same graph shape would otherwise share witnesses whose lines and
// columns belong to the other one.
export class CycleCache {
  private readonly results = new Map<string, Cycle[]>();

  get(key: CycleKey, filter: CycleFilter): Cycle[] | undefined {
    return this.results.get(cacheKey(key, filter));
  }

  set(key: CycleKey, filter: CycleFilter, cycles: Cycle[]): void {
    this.results.set(cacheKey(key, filter), cycles);
  }
}

function cacheKey(key: CycleKey, filter: CycleFilter): string {
  return JSON.stringify([
    key.graphId,
    key.scopeId,
    key.level,
    filter.ignoreTypeOnly,
    filter.ignoreLazyImports,
  ]);
}

// One cycle per strongly connected group of two or more members, sorted by
// smallest member. Edges to ids outside `nodes` are ignored, so a scoped run
// never widens to the rest of the repository.
export function findCycles(input: CycleInput, filter: CycleFilter, cache?: CycleCache): Cycle[] {
  const cached = cache?.get(input, filter);
  if (cached !== undefined) return [...cached];

  const graph = eligibleGraph(input, filter);
  const cycles = stronglyConnectedGroups(graph.successors)
    .filter((group) => group.length > 1 && group[0] < graph.anchors)
    .sort((left, right) => left[0] - right[0])
    .map((group) => cycleOf(graph, group, input.level));

  cache?.set(input, filter, cycles);
  return [...cycles];
}

// The file graph as cycle input. Its edges hold bare sites, so each one is
// mapped back to its record for the importing file and the resolved target.
// `keep` limits the nodes to a scope; edges leaving it are then ignored.
export function fileCycleGraph(
  graph: FileGraph,
  sites: SiteRecord[],
  keep: (file: string) => boolean = () => true,
): CycleGraph {
  const recordsOf = siteRecordLookup(sites);
  return {
    nodes: graph.files().filter(keep),
    edgesFrom: (file) =>
      graph.edgesFrom(file).map((edge) => ({ to: edge.to, sites: recordsOf(edge.sites) })),
  };
}

// The component or package graph as cycle input, built from the file graph.
// A bucket is not one node: it holds files with nothing in common, such as an
// entry point that imports every component and a config file they all import,
// and as one node it would join all of them into a single cycle. Each of its
// files is a loose node of its own instead, so a cycle through a leftover file
// is still found. A node is kept when `keep` accepts one of its files.
export function groupCycleGraph(
  graph: FileGraph,
  sites: SiteRecord[],
  groupOf: (file: string) => Group | undefined,
  keep: (file: string) => boolean = () => true,
): GroupCycleGraph {
  const recordsOf = siteRecordLookup(sites);
  const nodeOf = new Map<string, string>();
  const names = new Map<string, string>();
  const loose = new Set<string>();
  const nodes = new Set<string>();

  for (const file of graph.files()) {
    const group = groupOf(file);
    if (group === undefined) continue;
    const bucket = isBucket(group);
    const node = bucket ? `file:${file}` : group.id;
    nodeOf.set(file, node);
    names.set(node, bucket ? file : group.name);
    if (bucket) loose.add(node);
    if (keep(file)) nodes.add(node);
  }

  const edges = new Map<string, Map<string, SiteRecord[]>>();
  for (const edge of graph.edges()) {
    const from = nodeOf.get(edge.from);
    const to = nodeOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const targets = edges.get(from) ?? new Map<string, SiteRecord[]>();
    edges.set(from, targets);
    const records = targets.get(to) ?? [];
    targets.set(to, records);
    records.push(...recordsOf(edge.sites));
  }

  return {
    nodes: [...nodes],
    edgesFrom: (id) => [...(edges.get(id) ?? [])].map(([to, records]) => ({ to, sites: records })),
    isLoose: (id) => loose.has(id),
    nameOf: (id) => names.get(id) ?? id,
  };
}

// The graph the search runs on. Nodes are indices, ordered with every node
// that isn't loose first and by id within each part, so comparing indices
// compares that order. `anchors` counts the nodes that aren't loose. Each kept
// edge remembers the site its hop will show: the earliest eligible one by file,
// line and column.
interface EligibleGraph {
  ids: string[];
  anchors: number;
  successors: number[][];
  predecessors: number[][];
  witnessSites: Array<Map<number, SiteRecord>>;
}

function eligibleGraph(input: CycleInput, filter: CycleFilter): EligibleGraph {
  const isLoose = (id: string): boolean => input.isLoose?.(id) ?? false;
  const unique = [...new Set(input.nodes)].sort();
  const ids = [...unique.filter((id) => !isLoose(id)), ...unique.filter(isLoose)];
  const anchors = ids.findIndex(isLoose);
  const indexOf = new Map(ids.map((id, index) => [id, index]));
  const witnessSites = ids.map(() => new Map<number, SiteRecord>());

  ids.forEach((id, from) => {
    for (const edge of input.edgesFrom(id)) {
      const to = indexOf.get(edge.to);
      if (to === undefined || to === from) continue;
      for (const record of edge.sites) {
        if (!isEligible(record, filter)) continue;
        const current = witnessSites[from].get(to);
        if (current === undefined || compareSiteRecords(record, current) < 0) {
          witnessSites[from].set(to, record);
        }
      }
    }
  });

  const successors = witnessSites.map((sites) => [...sites.keys()].sort((a, b) => a - b));
  const predecessors = ids.map((): number[] => []);
  successors.forEach((targets, from) => {
    for (const to of targets) predecessors[to].push(from);
  });
  return {
    ids,
    anchors: anchors === -1 ? ids.length : anchors,
    successors,
    predecessors,
    witnessSites,
  };
}

// Filters run per site; an edge stays while any of its sites is eligible. A
// site without a target has nothing for its hop to point at.
function isEligible(record: SiteRecord, filter: CycleFilter): boolean {
  if (record.resolution.target === null) return false;
  if (filter.ignoreTypeOnly && record.site.loadsTarget === false) return false;
  return !(filter.ignoreLazyImports && record.site.deferred === true);
}

interface Frame {
  node: number;
  next: number;
}

// Tarjan's algorithm with an explicit stack, so a long import chain cannot
// overflow the call stack. Each group comes back with its members ascending.
function stronglyConnectedGroups(successors: number[][]): number[][] {
  const order = new Int32Array(successors.length).fill(-1);
  const low = new Int32Array(successors.length);
  const onStack = new Uint8Array(successors.length);
  const stack: number[] = [];
  const frames: Frame[] = [];
  const groups: number[][] = [];
  let visited = 0;

  const enter = (node: number): void => {
    order[node] = visited;
    low[node] = visited;
    visited += 1;
    stack.push(node);
    onStack[node] = 1;
    frames.push({ node, next: 0 });
  };

  for (let root = 0; root < successors.length; root++) {
    if (order[root] !== -1) continue;
    enter(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const targets = successors[frame.node];
      if (frame.next < targets.length) {
        const target = targets[frame.next++];
        if (order[target] === -1) enter(target);
        else if (onStack[target] === 1) low[frame.node] = Math.min(low[frame.node], order[target]);
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) low[parent.node] = Math.min(low[parent.node], low[frame.node]);
      if (low[frame.node] === order[frame.node]) groups.push(popGroup(stack, onStack, frame.node));
    }
  }
  return groups;
}

function popGroup(stack: number[], onStack: Uint8Array, root: number): number[] {
  const group: number[] = [];
  let member: number;
  do {
    member = stack.pop()!;
    onStack[member] = 0;
    group.push(member);
  } while (member !== root);
  return group.sort((a, b) => a - b);
}

function cycleOf(graph: EligibleGraph, group: number[], level: CycleLevel): Cycle {
  const optimal = group.length <= OPTIMAL_WITNESS_LIMIT;
  const inGroup = new Set(group);
  const walk = optimal ? shortestWalk(graph, group, inGroup) : firstWalk(graph, group[0], inGroup);
  return {
    level,
    members: group.map((node) => graph.ids[node]),
    hops: walk.map((from, index) => hopOf(graph, from, walk[(index + 1) % walk.length])),
    optimal,
  };
}

function hopOf(graph: EligibleGraph, from: number, to: number): CycleHop {
  const record = graph.witnessSites[from].get(to)!;
  return {
    fromGroup: graph.ids[from],
    toGroup: graph.ids[to],
    fromFile: record.file,
    to: record.resolution.target!,
    site: record.site,
  };
}

// The shortest cycle in the group, as a walk starting at its smallest member.
// Every cycle has exactly one smallest member, so a backwards BFS from each
// member, over only the members above it, finds the shortest cycle that starts
// there. Members are tried in order and a later one must be strictly shorter
// to win, which settles equal lengths by the smaller starting member. Loose
// members come last, so a cycle that starts at one is made only of loose
// members and the search stops there.
function shortestWalk(graph: EligibleGraph, group: number[], inGroup: Set<number>): number[] {
  let best: { start: number; length: number; distance: Map<number, number> } | undefined;

  for (const start of group) {
    const longestUseful = best === undefined ? Infinity : best.length - 1;
    if (longestUseful < 2 || start >= graph.anchors) break;

    const distance = stepsBackTo(
      graph.predecessors,
      start,
      (node) => node > start && inGroup.has(node),
      longestUseful - 1,
    );
    let length = Infinity;
    for (const next of graph.successors[start]) {
      const steps = distance.get(next);
      if (steps !== undefined) length = Math.min(length, steps + 1);
    }
    if (length <= longestUseful) best = { start, length, distance };
  }

  // The smallest member is never loose in a reported group, and it always
  // closes a cycle inside its own group.
  const { start, length, distance } = best!;
  return smallestWalk(graph.successors, start, length, distance);
}

// How many steps each allowed node needs to reach `target`, found by walking
// edges backwards, up to `maxSteps`.
function stepsBackTo(
  predecessors: number[][],
  target: number,
  allowed: (node: number) => boolean,
  maxSteps: number,
): Map<number, number> {
  const distance = new Map<number, number>([[target, 0]]);
  const queue = [target];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    const steps = distance.get(node)!;
    if (steps >= maxSteps) break;
    for (const previous of predecessors[node]) {
      if (distance.has(previous) || !allowed(previous)) continue;
      distance.set(previous, steps + 1);
      queue.push(previous);
    }
  }
  return distance;
}

// Walks `length` steps from `start` back to it, each time taking the smallest
// next member that is still exactly the right number of steps from home. That
// gives the lexicographically smallest of the shortest cycles through `start`.
function smallestWalk(
  successors: number[][],
  start: number,
  length: number,
  distance: Map<number, number>,
): number[] {
  const walk = [start];
  let node = start;
  for (let remaining = length - 1; remaining > 0; remaining--) {
    node = successors[node].find((next) => distance.get(next) === remaining)!;
    walk.push(node);
  }
  return walk;
}

// The first cycle a depth-first walk from `start` closes, taking members in
// order, rotated to start at its smallest member. A cycle of only loose members
// is passed over. The walk still ends: `start` is not loose, and every member
// of its group reaches it, so the walk meets an edge back to it.
function firstWalk(graph: EligibleGraph, start: number, inGroup: Set<number>): number[] {
  const path: number[] = [];
  const position = new Map<number, number>();
  // Positions on the path of its members that aren't loose, ascending.
  const anchored: number[] = [];
  const finished = new Set<number>();
  const frames: Frame[] = [];

  const enter = (node: number): void => {
    position.set(node, path.length);
    if (node < graph.anchors) anchored.push(path.length);
    path.push(node);
    frames.push({ node, next: 0 });
  };

  enter(start);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1];
    const targets = graph.successors[frame.node];
    if (frame.next < targets.length) {
      const target = targets[frame.next++];
      if (!inGroup.has(target) || finished.has(target)) continue;
      const at = position.get(target);
      if (at === undefined) enter(target);
      else if (anchored[anchored.length - 1] >= at) return rotateToSmallest(path.slice(at));
      continue;
    }
    frames.pop();
    path.pop();
    if (anchored[anchored.length - 1] === path.length) anchored.pop();
    position.delete(frame.node);
    finished.add(frame.node);
  }
  throw new Error(`no cycle from ${graph.ids[start]} in its own strongly connected group`);
}

function rotateToSmallest(walk: number[]): number[] {
  let smallest = 0;
  for (let index = 1; index < walk.length; index++) {
    if (walk[index] < walk[smallest]) smallest = index;
  }
  return [...walk.slice(smallest), ...walk.slice(0, smallest)];
}

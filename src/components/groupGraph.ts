import { compareKeys, indexBy } from '../collections';
import type { SiteRecord } from '../graph/buildFileGraph';
import type { FileGraph } from '../graph/fileGraph';
import type { ImportSite } from '../parser/types';
import { WORKSPACE_ROOT_PACKAGE } from './assignComponents';
import type { Assignment, Group, GroupEdge, GroupGraph, GroupLevel } from './types';

// Aggregates the file graph to one level. An edge between two groups keeps every
// file edge and site under it; an edge inside a group is not an edge at this level.
export function buildGroupGraph(
  graph: FileGraph,
  assignment: Assignment,
  level: GroupLevel,
  sites: SiteRecord[],
): GroupGraph {
  const groupOf = groupLookup(assignment, level);
  const recordOf = new Map<ImportSite, SiteRecord>(sites.map((record) => [record.site, record]));
  const merged = new Map<string, GroupEdge>();

  for (const fileEdge of graph.edges()) {
    const from = groupOf(fileEdge.from);
    const to = groupOf(fileEdge.to);
    if (from === undefined || to === undefined || from.id === to.id) continue;

    const key = JSON.stringify([from.id, to.id]);
    let edge = merged.get(key);
    if (edge === undefined) {
      edge = { from, to, sites: [], fileEdges: [], runtime: false };
      merged.set(key, edge);
    }
    edge.fileEdges.push(fileEdge);
    edge.sites.push(...fileEdge.sites.flatMap((site) => recordOf.get(site) ?? []));
    edge.runtime ||= fileEdge.runtime;
  }

  const members = indexBy(
    graph.files().filter((file) => groupOf(file) !== undefined),
    (file) => groupOf(file)!.id,
  );
  const edges = [...merged.values()].sort(compareGroupEdges);
  const fromIndex = indexBy(edges, (edge) => edge.from.id);
  const toIndex = indexBy(edges, (edge) => edge.to.id);

  return {
    level,
    groups: level === 'component' ? assignment.components : assignment.packages,
    edges,
    edgesFrom: (group) => [...(fromIndex.get(group.id) ?? [])],
    edgesTo: (group) => [...(toIndex.get(group.id) ?? [])],
    filesOf: (group) => [...(members.get(group.id) ?? [])],
  };
}

// A file outside every package has no package of its own, so at this level it
// falls into the workspace-root bucket, which only exists in a workspace repo.
function groupLookup(
  assignment: Assignment,
  level: GroupLevel,
): (file: string) => Group | undefined {
  if (level === 'component') return (file) => assignment.componentOf.get(file);

  const bucket = assignment.packages.find((group) => group.id === WORKSPACE_ROOT_PACKAGE);
  return (file) => assignment.packageOf.get(file) ?? bucket;
}

function compareGroupEdges(a: GroupEdge, b: GroupEdge): number {
  return compareKeys([a.from.id, a.to.id], [b.from.id, b.to.id]);
}

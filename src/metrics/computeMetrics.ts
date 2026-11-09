import { indexBy } from '../collections';
import type { Group, GroupGraph } from '../components/types';
import type { FileGraph } from '../graph/fileGraph';
import type { Declaration, HeritageRef, SymbolIndex } from '../symbols/types';

export type MetricsLevel = 'file' | 'component' | 'package';
export type AbstractnessMode = 'implemented' | 'jdepend';

export interface Metrics {
  id: string;
  level: MetricsLevel;
  Ca: number;
  Ce: number;
  instability: number | null;
  abstractness: number | null;
  distance: number | null;
  exported: number;
  abstract: number;
  data: number;
  unresolvedHeritage: number;
}

export interface MetricsByLevel {
  file: Metrics[];
  component: Metrics[];
  package: Metrics[];
}

// What a set of files declares: the A side of the metrics.
interface DeclarationCounts {
  exported: number;
  abstract: number;
  data: number;
  unresolvedHeritage: number;
}

// Coupling (Ca, Ce) counts distinct neighbours at the level being measured, and
// the declaration counts come from the group's own files, so a package is never
// an average of its components. The file graph only holds edges between analysed
// files, so external modules never count as neighbours.
export function computeMetrics(
  graph: FileGraph,
  groups: { component: GroupGraph; package?: GroupGraph },
  index: SymbolIndex,
  mode: AbstractnessMode,
): MetricsByLevel {
  const countsOf = declarationCounter(index, roleRule(index, mode));

  const file = graph.files().map((path) => {
    const Ca = new Set(graph.edgesTo(path).map((edge) => edge.from)).size;
    const Ce = new Set(graph.edgesFrom(path).map((edge) => edge.to)).size;
    return metricsOf(path, 'file', Ca, Ce, countsOf([path]));
  });

  return {
    file,
    component: groupMetrics(groups.component, countsOf),
    package: groups.package === undefined ? [] : groupMetrics(groups.package, countsOf),
  };
}

function groupMetrics(
  graph: GroupGraph,
  countsOf: (files: string[]) => DeclarationCounts,
): Metrics[] {
  return graph.groups.map((group: Group) => {
    const Ca = new Set(graph.edgesTo(group).map((edge) => edge.from.id)).size;
    const Ce = new Set(graph.edgesFrom(group).map((edge) => edge.to.id)).size;
    return metricsOf(group.id, graph.level, Ca, Ce, countsOf(graph.filesOf(group)));
  });
}

function metricsOf(
  id: string,
  level: MetricsLevel,
  Ca: number,
  Ce: number,
  counts: DeclarationCounts,
): Metrics {
  const instability = Ca + Ce === 0 ? null : Ce / (Ca + Ce);
  // Data is neither abstract nor concrete, so it leaves both sides of the ratio.
  const measured = counts.exported - counts.data;
  const abstractness = measured === 0 ? null : counts.abstract / measured;
  const distance =
    instability === null || abstractness === null ? null : Math.abs(abstractness + instability - 1);
  return { id, level, Ca, Ce, instability, abstractness, distance, ...counts };
}

function declarationCounter(
  index: SymbolIndex,
  roleOf: (declaration: Declaration) => Role,
): (files: string[]) => DeclarationCounts {
  const unresolvedByFile = new Map<string, number>();
  for (const ref of index.heritage()) {
    if (ref.resolved !== null) continue;
    unresolvedByFile.set(ref.from.file, (unresolvedByFile.get(ref.from.file) ?? 0) + 1);
  }

  return (files) => {
    const counts: DeclarationCounts = { exported: 0, abstract: 0, data: 0, unresolvedHeritage: 0 };
    for (const file of files) {
      for (const declaration of index.declarations(file)) {
        if (!declaration.exported) continue;
        counts.exported++;
        const role = roleOf(declaration);
        if (role === 'abstract') counts.abstract++;
        else if (role === 'data') counts.data++;
      }
      counts.unresolvedHeritage += unresolvedByFile.get(file) ?? 0;
    }
    return counts;
  };
}

const ABSTRACT_CAPABLE = new Set<Declaration['kind']>(['interface', 'abstract-class']);
const JDEPEND_ABSTRACT = new Set<Declaration['kind']>(['interface', 'type', 'abstract-class']);

type Role = 'abstract' | 'data' | 'concrete';

// "jdepend": every interface, type alias and abstract class is abstract, and
// there is no data category.
// "implemented": an interface or abstract class is abstract only when a class
// implements or extends it; otherwise a declaration shaped like data is data.
function roleRule(index: SymbolIndex, mode: AbstractnessMode): (declaration: Declaration) => Role {
  if (mode === 'jdepend') {
    return (declaration) => (JDEPEND_ABSTRACT.has(declaration.kind) ? 'abstract' : 'concrete');
  }
  const implemented = implementedDeclarations(index.heritage());
  return (declaration) => {
    if (ABSTRACT_CAPABLE.has(declaration.kind) && implemented.has(declaration.id)) {
      return 'abstract';
    }
    return declaration.dataShape ? 'data' : 'concrete';
  };
}

// Everything a class implements or extends, plus every interface those extend:
// a class implementing B also implements each interface B extends.
function implementedDeclarations(refs: HeritageRef[]): Set<string> {
  const resolved = refs.filter((ref) => ref.resolved !== null);
  const ancestors = indexBy(
    resolved.filter((ref) => ref.owner === 'interface'),
    (ref) => ref.from.id,
  );
  const pending = resolved.filter((ref) => ref.owner === 'class').map((ref) => ref.resolved!.id);

  const implemented = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (implemented.has(id)) continue;
    implemented.add(id);
    for (const ref of ancestors.get(id) ?? []) pending.push(ref.resolved!.id);
  }
  return implemented;
}

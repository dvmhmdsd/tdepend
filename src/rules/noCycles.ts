import { createHash } from 'node:crypto';

import type { Group } from '../components/types';
import {
  fileCycleGraph,
  findCycles,
  groupCycleGraph,
  type Cycle,
  type CycleGraph,
  type CycleLevel,
} from '../cycles/findCycles';
import { inScope, type RuleContext, type RuleOutcome } from './context';
import { finishViolation, severityOf, siteData } from './identity';
import type { CycleWitness, NoCyclesRule, RuleInstance, Violation } from './types';

const PLURAL: Record<CycleLevel, string> = {
  file: 'files',
  component: 'components',
  package: 'packages',
};

// One violation per strongly connected group, located at the witness's first hop.
export function evaluateNoCycles(
  instance: RuleInstance,
  rule: NoCyclesRule,
  context: RuleContext,
): RuleOutcome {
  const graph = scopedGraph(rule.level, instance.scopeFiles, context);
  if (graph === null) return { violations: [], warnings: [] };

  const cycles = findCycles(
    {
      level: rule.level,
      graphId: context.input.graph.id,
      scopeId: scopeIdOf(instance),
      ...graph.cycleGraph,
    },
    {
      ignoreTypeOnly: rule.ignoreTypeOnly ?? true,
      ignoreLazyImports: rule.ignoreLazyImports ?? false,
    },
    context.input.cycleCache,
  );
  return {
    violations: cycles.map((cycle) => cycleViolation(instance, rule, cycle, graph.nameOf)),
    warnings: [],
  };
}

interface ScopedGraph {
  cycleGraph: CycleGraph;
  nameOf(id: string): string;
}

// The graph at the rule's level, cut down to the instance's scope. A group is
// in scope when one of its files is. Without workspace packages there is no
// package graph, so a package-level rule has nothing to check.
function scopedGraph(
  level: CycleLevel,
  scope: RuleInstance['scopeFiles'],
  context: RuleContext,
): ScopedGraph | null {
  const { input } = context;
  if (level === 'file') {
    return {
      cycleGraph: fileCycleGraph(input.graph, input.sites, (file) => inScope(scope, file)),
      nameOf: (id) => id,
    };
  }
  const groupGraph = level === 'component' ? input.groups.component : input.groups.package;
  if (groupGraph === undefined) return null;
  const groups = new Map(groupGraph.groups.map((group): [string, Group] => [group.id, group]));
  return {
    cycleGraph: groupCycleGraph(groupGraph, (group) =>
      groupGraph.filesOf(group).some((file) => inScope(scope, file)),
    ),
    nameOf: (id) => groups.get(id)?.name ?? id,
  };
}

// The cache scope is the set of files itself: the root project and the whole
// repository share the id `proj:(repo)` but not their files.
function scopeIdOf(instance: RuleInstance): string {
  if (instance.scopeFiles === 'repo') return 'repo';
  const files = JSON.stringify([...instance.scopeFiles].sort());
  return `files:${createHash('sha1').update(files).digest('hex')}`;
}

function cycleViolation(
  instance: RuleInstance,
  rule: NoCyclesRule,
  cycle: Cycle,
  nameOf: (id: string) => string,
): Violation {
  const [first] = cycle.hops;
  const witness: CycleWitness = {
    level: cycle.level,
    members: cycle.members,
    hops: cycle.hops.map((hop) => ({ ...hop, site: siteData(hop.site) })),
    optimal: cycle.optimal,
  };
  const path = [...cycle.hops.map((hop) => hop.fromGroup), first.fromGroup].map(nameOf).join(' → ');
  return finishViolation({
    kind: 'cycle',
    ruleId: rule.id,
    projectId: instance.projectId,
    severity: severityOf(rule),
    message:
      rule.message ??
      `Import cycle between ${cycle.members.length} ${PLURAL[cycle.level]}: ${path}. Remove or invert one of these imports.`,
    from: first.fromFile,
    to: first.to,
    site: siteData(first.site),
    witness,
  });
}

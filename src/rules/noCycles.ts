import { createHash } from 'node:crypto';

import { groupLookup } from '../components/groupGraph';
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
    violations: cycles.map((cycle) => cycleViolation(instance, rule, cycle, graph)),
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
  const keep = (file: string): boolean => inScope(scope, file);
  if (level === 'file') {
    return { cycleGraph: fileCycleGraph(input.graph, input.sites, keep), nameOf: (id) => id };
  }
  if (level === 'package' && input.groups.package === undefined) return null;
  const cycleGraph = groupCycleGraph(
    input.graph,
    input.sites,
    groupLookup(input.assignment, level),
    keep,
  );
  return { cycleGraph, nameOf: cycleGraph.nameOf };
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
  { cycleGraph, nameOf }: ScopedGraph,
): Violation {
  const [first] = cycle.hops;
  const witness: CycleWitness = {
    level: cycle.level,
    members: cycle.members,
    hops: cycle.hops.map((hop) => ({ ...hop, site: siteData(hop.site) })),
    optimal: cycle.optimal,
  };
  const path = [...cycle.hops.map((hop) => hop.fromGroup), first.fromGroup].map(nameOf).join(' → ');
  const loose = cycle.members.filter((id) => cycleGraph.isLoose?.(id) ?? false).length;
  const between =
    loose === 0
      ? count(cycle.members.length, cycle.level)
      : `${count(cycle.members.length - loose, cycle.level)} and ${count(loose, 'file')} outside every ${cycle.level}`;
  return finishViolation({
    kind: 'cycle',
    ruleId: rule.id,
    projectId: instance.projectId,
    severity: severityOf(rule),
    message:
      rule.message ??
      `Import cycle between ${between}: ${path}. Remove or invert one of these imports.`,
    from: first.fromFile,
    to: first.to,
    site: siteData(first.site),
    witness,
  });
}

function count(amount: number, noun: string): string {
  return `${amount} ${noun}${amount === 1 ? '' : 's'}`;
}

import { groupLookup } from '../components/groupGraph';
import type { Group } from '../components/types';
import {
  compareSiteRecords,
  type ResolutionReport,
  type SiteRecord,
} from '../graph/buildFileGraph';
import type { FileEdge } from '../graph/fileGraph';
import { siteData } from '../rules/identity';
import type { RuleInstance } from '../rules/types';
import type {
  AnalysisResult,
  GroupCycle,
  SerializableCycle,
  SerializableEdge,
  SerializableGroup,
  SerializableReport,
  SerializableResult,
  SerializableRuleInstance,
  SerializableSite,
  SerializableSiteLocation,
  SerializableUnsupported,
} from '../types/api';

/**
 * Projects an analysis into its versioned, fully sorted export shape. The
 * parser's `ts.Node` references and the project context are dropped here, so
 * the result is plain data with no timestamp.
 */
export function toSerializable(result: AnalysisResult): SerializableResult {
  const filesOf = groupFiles(result);
  return {
    version: 2,
    files: result.graph.files(),
    edges: result.graph.edges().map(serializeEdge),
    sites: [...result.sites].sort(compareSiteRecords).map(serializeSite),
    components: result.assignment.components.map((group) => serializeGroup(group, filesOf)),
    packages: result.assignment.packages.map((group) => serializeGroup(group, filesOf)),
    metrics: result.metrics,
    cycles: {
      component: result.cycles.component.map(serializeCycle),
      package: result.cycles.package.map(serializeCycle),
    },
    rules: result.effective.instances.map(serializeInstance),
    report: serializeReport(result.report, discoveryWarnings(result)),
  };
}

// Group id → its files, for components and packages alike.
function groupFiles(result: AnalysisResult): Map<string, string[]> {
  const files = new Map<string, string[]>();
  const add = (group: Group | null | undefined, file: string): void => {
    if (group === null || group === undefined) return;
    const list = files.get(group.id);
    if (list === undefined) files.set(group.id, [file]);
    else list.push(file);
  };
  const packageOf =
    result.assignment.packages.length === 0 ? null : groupLookup(result.assignment, 'package');
  for (const file of result.graph.files()) {
    add(result.assignment.componentOf.get(file), file);
    add(packageOf?.(file), file);
  }
  return files;
}

function serializeGroup(group: Group, filesOf: Map<string, string[]>): SerializableGroup {
  return {
    id: group.id,
    name: group.name,
    directory: group.directory,
    projectId: group.projectId,
    packageId: group.packageId,
    level: group.level,
    files: filesOf.get(group.id) ?? [],
  };
}

function serializeCycle(cycle: GroupCycle): SerializableCycle {
  return {
    level: cycle.level,
    members: cycle.members,
    names: cycle.names,
    optimal: cycle.optimal,
    hops: cycle.hops.map((hop) => ({ ...hop, site: siteData(hop.site) })),
  };
}

function serializeInstance(instance: RuleInstance): SerializableRuleInstance {
  return {
    id: instance.rule.id,
    projectId: instance.projectId,
    scope: instance.scope,
    origin: instance.origin,
    severity: instance.rule.severity ?? 'error',
    rule: instance.rule,
  };
}

function serializeSite(record: SiteRecord): SerializableSite {
  const { site, resolution } = record;
  return {
    file: record.file,
    specifier: site.specifier,
    line: site.line,
    column: site.column,
    kind: site.kind,
    form: site.form,
    deferred: site.deferred === true,
    unsupported: site.unsupported ?? null,
    loadsTarget: site.loadsTarget === true,
    loadsTargetBy: site.loadsTargetBy ?? null,
    class: resolution.class,
    reason: resolution.reason ?? null,
    target: resolution.target,
    mapped: resolution.mapped?.from ?? null,
    requested: resolution.requested ?? null,
  };
}

function serializeEdge(edge: FileEdge): SerializableEdge {
  return {
    from: edge.from,
    to: edge.to,
    runtime: edge.runtime,
    mapped: edge.mapped,
    kinds: [...new Set(edge.sites.map((site) => site.kind))].sort(),
  };
}

export function serializeReport(report: ResolutionReport, warnings: string[]): SerializableReport {
  return {
    stats: { ...report.stats },
    unresolved: report.unresolved.map(siteLocation),
    ignoredByDir: { ...report.ignoredByDir },
    unsupported: report.unsupported.map(serializeUnsupported),
    selfImports: [...report.selfImports],
    uncovered: [...report.uncovered],
    skipped: report.skipped.map((entry) => ({ file: entry.file, reason: entry.reason })),
    warnings,
  };
}

export function discoveryWarnings(result: AnalysisResult): string[] {
  return [...result.ctx.warnings, ...result.ctx.unsupported.map((name) => `unsupported: ${name}`)];
}

function siteLocation(record: SiteRecord): SerializableSiteLocation {
  return {
    file: record.file,
    line: record.site.line,
    column: record.site.column,
    specifier: record.site.specifier,
  };
}

function serializeUnsupported(record: SiteRecord): SerializableUnsupported {
  return { ...siteLocation(record), reason: record.resolution.reason ?? '' };
}

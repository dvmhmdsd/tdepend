import type { SiteRecord } from '../graph/buildFileGraph';
import type { FileEdge } from '../graph/fileGraph';
import type {
  AnalysisResult,
  SerializableEdge,
  SerializableReport,
  SerializableResult,
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
  return {
    version: 1,
    files: result.graph.files(),
    edges: result.graph.edges().map(serializeEdge),
    sites: [...result.sites].sort(compareRecords).map(serializeSite),
    report: serializeReport(result),
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

function serializeReport(result: AnalysisResult): SerializableReport {
  return {
    stats: { ...result.report.stats },
    unresolved: result.report.unresolved.map(siteLocation),
    ignoredByDir: { ...result.report.ignoredByDir },
    unsupported: result.report.unsupported.map(serializeUnsupported),
    selfImports: [...result.report.selfImports],
    uncovered: [...result.report.uncovered],
    skipped: result.report.skipped.map((entry) => ({ file: entry.file, reason: entry.reason })),
    warnings: discoveryWarnings(result),
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

function compareRecords(a: SiteRecord, b: SiteRecord): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.site.line !== b.site.line) return a.site.line - b.site.line;
  return a.site.column - b.site.column;
}

import { discoveryWarnings } from '../api/serialization';
import type { AnalysisResult } from '../types/api';

const MAX_UNRESOLVED = 20;
const MAX_IGNORED_DIRS = 10;

/**
 * Renders the human-readable `analyze` report: a summary line set, the
 * unresolved imports with `path:line`, the ignored (gitignored) target
 * directories, and the unsupported, self-import and uncovered-file counts.
 */
export function formatAnalyzeText(result: AnalysisResult): string {
  const sections = [
    summaryLines(result),
    classLines(result),
    unresolvedLines(result),
    ignoredLines(result),
    unsupportedLines(result),
    [
      `Self-imports: ${result.report.selfImports.length}`,
      `Files outside every tsconfig: ${result.files.uncovered.length}`,
    ],
    notInstalledLines(result),
    warningLines(result),
  ].filter((lines) => lines.length > 0);

  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

function summaryLines(result: AnalysisResult): string[] {
  return [
    `Files: ${result.files.files.length}`,
    `Import sites: ${result.sites.length}`,
    `Edges: ${result.graph.edges().length}`,
  ];
}

function classLines(result: AnalysisResult): string[] {
  const lines = ['Sites by class:'];
  for (const [name, count] of Object.entries(result.report.stats)) {
    lines.push(`  ${name}: ${count}`);
  }
  return lines;
}

function unsupportedLines(result: AnalysisResult): string[] {
  const byReason = new Map<string, number>();
  for (const record of result.report.unsupported) {
    const reason = record.resolution.reason ?? 'unknown';
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const lines = [`Unsupported imports: ${result.report.unsupported.length}`];
  for (const [reason, count] of [...byReason.entries()].sort()) {
    lines.push(`  ${reason}: ${count}`);
  }
  return lines;
}

function notInstalledLines(result: AnalysisResult): string[] {
  const count = result.sites.filter(
    (record) => record.resolution.class === 'external' && record.resolution.reason === 'not-installed',
  ).length;
  if (count === 0) return [];
  return [`Declared packages not found: ${count} (is node_modules installed?)`];
}

function warningLines(result: AnalysisResult): string[] {
  const warnings = discoveryWarnings(result);
  if (warnings.length === 0) return [];
  return ['Warnings:', ...warnings.map((warning) => `  ${warning}`)];
}

function unresolvedLines(result: AnalysisResult): string[] {
  const { unresolved } = result.report;
  const lines = [`Unresolved imports (${unresolved.length}):`];

  for (const record of unresolved.slice(0, MAX_UNRESOLVED)) {
    lines.push(`  ${record.file}:${record.site.line}  ${record.site.specifier}`);
  }
  if (unresolved.length > MAX_UNRESOLVED) {
    lines.push(`  ... and ${unresolved.length - MAX_UNRESOLVED} more`);
  }

  return lines;
}

function ignoredLines(result: AnalysisResult): string[] {
  const entries = Object.entries(result.report.ignoredByDir).sort(compareIgnored);
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const lines = [`Ignored (gitignored targets): ${total}`];

  for (const [dir, count] of entries.slice(0, MAX_IGNORED_DIRS)) {
    lines.push(`  ${dir} (${count})`);
  }

  return lines;
}

function compareIgnored(a: [string, number], b: [string, number]): number {
  if (a[1] !== b[1]) return b[1] - a[1];
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

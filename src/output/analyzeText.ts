import { discoveryWarnings } from '../api/serialization';
import type { Group } from '../components/types';
import type { Metrics } from '../metrics/computeMetrics';
import type { AnalysisResult, GroupCycle } from '../types/api';

const MAX_UNRESOLVED = 20;
const MAX_IGNORED_DIRS = 10;

/**
 * Renders the human-readable `analyze` report: a summary, component metrics
 * (and package metrics in a workspace), distance highlights, cycles with their
 * imports, then the resolution report: classes, unresolved imports, ignored
 * target directories, and the unsupported, self-import and uncovered counts.
 */
export function formatAnalyzeText(result: AnalysisResult): string {
  const sections = [
    summaryLines(result),
    metricLines('Components', result.metrics.component, result.assignment.components),
    result.groups.package === undefined
      ? []
      : metricLines('Packages', result.metrics.package, result.assignment.packages),
    distanceLines(result),
    cycleLines('Component cycles', result.cycles.component),
    cycleLines('Package cycles', result.cycles.package),
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
    (record) =>
      record.resolution.class === 'external' && record.resolution.reason === 'not-installed',
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

function metricLines(title: string, rows: Metrics[], groups: Group[]): string[] {
  if (rows.length === 0) return [];
  const nameOf = new Map(groups.map((group) => [group.id, group.name]));
  const names = rows.map((row) => nameOf.get(row.id) ?? row.id);
  const width = Math.max(...names.map((name) => name.length));
  const header = ['Ca'.padStart(4), 'Ce'.padStart(3), ...['I', 'A', 'D'].map((x) => x.padStart(5))];
  const lines = [`${title} (${rows.length}):`, `  ${''.padEnd(width)}  ${header.join(' ')}`];
  rows.forEach((row, index) => {
    const numbers = [
      pad(row.Ca, 4),
      pad(row.Ce, 3),
      ratio(row.instability),
      ratio(row.abstractness),
      ratio(row.distance),
    ];
    lines.push(`  ${names[index].padEnd(width)}  ${numbers.join(' ')}`);
  });
  return lines;
}

// With `metrics.thresholds.distance`, the components furthest from the main
// sequence are listed again. It is a report only; it never changes the exit code.
function distanceLines(result: AnalysisResult): string[] {
  const threshold = result.config.metrics.thresholds.distance;
  if (threshold === null) return [];
  const nameOf = new Map(result.assignment.components.map((group) => [group.id, group.name]));
  const far = result.metrics.component.filter(
    (row) => row.distance !== null && row.distance > threshold,
  );
  if (far.length === 0)
    return [`No component is further than ${threshold} from the main sequence.`];
  return [
    `Further than ${threshold} from the main sequence (${far.length}):`,
    ...far.map((row) => `  ${nameOf.get(row.id) ?? row.id}  D ${ratio(row.distance).trim()}`),
  ];
}

function cycleLines(title: string, cycles: GroupCycle[]): string[] {
  if (cycles.length === 0) return [];
  const lines = [`${title} (${cycles.length}):`];
  for (const cycle of cycles) {
    const nameOf = new Map(cycle.members.map((id, index) => [id, cycle.names[index]]));
    const path = [...cycle.hops.map((hop) => hop.fromGroup), cycle.hops[0].fromGroup];
    lines.push(`  ${path.map((id) => nameOf.get(id) ?? id).join(' → ')}`);
    for (const hop of cycle.hops) {
      const target = 'file' in hop.to ? hop.to.file : hop.to.module;
      lines.push(
        `    ${hop.fromFile}:${hop.site.line}:${hop.site.column}  '${hop.site.specifier}' → ${target}`,
      );
    }
  }
  return lines;
}

function ratio(value: number | null): string {
  return (value === null ? '-' : value.toFixed(2)).padStart(5);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width);
}

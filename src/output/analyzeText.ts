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
    unresolvedLines(result),
    ignoredLines(result),
    [
      `Unsupported imports: ${result.report.unsupported.length}`,
      `Self-imports: ${result.report.selfImports.length}`,
      `Files outside every tsconfig: ${result.files.uncovered.length}`,
    ],
  ];

  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

function summaryLines(result: AnalysisResult): string[] {
  return [
    `Files: ${result.files.files.length}`,
    `Import sites: ${result.sites.length}`,
    `Edges: ${result.graph.edges().length}`,
  ];
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

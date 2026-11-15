import type { CheckReport } from '../api/check';
import { serializeReport } from '../api/serialization';
import type { BaselineEntry } from '../baseline/baseline';
import type { Violation, ViolationTarget } from '../rules/types';

export interface FormatOptions {
  /** Put before every path, so output from a subfolder lines up with the repository. */
  pathPrefix: string;
}

// One line per actionable finding, errors first; a cycle lists every hop under
// it. Known findings are only counted.
export function formatText(report: CheckReport, { pathPrefix }: FormatOptions): string {
  const path = (file: string): string => `${pathPrefix}${file}`;
  const errors = report.actionable.filter((violation) => violation.severity === 'error');
  const warns = report.actionable.filter((violation) => violation.severity === 'warn');
  const sections: string[][] = [];

  if (errors.length > 0)
    sections.push([`Errors (${errors.length}):`, ...findingLines(errors, path)]);
  if (warns.length > 0)
    sections.push([`Warnings (${warns.length}):`, ...findingLines(warns, path)]);
  if (report.noLongerReported.length > 0) {
    sections.push([
      `No longer reported (${report.noLongerReported.length}):`,
      ...report.noLongerReported.map((entry) => `  ${entryLine(entry, path)}`),
    ]);
  }
  if (report.warnings.length > 0) {
    sections.push(['Notes:', ...report.warnings.map((warning) => `  ${warning}`)]);
  }
  sections.push([summary(report, errors.length, warns.length)]);

  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

export function formatJson(report: CheckReport): string {
  const errors = report.actionable.filter((violation) => violation.severity === 'error').length;
  const data = {
    analyzerVersion: report.analyzerVersion,
    baseline: report.baseline,
    summary: {
      errors,
      warnings: report.actionable.length - errors,
      known: report.known.length,
      noLongerReported: report.noLongerReported.length,
    },
    actionable: report.actionable,
    known: report.known,
    noLongerReported: report.noLongerReported,
    warnings: report.warnings,
    resolution: serializeReport(report.report, []),
  };
  return `${JSON.stringify(data, null, 2)}\n`;
}

function findingLines(violations: Violation[], path: (file: string) => string): string[] {
  return violations.flatMap((violation) => {
    const line = `  ${findingLine(violation, path)}`;
    if (violation.kind !== 'cycle' || violation.witness === undefined) return [line];
    const hops = violation.witness.hops.map(
      (hop) =>
        `      ${path(hop.fromFile)}:${hop.site.line}:${hop.site.column}  '${hop.site.specifier}' → ${targetText(hop.to, path)}`,
    );
    return [line, ...hops];
  });
}

// path:line:col  RULE  message  ('specifier' → target); a coverage finding has
// no import, so it is the file alone.
export function findingLine(violation: Violation, path: (file: string) => string): string {
  if (violation.site === undefined) {
    return `${path(violation.from)}  ${violation.ruleId}  ${violation.message}`;
  }
  const { line, column, specifier } = violation.site;
  const target = violation.to === undefined ? '' : ` → ${targetText(violation.to, path)}`;
  return `${path(violation.from)}:${line}:${column}  ${violation.ruleId}  ${violation.message}  ('${specifier}'${target})`;
}

function entryLine(entry: BaselineEntry, path: (file: string) => string): string {
  const where =
    entry.kind === 'cycle'
      ? `${entry.level} cycle [${(entry.members ?? []).join(', ')}]`
      : entry.target === undefined
        ? path(entry.from)
        : `${path(entry.from)} → ${targetText(entry.target, path)}`;
  return `${entry.ruleId}  ${where}  (accepted ${entry.count})`;
}

function targetText(target: ViolationTarget, path: (file: string) => string): string {
  return 'file' in target ? path(target.file) : target.module;
}

function summary(report: CheckReport, errors: number, warns: number): string {
  const parts = [plural(errors, 'error'), plural(warns, 'warning')];
  if (report.baseline !== null) parts.push(`${report.known.length} known from the baseline`);
  return `${parts.join(', ')}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

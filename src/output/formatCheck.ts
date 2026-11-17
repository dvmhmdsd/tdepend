import type { CheckReport } from '../api/check';
import { serializeReport } from '../api/serialization';
import type { BaselineEntry } from '../baseline/baseline';
import type { Violation, ViolationTarget } from '../rules/types';

// One line per actionable finding, errors first; a cycle lists every hop under
// it. Known findings are only counted.
export function formatText(report: CheckReport): string {
  const errors = report.actionable.filter((violation) => violation.severity === 'error');
  const warns = report.actionable.filter((violation) => violation.severity === 'warn');
  const sections: string[][] = [];

  if (errors.length > 0) sections.push([`Errors (${errors.length}):`, ...findingLines(errors)]);
  if (warns.length > 0) sections.push([`Warnings (${warns.length}):`, ...findingLines(warns)]);
  if (report.noLongerReported.length > 0) {
    sections.push([
      `No longer reported (${report.noLongerReported.length}):`,
      ...report.noLongerReported.map((entry) => `  ${entryLine(entry)}`),
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
    exitCode: report.exitCode,
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

function findingLines(violations: Violation[]): string[] {
  return violations.flatMap((violation) => {
    const line = `  ${findingLine(violation)}`;
    if (violation.kind !== 'cycle' || violation.witness === undefined) return [line];
    const hops = violation.witness.hops.map(
      (hop) =>
        `      ${hop.fromFile}:${hop.site.line}:${hop.site.column}  '${hop.site.specifier}' → ${targetText(hop.to)}`,
    );
    return [line, ...hops];
  });
}

// path:line:col  RULE  message  ('specifier' → target); a coverage finding has
// no import, so it is the file alone.
export function findingLine(violation: Violation): string {
  if (violation.site === undefined) {
    return `${violation.from}  ${violation.ruleId}  ${violation.message}`;
  }
  const { line, column, specifier } = violation.site;
  const target = violation.to === undefined ? '' : ` → ${targetText(violation.to)}`;
  return `${violation.from}:${line}:${column}  ${violation.ruleId}  ${violation.message}  ('${specifier}'${target})`;
}

function entryLine(entry: BaselineEntry): string {
  const where =
    entry.kind === 'cycle'
      ? `${entry.level} cycle [${(entry.members ?? []).join(', ')}]`
      : entry.target === undefined
        ? entry.from
        : `${entry.from} → ${targetText(entry.target)}`;
  return `${entry.ruleId}  ${where}  (accepted ${entry.count})`;
}

function targetText(target: ViolationTarget): string {
  return 'file' in target ? target.file : target.module;
}

function summary(report: CheckReport, errors: number, warns: number): string {
  const parts = [plural(errors, 'error'), plural(warns, 'warning')];
  if (report.baseline !== null) parts.push(`${report.known.length} known from the baseline`);
  return `${parts.join(', ')}.`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

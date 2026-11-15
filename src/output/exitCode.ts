import type { CheckReport } from '../api/check';

// 2 means the analysis can't be trusted, so it wins over 1, which means an
// actionable error. Warnings and known violations never fail a run.
export function exitCodeFor(
  report: Pick<CheckReport, 'actionable' | 'report'>,
  opts: { strictResolution: boolean },
): 0 | 1 | 2 {
  if (opts.strictResolution && report.report.unresolved.length > 0) return 2;
  return report.actionable.some((violation) => violation.severity === 'error') ? 1 : 0;
}

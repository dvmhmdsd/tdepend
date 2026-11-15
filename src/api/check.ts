import { isAbsolute, resolve as resolvePath } from 'node:path';

import { compareWithBaseline, readBaseline, type BaselineEntry } from '../baseline/baseline';
import type { ResolutionReport } from '../graph/buildFileGraph';
import { evaluateRules } from '../rules/evaluateRules';
import type { Violation } from '../rules/types';
import type { AnalysisResult } from '../types/api';
import { packageVersion } from '../version';
import { analyze, type AnalyzeOptions } from './analyze';
import { discoveryWarnings } from './serialization';

export interface CheckOptions extends AnalyzeOptions {
  /** A baseline file; relative paths are read from the root. Overrides the config's `baseline`. */
  baseline?: string;
  /** Exit 2 when any import is unresolved. */
  strictResolution?: boolean;
}

export interface CheckReport {
  violations: Violation[];
  /** Violations the baseline doesn't cover. Only these decide the exit code. */
  actionable: Violation[];
  known: Violation[];
  noLongerReported: BaselineEntry[];
  warnings: string[];
  report: ResolutionReport;
  analyzerVersion: string;
  /** The baseline file compared against, or null when there was none. */
  baseline: string | null;
}

/**
 * Analyses the project, evaluates every effective rule instance and compares
 * the violations with the baseline, if one is configured or given.
 */
export async function check(options: CheckOptions = {}): Promise<CheckReport> {
  const result = await analyze(options);
  return checkAnalysis(result, baselinePath(options, result));
}

export function checkAnalysis(result: AnalysisResult, baseline: string | null): CheckReport {
  const evaluation = evaluateRules(
    {
      ctx: result.ctx,
      graph: result.graph,
      sites: result.sites,
      assignment: result.assignment,
      groups: result.groups,
      index: result.index,
      coverage: result.effective.coverage,
      cycleCache: result.cycleCache,
    },
    result.effective.instances,
  );
  const comparison =
    baseline === null
      ? { actionable: evaluation.violations, known: [], noLongerReported: [] }
      : compareWithBaseline(evaluation.violations, readBaseline(baseline));
  const warnings = new Set([
    ...discoveryWarnings(result),
    ...result.assignment.warnings,
    ...result.effective.warnings,
    ...evaluation.warnings,
  ]);

  return {
    violations: evaluation.violations,
    ...comparison,
    warnings: [...warnings].sort(),
    report: result.report,
    analyzerVersion: packageVersion(),
    baseline,
  };
}

// An explicit path is read from the root; the config's `baseline` from the
// config's own folder, like every other path in it.
export function baselinePath(
  options: Pick<CheckOptions, 'baseline' | 'root'>,
  result: AnalysisResult,
): string | null {
  if (options.baseline !== undefined) {
    if (isAbsolute(options.baseline)) return options.baseline;
    return resolvePath(options.root ?? process.cwd(), options.baseline);
  }
  if (result.config.baseline === null) return null;
  return resolvePath(result.configDir, result.config.baseline);
}

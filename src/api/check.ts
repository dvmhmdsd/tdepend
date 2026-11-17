import { existsSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import { compareWithBaseline, readBaseline, type BaselineEntry } from '../baseline/baseline';
import type { ResolutionReport } from '../graph/buildFileGraph';
import { evaluateRules } from '../rules/evaluateRules';
import type { Violation } from '../rules/types';
import type { AnalysisResult } from '../types/api';
import { exitCodeFor } from '../output/exitCode';
import { packageVersion } from '../version';
import { analyze, type AnalyzeOptions } from './analyze';
import { discoveryWarnings } from './serialization';

export interface CheckOptions extends AnalyzeOptions {
  /** A baseline file; relative paths are read from the root. Overrides the config's `baseline`. */
  baseline?: string;
  /** Make `exitCode` 2 when any import is unresolved. */
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
  /** 0, 1 for an error the baseline doesn't cover, 2 for unresolved imports under `strictResolution`. */
  exitCode: 0 | 1 | 2;
}

const DEFAULT_BASELINE = 'tdepend-baseline.json';

/**
 * Analyses the project, evaluates every effective rule instance and compares
 * the violations with the baseline, if one is configured or given.
 */
export async function check(options: CheckOptions = {}): Promise<CheckReport> {
  const result = await analyze(options);
  return checkAnalysis(result, baselinePath(options, result), options.strictResolution === true);
}

export function checkAnalysis(
  result: AnalysisResult,
  baseline: string | null,
  strictResolution = false,
): CheckReport {
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
    exitCode: exitCodeFor({ ...comparison, report: result.report }, { strictResolution }),
  };
}

// Where `tdepend baseline` writes: the config's `baseline`, read from the
// config's folder like every other path in it, or tdepend-baseline.json there.
export function baselineFile(result: AnalysisResult): string {
  return resolvePath(result.configDir, result.config.baseline ?? DEFAULT_BASELINE);
}

// The baseline `check` compares with: an explicit path, read from the root;
// else the one `tdepend baseline` writes. A configured file must exist; the
// default one is used only when it does.
export function baselinePath(
  options: Pick<CheckOptions, 'baseline' | 'root'>,
  result: AnalysisResult,
): string | null {
  if (options.baseline !== undefined) {
    if (isAbsolute(options.baseline)) return options.baseline;
    return resolvePath(options.root ?? process.cwd(), options.baseline);
  }
  const file = baselineFile(result);
  return result.config.baseline !== null || existsSync(file) ? file : null;
}

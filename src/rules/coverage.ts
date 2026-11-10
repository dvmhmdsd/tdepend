import type { RuleContext } from './context';
import { finishViolation } from './identity';
import { globMatcher } from './selectors';
import { REPO_SCOPE, type Violation } from './types';

export const COVERAGE_RULE_ID = 'components/coverage';

const MESSAGE =
  'File belongs to no declared component. Add it to a component pattern or to `allowUnmatched`.';

// With `requireAll`, every file left in a root bucket that no `allowUnmatched`
// glob covers is a violation, so a new directory can't escape the architecture.
// The finding names a file only: there is no import to point at.
export function evaluateCoverage(context: RuleContext): Violation[] {
  const { coverage, assignment } = context.input;
  if (coverage === undefined || !coverage.requireAll) return [];
  const allowed = globMatcher(coverage.allowUnmatched);
  return assignment.unassigned
    .filter((file) => !allowed(file))
    .map((file) =>
      finishViolation({
        kind: 'coverage',
        ruleId: COVERAGE_RULE_ID,
        projectId: REPO_SCOPE,
        severity: 'error',
        message: MESSAGE,
        from: file,
      }),
    );
}

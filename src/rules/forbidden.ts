import { unmatchedGlobs, type RuleContext, type RuleOutcome } from './context';
import { importViolation } from './identity';
import { globMatcher, selectorFiles, selectorMatcher } from './selectors';
import type { ForbiddenRule, RuleInstance } from './types';

// Each import site from a `from` file to a `to` target is one violation, unless
// an exception, the `kinds` list or `runtimeOnly` lets it through.
export function evaluateForbidden(
  instance: RuleInstance,
  rule: ForbiddenRule,
  context: RuleContext,
): RuleOutcome {
  const from = globMatcher(rule.from);
  const exceptFrom = globMatcher(rule.exceptFrom);
  const to = selectorMatcher(rule.to);
  const exceptTo = selectorMatcher(rule.exceptTo);
  const kinds = rule.kinds === undefined ? null : new Set(rule.kinds);

  const violations = context
    .sitesIn(instance)
    .filter(
      (record) =>
        from(record.file) &&
        !exceptFrom(record.file) &&
        (kinds === null || kinds.has(record.site.kind)) &&
        (rule.runtimeOnly !== true || record.site.loadsTarget === true) &&
        to(record) &&
        !exceptTo(record),
    )
    .map((record) => importViolation(instance, record, rule.message));

  return {
    violations,
    warnings: unmatchedGlobs(instance, context, [
      ['from', rule.from],
      ['to', selectorFiles(rule.to)],
    ]),
  };
}

import { ConfigError } from '../errors';
import { createContext, type RuleContext, type RuleOutcome } from './context';
import { evaluateCoverage } from './coverage';
import { evaluateForbidden } from './forbidden';
import { evaluateLayers } from './layers';
import { evaluateNoCycles } from './noCycles';
import { evaluatePrivate } from './private';
import {
  REPO_SCOPE,
  type RuleConfig,
  type RuleDefinition,
  type RuleEvaluation,
  type RuleInput,
  type RuleInstance,
  type Violation,
} from './types';

// Runs every instance that isn't `off`, plus coverage when it is configured.
// Violations come back sorted by file, line, column and rule; warnings are
// sorted and each appears once.
export function evaluateRules(input: RuleInput, instances: RuleInstance[]): RuleEvaluation {
  const context = createContext(input);
  const violations: Violation[] = evaluateCoverage(context);
  const warnings = new Set<string>();

  for (const instance of instances) {
    if (instance.rule.severity === 'off') continue;
    const outcome = evaluateInstance(instance, context);
    violations.push(...outcome.violations);
    for (const warning of outcome.warnings) warnings.add(warning);
  }

  return {
    violations: violations.sort(compareViolations),
    warnings: [...warnings].sort(),
    instances,
  };
}

function evaluateInstance(instance: RuleInstance, context: RuleContext): RuleOutcome {
  const rule = instance.rule;
  switch (rule.type) {
    case 'forbidden':
      return evaluateForbidden(instance, rule, context);
    case 'layers':
      return evaluateLayers(instance, rule, context);
    case 'private':
      return evaluatePrivate(instance, rule, context);
    case 'no-cycles':
      return evaluateNoCycles(instance, rule, context);
  }
}

// User rules have repository scope. A `{ id, severity }` entry only changes a
// preset rule's severity, so it has no instance of its own; merging it into
// the preset instances is the config merge's job.
export function userRuleInstances(rules: RuleConfig[]): RuleInstance[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) throw new ConfigError(`Duplicate rule id: ${rule.id}`);
    seen.add(rule.id);
  }
  return rules.filter(isDefinition).map((rule) => ({
    rule,
    projectId: REPO_SCOPE,
    scopeFiles: 'repo',
    origin: 'user',
  }));
}

function isDefinition(rule: RuleConfig): rule is RuleDefinition {
  return 'type' in rule;
}

function compareViolations(left: Violation, right: Violation): number {
  return (
    compareText(left.from, right.from) ||
    (left.site?.line ?? 0) - (right.site?.line ?? 0) ||
    (left.site?.column ?? 0) - (right.site?.column ?? 0) ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.projectId, right.projectId) ||
    compareText(left.fingerprint, right.fingerprint)
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

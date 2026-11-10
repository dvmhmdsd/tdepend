import { compareSiteRecords, type SiteRecord } from '../graph/buildFileGraph';
import { globMatcher, targetFile } from './selectors';
import type { RuleInput, RuleInstance, Violation } from './types';

export interface RuleOutcome {
  violations: Violation[];
  warnings: string[];
}

// What every rule reads, computed once per evaluation.
export interface RuleContext {
  input: RuleInput;
  // Sites whose importing file is in scope, in file, line and column order.
  sitesIn(scope: RuleInstance['scopeFiles']): SiteRecord[];
  // Analysed files plus resolved targets outside the analysis (excluded files).
  knownFiles: string[];
}

export function createContext(input: RuleInput): RuleContext {
  const ordered = [...input.sites].sort(compareSiteRecords);
  const targets = input.sites.map(targetFile).filter((file): file is string => file !== null);
  return {
    input,
    sitesIn: (scope) =>
      scope === 'repo' ? ordered : ordered.filter((record) => scope.has(record.file)),
    knownFiles: [...new Set([...input.graph.files(), ...targets])].sort(),
  };
}

export function inScope(scope: RuleInstance['scopeFiles'], file: string): boolean {
  return scope === 'repo' || scope.has(file);
}

export function noMatchWarning(instance: RuleInstance, key: string, globs: string[]): string {
  return `rule ${instance.rule.id} matches no files: ${key} [${globs.join(', ')}]`;
}

// User rules warn when one of their glob lists matches no known file. Preset
// rules stay quiet: a preset ships rules for layouts a project may not have.
export function unmatchedGlobs(
  instance: RuleInstance,
  context: RuleContext,
  lists: Array<[key: string, globs: string[] | undefined]>,
): string[] {
  if (instance.origin !== 'user') return [];
  return lists.flatMap(([key, globs]) => {
    if (globs === undefined || globs.length === 0) return [];
    const matches = globMatcher(globs);
    return context.knownFiles.some(matches) ? [] : [noMatchWarning(instance, key, globs)];
  });
}

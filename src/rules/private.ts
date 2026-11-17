import { isBucket } from '../components/assignComponents';
import type { Group } from '../components/types';
import { noMatchWarning, type RuleContext, type RuleOutcome } from './context';
import { importViolation } from './identity';
import { globMatcher, targetFile } from './selectors';
import type { PrivateRule, RuleInstance } from './types';

// A private file of component C may only be imported by files in C. Globs are
// relative to the component's directory (a root bucket's is its project's).
// `paths` lists the private files; `public` lists the only files that aren't,
// and in that mode a root bucket is never private. Targets are resolved files,
// so an alias and a relative import of the same file are judged the same.
export function evaluatePrivate(
  instance: RuleInstance,
  rule: PrivateRule,
  context: RuleContext,
): RuleOutcome {
  const { componentOf } = context.input.assignment;
  const exceptFrom = globMatcher(rule.exceptFrom);
  const isPrivate = privacyTest(rule);
  const scopeFiles = [...componentOf.keys()].filter((file) => context.inScope(instance, file));
  const canBePrivate = scopeFiles.filter((file) => !isFileComponent(componentOf.get(file)!));
  const doesNothing = scopeFiles.length > 0 && canBePrivate.length === 0;

  const violations = context.sitesIn(instance).flatMap((record) => {
    const target = targetFile(record);
    const owner = target === null ? undefined : componentOf.get(target);
    const importer = componentOf.get(record.file);
    if (target === null || owner === undefined || importer === undefined) return [];
    if (owner.id === importer.id || isFileComponent(owner) || exceptFrom(record.file)) return [];
    return isPrivate(target, owner) ? [importViolation(instance, record, rule.message)] : [];
  });

  const warnings: string[] = [];
  if (doesNothing) {
    warnings.push(`rule ${rule.id}: \`private\` does nothing with the \`file\` component strategy`);
  }
  if (instance.origin === 'user' && rule.paths !== undefined && canBePrivate.length > 0) {
    const anyPrivate = canBePrivate.some((file) => isPrivate(file, componentOf.get(file)!));
    if (!anyPrivate) warnings.push(noMatchWarning(instance, 'paths', rule.paths));
  }
  return { violations, warnings };
}

function privacyTest(rule: PrivateRule): (file: string, owner: Group) => boolean {
  if (rule.paths !== undefined) {
    const matches = globMatcher(rule.paths);
    return (file, owner) => matches(pathWithinComponent(owner, file));
  }
  const isPublic = globMatcher(rule.public);
  return (file, owner) => !isBucket(owner) && !isPublic(pathWithinComponent(owner, file));
}

function pathWithinComponent(owner: Group, file: string): string {
  if (owner.directory === '') return file;
  const prefix = `${owner.directory}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

// With the file strategy every file is its own component, so nothing can be
// private to a component.
function isFileComponent(group: Group): boolean {
  return group.id.startsWith('file:');
}

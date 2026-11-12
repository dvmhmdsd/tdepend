import { isBucket } from '../components/assignComponents';
import type { Group } from '../components/types';
import { inScope, noMatchWarning, type RuleContext, type RuleOutcome } from './context';
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
  const scopeFiles = [...componentOf.keys()].filter((file) => inScope(instance.scopeFiles, file));
  // Files whose component can own private files at all.
  const checked = scopeFiles.filter((file) => !isFileComponent(componentOf.get(file)!));
  const perFile = checked.length < scopeFiles.length;

  const violations = context.sitesIn(instance.scopeFiles).flatMap((record) => {
    const target = targetFile(record);
    const owner = target === null ? undefined : componentOf.get(target);
    const importer = componentOf.get(record.file);
    if (target === null || owner === undefined || importer === undefined) return [];
    if (owner.id === importer.id || isFileComponent(owner) || exceptFrom(record.file)) return [];
    return isPrivate(target, owner) ? [importViolation(instance, record, rule.message)] : [];
  });

  const warnings: string[] = [];
  if (perFile) {
    warnings.push(`rule ${rule.id}: \`private\` does nothing with the \`file\` component strategy`);
  }
  if (instance.origin === 'user' && rule.paths !== undefined && checked.length > 0) {
    const anyPrivate = checked.some((file) => isPrivate(file, componentOf.get(file)!));
    if (!anyPrivate) warnings.push(noMatchWarning(instance, 'paths', rule.paths));
  }
  return { violations, warnings };
}

function privacyTest(rule: PrivateRule): (file: string, owner: Group) => boolean {
  if (rule.paths !== undefined) {
    const matches = globMatcher(rule.paths);
    return (file, owner) => matches(insideOf(owner, file));
  }
  const isPublic = globMatcher(rule.public);
  return (file, owner) => !isBucket(owner) && !isPublic(insideOf(owner, file));
}

// The file's path relative to its component's directory.
function insideOf(owner: Group, file: string): string {
  if (owner.directory === '') return file;
  const prefix = `${owner.directory}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

// With the file strategy every file is its own component, so nothing can be
// private to a component.
function isFileComponent(group: Group): boolean {
  return group.id.startsWith('file:');
}

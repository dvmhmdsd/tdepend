import { createHash } from 'node:crypto';

import type { SiteRecord } from '../graph/buildFileGraph';
import type { ImportSite } from '../parser/types';
import type {
  RuleDefinition,
  RuleInstance,
  SiteData,
  Violation,
  ViolationDraft,
  ViolationTarget,
} from './types';

// §9: what makes two findings "the same" across runs. Lines, columns and the
// message stay out, so editing above an import keeps its identity; severity
// is in, so raising `warn` to `error` is a new finding until it is accepted.
export function identityOf(violation: ViolationDraft): unknown[] {
  const head = [violation.ruleId, violation.projectId, violation.severity];
  switch (violation.kind) {
    case 'import':
      return [
        'import',
        ...head,
        violation.from,
        targetKey(violation.to),
        violation.site?.specifier ?? null,
      ];
    case 'cycle':
      return ['cycle', ...head, violation.witness?.level ?? null, violation.witness?.members ?? []];
    case 'coverage':
      return ['coverage', ...head, violation.from];
  }
}

function targetKey(target: ViolationTarget | undefined): string[] | null {
  if (target === undefined) return null;
  return 'file' in target ? ['file', target.file] : ['module', target.module];
}

export function fingerprint(identity: unknown[]): string {
  return createHash('sha1').update(JSON.stringify(identity)).digest('hex');
}

export function finishViolation(draft: ViolationDraft): Violation {
  const identity = identityOf(draft);
  return { ...draft, identity, fingerprint: fingerprint(identity) };
}

// A site as plain data, without the parser node, so a violation serialises.
export function siteData(site: ImportSite): SiteData {
  const { node: _node, ...data } = site;
  return data;
}

// `off` rules are never evaluated, so a rule that runs is `error` or `warn`.
export function severityOf(rule: RuleDefinition): 'error' | 'warn' {
  return rule.severity === 'warn' ? 'warn' : 'error';
}

// The finding for one import site: located at the site, pointing at its target.
export function importViolation(
  instance: RuleInstance,
  record: SiteRecord,
  message: string,
): Violation {
  return finishViolation({
    kind: 'import',
    ruleId: instance.rule.id,
    projectId: instance.projectId,
    severity: severityOf(instance.rule),
    message,
    from: record.file,
    to: record.resolution.target ?? undefined,
    site: siteData(record.site),
  });
}

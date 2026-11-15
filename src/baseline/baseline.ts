import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import { ConfigError, ParseError } from '../errors';
import type { Violation, ViolationTarget } from '../rules/types';

// The baseline has its own version, separate from the JSON export's.
const BASELINE_VERSION = 1;

const targetSchema = z.union([
  z.strictObject({ file: z.string() }),
  z.strictObject({ module: z.string(), workspace: z.boolean().optional() }),
]);

const entrySchema = z.strictObject({
  fingerprint: z.string().min(1),
  kind: z.enum(['import', 'cycle', 'coverage']),
  ruleId: z.string(),
  projectId: z.string(),
  severity: z.enum(['error', 'warn']),
  level: z.enum(['file', 'component', 'package']).optional(),
  from: z.string(),
  target: targetSchema.optional(),
  specifier: z.string().optional(),
  count: z.number().int().min(1),
  members: z.array(z.string()).optional(),
});

const fileSchema = z.strictObject({
  version: z.literal(BASELINE_VERSION),
  entries: z.array(entrySchema),
});

export type BaselineEntry = z.infer<typeof entrySchema>;
export type BaselineFile = z.infer<typeof fileSchema>;

export interface Comparison {
  actionable: Violation[];
  known: Violation[];
  noLongerReported: BaselineEntry[];
}

export function readBaseline(path: string): Map<string, BaselineEntry> {
  if (!existsSync(path)) throw new ConfigError(`Baseline file not found: ${path}`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ParseError(`Invalid JSON in ${path}: ${message}`, path);
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== BASELINE_VERSION) {
    throw new ConfigError(
      `Baseline ${path} has version ${JSON.stringify(version)}; this tdepend reads version ${BASELINE_VERSION}.`,
    );
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid baseline ${path}: ${issues.join('; ')}`);
  }
  return new Map(parsed.data.entries.map((entry) => [entry.fingerprint, entry]));
}

export function writeBaseline(path: string, violations: Violation[]): void {
  saveBaseline(path, toBaselineFile(violations));
}

export function saveBaseline(path: string, file: BaselineFile): void {
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

// One entry per identity, counting its occurrences.
export function toBaselineFile(violations: Violation[]): BaselineFile {
  const entries = new Map<string, BaselineEntry>();
  for (const violation of [...violations].sort(compareViolations)) {
    const existing = entries.get(violation.fingerprint);
    if (existing === undefined) entries.set(violation.fingerprint, entryOf(violation));
    else if (violation.kind !== 'cycle') existing.count += 1;
  }
  return { version: BASELINE_VERSION, entries: [...entries.values()].sort(compareEntries) };
}

// Up to `count` current violations with an entry's identity are known, the
// earliest by path, line and column; the rest are fresh. A cycle is known when
// its members are a subset of one cycle entry's under the same rule, project,
// level and severity.
export function compareWithBaseline(
  violations: Violation[],
  baseline: Map<string, BaselineEntry>,
): Comparison {
  const known: Violation[] = [];
  const actionable: Violation[] = [];
  const matches = new Map<string, number>();
  const cycleEntries = [...baseline.values()]
    .filter((entry) => entry.kind === 'cycle')
    .sort(compareEntries);

  for (const violation of [...violations].sort(compareViolations)) {
    const entry =
      violation.kind === 'cycle'
        ? coveringEntry(violation, cycleEntries)
        : baseline.get(violation.fingerprint);
    const used = entry === undefined ? 0 : (matches.get(entry.fingerprint) ?? 0);
    if (entry !== undefined && (entry.kind === 'cycle' || used < entry.count)) {
      matches.set(entry.fingerprint, used + 1);
      known.push(violation);
    } else {
      actionable.push(violation);
    }
  }

  const noLongerReported = [...baseline.values()]
    .filter((entry) => (matches.get(entry.fingerprint) ?? 0) < entry.count)
    .sort(compareEntries);
  return { actionable, known, noLongerReported };
}

// Never adds allowance: counts only fall, no identity appears that wasn't
// there, and a cycle entry is replaced by one entry per current group it still
// covers, never by their union.
export function pruneBaseline(
  baseline: Map<string, BaselineEntry>,
  violations: Violation[],
): BaselineFile {
  const counts = new Map<string, number>();
  const cycleEntries = [...baseline.values()]
    .filter((entry) => entry.kind === 'cycle')
    .sort(compareEntries);
  const entries = new Map<string, BaselineEntry>();

  for (const violation of [...violations].sort(compareViolations)) {
    if (violation.kind === 'cycle') {
      if (coveringEntry(violation, cycleEntries) !== undefined) {
        entries.set(violation.fingerprint, entryOf(violation));
      }
    } else if (baseline.has(violation.fingerprint)) {
      counts.set(violation.fingerprint, (counts.get(violation.fingerprint) ?? 0) + 1);
    }
  }
  for (const [fingerprint, current] of counts) {
    const entry = baseline.get(fingerprint)!;
    entries.set(fingerprint, { ...entry, count: Math.min(entry.count, current) });
  }
  return { version: BASELINE_VERSION, entries: [...entries.values()].sort(compareEntries) };
}

// Accepted debt that grew: an added identity or a raised count, a severity
// raised from warn to error, or a cycle entry not contained in one previous
// entry. Previous entries are never combined.
export function baselineGrowth(before: BaselineFile, after: BaselineFile): string[] {
  const previous = new Map(before.entries.map((entry) => [entry.fingerprint, entry]));
  const lines: string[] = [];

  for (const entry of [...after.entries].sort(compareEntries)) {
    if (entry.kind === 'cycle') {
      const containing = before.entries.filter(
        (old) =>
          old.kind === 'cycle' && sameGroupRule(old, entry) && contains(old, entry.members ?? []),
      );
      const covered = containing.some(
        (old) => old.severity === entry.severity || old.severity === 'error',
      );
      if (covered) continue;
      lines.push(
        containing.length > 0
          ? `severity raised from warn to error: ${describe(entry)}`
          : `cycle grew: ${describe(entry)}`,
      );
      continue;
    }

    const same = previous.get(entry.fingerprint);
    if (same !== undefined) {
      if (entry.count > same.count) {
        lines.push(`count raised from ${same.count} to ${entry.count}: ${describe(entry)}`);
      }
      continue;
    }
    const sibling = before.entries.find(
      (old) => old.kind === entry.kind && sameIdentityButSeverity(old, entry),
    );
    if (sibling === undefined) {
      lines.push(`added: ${describe(entry)}`);
    } else if (sibling.severity === 'warn' && entry.severity === 'error') {
      lines.push(`severity raised from warn to error: ${describe(entry)}`);
    } else if (entry.count > sibling.count) {
      lines.push(`count raised from ${sibling.count} to ${entry.count}: ${describe(entry)}`);
    }
  }
  return lines;
}

function coveringEntry(
  violation: Violation,
  cycleEntries: BaselineEntry[],
): BaselineEntry | undefined {
  const members = violation.witness?.members ?? [];
  return cycleEntries.find(
    (entry) =>
      entry.ruleId === violation.ruleId &&
      entry.projectId === violation.projectId &&
      entry.severity === violation.severity &&
      entry.level === violation.witness?.level &&
      contains(entry, members),
  );
}

function contains(entry: BaselineEntry, members: string[]): boolean {
  const own = new Set(entry.members ?? []);
  return members.every((member) => own.has(member));
}

function sameGroupRule(left: BaselineEntry, right: BaselineEntry): boolean {
  return (
    left.ruleId === right.ruleId && left.projectId === right.projectId && left.level === right.level
  );
}

function sameIdentityButSeverity(left: BaselineEntry, right: BaselineEntry): boolean {
  return (
    left.ruleId === right.ruleId &&
    left.projectId === right.projectId &&
    left.from === right.from &&
    targetText(left.target) === targetText(right.target) &&
    left.specifier === right.specifier
  );
}

function describe(entry: BaselineEntry): string {
  const head = `${entry.ruleId} ${entry.projectId}`;
  if (entry.kind === 'cycle') return `${head} ${entry.level} [${(entry.members ?? []).join(', ')}]`;
  if (entry.target === undefined) return `${head} ${entry.from}`;
  return `${head} ${entry.from} → ${targetText(entry.target)}`;
}

function entryOf(violation: Violation): BaselineEntry {
  const entry: BaselineEntry = {
    fingerprint: violation.fingerprint,
    kind: violation.kind,
    ruleId: violation.ruleId,
    projectId: violation.projectId,
    severity: violation.severity,
    from: violation.from,
    count: 1,
  };
  if (violation.kind === 'cycle') entry.level = violation.witness?.level;
  if (violation.to !== undefined) entry.target = violation.to;
  if (violation.kind === 'import' && violation.site !== undefined) {
    entry.specifier = violation.site.specifier;
  }
  if (violation.kind === 'cycle') entry.members = violation.witness?.members ?? [];
  return entry;
}

function targetText(target: ViolationTarget | undefined): string {
  if (target === undefined) return '';
  return 'file' in target ? target.file : target.module;
}

function compareEntries(left: BaselineEntry, right: BaselineEntry): number {
  return (
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.projectId, right.projectId) ||
    compareText(left.from, right.from) ||
    compareText(targetText(left.target), targetText(right.target)) ||
    compareText(left.fingerprint, right.fingerprint)
  );
}

function compareViolations(left: Violation, right: Violation): number {
  return (
    compareText(left.from, right.from) ||
    (left.site?.line ?? 0) - (right.site?.line ?? 0) ||
    (left.site?.column ?? 0) - (right.site?.column ?? 0) ||
    compareText(left.ruleId, right.ruleId) ||
    compareText(left.fingerprint, right.fingerprint)
  );
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  baselineGrowth,
  compareWithBaseline,
  pruneBaseline,
  readBaseline,
  toBaselineFile,
  writeBaseline,
  type BaselineEntry,
  type BaselineFile,
} from '../baseline/baseline';
import { ConfigError, ParseError } from '../errors';
import { finishViolation } from '../rules/identity';
import type { Violation } from '../rules/types';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name = 'tdepend-baseline.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-baseline-'));
  tempDirs.push(dir);
  return join(dir, name);
}

const PROJECT = 'proj:(repo)';

function importAt(
  from: string,
  line: number,
  options: { to?: string; severity?: 'error' | 'warn'; ruleId?: string; column?: number } = {},
): Violation {
  const to = options.to ?? 'src/db.ts';
  return finishViolation({
    kind: 'import',
    ruleId: options.ruleId ?? 'NO-DB',
    projectId: PROJECT,
    severity: options.severity ?? 'error',
    message: 'Not here.',
    from,
    to: { file: to },
    site: {
      specifier: './db',
      line,
      column: options.column ?? 20,
      kind: 'static',
      form: 'declaration',
      bindings: [],
    },
  });
}

function cycleOf(members: string[], severity: 'error' | 'warn' = 'error'): Violation {
  const [first, second] = members;
  return finishViolation({
    kind: 'cycle',
    ruleId: 'NO-CYCLE',
    projectId: PROJECT,
    severity,
    message: 'Import cycle.',
    from: first,
    to: { file: second },
    site: {
      specifier: `./${second}`,
      line: 1,
      column: 20,
      kind: 'static',
      form: 'declaration',
      bindings: [],
    },
    witness: { level: 'file', members, hops: [], optimal: true },
  });
}

function coverageOf(file: string): Violation {
  return finishViolation({
    kind: 'coverage',
    ruleId: 'components/coverage',
    projectId: PROJECT,
    severity: 'error',
    message: 'File belongs to no declared component.',
    from: file,
  });
}

const asMap = (file: BaselineFile): Map<string, BaselineEntry> =>
  new Map(file.entries.map((entry) => [entry.fingerprint, entry]));

const at = (violations: Violation[]): string[] =>
  violations.map((violation) => `${violation.from}:${violation.site?.line ?? '-'}`);

describe('compareWithBaseline: counts', () => {
  it('C=2 with count 1 gives 1 actionable, chosen deterministically by path/line/col', () => {
    const accepted = asMap(toBaselineFile([importAt('src/a.ts', 3)]));
    const current = [importAt('src/a.ts', 9), importAt('src/a.ts', 3, { column: 40 })];

    const comparison = compareWithBaseline(current, accepted);
    expect(at(comparison.known)).toEqual(['src/a.ts:3']);
    expect(at(comparison.actionable)).toEqual(['src/a.ts:9']);
    expect(compareWithBaseline([...current].reverse(), accepted)).toEqual(comparison);
  });

  it('noLongerReported lists entries with fewer matches than count', () => {
    const accepted = asMap(
      toBaselineFile([importAt('src/a.ts', 3), importAt('src/a.ts', 9), importAt('src/b.ts', 1)]),
    );
    const comparison = compareWithBaseline([importAt('src/a.ts', 4)], accepted);

    expect(at(comparison.known)).toEqual(['src/a.ts:4']);
    expect(comparison.actionable).toEqual([]);
    expect(comparison.noLongerReported.map((entry) => [entry.from, entry.count])).toEqual([
      ['src/a.ts', 2],
      ['src/b.ts', 1],
    ]);
  });

  it('a severity change is a fresh finding', () => {
    const accepted = asMap(toBaselineFile([importAt('src/a.ts', 3, { severity: 'warn' })]));
    const comparison = compareWithBaseline([importAt('src/a.ts', 3)], accepted);
    expect(at(comparison.actionable)).toEqual(['src/a.ts:3']);
  });
});

describe('compareWithBaseline: cycles', () => {
  const accepted = asMap(toBaselineFile([cycleOf(['a', 'b', 'c']), cycleOf(['x', 'y'])]));

  it('a subset is known; growth is fresh; a merge is fresh unless covered; an inner edge stays known', () => {
    const shrunk = cycleOf(['a', 'b']);
    const grown = cycleOf(['a', 'b', 'c', 'd']);
    const merged = cycleOf(['a', 'b', 'c', 'x', 'y']);
    // Same members with an extra edge inside is the same identity.
    const innerEdge = cycleOf(['x', 'y']);

    const comparison = compareWithBaseline([shrunk, grown, merged, innerEdge], accepted);
    const groups = (cycles: Violation[]) =>
      cycles.map((cycle) => cycle.witness?.members.join(' ')).sort();
    expect(groups(comparison.known)).toEqual(['a b', 'x y']);
    expect(groups(comparison.actionable)).toEqual(['a b c d', 'a b c x y']);

    const wide = asMap(toBaselineFile([cycleOf(['a', 'b', 'c', 'x', 'y'])]));
    expect(compareWithBaseline([merged], wide).known).toEqual([merged]);
  });

  it('one entry covers a split into several groups; an entry covering nothing is no longer reported', () => {
    const comparison = compareWithBaseline(
      [cycleOf(['a', 'b']), cycleOf(['c', 'd'])],
      asMap(toBaselineFile([cycleOf(['a', 'b', 'c', 'd'])])),
    );
    expect(comparison.known).toHaveLength(2);
    expect(comparison.noLongerReported).toEqual([]);

    const gone = compareWithBaseline([], accepted);
    expect(gone.noLongerReported.map((entry) => entry.members)).toEqual([
      ['a', 'b', 'c'],
      ['x', 'y'],
    ]);
  });

  it('a cycle at another severity is not covered', () => {
    expect(compareWithBaseline([cycleOf(['a', 'b'], 'warn')], accepted).actionable).toHaveLength(1);
  });
});

describe('writeBaseline and readBaseline', () => {
  it('writeBaseline is sorted and stable', () => {
    const violations = [
      importAt('src/b.ts', 1),
      cycleOf(['a', 'b']),
      importAt('src/a.ts', 5, { ruleId: 'ALPHA' }),
      importAt('src/a.ts', 2),
      importAt('src/a.ts', 7),
    ];
    const first = tempFile();
    const second = tempFile();
    writeBaseline(first, violations);
    writeBaseline(second, [...violations].reverse());

    const text = readFileSync(first, 'utf-8');
    expect(readFileSync(second, 'utf-8')).toBe(text);
    expect(text.endsWith('\n')).toBe(true);
    const file = JSON.parse(text) as BaselineFile;
    expect(file.version).toBe(1);
    expect(file.entries.map((entry) => [entry.ruleId, entry.from, entry.count])).toEqual([
      ['ALPHA', 'src/a.ts', 1],
      ['NO-CYCLE', 'a', 1],
      ['NO-DB', 'src/a.ts', 2],
      ['NO-DB', 'src/b.ts', 1],
    ]);
    expect(file.entries[2]).toEqual({
      fingerprint: importAt('src/a.ts', 2).fingerprint,
      kind: 'import',
      ruleId: 'NO-DB',
      projectId: PROJECT,
      severity: 'error',
      from: 'src/a.ts',
      target: { file: 'src/db.ts' },
      specifier: './db',
      count: 2,
    });
    expect(file.entries[1]).toMatchObject({ kind: 'cycle', level: 'file', members: ['a', 'b'] });
  });

  it('a coverage entry round-trips without target or specifier', () => {
    const path = tempFile();
    writeBaseline(path, [coverageOf('src/orphan.ts')]);
    const [entry] = readBaseline(path).values();

    expect(entry).toEqual({
      fingerprint: coverageOf('src/orphan.ts').fingerprint,
      kind: 'coverage',
      ruleId: 'components/coverage',
      projectId: PROJECT,
      severity: 'error',
      from: 'src/orphan.ts',
      count: 1,
    });
    expect(
      compareWithBaseline([coverageOf('src/orphan.ts')], readBaseline(path)).known,
    ).toHaveLength(1);
  });

  it('a file with version 2 (or any other) is a ConfigError', () => {
    const path = tempFile();
    for (const version of [2, 0, '1']) {
      writeFileSync(path, JSON.stringify({ version, entries: [] }));
      expect(() => readBaseline(path)).toThrow(ConfigError);
    }
    writeFileSync(path, JSON.stringify({ version: 2, entries: [] }));
    expect(() => readBaseline(path)).toThrow(
      `Baseline ${path} has version 2; this tdepend reads version 1.`,
    );
  });

  it('a missing file, bad JSON or a malformed entry exits 2', () => {
    const path = tempFile();
    expect(() => readBaseline(path)).toThrow(`Baseline file not found: ${path}`);
    writeFileSync(path, '{');
    expect(() => readBaseline(path)).toThrow(ParseError);
    writeFileSync(path, JSON.stringify({ version: 1, entries: [{ fingerprint: 'x' }] }));
    expect(() => readBaseline(path)).toThrow(ConfigError);
  });
});

describe('pruneBaseline', () => {
  it('lowers counts, drops unmatched, splits a cycle entry per covered group, never raises', () => {
    const before = toBaselineFile([
      importAt('src/a.ts', 1),
      importAt('src/a.ts', 2),
      importAt('src/b.ts', 1),
      cycleOf(['a', 'b', 'c', 'd']),
    ]);
    const current = [
      importAt('src/a.ts', 5),
      importAt('src/c.ts', 1),
      cycleOf(['a', 'b']),
      cycleOf(['c', 'd']),
      cycleOf(['a', 'e']),
    ];
    const after = pruneBaseline(asMap(before), current);

    expect(
      after.entries.map((entry) => [entry.kind, entry.from, entry.count, entry.members]),
    ).toEqual([
      ['cycle', 'a', 1, ['a', 'b']],
      ['cycle', 'c', 1, ['c', 'd']],
      ['import', 'src/a.ts', 1, undefined],
    ]);

    const more = [importAt('src/a.ts', 5), importAt('src/a.ts', 6), importAt('src/a.ts', 7)];
    expect(pruneBaseline(asMap(before), more).entries.map((entry) => entry.count)).toEqual([2]);
  });

  it('a group covered by two entries makes one entry', () => {
    const before = toBaselineFile([cycleOf(['a', 'b', 'c']), cycleOf(['a', 'b', 'd'])]);
    const after = pruneBaseline(asMap(before), [cycleOf(['a', 'b'])]);
    expect(after.entries.map((entry) => entry.members)).toEqual([['a', 'b']]);
  });
});

describe('baselineGrowth', () => {
  const before = toBaselineFile([
    importAt('src/a.ts', 1),
    importAt('src/w.ts', 1, { severity: 'warn' }),
    cycleOf(['a', 'b', 'c']),
  ]);

  it('reports added entries, raised counts, raised severities, a merged cycle and an added member', () => {
    const after = toBaselineFile([
      importAt('src/a.ts', 1),
      importAt('src/a.ts', 2),
      importAt('src/new.ts', 1),
      importAt('src/w.ts', 1),
      cycleOf(['a', 'b', 'c']),
      cycleOf(['a', 'b', 'c', 'd']),
      cycleOf(['a', 'x']),
    ]);

    expect(baselineGrowth(before, after)).toEqual([
      'cycle grew: NO-CYCLE proj:(repo) file [a, b, c, d]',
      'cycle grew: NO-CYCLE proj:(repo) file [a, x]',
      'count raised from 1 to 2: NO-DB proj:(repo) src/a.ts → src/db.ts',
      'added: NO-DB proj:(repo) src/new.ts → src/db.ts',
      'severity raised from warn to error: NO-DB proj:(repo) src/w.ts → src/db.ts',
    ]);
  });

  it('a cycle contained in one previous entry is not growth; a lowered severity is not growth', () => {
    const after = toBaselineFile([
      importAt('src/a.ts', 1, { severity: 'warn' }),
      cycleOf(['a', 'b']),
      cycleOf(['b', 'c']),
    ]);
    expect(baselineGrowth(before, after)).toEqual([]);
  });

  it('baselineGrowth(before, pruneBaseline(before, current)) is empty for a shrink and a split', () => {
    const shrink = [importAt('src/a.ts', 9), cycleOf(['a', 'b'])];
    const split = [
      cycleOf(['a', 'b']),
      cycleOf(['b', 'c']),
      importAt('src/w.ts', 2, { severity: 'warn' }),
    ];
    const grown = [
      importAt('src/a.ts', 9),
      importAt('src/a.ts', 10),
      cycleOf(['a', 'b', 'c', 'd']),
    ];

    for (const current of [shrink, split, grown]) {
      expect(baselineGrowth(before, pruneBaseline(asMap(before), current))).toEqual([]);
    }
  });
});

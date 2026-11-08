import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseFile } from '../parser/extractSites';
import type { ParsedFile } from '../parser/types';
import { buildSymbolIndex, type HeritageRef } from '../symbols/symbolIndex';
import { FIXTURES, buildFixtureParts } from './helpers/fixtureGraph';

type DeclarationRow = [string, string, boolean];
type HeritageRow = [string, string, string, string | null, string?];

interface ExpectedSymbols {
  declarations: Record<string, DeclarationRow[]>;
  heritage: HeritageRow[];
  excludedHeritage: HeritageRow[];
}

const ROOT = join(FIXTURES, 'heritage');
const expected = JSON.parse(
  readFileSync(join(ROOT, 'expected-symbols.json'), 'utf-8'),
) as ExpectedSymbols;

function buildHeritage() {
  const parts = buildFixtureParts('heritage');
  const excluded = new Map<string, ParsedFile>();
  for (const { file, reason } of parts.files.skipped) {
    if (reason !== 'excluded') continue;
    const absolute = join(ROOT, file);
    const options = parts.ctx.optionsFor(file).options;
    excluded.set(file, parseFile(file, readFileSync(absolute, 'utf-8'), options, absolute));
  }
  const index = buildSymbolIndex(parts.graph, parts.parsed, parts.resolver, { excluded });
  return { ...parts, index };
}

const { index, sites, graph } = buildHeritage();

function row(ref: HeritageRef): HeritageRow {
  const resolved = ref.resolved?.id ?? null;
  return ref.unresolvedReason === undefined
    ? [ref.from.id, ref.clause, ref.name, resolved]
    : [ref.from.id, ref.clause, ref.name, resolved, ref.unresolvedReason];
}

const refsFrom = (id: string): HeritageRef[] =>
  index.heritage().filter((ref) => ref.from.id === id);

describe('symbol index: declarations', () => {
  it('heritage fixture: declarations match expected-symbols.json', () => {
    const actual = Object.fromEntries(
      graph
        .files()
        .map((file) => [
          file,
          index.declarations(file).map((d): DeclarationRow => [d.name, d.kind, d.exported]),
        ]),
    );

    expect(actual).toEqual(expected.declarations);
  });

  it('gives each declaration a file#name id', () => {
    const [format] = index.declarations('src/functions.ts').filter((d) => d.name === 'format');

    expect(format).toEqual({
      id: 'src/functions.ts#format',
      file: 'src/functions.ts',
      name: 'format',
      kind: 'function',
      exported: true,
    });
  });

  it('a class in an excluded file is not in the index', () => {
    expect(index.declarations('src/contract.spec.ts')).toEqual([]);
    expect(index.heritage().some((ref) => ref.from.file === 'src/contract.spec.ts')).toBe(false);
    expect(index.excludedHeritage().map(row)).toEqual(expected.excludedHeritage);
  });
});

describe('symbol index: heritage', () => {
  it('heritage fixture: every reference resolves as expected-symbols.json says', () => {
    expect(index.heritage().map(row)).toEqual(expected.heritage);
    expect(index.unresolvedHeritageCount).toBe(5);
  });

  it('implements through a named re-export barrel resolves', () => {
    expect(refsFrom('src/order-repository.ts#OrderRepository')[0].resolved?.id).toBe(
      'src/repository.ts#Repository',
    );
  });

  it('implements through import type and an export type barrel resolves with zero unresolved heritage; those sites have loadsTarget false', () => {
    const refs = refsFrom('src/adapter.ts#Adapter');
    const barrelSites = sites.filter(
      (record) => record.file === 'src/adapter.ts' || record.file === 'src/types.ts',
    );

    expect(refs.map(row)).toEqual([
      ['src/adapter.ts#Adapter', 'implements', 'Port', 'src/contract.ts#Port'],
    ]);
    expect(barrelSites).toHaveLength(3);
    expect(barrelSites.every((record) => record.site.loadsTarget === false)).toBe(true);
  });

  it('a type-context import("./x").T is not a binding and is not followed', () => {
    const [ref] = refsFrom('src/type-context.ts#Indirect');

    expect(ref.resolved?.id).toBe('src/type-context.ts#ViaImport');
    expect(index.exports('src/type-context.ts').map((info) => info.name)).toEqual([
      'Indirect',
      'ViaImport',
    ]);
  });

  it('export * is followed only when exactly one source declares the name; otherwise unresolved ambiguous', () => {
    expect(row(refsFrom('src/ambiguous.ts#Single')[0])[3]).toBe('src/contract.ts#Port');
    expect(row(refsFrom('src/ambiguous.ts#Twin')[0])).toEqual([
      'src/ambiguous.ts#Twin',
      'implements',
      'Dup',
      null,
      'ambiguous',
    ]);
    expect(index.resolveExport('src/stars.ts', 'Dup')).toBeNull();
  });

  it('cyclic barrels terminate', () => {
    expect(index.resolveExport('src/cycle-a.ts', 'Found')?.id).toBe('src/cycle-b.ts#Found');
    expect(index.resolveExport('src/cycle-a.ts', 'Nowhere')).toBeNull();
    expect(index.exports('src/cycle-a.ts').map((info) => info.name)).toEqual(['Found']);
  });

  it('an external heritage reference is unresolved external', () => {
    expect(row(refsFrom('src/external.ts#Emitter')[0])[4]).toBe('external');
    expect(row(refsFrom('src/external.ts#Failure')[0])[4]).toBe('external');
  });

  it('a call in a heritage clause is unresolved computed; a namespace member resolves', () => {
    expect(row(refsFrom('src/external.ts#Mixed')[0])[4]).toBe('computed');
    expect(refsFrom('src/external.ts#Qualified')[0].resolved?.id).toBe('src/shapes.ts#Readable');
  });

  it('follows interface ancestry as its own reference and an alias to its interface', () => {
    expect(refsFrom('src/shapes.ts#Stream')[0].resolved?.id).toBe('src/shapes.ts#Readable');
    expect(refsFrom('src/streams.ts#AliasSource')[0].resolved?.id).toBe('src/shapes.ts#Readable');
  });
});

describe('symbol index: exports', () => {
  it('resolveExport follows export { a as b } from renames', () => {
    expect(index.resolveExport('src/named-barrel.ts', 'Repo')?.id).toBe(
      'src/repository.ts#Repository',
    );
    expect(index.resolveExport('src/types.ts', 'Box')?.id).toBe('src/contract.ts#Shape');
    expect(index.resolveExport('src/default-class.ts', 'default')?.id).toBe(
      'src/default-class.ts#Service',
    );
    expect(index.resolveExport('src/types.ts', 'Shape')).toBeNull();
  });

  it('exports() reports isAsyncFunction for async function declarations and async arrow consts only', () => {
    const rows = index
      .exports('src/functions.ts')
      .map((info) => [info.name, info.declaration?.id, info.isAsyncFunction]);

    expect(rows).toEqual([
      ['fetchAll', 'src/functions.ts#fetchAll', true],
      ['fetchOne', 'src/functions.ts#fetchOne', false],
      ['format', 'src/functions.ts#format', false],
      ['helper', 'src/functions.ts#helper', false],
      ['load', 'src/functions.ts#load', true],
      ['renamed', 'src/functions.ts#internal', false],
      ['sync', 'src/functions.ts#sync', false],
    ]);
  });

  it('exports() lists re-exports with their source and expands export * without ambiguous names', () => {
    const rows = index
      .exports('src/stars.ts')
      .map((info) => [info.name, info.declaration?.id, info.reexportFrom]);

    expect(rows).toEqual([
      ['Clock', 'src/contract.ts#Clock', './contract'],
      ['Port', 'src/contract.ts#Port', './contract'],
      ['Shape', 'src/contract.ts#Shape', './contract'],
    ]);
    expect(index.exports('src/types.ts').map((info) => [info.name, info.reexportFrom])).toEqual([
      ['Box', './contract'],
      ['Port', './contract'],
    ]);
  });

  it('an anonymous default export is one concrete declaration', () => {
    expect(index.exports('src/default-expression.ts')).toEqual([
      {
        name: 'default',
        declaration: index.declarations('src/default-expression.ts')[0],
        isAsyncFunction: false,
      },
    ]);
  });

  it('a file outside the index has no declarations and no exports', () => {
    expect(index.declarations('src/missing.ts')).toEqual([]);
    expect(index.exports('src/missing.ts')).toEqual([]);
    expect(index.resolveExport('src/missing.ts', 'x')).toBeNull();
  });
});

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { fileCycleGraph, findCycles } from '../cycles/findCycles';
import type { BuildGraphResult } from '../graph/buildFileGraph';
import { eraseTypeReexports } from '../graph/eraseTypeReexports';
import type { Compiler } from '../parser/loadsTarget';
import { buildSymbolIndex } from '../symbols/symbolIndex';
import { FIXTURES, buildFixtureParts } from './helpers/fixtureGraph';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdepend-reexports-'));
  tempDirs.push(dir);
  for (const [rel, content] of Object.entries({ 'package.json': '{}', ...files })) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

interface Built {
  before: BuildGraphResult;
  after: BuildGraphResult;
  beforeId: string;
}

function erase(name: string, compilers: Compiler[], root?: string): Built {
  const parts = buildFixtureParts(name, { compilers, root });
  const before: BuildGraphResult = {
    graph: parts.graph,
    sites: parts.sites,
    report: parts.report,
    parsed: parts.parsed,
  };
  const beforeId = parts.graph.id;
  const index = buildSymbolIndex(parts.graph, parts.parsed, parts.sites);
  return { before, after: eraseTypeReexports(before, index, compilers), beforeId };
}

const loads = (result: BuildGraphResult, file: string): boolean[] =>
  result.sites
    .filter((record) => record.file === file)
    .map((record) => record.site.loadsTarget === true);

const TSC: Compiler[] = ['tsc'];

const DEP = [
  'export interface T { readonly t: string }',
  'export type Alias = { readonly alias: string };',
  'export class Klass {}',
  "export const enum Status { A = 'a' }",
  "export const Shape = { kind: 'shape' };",
  'export type Shape = typeof Shape;',
  'export const used = 1;',
].join('\n');

describe('eraseTypeReexports', () => {
  it("compilers ['tsc']: export { T } from './x' with T an interface or a type alias is erased", () => {
    const { after } = erase('compiler-elision', TSC);
    expect(loads(after, 'case-12-unmarked-reexport.ts')).toEqual([false]);
    expect(loads(after, 'case-44-reexport-type-alias.ts')).toEqual([false]);

    const [record] = after.sites.filter((site) => site.file === 'case-44-reexport-type-alias.ts');
    expect(record.site.loadsTargetBy).toBe('symbols');
    expect(record.site.loadReason).toBe(
      're-exports only types, and tsc is the only compiler, so tsc erases it',
    );
  });

  it('a mixed list, a class, an enum, a const enum, a merged const and type, and an unresolved name stay loading', () => {
    const { after } = erase('compiler-elision', TSC);
    for (const file of [
      'case-45-reexport-mixed.ts',
      'case-46-reexport-class.ts',
      'case-47-reexport-enum.ts',
    ]) {
      expect(loads(after, file)).toEqual([true]);
    }

    const root = tempProject({
      'src/dep.ts': DEP,
      'src/status.ts': "export { Status } from './dep';",
      'src/shape.ts': "export { Shape } from './dep';",
      'src/missing.ts': "export { Nope } from './dep';",
      'src/outside.ts': "export { Thing } from 'left-pad';",
    });
    const temp = erase('', TSC, root).after;
    for (const file of ['src/status.ts', 'src/shape.ts', 'src/missing.ts', 'src/outside.ts']) {
      expect(loads(temp, file)).toEqual([true]);
    }
  });

  it("import { T } from './x'; export { T } erases the import when T is a type with no other value use", () => {
    expect(loads(erase('compiler-elision', TSC).after, 'case-50-import-then-export.ts')).toEqual([
      false,
    ]);

    const root = tempProject({
      'src/dep.ts': DEP,
      'src/also-value.ts':
        "import { T, used } from './dep';\nexport { T };\nexport const n = used;",
      'src/class.ts': "import { Klass } from './dep';\nexport { Klass };",
      'src/value-use.ts': "import { T } from './dep';\nexport { T };\nexport const t = T;",
    });
    const temp = erase('', TSC, root).after;
    for (const file of ['src/also-value.ts', 'src/class.ts', 'src/value-use.ts']) {
      expect(loads(temp, file)).toEqual([true]);
    }
  });

  it('a name marked `type` in the clause counts as a type whatever it names', () => {
    expect(loads(erase('compiler-elision', TSC).after, 'case-52-reexport-inline-type.ts')).toEqual([
      false,
    ]);
  });

  it('a re-export in a JavaScript file, or under verbatimModuleSyntax, keeps loading', () => {
    const js = tempProject({
      'src/dep.ts': DEP,
      'src/barrel.js': "export { T } from './dep';",
      'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true }, include: ['src'] }),
    });
    expect(loads(erase('', TSC, js).after, 'src/barrel.js')).toEqual([true]);

    const verbatim = tempProject({
      'src/dep.ts': DEP,
      'src/barrel.ts': "export { T } from './dep';",
      'src/reexported.ts': "import { T } from './dep';\nexport { T };",
      'tsconfig.json': JSON.stringify({
        compilerOptions: { verbatimModuleSyntax: true, module: 'esnext' },
        include: ['src'],
      }),
    });
    const after = erase('', TSC, verbatim).after;
    expect(loads(after, 'src/barrel.ts')).toEqual([true]);
    expect(loads(after, 'src/reexported.ts')).toEqual([true]);
  });

  it("the default compilers and ['tsc', 'esbuild'] keep every case loading", () => {
    for (const compilers of [
      ['tsc', 'esbuild', 'swc'],
      ['tsc', 'esbuild'],
    ] as Compiler[][]) {
      const { before, after } = erase('compiler-elision', compilers);
      expect(after).toBe(before);
      expect(loads(after, 'case-12-unmarked-reexport.ts')).toEqual([true]);
    }
  });

  it('edge runtime flags and the graph id are recomputed; a barrel cycle closed only by type re-exports leaves the runtime cycles', () => {
    const root = tempProject({
      'src/a.ts':
        "import { b } from './b';\nexport interface AType { readonly a: string }\nexport const a = b;",
      'src/b.ts': "export { AType } from './a';\nexport const b = 1;",
    });
    const { after, beforeId } = erase('', TSC, root);
    const back = after.graph.edges().find((edge) => edge.from === 'src/b.ts');
    expect(back?.runtime).toBe(false);
    expect(after.graph.id).not.toBe(beforeId);

    const cycles = (ignoreTypeOnly: boolean) =>
      findCycles(
        {
          level: 'file',
          graphId: after.graph.id,
          scopeId: 'repo',
          ...fileCycleGraph(after.graph, after.sites),
        },
        { ignoreTypeOnly, ignoreLazyImports: false },
      );
    expect(cycles(true)).toEqual([]);
    expect(cycles(false)).toHaveLength(1);
  });

  it('every new compiler-elision case matches the recorded tsc program verdict', () => {
    const { after } = erase('compiler-elision', TSC);
    const dir = join(FIXTURES, 'compiler-elision');
    const cases = readdirSync(dir)
      .filter((name) => name.endsWith('.expected.json'))
      .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf-8')))
      .filter((entry) => entry.id === 'case-12' || Number(entry.id.slice(5)) >= 44);

    expect(cases).toHaveLength(10);
    for (const entry of cases) {
      expect([entry.id, loads(after, entry.file)]).toEqual([entry.id, [entry.tscProgram]]);
    }
  });
});

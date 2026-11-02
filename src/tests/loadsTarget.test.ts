import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseFile } from '../parser/extractSites';
import { classifyLoads, type Compiler } from '../parser/loadsTarget';
import type { ImportSite, ParsedFile } from '../parser/types';

const FIXTURE = join(process.cwd(), 'src', 'tests', 'fixtures', 'compiler-elision');
const DEFAULT_COMPILERS: Compiler[] = ['tsc', 'esbuild', 'swc'];

interface Expectation {
  id: string;
  slug: string;
  file: string;
  options: Record<string, unknown>;
  tsc: boolean;
  tscProgram?: boolean;
  esbuild: boolean;
  swc: boolean;
  conservative: boolean;
  loadsTarget: boolean;
}

function loadExpectations(): Expectation[] {
  return readdirSync(FIXTURE)
    .filter((name) => name.endsWith('.expected.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf-8')) as Expectation);
}

const expectations = loadExpectations();
const bySlug = new Map(expectations.map((entry) => [entry.slug, entry]));

function optionsFrom(raw: Record<string, unknown>): ts.CompilerOptions {
  const options: ts.CompilerOptions = {};
  if (raw.verbatimModuleSyntax === true) options.verbatimModuleSyntax = true;
  if (raw.preserveValueImports === true) options.preserveValueImports = true;
  if (raw.importsNotUsedAsValues === 'preserve') {
    options.importsNotUsedAsValues = ts.ImportsNotUsedAsValues.Preserve;
  }
  if (raw.experimentalDecorators === true) options.experimentalDecorators = true;
  if (raw.emitDecoratorMetadata === true) options.emitDecoratorMetadata = true;
  if (raw.jsx === 'react') options.jsx = ts.JsxEmit.React;
  if (raw.module === 'nodenext') {
    options.module = ts.ModuleKind.NodeNext;
    options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
  }
  return options;
}

function entryFor(slug: string): Expectation {
  const entry = bySlug.get(slug);
  if (entry === undefined) throw new Error(`no compiler-elision case "${slug}"`);
  return entry;
}

function parsedCase(slug: string): {
  parsed: ParsedFile;
  site: ImportSite;
  options: ts.CompilerOptions;
} {
  const entry = entryFor(slug);
  const options = optionsFrom(entry.options);
  const text = readFileSync(join(FIXTURE, entry.file), 'utf-8');
  const parsed = parseFile(entry.file, text, options);
  const site = parsed.sites.find(
    (candidate) => candidate.specifier === './dep' && candidate.unsupported === undefined,
  );
  if (site === undefined) throw new Error(`no ./dep import site in ${entry.file}`);
  return { parsed, site, options };
}

function classify(
  slug: string,
  overrides: { typeOnly?: 'usage' | 'syntax'; compilers?: Compiler[] } = {},
) {
  const { parsed, site, options } = parsedCase(slug);
  return classifyLoads(
    parsed,
    site,
    options,
    overrides.typeOnly ?? 'usage',
    overrides.compilers ?? DEFAULT_COMPILERS,
  );
}

describe('compiler-elision fixture', () => {
  for (const entry of expectations) {
    it(`${entry.id} ${entry.slug} matches its recorded expectation`, () => {
      const verdict = classify(entry.slug);
      const anyCompilerKeeps = entry.tsc || entry.esbuild || entry.swc;

      expect(verdict.loadsTarget).toBe(entry.loadsTarget);
      expect(verdict.reason.length).toBeGreaterThan(0);

      // The runtime-load contract: never erase a module any compiler evaluates.
      if (anyCompilerKeeps) expect(verdict.loadsTarget).toBe(true);
      if (!entry.conservative) expect(verdict.loadsTarget).toBe(anyCompilerKeeps);
    });
  }
});

describe('classifyLoads rules', () => {
  it('erases a whole-declaration type import by syntax', () => {
    for (const slug of ['import-type', 'export-type']) {
      const verdict = classify(slug);
      expect(verdict.loadsTarget).toBe(false);
      expect(verdict.loadsTargetBy).toBe('syntax');
    }
  });

  it('erases type-context import sites by syntax', () => {
    for (const slug of ['type-context-import', 'type-context-typeof']) {
      const verdict = classify(slug);
      expect(verdict.loadsTarget).toBe(false);
      expect(verdict.loadsTargetBy).toBe('syntax');
    }
  });

  it('erases inline type modifiers without verbatimModuleSyntax and retains them with it', () => {
    expect(classify('inline-type').loadsTarget).toBe(false);
    expect(classify('inline-type-verbatim').loadsTarget).toBe(true);
    expect(classify('inline-type-verbatim').loadsTargetBy).toBe('retained');
  });

  it('an empty import {} from loads because swc keeps it', () => {
    const entry = entryFor('empty-import');
    expect([entry.tsc, entry.esbuild, entry.swc]).toEqual([false, false, true]);
    expect(classify('empty-import').loadsTarget).toBe(true);
  });

  it('an empty export {} from is erased in .ts, retained with verbatim, and retained in .mjs', () => {
    expect(classify('empty-export').loadsTarget).toBe(false);
    expect(classify('empty-export-verbatim').loadsTarget).toBe(true);
    expect(classify('empty-export-mjs').loadsTarget).toBe(true);
  });

  it('a shadowed local name is conservative and loads', () => {
    expect(entryFor('shadowed-name').conservative).toBe(true);
    expect(classify('shadowed-name').loadsTarget).toBe(true);
  });

  it('compilers: ["tsc"] erases an empty import but keeps an unmarked re-export', () => {
    expect(classify('empty-import').loadsTarget).toBe(true);
    expect(classify('empty-import', { compilers: ['tsc'] }).loadsTarget).toBe(false);
    // The parser cannot tell `export { T } from` of a type from one of a value,
    // and tsc keeps the value form, so the site stays loading until the symbol
    // index exists (0.4.0).
    expect(classify('unmarked-reexport').loadsTarget).toBe(true);
    expect(classify('unmarked-reexport', { compilers: ['tsc'] }).loadsTarget).toBe(true);
  });

  it('erases an unused import by usage and loads a used-as-value import', () => {
    const unused = classify('unused-import');
    expect(unused.loadsTarget).toBe(false);
    expect(unused.loadsTargetBy).toBe('usage');
    expect(classify('used-value').loadsTarget).toBe(true);
  });

  it('a binding used only as a type is erased; a mixed site loads', () => {
    expect(classify('type-only-usage').loadsTarget).toBe(false);
    expect(classify('mixed-usage').loadsTarget).toBe(true);
  });

  it('a decorated constructor parameter type loads under emitDecoratorMetadata; without it, erased', () => {
    expect(classify('decorator-metadata').loadsTarget).toBe(true);
    expect(classify('no-decorator-metadata').loadsTarget).toBe(false);
  });

  it('decorator metadata on an interface is conservative and still loads under compilers: ["tsc"]', () => {
    const entry = entryFor('decorator-metadata');
    expect(entry.conservative).toBe(true);
    expect(entry.tscProgram).toBe(false);
    expect(classify('decorator-metadata', { compilers: ['tsc'] }).loadsTarget).toBe(true);
  });

  it('a parameter decorator alone emits metadata for the method or constructor', () => {
    for (const slug of ['decorator-param-only', 'decorator-ctor-param-only']) {
      expect(entryFor(slug).tsc).toBe(true);
      expect(classify(slug).loadsTarget).toBe(true);
    }
  });

  it('metadata records only the leftmost type name, so a generic argument is erased', () => {
    expect(entryFor('decorator-generic-arg').tsc).toBe(false);
    expect(classify('decorator-generic-arg').loadsTarget).toBe(false);
  });

  it('an instantiation expression is a value use', () => {
    expect(classify('instantiation-expression').loadsTarget).toBe(true);
  });

  it('retains an unmarked export { T } from and erases export type { T } from', () => {
    expect(classify('unmarked-reexport').loadsTarget).toBe(true);
    expect(classify('export-type').loadsTarget).toBe(false);
  });

  it('a const enum member use loads; ns.Foo in a type does not; ns.bar() does', () => {
    expect(classify('const-enum').loadsTarget).toBe(true);
    expect(classify('namespace-type').loadsTarget).toBe(false);
    expect(classify('namespace-value').loadsTarget).toBe(true);
  });

  it('static sites in a .js file and under preserveValueImports always load', () => {
    expect(classify('js-static').loadsTarget).toBe(true);
    expect(classify('preserve-value-imports').loadsTarget).toBe(true);
  });

  it('retains a static site under verbatimModuleSyntax', () => {
    expect(classify('verbatim-static').loadsTarget).toBe(true);
  });

  it('retains a classic JSX factory import that is otherwise unused', () => {
    expect(classify('classic-jsx').loadsTarget).toBe(true);
  });

  it('retains a namespace re-export, side-effect and dynamic import', () => {
    for (const slug of ['reexport-star', 'side-effect', 'dynamic-import']) {
      expect(classify(slug).loadsTarget).toBe(true);
    }
  });

  it('typeOnly: "syntax" makes every static site load', () => {
    for (const slug of ['unused-import', 'type-only-usage', 'namespace-type']) {
      expect(classify(slug, { typeOnly: 'syntax' }).loadsTarget).toBe(true);
    }
    expect(classify('unused-import', { typeOnly: 'syntax' }).loadsTargetBy).toBe('retained');
  });

  it('preservesUnused via importsNotUsedAsValues: preserve keeps a static import', () => {
    const parsed = parseFile('src/a.ts', `import { used } from './dep';\n`, {
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Preserve,
    });
    const verdict = classifyLoads(
      parsed,
      parsed.sites[0],
      { importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Preserve },
      'usage',
      DEFAULT_COMPILERS,
    );

    expect(verdict.loadsTarget).toBe(true);
  });
});

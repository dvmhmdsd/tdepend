import { describe, expect, it } from 'vitest';

import { parseFile } from '../../next/parser/extractSites';
import type { ImportSite } from '../../next/parser/types';

function sitesOf(text: string, file = 'src/a.ts'): ImportSite[] {
  return parseFile(file, text, {}).sites;
}

function only(text: string, file = 'src/a.ts'): ImportSite {
  const sites = sitesOf(text, file);
  expect(sites).toHaveLength(1);
  return sites[0];
}

describe('parseFile import sites', () => {
  it('records a static import at the opening quote of its specifier', () => {
    const site = only(`// one\n// two\nimport { a } from './a';\n`);

    expect(site.kind).toBe('static');
    expect(site.line).toBe(3);
    expect(site.column).toBe(19);
    expect(site.specifier).toBe('./a');
    expect(site.form).toBe('declaration');
    expect(site.bindings).toEqual([{ local: 'a', imported: 'a', typeOnly: false }]);
  });

  it('records default and namespace bindings', () => {
    const site = only(`import Def, * as ns from './a';\n`);

    expect(site.kind).toBe('static');
    expect(site.bindings).toEqual([
      { local: 'Def', imported: 'default', typeOnly: false },
      { local: 'ns', imported: '*', typeOnly: false },
    ]);
  });

  it('treats whole-declaration and all-inline type imports as type', () => {
    expect(only(`import type { A } from './a';\n`).kind).toBe('type');
    expect(only(`import { type A, type B } from './b';\n`).kind).toBe('type');

    const mixed = only(`import { type A, b as c } from './c';\n`);
    expect(mixed.kind).toBe('static');
    expect(mixed.bindings).toEqual([
      { local: 'A', imported: 'A', typeOnly: true },
      { local: 'c', imported: 'b', typeOnly: false },
    ]);
  });

  it('classifies plain and type-only re-exports', () => {
    expect(only(`export * from './a';\n`).kind).toBe('re-export');
    expect(only(`export { a } from './b';\n`).kind).toBe('re-export');
    expect(only(`export {} from './c';\n`).kind).toBe('re-export');
    expect(only(`export type { A } from './d';\n`).kind).toBe('type');
    expect(only(`export { type A } from './e';\n`).kind).toBe('type');
  });

  it('an empty import is a static site with no bindings', () => {
    const site = only(`import {} from './x';\n`);

    expect(site.kind).toBe('static');
    expect(site.bindings).toEqual([]);
  });

  it('records type-context imports at the quote with the type-context form', () => {
    const alias = only(`type T = import('./x').T;\n`);
    expect(alias.kind).toBe('type');
    expect(alias.form).toBe('type-context');
    expect(alias.specifier).toBe('./x');
    expect(alias.line).toBe(1);
    expect(alias.column).toBe(17);

    const query = only(`type U = typeof import('./y');\n`);
    expect(query.kind).toBe('type');
    expect(query.form).toBe('type-context');
    expect(query.specifier).toBe('./y');
    expect(query.column).toBe(24);

    expect(only(`import { a } from './a';\n`).form).toBe('declaration');
  });

  it('marks a dynamic site deferred from its enclosing context', () => {
    const topLevel = only(`await import('./top');\n`);
    expect(topLevel.kind).toBe('dynamic');
    expect(topLevel.deferred).toBe(false);

    const inFunction = only(`async function f() {\n  await import('./f');\n}\n`);
    expect(inFunction.deferred).toBe(true);

    const inStaticBlock = only(`class C {\n  static {\n    import('./b');\n  }\n}\n`);
    expect(inStaticBlock.deferred).toBe(false);

    const inStaticField = only(`class C {\n  static x = import('./c');\n}\n`);
    expect(inStaticField.deferred).toBe(false);

    const inIife = only(`(() => {\n  import('./d');\n})();\n`);
    expect(inIife.deferred).toBe(false);
  });

  it('flags a non-literal specifier as unsupported', () => {
    const site = only(`const name = './a';\nconst m = import(name);\n`);

    expect(site.kind).toBe('dynamic');
    expect(site.specifier).toBe('name');
    expect(site.unsupported).toBe('non-literal');
  });

  it('classifies require forms and a shadowed require', () => {
    expect(only(`const x = require('./x');\n`).kind).toBe('require');

    const equals = only(`import y = require('./y');\n`);
    expect(equals.kind).toBe('require');
    expect(equals.bindings).toEqual([{ local: 'y', imported: '*', typeOnly: false }]);

    const shadowed = only(`const require = () => {};\nrequire('./x');\n`);
    expect(shadowed.kind).toBe('require');
    expect(shadowed.unsupported).toBe('shadowed-require');
  });

  it('a bare import with no clause is a side-effect site', () => {
    const site = only(`import './polyfill';\n`);

    expect(site.kind).toBe('side-effect');
    expect(site.bindings).toEqual([]);
  });

  it('flags a JSDoc import type in a JS file', () => {
    const site = only(`/** @type {import('./x').T} */\nexport const y = 1;\n`, 'src/a.js');

    expect(site.kind).toBe('type');
    expect(site.form).toBe('type-context');
    expect(site.specifier).toBe('./x');
    expect(site.line).toBe(1);
    expect(site.column).toBe(19);
    expect(site.unsupported).toBe('jsdoc-import-type');
  });

  it('collects the directive prologue only from the leading statements', () => {
    const prologue = parseFile(
      'src/a.ts',
      `'use client';\n'use strict';\nimport a from './a';\n`,
      {},
    );
    expect(prologue.directives).toEqual(['use client', 'use strict']);

    const interrupted = parseFile('src/b.ts', `const x = 1;\n'use strict';\n`, {});
    expect(interrupted.directives).toEqual([]);
  });

  it('parses a tsx file containing JSX', () => {
    const parsed = parseFile(
      'src/a.tsx',
      `import { a } from './a';\nexport const x = <div className="a">{a}</div>;\n`,
      {},
    );

    expect(parsed.sourceFile.fileName).toBe('src/a.tsx');
    expect(parsed.sites).toHaveLength(1);
    expect(parsed.sites[0].specifier).toBe('./a');
  });
});

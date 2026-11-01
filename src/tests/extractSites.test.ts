import { describe, expect, it } from 'vitest';

import { parseFile } from '../parser/extractSites';
import type { ImportSite } from '../parser/types';

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

describe('require shadowing is scoped to enclosing value scopes', () => {
  function requireSite(text: string, specifier = './x'): ImportSite {
    const sites = sitesOf(text).filter(
      (site) => site.kind === 'require' && site.specifier === specifier,
    );
    expect(sites).toHaveLength(1);
    return sites[0];
  }

  it('shadows a module-level call from a module-level value binding, in either order', () => {
    expect(requireSite(`const require = () => {};\nrequire('./x');\n`).unsupported).toBe(
      'shadowed-require',
    );
    expect(requireSite(`require('./x');\nconst require = () => {};\n`).unsupported).toBe(
      'shadowed-require',
    );
  });

  it('does not let an unrelated nested function parameter shadow a module-level call', () => {
    const site = requireSite(`function f(require: unknown) {}\nrequire('./x');\n`);

    expect(site.kind).toBe('require');
    expect(site.unsupported).toBeUndefined();
  });

  it('shadows a call inside the function that declares the parameter', () => {
    expect(requireSite(`function f(require: unknown) {\n  require('./x');\n}\n`).unsupported).toBe(
      'shadowed-require',
    );
  });

  it('treats a value import named require as a shadow', () => {
    expect(requireSite(`import require from './req';\nrequire('./x');\n`).unsupported).toBe(
      'shadowed-require',
    );
  });

  it('does not collect declarations from unrelated nested functions', () => {
    const site = requireSite(
      `function a() {\n  const require = 1;\n}\nfunction b() {\n  require('./x');\n}\n`,
    );

    expect(site.unsupported).toBeUndefined();
  });

  it('hoists a var declaration to its enclosing function scope', () => {
    const hoisted = requireSite(
      `function f() {\n  if (flag) {\n    var require = custom;\n  }\n  require('./x');\n}\n`,
    );
    expect(hoisted.unsupported).toBe('shadowed-require');

    const blockScoped = requireSite(
      `function f() {\n  if (flag) {\n    let require = custom;\n  }\n  require('./x');\n}\n`,
    );
    expect(blockScoped.unsupported).toBeUndefined();
  });

  it('shadows from an enclosing module binding through a nested block', () => {
    const site = requireSite(
      `const require = custom;\nfunction f() {\n  {\n    require('./x');\n  }\n}\n`,
    );

    expect(site.unsupported).toBe('shadowed-require');
  });

  it('scopes catch, loop and destructuring bindings to their value scopes', () => {
    expect(requireSite(`try {} catch (require) {\n  require('./x');\n}\n`).unsupported).toBe(
      'shadowed-require',
    );
    expect(requireSite(`try {} catch (require) {}\nrequire('./x');\n`).unsupported).toBeUndefined();

    expect(requireSite(`for (const require of xs) {\n  require('./x');\n}\n`).unsupported).toBe(
      'shadowed-require',
    );
    expect(
      requireSite(`for (const require of xs) {}\nrequire('./x');\n`).unsupported,
    ).toBeUndefined();

    expect(requireSite(`const { require } = obj;\nrequire('./x');\n`).unsupported).toBe(
      'shadowed-require',
    );
  });

  it('binds a named function or class expression name internally only', () => {
    expect(requireSite(`const f = function require() {\n  require('./x');\n};\n`).unsupported).toBe(
      'shadowed-require',
    );
    expect(
      requireSite(`const f = function require() {};\nrequire('./x');\n`).unsupported,
    ).toBeUndefined();
    expect(
      requireSite(`const C = class require {\n  m() {\n    require('./x');\n  }\n};\n`).unsupported,
    ).toBe('shadowed-require');
  });

  it('keeps a static-block var out of sibling blocks and the module', () => {
    const sibling = requireSite(
      `class C {\n  static {\n    var require = 1;\n  }\n  static {\n    require('./x');\n  }\n}\n`,
    );
    expect(sibling.unsupported).toBeUndefined();

    const moduleScope = requireSite(
      `class C {\n  static {\n    var require = 1;\n  }\n}\nrequire('./x');\n`,
    );
    expect(moduleScope.unsupported).toBeUndefined();
  });

  it('ignores type-only declarations and type-only imports named require', () => {
    expect(requireSite(`type require = string;\nrequire('./x');\n`).unsupported).toBeUndefined();
    expect(requireSite(`interface require {}\nrequire('./x');\n`).unsupported).toBeUndefined();
    expect(
      requireSite(`import type { require } from './t';\nrequire('./x');\n`).unsupported,
    ).toBeUndefined();
    expect(
      requireSite(`import { type require, other } from './t';\nrequire('./x');\n`).unsupported,
    ).toBeUndefined();
  });

  it('shares one lexical scope across every switch clause', () => {
    expect(
      requireSite(
        `switch (n) {\n  case 1:\n    const require = 1;\n    break;\n  case 2:\n    require('./x');\n}\n`,
      ).unsupported,
    ).toBe('shadowed-require');
  });

  it('does not let a default-clause declaration leak past the switch', () => {
    const site = requireSite(
      `switch (n) {\n  default:\n    const require = 1;\n}\nrequire('./x');\n`,
    );

    expect(site.unsupported).toBeUndefined();
  });

  it('evaluates a computed method name in the enclosing scope, not the method', () => {
    const site = requireSite(`const obj = { [require('./x')](require) {} };\n`);

    expect(site.kind).toBe('require');
    expect(site.unsupported).toBeUndefined();
  });

  it('still shadows a call in the body of a method that names a parameter require', () => {
    expect(requireSite(`const obj = { m(require) {\n  require('./x');\n} };\n`).unsupported).toBe(
      'shadowed-require',
    );
  });

  it('keeps a body var out of the parameter defaults but visible in the body', () => {
    expect(
      requireSite(`function f(x = require('./x')) {\n  var require = custom;\n}\n`).unsupported,
    ).toBeUndefined();

    expect(
      requireSite(
        `function f(x = require('./x')) {\n  let require = custom;\n  require('./y');\n}\n`,
        './y',
      ).unsupported,
    ).toBe('shadowed-require');
  });

  it('keeps namespace-local var bindings out of the module scope', () => {
    expect(
      requireSite(`namespace N {\n  var require = custom;\n  require('./x');\n}\n`).unsupported,
    ).toBe('shadowed-require');

    expect(
      requireSite(`namespace N {\n  var require = custom;\n}\nrequire('./x');\n`).unsupported,
    ).toBeUndefined();
  });

  it('keeps a namespace-local import-equals binding out of the module scope', () => {
    const site = requireSite(
      `namespace N {\n  import require = require('./dep');\n}\nrequire('./x');\n`,
    );

    expect(site.kind).toBe('require');
    expect(site.unsupported).toBeUndefined();
  });

  it('evaluates nested scopes in a computed method name in the enclosing scope', () => {
    const site = requireSite(`const obj = { [(() => require('./x'))()](require) {} };\n`);

    expect(site.kind).toBe('require');
    expect(site.unsupported).toBeUndefined();
  });

  it('evaluates a method decorator in the enclosing scope', () => {
    const site = requireSite(`class C {\n  @dec(require('./x'))\n  m(require) {}\n}\n`);

    expect(site.kind).toBe('require');
    expect(site.unsupported).toBeUndefined();
  });

  it('does not leak a dotted namespace inner name into the module scope', () => {
    const site = requireSite(`namespace N.require {\n  export const x = 1;\n}\nrequire('./x');\n`);

    expect(site.kind).toBe('require');
    expect(site.unsupported).toBeUndefined();
  });

  it('hoists a sloppy block function but not in strict code', () => {
    const sloppy = requireSite(
      `function f() {\n  if (true) {\n    function require() {}\n  }\n  require('./x');\n}\nf();\n`,
    );
    expect(sloppy.unsupported).toBe('shadowed-require');

    const strict = requireSite(
      `'use strict';\nfunction f() {\n  if (true) {\n    function require() {}\n  }\n  require('./x');\n}\nf();\n`,
    );
    expect(strict.unsupported).toBeUndefined();

    const strictFunction = requireSite(
      `function f() {\n  'use strict';\n  if (true) {\n    function require() {}\n  }\n  require('./x');\n}\n`,
    );
    expect(strictFunction.unsupported).toBeUndefined();
  });

  it('does not hoist async or generator block functions', () => {
    expect(
      requireSite(
        `function f() {\n  {\n    async function require() {}\n  }\n  require('./x');\n}\n`,
      ).unsupported,
    ).toBeUndefined();
    expect(
      requireSite(`function f() {\n  {\n    function* require() {}\n  }\n  require('./x');\n}\n`)
        .unsupported,
    ).toBeUndefined();
  });

  it('does not hoist a block function blocked by an enclosing lexical binding', () => {
    const site = requireSite(
      `function f() {\n  {\n    let require = custom;\n    {\n      function require() {}\n    }\n  }\n  require('./x');\n}\n`,
    );

    expect(site.unsupported).toBeUndefined();
  });

  it('does not shadow a type-only namespace', () => {
    expect(
      requireSite(
        `namespace require {\n  export interface Options { value: string }\n}\nrequire('./x');\n`,
      ).unsupported,
    ).toBeUndefined();
  });

  it('shadows a namespace that introduces a runtime value', () => {
    expect(
      requireSite(`namespace require {\n  export const x = 1;\n}\nrequire('./x');\n`).unsupported,
    ).toBe('shadowed-require');
  });

  it('sees a merged namespace exported value member across declarations', () => {
    const site = requireSite(
      `namespace N {\n  export const require = (path: string) => 0;\n}\nnamespace N {\n  export const value = require('./x');\n}\n`,
    );

    expect(site.unsupported).toBe('shadowed-require');
  });

  it('does not share a non-exported namespace binding across declarations', () => {
    const site = requireSite(
      `namespace N {\n  const require = (path: string) => 0;\n}\nnamespace N {\n  export const value = require('./x');\n}\n`,
    );

    expect(site.unsupported).toBeUndefined();
  });
});

# tdepend

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

tdepend checks a TypeScript codebase against architecture rules you write down, such as "controllers don't import repositories" or "no import cycles between modules", and fails the build when an import breaks one.

It resolves every import through TypeScript's own resolver, so its import graph matches the compiler. It knows which imports really load their target at runtime and which ones the compiler erases. On that graph it groups files into components and packages, reports coupling metrics and import cycles, and evaluates rules. A baseline lets you adopt a rule in a codebase that already breaks it.

## Installation

tdepend needs Node 22.12 or later.

```bash
npm install --save-dev tdepend
```

## Quick start

```bash
tdepend init        # write a starter tdepend.config.json
tdepend analyze     # components, metrics, cycles and how every import resolved
tdepend check       # evaluate the rules; exit 1 on any error
tdepend baseline    # accept today's violations, so only new ones fail
```

Every command takes `--root <dir>` and `--config <path>`. tdepend reads the checkout as it is, so it works before a build and usually before `npm install`.

## Commands

### `tdepend analyze`

Prints components with their metrics, cycles between components, and the resolution report. It exits 0, or 2 when the config, a source file or the root can't be read.

| Option | Meaning |
|---|---|
| `-f, --format <text\|json>` | Output format, `text` by default |
| `-e, --export <path>` | Also write the full result as JSON |
| `--strict-resolution` | Exit 2 when any import is unresolved |

```text
Components (3):
                Ca  Ce     I     A     D
  src/orders     2   1  0.33  0.00  0.67
  src/users      2   2  0.50  0.00  0.50
  (root)         1   2  0.67  0.00  0.33

Component cycles (1):
  src/orders → src/users → src/orders
    src/orders/orders.controller.ts:2:33  '@users/repositories/users.repository' → src/users/repositories/users.repository.ts
    src/users/users.service.ts:3:31  '../orders/orders.service' → src/orders/orders.service.ts
```

In a workspace it also prints package metrics and package cycles. Each import gets one class:

| Class | Meaning |
|---|---|
| `internal` | A file in the analysis set, in the same package |
| `workspace` | A file in the analysis set, in another workspace package |
| `external` | A package from `node_modules`, or one declared in `package.json` but not installed |
| `builtin` | A Node built-in; `fs` and `node:fs` are the same module |
| `excluded` | A repo file outside the analysis set, such as a test |
| `asset` | A stylesheet, image, font, JSON or Markdown file, or anything with a `?query` |
| `virtual` | A `virtual:` or `~icons/` module, or a `resolve.virtual` pattern |
| `ignored` | Unresolved, but matched by `resolve.ignoreUnresolved` or gitignored |
| `unsupported` | A form tdepend can't follow, such as `import(name)` |
| `unresolved` | None of the above; usually a broken import |

Only `internal` and `workspace` imports are edges of the graph.

### `tdepend explain <file>`

Prints every import in one file: position, kind, class, target, and whether it loads its target at runtime, with the reason.

```text
1:8  side-effect  internal  '@/components/button' -> src/components/button.tsx  loads (retained): a side-effect import is evaluated and every compiler keeps it
```

An import loads its target unless every compiler in `compilers` drops it.

### `tdepend check`

Evaluates the rules and prints the violations the baseline doesn't cover.

| Option | Meaning |
|---|---|
| `-b, --baseline <path>` | Baseline file to compare with, instead of the config's `baseline` |
| `-f, --format <text\|json>` | Output format, `text` by default |
| `--strict-resolution` | Exit 2 when any import is unresolved |
| `--path-prefix <prefix>` | Put this before every path in the output |

```text
Errors (1):
  src/a.controller.ts:3:19  LAYER-CONTROLLER-REPO-001  Controllers call services, not repositories.  ('./a.repository' → src/a.repository.ts)

1 error, 0 warnings.
```

| Exit code | When |
|---|---|
| 0 | No error the baseline doesn't cover. Warnings never fail a run |
| 1 | At least one error the baseline doesn't cover |
| 2 | A config, parse or baseline error, a missing root, or an unresolved import under `--strict-resolution` |

### `tdepend baseline`

Writes every current violation into the baseline file (the config's `baseline`, or `tdepend-baseline.json` next to the config). With `--prune` it only lowers counts and removes entries nothing matches any more; it never accepts a new violation.

### `tdepend init`

Detects your projects and presets and writes a starter config. It refuses to overwrite an existing one unless you pass `--force`.

```json
{
  "presets": ["auto"],
  "exclude": [],
  "rules": [{ "id": "nest/layers", "severity": "warn" }]
}
```

The `rules` entries switch on the detected presets' recommended rules as warnings.

## Presets

A project is the root folder, every folder with a `package.json` that declares dependencies, and every workspace package. Each project gets presets from its own `package.json`. `"presets": ["auto"]` turns on `node` plus every built-in preset that matches; listing names instead uses only those.

| Preset | When | Skips | Components | Rules |
|---|---|---|---|---|
| `node` | always | tests, specs, `__tests__`, stories, `.d.ts`, `*.min.js`, `dist`, `build`, `coverage`, `public`, `e2e` | `src/*` | `node/no-cycles`: file cycles, warn |
| `nest` | `@nestjs/core` | `test/**` | one per `*.module.ts` folder | `nest/layers`, off |
| `react` | `react` without `next` | stories | `src/features/*`, then `src/*` | `react/shared-no-feature-import`, off |
| `express` | `express` | | `src/*` | |
| `fastify` | `fastify` | | `src/*` | |

- `nest/layers`: controllers don't import repositories; repositories don't import services or controllers; DTOs don't import services or repositories.
- `react/shared-no-feature-import`: `src/{components,lib,shared,utils}/**` doesn't import `src/features/**`.

Turn an off rule on with `{ "id": "nest/layers", "severity": "warn" }` in `rules`. A preset rule runs separately in each project that has it, on that project's files.

When several presets set components for one project, `nest` wins, then `react`, then `express` or `fastify`, then `node`. A `components` setting in your config applies to every project.

### Your own preset

```js
// acme-preset.js
const { definePreset } = require('tdepend/presets');

module.exports = definePreset({
  name: 'acme',
  detect: (project) => project.dependencies.has('@nestjs/core'),
  rules: [{ type: 'no-cycles', id: 'acme/no-module-cycles', level: 'component' }],
});
```

List it as `"presets": ["auto", "./acme-preset.js"]`. A preset may set `extends`, `skips`, `ignoreUnresolved`, `components`, `rules` (on), `recommended` (off) and `repoRules` (run once for the whole repository). Its paths are relative to the project.

## Components

| `components.type` | A file belongs to |
|---|---|
| `directory` | The folder matched by the first of `patterns` that matches one of its ancestors, such as `["src/features/*", "src/*"]` |
| `nest-module` | The nearest folder with a `*.module.ts`. The outermost module (AppModule) keeps only its `*.module.ts` files; everything else it would claim, such as `src/main.ts` or `src/common`, belongs to no component |
| `file` | Itself |

Files that match nothing go to their project's `(root)` group. With `"coverage": { "requireAll": true, "allowUnmatched": ["src/main.ts"] }` inside `components`, each of those files is a `components/coverage` violation. In a workspace, every file also belongs to its nearest workspace package.

## Rules

Every rule has an `id`, a `severity` (`error` by default, `warn` or `off`) and a `message`. Paths are relative to the repository root.

**`forbidden`**: no import from `from` files to `to` targets.

```json
{ "type": "forbidden", "id": "LAYER-CONTROLLER-REPO-001",
  "from": ["src/**/*.controller.ts"], "to": ["src/**/*.repository.ts"],
  "message": "Controllers call services, not repositories." }
```

`to` takes `{ "files": [...] }`, `{ "modules": [...] }` or both. A `modules` pattern matches a package or Node built-in by name: `@prisma/client` matches only that module, `@prisma/client/*` only its subpaths, and `node:fs` also matches `fs`. Optional: `exceptFrom`, `exceptTo`, `kinds`, and `runtimeOnly: true` to skip imports that never run.

**`layers`**: forbidden imports between named layers. A file belongs to the first layer it matches.

```json
{ "type": "layers", "id": "LAYERS-001",
  "layers": { "controllers": ["src/**/*.controller.ts"], "repositories": ["src/**/*.repository.ts"] },
  "disallow": { "controllers": [{ "layer": "repositories", "message": "Go through a service." }] } }
```

**`private`**: files only their own component may import, relative to the component's folder. Either list the private files with `paths`, or list the public entry files with `public` and everything else is private.

```json
{ "type": "private", "id": "REPO-PRIVATE-001", "paths": ["**/repositories/**"],
  "message": "Use the owning module's service instead of its repository." }
```

**`no-cycles`**: no import cycles at `file`, `component` or `package` level.

```json
{ "type": "no-cycles", "id": "MODULE-NO-CYCLE-001", "level": "component" }
```

Each cycle is one violation, located at the first import of its shortest loop. `ignoreTypeOnly` (default `true`) leaves out imports that never run; `ignoreLazyImports: true` leaves out `import()` inside functions.

## Metrics

For every file, component and package: **Ca** (how many depend on it), **Ce** (how many it depends on), instability **I** = Ce / (Ca + Ce), abstractness **A**, and distance from the main sequence **D** = |A + I − 1|.

With `"abstractness": "implemented"` (the default), an interface or abstract class is abstract only when something implements or extends it, and fields-only declarations such as DTOs are left out of A. With `"jdepend"`, every interface, type alias and abstract class is abstract. `"thresholds": { "distance": 0.5 }` lists the components further than that from the main sequence. Metrics never change the exit code.

## Baselines

The baseline lists accepted violations with a count:

```json
{ "version": 1, "entries": [
  { "fingerprint": "…", "kind": "import", "ruleId": "NO-DB", "projectId": "proj:(repo)", "severity": "error",
    "from": "src/a.ts", "target": { "file": "src/db.ts" }, "specifier": "./db", "count": 2 }
] }
```

- A violation is matched by rule, project, severity, file, target and specifier, not by line.
- With `count: 2`, two current matches are accepted and a third is reported.
- A cycle is accepted when its members are a subset of one cycle entry's members.
- Entries with fewer matches than their count are listed as *no longer reported*.

## JSON output

`analyze --format json` and `--export` write one sorted document with no timestamp: files, edges, import sites, components and packages, metrics, cycles, the effective rule instances with their severities, and the resolution report. Paths are relative to the root; lines and columns start at 1. `check --format json` prints the actionable and accepted violations, the entries no longer reported, and warnings.

## Library API

```ts
import { analyze, check, init, explainFile, exportToFile, toSerializable } from 'tdepend';
import { definePreset, builtInPresets } from 'tdepend/presets';

const report = await check({ root: '.' });
console.log(report.actionable.length);
```

`analyze` and `check` take `root`, `config` and `typeOnly`; `check` also takes `baseline` and `strictResolution`.

## Configuration

`tdepend.config.json` in the root, or `--config <path>`. Every key is optional; these are the defaults:

```json
{
  "root": ".",
  "presets": ["auto"],
  "include": [],
  "exclude": [],
  "typeOnly": "usage",
  "compilers": ["tsc", "esbuild", "swc"],
  "resolve": { "aliases": {}, "virtual": [], "ignoreUnresolved": [] },
  "metrics": { "abstractness": "implemented", "thresholds": { "distance": null } },
  "rules": [],
  "baseline": null
}
```

- **`components`**: one component strategy for every project; without it, presets decide.
- **`include`**: root-relative globs that replace discovery. The skips still apply.
- **`exclude`**: added to the presets' skips. `"!pattern"` switches a preset skip off, as in `"!**/public/**"`.
- **`typeOnly`**: `usage` treats an import as type-only when its names are only used as types; `syntax` only when it is written `import type`.
- **`compilers`**: the compilers your build uses. With `["tsc"]`, tdepend also drops `export { T } from` when every name is a type, as tsc does.
- **`resolve.aliases`**: aliases that exist only in a bundler config, such as `{ "@/": "src/" }`. `tsconfig` `paths` need no config.
- **`baseline`**: the baseline file, relative to the config.

Gitignored files and `node_modules`, `dist`, `build`, `out`, `coverage` and dot directories are skipped. An unknown key exits 2.

## Supported layouts

NestJS (CommonJS, NodeNext, monorepos with `paths`), Next.js, Vite with TanStack Router, TanStack Start, Express, Fastify, plain Node libraries, pnpm and npm workspaces (built or not), and several apps without a workspace config. Vue, Svelte and Astro components and Yarn Plug'n'Play are not supported.

## Development

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```

## License

[MIT](LICENSE)

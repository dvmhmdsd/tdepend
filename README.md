# tdepend

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

tdepend's goal is to make TypeScript architecture contracts executable. Version 0.3.0 delivers the foundation those contracts need: an import graph that matches the TypeScript compiler.

It finds your projects, workspace packages and `tsconfig` files, then resolves every import through TypeScript's own resolver. For each import it records:

- where it is, by file, line and column;
- what form it takes, such as a static import, a `require` or a type-only import;
- what it resolves to, in one of ten classes;
- whether it really loads its target at runtime, or the compiler erases it.

Architecture rules, metrics, cycles and baselines are not in this version. See [Migrating from 0.2](#migrating-from-02).

## Installation

tdepend needs Node 22.12 or later.

```bash
npm install --save-dev tdepend
# or
pnpm add --save-dev tdepend
```

## Usage

```bash
tdepend analyze                     # report on the current directory
tdepend analyze --root path/to/repo # report on another directory
tdepend explain src/main.tsx        # show every import in one file
```

Both commands take `--root <dir>` and `--config <path>`. `tdepend --version` prints the version and `tdepend --help` lists the commands.

tdepend reads the checkout as it is, so it works before a build and usually before `pnpm install`. The exception is a `tsconfig` whose `extends` names a package or a generated file. That target must exist, or tdepend exits 2 and names the config. tdepend never writes to the analysed repo unless you point `--export` there.

### `tdepend analyze`

| Option | Meaning |
|---|---|
| `-f, --format <text\|json>` | Output format, `text` by default |
| `-e, --export <path>` | Also write the full result to a JSON file |
| `--strict-resolution` | Exit 2 when any import is unresolved |

The exit code is 0, or 2 on a config or parse error. With `--strict-resolution` it is also 2 when an import is unresolved, which makes that flag the one gate this version offers for CI.

The text report looks like this:

```text
Files: 6
Import sites: 10
Edges: 2

Sites by class:
  builtin: 1
  asset: 2
  virtual: 1
  internal: 2
  workspace: 0
  excluded: 2
  external: 0
  ignored: 0
  unsupported: 0
  unresolved: 2

Unresolved imports (2):
  src/main.tsx:6  ./missing
  src/main.tsx:9  left-pad

Ignored (gitignored targets): 0

Unsupported imports: 0

Self-imports: 0
Files outside every tsconfig: 2
```

**Files** is the analysis set. **Import sites** counts every import statement or call. **Edges** counts the file pairs connected by at least one site.

Every site gets exactly one class:

| Class | Meaning | Adds a graph edge |
|---|---|---|
| `builtin` | A Node built-in; `fs` and `node:fs` count as the same module | No |
| `virtual` | A `virtual:` or `~icons/` module, or a `resolve.virtual` pattern | No |
| `asset` | A stylesheet, image, font, JSON or Markdown file, or anything with a `?query` | No |
| `internal` | A file in the analysis set, in the same package | Yes |
| `workspace` | A file in the analysis set, in a different workspace package | Yes |
| `excluded` | A repo file outside the analysis set, such as a test or generated file | No |
| `external` | A package from `node_modules`, or one declared in `package.json` but not installed | No |
| `ignored` | An unresolved import that matches `resolve.ignoreUnresolved`, or whose target is gitignored | No |
| `unsupported` | A form tdepend can't follow, such as `import(name)`, a shadowed `require`, or a JSDoc import type | No |
| `unresolved` | None of the above; this is usually a broken import | No |

The report also counts self-imports and files that no `tsconfig` covers. When a package is declared but missing, it adds a line asking whether `node_modules` is installed. Discovery warnings, such as a compiler option TypeScript 5.9 doesn't know, are listed at the end.

### `tdepend explain <file>`

`explain` is the debugging tool. It prints one row per import: position, kind, class, target and the runtime verdict with its reason.

```text
1:8  side-effect  internal  '@/components/button' -> src/components/button.tsx  loads (retained): a side-effect import is evaluated and every compiler keeps it
3:8  side-effect  asset  './styles.css' -> -  loads (retained): a side-effect import is evaluated and every compiler keeps it
7:27  static  excluded  './routeTree.gen' -> src/routeTree.gen.ts  loads (retained): at least one binding is used as a value
10:16  static  builtin  'node:fs' -> node:fs  loads (retained): at least one binding is used as a value
```

The verdict rule is conservative: an import loads its target unless `tsc`, esbuild and swc would all drop it. A reported runtime edge may therefore be one a single compiler would erase, but an import reported as erased is erased by every listed compiler.

The word in brackets is the kind of evidence. `syntax` means the form alone decides, as with `import type`. `usage` means no binding is used as a value. `retained` means a compiler keeps the import.

### JSON export

`--export <path>` and `--format json` write the same versioned document. It has no timestamp and every list is sorted, so two runs on the same inputs produce byte-identical output.

```json
{
  "version": 1,
  "files": ["src/main.ts", "src/util.ts"],
  "edges": [
    { "from": "src/main.ts", "to": "src/util.ts", "runtime": true, "mapped": false, "kinds": ["static"] }
  ],
  "sites": [
    {
      "file": "src/main.ts",
      "specifier": "./util",
      "line": 1,
      "column": 22,
      "kind": "static",
      "form": "declaration",
      "deferred": false,
      "unsupported": null,
      "loadsTarget": true,
      "loadsTargetBy": "retained",
      "class": "internal",
      "reason": null,
      "target": { "file": "src/util.ts" },
      "mapped": null,
      "requested": null
    }
  ],
  "report": { "...": "class counts, unresolved, ignored and unsupported sites, warnings" }
}
```

Paths are relative to the analysis root and use `/` on every platform. Lines and columns start at 1, and the column points at the opening quote of the specifier. An edge is `runtime` when at least one of its sites loads the target, and `mapped` when a declared output path such as `dist/index.d.ts` was mapped back to its source file.

## Library API

The package exports four functions, plus the types of the values they return.

```ts
import { analyze, explainFile, exportToFile, toSerializable } from 'tdepend';

const result = await analyze({ root: '.' });

const { edges, report } = toSerializable(result);
console.log(`${edges.length} edges, ${report.unresolved.length} unresolved imports`);

await exportToFile(result, 'graph.json');

const rows = await explainFile({ root: '.', file: 'src/main.tsx' });
for (const row of rows) {
  console.log(row.specifier, row.class, row.loadsTarget);
}
```

- `analyze(options?)` runs the whole pipeline. Its options are `root`, `config` and `typeOnly`.
- `explainFile(options)` takes the same options plus `file`, and returns one row per import.
- `toSerializable(result)` returns the JSON document above.
- `exportToFile(result, path)` writes that document to a file.

## Configuration

tdepend looks for `tdepend.config.json` in the analysis root, or uses `--config <path>`. A config is optional. These are the keys that work in 0.3.0, with their defaults:

```json
{
  "root": ".",
  "include": [],
  "exclude": [],
  "typeOnly": "usage",
  "compilers": ["tsc", "esbuild", "swc"],
  "resolve": { "aliases": {}, "virtual": [], "ignoreUnresolved": [] }
}
```

- **`root`** is the analysis root, relative to `--root` or the working directory.
- **`include`** replaces discovery when it isn't empty. It takes root-relative globs, and `exclude` still applies.
- **`exclude`** adds to the built-in skips below. An entry starting with `!` removes an earlier pattern, so `"!**/public/**"` keeps `public/`.
- **`typeOnly`** is `usage` or `syntax`. With `syntax`, every static import counts as loading its target, however its bindings are used.
- **`compilers`** names the compilers you really use. In 0.3.0 it only changes empty `import {} from` statements, which `tsc` erases and swc keeps.
- **`resolve.aliases`** is for aliases that exist only in a bundler config, as a prefix map relative to the importing file's project, such as `{ "@/": "src/" }`. Aliases in `tsconfig` `paths` need no config.
- **`resolve.virtual`** lists extra patterns to treat as `virtual`.
- **`resolve.ignoreUnresolved`** lists unresolved imports to class as `ignored`.

The built-in skips are test and spec files, `__tests__`, stories, declaration files, `*.min.js`, `public` and a root `e2e` folder. Gitignored files are skipped too. Directories named `node_modules`, `dist`, `build`, `out` and `coverage`, and dot directories such as `.storybook`, are never walked, so `include` can't reach them. A `tsconfig` that lists a file in a dot directory still brings that file in.

`exclude` also applies to `tsconfig` files, so a deliberately broken one under a fixtures folder can be left out.

The keys `presets` and `metrics.abstractness` are accepted and have no effect yet. An unknown key exits 2, and so do `rules`, `components`, `baseline` and `metrics.thresholds`, which belong to later releases.

## Migrating from 0.2

Version 0.3.0 is a rewrite, with no compatibility layer. The old graph missed aliases, re-exports, dynamic imports and workspace packages, so it was replaced rather than patched.

- **Metrics and cycles are gone for now.** 0.3.0 reports the graph only. Coupling metrics, cycles and rules arrive in 0.4, through a new `check` command with baselines. Comparing a pull request against its base arrives in 0.5.
- **Removed exports:** `analyzeWithConfig`, `exportToJson`, `DependencyGraph`, `detectCycles`, `computeAllMetrics`, `parseProject` and `scanFiles`. The public API is now the four functions above.
- **Removed CLI option:** `--ci`. Use `--format json` for machine output and `--strict-resolution` to fail a build.
- **Removed config keys:** `rootDir`, `ci`, `analysis` and `metrics.enabled`. `metrics.thresholds` returns in 0.4.
- **Old configs are rejected.** A config with `rootDir`, `ci` or `analysis` exits 2 with this message:

  ```text
  This looks like a tdepend 0.2 config. See 'Migrating from 0.2' in the README.
  ```

  Start again from the keys in [Configuration](#configuration).
- **Node 22.12 or later** is now required.

## Support levels

| Level | Layouts |
|---|---|
| **Supported**, covered by a fixture | NestJS with CommonJS or NodeNext, NestJS monorepos using `paths`, Next.js apps, Vite with TanStack Router, TanStack Start, Express in CommonJS JavaScript, Fastify in ESM, plain Node libraries, feature-based frontends, pnpm and npm workspaces including unbuilt and bundler-built packages, several apps without a workspace config, nested projects |
| **Configured manually** | Aliases that exist only in a bundler config, through `resolve.aliases`; unusual layouts, through `include` |
| **Experimental** | Yarn workspaces without Plug'n'Play, which use the same `package.json` form as npm but have no fixture of their own |
| **Unsupported** | Vue, Svelte and Astro single-file components, Yarn Plug'n'Play, non-literal dynamic loading |

## Development

```bash
pnpm install
pnpm run clean      # remove dist
pnpm run build      # clean, then compile
pnpm test           # run the test suite
pnpm run typecheck  # check the sources and the tests
```

## Project structure

```text
src/
  api/        analyze, explainFile, exportToFile, toSerializable
  cli/        command line entry point
  config/     config schema and loading
  files/      the analysis set
  graph/      the file graph and resolution report
  output/     the text report
  parser/     import sites and runtime-load classification
  project/    projects, workspace packages, tsconfigs, gitignore rules
  resolver/   TypeScript resolution, workspace host, classification
  tests/      tests and fixtures
  types/      public result types
  fs.ts       file system port
  errors.ts   errors that exit 2
  index.ts    library entry point
scripts/      regenerates the compiler fixture expectations
```

## License

[MIT](LICENSE)

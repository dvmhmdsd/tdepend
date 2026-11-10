import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assignComponents } from '../components/assignComponents';
import { buildGroupGraph } from '../components/groupGraph';
import type { ComponentStrategy, CoverageConfig } from '../components/types';
import { CycleCache } from '../cycles/findCycles';
import { ConfigError } from '../errors';
import { evaluateRules, userRuleInstances } from '../rules/evaluateRules';
import { fingerprint, identityOf } from '../rules/identity';
import {
  REPO_SCOPE,
  ruleConfigSchema,
  type RuleDefinition,
  type RuleEvaluation,
  type RuleInput,
  type RuleInstance,
  type Violation,
} from '../rules/types';
import { buildSymbolIndex } from '../symbols/symbolIndex';
import { FIXTURES, buildFixtureParts } from './helpers/fixtureGraph';

const BY_FOLDER: ComponentStrategy = { type: 'directory', patterns: ['src/*'] };

function inputFor(name: string, strategy = BY_FOLDER, coverage?: CoverageConfig): RuleInput {
  const parts = buildFixtureParts(name);
  const assignment = assignComponents(parts.ctx, parts.graph.files(), () => strategy);
  const component = buildGroupGraph(parts.graph, assignment, 'component', parts.sites);
  const groups =
    assignment.packages.length === 0
      ? { component }
      : { component, package: buildGroupGraph(parts.graph, assignment, 'package', parts.sites) };
  return {
    ctx: parts.ctx,
    graph: parts.graph,
    sites: parts.sites,
    assignment,
    groups,
    index: buildSymbolIndex(parts.graph, parts.parsed, parts.sites),
    coverage,
    cycleCache: new CycleCache(),
  };
}

const backend = inputFor('layered-backend');
const external = inputFor('external-policy');

const userRule = (rule: RuleDefinition): RuleInstance => ({
  rule,
  projectId: REPO_SCOPE,
  scopeFiles: 'repo',
  origin: 'user',
});

const run = (input: RuleInput, ...rules: RuleDefinition[]): RuleEvaluation =>
  evaluateRules(input, rules.map(userRule));

const sitesOf = (evaluation: RuleEvaluation): string[] =>
  evaluation.violations.map((violation) => `${violation.from}:${violation.site?.line}`);

const targetOf = (violation: Violation): string | undefined =>
  violation.to === undefined
    ? undefined
    : 'file' in violation.to
      ? violation.to.file
      : violation.to.module;

const forbiddenModules = (modules: string[], extra = {}): RuleDefinition => ({
  type: 'forbidden',
  id: 'NO-MODULES',
  message: 'Not here.',
  from: ['**'],
  to: { modules },
  ...extra,
});

describe('forbidden: files', () => {
  it('reports a controller importing a repository at the import site', () => {
    const evaluation = run(backend, {
      type: 'forbidden',
      id: 'LAYER-CONTROLLER-REPO-001',
      from: ['src/**/*.controller.ts'],
      to: ['src/**/repositories/**'],
      message: 'Controllers call services, not repositories.',
    });

    expect(sitesOf(evaluation)).toEqual([
      'src/orders/orders.controller.ts:2',
      'src/users/users.controller.ts:2',
    ]);
    const [first] = evaluation.violations;
    expect(first).toMatchObject({
      kind: 'import',
      ruleId: 'LAYER-CONTROLLER-REPO-001',
      projectId: REPO_SCOPE,
      severity: 'error',
      message: 'Controllers call services, not repositories.',
      from: 'src/orders/orders.controller.ts',
      to: { file: 'src/users/repositories/users.repository.ts' },
    });
    expect(first.site).toMatchObject({
      specifier: '@users/repositories/users.repository',
      line: 2,
      column: 33,
      kind: 'static',
    });
    expect(first.witness).toBeUndefined();
  });

  it('matches an excluded target at its real location', () => {
    const evaluation = run(external, {
      type: 'forbidden',
      id: 'NO-GENERATED',
      from: ['src/services/**'],
      to: ['src/generated/**'],
      message: 'Generated rows stay in repositories.',
    });

    expect(sitesOf(evaluation)).toEqual(['src/services/user.service.ts:7']);
    expect(evaluation.violations[0].to).toEqual({ file: 'src/generated/rows.d.ts' });
  });
});

describe('forbidden: modules', () => {
  it('services importing @prisma/client violate, with node_modules absent', () => {
    expect(existsSync(join(FIXTURES, 'external-policy', 'node_modules'))).toBe(false);
    const evaluation = run(external, {
      type: 'forbidden',
      id: 'DOMAIN-NO-PRISMA-001',
      from: ['src/services/**'],
      to: { modules: ['@prisma/client'] },
      message: 'Services use repositories; only repositories import the Prisma client.',
    });

    expect(sitesOf(evaluation)).toEqual([
      'src/services/order.service.ts:1',
      'src/services/user.service.ts:1',
    ]);
    expect(evaluation.violations.map((violation) => violation.to)).toEqual([
      { module: '@prisma/client' },
      { module: '@prisma/client' },
    ]);
  });

  it('patterns: exact name, exact subpath, a /* wildcard for subpaths only, and node:fs for fs', () => {
    const hits = (modules: string[]) => sitesOf(run(external, forbiddenModules(modules)));

    expect(hits(['@acme/ui'])).toEqual(['src/services/order.service.ts:2']);
    expect(hits(['@acme/ui/internal'])).toEqual(['src/services/user.service.ts:2']);
    expect(hits(['@acme/ui/*'])).toEqual(['src/services/user.service.ts:2']);
    expect(hits(['node:fs'])).toEqual([
      'src/services/user.service.ts:4',
      'src/services/user.service.ts:5',
    ]);
    expect(hits(['fs'])).toEqual([
      'src/services/user.service.ts:4',
      'src/services/user.service.ts:5',
    ]);
  });

  it('an alias that looks like a package is not matched by modules', () => {
    // '@acme/shared' is a tsconfig path to src/shared.ts, so it is a file, not a module.
    expect(sitesOf(run(external, forbiddenModules(['@acme/*'])))).toEqual([
      'src/services/order.service.ts:2',
      'src/services/user.service.ts:2',
    ]);
  });

  it('a site with requested (a workspace specifier) never matches a modules selector', () => {
    const workspace = inputFor('pnpm-monorepo', {
      type: 'directory',
      patterns: ['src', 'scripts'],
    });
    expect(workspace.sites.some((record) => record.resolution.requested !== undefined)).toBe(true);

    const evaluation = run(workspace, forbiddenModules(['@demo/*', '@demo/b/src/internal']));
    expect(evaluation.violations).toEqual([]);
  });

  it('exceptFrom and exceptTo remove matches; kinds and runtimeOnly filter sites', () => {
    const axios = forbiddenModules(['axios'], { exceptFrom: ['src/adapters/http/**'] });
    expect(sitesOf(run(external, axios))).toEqual(['src/services/user.service.ts:3']);

    const acme = forbiddenModules(['@acme/*'], { exceptTo: { modules: ['@acme/ui'] } });
    expect(sitesOf(run(external, acme))).toEqual(['src/services/user.service.ts:2']);

    const typeOnly = forbiddenModules(['@prisma/client'], { kinds: ['type'] });
    expect(sitesOf(run(external, typeOnly))).toEqual(['src/services/order.service.ts:1']);

    const runtime = forbiddenModules(['@prisma/client'], { runtimeOnly: true });
    expect(sitesOf(run(external, runtime))).toEqual([
      'src/repositories/user.repository.ts:1',
      'src/services/user.service.ts:1',
    ]);
  });
});

describe('layers', () => {
  const layers = {
    controllers: ['src/**/*.controller.ts'],
    services: ['src/**/*.service.ts'],
    repositories: ['src/**/repositories/**'],
  };

  it('expands to per-pair messages under the layers id, falling back to the rule message', () => {
    const evaluation = run(backend, {
      type: 'layers',
      id: 'LAYERS-001',
      message: 'Layers point downwards only.',
      layers,
      disallow: {
        controllers: [
          { layer: 'repositories', message: 'Controllers call services, not repositories.' },
        ],
        services: [{ layer: 'repositories' }],
      },
    });

    expect(
      evaluation.violations.map((violation) => [
        violation.ruleId,
        `${violation.from}:${violation.site?.line}`,
        violation.message,
      ]),
    ).toEqual([
      [
        'LAYERS-001',
        'src/orders/orders.controller.ts:2',
        'Controllers call services, not repositories.',
      ],
      ['LAYERS-001', 'src/orders/orders.service.ts:1', 'Layers point downwards only.'],
      [
        'LAYERS-001',
        'src/users/users.controller.ts:2',
        'Controllers call services, not repositories.',
      ],
      ['LAYERS-001', 'src/users/users.service.ts:1', 'Layers point downwards only.'],
    ]);
  });

  it('a file belongs to the first listed layer it matches; without messages a default one is used', () => {
    const shadowed = run(backend, {
      type: 'layers',
      id: 'LAYERS-002',
      layers: { everything: ['src/**'], ...layers },
      disallow: { controllers: [{ layer: 'repositories' }] },
    });
    expect(shadowed.violations).toEqual([]);

    const plain = run(backend, {
      type: 'layers',
      id: 'LAYERS-003',
      layers,
      disallow: { controllers: [{ layer: 'repositories' }] },
    });
    expect(plain.violations.map((violation) => violation.message)).toEqual([
      'Layer `controllers` must not import layer `repositories`.',
      'Layer `controllers` must not import layer `repositories`.',
    ]);
  });
});

describe('private', () => {
  it('paths: only the owning component may import its repositories; alias and relative imports agree', () => {
    const evaluation = run(backend, {
      type: 'private',
      id: 'MODULE-REPO-PRIVATE-001',
      paths: ['**/repositories/**'],
      message: "Use the owning module's service instead of its repository.",
    });

    expect(sitesOf(evaluation)).toEqual([
      'src/orders/orders.controller.ts:2',
      'src/orders/orders.service.ts:1',
    ]);
    expect(evaluation.violations.map(targetOf)).toEqual([
      'src/users/repositories/users.repository.ts',
      'src/users/repositories/users.repository.ts',
    ]);
  });

  it('public: files outside index.ts and testing.ts are private; exceptFrom works; root buckets are never private', () => {
    const rule: RuleDefinition = {
      type: 'private',
      id: 'PUBLIC-API-001',
      public: ['index.ts', 'testing.ts'],
      message: 'Import other components through their public files.',
    };

    // users.service → ../config (a root bucket file) and orders.service → ../users/testing are allowed.
    expect(sitesOf(run(backend, { ...rule, exceptFrom: ['src/main.ts'] }))).toEqual([
      'src/orders/orders.controller.ts:2',
      'src/orders/orders.service.ts:1',
      'src/orders/orders.service.ts:2',
      'src/users/users.service.ts:3',
    ]);
    expect(sitesOf(run(backend, rule))).toEqual([
      'src/main.ts:1',
      'src/main.ts:2',
      'src/orders/orders.controller.ts:2',
      'src/orders/orders.service.ts:1',
      'src/orders/orders.service.ts:2',
      'src/users/users.service.ts:3',
    ]);
  });

  it('with the file strategy it warns once and reports nothing', () => {
    const perFile = inputFor('layered-backend', { type: 'file' });
    const evaluation = run(perFile, {
      type: 'private',
      id: 'MODULE-REPO-PRIVATE-001',
      paths: ['**/repositories/**'],
      message: 'Private.',
    });

    expect(evaluation.violations).toEqual([]);
    expect(evaluation.warnings).toEqual([
      'rule MODULE-REPO-PRIVATE-001: `private` does nothing with the `file` component strategy',
    ]);
  });
});

describe('no-cycles', () => {
  it('file level: one violation per group at the first hop’s earliest eligible site; identity uses sorted members', () => {
    const evaluation = run(backend, { type: 'no-cycles', id: 'NO-CYCLE-001', level: 'file' });

    expect(evaluation.violations).toHaveLength(1);
    const [cycle] = evaluation.violations;
    const members = ['src/orders/orders.service.ts', 'src/users/users.service.ts'];
    expect(cycle).toMatchObject({
      kind: 'cycle',
      from: 'src/orders/orders.service.ts',
      to: { file: 'src/users/users.service.ts' },
      message:
        'Import cycle between 2 files: src/orders/orders.service.ts → src/users/users.service.ts → src/orders/orders.service.ts. Remove or invert one of these imports.',
    });
    expect(cycle.site?.line).toBe(2);
    expect(cycle.witness?.members).toEqual(members);
    expect(cycle.witness?.hops.map((hop) => [hop.fromFile, hop.site.line])).toEqual([
      ['src/orders/orders.service.ts', 2],
      ['src/users/users.service.ts', 3],
    ]);
    expect(cycle.identity).toEqual(['cycle', 'NO-CYCLE-001', REPO_SCOPE, 'error', 'file', members]);
  });

  it('component level: names the components and points at one concrete import', () => {
    const evaluation = run(backend, {
      type: 'no-cycles',
      id: 'MODULE-NO-CYCLE-001',
      level: 'component',
    });

    expect(evaluation.violations).toHaveLength(1);
    const [cycle] = evaluation.violations;
    // The root bucket is a group too: main.ts imports the users controller and
    // users.service imports config.ts, so the bucket is in the same tangle.
    expect(cycle.witness?.members).toEqual([
      'dir:proj:(repo):src/orders',
      'dir:proj:(repo):src/users',
      'root:proj:(repo)',
    ]);
    expect(cycle.from).toBe('src/orders/orders.controller.ts');
    expect(cycle.site?.line).toBe(2);
    expect(cycle.message).toBe(
      'Import cycle between 3 components: src/orders → src/users → src/orders. Remove or invert one of these imports.',
    );
  });

  it('package level without workspace packages reports nothing; ignoreTypeOnly defaults to true', () => {
    expect(run(backend, { type: 'no-cycles', id: 'PKG', level: 'package' }).violations).toEqual([]);
    const cycles = inputFor('cycles');
    expect(run(cycles, { type: 'no-cycles', id: 'C', level: 'file' }).violations).toHaveLength(3);
    expect(
      run(cycles, { type: 'no-cycles', id: 'C', level: 'file', ignoreTypeOnly: false }).violations,
    ).toHaveLength(5);
  });

  it('a project-scoped instance only sees its own files', () => {
    const scope = new Set(
      backend.graph.files().filter((file) => file !== 'src/users/users.service.ts'),
    );
    const evaluation = evaluateRules(backend, [
      {
        rule: { type: 'no-cycles', id: 'node/no-cycles', level: 'file' },
        projectId: REPO_SCOPE,
        scopeFiles: scope,
        origin: 'preset',
      },
    ]);
    expect(evaluation.violations).toEqual([]);
  });
});

describe('coverage', () => {
  const MESSAGE =
    'File belongs to no declared component. Add it to a component pattern or to `allowUnmatched`.';

  it('unassigned files violate when requireAll is on; the violation has no to and no site', () => {
    const strict = inputFor('layered-backend', BY_FOLDER, { requireAll: true, allowUnmatched: [] });
    const evaluation = evaluateRules(strict, []);

    expect(evaluation.violations.map((violation) => violation.from)).toEqual([
      'src/config.ts',
      'src/main.ts',
    ]);
    const [first] = evaluation.violations;
    expect(first).toMatchObject({
      kind: 'coverage',
      ruleId: 'components/coverage',
      projectId: REPO_SCOPE,
      severity: 'error',
      message: MESSAGE,
    });
    expect(first.to).toBeUndefined();
    expect(first.site).toBeUndefined();
    expect(first.identity).toEqual([
      'coverage',
      'components/coverage',
      REPO_SCOPE,
      'error',
      'src/config.ts',
    ]);
  });

  it('allowUnmatched exempts files; requireAll off reports nothing', () => {
    const allowed = inputFor('layered-backend', BY_FOLDER, {
      requireAll: true,
      allowUnmatched: ['src/main.ts'],
    });
    expect(evaluateRules(allowed, []).violations.map((violation) => violation.from)).toEqual([
      'src/config.ts',
    ]);

    const relaxed = inputFor('layered-backend', BY_FOLDER, {
      requireAll: false,
      allowUnmatched: [],
    });
    expect(evaluateRules(relaxed, []).violations).toEqual([]);
  });
});

describe('violations as data', () => {
  const everything = run(
    backend,
    { type: 'forbidden', id: 'A', from: ['src/**'], to: ['src/**'], message: 'Every import.' },
    { type: 'no-cycles', id: 'B', level: 'component' },
  );

  it('serialised violations contain no node field', () => {
    const json = JSON.stringify(everything.violations);
    expect(json).not.toContain('"node"');
    expect(everything.violations.length).toBeGreaterThan(10);
  });

  it('identity ignores line, column and message and includes severity; the fingerprint is the sha1 of its JSON', () => {
    const [violation] = everything.violations;
    const { identity: _identity, fingerprint: _fingerprint, ...draft } = violation;

    expect(violation.identity).toEqual([
      'import',
      'A',
      REPO_SCOPE,
      'error',
      'src/main.ts',
      ['file', 'src/users/users.controller.ts'],
      './users/users.controller',
    ]);
    expect(
      identityOf({
        ...draft,
        message: 'Other words.',
        site: { ...draft.site!, line: 40, column: 2 },
      }),
    ).toEqual(violation.identity);
    expect(identityOf({ ...draft, severity: 'warn' })).not.toEqual(violation.identity);
    expect(violation.fingerprint).toBe(
      createHash('sha1').update(JSON.stringify(violation.identity)).digest('hex'),
    );
    expect(fingerprint(violation.identity)).toBe(violation.fingerprint);
  });

  it('a module target is encoded as ["module", id]', () => {
    const [violation] = run(external, forbiddenModules(['axios'])).violations;
    expect(violation.identity[5]).toEqual(['module', 'axios']);
  });

  it('violations are sorted by file, line, column and rule', () => {
    const keys = everything.violations.map((violation) => [
      violation.from,
      violation.site?.line ?? 0,
      violation.site?.column ?? 0,
      violation.ruleId,
    ]);
    const sorted = [...keys].sort((left, right) =>
      left[0] !== right[0]
        ? String(left[0]) < String(right[0])
          ? -1
          : 1
        : Number(left[1]) - Number(right[1]) ||
          Number(left[2]) - Number(right[2]) ||
          (left[3] < right[3] ? -1 : 1),
    );
    expect(keys).toEqual(sorted);
  });

  it('severity off skips a rule; warn is carried into the violation', () => {
    const rule: RuleDefinition = { type: 'no-cycles', id: 'C', level: 'file' };
    expect(run(backend, { ...rule, severity: 'off' }).violations).toEqual([]);
    expect(run(backend, { ...rule, severity: 'warn' }).violations[0].severity).toBe('warn');
  });
});

describe('instances, scopes and warnings', () => {
  const nothing: RuleDefinition = {
    type: 'forbidden',
    id: 'EMPTY-001',
    from: ['src/nothing/**'],
    to: ['src/**'],
    message: 'Nothing.',
  };

  it('a user rule whose globs match nothing warns; a preset instance does not', () => {
    expect(run(backend, nothing).warnings).toEqual([
      'rule EMPTY-001 matches no files: from [src/nothing/**]',
    ]);
    expect(
      run(backend, {
        type: 'private',
        id: 'EMPTY-002',
        paths: ['**/nowhere/**'],
        message: 'Nothing.',
      }).warnings,
    ).toEqual(['rule EMPTY-002 matches no files: paths [**/nowhere/**]']);

    const preset = evaluateRules(backend, [{ ...userRule(nothing), origin: 'preset' }]);
    expect(preset.warnings).toEqual([]);
  });

  it('preset instances are evaluated per project scope; a user rule has repository scope', () => {
    const apps = inputFor('multi-app-no-workspaces');
    const rule = forbiddenModules(['left-pad']);
    const filesOf = (dir: string) =>
      new Set(apps.graph.files().filter((file) => file.startsWith(dir)));
    const preset = (projectId: string, dir: string): RuleInstance => ({
      rule,
      projectId,
      scopeFiles: filesOf(dir),
      origin: 'preset',
    });

    const evaluation = evaluateRules(apps, [
      preset('proj:apps/admin', 'apps/admin/'),
      preset('proj:apps/web', 'apps/web/'),
      userRule(rule),
    ]);
    expect(evaluation.violations.map((violation) => [violation.projectId, violation.from])).toEqual(
      [
        ['proj:(repo)', 'apps/web/src/uses-left-pad.ts'],
        ['proj:apps/web', 'apps/web/src/uses-left-pad.ts'],
      ],
    );
  });

  it('userRuleInstances gives repository-scoped instances and rejects duplicate ids', () => {
    const rule: RuleDefinition = { type: 'no-cycles', id: 'NO-CYCLE-001', level: 'file' };
    expect(userRuleInstances([rule, { id: 'nest/layers', severity: 'warn' }])).toEqual([
      userRule(rule),
    ]);
    expect(() => userRuleInstances([rule, { ...rule, level: 'component' }])).toThrow(ConfigError);
    expect(() => userRuleInstances([rule, { id: 'NO-CYCLE-001', severity: 'warn' }])).toThrow(
      'Duplicate rule id: NO-CYCLE-001',
    );
  });

  it('the rule schema rejects bad shapes and accepts an override entry', () => {
    const accepts = (value: unknown) => ruleConfigSchema.safeParse(value).success;
    const privateRule = { type: 'private', id: 'P', message: 'Private.' };

    expect(accepts({ id: 'nest/layers', severity: 'warn' })).toBe(true);
    expect(accepts({ ...privateRule, paths: ['a/**'] })).toBe(true);
    expect(accepts({ ...privateRule, paths: ['a/**'], public: ['index.ts'] })).toBe(false);
    expect(accepts(privateRule)).toBe(false);
    expect(accepts({ type: 'no-cycles', id: 'C', level: 'file', extra: true })).toBe(false);
    expect(accepts({ type: 'forbidden', id: 'F', message: 'M', from: ['a'], to: {} })).toBe(false);
    expect(
      accepts({
        type: 'layers',
        id: 'L',
        layers: { a: ['a/**'] },
        disallow: { a: [{ layer: 'b' }] },
      }),
    ).toBe(false);
  });

  it('returns the instances it was given', () => {
    const instances = [userRule(nothing)];
    expect(evaluateRules(backend, instances).instances).toEqual(instances);
  });
});

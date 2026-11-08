import { describe, expect, it } from 'vitest';

import { assignComponents } from '../components/assignComponents';
import { buildGroupGraph } from '../components/groupGraph';
import type { ComponentStrategy } from '../components/types';
import { computeMetrics, type AbstractnessMode, type Metrics } from '../metrics/computeMetrics';
import { buildSymbolIndex } from '../symbols/symbolIndex';
import { buildFixtureParts } from './helpers/fixtureGraph';

function metricsFor(name: string, strategy: ComponentStrategy, mode: AbstractnessMode) {
  const parts = buildFixtureParts(name);
  const assignment = assignComponents(parts.ctx, parts.graph.files(), () => strategy);
  const component = buildGroupGraph(parts.graph, assignment, 'component', parts.sites);
  const index = buildSymbolIndex(parts.graph, parts.parsed, parts.sites);
  const groups =
    assignment.packages.length === 0
      ? { component }
      : { component, package: buildGroupGraph(parts.graph, assignment, 'package', parts.sites) };
  return computeMetrics(parts.graph, groups, index, mode);
}

const oneComponent: ComponentStrategy = { type: 'directory', patterns: ['src'] };
const implemented = metricsFor('heritage', oneComponent, 'implemented');
const jdepend = metricsFor('heritage', oneComponent, 'jdepend');
const workspace = metricsFor(
  'pnpm-monorepo',
  { type: 'directory', patterns: ['src', 'scripts'] },
  'implemented',
);

const byId = (list: Metrics[], id: string): Metrics => {
  const found = list.find((metrics) => metrics.id === id);
  if (found === undefined) throw new Error(`no metrics for ${id}`);
  return found;
};

// [exported declarations, abstract declarations] for one file.
const declarationCounts = (list: Metrics[], file: string): [number, number] => {
  const metrics = byId(list, `src/${file}`);
  return [metrics.exported, metrics.abstract];
};

describe('computeMetrics: abstractness', () => {
  it('implemented: an interface counts as abstract only when a class implements it, including through interface ancestry and alias-to-interface', () => {
    const files = implemented.file;

    expect(declarationCounts(files, 'ancestry.ts')).toEqual([3, 2]);
    expect(declarationCounts(files, 'alias-target.ts')).toEqual([3, 1]);
    expect(declarationCounts(files, 'shapes.ts')).toEqual([4, 2]);
    expect(declarationCounts(files, 'repository.ts')).toEqual([1, 1]);
    expect(declarationCounts(files, 'cycle-b.ts')).toEqual([1, 1]);
  });

  it('an interface named only by an unresolved reference stays concrete', () => {
    expect(declarationCounts(implemented.file, 'dup-a.ts')).toEqual([1, 0]);
    expect(declarationCounts(implemented.file, 'dup-b.ts')).toEqual([1, 0]);
  });

  it('jdepend: every interface, type alias and abstract class is abstract', () => {
    const files = jdepend.file;

    expect(declarationCounts(files, 'contract.ts')).toEqual([3, 3]);
    expect(declarationCounts(files, 'alias-target.ts')).toEqual([3, 2]);
    expect(declarationCounts(files, 'shapes.ts')).toEqual([4, 4]);
    expect(declarationCounts(files, 'merging.ts')).toEqual([3, 3]);
    expect(declarationCounts(files, 'repository.ts')).toEqual([1, 1]);
    expect(declarationCounts(files, 'type-context.ts')).toEqual([2, 1]);
    expect(declarationCounts(files, 'functions.ts')).toEqual([7, 0]);
  });

  it('declaration merging is one identity; overloads one; export lists none; anonymous default one concrete', () => {
    const files = implemented.file;

    expect(declarationCounts(files, 'merging.ts')).toEqual([3, 0]);
    expect(declarationCounts(files, 'functions.ts')).toEqual([7, 0]);
    expect(declarationCounts(files, 'default-expression.ts')).toEqual([1, 0]);
    expect(declarationCounts(files, 'named-barrel.ts')).toEqual([0, 0]);
    expect(declarationCounts(files, 'types.ts')).toEqual([0, 0]);
  });

  it('a class in an excluded spec file does not make an interface abstract', () => {
    expect(declarationCounts(implemented.file, 'contract.ts')).toEqual([3, 2]);
    expect(implemented.file.some((metrics) => metrics.id.endsWith('.spec.ts'))).toBe(false);
  });

  it('counts unresolved heritage where the reference is written, at every level', () => {
    expect(byId(implemented.file, 'src/external.ts').unresolvedHeritage).toBe(3);
    expect(byId(implemented.file, 'src/ambiguous.ts').unresolvedHeritage).toBe(1);
    expect(byId(implemented.component, 'dir:proj:(repo):src').unresolvedHeritage).toBe(5);
  });
});

describe('computeMetrics: coupling', () => {
  it('Ca and Ce count distinct groups at each level; package metrics are not averages of component metrics', () => {
    const cond = byId(workspace.component, 'dir:proj:packages/cond:packages/cond/src');
    const condPackage = byId(workspace.package, 'pkg:packages/cond');

    // Two components of @demo/a import cond: two neighbours as components, one as a package.
    expect([cond.Ca, cond.Ce]).toEqual([3, 0]);
    expect([condPackage.Ca, condPackage.Ce]).toEqual([2, 0]);
    expect(
      [byId(workspace.package, 'pkg:packages/a')].map((m) => [m.Ca, m.Ce, m.instability]),
    ).toEqual([[0, 2, 1]]);
    expect(byId(workspace.package, 'pkg:(workspace-root)').Ce).toBe(1);
  });

  it("a package's declarations are its own files' declarations", () => {
    const own = workspace.file.filter((metrics) => metrics.id.startsWith('packages/b/'));
    const pkg = byId(workspace.package, 'pkg:packages/b');

    expect(pkg.exported).toBe(own.reduce((total, metrics) => total + metrics.exported, 0));
    expect(pkg.exported).toBeGreaterThan(0);
  });

  it('Ca and Ce count distinct files at the file level', () => {
    expect([
      byId(implemented.file, 'src/contract.ts').Ca,
      byId(implemented.file, 'src/contract.ts').Ce,
    ]).toEqual([4, 0]);
    expect([
      byId(implemented.file, 'src/named-barrel.ts').Ca,
      byId(implemented.file, 'src/named-barrel.ts').Ce,
    ]).toEqual([2, 1]);
  });

  it('external modules do not count in Ce', () => {
    // external.ts imports node:events and ./shapes; only ./shapes is a neighbour.
    expect(byId(implemented.file, 'src/external.ts').Ce).toBe(1);
  });

  it('instability null when Ca+Ce=0; abstractness null with no exports; distance only when both non-null', () => {
    const pick = (file: string) => {
      const m = byId(implemented.file, `src/${file}`);
      return [m.instability, m.abstractness, m.distance];
    };

    expect(pick('default-expression.ts')).toEqual([null, 0, null]);
    expect(pick('named-barrel.ts')).toEqual([1 / 3, null, null]);
    expect(pick('repository.ts')).toEqual([0, 1, 0]);
    expect(byId(implemented.file, 'src/contract.ts').distance).toBeCloseTo(1 / 3);
  });
});

describe('computeMetrics: shape', () => {
  it('gives every file and group one entry at its level, sorted by id', () => {
    const fileIds = implemented.file.map((metrics) => metrics.id);

    expect(fileIds).toEqual([...fileIds].sort());
    expect(fileIds).toHaveLength(29);
    expect(implemented.component.map((metrics) => [metrics.id, metrics.level])).toEqual([
      ['dir:proj:(repo):src', 'component'],
    ]);
    expect(new Set(implemented.file.map((metrics) => metrics.level))).toEqual(new Set(['file']));
    expect(workspace.package.map((metrics) => metrics.id)).toEqual([
      'pkg:(workspace-root)',
      'pkg:packages/a',
      'pkg:packages/b',
      'pkg:packages/cond',
      'pkg:packages/esm',
    ]);
  });

  it('a repo without workspaces has no package metrics', () => {
    expect(implemented.package).toEqual([]);
  });
});

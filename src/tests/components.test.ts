import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { assignComponents } from '../components/assignComponents';
import { buildGroupGraph } from '../components/groupGraph';
import type { ComponentStrategy } from '../components/types';
import type { SiteRecord } from '../graph/buildFileGraph';
import { FileGraph, type FileEdge } from '../graph/fileGraph';
import type { ImportSite } from '../parser/types';
import { discoverProject } from '../project/discoverProject';
import type { ProjectContext } from '../project/types';
import { FIXTURES, buildFixture } from './helpers/fixtureGraph';

const context = (name: string): ProjectContext => discoverProject(join(FIXTURES, name));

const directory = (...patterns: string[]): (() => ComponentStrategy) => {
  return () => ({ type: 'directory', patterns });
};

const assign = (name: string, files: string[], strategy: () => ComponentStrategy) => {
  return assignComponents(context(name), files, strategy);
};

function site(specifier: string, loadsTarget: boolean): ImportSite {
  return { specifier, loadsTarget, kind: loadsTarget ? 'static' : 'type' } as ImportSite;
}

function edgeBetween(from: string, to: string, loadsTarget: boolean): FileEdge {
  return { from, to, sites: [site(`./${to}`, loadsTarget)], runtime: loadsTarget, mapped: false };
}

function recordsOf(edges: FileEdge[]): SiteRecord[] {
  return edges.flatMap((edge) =>
    edge.sites.map((s) => ({
      file: edge.from,
      site: s,
      resolution: { class: 'internal' as const, target: { file: edge.to } },
    })),
  );
}

describe('assignComponents: directory strategy', () => {
  it('directory: first matching ancestor pattern wins, nested files included', () => {
    const files = ['src/bookings/orders/dto/x.ts', 'src/bookings/booking.module.ts'];
    const result = assign('nest-cjs', files, directory('src/bookings/*', 'src/*'));

    expect(result.componentOf.get(files[0])?.id).toBe('dir:proj:(repo):src/bookings/orders');
    expect(result.componentOf.get(files[1])?.id).toBe('dir:proj:(repo):src/bookings');
    expect(result.warnings).toEqual([]);
  });

  it('directory: a broad pattern listed first shadows a narrow one and warns', () => {
    const files = ['src/features/cart/x.ts', 'src/features/search/y.ts'];
    const result = assign('nest-cjs', files, directory('src/*', 'src/features/*'));

    expect(result.componentOf.get(files[0])?.id).toBe('dir:proj:(repo):src/features');
    expect(result.warnings).toEqual([
      'pattern `src/features/*` is shadowed by `src/*`; list narrower patterns first.',
    ]);
  });

  it('a narrow pattern listed first is not reported as shadowed', () => {
    const files = ['lib/cart/items/x.ts'];

    expect(assign('nest-cjs', files, directory('lib/cart/*', 'lib/*')).warnings).toEqual([]);
    expect(assign('nest-cjs', files, directory('lib/*', 'lib/cart/*')).warnings).toEqual([
      'pattern `lib/cart/*` is shadowed by `lib/*`; list narrower patterns first.',
    ]);
  });

  it('a later pattern matching the same directory is not shadowed', () => {
    const files = ['lib/cart/x.ts'];

    expect(assign('nest-cjs', files, directory('lib/cart', 'lib/*')).warnings).toEqual([]);
  });

  it('warns once however many files and projects hit the shadowed pattern', () => {
    const files = ['tools/cli/src/a/b/x.ts', 'src/a/b/y.ts', 'src/a/b/z.ts'];
    const result = assign('nested-project', files, directory('src/*', 'src/a/*'));

    expect(result.warnings).toHaveLength(1);
  });

  it('unmatched files go to root:<projectId>', () => {
    const result = assign('nest-cjs', ['src/main.ts', 'src/a/b.ts'], directory('src/*'));

    expect(result.componentOf.get('src/main.ts')).toMatchObject({
      id: 'root:proj:(repo)',
      name: '(root)',
      directory: '',
      projectId: 'proj:(repo)',
      level: 'component',
    });
    expect(result.unassigned).toEqual(['src/main.ts']);
  });

  it('names the root bucket of a nested project after its directory', () => {
    const result = assign('nested-project', ['tools/cli/x.ts'], directory('src'));

    expect(result.componentOf.get('tools/cli/x.ts')).toMatchObject({
      id: 'root:proj:tools/cli',
      name: 'tools/cli/(root)',
      directory: 'tools/cli',
    });
  });

  it('ancestor matching stops at the project boundary', () => {
    const files = ['tools/cli/src/a.ts', 'tools/shared/x.ts'];
    const result = assign('nested-project', files, directory('tools/*', 'src'));

    expect(result.componentOf.get(files[0])?.id).toBe('dir:proj:tools/cli:tools/cli/src');
    expect(result.componentOf.get(files[1])?.id).toBe('dir:proj:(repo):tools/shared');
  });

  it('ancestor matching stops at the package boundary', () => {
    const files = ['packages/a/src/index.ts'];
    const result = assign('pnpm-monorepo', files, directory('packages/*', 'packages'));

    expect(result.componentOf.get(files[0])?.id).toBe('root:proj:packages/a');
    expect(result.unassigned).toEqual(files);
  });

  it('applies each project its own strategy', () => {
    const files = ['tools/cli/src/a.ts', 'src/a.ts'];
    const result = assignComponents(context('nested-project'), files, (project) =>
      project.dir === '' ? { type: 'file' } : { type: 'directory', patterns: ['src'] },
    );

    expect(result.componentOf.get(files[0])?.id).toBe('dir:proj:tools/cli:tools/cli/src');
    expect(result.componentOf.get(files[1])?.id).toBe('file:src/a.ts');
  });
});

describe('assignComponents: nest-module and file strategies', () => {
  const nest = (): ComponentStrategy => ({ type: 'nest-module' });

  it('nest-module: nearest ancestor with a *.module.ts, nested modules', () => {
    const files = [
      'scripts/seed.ts',
      'src/app.module.ts',
      'src/main.ts',
      'src/users/admin/admin.module.ts',
      'src/users/admin/dto/a.ts',
      'src/users/dto/x.ts',
      'src/users/users.module.ts',
    ];
    const { componentOf, unassigned } = assign('nest-cjs', files, nest);

    expect(componentOf.get('src/main.ts')?.id).toBe('dir:proj:(repo):src');
    expect(componentOf.get('src/users/dto/x.ts')?.id).toBe('dir:proj:(repo):src/users');
    expect(componentOf.get('src/users/admin/dto/a.ts')?.id).toBe('dir:proj:(repo):src/users/admin');
    expect(componentOf.get('scripts/seed.ts')?.id).toBe('root:proj:(repo)');
    expect(unassigned).toEqual(['scripts/seed.ts']);
  });

  it('nest-module: a module beside package.json owns the project directory', () => {
    const files = ['app.module.ts', 'src/a.ts'];
    const { componentOf, unassigned } = assign('nest-cjs', files, nest);

    expect(componentOf.get('src/a.ts')).toMatchObject({
      id: 'dir:proj:(repo):.',
      name: '.',
      directory: '',
    });
    expect(unassigned).toEqual([]);
  });

  it('nest-module: a parent project module never claims a nested project file', () => {
    const files = ['tools/tools.module.ts', 'tools/cli/src/b.ts'];
    const { componentOf } = assign('nested-project', files, nest);

    expect(componentOf.get('tools/cli/src/b.ts')?.id).toBe('root:proj:tools/cli');
  });

  it('file strategy ids are file:<path> and never collide in one directory', () => {
    const files = ['src/a.ts', 'src/b.ts'];
    const result = assign('nest-cjs', files, () => ({ type: 'file' }));

    expect(result.components.map((group) => group.id)).toEqual(['file:src/a.ts', 'file:src/b.ts']);
    expect(result.components[0]).toMatchObject({ name: 'src/a.ts', directory: 'src' });
    expect(result.unassigned).toEqual([]);
  });
});

describe('assignComponents: packages', () => {
  it('packages: every file has the nearest declared package or null; files outside packages aggregate into pkg:(workspace-root)', () => {
    const files = ['packages/a/src/index.ts', 'packages/b/src/index.ts', 'scripts/seed.ts'];
    const result = assign('pnpm-monorepo', files, directory('src', 'scripts'));

    expect(result.packageOf.get(files[0])).toMatchObject({
      id: 'pkg:packages/a',
      name: '@demo/a',
      directory: 'packages/a',
      projectId: 'proj:packages/a',
      packageId: 'pkg:packages/a',
      level: 'package',
    });
    expect(result.packageOf.get('scripts/seed.ts')).toBeNull();
    expect(result.componentOf.get(files[0])?.packageId).toBe('pkg:packages/a');
    expect(result.componentOf.get('scripts/seed.ts')?.packageId).toBeNull();
    expect(result.packages.map((group) => group.id)).toEqual([
      'pkg:(workspace-root)',
      'pkg:packages/a',
      'pkg:packages/b',
    ]);
  });

  it('a repo without workspaces has no package level', () => {
    const result = assign('nest-cjs', ['src/main.ts'], directory('src'));

    expect(result.packageOf.get('src/main.ts')).toBeNull();
    expect(result.packages).toEqual([]);
  });

  it('typed ids never collide across strategies and levels', () => {
    const files = ['packages/a/src/index.ts', 'scripts/seed.ts', 'other.ts'];
    const result = assignComponents(context('pnpm-monorepo'), files, (project) =>
      project.dir === '' ? { type: 'directory', patterns: ['scripts'] } : { type: 'file' },
    );
    const ids = [...result.components, ...result.packages].map((group) => group.id);

    expect(ids).toEqual([
      'dir:proj:(repo):scripts',
      'file:packages/a/src/index.ts',
      'root:proj:(repo)',
      'pkg:(workspace-root)',
      'pkg:packages/a',
    ]);
  });
});

describe('buildGroupGraph', () => {
  const files = ['src/a/one.ts', 'src/a/two.ts', 'src/b/three.ts', 'src/c/four.ts'];
  const edges = [
    edgeBetween('src/a/one.ts', 'src/a/two.ts', true),
    edgeBetween('src/a/one.ts', 'src/b/three.ts', false),
    edgeBetween('src/a/two.ts', 'src/b/three.ts', true),
    edgeBetween('src/a/two.ts', 'src/c/four.ts', false),
  ];
  const graph = new FileGraph(files, edges);
  const assignment = assign('nest-cjs', files, directory('src/*'));
  const groupGraph = buildGroupGraph(graph, assignment, 'component', recordsOf(edges));
  const group = (name: string) => groupGraph.groups.find((g) => g.name === name)!;

  it('group edges aggregate sites, drop intra-group edges, keep runtime flag', () => {
    const summary = groupGraph.edges.map((edge) => [
      edge.from.name,
      edge.to.name,
      edge.sites.length,
      edge.fileEdges.length,
      edge.runtime,
    ]);

    expect(summary).toEqual([
      ['src/a', 'src/b', 2, 2, true],
      ['src/a', 'src/c', 1, 1, false],
    ]);
  });

  it('carries the original records, resolution included', () => {
    const [first] = groupGraph.edges;

    expect(first.sites.map((record) => record.file)).toEqual(['src/a/one.ts', 'src/a/two.ts']);
    expect(first.sites[0].resolution.class).toBe('internal');
  });

  it('indexes edges by group in both directions', () => {
    expect(groupGraph.edgesFrom(group('src/a')).map((edge) => edge.to.name)).toEqual([
      'src/b',
      'src/c',
    ]);
    expect(groupGraph.edgesTo(group('src/b')).map((edge) => edge.from.name)).toEqual(['src/a']);
    expect(groupGraph.edgesFrom(group('src/c'))).toEqual([]);
  });

  it('keeps a group that has no edges', () => {
    const lonely = new FileGraph(['src/a/one.ts'], []);
    const result = buildGroupGraph(
      lonely,
      assign('nest-cjs', ['src/a/one.ts'], directory('src/*')),
      'component',
      [],
    );

    expect(result.groups.map((g) => g.name)).toEqual(['src/a']);
    expect(result.edges).toEqual([]);
  });

  it('aggregates a real workspace by package, with the workspace-root bucket', () => {
    const { graph: real, sites } = buildFixture('pnpm-monorepo');
    const packages = assignComponents(context('pnpm-monorepo'), real.files(), directory('src'));
    const result = buildGroupGraph(real, packages, 'package', sites);
    const pairs = result.edges.map((edge) => [edge.from.id, edge.to.id]);

    expect(result.level).toBe('package');
    expect(result.groups.map((g) => g.id)).toContain('pkg:(workspace-root)');
    expect(pairs).toContainEqual(['pkg:packages/a', 'pkg:packages/b']);
    expect(pairs.every(([from, to]) => from !== to)).toBe(true);
    expect(result.edges.every((edge) => edge.sites.length > 0)).toBe(true);
  });

  it('lists the files of each group', () => {
    expect(groupGraph.filesOf(group('src/a'))).toEqual(['src/a/one.ts', 'src/a/two.ts']);
    expect(groupGraph.filesOf(group('src/c'))).toEqual(['src/c/four.ts']);
  });

  it('puts files outside every package in the workspace-root bucket at the package level', () => {
    const { graph: real, sites } = buildFixture('pnpm-monorepo');
    const packages = assignComponents(context('pnpm-monorepo'), real.files(), directory('src'));
    const result = buildGroupGraph(real, packages, 'package', sites);
    const bucket = result.groups.find((g) => g.id === 'pkg:(workspace-root)')!;

    expect(result.filesOf(bucket)).toEqual(['scripts/seed.ts', 'scripts/util.ts']);
  });

  it('a repo without workspaces has an empty package graph', () => {
    const result = buildGroupGraph(graph, assignment, 'package', recordsOf(edges));

    expect(result.groups).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

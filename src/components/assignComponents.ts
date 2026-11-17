import picomatch from 'picomatch';

import type { Project, ProjectContext, WorkspacePackage } from '../project/types';
import { posixDirname } from '../resolver/workspaceHost';
import type { Assignment, ComponentStrategy, Group } from './types';

export const WORKSPACE_ROOT_PACKAGE = 'pkg:(workspace-root)';

const NEST_MODULE = /\.module\.ts$/;

type Placement = Pick<Group, 'id' | 'name' | 'directory'>;

// Finds the component a file belongs to, or null for its project's root bucket.
type Locator = (file: string) => Placement | null;

export function assignComponents(
  ctx: ProjectContext,
  files: string[],
  strategyFor: (project: Project) => ComponentStrategy,
): Assignment {
  const moduleDirs = new Map<string, Set<string>>();
  for (const file of files) {
    if (!NEST_MODULE.test(file)) continue;
    const projectId = ctx.projectFor(file).id;
    const dirs = moduleDirs.get(projectId) ?? new Set<string>();
    dirs.add(posixDirname(file));
    moduleDirs.set(projectId, dirs);
  }
  const locators = new Map<string, Locator>();
  const components = new Map<string, Group>();
  const packages = new Map<string, Group>();
  const warnings = new Set<string>();
  const assignment: Assignment = {
    componentOf: new Map(),
    packageOf: new Map(),
    components: [],
    packages: [],
    unassigned: [],
    warnings: [],
  };

  for (const file of [...files].sort()) {
    const project = ctx.projectFor(file);
    const pkg = ctx.packageFor(file);
    let locate = locators.get(project.id);
    if (locate === undefined) {
      const dirs = moduleDirs.get(project.id) ?? new Set<string>();
      locate = createLocator(project, strategyFor(project), dirs, warnings);
      locators.set(project.id, locate);
    }

    const placement = locate(file);
    if (placement === null) assignment.unassigned.push(file);

    const component: Group = {
      ...(placement ?? rootBucket(project)),
      projectId: project.id,
      packageId: pkg?.id ?? null,
      level: 'component',
    };
    assignment.componentOf.set(file, intern(components, component));

    if (pkg !== null) {
      assignment.packageOf.set(file, intern(packages, packageGroup(ctx, pkg)));
    } else {
      assignment.packageOf.set(file, null);
      if (ctx.packages.length > 0) intern(packages, workspaceRootGroup());
    }
  }

  assignment.components = sortedGroups(components);
  assignment.packages = sortedGroups(packages);
  assignment.warnings = [...warnings].sort();
  return assignment;
}

function createLocator(
  project: Project,
  strategy: ComponentStrategy,
  moduleDirs: Set<string>,
  warnings: Set<string>,
): Locator {
  switch (strategy.type) {
    case 'file':
      return (file) => ({ id: `file:${file}`, name: file, directory: posixDirname(file) });
    case 'nest-module':
      return nestModuleLocator(project, moduleDirs);
    case 'directory':
      return directoryLocator(project, strategy.patterns, warnings);
  }
}

// Patterns are tried in order and the first to match any ancestor wins, so a
// catch-all like `src/*` can follow narrower patterns. Ancestors are listed
// nearest first, which makes a lower position a deeper directory: a later
// pattern that reaches deeper than the winner is one the user's order shadowed.
function directoryLocator(project: Project, patterns: string[], warnings: Set<string>): Locator {
  const matchers = patterns.map((pattern) => picomatch(pattern, { dot: true }));

  return (file) => {
    const ancestors = ancestorsBelow(file, project.dir);
    const relative = ancestors.map((dir) => relativeTo(dir, project.dir));
    const positions = matchers.map((matches) => relative.findIndex((dir) => matches(dir)));
    const winner = positions.findIndex((position) => position !== -1);
    if (winner === -1) return null;

    positions.forEach((position, index) => {
      if (index > winner && position !== -1 && position < positions[winner]) {
        warnings.add(
          `pattern \`${patterns[index]}\` is shadowed by \`${patterns[winner]}\`; list narrower patterns first.`,
        );
      }
    });
    return directoryPlacement(project, ancestors[positions[winner]]);
  };
}

// `moduleDirs` holds this project's module directories. The outermost one with
// modules below it is the application's root module, AppModule in src/. Every
// other file it would claim (main.ts, bootstrap helpers, src/common) is shared
// or entry-point code: counted as part of AppModule, which imports every
// feature module, any of them a feature imports would put AppModule in a cycle
// with that feature. So the root module keeps only its *.module.ts files, and
// the rest go to the root bucket, where each file stands alone in cycles.
function nestModuleLocator(project: Project, moduleDirs: Set<string>): Locator {
  const ancestorsOf = (dir: string): string[] =>
    dir === project.dir ? [] : [...ancestorsBelow(dir, project.dir), project.dir];
  const roots = new Set(
    [...moduleDirs].filter(
      (dir) =>
        !ancestorsOf(dir).some((ancestor) => moduleDirs.has(ancestor)) &&
        [...moduleDirs].some((other) => ancestorsOf(other).includes(dir)),
    ),
  );

  return (file) => {
    const owner = [...ancestorsBelow(file, project.dir), project.dir].find((dir) =>
      moduleDirs.has(dir),
    );
    if (owner === undefined) return null;
    if (roots.has(owner) && (posixDirname(file) !== owner || !NEST_MODULE.test(file))) {
      return null;
    }
    return directoryPlacement(project, owner);
  };
}

// Stopping at the project directory also stops at the package directory: every
// workspace package is a project, so a package never sits above a file's project.
function ancestorsBelow(file: string, boundary: string): string[] {
  const ancestors: string[] = [];
  for (let dir = posixDirname(file); dir !== boundary && dir !== ''; dir = posixDirname(dir)) {
    ancestors.push(dir);
  }
  return ancestors;
}

function relativeTo(dir: string, base: string): string {
  return base === '' ? dir : dir.slice(base.length + 1);
}

function directoryPlacement(project: Project, dir: string): Placement {
  const shown = dir === '' ? '.' : dir;
  return { id: `dir:${project.id}:${shown}`, name: shown, directory: dir };
}

// A project's root bucket or the workspace-root package: the files nothing
// claimed, not a unit anyone designed.
export function isBucket(group: Group): boolean {
  return group.id.startsWith('root:') || group.id === WORKSPACE_ROOT_PACKAGE;
}

function rootBucket(project: Project): Placement {
  return {
    id: `root:${project.id}`,
    name: project.dir === '' ? '(root)' : `${project.dir}/(root)`,
    directory: project.dir,
  };
}

function packageGroup(ctx: ProjectContext, pkg: WorkspacePackage): Group {
  return {
    id: pkg.id,
    name: pkg.name,
    directory: pkg.dir,
    projectId: ctx.projectFor(`${pkg.dir}/package.json`).id,
    packageId: pkg.id,
    level: 'package',
  };
}

function workspaceRootGroup(): Group {
  return {
    id: WORKSPACE_ROOT_PACKAGE,
    name: '(workspace-root)',
    directory: '',
    projectId: 'proj:(repo)',
    packageId: WORKSPACE_ROOT_PACKAGE,
    level: 'package',
  };
}

function intern(groups: Map<string, Group>, group: Group): Group {
  const existing = groups.get(group.id);
  if (existing !== undefined) return existing;
  groups.set(group.id, group);
  return group;
}

function sortedGroups(groups: Map<string, Group>): Group[] {
  return [...groups.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

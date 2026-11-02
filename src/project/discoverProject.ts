import { execFileSync } from 'node:child_process';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import picomatch from 'picomatch';
import * as ts from 'typescript';
import { parse as parseYaml } from 'yaml';

import { ConfigError } from '../errors';
import {
  isDir,
  isFile,
  nodeFileSystem,
  toPosix,
  tryRead,
  tryStat,
  type FileSystemLike,
} from '../fs';
import { createIgnoreMatcher, shouldSkipDir, type IgnoreMatcher } from './gitignore';
import type {
  DiscoverOptions,
  Project,
  ProjectContext,
  TsconfigEntry,
  WorkspacePackage,
} from './types';

const UNKNOWN_OPTION_CODES = new Set([5023, 5024, 5025]);

const BUNDLER_DEPENDENCIES = ['vite', 'next', 'webpack', '@rsbuild/core', '@tanstack/react-start'];

export function discoverProject(rootDir: string, opts: DiscoverOptions = {}): ProjectContext {
  const fs = opts.fs ?? nodeFileSystem();
  const root = realpathOrSelf(fs, rootDir);
  const gitTopLevel = findGitTopLevel(root);
  const localExclude = opts.localExclude ?? readLocalExclude(fs, gitTopLevel);
  const ignore = createIgnoreMatcher({
    rootDir: root,
    gitTopLevel,
    localExcludeBase: gitTopLevel ?? root,
    localExclude,
    fs,
  });

  const warnings: string[] = [];
  const unsupported: string[] = [];

  const tsconfigPaths: string[] = [];
  const packagePaths: string[] = [];
  walk(root, fs, ignore, (abs, rel) => {
    const name = basename(abs);
    if ((name.startsWith('tsconfig') || name.startsWith('jsconfig')) && name.endsWith('.json')) {
      tsconfigPaths.push(rel);
    } else if (name === 'package.json') {
      packagePaths.push(rel);
    }
  });

  const packageSet = new Set(packagePaths);
  const readPackage = (rel: string): Record<string, unknown> | null =>
    readJsonObject(fs, join(root, rel));

  const tsconfigs = tsconfigPaths.map((rel) => parseTsconfig(rel, root, warnings));

  const packages = readWorkspacePackages(root, fs, packageSet, readPackage);

  const isExcluded = opts.isExcluded ?? ((): boolean => false);
  const projectDirs = new Set<string>(['']);
  for (const rel of packagePaths) {
    if (isExcluded(rel)) continue;
    const pkg = readPackage(rel);
    if (pkg !== null && declaresDependencies(pkg)) projectDirs.add(dirOfPosix(rel));
  }
  for (const pkg of packages) projectDirs.add(pkg.dir);

  const projects: Project[] = [...projectDirs].sort().map((dir) => {
    const rel = dir === '' ? 'package.json' : `${dir}/package.json`;
    const pkg = packageSet.has(rel) ? readPackage(rel) : null;
    return {
      id: dir === '' ? 'proj:(repo)' : `proj:${dir}`,
      dir,
      dependencies: dependenciesOf(pkg),
      packageJson: pkg,
    };
  });

  if (isFile(fs, join(root, '.pnp.cjs')) && !isDir(fs, join(root, 'node_modules'))) {
    unsupported.push('yarn-pnp');
  }

  const projectFor = (file: string): Project => {
    const rel = normalizeRel(root, file);
    let best = projects[0];
    for (const project of projects) {
      if (isAncestorDir(project.dir, rel) && project.dir.length > best.dir.length) best = project;
    }
    return best;
  };

  const packageFor = (file: string): WorkspacePackage | null => {
    const rel = normalizeRel(root, file);
    let best: WorkspacePackage | null = null;
    for (const pkg of packages) {
      if (isAncestorDir(pkg.dir, rel) && (best === null || pkg.dir.length > best.dir.length)) {
        best = pkg;
      }
    }
    return best;
  };

  const optionsFor = (
    file: string,
  ): { options: ts.CompilerOptions; entry: TsconfigEntry | null } => {
    const rel = normalizeRel(root, file);
    const containing = tsconfigs.filter((entry) => entry.fileNames.has(rel));
    const entry = pickNearest(containing, rel) ?? pickNearestAncestor(tsconfigs, rel);
    if (entry === null) {
      const project = projectFor(rel);
      const fallback = fallbackOptions(project, rel, packageSet, readPackage);
      return { options: fallback, entry: null };
    }
    return { options: entry.options, entry };
  };

  const isIgnored = (path: string): boolean => {
    const abs = isAbsolute(path) ? path : join(root, path);
    return ignore.test(abs);
  };

  return {
    rootDir: root,
    gitTopLevel,
    projects,
    packages,
    tsconfigs,
    projectFor,
    packageFor,
    optionsFor,
    isIgnored,
    unsupported,
    warnings,
  };
}

function realpathOrSelf(fs: FileSystemLike, path: string): string {
  try {
    return fs.realpath(path);
  } catch {
    return path;
  }
}

function findGitTopLevel(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = out.trim();
    return line === '' ? null : line;
  } catch {
    return null;
  }
}

function readLocalExclude(fs: FileSystemLike, gitTopLevel: string | null): string[] {
  if (gitTopLevel === null) return [];
  const text = tryRead(fs, join(gitTopLevel, '.git', 'info', 'exclude'));
  if (text === null) return [];
  return text.split('\n');
}

function walk(
  root: string,
  fs: FileSystemLike,
  ignore: IgnoreMatcher,
  visit: (abs: string, rel: string) => void,
  dir: string = root,
  relDir = '',
): void {
  let entries: string[];
  try {
    entries = fs.readdir(dir);
  } catch {
    return;
  }
  entries.sort();

  for (const name of entries) {
    if (shouldSkipDir(name)) continue;
    const abs = join(dir, name);
    const stats = tryStat(fs, abs);
    if (stats === null) continue;
    if (!isInsideRoot(fs, root, abs)) continue;
    const rel = relDir === '' ? name : `${relDir}/${name}`;
    if (stats.isDirectory()) {
      if (ignore.test(abs, true)) continue;
      walk(root, fs, ignore, visit, abs, rel);
    } else if (stats.isFile()) {
      if (ignore.test(abs, false)) continue;
      visit(abs, rel);
    }
  }
}

function isInsideRoot(fs: FileSystemLike, root: string, abs: string): boolean {
  const real = realpathOrSelf(fs, abs);
  return real === root || real.startsWith(root + sep);
}

function parseTsconfig(rel: string, root: string, warnings: string[]): TsconfigEntry {
  const abs = join(root, rel);
  let unrecoverable: ts.Diagnostic | null = null;
  let parsed: ts.ParsedCommandLine | undefined;

  try {
    parsed = ts.getParsedCommandLineOfConfigFile(
      abs,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          unrecoverable = diagnostic;
        },
      },
    );
  } catch (error) {
    throw new ConfigError(
      `Cannot parse TypeScript config ${rel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed === undefined) {
    const detail = unrecoverable === null ? '' : `: ${flatten(unrecoverable)}`;
    throw new ConfigError(`Invalid TypeScript config ${rel}${detail}`);
  }

  let unknownOption = false;
  for (const diagnostic of parsed.errors) {
    if (UNKNOWN_OPTION_CODES.has(diagnostic.code)) {
      unknownOption = true;
      continue;
    }
    if (diagnostic.code === 18003) continue;
    throw new ConfigError(`Invalid TypeScript config ${rel}: ${flatten(diagnostic)}`);
  }
  if (unknownOption) warnings.push(`unknown-compiler-option: ${rel}`);

  const options = parsed.options;
  const fileNames = new Set(parsed.fileNames.map((file) => toPosix(relative(root, file))));
  const declaredRootDir =
    options.rootDir === undefined ? null : toPosix(relative(root, options.rootDir));

  return {
    configPath: rel,
    options,
    fileNames,
    rootDir: declaredRootDir ?? commonDir([...fileNames]) ?? dirOfPosix(rel),
    outDir: options.outDir === undefined ? undefined : toPosix(relative(root, options.outDir)),
    declarationDir:
      options.declarationDir === undefined
        ? undefined
        : toPosix(relative(root, options.declarationDir)),
  };
}

function flatten(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
}

function readWorkspacePackages(
  root: string,
  fs: FileSystemLike,
  packageSet: Set<string>,
  readPackage: (rel: string) => Record<string, unknown> | null,
): WorkspacePackage[] {
  const rootPackage = packageSet.has('package.json') ? readPackage('package.json') : null;
  const globs = readWorkspaceGlobs(root, fs, rootPackage);
  if (globs.length === 0) return [];

  const isPackageDir = workspaceMatcher(globs);
  const dirs = [...packageSet]
    .map((rel) => dirOfPosix(rel))
    .filter((dir) => dir !== '' && isPackageDir(dir))
    .sort();

  const seen = new Map<string, string>();
  return dirs.map((dir) => {
    const pkg = readPackage(`${dir}/package.json`);
    const name = pkg !== null && typeof pkg.name === 'string' ? pkg.name : null;
    if (name === null) {
      throw new ConfigError(`Workspace package ${dir} has no "name" in its package.json`);
    }
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new ConfigError(`Duplicate workspace package name "${name}" in ${previous} and ${dir}`);
    }
    seen.set(name, dir);
    return { id: `pkg:${dir}`, name, dir, packageJson: pkg as object };
  });
}

// picomatch treats a negated pattern in a list as "match anything but", which
// would make `['packages/*', '!**/test/**']` match every directory. Positive and
// negative patterns are matched separately instead.
function workspaceMatcher(globs: string[]): (dir: string) => boolean {
  const positive = globs.filter((glob) => !glob.startsWith('!'));
  const negative = globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1));
  const matchesPositive = positive.length === 0 ? () => false : picomatch(positive, { dot: true });
  const matchesNegative = negative.length === 0 ? () => false : picomatch(negative, { dot: true });
  return (dir) => matchesPositive(dir) && !matchesNegative(dir);
}

function readWorkspaceGlobs(
  root: string,
  fs: FileSystemLike,
  rootPackage: Record<string, unknown> | null,
): string[] {
  const yamlText = tryRead(fs, join(root, 'pnpm-workspace.yaml'));
  if (yamlText !== null) {
    let doc: unknown = null;
    try {
      doc = parseYaml(yamlText);
    } catch {
      doc = null;
    }
    if (
      doc !== null &&
      typeof doc === 'object' &&
      Array.isArray((doc as { packages?: unknown }).packages)
    ) {
      const packages = (doc as { packages: unknown[] }).packages;
      const strings = packages.filter((entry): entry is string => typeof entry === 'string');
      if (strings.length > 0) return strings;
    }
  }

  const workspaces = rootPackage?.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === 'string');
  }
  if (workspaces !== null && typeof workspaces === 'object') {
    const nested = (workspaces as { packages?: unknown }).packages;
    if (Array.isArray(nested)) {
      return nested.filter((entry): entry is string => typeof entry === 'string');
    }
  }
  return [];
}

function pickNearestAncestor(entries: TsconfigEntry[], rel: string): TsconfigEntry | null {
  return pickNearest(
    entries.filter((entry) => isAncestorDir(dirOfPosix(entry.configPath), rel)),
    rel,
  );
}

function pickNearest(entries: TsconfigEntry[], rel: string): TsconfigEntry | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    const dirA = dirOfPosix(a.configPath);
    const dirB = dirOfPosix(b.configPath);
    const byAncestor = Number(isAncestorDir(dirB, rel)) - Number(isAncestorDir(dirA, rel));
    if (byAncestor !== 0) return byAncestor;
    const byDepth = depthOf(dirB) - depthOf(dirA);
    if (byDepth !== 0) return byDepth;
    const byPriority = configPriority(a.configPath) - configPriority(b.configPath);
    if (byPriority !== 0) return byPriority;
    return a.configPath < b.configPath ? -1 : a.configPath > b.configPath ? 1 : 0;
  });
  return sorted[0];
}

function configPriority(configPath: string): number {
  const name = basename(configPath);
  if (name === 'tsconfig.json') return 0;
  if (name === 'jsconfig.json') return 1;
  return 2;
}

function fallbackOptions(
  project: Project,
  rel: string,
  packageSet: Set<string>,
  readPackage: (rel: string) => Record<string, unknown> | null,
): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    allowJs: true,
    resolveJsonModule: true,
    jsx: ts.JsxEmit.Preserve,
  };

  if (BUNDLER_DEPENDENCIES.some((name) => project.dependencies.has(name))) {
    return {
      ...base,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    };
  }
  if (nearestPackageIsModule(rel, packageSet, readPackage)) {
    return {
      ...base,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
  }
  return {
    ...base,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
  };
}

function nearestPackageIsModule(
  rel: string,
  packageSet: Set<string>,
  readPackage: (rel: string) => Record<string, unknown> | null,
): boolean {
  let dir = dirOfPosix(rel);
  for (;;) {
    const candidate = dir === '' ? 'package.json' : `${dir}/package.json`;
    if (packageSet.has(candidate)) {
      const pkg = readPackage(candidate);
      return pkg !== null && pkg.type === 'module';
    }
    if (dir === '') return false;
    dir = dirOfPosix(dir);
  }
}

function readJsonObject(fs: FileSystemLike, path: string): Record<string, unknown> | null {
  const text = tryRead(fs, path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function declaresDependencies(pkg: Record<string, unknown>): boolean {
  return (['dependencies', 'devDependencies', 'peerDependencies'] as const).some(
    (key) => pkg[key] !== null && typeof pkg[key] === 'object',
  );
}

function dependenciesOf(pkg: Record<string, unknown> | null): Set<string> {
  const deps = new Set<string>();
  if (pkg === null) return deps;
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const value = pkg[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of Object.keys(value)) deps.add(name);
    }
  }
  return deps;
}

function normalizeRel(root: string, file: string): string {
  if (isAbsolute(file)) return toPosix(relative(root, file));
  return file.replace(/^\.\//, '').split('\\').join('/');
}

function isAncestorDir(dir: string, rel: string): boolean {
  if (dir === '') return true;
  return rel === dir || rel.startsWith(`${dir}/`);
}

function depthOf(dir: string): number {
  return dir === '' ? 0 : dir.split('/').length;
}

function dirOfPosix(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function commonDir(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let prefix = dirOfPosix(paths[0]);
  for (const path of paths.slice(1)) {
    prefix = commonPrefixDir(prefix, dirOfPosix(path));
    if (prefix === '') return '';
  }
  return prefix;
}

function commonPrefixDir(a: string, b: string): string {
  const left = a === '' ? [] : a.split('/');
  const right = b === '' ? [] : b.split('/');
  const shared: string[] = [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) break;
    shared.push(left[i]);
  }
  return shared.join('/');
}

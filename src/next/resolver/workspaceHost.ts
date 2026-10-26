import { dirname, join, relative, sep } from 'node:path';

import * as ts from 'typescript';

import { isDir, isFile, toPosix, tryRead, type FileSystemLike } from '../fs';
import type { ProjectContext } from '../project/types';

export function posixDirname(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

export function posixJoin(...parts: string[]): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of part.split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment === '..') {
        const last = segments[segments.length - 1];
        if (segments.length > 0 && last !== '..') segments.pop();
        else segments.push('..');
        continue;
      }
      segments.push(segment);
    }
  }
  return segments.join('/');
}

function isUnderDirectory(prefix: string, path: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function rootRelativePosix(root: string, posixPath: string): string {
  if (root === '' || root === '/') return posixPath.replace(/^\/+/, '');
  if (posixPath === root) return '';
  return posixPath.startsWith(`${root}/`) ? posixPath.slice(root.length + 1) : posixPath;
}

interface WorkspacePackageDir {
  name: string;
  dirNative: string;
}

interface OutputEntry {
  out: string;
  source: string;
}

interface Layout {
  packages: WorkspacePackageDir[];
  outputs: OutputEntry[];
}

const LAYOUTS = new WeakMap<ProjectContext, Layout>();

function layoutOf(ctx: ProjectContext): Layout {
  const cached = LAYOUTS.get(ctx);
  if (cached !== undefined) return cached;

  const packages = ctx.packages.map((pkg) => ({
    name: pkg.name,
    dirNative: join(ctx.rootDir, pkg.dir),
  }));

  const outputs: OutputEntry[] = [];
  for (const entry of ctx.tsconfigs) {
    if (entry.rootDir === '') continue;
    for (const out of [entry.outDir, entry.declarationDir]) {
      if (out === undefined || out === '') continue;
      outputs.push({ out, source: entry.rootDir });
    }
  }

  const layout: Layout = { packages, outputs };
  LAYOUTS.set(ctx, layout);
  return layout;
}

export function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0] ?? '';
}

export function isNodeModulesPath(path: string): boolean {
  return path.includes('/node_modules/');
}

export function redirectWorkspacePath(path: string, ctx: ProjectContext): string {
  const posix = toPosix(path);
  const marker = '/node_modules/';
  const markerAt = posix.lastIndexOf(marker);
  if (markerAt < 0) return path;

  const rest = posix.slice(markerAt + marker.length);
  const name = packageNameOf(rest);
  const pkg = layoutOf(ctx).packages.find((candidate) => candidate.name === name);
  if (pkg === undefined) return path;

  const suffix = rest.slice(name.length);
  return pkg.dirNative + (sep === '/' ? suffix : suffix.split('/').join(sep));
}

export function outputSourceCandidates(path: string, ctx: ProjectContext): string[] {
  const rel = rootRelativePosix(toPosix(ctx.rootDir), toPosix(path));
  const candidates: string[] = [];

  for (const entry of layoutOf(ctx).outputs) {
    if (!isUnderDirectory(entry.out, rel)) continue;
    const rest = rel.slice(entry.out.length + 1);
    for (const candidate of swapToSourceExtensions(rest)) {
      const computed = entry.source === '' ? candidate : `${entry.source}/${candidate}`;
      if (!candidates.includes(computed)) candidates.push(computed);
    }
  }

  return candidates;
}

const SOURCE_SWAPS: Array<{ from: string; to: string[] }> = [
  { from: '.d.mts', to: ['.mts'] },
  { from: '.d.cts', to: ['.cts'] },
  { from: '.d.ts', to: ['.ts', '.tsx'] },
  { from: '.mjs', to: ['.mts', '.mjs'] },
  { from: '.cjs', to: ['.cts', '.cjs'] },
  { from: '.js', to: ['.ts', '.tsx', '.js', '.jsx'] },
];

function swapToSourceExtensions(rest: string): string[] {
  for (const swap of SOURCE_SWAPS) {
    if (rest.endsWith(swap.from)) {
      const head = rest.slice(0, rest.length - swap.from.length);
      return swap.to.map((extension) => `${head}${extension}`);
    }
  }
  return [];
}

export function createWorkspaceHost(
  ctx: ProjectContext,
  fs: FileSystemLike,
): ts.ModuleResolutionHost {
  const isVirtualNodeModulesDirectory = (path: string): boolean => {
    const posix = toPosix(path);
    return /(?:^|\/)node_modules$/.test(posix) || /\/node_modules\/@[^/]+$/.test(posix);
  };

  return {
    fileExists: (path) => {
      const real = redirectWorkspacePath(path, ctx);
      if (isFile(fs, real)) return true;
      return outputSourceCandidates(real, ctx).some((candidate) =>
        isFile(fs, join(ctx.rootDir, candidate)),
      );
    },
    readFile: (path) => {
      const real = redirectWorkspacePath(path, ctx);
      return tryRead(fs, real) ?? undefined;
    },
    directoryExists: (path) => {
      const real = redirectWorkspacePath(path, ctx);
      if (isDir(fs, real)) return true;
      return isVirtualNodeModulesDirectory(path);
    },
    getCurrentDirectory: () => ctx.rootDir,
    getDirectories: (path) => {
      try {
        return fs.readdir(redirectWorkspacePath(path, ctx));
      } catch {
        return [];
      }
    },
    realpath: (path) => {
      const real = redirectWorkspacePath(path, ctx);
      try {
        return fs.realpath(real);
      } catch {
        return real;
      }
    },
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  };
}

export function rootRelative(fs: FileSystemLike, rootDir: string, path: string): string | null {
  let real: string;
  try {
    real = fs.realpath(path);
  } catch {
    real = path;
  }
  const root = toPosix(rootDir);
  const posix = toPosix(real);
  if (posix === root) return '';
  if (!posix.startsWith(`${root}/`)) return null;
  return posix.slice(root.length + 1);
}

export function relativeTo(fromPath: string, toPath: string): string {
  const rel = toPosix(relative(dirname(fromPath), toPath));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

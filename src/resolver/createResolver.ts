import { isBuiltin } from 'node:module';
import { join } from 'node:path';

import picomatch from 'picomatch';
import * as ts from 'typescript';

import { isFile, nodeFileSystem, toPosix, type FileSystemLike } from '../fs';
import type { ImportSite, ParsedFile } from '../parser/types';
import type { ProjectContext, TsconfigEntry } from '../project/types';
import type {
  Resolution,
  ResolutionClass,
  ResolveOptions,
  Resolver,
  WorkspaceRequest,
} from './types';
import {
  createWorkspaceHost,
  isNodeModulesPath,
  outputSourceCandidates,
  packageNameOf,
  posixDirname,
  posixJoin,
  redirectWorkspacePath,
  relativeTo,
  rootRelative,
} from './workspaceHost';

const ASSET_EXTENSIONS = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.ico',
  '.json',
  '.woff',
  '.woff2',
  '.md',
  '.mdx',
]);

const IGNORE_TARGET_SUFFIXES = ['', '/index.ts', '/index.tsx', '.ts', '.tsx'];

export function createResolver(
  ctx: ProjectContext,
  analysisFiles: Set<string>,
  options: ResolveOptions,
  fs: FileSystemLike = nodeFileSystem(),
): Resolver {
  const host = createWorkspaceHost(ctx, fs);
  const caches = new Map<string, ts.ModuleResolutionCache>();
  const workspaceNames = new Set(ctx.packages.map((pkg) => pkg.name));
  const aliasEntries = Object.entries(options.aliases).sort((a, b) => b[0].length - a[0].length);
  const ignoreMatcher = buildMatcher(options.ignoreUnresolved);
  const virtualMatcher = buildMatcher(options.virtual);

  function cacheFor(
    entry: TsconfigEntry | null,
    compilerOptions: ts.CompilerOptions,
    fromRel: string,
  ): ts.ModuleResolutionCache {
    const key = entry === null ? `fallback:${ctx.projectFor(fromRel).id}` : entry.configPath;
    const existing = caches.get(key);
    if (existing !== undefined) return existing;

    const getCanonicalFileName = ts.sys.useCaseSensitiveFileNames
      ? (fileName: string): string => fileName
      : (fileName: string): string => fileName.toLowerCase();
    const created = ts.createModuleResolutionCache(
      ctx.rootDir,
      getCanonicalFileName,
      compilerOptions,
    );
    caches.set(key, created);
    return created;
  }

  function requestedWorkspace(specifier: string): WorkspaceRequest | undefined {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
      return undefined;
    }
    const name = packageNameOf(specifier);
    if (!workspaceNames.has(name)) return undefined;
    const rest = specifier.slice(name.length);
    return { package: name, subpath: rest === '' ? '.' : `.${rest}` };
  }

  function isVirtual(specifier: string): boolean {
    if (specifier.startsWith('virtual:') || specifier.startsWith('~icons/')) return true;
    return virtualMatcher?.(specifier) ?? false;
  }

  function applyAlias(specifier: string, fromRel: string): string | undefined {
    for (const [prefix, replacement] of aliasEntries) {
      if (!specifier.startsWith(prefix)) continue;
      const rest = specifier.slice(prefix.length);
      const project = ctx.projectFor(fromRel);
      const targetRel = posixJoin(project.dir, replacement, rest);
      return relativeTo(join(ctx.rootDir, fromRel), join(ctx.rootDir, targetRel));
    }
    return undefined;
  }

  function leafClass(fromRel: string, targetRel: string): ResolutionClass {
    if (!analysisFiles.has(targetRel)) return 'excluded';
    if (ctx.packages.length === 0) return 'internal';

    const fromPackage = ctx.packageFor(fromRel);
    const toPackage = ctx.packageFor(targetRel);
    if (fromPackage !== null && toPackage !== null && fromPackage.id !== toPackage.id) {
      return 'workspace';
    }
    return 'internal';
  }

  function classifyResolved(
    resolved: ts.ResolvedModuleFull,
    specifier: string,
    fromRel: string,
    requested: WorkspaceRequest | undefined,
  ): Resolution {
    const redirected = redirectWorkspacePath(resolved.resolvedFileName, ctx);

    if (requested === undefined && isNodeModulesPath(toPosix(redirected))) {
      return { class: 'external', target: { module: specifier } };
    }

    const resolvedRel = rootRelative(fs, ctx.rootDir, redirected);
    if (resolvedRel === null) {
      return { class: 'unresolved', target: null, reason: 'outside-root', requested };
    }

    const candidates = outputSourceCandidates(resolvedRel, ctx);
    let targetRel = resolvedRel;
    let mapped: { from: string } | undefined;

    if (candidates.length > 0) {
      const existing = candidates.filter((candidate) => isFile(fs, join(ctx.rootDir, candidate)));
      if (existing.length === 0) {
        return { class: 'unresolved', target: null, reason: 'missing-source-mapping', requested };
      }
      if (existing.length > 1) {
        return { class: 'unresolved', target: null, reason: 'ambiguous-source-mapping', requested };
      }
      targetRel = existing[0];
      mapped = { from: resolvedRel };
    }

    const realTarget = rootRelative(fs, ctx.rootDir, join(ctx.rootDir, targetRel));
    const finalTarget = realTarget ?? targetRel;

    return {
      class: leafClass(fromRel, finalTarget),
      target: { file: finalTarget },
      mapped,
      requested,
    };
  }

  function matchesIgnored(candidates: string[]): boolean {
    if (ignoreMatcher === null) return false;
    return candidates.some((candidate) => ignoreMatcher(candidate));
  }

  function hasNoResolvableEntry(packageName: string): boolean {
    const pkg = ctx.packages.find((candidate) => candidate.name === packageName);
    if (pkg === undefined) return false;
    const manifest = pkg.packageJson as Record<string, unknown>;
    return (
      manifest.exports === undefined &&
      manifest.main === undefined &&
      manifest.types === undefined &&
      manifest.typings === undefined
    );
  }

  function classifyUnresolved(
    specifier: string,
    fromRel: string,
    requested: WorkspaceRequest | undefined,
    compilerOptions: ts.CompilerOptions,
    aliasTried: boolean,
  ): Resolution {
    const isRelative =
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier === '.' ||
      specifier === '..' ||
      specifier.startsWith('/');

    if (isRelative) {
      const targetRel = posixJoin(posixDirname(fromRel), specifier);
      if (matchesIgnored(IGNORE_TARGET_SUFFIXES.map((suffix) => `${targetRel}${suffix}`))) {
        return { class: 'ignored', target: null, reason: 'ignore-unresolved' };
      }
      const targetAbs = join(ctx.rootDir, targetRel);
      if (ctx.isIgnored(targetAbs) || ctx.isIgnored(`${targetAbs}/index.ts`)) {
        return { class: 'ignored', target: null, reason: 'gitignored' };
      }
      return { class: 'unresolved', target: null, requested };
    }

    if (specifier.startsWith('#')) return { class: 'unresolved', target: null, requested };

    if (matchesIgnored([specifier])) {
      return { class: 'ignored', target: null, reason: 'ignore-unresolved' };
    }

    if (requested !== undefined) {
      const reason = hasNoResolvableEntry(requested.package) ? 'no-resolvable-entry' : undefined;
      return { class: 'unresolved', target: null, requested, reason };
    }

    if (aliasTried || matchesPathsKey(specifier, compilerOptions)) {
      return { class: 'unresolved', target: null };
    }

    if (ctx.projectFor(fromRel).dependencies.has(packageNameOf(specifier))) {
      return { class: 'external', target: { module: specifier }, reason: 'not-installed' };
    }

    return { class: 'unresolved', target: null };
  }

  return {
    resolve(site: ImportSite, parsed: ParsedFile): Resolution {
      if (site.unsupported !== undefined) {
        return { class: 'unsupported', target: null, reason: site.unsupported };
      }

      const specifier = site.specifier;
      const fromRel = toPosix(parsed.file);
      const fromAbs = join(ctx.rootDir, fromRel);

      if (isBuiltin(specifier)) {
        return { class: 'builtin', target: { module: builtinIdentity(specifier) } };
      }
      if (isVirtual(specifier)) return { class: 'virtual', target: null };
      if (isAsset(specifier)) return { class: 'asset', target: null };

      const requested = requestedWorkspace(specifier);
      const { options: compilerOptions, entry } = ctx.optionsFor(fromRel);
      const mode = ts.getModeForUsageLocation(
        parsed.sourceFile,
        site.node as ts.StringLiteralLike,
        compilerOptions,
      );
      const cache = cacheFor(entry, compilerOptions, fromRel);

      const direct = ts.resolveModuleName(
        specifier,
        fromAbs,
        compilerOptions,
        host,
        cache,
        undefined,
        mode,
      );
      if (direct.resolvedModule !== undefined) {
        return classifyResolved(direct.resolvedModule, specifier, fromRel, requested);
      }

      const aliasSpecifier = applyAlias(specifier, fromRel);
      if (aliasSpecifier !== undefined) {
        const aliased = ts.resolveModuleName(
          aliasSpecifier,
          fromAbs,
          compilerOptions,
          host,
          cache,
          undefined,
          mode,
        );
        if (aliased.resolvedModule !== undefined) {
          return classifyResolved(aliased.resolvedModule, specifier, fromRel, requested);
        }
      }

      return classifyUnresolved(
        specifier,
        fromRel,
        requested,
        compilerOptions,
        aliasSpecifier !== undefined,
      );
    },
  };
}

function isAsset(specifier: string): boolean {
  if (specifier.includes('?')) return true;
  const base = specifier.split('?')[0];
  const dot = base.lastIndexOf('.');
  if (dot < 0) return false;
  return ASSET_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function builtinIdentity(specifier: string): string {
  return specifier.startsWith('node:') ? specifier : `node:${specifier}`;
}

function buildMatcher(patterns: string[]): ((value: string) => boolean) | null {
  const cleaned = patterns.filter((pattern) => pattern !== '');
  if (cleaned.length === 0) return null;
  return picomatch(cleaned, { dot: true });
}

function matchesPathsKey(specifier: string, options: ts.CompilerOptions): boolean {
  const paths = options.paths;
  if (paths === undefined) return false;
  return Object.keys(paths).some((key) => {
    const star = key.indexOf('*');
    if (star < 0) return key === specifier;
    return specifier.startsWith(key.slice(0, star)) && specifier.endsWith(key.slice(star + 1));
  });
}

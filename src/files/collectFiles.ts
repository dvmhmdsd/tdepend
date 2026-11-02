import { join, relative, sep } from 'node:path';

import picomatch from 'picomatch';

import { isFile, nodeFileSystem, toPosix, tryStat, type FileSystemLike } from '../fs';
import { shouldSkipDir } from '../project/gitignore';
import type { ProjectContext } from '../project/types';

export const DEFAULT_SKIPS = [
  '**/*.{test,spec}.*',
  '**/__tests__/**',
  '**/*.stories.*',
  '**/*.d.ts',
  '**/*.d.mts',
  '**/*.d.cts',
  '**/*.min.js',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/public/**',
  'e2e/**',
];

export type SkipReason = 'excluded' | 'gitignored' | 'declaration' | 'outside-root';

export interface SkippedEntry {
  file: string;
  reason: SkipReason;
}

export interface CollectResult {
  files: string[];
  uncovered: string[];
  skipped: SkippedEntry[];
}

export interface CollectOptions {
  include: string[];
  exclude: string[];
  presetSkips: string[];
  fs?: FileSystemLike;
}

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;

export function collectFiles(ctx: ProjectContext, opts: CollectOptions): CollectResult {
  const fs = opts.fs ?? nodeFileSystem();
  const isExcluded = createExcludeMatcher(opts.presetSkips, opts.exclude);
  const matchesInclude = opts.include.length === 0 ? null : picomatch(opts.include, { dot: true });

  const { candidates, skipped: walkSkipped } = discoverCandidates(fs, ctx, matchesInclude);
  const { files, skipped: admitSkipped } = admitCandidates(fs, ctx, candidates, isExcluded);
  const skipped = [...walkSkipped, ...admitSkipped];

  const covered = coveredFiles(fs, ctx);
  const uncovered = files.filter((file) => !covered.has(file));

  files.sort();
  uncovered.sort();
  skipped.sort(compareSkipped);

  return { files, uncovered, skipped };
}

function discoverCandidates(
  fs: FileSystemLike,
  ctx: ProjectContext,
  matchesInclude: ((rel: string) => boolean) | null,
): { candidates: Map<string, string>; skipped: SkippedEntry[] } {
  const root = ctx.rootDir;
  const candidates = new Map<string, string>();
  const skipped: SkippedEntry[] = [];

  if (matchesInclude === null) {
    for (const entry of ctx.tsconfigs) {
      for (const file of entry.fileNames) {
        if (SOURCE_FILE.test(file)) candidates.set(file, join(root, file));
      }
    }
  }

  walkSourceFiles(fs, root, matchesInclude, {
    onFile: (rel, abs) => candidates.set(rel, abs),
    onOutside: (rel) => skipped.push({ file: rel, reason: 'outside-root' }),
  });

  return { candidates, skipped };
}

function admitCandidates(
  fs: FileSystemLike,
  ctx: ProjectContext,
  candidates: Map<string, string>,
  isExcluded: (rel: string) => boolean,
): { files: string[]; skipped: SkippedEntry[] } {
  const root = ctx.rootDir;
  const files: string[] = [];
  const skipped: SkippedEntry[] = [];
  const seen = new Set<string>();

  for (const [rel, abs] of candidates) {
    if (!isFile(fs, abs)) continue;
    const realRel = realRelative(fs, root, abs);
    if (realRel === null) {
      skipped.push({ file: rel, reason: 'outside-root' });
      continue;
    }
    const reason = skipReasonFor(ctx, isExcluded, rel, abs);
    if (reason !== null) {
      skipped.push({ file: rel, reason });
      continue;
    }
    if (seen.has(realRel)) continue;
    seen.add(realRel);
    files.push(realRel);
  }

  return { files, skipped };
}

function skipReasonFor(
  ctx: ProjectContext,
  isExcluded: (rel: string) => boolean,
  rel: string,
  abs: string,
): SkipReason | null {
  if (DECLARATION_FILE.test(rel)) return 'declaration';
  if (isExcluded(rel)) return 'excluded';
  if (ctx.isIgnored(abs)) return 'gitignored';
  return null;
}

interface WalkHandlers {
  onFile(rel: string, abs: string): void;
  onOutside(rel: string): void;
}

interface WalkEntry {
  abs: string;
  name: string;
  rel: string;
}

interface WalkContext {
  fs: FileSystemLike;
  root: string;
  matchesInclude: ((rel: string) => boolean) | null;
  handlers: WalkHandlers;
}

function walkSourceFiles(
  fs: FileSystemLike,
  root: string,
  matchesInclude: ((rel: string) => boolean) | null,
  handlers: WalkHandlers,
): void {
  visitDirectory({ fs, root, matchesInclude, handlers }, root);
}

function visitDirectory(ctx: WalkContext, dir: string): void {
  let entries: string[];
  try {
    entries = ctx.fs.readdir(dir);
  } catch {
    return;
  }
  entries.sort();

  for (const name of entries) {
    if (shouldSkipDir(name)) continue;
    const abs = join(dir, name);
    const stats = tryStat(ctx.fs, abs);
    if (stats === null) continue;
    const rel = toPosix(relative(ctx.root, abs));

    if (stats.isDirectory()) {
      if (realRelative(ctx.fs, ctx.root, abs) === null) ctx.handlers.onOutside(rel);
      else visitDirectory(ctx, abs);
    } else if (stats.isFile()) {
      visitFile(ctx, { abs, name, rel });
    }
  }
}

function visitFile(ctx: WalkContext, entry: WalkEntry): void {
  if (!SOURCE_FILE.test(entry.name)) return;
  if (realRelative(ctx.fs, ctx.root, entry.abs) === null) {
    ctx.handlers.onOutside(entry.rel);
    return;
  }
  if (ctx.matchesInclude !== null && !ctx.matchesInclude(entry.rel)) return;
  ctx.handlers.onFile(entry.rel, entry.abs);
}

export function createExcludeMatcher(
  presetSkips: string[],
  exclude: string[],
): (rel: string) => boolean {
  const effective: string[] = [];

  for (const pattern of [...presetSkips, ...exclude]) {
    if (pattern === '') continue;
    if (pattern.startsWith('!')) {
      const index = effective.indexOf(pattern.slice(1));
      if (index >= 0) effective.splice(index, 1);
      continue;
    }
    if (!effective.includes(pattern)) effective.push(pattern);
  }

  if (effective.length === 0) return () => false;
  const match = picomatch(effective, { dot: true });
  return (rel) => match(rel);
}

function coveredFiles(fs: FileSystemLike, ctx: ProjectContext): Set<string> {
  const covered = new Set<string>();

  for (const entry of ctx.tsconfigs) {
    for (const file of entry.fileNames) {
      covered.add(file);
      const realRel = realRelative(fs, ctx.rootDir, join(ctx.rootDir, file));
      if (realRel !== null) covered.add(realRel);
    }
  }

  return covered;
}

function realRelative(fs: FileSystemLike, root: string, abs: string): string | null {
  let real: string;
  try {
    real = fs.realpath(abs);
  } catch {
    return null;
  }
  if (real === root) return '';
  if (!real.startsWith(root + sep)) return null;
  return toPosix(real.slice(root.length + 1));
}

function compareSkipped(a: SkippedEntry, b: SkippedEntry): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  return 0;
}

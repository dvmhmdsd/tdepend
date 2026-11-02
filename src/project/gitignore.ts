import { dirname, isAbsolute, join, relative } from 'node:path';

import picomatch from 'picomatch';

import { isDir, toPosix, tryRead, type FileSystemLike } from '../fs';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage']);

export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

export interface IgnoreMatcher {
  test(absPath: string, isDir?: boolean): boolean;
}

export interface CreateIgnoreMatcherOptions {
  rootDir: string;
  gitTopLevel?: string | null;
  localExcludeBase: string;
  localExclude: string[];
  fs: FileSystemLike;
}

interface IgnoreRule {
  base: string;
  regex: RegExp;
  negated: boolean;
  dirOnly: boolean;
}

export function createIgnoreMatcher(opts: CreateIgnoreMatcherOptions): IgnoreMatcher {
  const rules: IgnoreRule[] = [];

  for (const pattern of opts.localExclude) {
    const rule = compileRule(opts.localExcludeBase, pattern);
    if (rule !== null) rules.push(rule);
  }

  const readRules = (dir: string): void => {
    const text = tryRead(opts.fs, join(dir, '.gitignore'));
    if (text === null) return;
    for (const line of text.split('\n')) {
      const rule = compileRule(dir, line);
      if (rule !== null) rules.push(rule);
    }
  };

  for (const dir of ancestorsBetween(opts.gitTopLevel ?? null, opts.rootDir)) readRules(dir);

  const collect = (dir: string): void => {
    readRules(dir);

    let entries: string[];
    try {
      entries = opts.fs.readdir(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (shouldSkipDir(name)) continue;
      const child = join(dir, name);
      if (!isDir(opts.fs, child)) continue;
      if (matches(rules, child, true)) continue;
      collect(child);
    }
  };

  collect(opts.rootDir);

  return { test: (absPath, isDirectory = false) => matches(rules, absPath, isDirectory) };
}

function ancestorsBetween(top: string | null, rootDir: string): string[] {
  if (top === null || relativeToBase(top, rootDir) === null) return [];
  const dirs: string[] = [];
  for (let dir = dirname(rootDir); dir.length >= top.length; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === top || dirname(dir) === dir) break;
  }
  return dirs;
}

function matches(rules: IgnoreRule[], absPath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    const rel = relativeToBase(rule.base, absPath);
    if (rel === null) continue;
    if (ruleMatches(rule, rel, isDirectory)) ignored = !rule.negated;
  }
  return ignored;
}

function relativeToBase(base: string, absPath: string): string | null {
  const rel = relative(base, absPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return toPosix(rel);
}

function ruleMatches(rule: IgnoreRule, rel: string, isDirectory: boolean): boolean {
  const parts = rel.split('/');
  for (let i = parts.length; i >= 1; i--) {
    const candidate = parts.slice(0, i).join('/');
    const isSelf = i === parts.length;
    if (rule.dirOnly && isSelf && !isDirectory) continue;
    if (rule.regex.test(candidate)) return true;
  }
  return false;
}

function compileRule(base: string, rawLine: string): IgnoreRule | null {
  const line = rawLine.replace(/\r$/, '').replace(/\s+$/, '');
  if (line === '' || line.startsWith('#')) return null;

  let negated = false;
  let pattern = line;
  if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
    if (pattern === '') return null;
  }

  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }

  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern.includes('/')) anchored = true;
  if (pattern === '') return null;

  const glob = anchored ? pattern : `**/${pattern}`;
  let regex: RegExp;
  try {
    regex = picomatch.makeRe(glob, { dot: true });
  } catch {
    return null;
  }
  if (regex === undefined || regex === null) return null;

  return { base, regex, negated, dirOnly };
}

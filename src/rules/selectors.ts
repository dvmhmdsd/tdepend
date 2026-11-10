import { isBuiltin } from 'node:module';

import picomatch from 'picomatch';

import type { SiteRecord } from '../graph/buildFileGraph';
import { builtinIdentity } from '../resolver/createResolver';
import type { ResolutionClass } from '../resolver/types';
import type { TargetSelector } from './types';

export type PathMatcher = (path: string) => boolean;
export type SiteMatcher = (record: SiteRecord) => boolean;

const NOTHING = (): boolean => false;

// Root-relative globs, compiled once. A missing or empty list matches nothing.
export function globMatcher(globs: string[] | undefined): PathMatcher {
  const cleaned = (globs ?? []).filter((glob) => glob !== '');
  return cleaned.length === 0 ? NOTHING : picomatch(cleaned, { dot: true });
}

const FILE_CLASSES = new Set<ResolutionClass>(['internal', 'workspace', 'excluded']);

// The file a `files` selector judges. An excluded target keeps its file, so a
// rule can still see an import of a generated or skipped file.
export function targetFile(record: SiteRecord): string | null {
  const { target } = record.resolution;
  if (!FILE_CLASSES.has(record.resolution.class) || target === null || !('file' in target)) {
    return null;
  }
  return target.file;
}

// The module identity a `modules` selector judges: built-in and external
// sites, installed or not. A site naming a workspace package (`requested`) is
// never a module, so a workspace import can't be caught as an npm package.
export function targetModule(record: SiteRecord): string | null {
  const { target, requested } = record.resolution;
  const kind = record.resolution.class;
  if ((kind !== 'builtin' && kind !== 'external') || requested !== undefined) return null;
  if (target === null || !('module' in target)) return null;
  return target.module;
}

// `name` matches that module exactly, `name/*` matches its subpaths and not the
// name itself, and a built-in may be written with or without `node:`.
export function moduleMatcher(patterns: string[] | undefined): (identity: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns ?? []) {
    const wildcard = pattern.endsWith('/*');
    const base = wildcard ? pattern.slice(0, -2) : pattern;
    const name = isBuiltin(base) ? builtinIdentity(base) : base;
    if (wildcard) prefixes.push(`${name}/`);
    else exact.add(name);
  }
  if (exact.size === 0 && prefixes.length === 0) return NOTHING;
  return (identity) =>
    exact.has(identity) ||
    prefixes.some((prefix) => identity.startsWith(prefix) && identity.length > prefix.length);
}

// A compiled `to` or `exceptTo` selector. The shorthand `string[]` means files.
export function selectorMatcher(selector: TargetSelector | string[] | undefined): SiteMatcher {
  if (selector === undefined) return NOTHING;
  const { files, modules } = Array.isArray(selector) ? { files: selector, modules: [] } : selector;
  const matchesFile = globMatcher(files);
  const matchesModule = moduleMatcher(modules);
  return (record) => {
    const file = targetFile(record);
    if (file !== null) return matchesFile(file);
    const identity = targetModule(record);
    return identity !== null && matchesModule(identity);
  };
}

export function selectorFiles(selector: TargetSelector | string[]): string[] | undefined {
  return Array.isArray(selector) ? selector : selector.files;
}

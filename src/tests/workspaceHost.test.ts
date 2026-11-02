import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeFileSystem } from '../fs';
import { discoverProject } from '../project/discoverProject';
import { createWorkspaceHost, posixJoin } from '../resolver/workspaceHost';

describe('createWorkspaceHost', () => {
  it('getDirectories lists directories only', () => {
    const root = join(process.cwd(), 'src', 'tests', 'fixtures', 'pnpm-monorepo');
    const host = createWorkspaceHost(discoverProject(root), nodeFileSystem());

    expect(host.getDirectories?.(join(root, 'packages', 'a'))).toEqual(['browser', 'dist', 'src']);
  });
});

describe('posixJoin lexical parent normalization', () => {
  it('cancels a parent against the preceding segment', () => {
    expect(posixJoin('src', '../shared/', 'x')).toBe('shared/x');
  });

  it('removes the final segment and defines the empty result as ""', () => {
    expect(posixJoin('src', '..')).toBe('');
  });

  it('survives a path that escapes every segment', () => {
    expect(posixJoin('src', '../..')).toBe('..');
  });

  it('keeps unmatched leading ".." instead of clamping into the root', () => {
    expect(posixJoin('src', '../../outside')).toBe('../outside');
    expect(posixJoin('..', 'x')).toBe('../x');
  });

  it('cancels nested segments', () => {
    expect(posixJoin('a/b/../c')).toBe('a/c');
  });

  it('ignores "." and repeated separators', () => {
    expect(posixJoin('./a//b/./c')).toBe('a/b/c');
  });

  it('preserves ordinary workspace-relative joins', () => {
    expect(posixJoin('', 'src/', 'components/button')).toBe('src/components/button');
    expect(posixJoin('packages/a', '../b/src')).toBe('packages/b/src');
  });
});

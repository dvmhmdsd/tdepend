import { describe, expect, it } from 'vitest';

import { posixJoin } from '../resolver/workspaceHost';

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

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Run the pinned pnpm rather than whatever happens to be on PATH: under
// `pnpm test` npm_execpath points at pnpm's own entry script. Node refuses to
// spawn a .cmd file without a shell, which is what pnpm is on Windows.
function runPnpm(args: string[]): string {
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && /\.c?js$/.test(execPath)) {
    return execFileSync(process.execPath, [execPath, ...args], options);
  }
  return execFileSync('pnpm', args, { ...options, shell: process.platform === 'win32' });
}

function allowedEntry(entry: string): boolean {
  return (
    entry === 'package/package.json' ||
    entry === 'package/README.md' ||
    entry === 'package/LICENSE' ||
    entry.startsWith('package/dist/')
  );
}

describe('build cleanup', () => {
  it(
    'removes stale output from a previous layout',
    () => {
      const stale = [
        join(ROOT, 'dist', 'next', 'stale.js'),
        join(ROOT, 'dist', 'parser', 'tsParser.js'),
      ];
      mkdirSync(join(ROOT, 'dist', 'next'), { recursive: true });
      mkdirSync(join(ROOT, 'dist', 'parser'), { recursive: true });
      for (const file of stale) writeFileSync(file, '// stale\n');

      runPnpm(['run', 'build']);

      for (const file of stale) expect(existsSync(file)).toBe(false);
    },
    180_000,
  );
});

describe('packed archive', () => {
  it(
    'contains only the files allow-list and no legacy module',
    () => {
      runPnpm(['run', 'build']);

      const destination = mkdtempSync(join(tmpdir(), 'tdepend-pack-'));
      tempDirs.push(destination);
      runPnpm(['pack', '--pack-destination', destination]);

      const tarball = readdirSync(destination).find((name) => name.endsWith('.tgz'));
      expect(tarball).toBeDefined();

      // A relative name: GNU tar reads the colon in C:\ as a remote host.
      const listing = execFileSync('tar', ['-tzf', tarball as string], {
        cwd: destination,
        encoding: 'utf-8',
      });
      const entries = listing
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && line !== 'package' && !line.endsWith('/'));

      for (const entry of entries) {
        expect(allowedEntry(entry), `unexpected packed entry: ${entry}`).toBe(true);
      }

      expect(entries.some((entry) => entry.includes('/next/'))).toBe(false);
      expect(entries.some((entry) => /tsParser|dependencyGraph|cycleDetector/.test(entry))).toBe(
        false,
      );
    },
    180_000,
  );
});

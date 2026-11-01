import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../cli/run';

const fixture = (name: string): string => join(process.cwd(), 'src', 'tests', 'fixtures', name);

let dir: string;
let stdout: string;
let stderr: string;

function io(): { cwd: string; stdout(s: string): void; stderr(s: string): void } {
  return {
    cwd: dir,
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdepend-cli-'));
  stdout = '';
  stderr = '';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('runCli', () => {
  it('unknown command returns 2 and prints usage to stderr', async () => {
    const code = await runCli(['bogus'], io());

    expect(code).toBe(2);
    expect(stderr.toLowerCase()).toContain('usage');
  });

  it('a ConfigError returns 2 with the message on stderr', async () => {
    writeFileSync(join(dir, 'tdepend.config.json'), JSON.stringify({ foo: 1 }));

    const code = await runCli(['analyze'], io());

    expect(code).toBe(2);
    expect(stderr).toContain('foo');
  });

  it('analyze --format json prints the serializable result', async () => {
    const code = await runCli(['analyze', '--root', fixture('nest-cjs'), '--format', 'json'], io());

    expect(code).toBe(0);
    expect(JSON.parse(stdout).version).toBe(1);
  });

  it('analyze --strict-resolution returns 2 when an import is unresolved', async () => {
    const code = await runCli(
      ['analyze', '--root', fixture('vite-tanstack-router'), '--strict-resolution'],
      io(),
    );

    expect(code).toBe(2);
  });

  it('explain prints one row per import', async () => {
    const code = await runCli(
      ['explain', 'src/main.tsx', '--root', fixture('vite-tanstack-router')],
      io(),
    );

    expect(code).toBe(0);
    expect(stdout.trim().split('\n')).toHaveLength(10);
  });

  it('rejects an unknown 0.2 command flag such as --class', async () => {
    const code = await runCli(['analyze', '--class', 'Foo'], io());

    expect(code).toBe(2);
  });
});

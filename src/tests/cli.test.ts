import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('--version', () => {
  it('prints the version from package.json', async () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string;
    };

    const code = await runCli(['--version'], io());

    expect(code).toBe(0);
    expect(stdout.trim()).toBe(manifest.version);
  });
});

describe('analysis root', () => {
  it('exits 2 and names a root that does not exist', async () => {
    const missing = join(dir, 'no-such-folder');

    const code = await runCli(['analyze', '--root', missing, '--strict-resolution'], io());

    expect(code).toBe(2);
    expect(stderr).toContain(`Root directory not found: ${missing}`);
    expect(stdout).toBe('');
  });

  it('exits 2 when the root is a file', async () => {
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'not a directory');

    expect(await runCli(['analyze', '--root', file], io())).toBe(2);
    expect(stderr).toContain(`Root directory not found: ${file}`);
  });

  it('exits 2 when the config root does not exist', async () => {
    writeFileSync(join(dir, 'tdepend.config.json'), JSON.stringify({ root: 'no-such-folder' }));

    expect(await runCli(['analyze', '--root', dir], io())).toBe(2);
    expect(stderr).toContain(`Root directory not found: ${join(dir, 'no-such-folder')}`);
  });

  it('names a missing root in explain too', async () => {
    const missing = join(dir, 'no-such-folder');

    expect(await runCli(['explain', 'src/a.ts', '--root', missing], io())).toBe(2);
    expect(stderr).toContain(`Root directory not found: ${missing}`);
  });
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
    expect(stdout).toContain("side-effect  internal  './features/cart' -> src/features/cart/index.ts");
    expect(stdout).toContain('loads (retained):');
  });

  it('explain on a file outside the analysis set returns 2', async () => {
    const code = await runCli(['explain', 'src/nope.ts', '--root', fixture('nest-cjs')], io());

    expect(code).toBe(2);
    expect(stderr).toContain('not in the analysis set');
  });

  it('analyze text lists sites by class, missing packages and discovery warnings', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { experimentalFoo: true }, include: ['src'] }),
    );
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), "import react from 'react';\nexport const r = react;\n");

    const code = await runCli(['analyze', '--root', dir], io());

    expect(code).toBe(0);
    expect(stdout).toContain('Sites by class:');
    expect(stdout).toContain('  external: 1');
    expect(stdout).toContain('Declared packages not found: 1');
    expect(stdout).toContain('Warnings:\n  unknown-compiler-option: tsconfig.json');
  });

  it('rejects an unknown --format value', async () => {
    const code = await runCli(['analyze', '--root', fixture('nest-cjs'), '--format', 'yaml'], io());

    expect(code).toBe(2);
    expect(stdout).toBe('');
  });

  it('resolves --config against the working directory, not --root', async () => {
    writeFileSync(join(dir, 'custom.json'), JSON.stringify({ typeOnly: 'syntax' }));

    const code = await runCli(
      ['analyze', '--root', fixture('nest-cjs'), '--config', 'custom.json', '--format', 'json'],
      io(),
    );

    expect(code).toBe(0);
  });

  it('rejects an unknown 0.2 command flag such as --class', async () => {
    const code = await runCli(['analyze', '--class', 'Foo'], io());

    expect(code).toBe(2);
  });
});

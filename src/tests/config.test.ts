import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, ParseError } from '../errors';
import { loadConfig } from '../config/loadConfig';
import { componentsSchema } from '../config/schema';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdepend-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(value: unknown): void {
  writeFileSync(join(dir, 'tdepend.config.json'), JSON.stringify(value));
}

describe('loadConfig', () => {
  it('applies defaults when no config file exists', () => {
    const { config, configFile } = loadConfig({ cwd: dir });

    expect(configFile).toBeNull();
    expect(config.presets).toEqual(['auto']);
    expect(config.typeOnly).toBe('usage');
    expect(config.compilers).toEqual(['tsc', 'esbuild', 'swc']);
    expect(config.metrics.abstractness).toBe('implemented');
    expect(config.exclude).toEqual([]);
    expect(config.baseline).toBeNull();
  });

  it('rejects unknown keys with exit 2 and lists them', () => {
    writeConfig({ foo: 1, bar: 2 });

    try {
      loadConfig({ cwd: dir });
      expect.unreachable('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).exitCode).toBe(2);
      expect((error as Error).message).toContain('foo');
      expect((error as Error).message).toContain('bar');
    }
  });

  it('rejects keys it does not know, naming them', () => {
    writeConfig({ rootDir: 'src', ci: {} });

    expect(() => loadConfig({ cwd: dir })).toThrow('Unknown config key(s): rootDir, ci');
  });

  it('accepts rules, components, baseline and metrics.thresholds', () => {
    writeConfig({
      rules: [{ id: 'nest/layers', severity: 'warn' }],
      components: { type: 'nest-module', coverage: { requireAll: true } },
      baseline: 'b.json',
      metrics: { abstractness: 'jdepend', thresholds: { distance: 0.5 } },
    });

    const { config } = loadConfig({ cwd: dir });
    expect(config.rules).toEqual([{ id: 'nest/layers', severity: 'warn' }]);
    expect(config.components).toEqual({
      type: 'nest-module',
      coverage: { requireAll: true, allowUnmatched: [] },
    });
    expect(config.baseline).toBe('b.json');
    expect(config.metrics).toEqual({ abstractness: 'jdepend', thresholds: { distance: 0.5 } });

    writeConfig({ rules: [{ type: 'no-cycles', id: 'C', level: 'galaxy' }] });
    expect(() => loadConfig({ cwd: dir })).toThrow('Invalid config');
  });

  it('accepts an exclude entry starting with !', () => {
    writeConfig({ exclude: ['!**/public/**'] });

    const { config } = loadConfig({ cwd: dir });
    expect(config.exclude).toEqual(['!**/public/**']);
  });

  it('defaults compilers and rejects unknown names and an empty list', () => {
    expect(loadConfig({ cwd: dir }).config.compilers).toEqual(['tsc', 'esbuild', 'swc']);

    writeConfig({ compilers: [] });
    expect(() => loadConfig({ cwd: dir })).toThrow(ConfigError);

    writeConfig({ compilers: ['tsc', 'webpack'] });
    expect(() => loadConfig({ cwd: dir })).toThrow(ConfigError);
  });

  it('accepts components directory, nest-module and file and rejects package', () => {
    expect(componentsSchema.safeParse({ type: 'directory', patterns: ['src/*'] }).success).toBe(
      true,
    );
    expect(componentsSchema.safeParse({ type: 'nest-module' }).success).toBe(true);
    expect(componentsSchema.safeParse({ type: 'file' }).success).toBe(true);
    expect(componentsSchema.safeParse({ type: 'package' }).success).toBe(false);
  });

  it('reports invalid JSON as a ParseError naming the file', () => {
    writeFileSync(join(dir, 'tdepend.config.json'), '{ invalid json }');

    try {
      loadConfig({ cwd: dir });
      expect.unreachable('expected ParseError');
    } catch (error) {
      expect(error).toBeInstanceOf(ParseError);
      expect((error as ParseError).exitCode).toBe(2);
      expect((error as ParseError).file).toContain('tdepend.config.json');
    }
  });

  it('honours an explicit configPath and rejects a missing one', () => {
    writeFileSync(join(dir, 'custom.json'), JSON.stringify({ typeOnly: 'syntax' }));

    const { config, configFile } = loadConfig({ cwd: dir, configPath: 'custom.json' });
    expect(config.typeOnly).toBe('syntax');
    expect(configFile).toContain('custom.json');

    expect(() => loadConfig({ cwd: dir, configPath: 'missing.json' })).toThrow(ConfigError);
  });
});

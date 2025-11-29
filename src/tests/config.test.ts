import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../config/loadConfig';
import { defaultConfig } from '../config/schema';

const TEST_DIR = join(process.cwd(), '.test-configs');

describe('Config System', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('loads default config when no file exists', () => {
    const config = loadConfig();
    expect(config).toEqual(defaultConfig);
  });

  it('loads config from custom path', () => {
    const configPath = join(TEST_DIR, 'custom.config.json');
    const customConfig = {
      rootDir: 'lib',
      include: ['lib/**/*.ts'],
    };
    writeFileSync(configPath, JSON.stringify(customConfig, null, 2));

    const config = loadConfig(configPath);
    expect(config.rootDir).toBe('lib');
    expect(config.include).toEqual(['lib/**/*.ts']);
    // Should merge with defaults
    expect(config.metrics.enabled).toEqual(defaultConfig.metrics.enabled);
  });

  it('throws error when custom config file not found', () => {
    expect(() => loadConfig('/nonexistent/path.json')).toThrow('Config file not found');
  });

  it('throws error for invalid JSON', () => {
    const configPath = join(TEST_DIR, 'invalid.json');
    writeFileSync(configPath, '{ invalid json }');

    expect(() => loadConfig(configPath)).toThrow('Invalid JSON');
  });

  it('validates config with Zod schema', () => {
    const configPath = join(TEST_DIR, 'invalid-schema.json');
    const invalidConfig = {
      metrics: {
        thresholds: {
          distance: 2.5, // Invalid: should be between 0 and 1
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(invalidConfig, null, 2));

    expect(() => loadConfig(configPath)).toThrow('Config validation failed');
  });

  it('merges partial config with defaults', () => {
    const configPath = join(TEST_DIR, 'partial.json');
    const partialConfig = {
      metrics: {
        thresholds: {
          distance: 0.8,
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(partialConfig, null, 2));

    const config = loadConfig(configPath);
    expect(config.metrics.thresholds.distance).toBe(0.8);
    expect(config.metrics.enabled).toEqual(defaultConfig.metrics.enabled);
    expect(config.rootDir).toBe(defaultConfig.rootDir);
  });

  it('finds tdepend.config.json in current directory', () => {
    const configPath = join(process.cwd(), 'tdepend.config.json');
    const customConfig = { rootDir: 'tdepend-test' };
    writeFileSync(configPath, JSON.stringify(customConfig, null, 2));

    try {
      const config = loadConfig();
      expect(config.rootDir).toBe('tdepend-test');
    } finally {
      rmSync(configPath, { force: true });
    }
  });





  it('supports all metric types', () => {
    const configPath = join(TEST_DIR, 'metrics.json');
    const metricsConfig = {
      metrics: {
        enabled: ['coupling', 'abstractness'],
      },
    };
    writeFileSync(configPath, JSON.stringify(metricsConfig, null, 2));

    const config = loadConfig(configPath);
    expect(config.metrics.enabled).toEqual(['coupling', 'abstractness']);
  });

  it('supports analysis target configuration', () => {
    const configPath = join(TEST_DIR, 'analysis.json');
    const analysisConfig = {
      analysis: {
        target: 'class',
        value: 'UserService',
      },
    };
    writeFileSync(configPath, JSON.stringify(analysisConfig, null, 2));

    const config = loadConfig(configPath);
    expect(config.analysis.target).toBe('class');
    expect(config.analysis.value).toBe('UserService');
  });

  it('supports CI configuration', () => {
    const configPath = join(TEST_DIR, 'ci.json');
    const ciConfig = {
      ci: {
        failOnThreshold: false,
        outputFormat: 'json',
      },
    };
    writeFileSync(configPath, JSON.stringify(ciConfig, null, 2));

    const config = loadConfig(configPath);
    expect(config.ci.failOnThreshold).toBe(false);
    expect(config.ci.outputFormat).toBe('json');
  });
});

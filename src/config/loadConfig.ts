import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { configSchema, defaultConfig, type TDependConfig } from './schema';
import { deepMerge } from '../utils/deepMerge';

function resolveConfigPath(configPath?: string): string | null {
  if (configPath) {
    const resolvedPath = resolve(configPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Config file not found: ${resolvedPath}`);
    }
    return resolvedPath;
  }

  const defaultPath = resolve('tdepend.config.json');
  if (existsSync(defaultPath)) {
    return defaultPath;
  }

  return null;
}

function readConfigFile(filePath: string): Partial<TDependConfig> {
  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${filePath}`);
    }
    throw error;
  }
}

function validateConfig(config: Partial<TDependConfig>): TDependConfig {
  try {
    return configSchema.parse(config);
  } catch (error) {
    throw new Error(`Config validation failed: ${error}`);
  }
}

/**
 * Load and validate TDepend configuration
 *
 * @param configPath - Optional path to config file. If not provided, searches for
 *                     tdepend.config.json in current directory
 * @returns Validated and merged configuration
 * @throws Error if config file is not found, invalid JSON, or fails validation
 */
export function loadConfig(configPath?: string): TDependConfig {
  const resolvedPath = resolveConfigPath(configPath);
  const loadedConfig = resolvedPath ? readConfigFile(resolvedPath) : {};
  const mergedConfig = deepMerge(defaultConfig, loadedConfig);
  return validateConfig(mergedConfig);
}

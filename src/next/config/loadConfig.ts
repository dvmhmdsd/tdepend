import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { ConfigError, ParseError } from '../errors';
import { configSchema, type UserConfig } from './schema';

const CONFIG_FILENAME = 'tdepend.config.json';

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

export interface LoadConfigResult {
  config: UserConfig;
  configFile: string | null;
}

export function loadConfig(opts: LoadConfigOptions): LoadConfigResult {
  const configFile = findConfigFile(opts);
  if (configFile === null) {
    return { config: configSchema.parse({}), configFile: null };
  }

  const parsed = configSchema.safeParse(readRawConfig(configFile));
  if (!parsed.success) {
    throw new ConfigError(formatZodError(parsed.error));
  }

  return { config: parsed.data, configFile };
}

function findConfigFile(opts: LoadConfigOptions): string | null {
  if (opts.configPath !== undefined) {
    const path = isAbsolute(opts.configPath)
      ? opts.configPath
      : resolve(opts.cwd, opts.configPath);
    if (!existsSync(path)) {
      throw new ConfigError(`Config file not found: ${opts.configPath}`);
    }
    return path;
  }

  const path = join(opts.cwd, CONFIG_FILENAME);
  return existsSync(path) ? path : null;
}

function readRawConfig(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    throw new ConfigError(
      `Cannot read config file ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ParseError(
      `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
      file,
    );
  }
}

function formatZodError(error: z.ZodError): string {
  const unknownKeys: string[] = [];
  const otherIssues: string[] = [];

  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      unknownKeys.push(...issue.keys);
    } else {
      const at = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      otherIssues.push(`${at}: ${issue.message}`);
    }
  }

  const parts: string[] = [];
  if (unknownKeys.length > 0) {
    parts.push(`Unknown config key(s): ${unknownKeys.join(', ')}`);
  }
  if (otherIssues.length > 0) {
    parts.push(otherIssues.join('; '));
  }
  return `Invalid config. ${parts.join('. ')}`;
}

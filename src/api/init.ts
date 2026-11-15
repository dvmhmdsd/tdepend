import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

import { ConfigError } from '../errors';
import { createExcludeMatcher } from '../files/collectFiles';
import { builtInPresets } from '../presets/registry';
import { resolvePresets } from '../presets/resolvePresets';
import { discoverProject } from '../project/discoverProject';

const CONFIG_FILENAME = 'tdepend.config.json';

export interface InitOptions {
  root: string;
  /** Overwrite an existing config. */
  force?: boolean;
}

export interface InitResult {
  written: string;
  /** Every preset detected in some project, sorted. */
  presets: string[];
  /** Detected presets per project id. */
  projects: Record<string, string[]>;
}

/**
 * Writes a starter config: `presets: ["auto"]`, an empty `exclude`, and the
 * detected presets' recommended rules switched on as `warn`, so a new repo sees
 * them and owns the choice to keep, raise or drop each one.
 */
export async function init(options: InitOptions): Promise<InitResult> {
  const root = resolvePath(options.root);
  const written = join(root, CONFIG_FILENAME);
  if (existsSync(written) && options.force !== true) {
    throw new ConfigError(
      `${CONFIG_FILENAME} already exists in ${root}; use --force to overwrite it.`,
    );
  }

  const ctx = discoverProject(root, {
    isExcluded: createExcludeMatcher(builtInPresets.node.skips ?? [], []),
  });
  const byProject = resolvePresets(['auto'], ctx, root);
  const projects: Record<string, string[]> = {};
  const recommended = new Set<string>();
  for (const [projectId, presets] of byProject) {
    projects[projectId] = presets.map((preset) => preset.name);
    for (const preset of presets) {
      for (const rule of preset.recommended ?? []) recommended.add(rule.id);
    }
  }

  const config = {
    presets: ['auto'],
    exclude: [],
    rules: [...recommended].sort().map((id) => ({ id, severity: 'warn' })),
  };
  writeFileSync(written, `${JSON.stringify(config, null, 2)}\n`);
  return {
    written,
    presets: [...new Set(Object.values(projects).flat())].sort(),
    projects,
  };
}

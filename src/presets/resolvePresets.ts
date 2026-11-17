import { createRequire } from 'node:module';
import { join } from 'node:path';

import { ConfigError } from '../errors';
import type { ProjectContext } from '../project/types';
import { isPreset, type Preset } from './definePreset';
import { builtInPresets } from './registry';

// The presets of every project, `node` first. A listed preset turns on in each
// project whose own package.json its `detect` matches, and `auto` lists every
// built-in, so naming one built-in narrows `auto` to it. A preset brings the
// presets it extends, ahead of itself.
export function resolvePresets(
  selection: string[],
  ctx: ProjectContext,
  configDir: string,
): Map<string, Preset[]> {
  const listed = selection.flatMap((entry) =>
    entry === 'auto' ? Object.values(builtInPresets) : [loadPreset(entry, configDir)],
  );
  const named = byName(listed);
  const result = new Map<string, Preset[]>();

  for (const project of ctx.projects) {
    const chosen: Preset[] = [];
    const add = (preset: Preset, extending: Preset[]): void => {
      if (chosen.includes(preset)) return;
      if (extending.includes(preset)) {
        throw new ConfigError(`Preset ${preset.name} extends itself`);
      }
      for (const base of preset.extends ?? []) {
        const found = named.get(base);
        if (found === undefined) {
          throw new ConfigError(`Preset ${preset.name} extends unknown preset "${base}"`);
        }
        add(found, [...extending, preset]);
      }
      chosen.push(preset);
    };

    add(builtInPresets.node, []);
    for (const preset of listed) {
      if (preset.detect(project)) add(preset, []);
    }
    result.set(project.id, chosen);
  }
  return result;
}

const RESERVED_NAMES = new Set(['next', 'tanstack-router', 'tanstack-start', 'prisma', 'monorepo']);

function loadPreset(entry: string, configDir: string): Preset {
  const builtIn = Object.prototype.hasOwnProperty.call(builtInPresets, entry)
    ? builtInPresets[entry]
    : undefined;
  if (builtIn !== undefined) return builtIn;
  const unknown = (): ConfigError =>
    new ConfigError(
      `Unknown preset "${entry}". Built-in presets: ${Object.keys(builtInPresets).sort().join(', ')}. Any other entry must be a module that resolves from ${configDir}.`,
    );
  // These name framework packages a repo usually has installed; loading one as
  // a preset would run that package's code.
  if (RESERVED_NAMES.has(entry)) throw unknown();

  // A config file name, so the module is resolved as if the config imported it.
  const load = createRequire(join(configDir, 'tdepend.config.json'));
  try {
    load.resolve(entry);
  } catch {
    throw unknown();
  }

  let loaded: unknown;
  try {
    loaded = load(entry);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Preset ${entry} failed to load: ${message}`);
  }
  const preset = [loaded, (loaded as { default?: unknown } | null)?.default].find(isPreset);
  if (preset === undefined) {
    throw new ConfigError(`Preset ${entry} must export a preset made with definePreset`);
  }
  return preset;
}

function byName(listed: Preset[]): Map<string, Preset> {
  const named = new Map<string, Preset>();
  for (const preset of [...Object.values(builtInPresets), ...listed]) {
    const existing = named.get(preset.name);
    if (existing !== undefined && existing !== preset) {
      throw new ConfigError(`Two presets are named "${preset.name}"`);
    }
    named.set(preset.name, preset);
  }
  return named;
}

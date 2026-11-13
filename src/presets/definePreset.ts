import { z } from 'zod';

import { componentStrategySchema } from '../config/schema';
import { ConfigError } from '../errors';
import type { Project } from '../project/types';
import { ruleDefinitionSchema } from '../rules/types';

// Every glob a preset gives (skips, ignoreUnresolved, component patterns, rule
// globs) is relative to the project directory; repoRules globs are relative to
// the repository root.
const presetSchema = z.strictObject({
  name: z.string().min(1),
  detect: z.custom<(project: Project) => boolean>((value) => typeof value === 'function', {
    message: '`detect` must be a function',
  }),
  extends: z.array(z.string()).optional(),
  skips: z.array(z.string()).optional(),
  ignoreUnresolved: z.array(z.string()).optional(),
  components: componentStrategySchema.optional(),
  // On when the preset is.
  rules: z.array(ruleDefinitionSchema).optional(),
  // Shipped off; `init` writes them into a new config as `warn`.
  recommended: z.array(ruleDefinitionSchema).optional(),
  // Evaluated once, at repository scope.
  repoRules: z.array(ruleDefinitionSchema).optional(),
});

export type Preset = z.infer<typeof presetSchema>;

// A global symbol, so a preset made against another copy of tdepend still counts.
const PRESET = Symbol.for('tdepend.preset');

export function definePreset(preset: Preset): Preset {
  const parsed = presetSchema.safeParse(preset);
  if (!parsed.success) {
    const name = typeof preset?.name === 'string' && preset.name !== '' ? preset.name : '(unnamed)';
    const issues = parsed.error.issues.map((issue) => {
      const at = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${at}${issue.message}`;
    });
    throw new ConfigError(`Invalid preset ${name}: ${issues.join('; ')}`);
  }
  return Object.defineProperty(parsed.data, PRESET, { value: true });
}

export function isPreset(value: unknown): value is Preset {
  return typeof value === 'object' && value !== null && PRESET in value;
}

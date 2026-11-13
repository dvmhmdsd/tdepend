import { z } from 'zod';

import { ruleConfigSchema } from '../rules/types';

const coverageSchema = z.strictObject({
  requireAll: z.boolean().default(false),
  allowUnmatched: z.array(z.string()).default([]),
});

const directoryStrategy = z.strictObject({
  type: z.literal('directory'),
  patterns: z.array(z.string()),
});
const nestModuleStrategy = z.strictObject({ type: z.literal('nest-module') });
const fileStrategy = z.strictObject({ type: z.literal('file') });

// A preset sets a strategy; the user config may add coverage to it.
export const componentStrategySchema = z.discriminatedUnion('type', [
  directoryStrategy,
  nestModuleStrategy,
  fileStrategy,
]);

export const componentsSchema = z.discriminatedUnion('type', [
  directoryStrategy.extend({ coverage: coverageSchema.optional() }),
  nestModuleStrategy.extend({ coverage: coverageSchema.optional() }),
  fileStrategy,
]);

const resolveSchema = z.strictObject({
  aliases: z.record(z.string(), z.string()).default({}),
  virtual: z.array(z.string()).default([]),
  ignoreUnresolved: z.array(z.string()).default([]),
});

const metricsSchema = z.strictObject({
  abstractness: z.enum(['implemented', 'jdepend']).default('implemented'),
  thresholds: z
    .strictObject({
      distance: z.number().min(0).max(1).nullable().default(null),
    })
    .default({ distance: null }),
});

export const configSchema = z.strictObject({
  root: z.string().default('.'),
  presets: z.array(z.string()).default(['auto']),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
  typeOnly: z.enum(['usage', 'syntax']).default('usage'),
  compilers: z
    .array(z.enum(['tsc', 'esbuild', 'swc']))
    .min(1)
    .default(['tsc', 'esbuild', 'swc']),
  resolve: resolveSchema.default({ aliases: {}, virtual: [], ignoreUnresolved: [] }),
  metrics: metricsSchema.default({ abstractness: 'implemented', thresholds: { distance: null } }),
  rules: z.array(ruleConfigSchema).default([]),
  baseline: z.string().nullable().default(null),
  components: componentsSchema.optional(),
});

export type UserConfig = z.infer<typeof configSchema>;

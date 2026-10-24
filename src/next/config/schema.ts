import { z } from 'zod';

const coverageSchema = z.strictObject({
  requireAll: z.boolean().default(false),
  allowUnmatched: z.array(z.string()).default([]),
});

export const componentsSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('directory'),
    patterns: z.array(z.string()),
    coverage: coverageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('nest-module'),
    coverage: coverageSchema.optional(),
  }),
  z.strictObject({
    type: z.literal('file'),
  }),
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
  compilers: z.array(z.enum(['tsc', 'esbuild', 'swc'])).min(1).default(['tsc', 'esbuild', 'swc']),
  resolve: resolveSchema.default({ aliases: {}, virtual: [], ignoreUnresolved: [] }),
  metrics: metricsSchema.default({ abstractness: 'implemented', thresholds: { distance: null } }),
  rules: z.array(z.unknown()).default([]),
  baseline: z.string().nullable().default(null),
  components: componentsSchema.optional(),
});

export type UserConfig = z.infer<typeof configSchema>;

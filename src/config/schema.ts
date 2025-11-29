import { z } from 'zod';

export const configSchema = z.object({
  rootDir: z.string().default('src'),
  include: z.array(z.string()).default(['src/**/*.ts', 'src/**/*.tsx']),
  exclude: z.array(z.string()).default(['**/*.test.ts', '**/*.spec.ts', 'dist']),
  metrics: z
    .object({
      enabled: z
        .array(z.enum(['coupling', 'abstractness', 'distance', 'cycles']))
        .default(['coupling', 'abstractness', 'distance', 'cycles']),
      thresholds: z
        .object({
          distance: z.number().min(0).max(1).default(0.6),
        })
        .default({ distance: 0.6 }),
    })
    .default({
      enabled: ['coupling', 'abstractness', 'distance', 'cycles'],
      thresholds: { distance: 0.6 },
    }),
  analysis: z
    .object({
      target: z.enum(['module', 'class', 'namespace']).nullable().default(null),
      value: z.string().nullable().default(null),
    })
    .default({ target: null, value: null }),
  ci: z
    .object({
      failOnThreshold: z.boolean().default(true),
      failOnCycle: z.boolean().default(false),
      outputFormat: z.enum(['console', 'json']).default('console'),
    })
    .default({ failOnThreshold: true, failOnCycle: false, outputFormat: 'console' }),
});

export type TDependConfig = z.infer<typeof configSchema>;

export const defaultConfig: TDependConfig = {
  rootDir: 'src',
  include: ['src/**/*.ts', 'src/**/*.tsx'],
  exclude: ['**/*.test.ts', '**/*.spec.ts', 'dist'],
  metrics: {
    enabled: ['coupling', 'abstractness', 'distance', 'cycles'],
    thresholds: {
      distance: 0.6,
    },
  },
  analysis: {
    target: null,
    value: null,
  },
  ci: {
    failOnThreshold: true,
    failOnCycle: false,
    outputFormat: 'console',
  },
};

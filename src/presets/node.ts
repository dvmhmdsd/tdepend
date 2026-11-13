import { definePreset } from './definePreset';

export const node = definePreset({
  name: 'node',
  detect: () => true,
  skips: [
    '**/*.{test,spec}.*',
    '**/__tests__/**',
    '**/*.stories.*',
    '**/*.d.ts',
    '**/*.d.mts',
    '**/*.d.cts',
    '**/*.min.js',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/public/**',
    'e2e/**',
  ],
  components: { type: 'directory', patterns: ['src/*'] },
  rules: [{ type: 'no-cycles', id: 'node/no-cycles', level: 'file', severity: 'warn' }],
});

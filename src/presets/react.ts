import { definePreset } from './definePreset';

export const react = definePreset({
  name: 'react',
  // A Next app is a React app with its own preset.
  detect: (project) => project.dependencies.has('react') && !project.dependencies.has('next'),
  skips: ['**/*.stories.*'],
  components: { type: 'directory', patterns: ['src/features/*', 'src/*'] },
  recommended: [
    {
      type: 'forbidden',
      id: 'react/shared-no-feature-import',
      from: ['src/{components,lib,shared,utils}/**'],
      to: ['src/features/**'],
      message:
        'Shared code must not import a feature; move it into the feature or lift it to shared.',
    },
  ],
});

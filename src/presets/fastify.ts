import { definePreset } from './definePreset';

export const fastify = definePreset({
  name: 'fastify',
  detect: (project) => project.dependencies.has('fastify'),
  components: { type: 'directory', patterns: ['src/*'] },
});

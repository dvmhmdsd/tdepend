import { definePreset } from './definePreset';

export const express = definePreset({
  name: 'express',
  detect: (project) => project.dependencies.has('express'),
  components: { type: 'directory', patterns: ['src/*'] },
});

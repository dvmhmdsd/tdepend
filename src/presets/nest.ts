import { definePreset } from './definePreset';

const UPWARD = "Repositories don't call up into services or controllers.";
const DATA = "DTOs are data; they don't call services or repositories.";

export const nest = definePreset({
  name: 'nest',
  detect: (project) => project.dependencies.has('@nestjs/core'),
  skips: ['test/**'],
  components: { type: 'nest-module' },
  recommended: [
    {
      type: 'layers',
      id: 'nest/layers',
      layers: {
        controller: ['**/*.controller.ts'],
        service: ['**/*.service.ts'],
        repository: ['**/*.repository.ts'],
        dto: ['**/*.dto.ts'],
      },
      disallow: {
        controller: [
          { layer: 'repository', message: 'Controllers call services, not repositories.' },
        ],
        repository: [
          { layer: 'controller', message: UPWARD },
          { layer: 'service', message: UPWARD },
        ],
        dto: [
          { layer: 'service', message: DATA },
          { layer: 'repository', message: DATA },
        ],
      },
    },
  ],
});

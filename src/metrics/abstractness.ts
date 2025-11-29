import type { ParsedModule } from '../types/parser';

export function computeAbstractness(module: ParsedModule): number {
  const abstractClasses = module.classes.filter((c) => c.isAbstract).length;
  const abstractTypes = module.interfaces + abstractClasses;
  const totalTypes = module.totalTypes;

  return totalTypes === 0 ? 0 : abstractTypes / totalTypes;
}

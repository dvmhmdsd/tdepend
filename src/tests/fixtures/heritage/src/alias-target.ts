export interface Target {
  run(): void;
}

export type TargetAlias = Target;

export class ViaAlias implements TargetAlias {
  run(): void {}
}

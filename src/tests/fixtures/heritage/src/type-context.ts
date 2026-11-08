export type ViaImport = import('./contract').Port;

export class Indirect implements ViaImport {
  send(): void {}
}

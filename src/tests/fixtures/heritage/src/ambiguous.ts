import type { Dup, Port } from './stars';

export class Twin implements Dup {
  a = '';
  b = '';
}

export class Single implements Port {
  send(): void {}
}

import type { Port } from './types';

export class Adapter implements Port {
  send(message: string): void {
    console.log(message);
  }
}

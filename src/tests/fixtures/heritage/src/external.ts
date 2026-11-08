import { EventEmitter } from 'node:events';
import * as shapes from './shapes';

export class Emitter extends EventEmitter {}

export class Failure extends Error {}

export class Qualified implements shapes.Readable {
  read(): string {
    return '';
  }
}

function mix<T>(base: T): T {
  return base;
}

export class Mixed extends mix(Object) {}

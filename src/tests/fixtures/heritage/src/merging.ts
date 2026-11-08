export interface Merged {
  a: string;
}
export class Merged {
  b = '';
}

export interface Twice {
  a: string;
}
export interface Twice {
  b: string;
}

export const Schema = { kind: 'schema' };
export type Schema = typeof Schema;

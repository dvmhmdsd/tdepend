export interface A {
  readonly a: string;
}

export interface T {
  readonly t: string;
}

export interface Port {
  run(): void;
}

export interface Foo {
  readonly foo: string;
}

export interface Svc {
  readonly svc: string;
}

export const used = 1;
export const Frag = 'frag';
export const Preact = { createElement(): null { return null; } };

export function h(): null {
  return null;
}

export function create(): null {
  return null;
}

export const KEYS = { a: 'a' } as const;
export const b = 2;

export function bar(): number {
  return 1;
}

export const enum Status {
  Active = 'active',
}

export default function React(): void {
  /* stands in for the classic JSX factory */
}

export function box<T>(value: T): T {
  return value;
}

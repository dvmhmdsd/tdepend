export function format(value: string): string;
export function format(value: number): string;
export function format(value: string | number): string {
  return String(value);
}

export async function load(): Promise<void> {}
export const fetchAll = async (): Promise<void> => {};
export const fetchOne = async function (): Promise<void> {};
export const sync = (): void => {};

const helper = 1;
function internal(): void {}

export { helper, internal as renamed };

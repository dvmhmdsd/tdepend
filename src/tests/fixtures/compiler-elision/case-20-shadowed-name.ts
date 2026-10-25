import { used } from './dep';

export function consume(used: number): number {
  return used + 1;
}

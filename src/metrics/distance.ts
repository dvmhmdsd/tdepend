export function computeDistance(abstractness: number, instability: number): number {
  return Math.abs(abstractness + instability - 1);
}

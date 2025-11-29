export function computeInstability(Ca: number, Ce: number): number {
  const total = Ca + Ce;
  return total === 0 ? 0 : Ce / total;
}

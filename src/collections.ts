// Ordering and grouping helpers shared by the graphs and the symbol index.

// Compares two key lists position by position, so records sort by their first
// key, then their second, and so on.
export function compareKeys(left: readonly string[], right: readonly string[]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
}

export function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    const list = index.get(value);
    if (list === undefined) index.set(value, [item]);
    else list.push(item);
  }
  return index;
}

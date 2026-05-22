const QUALIFIER_RANK = new Map<string, number>([
  ["alpha", 1],
  ["a", 1],
  ["beta", 2],
  ["b", 2],
  ["milestone", 3],
  ["m", 3],
  ["rc", 4],
  ["cr", 4],
  ["snapshot", 5],
  ["", 6],
  ["sp", 7],
]);

export function compareVersions(left: string, right: string): number {
  const leftParts = tokenizeVersion(left);
  const rightParts = tokenizeVersion(right);
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = leftParts[index] ?? "";
    const rightPart = rightParts[index] ?? "";
    const diff = comparePart(leftPart, rightPart);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function maxVersion(values: string[]): string | undefined {
  return values.reduce<string | undefined>((best, current) => {
    if (!best) {
      return current;
    }
    return compareVersions(current, best) > 0 ? current : best;
  }, undefined);
}

function tokenizeVersion(value: string): string[] {
  return value
    .split(/[\.\-_\+]/g)
    .flatMap((part) => part.match(/\d+|[A-Za-z]+/g) ?? [])
    .map((part) => part.toLowerCase());
}

function comparePart(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const diff = Number(left) - Number(right);
    return diff === 0 ? 0 : diff > 0 ? 1 : -1;
  }
  if (leftNumeric) {
    return right === "" ? 1 : 1;
  }
  if (rightNumeric) {
    return left === "" ? -1 : -1;
  }
  const leftRank = QUALIFIER_RANK.get(left) ?? 50;
  const rightRank = QUALIFIER_RANK.get(right) ?? 50;
  if (leftRank !== rightRank) {
    return leftRank > rightRank ? 1 : -1;
  }
  return left.localeCompare(right);
}

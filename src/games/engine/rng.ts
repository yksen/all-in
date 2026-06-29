import { randomInt } from "node:crypto";

/** Uniform integer in [0, maxExclusive). Cryptographically secure, unbiased. */
export function secureInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new RangeError("maxExclusive must be > 0");
  return randomInt(maxExclusive);
}

/** Uniform integer in [min, max] inclusive. */
export function intBetween(min: number, max: number): number {
  return min + secureInt(max - min + 1);
}

/** A single d6 roll (1..6). */
export function rollDie(): number {
  return 1 + secureInt(6);
}

export function pick<T>(items: readonly T[]): T {
  if (items.length === 0) throw new RangeError("cannot pick from empty array");
  return items[secureInt(items.length)]!;
}

/** In-place Fisher–Yates shuffle using the secure RNG. */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = secureInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

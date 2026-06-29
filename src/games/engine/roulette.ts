import { intBetween } from "./rng.ts";

export type BetKind =
  | "straight"
  | "split"
  | "street"
  | "corner"
  | "sixline"
  | "red"
  | "black"
  | "green"
  | "even"
  | "odd"
  | "low"
  | "high"
  | "dozen"
  | "column";

/** A bet definition without a stake: which numbers win and the to-one payout. */
export interface BetDef {
  kind: BetKind;
  numbers: number[];
  /** Payout "to one" — profit is amount * payout, total return is amount * (payout + 1). */
  payout: number;
  label: string;
}

/** European wheel: single zero. Standard red numbers. */
export const RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

export function colorOf(n: number): "red" | "black" | "green" {
  if (n === 0) return "green";
  return RED.has(n) ? "red" : "black";
}

/** Spin the European wheel: a uniform 0..36. */
export function spin(): number {
  return intBetween(0, 36);
}

/**
 * Physical pocket order on a European (single-zero) wheel, clockwise from 0.
 * Used purely for the spin animation so the reel shows real neighbours, not random
 * numbers. The outcome itself is still a uniform draw from spin().
 */
export const WHEEL_SEQUENCE: readonly number[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];

const range = (from: number, to: number, step = 1): number[] => {
  const out: number[] = [];
  for (let n = from; n <= to; n += step) out.push(n);
  return out;
};

const key = (nums: number[]): string => [...nums].sort((a, b) => a - b).join(",");

// Precompute every valid inside bet group (split/street/corner/sixline), so a set
// of numbers entered by the player can be validated by exact lookup.
const INSIDE_GROUPS = new Map<string, BetDef>();
{
  const add = (numbers: number[], kind: BetKind, payout: number, label: string) =>
    INSIDE_GROUPS.set(key(numbers), { kind, numbers: [...numbers].sort((a, b) => a - b), payout, label });

  for (let r = 0; r < 12; r++) {
    const base = r * 3 + 1; // 1,4,7,...
    add([base, base + 1, base + 2], "street", 11, `Street ${base}-${base + 2}`);
    add([base, base + 1], "split", 17, `Split ${base}/${base + 1}`);
    add([base + 1, base + 2], "split", 17, `Split ${base + 1}/${base + 2}`);
  }
  for (let n = 1; n <= 33; n++) add([n, n + 3], "split", 17, `Split ${n}/${n + 3}`);
  add([0, 1], "split", 17, "Split 0/1");
  add([0, 2], "split", 17, "Split 0/2");
  add([0, 3], "split", 17, "Split 0/3");

  for (let r = 0; r < 11; r++) {
    const base = r * 3 + 1;
    add([base, base + 1, base + 3, base + 4], "corner", 8, `Corner ${base}`);
    add([base + 1, base + 2, base + 4, base + 5], "corner", 8, `Corner ${base + 1}`);
    add([base, base + 1, base + 2, base + 3, base + 4, base + 5], "sixline", 5, `Six-line ${base}-${base + 5}`);
  }
  add([0, 1, 2, 3], "corner", 8, "First four 0-1-2-3");
}

/** Outside bets, by id. Zero is excluded from all of them (that's the house edge). */
export const OUTSIDE_BETS: Record<string, () => BetDef> = {
  red: () => ({ kind: "red", numbers: [...RED], payout: 1, label: "Red" }),
  black: () => ({
    kind: "black",
    numbers: range(1, 36).filter((n) => !RED.has(n)),
    payout: 1,
    label: "Black",
  }),
  green: () => ({ kind: "green", numbers: [0], payout: 35, label: "Green (0)" }),
  even: () => ({ kind: "even", numbers: range(2, 36, 2), payout: 1, label: "Even" }),
  odd: () => ({ kind: "odd", numbers: range(1, 35, 2), payout: 1, label: "Odd" }),
  low: () => ({ kind: "low", numbers: range(1, 18), payout: 1, label: "1-18 (low)" }),
  high: () => ({ kind: "high", numbers: range(19, 36), payout: 1, label: "19-36 (high)" }),
  dozen1: () => ({ kind: "dozen", numbers: range(1, 12), payout: 2, label: "1st dozen (1-12)" }),
  dozen2: () => ({ kind: "dozen", numbers: range(13, 24), payout: 2, label: "2nd dozen (13-24)" }),
  dozen3: () => ({ kind: "dozen", numbers: range(25, 36), payout: 2, label: "3rd dozen (25-36)" }),
  column1: () => ({ kind: "column", numbers: range(1, 34, 3), payout: 2, label: "Column 1" }),
  column2: () => ({ kind: "column", numbers: range(2, 35, 3), payout: 2, label: "Column 2" }),
  column3: () => ({ kind: "column", numbers: range(3, 36, 3), payout: 2, label: "Column 3" }),
};

/** Resolve raw numbers entered for an inside bet into a valid BetDef, or null. */
export function resolveInsideBet(numbers: number[]): BetDef | null {
  const unique = [...new Set(numbers)];
  if (unique.some((n) => !Number.isInteger(n) || n < 0 || n > 36)) return null;

  if (unique.length === 1) {
    const n = unique[0]!;
    return { kind: "straight", numbers: [n], payout: 35, label: `Straight ${n}` };
  }
  return INSIDE_GROUPS.get(key(unique)) ?? null;
}

export function isWinning(bet: BetDef, result: number): boolean {
  return bet.numbers.includes(result);
}

/** Total chips returned for a bet given the result (0 if it loses). */
export function returnFor(bet: BetDef, amount: number, result: number): number {
  return isWinning(bet, result) ? amount * (bet.payout + 1) : 0;
}

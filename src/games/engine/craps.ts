import { intBetween } from "./rng.ts";

/**
 * Simplified craps: a two-dice game played over a round of one or more rolls.
 *
 * Line bets (resolved over the whole round):
 *   - Pass Line   — even money; wins on a come-out 7/11, then on hitting the point.
 *   - Don't Pass  — even money; mirror of Pass; come-out 12 is barred (pushes).
 * One-roll bet (resolved on the come-out roll only):
 *   - Field       — 3,4,9,10,11 pay 1:1; 2 pays 2:1; 12 pays 3:1; 5,6,7,8 lose.
 *
 * ponytail: Field is settled on the come-out roll only; real-table Field pays on
 * every roll. Upgrade path: re-resolve Field on each point-phase roll too.
 */

export type CrapsBetKind = "pass" | "dontpass" | "field";

export const CRAPS_BET_LABELS: Record<CrapsBetKind, string> = {
  pass: "Pass Line",
  dontpass: "Don't Pass",
  field: "Field",
};

/** Roll two d6. */
export function rollPair(): [number, number] {
  return [intBetween(1, 6), intBetween(1, 6)];
}

/**
 * Terminal result for the line bets, or `point` when the round must keep rolling.
 *   - pass     → Pass wins, Don't Pass loses
 *   - dontpass → Don't Pass wins, Pass loses
 *   - push     → Pass loses, Don't Pass pushes (come-out 12, "bar 12")
 *   - point    → no decision yet; this number becomes the point
 */
export type RoundResult =
  | { type: "pass" }
  | { type: "dontpass" }
  | { type: "push" }
  | { type: "point"; point: number };

/** Resolve a come-out roll sum into a line result. */
export function comeOutOutcome(sum: number): RoundResult {
  if (sum === 7 || sum === 11) return { type: "pass" };
  if (sum === 2 || sum === 3) return { type: "dontpass" };
  if (sum === 12) return { type: "push" };
  return { type: "point", point: sum };
}

/** Resolve a point-phase roll: hit the point (Pass wins), seven-out (Don't wins), or keep rolling (null). */
export function pointOutcome(sum: number, point: number): RoundResult | null {
  if (sum === point) return { type: "pass" };
  if (sum === 7) return { type: "dontpass" };
  return null;
}

/** Total chips returned for a Pass/Don't Pass bet given the terminal round result (0 if it loses). */
export function lineReturn(kind: "pass" | "dontpass", amount: number, result: RoundResult): number {
  switch (result.type) {
    case "pass":
      return kind === "pass" ? amount * 2 : 0;
    case "dontpass":
      return kind === "dontpass" ? amount * 2 : 0;
    case "push":
      return kind === "dontpass" ? amount : 0; // bar 12: Don't Pass pushes, Pass loses
    default:
      return 0; // not terminal
  }
}

/** Total chips returned for a Field bet given the come-out roll sum (0 if it loses). */
export function fieldReturn(amount: number, sum: number): number {
  if (sum === 12) return amount * 4; // 3:1 (the player-friendly Field; drops the edge to ~2.78%)
  if (sum === 2) return amount * 3; // 2:1
  if (sum === 3 || sum === 4 || sum === 9 || sum === 10 || sum === 11) return amount * 2; // 1:1
  return 0; // 5,6,7,8 lose
}

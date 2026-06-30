import { secureInt } from "./rng.ts";

/**
 * Pure crash math. The multiplier climbs as m(t) = e^(k·t), so it accelerates over
 * time; `growthRate` picks k from a friendlier "doubles every N seconds" knob.
 */

/** k such that the multiplier doubles every `doubleEverySeconds`. */
export function growthRate(doubleEverySeconds: number): number {
  return Math.LN2 / doubleEverySeconds;
}

/** The multiplier `elapsedSec` into a flight. */
export function multiplierAt(k: number, elapsedSec: number): number {
  return Math.exp(k * elapsedSec);
}

/** Seconds at which a flight reaches `multiplier` — the inverse of multiplierAt. */
export function timeToReach(k: number, multiplier: number): number {
  return Math.log(multiplier) / k;
}

/**
 * Roll where a flight busts. P(crash >= m) = (1 - houseEdge) / m, so the EV of any
 * cash-out target T is T · (1 - houseEdge)/T = (1 - houseEdge) — the house edge is the
 * same whatever target you aim for. About `houseEdge` of rolls land below 1.0 and clamp
 * to an instant 1.00x bust. Uses the crypto RNG, floored to 2 decimals, capped.
 */
export function rollCrashPoint(houseEdge: number, maxMultiplier: number): number {
  const u = (secureInt(1_000_000) + 1) / 1_000_000; // uniform in (0, 1] — no divide-by-zero
  const raw = (1 - houseEdge) / u;
  return Math.min(maxMultiplier, Math.max(1, Math.floor(raw * 100) / 100));
}

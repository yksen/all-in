import { expect, test } from "bun:test";
import { growthRate, multiplierAt, rollCrashPoint, timeToReach } from "./crash.ts";

test("multiplierAt and timeToReach are inverses", () => {
  const k = growthRate(6);
  expect(multiplierAt(k, 0)).toBeCloseTo(1, 10); // starts at 1.00x
  expect(multiplierAt(k, 6)).toBeCloseTo(2, 10); // doubles every 6s
  for (const m of [1.5, 2, 5, 10, 50]) {
    expect(multiplierAt(k, timeToReach(k, m))).toBeCloseTo(m, 9);
  }
});

test("rollCrashPoint stays within bounds", () => {
  for (let i = 0; i < 50_000; i++) {
    const c = rollCrashPoint(0.01, 50);
    expect(c).toBeGreaterThanOrEqual(1);
    expect(c).toBeLessThanOrEqual(50);
    expect(Number.isFinite(c)).toBe(true);
  }
});

test("rollCrashPoint has ~1% house edge (EV of a cash-out target ≈ 0.99)", () => {
  // EV of always cashing out at target T = T · P(crash >= T). With a 1% edge this is ≈ 0.99
  // for any reachable T. Test T = 2 over many samples (uncapped tail, so use a high cap).
  const T = 2;
  const N = 300_000;
  let wins = 0;
  for (let i = 0; i < N; i++) {
    if (rollCrashPoint(0.01, 1e9) >= T) wins++;
  }
  const ev = T * (wins / N);
  expect(ev).toBeGreaterThan(0.96);
  expect(ev).toBeLessThan(1.0); // never favours the player
});

test("payout flooring keeps chips integer", () => {
  const bet = 137;
  const mult = 2.37;
  const payout = Math.floor(bet * Math.floor(mult * 100) / 100);
  expect(Number.isInteger(payout)).toBe(true);
  expect(payout).toBe(324); // 137 * 2.37 = 324.69 → 324
});

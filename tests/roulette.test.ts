import { describe, expect, test } from "bun:test";
import { OUTSIDE_BETS, resolveInsideBet, returnFor, spin, WHEEL_SEQUENCE } from "../src/games/engine/roulette.ts";

describe("roulette payouts", () => {
  test("straight bet pays 35:1 (returns 36x) only on its number", () => {
    const bet = resolveInsideBet([17])!;
    expect(bet.payout).toBe(35);
    expect(returnFor(bet, 10, 17)).toBe(360);
    expect(returnFor(bet, 10, 18)).toBe(0);
    expect(returnFor(bet, 10, 0)).toBe(0);
  });

  test("valid and invalid inside bets", () => {
    expect(resolveInsideBet([1, 2])?.kind).toBe("split");
    expect(resolveInsideBet([1, 2, 3])?.kind).toBe("street");
    expect(resolveInsideBet([1, 2, 4, 5])?.kind).toBe("corner");
    expect(resolveInsideBet([1, 2, 3, 4, 5, 6])?.kind).toBe("sixline");
    expect(resolveInsideBet([1, 5])).toBeNull(); // not adjacent
    expect(resolveInsideBet([40])).toBeNull(); // out of range
  });

  test("red loses on zero (house edge source)", () => {
    const red = OUTSIDE_BETS.red!();
    expect(returnFor(red, 10, 1)).toBe(20);
    expect(returnFor(red, 10, 2)).toBe(0); // 2 is black
    expect(returnFor(red, 10, 0)).toBe(0); // green
  });

  test("wheel sequence is a permutation of 0..36 starting at zero", () => {
    expect(WHEEL_SEQUENCE).toHaveLength(37);
    expect(WHEEL_SEQUENCE[0]).toBe(0);
    expect([...new Set(WHEEL_SEQUENCE)].sort((a, b) => a - b)).toEqual([...Array(37).keys()]);
    // Spot-check real adjacencies on the European wheel (17 sits between 34 and 25).
    const i = WHEEL_SEQUENCE.indexOf(17);
    expect(new Set([WHEEL_SEQUENCE[i - 1], WHEEL_SEQUENCE[i + 1]])).toEqual(new Set([34, 25]));
  });

  test("Monte Carlo RTP of an even-money bet is ~97.3%", () => {
    const red = OUTSIDE_BETS.red!();
    const rounds = 200_000;
    let returned = 0;
    for (let i = 0; i < rounds; i++) returned += returnFor(red, 1, spin());
    const rtp = returned / rounds;
    // True RTP = 18/37 * 2 = 0.9729...; allow generous tolerance for randomness.
    expect(rtp).toBeGreaterThan(0.94);
    expect(rtp).toBeLessThan(1.0);
  });
});

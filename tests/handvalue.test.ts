import { describe, expect, test } from "bun:test";
import { handTotal, isBlackjack, isBust } from "../src/games/engine/handvalue.ts";
import { c } from "./util.ts";

describe("blackjack hand value", () => {
  test("ace + king is a soft 21 (natural)", () => {
    const hand = [c(1, "S"), c(13, "H")];
    expect(handTotal(hand)).toEqual({ total: 21, soft: true });
    expect(isBlackjack(hand)).toBe(true);
  });

  test("aces demote to avoid busting", () => {
    expect(handTotal([c(1, "S"), c(1, "H"), c(9, "D")])).toEqual({ total: 21, soft: true });
    expect(handTotal([c(1, "S"), c(1, "H"), c(1, "D"), c(9, "C")])).toEqual({ total: 12, soft: false });
  });

  test("soft 17", () => {
    expect(handTotal([c(1, "S"), c(6, "H")])).toEqual({ total: 17, soft: true });
  });

  test("bust over 21", () => {
    const hand = [c(13, "S"), c(12, "H"), c(2, "D")];
    expect(handTotal(hand).total).toBe(22);
    expect(isBust(hand)).toBe(true);
  });

  test("three cards making 21 is not a natural blackjack", () => {
    expect(isBlackjack([c(7, "S"), c(7, "H"), c(7, "D")])).toBe(false);
  });
});

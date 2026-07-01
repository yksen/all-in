import { expect, test } from "bun:test";
import type { Suit } from "./deck.ts";
import type { Card } from "./deck.ts";
import { canSplit, dealerShouldHit, firstUnfinished, makeHand, settleHand } from "./blackjack.ts";

const c = (rank: number, suit: Suit = "S"): Card => ({ rank, suit });

test("settleHand: player total beats dealer total pays 1:1 (win)", () => {
  const hand = makeHand(100, [c(10), c(9)]); // 19
  expect(settleHand(hand, [c(10), c(8)])).toEqual({ ret: 200, outcome: "win" }); // dealer 18
});

test("settleHand: player busts is a loss regardless of dealer", () => {
  const hand = makeHand(100, [c(10), c(9), c(5)]); // 24, bust
  expect(settleHand(hand, [c(1), c(9)])).toEqual({ ret: 0, outcome: "loss" }); // dealer 20
});

test("settleHand: equal totals push", () => {
  const hand = makeHand(100, [c(10), c(9)]); // 19
  expect(settleHand(hand, [c(10), c(9)])).toEqual({ ret: 100, outcome: "push" });
});

test("settleHand: dealer bust is a win for any non-busted hand", () => {
  const hand = makeHand(100, [c(2), c(3)]); // 5
  expect(settleHand(hand, [c(10), c(9), c(5)])).toEqual({ ret: 200, outcome: "win" }); // dealer 24
});

test("settleHand: natural blackjack pays 3:2 when dealer has no natural", () => {
  const hand = makeHand(100, [c(1), c(13)]); // ace + king = 21
  expect(settleHand(hand, [c(10), c(8)])).toEqual({ ret: 250, outcome: "blackjack" }); // 100 + floor(150)
});

test("settleHand: both naturals push, even though the player's is a blackjack", () => {
  const hand = makeHand(100, [c(1), c(13)]);
  expect(settleHand(hand, [c(1), c(12)])).toEqual({ ret: 100, outcome: "push" });
});

test("settleHand: a 21 from a split hand is not a natural — just a strong total", () => {
  const hand = makeHand(100, [c(1), c(13)], true); // fromSplit
  expect(settleHand(hand, [c(10), c(8)])).toEqual({ ret: 200, outcome: "win" }); // 1:1, not 3:2
  expect(settleHand(hand, [c(1), c(12)])).toEqual({ ret: 0, outcome: "loss" }); // dealer's natural still beats a 21 that isn't one
});

test("settleHand: surrender returns half the bet, floored", () => {
  const hand = makeHand(101, [c(10), c(6)]);
  hand.surrendered = true;
  expect(settleHand(hand, [c(10), c(9)])).toEqual({ ret: 50, outcome: "surrender" });
});

test("dealerShouldHit: hits below 17, stands on hard 17+", () => {
  expect(dealerShouldHit([c(10), c(6)])).toBe(true); // 16
  expect(dealerShouldHit([c(10), c(7)])).toBe(false); // hard 17
  expect(dealerShouldHit([c(10), c(9)])).toBe(false); // 19
});

test("dealerShouldHit: hits soft 17 (config default: dealerHitsSoft17 = true)", () => {
  expect(dealerShouldHit([c(1), c(6)])).toBe(true); // soft 17 (A+6)
});

test("firstUnfinished: skips done hands, including ones inserted by a split", () => {
  const first = makeHand(100, [c(8), c(8)]);
  first.done = true;
  const second = makeHand(100, [c(8)]); // the split-off hand, still live
  const third = makeHand(100, [c(5), c(6)]);
  expect(firstUnfinished([first, second, third])).toBe(1);
});

test("firstUnfinished: -1 once every hand is done", () => {
  const hands = [makeHand(100, [c(8), c(8)]), makeHand(100, [c(5), c(6)])];
  for (const h of hands) h.done = true;
  expect(firstUnfinished(hands)).toBe(-1);
});

test("canSplit: true for a matching pair with room for another hand", () => {
  expect(canSplit(makeHand(100, [c(8), c(8)]), 1)).toBe(true);
  expect(canSplit(makeHand(100, [c(13), c(10)]), 1)).toBe(true); // both worth 10
});

test("canSplit: false for a non-pair, or once the hand limit is reached", () => {
  expect(canSplit(makeHand(100, [c(8), c(9)]), 1)).toBe(false);
  expect(canSplit(makeHand(100, [c(8), c(8)]), 4)).toBe(false); // MAX_TOTAL_HANDS reached
});

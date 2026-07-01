import { expect, test } from "bun:test";
import { baccaratValue, decideWinner, playHand, settle, total } from "./engine/baccarat.ts";
import { Shoe } from "./engine/deck.ts";
import type { Card, Suit } from "./engine/deck.ts";

const c = (rank: number, suit: Suit = "S"): Card => ({ rank, suit });

/** A draw thunk yielding scripted cards in deal order: P1, P2, B1, B2, [P3], [B3]. */
function scripted(cards: Card[]): () => Card {
  let i = 0;
  return () => {
    const card = cards[i++];
    if (!card) throw new Error("scripted deck exhausted");
    return card;
  };
}

const CFG = { bankerCommissionPct: 5, tiePayout: 8 };

test("baccaratValue: ace=1, 2–9 face, ten/court=0", () => {
  expect(baccaratValue(c(1))).toBe(1);
  expect(baccaratValue(c(7))).toBe(7);
  expect(baccaratValue(c(9))).toBe(9);
  for (const r of [10, 11, 12, 13]) expect(baccaratValue(c(r))).toBe(0);
});

test("total is mod-10", () => {
  expect(total([c(7), c(8)])).toBe(5); // 15 % 10
  expect(total([c(10), c(13)])).toBe(0);
  expect(total([c(9), c(4)])).toBe(3); // 13 % 10
});

test("natural stands both hands (no third cards)", () => {
  const { player, banker } = playHand(scripted([c(4), c(5), c(1), c(2)])); // player 9 vs banker 3
  expect(player).toHaveLength(2);
  expect(banker).toHaveLength(2); // banker would draw on 3, but a natural freezes the coup
  expect(decideWinner(player, banker)).toBe("player");
});

test("player stands 6–7; banker draws when player stood and banker ≤5", () => {
  const { player, banker } = playHand(scripted([c(6), c(1), c(2), c(3), c(4)])); // player 7 stands, banker 5 draws
  expect(player).toHaveLength(2);
  expect(banker).toHaveLength(3);
});

test("tableau: banker 3 stands when player's third card is an 8", () => {
  const { player, banker } = playHand(scripted([c(2), c(3), c(1), c(2), c(8)])); // player 5→draws 8; banker 3 stands
  expect(player).toHaveLength(3);
  expect(banker).toHaveLength(2);
});

test("tableau: banker 3 draws when player's third card is not an 8", () => {
  const { player, banker } = playHand(scripted([c(2), c(3), c(1), c(2), c(5), c(4)])); // banker 3, p3=5 → draws
  expect(player).toHaveLength(3);
  expect(banker).toHaveLength(3);
});

test("tableau: banker 6 draws on player third 6, stands otherwise", () => {
  const draws = playHand(scripted([c(2), c(2), c(3), c(3), c(6), c(1)])); // player 4→6, banker 6, p3=6 → draws
  expect(draws.banker).toHaveLength(3);
  const stands = playHand(scripted([c(2), c(2), c(3), c(3), c(5)])); // banker 6, p3=5 → stands
  expect(stands.banker).toHaveLength(2);
});

test("settle: player win pays 1:1", () => {
  expect(settle(100, "player", "player", CFG)).toEqual({ ret: 200, outcome: "win" });
});

test("settle: banker win pays 0.95:1 (commission, floored)", () => {
  expect(settle(100, "banker", "banker", CFG)).toEqual({ ret: 195, outcome: "win" });
  expect(settle(101, "banker", "banker", CFG)).toEqual({ ret: 196, outcome: "win" }); // 101 + floor(95.95)
});

test("settle: tie bet pays 8:1", () => {
  expect(settle(50, "tie", "tie", CFG)).toEqual({ ret: 450, outcome: "win" });
});

test("settle: player/banker bets push on a tie; wrong side loses", () => {
  expect(settle(100, "player", "tie", CFG)).toEqual({ ret: 100, outcome: "push" });
  expect(settle(100, "banker", "tie", CFG)).toEqual({ ret: 100, outcome: "push" });
  expect(settle(100, "tie", "player", CFG)).toEqual({ ret: 0, outcome: "loss" });
  expect(settle(100, "player", "banker", CFG)).toEqual({ ret: 0, outcome: "loss" });
});

test("property: real shoe hands have totals 0–9 and a consistent winner", () => {
  const shoe = new Shoe(8);
  for (let i = 0; i < 500; i++) {
    if (shoe.remaining < 6) break; // a coup draws at most 6 cards
    const { player, banker } = playHand(() => shoe.draw());
    const pt = total(player);
    const bt = total(banker);
    expect(pt).toBeGreaterThanOrEqual(0);
    expect(pt).toBeLessThanOrEqual(9);
    expect(bt).toBeGreaterThanOrEqual(0);
    expect(bt).toBeLessThanOrEqual(9);
    const win = decideWinner(player, banker);
    expect(win).toBe(pt > bt ? "player" : bt > pt ? "banker" : "tie");
  }
});

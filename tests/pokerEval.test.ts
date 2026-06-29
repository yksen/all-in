import { describe, expect, test } from "bun:test";
import { bestOf, compareRanks } from "../src/games/engine/pokerEval.ts";
import { c } from "./util.ts";

describe("poker hand ranking", () => {
  test("category ordering", () => {
    const royal = bestOf([c(10, "S"), c(11, "S"), c(12, "S"), c(13, "S"), c(1, "S")]);
    const straightFlush = bestOf([c(5, "H"), c(6, "H"), c(7, "H"), c(8, "H"), c(9, "H")]);
    const quads = bestOf([c(9, "S"), c(9, "H"), c(9, "D"), c(9, "C"), c(2, "S")]);
    const fullHouse = bestOf([c(9, "S"), c(9, "H"), c(9, "D"), c(2, "C"), c(2, "S")]);
    const flush = bestOf([c(2, "S"), c(5, "S"), c(7, "S"), c(9, "S"), c(11, "S")]);
    const straight = bestOf([c(5, "H"), c(6, "S"), c(7, "H"), c(8, "D"), c(9, "C")]);
    const trips = bestOf([c(9, "S"), c(9, "H"), c(9, "D"), c(2, "C"), c(5, "S")]);
    const twoPair = bestOf([c(9, "S"), c(9, "H"), c(2, "D"), c(2, "C"), c(5, "S")]);
    const pair = bestOf([c(9, "S"), c(9, "H"), c(2, "D"), c(4, "C"), c(7, "S")]);
    const high = bestOf([c(9, "S"), c(11, "H"), c(2, "D"), c(4, "C"), c(7, "S")]);

    const ladder = [high, pair, twoPair, trips, straight, flush, fullHouse, quads, straightFlush, royal];
    for (let i = 1; i < ladder.length; i++) {
      expect(compareRanks(ladder[i]!.score, ladder[i - 1]!.score)).toBe(1);
    }
    expect(royal.name).toBe("Royal flush");
  });

  test("wheel A-2-3-4-5 is a straight to the five", () => {
    const wheel = bestOf([c(1, "S"), c(2, "H"), c(3, "D"), c(4, "C"), c(5, "S")]);
    expect(wheel.score[0]).toBe(4); // straight
    expect(wheel.score[1]).toBe(5); // high card is the 5, not the ace
  });

  test("best 5 of 7 finds the flush", () => {
    const r = bestOf([c(2, "S"), c(5, "S"), c(7, "S"), c(9, "S"), c(11, "S"), c(13, "H"), c(13, "D")]);
    expect(r.name).toBe("Flush");
  });

  test("higher kicker wins", () => {
    const a = bestOf([c(1, "S"), c(13, "H"), c(9, "D"), c(5, "C"), c(2, "S")]); // A high
    const b = bestOf([c(13, "S"), c(12, "H"), c(9, "C"), c(5, "D"), c(2, "H")]); // K high
    expect(compareRanks(a.score, b.score)).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { Rounds } from "../src/economy/rounds.ts";
import { memDb } from "./util.ts";

const G = "guild1";
const U = "userA";

describe("user stats", () => {
  test("best win / worst loss never double-count a single result", () => {
    const rounds = new Rounds(memDb());

    // A player with only a win: worst loss must be 0, not the win.
    rounds.record({ game: "coinflip", guildId: G, userId: U, wager: 100, payout: 250, outcome: "win", startedAt: 0 });
    const afterWin = rounds.userStats(G, U);
    expect(afterWin.biggestWin).toBe(150);
    expect(afterWin.biggestLoss).toBe(0);

    // Add a loss: now both fields reflect their own side.
    rounds.record({ game: "coinflip", guildId: G, userId: U, wager: 200, payout: 0, outcome: "loss", startedAt: 0 });
    const afterLoss = rounds.userStats(G, U);
    expect(afterLoss.biggestWin).toBe(150);
    expect(afterLoss.biggestLoss).toBe(-200);
  });

  test("a player with only losses has no best win", () => {
    const rounds = new Rounds(memDb());
    rounds.record({ game: "roulette", guildId: G, userId: U, wager: 50, payout: 0, outcome: "loss", startedAt: 0 });
    const s = rounds.userStats(G, U);
    expect(s.biggestWin).toBe(0);
    expect(s.biggestLoss).toBe(-50);
  });
});

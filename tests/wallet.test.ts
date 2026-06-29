import { describe, expect, test } from "bun:test";
import { InsufficientFundsError, Wallet } from "../src/economy/wallet.ts";
import { config } from "../src/config.ts";
import { memDb } from "./util.ts";

const G = "guild1";
const U = "userA";

describe("wallet & ledger", () => {
  test("welcome bonus granted exactly once", () => {
    const w = new Wallet(memDb());
    const first = w.ensureAccount(G, U);
    expect(first).toEqual({ created: true, balance: config.economy.welcomeBonus });
    const second = w.ensureAccount(G, U);
    expect(second.created).toBe(false);
    expect(w.getBalance(G, U)).toBe(config.economy.welcomeBonus);
  });

  test("welcome bonus is still granted when a voice credit created the row first", () => {
    const w = new Wallet(memDb());
    // A user earns from voice before ever running a command — this creates their users
    // row at balance 0 via ensureUserRow, with no welcome entry.
    w.applyDelta({ guildId: G, userId: U, delta: 5, type: "earn_voice" });
    expect(w.getBalance(G, U)).toBe(5);

    const res = w.ensureAccount(G, U);
    expect(res.created).toBe(true);
    expect(w.getBalance(G, U)).toBe(config.economy.welcomeBonus + 5);

    // And it stays one-time.
    expect(w.ensureAccount(G, U).created).toBe(false);
    expect(w.getBalance(G, U)).toBe(config.economy.welcomeBonus + 5);
  });

  test("debit beyond balance throws and leaves balance intact", () => {
    const w = new Wallet(memDb());
    w.ensureAccount(G, U);
    const before = w.getBalance(G, U);
    expect(() => w.applyDelta({ guildId: G, userId: U, delta: -(before + 1), type: "bet" })).toThrow(
      InsufficientFundsError,
    );
    expect(w.getBalance(G, U)).toBe(before);
  });

  test("ledger balance_after tracks the running balance", () => {
    const db = memDb();
    const w = new Wallet(db);
    w.ensureAccount(G, U);
    w.applyDelta({ guildId: G, userId: U, delta: -100, type: "bet" });
    w.applyDelta({ guildId: G, userId: U, delta: 250, type: "payout" });
    const rows = db.query("SELECT balance_after FROM ledger WHERE guild_id=? AND user_id=? ORDER BY id").all(G, U) as {
      balance_after: number;
    }[];
    const start = config.economy.welcomeBonus;
    expect(rows.map((r) => r.balance_after)).toEqual([start, start - 100, start - 100 + 250]);
    expect(w.getBalance(G, U)).toBe(start + 150);
  });

  test("rollback by ref reverses net effect and is idempotent", () => {
    const w = new Wallet(memDb());
    w.ensureAccount(G, U);
    const start = w.getBalance(G, U);
    w.applyDelta({ guildId: G, userId: U, delta: 5000, type: "payout", ref: "buggy-round" });
    expect(w.getBalance(G, U)).toBe(start + 5000);

    const first = w.rollbackByRef(G, "buggy-round");
    expect(first.alreadyDone).toBe(false);
    expect(w.getBalance(G, U)).toBe(start);

    const second = w.rollbackByRef(G, "buggy-round");
    expect(second.alreadyDone).toBe(true);
    expect(w.getBalance(G, U)).toBe(start);
  });

  test("adjust clamps so balance never goes negative", () => {
    const w = new Wallet(memDb());
    w.ensureAccount(G, U);
    const start = w.getBalance(G, U);
    const { applied, balanceAfter } = w.adjust(G, U, -(start + 9999), "admin_adjust");
    expect(applied).toBe(-start);
    expect(balanceAfter).toBe(0);
  });

  test("placeBet escrows chips and is refunded on startup recovery", () => {
    const w = new Wallet(memDb());
    w.ensureAccount(G, U);
    const start = w.getBalance(G, U);
    w.placeBet({ guildId: G, userId: U, amount: 300, game: "blackjack", ref: "sess1", channelId: "c", messageId: "m" });
    expect(w.getBalance(G, U)).toBe(start - 300);
    expect(w.listOpenGames()).toHaveLength(1);

    const res = w.refundOpenGames(); // simulates a restart mid-game
    expect(res).toMatchObject({ count: 1, total: 300 });
    expect(w.getBalance(G, U)).toBe(start);
    expect(w.listOpenGames()).toHaveLength(0);
  });

  test("closeGame clears tracking so settled games are never refunded", () => {
    const w = new Wallet(memDb());
    w.ensureAccount(G, U);
    w.placeBet({ guildId: G, userId: U, amount: 200, game: "roulette", ref: "sess2" });
    w.closeGame("sess2");
    expect(w.listOpenGames()).toHaveLength(0);
    expect(w.refundOpenGames().count).toBe(0);
  });

  test("trackEscrow sets an absolute amount; 0 removes the record", () => {
    const w = new Wallet(memDb());
    w.ensureAccount(G, U);
    w.trackEscrow({ ref: "c1", userId: U, guildId: G, game: "craps", amount: 120 });
    expect(w.listOpenGames()[0]?.escrow).toBe(120);
    w.trackEscrow({ ref: "c1", userId: U, guildId: G, game: "craps", amount: 50 });
    expect(w.listOpenGames()[0]?.escrow).toBe(50);
    w.trackEscrow({ ref: "c1", userId: U, guildId: G, game: "craps", amount: 0 });
    expect(w.listOpenGames()).toHaveLength(0);
  });
});

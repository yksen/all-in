import type { Database } from "bun:sqlite";
import { config } from "../config.ts";

export type LedgerType =
  | "welcome"
  | "earn_voice"
  | "bet"
  | "payout"
  | "admin_adjust"
  | "rollback";

export interface LedgerEntryInput {
  guildId: string;
  userId: string;
  /** Signed amount of chips to add to the balance. */
  delta: number;
  type: LedgerType;
  game?: string | null;
  ref?: string | null;
  meta?: unknown;
}

export interface LedgerRow {
  id: number;
  ts: number;
  guild_id: string;
  user_id: string;
  delta: number;
  balance_after: number;
  type: string;
  game: string | null;
  ref: string | null;
  meta: string | null;
}

export class InsufficientFundsError extends Error {
  constructor(
    public readonly balance: number,
    public readonly needed: number,
  ) {
    super(`Insufficient funds: have ${balance}, need ${needed}`);
    this.name = "InsufficientFundsError";
  }
}

/**
 * The ONLY place chips move. Every balance change is applied atomically together
 * with an append-only `ledger` row recording the delta, the resulting balance, and
 * why. That ledger is what makes auditing, leaderboards and rollback possible.
 */
export class Wallet {
  constructor(private readonly db: Database) {}

  /** Create the row at 0 if missing. No welcome bonus (used by internal credits). */
  private ensureUserRow(guildId: string, userId: string): void {
    this.db
      .query("INSERT OR IGNORE INTO users (guild_id, user_id, balance, created_at) VALUES (?, ?, 0, ?)")
      .run(guildId, userId, Date.now());
  }

  getBalance(guildId: string, userId: string): number {
    const row = this.db
      .query("SELECT balance FROM users WHERE guild_id = ? AND user_id = ?")
      .get(guildId, userId) as { balance: number } | null;
    return row?.balance ?? 0;
  }

  /**
   * Ensure an account exists; grant the one-time welcome bonus if it hasn't been given
   * yet. Call this once per interaction before any game logic runs. Idempotent.
   *
   * The bonus is keyed on the *ledger* (has a `welcome` entry ever been written?), not on
   * whether the users row exists — otherwise any path that creates the row first, such as
   * a voice-earning credit (`applyDelta` -> `ensureUserRow`), would silently pre-empt the
   * bonus and the player would never receive it. `created` reports whether the bonus was
   * granted on this call.
   */
  ensureAccount(guildId: string, userId: string): { created: boolean; balance: number } {
    const txn = this.db.transaction(() => {
      this.ensureUserRow(guildId, userId);

      const alreadyWelcomed = this.db
        .query("SELECT 1 FROM ledger WHERE guild_id = ? AND user_id = ? AND type = 'welcome' LIMIT 1")
        .get(guildId, userId);
      if (alreadyWelcomed) return { created: false, balance: this.getBalance(guildId, userId) };

      const bonus = config.economy.welcomeBonus;
      if (bonus <= 0) return { created: false, balance: this.getBalance(guildId, userId) };

      // applyDelta records the 'welcome' ledger row and adds to any balance already
      // accrued (e.g. from voice). Safe inside this transaction (bun:sqlite savepoints).
      const balance = this.applyDelta({ guildId, userId, delta: bonus, type: "welcome" });
      return { created: true, balance };
    });
    return txn();
  }

  /**
   * Apply a signed delta to a balance and record it in the ledger, atomically.
   * Throws InsufficientFundsError if the result would be negative (debits only).
   * Returns the resulting balance. Safe to call inside an outer transaction
   * (bun:sqlite nests via savepoints).
   */
  applyDelta(input: LedgerEntryInput): number {
    const txn = this.db.transaction(() => {
      this.ensureUserRow(input.guildId, input.userId);
      const balance = this.getBalance(input.guildId, input.userId);
      const after = balance + input.delta;
      if (after < 0) throw new InsufficientFundsError(balance, -input.delta);

      this.db
        .query("UPDATE users SET balance = ? WHERE guild_id = ? AND user_id = ?")
        .run(after, input.guildId, input.userId);
      this.db
        .query(
          "INSERT INTO ledger (ts, guild_id, user_id, delta, balance_after, type, game, ref, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          Date.now(),
          input.guildId,
          input.userId,
          input.delta,
          after,
          input.type,
          input.game ?? null,
          input.ref ?? null,
          input.meta != null ? JSON.stringify(input.meta) : null,
        );
      return after;
    });
    return txn();
  }

  /**
   * Apply a delta that is clamped so the balance never goes below zero (used by
   * admin adjustments and rollbacks, where reversing a credit the user already
   * spent should just zero them out rather than fail). Returns what was actually
   * applied. Records the original requested amount in the ledger meta.
   */
  adjust(
    guildId: string,
    userId: string,
    requestedDelta: number,
    type: LedgerType,
    ref: string | null = null,
    meta: Record<string, unknown> = {},
  ): { applied: number; balanceAfter: number } {
    const txn = this.db.transaction(() => {
      this.ensureUserRow(guildId, userId);
      const balance = this.getBalance(guildId, userId);
      const applied = balance + requestedDelta < 0 ? -balance : requestedDelta;
      const after = balance + applied;
      if (applied !== 0) {
        this.db
          .query("UPDATE users SET balance = ? WHERE guild_id = ? AND user_id = ?")
          .run(after, guildId, userId);
        this.db
          .query(
            "INSERT INTO ledger (ts, guild_id, user_id, delta, balance_after, type, game, ref, meta) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
          )
          .run(
            Date.now(),
            guildId,
            userId,
            applied,
            after,
            type,
            ref,
            JSON.stringify({ ...meta, requested: requestedDelta, clamped: applied !== requestedDelta }),
          );
      }
      return { applied, balanceAfter: after };
    });
    return txn();
  }

  /**
   * Reverse the net money effect of every ledger entry sharing a `ref` (e.g. a buggy
   * game round or transfer) by applying compensating, clamped entries per user.
   * Idempotent: re-running on an already-reversed ref is a no-op.
   */
  rollbackByRef(guildId: string, ref: string): { affected: { userId: string; applied: number }[]; alreadyDone: boolean } {
    const marker = `rb:${ref}`;
    const already = this.db
      .query("SELECT 1 FROM ledger WHERE guild_id = ? AND ref = ? LIMIT 1")
      .get(guildId, marker);
    if (already) return { affected: [], alreadyDone: true };

    const rows = this.db
      .query("SELECT user_id, SUM(delta) AS s FROM ledger WHERE guild_id = ? AND ref = ? GROUP BY user_id")
      .all(guildId, ref) as { user_id: string; s: number }[];

    const txn = this.db.transaction(() => {
      const affected: { userId: string; applied: number }[] = [];
      for (const r of rows) {
        if (r.s === 0) continue;
        const { applied } = this.adjust(guildId, r.user_id, -r.s, "rollback", marker, { rolledBackRef: ref });
        affected.push({ userId: r.user_id, applied });
      }
      return affected;
    });
    return { affected: txn(), alreadyDone: false };
  }

  /** Reverse the net change of every user over a recent time window. */
  rollbackWindow(guildId: string, sinceTs: number): { userId: string; applied: number }[] {
    const rows = this.db
      .query("SELECT user_id, SUM(delta) AS s FROM ledger WHERE guild_id = ? AND ts >= ? GROUP BY user_id")
      .all(guildId, sinceTs) as { user_id: string; s: number }[];

    const txn = this.db.transaction(() => {
      const affected: { userId: string; applied: number }[] = [];
      for (const r of rows) {
        if (r.s === 0) continue;
        const { applied } = this.adjust(guildId, r.user_id, -r.s, "rollback", `rbw:${sinceTs}`, {
          window: true,
          sinceTs,
        });
        affected.push({ userId: r.user_id, applied });
      }
      return affected;
    });
    return txn();
  }

  // --- Escrow tracking (crash/restart recovery) -----------------------------
  // Every chip locked into an in-flight game is recorded in `active_games` in the
  // SAME transaction as the debit. When the game ends, closeGame() removes the
  // record. On startup, refundOpenGames() returns whatever is left.

  /** Debit a bet and record it as open escrow (increments the tracked amount). */
  placeBet(opts: {
    guildId: string;
    userId: string;
    amount: number;
    game: string;
    ref: string;
    channelId?: string | null;
    messageId?: string | null;
    meta?: unknown;
  }): number {
    const txn = this.db.transaction(() => {
      const balanceAfter = this.applyDelta({
        guildId: opts.guildId,
        userId: opts.userId,
        delta: -opts.amount,
        type: "bet",
        game: opts.game,
        ref: opts.ref,
        meta: opts.meta,
      });
      this.db
        .query(
          `INSERT INTO active_games (ref, user_id, guild_id, game, escrow, channel_id, message_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ref, user_id) DO UPDATE SET
             escrow = escrow + excluded.escrow,
             channel_id = COALESCE(excluded.channel_id, active_games.channel_id),
             message_id = COALESCE(excluded.message_id, active_games.message_id)`,
        )
        .run(
          opts.ref,
          opts.userId,
          opts.guildId,
          opts.game,
          opts.amount,
          opts.channelId ?? null,
          opts.messageId ?? null,
          Date.now(),
        );
      return balanceAfter;
    });
    return txn();
  }

  /**
   * Set the tracked escrow for a game/player to an absolute amount (used by games
   * where standing bets shrink as they resolve). 0 removes the record.
   */
  trackEscrow(opts: {
    ref: string;
    userId: string;
    guildId: string;
    game: string;
    amount: number;
    channelId?: string | null;
    messageId?: string | null;
  }): void {
    if (opts.amount <= 0) {
      this.db.query("DELETE FROM active_games WHERE ref = ? AND user_id = ?").run(opts.ref, opts.userId);
      return;
    }
    this.db
      .query(
        `INSERT INTO active_games (ref, user_id, guild_id, game, escrow, channel_id, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(ref, user_id) DO UPDATE SET
           escrow = excluded.escrow,
           channel_id = COALESCE(excluded.channel_id, active_games.channel_id),
           message_id = COALESCE(excluded.message_id, active_games.message_id)`,
      )
      .run(
        opts.ref,
        opts.userId,
        opts.guildId,
        opts.game,
        opts.amount,
        opts.channelId ?? null,
        opts.messageId ?? null,
        Date.now(),
      );
  }

  /** Remember which message hosts a game, so recovery can edit it after a restart. */
  setGameMessage(ref: string, channelId: string, messageId: string): void {
    this.db
      .query("UPDATE active_games SET channel_id = ?, message_id = ? WHERE ref = ?")
      .run(channelId, messageId, ref);
  }

  /** Mark a game as settled — drop all escrow tracking rows for its ref. */
  closeGame(ref: string): void {
    this.db.query("DELETE FROM active_games WHERE ref = ?").run(ref);
  }

  listOpenGames(): OpenGame[] {
    return this.db
      .query("SELECT ref, user_id, guild_id, game, escrow, channel_id, message_id FROM active_games")
      .all() as OpenGame[];
  }

  /**
   * Refund every still-open escrow and clear the tracking. Called on startup so a
   * restart/crash that abandoned in-progress games returns players' chips. Each
   * refund + delete is atomic, so it can never double-refund across runs.
   */
  refundOpenGames(): { count: number; total: number; items: OpenGame[] } {
    const rows = this.listOpenGames();
    let total = 0;
    for (const r of rows) {
      const txn = this.db.transaction(() => {
        if (r.escrow > 0) {
          this.adjust(r.guild_id, r.user_id, r.escrow, "rollback", `interrupted:${r.ref}`, {
            interrupted: true,
            game: r.game,
          });
        }
        this.db.query("DELETE FROM active_games WHERE ref = ? AND user_id = ?").run(r.ref, r.user_id);
      });
      txn();
      total += r.escrow;
    }
    return { count: rows.length, total, items: rows };
  }
}

export interface OpenGame {
  ref: string;
  user_id: string;
  guild_id: string;
  game: string;
  escrow: number;
  channel_id: string | null;
  message_id: string | null;
}

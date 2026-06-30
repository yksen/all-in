import type { Database } from "bun:sqlite";

export interface RoundInput {
  game: string;
  guildId: string;
  userId: string;
  wager: number;
  payout: number;
  outcome: string;
  details?: unknown;
  startedAt: number;
}

export interface TopBalanceRow {
  user_id: string;
  balance: number;
  /** Lifetime net across all games (sum of game_rounds.net). */
  net: number;
}

export interface TopRoundRow {
  user_id: string;
  game: string;
  wager: number;
  payout: number;
  net: number;
  outcome: string;
  ended_at: number;
  /** JSON blob; only populated by recentRounds. */
  details?: string | null;
}

export interface ServerStats {
  turnover: number;
  mintedFromActivity: number;
  mintedWelcome: number;
  housePnL: number;
  roundsPlayed: number;
  inCirculation: number;
  players: number;
}

export interface UserStats {
  balance: number;
  totalWagered: number;
  net: number;
  biggestWin: number;
  biggestLoss: number;
  gamesPlayed: number;
  /** Chips this player has earned from voice activity. */
  fromActivity: number;
}

/** Records finished rounds and answers all the leaderboard / stats queries. */
export class Rounds {
  constructor(private readonly db: Database) {}

  /** Persist a finished round for stats. `net` is derived as payout - wager. */
  record(input: RoundInput): number {
    const net = input.payout - input.wager;
    const res = this.db
      .query(
        `INSERT INTO game_rounds (game, guild_id, user_id, wager, payout, net, outcome, details, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.game,
        input.guildId,
        input.userId,
        input.wager,
        input.payout,
        net,
        input.outcome,
        input.details != null ? JSON.stringify(input.details) : null,
        input.startedAt,
        Date.now(),
      );
    return Number(res.lastInsertRowid);
  }

  /** A player's position on the balance leaderboard, and the number of ranked players. */
  balanceRank(guildId: string, userId: string): { rank: number; total: number } {
    const total = (
      this.db.query("SELECT COUNT(*) AS c FROM users WHERE guild_id = ? AND balance > 0").get(guildId) as { c: number }
    ).c;
    const me = this.db
      .query("SELECT balance FROM users WHERE guild_id = ? AND user_id = ?")
      .get(guildId, userId) as { balance: number } | null;
    if (!me || me.balance <= 0) return { rank: 0, total };
    const ahead = (
      this.db
        .query("SELECT COUNT(*) AS c FROM users WHERE guild_id = ? AND balance > ?")
        .get(guildId, me.balance) as { c: number }
    ).c;
    return { rank: ahead + 1, total };
  }

  topBalances(guildId: string, limit: number): TopBalanceRow[] {
    return this.db
      .query(
        `SELECT u.user_id, u.balance,
                COALESCE((SELECT SUM(g.net) FROM game_rounds g
                          WHERE g.guild_id = u.guild_id AND g.user_id = u.user_id), 0) AS net
         FROM users u
         WHERE u.guild_id = ? AND u.balance > 0
         ORDER BY u.balance DESC, u.user_id ASC LIMIT ?`,
      )
      .all(guildId, limit) as TopBalanceRow[];
  }

  /** Biggest single-round wins (net > 0) or losses (net < 0). */
  topRounds(guildId: string, kind: "wins" | "losses", limit: number): TopRoundRow[] {
    const where = kind === "wins" ? "net > 0" : "net < 0";
    const order = kind === "wins" ? "net DESC" : "net ASC";
    return this.db
      .query(
        `SELECT user_id, game, wager, payout, net, outcome, ended_at FROM game_rounds
         WHERE guild_id = ? AND ${where} ORDER BY ${order} LIMIT ?`,
      )
      .all(guildId, limit) as TopRoundRow[];
  }

  /** A player's most recently finished rounds, newest first. */
  recentRounds(guildId: string, userId: string, limit: number): TopRoundRow[] {
    return this.db
      .query(
        `SELECT user_id, game, wager, payout, net, outcome, ended_at, details FROM game_rounds
         WHERE guild_id = ? AND user_id = ? ORDER BY ended_at DESC LIMIT ?`,
      )
      .all(guildId, userId, limit) as TopRoundRow[];
  }

  serverStats(guildId: string): ServerStats {
    const g = this.db
      .query(
        `SELECT COALESCE(SUM(wager), 0) AS turnover,
                COALESCE(SUM(wager - payout), 0) AS housePnL,
                COUNT(*) AS roundsPlayed
         FROM game_rounds WHERE guild_id = ?`,
      )
      .get(guildId) as { turnover: number; housePnL: number; roundsPlayed: number };

    const minted = this.db
      .query(
        `SELECT COALESCE(SUM(CASE WHEN type = 'earn_voice' THEN delta ELSE 0 END), 0) AS activity,
                COALESCE(SUM(CASE WHEN type = 'welcome'    THEN delta ELSE 0 END), 0) AS welcome
         FROM ledger WHERE guild_id = ?`,
      )
      .get(guildId) as { activity: number; welcome: number };

    const circ = this.db
      .query(
        "SELECT COALESCE(SUM(balance), 0) AS inCirculation, COUNT(*) AS players FROM users WHERE guild_id = ?",
      )
      .get(guildId) as { inCirculation: number; players: number };

    return {
      turnover: g.turnover,
      mintedFromActivity: minted.activity,
      mintedWelcome: minted.welcome,
      housePnL: g.housePnL,
      roundsPlayed: g.roundsPlayed,
      inCirculation: circ.inCirculation,
      players: circ.players,
    };
  }

  userStats(guildId: string, userId: string): UserStats {
    const balanceRow = this.db
      .query("SELECT balance FROM users WHERE guild_id = ? AND user_id = ?")
      .get(guildId, userId) as { balance: number } | null;

    const r = this.db
      .query(
        // biggestWin/biggestLoss only consider actually-winning / actually-losing rounds
        // (net > 0 / net < 0). Otherwise a player's single round would show in both fields.
        // No wins -> 0, no losses -> 0 (aggregates skip the NULLs from the CASE).
        `SELECT COALESCE(SUM(wager), 0) AS totalWagered,
                COALESCE(SUM(net), 0)   AS net,
                COALESCE(MAX(CASE WHEN net > 0 THEN net END), 0) AS biggestWin,
                COALESCE(MIN(CASE WHEN net < 0 THEN net END), 0) AS biggestLoss,
                COUNT(*)                AS gamesPlayed
         FROM game_rounds WHERE guild_id = ? AND user_id = ?`,
      )
      .get(guildId, userId) as Omit<UserStats, "balance" | "fromActivity">;

    const activity = (
      this.db
        .query(
          "SELECT COALESCE(SUM(delta), 0) AS v FROM ledger WHERE guild_id = ? AND user_id = ? AND type = 'earn_voice'",
        )
        .get(guildId, userId) as { v: number }
    ).v;

    return { balance: balanceRow?.balance ?? 0, fromActivity: activity, ...r };
  }
}

/**
 * Schema migrations, embedded as strings so they ship inside the compiled binary
 * (no schema.sql to read from disk at runtime). Each entry's `version` must be a
 * contiguous, increasing integer; the runner applies every migration whose version
 * is greater than the DB's current `PRAGMA user_version`, inside one transaction.
 *
 * Money is stored as INTEGER chips. `users.balance` carries a CHECK (>= 0) so a bug
 * can never drive a wallet negative, and `ledger` is an append-only audit trail that
 * makes every balance change reconstructable and reversible.
 */
export const migrations: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: /* sql */ `
      CREATE TABLE users (
        guild_id   TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        balance    INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );

      -- Append-only audit log. The source of truth for every chip movement.
      CREATE TABLE ledger (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            INTEGER NOT NULL,
        guild_id      TEXT    NOT NULL,
        user_id       TEXT    NOT NULL,
        delta         INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        type          TEXT    NOT NULL,   -- welcome|earn_voice|bet|payout|transfer|admin_adjust|rollback
        game          TEXT,               -- blackjack|roulette|holdem|coinflip|... or NULL
        ref           TEXT,               -- round id / transfer id / correlation key
        meta          TEXT                -- JSON blob
      );
      CREATE INDEX idx_ledger_guild_user ON ledger (guild_id, user_id);
      CREATE INDEX idx_ledger_ts         ON ledger (ts);
      CREATE INDEX idx_ledger_type       ON ledger (type);
      CREATE INDEX idx_ledger_ref        ON ledger (ref);

      -- One row per finished game round, for stats (turnover, biggest win/loss...).
      CREATE TABLE game_rounds (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        game       TEXT    NOT NULL,
        guild_id   TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        wager      INTEGER NOT NULL,
        payout     INTEGER NOT NULL,
        net        INTEGER NOT NULL,   -- payout - wager
        outcome    TEXT    NOT NULL,   -- win|loss|push|blackjack|...
        details    TEXT,               -- JSON blob
        started_at INTEGER NOT NULL,
        ended_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_rounds_guild ON game_rounds (guild_id);
      CREATE INDEX idx_rounds_user  ON game_rounds (guild_id, user_id);
      CREATE INDEX idx_rounds_net   ON game_rounds (net);
      CREATE INDEX idx_rounds_game  ON game_rounds (game);
    `,
  },
  {
    version: 2,
    sql: /* sql */ `
      -- Tracks chips currently escrowed in an in-flight game (per ref, per player).
      -- A row exists only while a game is unsettled; on startup any leftover rows are
      -- refunded, so a restart (e.g. for an update) or crash never strands a bet.
      CREATE TABLE active_games (
        ref        TEXT    NOT NULL,
        user_id    TEXT    NOT NULL,
        guild_id   TEXT    NOT NULL,
        game       TEXT    NOT NULL,
        escrow     INTEGER NOT NULL DEFAULT 0,
        channel_id TEXT,
        message_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (ref, user_id)
      );
    `,
  },
  {
    version: 3,
    sql: /* sql */ `
      -- A persistent roulette table installed by an admin on a channel. It survives
      -- restarts: on startup the bot re-attaches to message_id and resumes spinning.
      CREATE TABLE roulette_tables (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    sql: /* sql */ `
      -- A persistent crash table installed by an admin on a channel. Like roulette, it
      -- survives restarts: on startup the bot re-attaches to message_id and resumes its
      -- round loop. In-flight bets at restart are refunded by refundOpenGames().
      CREATE TABLE crash_tables (
        channel_id TEXT PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `,
  },
];

import { z } from "zod";

/**
 * Central, typed configuration. Discord credentials and a few runtime knobs come
 * from the environment (validated with zod); everything game/economy related has a
 * sensible default here so the whole economy can be re-tuned in one place.
 *
 * All monetary amounts are whole "chips" (integers). No floats anywhere in money.
 */

const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

/** An optional env var parsed as a non-negative integer, falling back to `def` when unset/blank. */
const envInt = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v.trim());
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be an integer >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

/** An optional env var parsed as a boolean flag (true/false/1/0/yes/no/on/off), falling back to `def`. */
const envBool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be true/false" });
      return z.NEVER;
    });

const envSchema = z.object({
  // Optional at parse time so maintenance subcommands (backup/restore) work without
  // credentials; assertBotConfig() enforces them before the bot actually logs in.
  DISCORD_TOKEN: z.string().optional().default(""),
  CLIENT_ID: z.string().optional().default(""),
  GUILD_ID: z.string().optional().default(""),
  OWNER_IDS: z.string().optional().default(""),
  DATA_DIR: z.string().optional(),
  LOG_FORMAT: z.enum(["pretty", "json"]).optional().default("pretty"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional()
    .default("info"),

  // --- Economy: earning (all have sensible defaults; override via env to re-tune) ---
  WELCOME_BONUS: envInt(1_000),
  VOICE_AMOUNT_PER_TICK: envInt(5),
  VOICE_TICK_SECONDS: envInt(60, 1),
  // Anti-farm requirements are OFF by default (permissive): 1 human = "just be in a
  // channel", and self-muted/deafened members still earn. Tighten them via env if wanted.
  VOICE_MIN_HUMANS: envInt(1, 1),
  VOICE_PAY_WHILE_MUTED: envBool(true),
  VOICE_PAY_WHILE_DEAFENED: envBool(true),
  // The server's Inactive/AFK channel is excluded automatically (via the API); this
  // is for any *extra* channels you want to treat as no-earn (comma-separated IDs).
  VOICE_EXCLUDED_CHANNELS: z.string().optional().default(""),
});

const env = envSchema.parse(process.env);

export const config = {
  discord: {
    token: env.DISCORD_TOKEN,
    clientId: env.CLIENT_ID,
    /** When set, commands register to this guild (instant). Empty => global. */
    guildId: env.GUILD_ID || undefined,
    ownerIds: csv(env.OWNER_IDS),
  },

  /** Where bot.db + backups/ live. systemd points this at /var/lib/discord-all-in. */
  dataDir: env.DATA_DIR ?? `${process.cwd()}/data`,

  log: { format: env.LOG_FORMAT, level: env.LOG_LEVEL },

  currency: {
    name: "chips",
    /** Shown after amounts, e.g. "1,234 🪙". */
    emoji: "🪙",
  },

  economy: {
    /** One-time grant the first time a user interacts with the bot. */
    welcomeBonus: env.WELCOME_BONUS,
    voice: {
      /** Chips granted per credited tick. */
      amountPerTick: env.VOICE_AMOUNT_PER_TICK,
      /** How often the earning loop runs (and the granularity of accrual). */
      tickSeconds: env.VOICE_TICK_SECONDS,
      /** Require at least this many non-bot humans in the channel (anti solo-farm; 1 = off). */
      minHumansInChannel: env.VOICE_MIN_HUMANS,
      /** Whether self-muted / self-deafened members still earn (true = no such requirement). */
      payWhileSelfMuted: env.VOICE_PAY_WHILE_MUTED,
      payWhileSelfDeafened: env.VOICE_PAY_WHILE_DEAFENED,
      /** Extra no-earn channels beyond the server's Inactive/AFK channel (always excluded). */
      excludedChannelIds: csv(env.VOICE_EXCLUDED_CHANNELS),
    },
  },

  games: {
    blackjack: {
      minBet: 10,
      maxBet: 10_000,
      maxHands: 3,
      dealerHitsSoft17: true,
      /** 3:2 payout for a natural blackjack. */
      blackjackPayoutNum: 3,
      blackjackPayoutDen: 2,
      allowSurrender: false,
    },
    /**
     * Roulette is a single, always-on European table that an admin installs on a
     * channel. It spins on a fixed cadence; players bet during each round.
     */
    roulette: {
      type: "european" as const,
      minBet: 10,
      maxBet: 5_000,
      /** Cap on the sum of one player's bets in a single round. */
      maxTotalBetPerRound: 20_000,
      /** Seconds between automatic spins. */
      spinIntervalSeconds: 30,
      /** Repost the table to the bottom of the channel this many seconds before a spin
       *  (only when there are bets that round) so it doesn't get lost in chat. */
      repostLeadSeconds: 15,
      /** How many past results to keep in the table's history strip. */
      historyLength: 12,
    },
    casinoHoldem: {
      minAnte: 10,
      maxAnte: 5_000,
    },
    coinflip: {
      minBet: 10,
      maxBet: 50_000,
      challengeTimeoutSeconds: 120,
    },
    /**
     * Crash is a persistent, always-on table an admin installs on a channel (like
     * roulette). Each round: a betting window, then a multiplier that climbs from 1.00x
     * and busts at a random point; players race to cash out before it crashes.
     */
    crash: {
      minBet: 10,
      maxBet: 10_000,
      /** Length of the betting window before each flight. */
      bettingSeconds: 12,
      /** Bump the panel to the bottom of the channel this many seconds before a flight
       *  (only when nobody has bet yet and it's been buried) so it doesn't get lost in chat. */
      repostLeadSeconds: 6,
      /** Pause showing the result after a crash before the next betting window opens. */
      cooldownSeconds: 6,
      /**
       * Animation frame interval. ~1s is the floor for live-editing a single Discord
       * message: editing faster just makes discord.js queue the edits and the shown
       * multiplier lags real time. The displayed value is computed from real elapsed
       * time, so it stays exact even at 1 fps.
       */
      refreshMs: 1_000,
      /** Pacing knob: the multiplier doubles every this many seconds (k = ln2 / this). */
      doubleEverySeconds: 6,
      /** House edge — EV of any cash-out target is (1 - houseEdge). */
      houseEdge: 0.01,
      /** Crash multiplier cap; also bounds the longest possible flight (~34s at 50x). */
      maxMultiplier: 50,
    },
  },

  /** How long an interactive game session waits for the player before expiring. */
  sessionTimeoutSeconds: 180,
} as const;

export type Config = typeof config;

/** Throw a clear error if the Discord credentials needed to run the bot are missing. */
export function assertBotConfig(): void {
  const missing: string[] = [];
  if (!config.discord.token) missing.push("DISCORD_TOKEN");
  if (!config.discord.clientId) missing.push("CLIENT_ID");
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

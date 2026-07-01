import type { Command } from "../framework/types.ts";
import { leaderboard } from "./leaderboard.ts";
import { topWins, topLosses } from "./top.ts";
import { recent } from "./recent.ts";
import { stats, serverstats } from "./stats.ts";
import { blackjackCommand } from "../games/blackjack.ts";
import { pokerCommand } from "../games/poker.ts";
import { baccaratCommand } from "../games/baccarat.ts";
import { coinflipCommand } from "../games/coinflip.ts";
import { diceDuelCommand } from "../games/diceduel.ts";
import { admin } from "./admin.ts";

/**
 * Every slash command, registered statically (no filesystem scanning) so the list
 * survives `bun build --compile` into a single binary.
 */
export const commands: Command[] = [
  leaderboard,
  topWins,
  topLosses,
  recent,
  stats,
  serverstats,
  blackjackCommand,
  pokerCommand,
  baccaratCommand,
  coinflipCommand,
  diceDuelCommand,
  admin,
];

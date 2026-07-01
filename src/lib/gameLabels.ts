/** Human-friendly display names for the `game` keys stored in game_rounds. */
export const GAME_LABELS: Record<string, string> = {
  blackjack: "Blackjack",
  blackjack_table: "Blackjack (Table)",
  roulette: "Roulette",
  holdem: "Casino Hold'em",
  coinflip: "Coinflip",
  crash: "Crash",
  craps: "Craps",
  diceduel: "Dice Duel",
  baccarat: "Baccarat",
};

export function gameLabel(game: string): string {
  return GAME_LABELS[game] ?? game;
}

/** Human-friendly display names for the `game` keys stored in game_rounds. */
export const GAME_LABELS: Record<string, string> = {
  blackjack: "Blackjack",
  roulette: "Roulette",
  holdem: "Casino Hold'em",
  coinflip: "Coinflip",
};

export function gameLabel(game: string): string {
  return GAME_LABELS[game] ?? game;
}

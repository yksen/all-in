import { formatChips, formatSigned } from "../lib/money.ts";

export interface BettorResult {
  userId: string;
  net: number;
  balance: number;
}

/** "@user +500 🪙 → balance: 12,340 🪙" for every bettor in a round (win or lose, net high→low). */
export function resultsField(results: BettorResult[]): string {
  if (results.length === 0) return "No bets this round.";
  return results
    .map((r) => `<@${r.userId}> ${formatSigned(r.net)} → balance: **${formatChips(r.balance)}**`)
    .join("\n")
    .slice(0, 1024);
}

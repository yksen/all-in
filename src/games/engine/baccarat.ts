import type { Card } from "./deck.ts";

export type Side = "player" | "banker" | "tie";
export type Winner = "player" | "banker" | "tie";

/** Baccarat pip value: Ace = 1, 2–9 face value, 10/J/Q/K = 0. */
export function baccaratValue(card: Card): number {
  return card.rank >= 10 ? 0 : card.rank;
}

/** Baccarat hand total: sum of pip values mod 10 (always 0–9). */
export function total(cards: Card[]): number {
  return cards.reduce((sum, c) => sum + baccaratValue(c), 0) % 10;
}

/**
 * Deal a full baccarat coup, applying the natural rule and the standard third-card
 * tableau, and return the final hands. `draw` yields the next card — a thunk rather
 * than a Shoe so tests can script an exact deck (the game passes `() => shoe.draw()`).
 */
export function playHand(draw: () => Card): { player: Card[]; banker: Card[] } {
  const player = [draw(), draw()];
  const banker = [draw(), draw()];
  const pt = total(player);
  const bt = total(banker);

  // Natural: either two-card total of 8 or 9 ends the coup immediately.
  if (pt >= 8 || bt >= 8) return { player, banker };

  // Player rule: draws on 0–5, stands on 6–7.
  let p3: number | undefined;
  if (pt <= 5) {
    const card = draw();
    player.push(card);
    p3 = baccaratValue(card);
  }

  // Banker rule — depends on the banker total and (if drawn) the player's third card.
  const bankerDraws =
    p3 === undefined
      ? bt <= 5 // player stood → banker draws on 0–5, stands on 6–7
      : bt <= 2 ||
        (bt === 3 && p3 !== 8) ||
        (bt === 4 && p3 >= 2 && p3 <= 7) ||
        (bt === 5 && p3 >= 4 && p3 <= 7) ||
        (bt === 6 && p3 >= 6 && p3 <= 7); // bt === 7 stands
  if (bankerDraws) banker.push(draw());

  return { player, banker };
}

export function decideWinner(player: Card[], banker: Card[]): Winner {
  const p = total(player);
  const b = total(banker);
  return p > b ? "player" : b > p ? "banker" : "tie";
}

export interface BaccaratPayoutConfig {
  bankerCommissionPct: number;
  tiePayout: number;
}

/**
 * Chips returned to the player (0 = lost), plus the outcome label for stats.
 * `ret` includes the stake (blackjack convention): net profit is `ret - bet`.
 */
export function settle(
  bet: number,
  betOn: Side,
  win: Winner,
  cfg: BaccaratPayoutConfig,
): { ret: number; outcome: "win" | "loss" | "push" } {
  if (betOn === win) {
    if (betOn === "player") return { ret: bet * 2, outcome: "win" }; // 1:1
    if (betOn === "banker") {
      const profit = Math.floor((bet * (100 - cfg.bankerCommissionPct)) / 100); // 0.95:1 at 5%
      return { ret: bet + profit, outcome: "win" };
    }
    return { ret: bet * (cfg.tiePayout + 1), outcome: "win" }; // tie, e.g. 8:1 → returns 9×
  }
  // A tie pushes the Player/Banker bets (stake returned).
  if (win === "tie" && betOn !== "tie") return { ret: bet, outcome: "push" };
  return { ret: 0, outcome: "loss" };
}

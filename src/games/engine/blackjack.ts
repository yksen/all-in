import { type Card, cardValue } from "./deck.ts";
import { handTotal, isBlackjack, isBust } from "./handvalue.ts";
import { config } from "../../config.ts";

const BJ = config.games.blackjack;

/** A hand can never grow past this many splits (3 splits = 4 hands). */
export const MAX_TOTAL_HANDS = 4;

export type Outcome = "win" | "loss" | "push" | "blackjack" | "surrender";

export interface Hand {
  cards: Card[];
  bet: number;
  done: boolean;
  doubled: boolean;
  surrendered: boolean;
  fromSplit: boolean;
}

export const OUTCOME_LABEL: Record<Outcome, string> = {
  win: "✅ Win",
  loss: "❌ Loss",
  push: "➖ Push",
  blackjack: "🃏 Blackjack!",
  surrender: "🏳️ Surrender",
};

export function makeHand(bet: number, cards: Card[], fromSplit = false): Hand {
  return { cards, bet, done: false, doubled: false, surrendered: false, fromSplit };
}

/** Index of the first hand still being played, or -1 if every hand is done. */
export function firstUnfinished(hands: Hand[]): number {
  return hands.findIndex((h) => !h.done);
}

export function dealerShouldHit(cards: Card[]): boolean {
  const { total, soft } = handTotal(cards);
  if (total < 17) return true;
  return total === 17 && soft && BJ.dealerHitsSoft17;
}

/** Chips returned to the player for one hand (stake + winnings), and the outcome. */
export function settleHand(hand: Hand, dealer: Card[]): { ret: number; outcome: Outcome } {
  if (hand.surrendered) return { ret: Math.floor(hand.bet / 2), outcome: "surrender" };
  if (isBust(hand.cards)) return { ret: 0, outcome: "loss" };

  const dealerNatural = isBlackjack(dealer);
  const playerNatural = isBlackjack(hand.cards) && !hand.fromSplit;

  if (playerNatural) {
    if (dealerNatural) return { ret: hand.bet, outcome: "push" };
    const profit = Math.floor((hand.bet * BJ.blackjackPayoutNum) / BJ.blackjackPayoutDen);
    return { ret: hand.bet + profit, outcome: "blackjack" };
  }
  if (dealerNatural) return { ret: 0, outcome: "loss" };

  const dealerTotal = handTotal(dealer).total;
  const playerTotal = handTotal(hand.cards).total;
  if (dealerTotal > 21 || playerTotal > dealerTotal) return { ret: hand.bet * 2, outcome: "win" };
  if (playerTotal === dealerTotal) return { ret: hand.bet, outcome: "push" };
  return { ret: 0, outcome: "loss" };
}

/** True if a two-card hand is eligible to split (matching values, room for another hand, funds). */
export function canSplit(hand: Hand, totalHands: number): boolean {
  return (
    hand.cards.length === 2 && cardValue(hand.cards[0]!) === cardValue(hand.cards[1]!) && totalHands < MAX_TOTAL_HANDS
  );
}

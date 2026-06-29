import { type Card, cardValue } from "./deck.ts";

export interface HandValue {
  /** Best total <= 21 if possible. */
  total: number;
  /** True if an Ace is still counted as 11 (a "soft" hand). */
  soft: boolean;
}

/** Blackjack hand total, demoting Aces from 11 to 1 as needed to avoid busting. */
export function handTotal(cards: Card[]): HandValue {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += cardValue(card);
    if (card.rank === 1) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0 };
}

export function isBust(cards: Card[]): boolean {
  return handTotal(cards).total > 21;
}

/** A two-card 21 (natural). */
export function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && handTotal(cards).total === 21;
}

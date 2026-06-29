import { shuffle } from "./rng.ts";

export type Suit = "S" | "H" | "D" | "C";

/** rank 1..13 where 1=Ace, 11=Jack, 12=Queen, 13=King. */
export interface Card {
  rank: number;
  suit: Suit;
}

export const SUITS: readonly Suit[] = ["S", "H", "D", "C"];

export function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (let rank = 1; rank <= 13; rank++) deck.push({ rank, suit });
  }
  return deck;
}

/** A shuffled shoe of one or more decks that you draw sequentially from. */
export class Shoe {
  private cards: Card[];

  constructor(numDecks = 1) {
    this.cards = [];
    for (let i = 0; i < numDecks; i++) this.cards.push(...freshDeck());
    shuffle(this.cards);
  }

  get remaining(): number {
    return this.cards.length;
  }

  draw(): Card {
    const card = this.cards.pop();
    if (!card) throw new Error("shoe is empty");
    return card;
  }

  drawMany(n: number): Card[] {
    return Array.from({ length: n }, () => this.draw());
  }
}

/** Blackjack-style value of a single card: face cards = 10, Ace = 11 (soft). */
export function cardValue(card: Card): number {
  if (card.rank === 1) return 11;
  if (card.rank >= 11) return 10;
  return card.rank;
}

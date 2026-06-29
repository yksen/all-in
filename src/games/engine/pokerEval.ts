import type { Card } from "./deck.ts";

/**
 * Poker hand evaluation by brute force over all 5-card combinations (used by Casino
 * Hold'em, where each player makes the best 5 of 7 cards). A hand is reduced to a
 * `score` array compared lexicographically: first element is the category, the rest
 * are tiebreakers (all higher = better).
 */

export interface HandRank {
  score: number[];
  name: string;
}

// Category indices (higher beats lower).
const CATEGORY_NAME = [
  "High card",
  "Pair",
  "Two pair",
  "Three of a kind",
  "Straight",
  "Flush",
  "Full house",
  "Four of a kind",
  "Straight flush",
  "Royal flush",
] as const;

/** Ace counts as 14 (and as 1 only for the A-2-3-4-5 wheel). */
function cardValueHigh(card: Card): number {
  return card.rank === 1 ? 14 : card.rank;
}

function detectStraightHigh(uniqueDesc: number[]): number {
  // uniqueDesc is distinct values sorted descending. Standard 5-in-a-row:
  for (let i = 0; i <= uniqueDesc.length - 5; i++) {
    const window = uniqueDesc.slice(i, i + 5);
    if (window[0]! - window[4]! === 4) return window[0]!;
  }
  // Wheel: A,5,4,3,2.
  if ([14, 5, 4, 3, 2].every((v) => uniqueDesc.includes(v))) return 5;
  return 0;
}

function rank5(cards: Card[]): HandRank {
  const values = cards.map(cardValueHigh).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Sort distinct values by (count desc, value desc).
  const grouped = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniqueDesc = [...counts.keys()].sort((a, b) => b - a);
  const straightHigh = uniqueDesc.length >= 5 ? detectStraightHigh(uniqueDesc) : 0;

  let category: number;
  let tiebreak: number[];

  const countsPattern = grouped.map((g) => g[1]).join("");
  const byCount = grouped.map((g) => g[0]);

  if (straightHigh && isFlush) {
    category = straightHigh === 14 ? 9 : 8; // royal vs straight flush
    tiebreak = [straightHigh];
  } else if (countsPattern.startsWith("4")) {
    category = 7;
    tiebreak = byCount; // [quad, kicker]
  } else if (countsPattern === "32") {
    category = 6;
    tiebreak = byCount; // [trips, pair]
  } else if (isFlush) {
    category = 5;
    tiebreak = values;
  } else if (straightHigh) {
    category = 4;
    tiebreak = [straightHigh];
  } else if (countsPattern.startsWith("3")) {
    category = 3;
    tiebreak = byCount; // [trips, k1, k2]
  } else if (countsPattern.startsWith("22")) {
    category = 2;
    tiebreak = byCount; // [highPair, lowPair, kicker]
  } else if (countsPattern.startsWith("2")) {
    category = 1;
    tiebreak = byCount; // [pair, k1, k2, k3]
  } else {
    category = 0;
    tiebreak = values;
  }

  return { score: [category, ...tiebreak], name: CATEGORY_NAME[category]! };
}

function combinations5(cards: Card[]): Card[][] {
  const out: Card[][] = [];
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) out.push([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
  return out;
}

export function compareRanks(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Best 5-card hand out of 5..7 cards. */
export function bestOf(cards: Card[]): HandRank {
  if (cards.length === 5) return rank5(cards);
  let best: HandRank | null = null;
  for (const combo of combinations5(cards)) {
    const r = rank5(combo);
    if (!best || compareRanks(r.score, best.score) > 0) best = r;
  }
  return best!;
}

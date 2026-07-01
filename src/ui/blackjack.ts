import type { Card } from "../games/engine/deck.ts";
import { handTotal } from "../games/engine/handvalue.ts";
import type { Hand } from "../games/engine/blackjack.ts";
import { formatChips } from "../lib/money.ts";
import { renderHand } from "./cards.ts";

export function totalString(cards: Card[]): string {
  const { total, soft } = handTotal(cards);
  return soft && total <= 21 ? `${total - 10}/${total}` : String(total);
}

/** The `🤵 Dealer` embed field — hole card hidden unless `reveal`. */
export function dealerField(cards: Card[], reveal: boolean): { name: string; value: string } {
  const value = reveal
    ? `**Total: ${handTotal(cards).total}**`
    : `**Showing: ${handTotal([cards[0]!]).total}+**`;
  return { name: "🤵 Dealer", value: `${renderHand(cards, { hideFrom: reveal ? undefined : 1 })}\n${value}` };
}

/** One hand's embed field. `label` is the caller-supplied title, e.g. "Hand 1" or "Seat 2 • Hand 1". */
export function handField(hand: Hand, label: string, active: boolean, reveal: boolean): { name: string; value: string } {
  const tags: string[] = [];
  if (hand.doubled) tags.push("doubled");
  if (hand.fromSplit) tags.push("split");
  const tagStr = tags.length ? ` (${tags.join(", ")})` : "";
  const marker = active && !reveal ? "▶ " : "";
  return {
    name: `${marker}${label} — bet ${formatChips(hand.bet)}${tagStr}`,
    value: `${renderHand(hand.cards)}\n**Total: ${totalString(hand.cards)}**`,
  };
}

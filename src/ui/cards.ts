import type { Card, Suit } from "../games/engine/deck.ts";

/**
 * Cards are drawn as large ASCII boxes inside a Discord `ansi` code block, which lets
 * us color them: red suits (♥♦) in red, black suits (♠♣) in bright white (true black
 * would be invisible on Discord's dark background). On the rare client without ANSI
 * support this degrades to plain monospace — still perfectly readable.
 */

const SUIT_CHAR: Record<Suit, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };
const RED_SUITS = new Set<Suit>(["H", "D"]);

const ESC = String.fromCharCode(27); // ANSI escape; avoids embedding a raw control byte
const RED = `${ESC}[1;31m`;
const WHITE = `${ESC}[1;37m`;
const GRAY = `${ESC}[1;30m`;
const RESET = `${ESC}[0m`;

function rankLabel(rank: number): string {
  switch (rank) {
    case 1:
      return "A";
    case 11:
      return "J";
    case 12:
      return "Q";
    case 13:
      return "K";
    default:
      return String(rank);
  }
}

function center(s: string, width: number): string {
  const pad = width - s.length;
  const left = Math.floor(pad / 2);
  return " ".repeat(left) + s + " ".repeat(pad - left);
}

function cardLines(card: Card): string[] {
  const rs = `${rankLabel(card.rank)}${SUIT_CHAR[card.suit]}`; // e.g. "A♠", "10♥"
  const s = SUIT_CHAR[card.suit];
  const color = RED_SUITS.has(card.suit) ? RED : WHITE;
  // Rank+suit in the top-left and bottom-right corners, big suit in the middle.
  const rows = ["┌─────┐", `│${rs.padEnd(5)}│`, `│${center(s, 5)}│`, `│${rs.padStart(5)}│`, "└─────┘"];
  return rows.map((line) => `${color}${line}${RESET}`);
}

function hiddenLines(): string[] {
  const body = "│▚▚▚▚▚│";
  return ["┌─────┐", body, body, body, "└─────┘"].map((line) => `${GRAY}${line}${RESET}`);
}

/**
 * Render a hand as a colored ANSI code block of side-by-side cards.
 * `hideFrom` hides cards at that index and beyond (the dealer's hole card).
 */
export function renderHand(cards: Card[], opts: { hideFrom?: number } = {}): string {
  const hideFrom = opts.hideFrom ?? Number.POSITIVE_INFINITY;
  const columns = cards.map((card, i) => (i >= hideFrom ? hiddenLines() : cardLines(card)));
  const lines: string[] = [];
  for (let row = 0; row < 5; row++) lines.push(columns.map((col) => col[row]).join(""));
  return "```ansi\n" + lines.join("\n") + "\n```";
}

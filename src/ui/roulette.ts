import { colorOf } from "../games/engine/roulette.ts";

/**
 * Roulette table rendered as a colored ANSI block: the full European number layout
 * (3 rows of 12 + zero), each number tinted by its real color, with the last result
 * shown in inverse video. Plus a plain history strip using emoji.
 *
 * Mobile Discord drops ANSI colour in code blocks, so colour alone can't tell red from
 * black — every pocket also carries a width-1 SHAPE marker (red ●, black ○, green ◆) that
 * renders identically everywhere. Colour is then just a desktop bonus.
 */

const ESC = String.fromCharCode(27);
const COLOR = { red: `${ESC}[1;31m`, black: `${ESC}[1;37m`, green: `${ESC}[1;32m` } as const;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const EMOJI = { red: "🔴", black: "⚫", green: "🟢" } as const;
/** Colour-blind / mobile-safe shape per pocket colour (renders without ANSI colour). */
const SHAPE = { red: "●", black: "○", green: "◆" } as const;

function cell(n: number, last: number | null): string {
  const c = colorOf(n);
  const hi = n === last ? INVERSE : "";
  return `${hi}${COLOR[c]}${n.toString().padStart(2)}${SHAPE[c]}${RESET}`; // 3 visible chars: "12●", " 0◆"
}

/** The betting layout as a colored code block; `last` (if any) is highlighted. */
export function renderGrid(last: number | null): string {
  const rowOf = (start: number) => {
    const cells: string[] = [];
    for (let n = start; n <= 36; n += 3) cells.push(cell(n, last));
    return cells.join(" ");
  };
  // 4-space lead aligns rows 1 & 3 under the (now 3-wide) zero cell + its trailing space.
  const lines = [`    ${rowOf(3)}`, `${cell(0, last)} ${rowOf(2)}`, `    ${rowOf(1)}`];
  return "```ansi\n" + lines.join("\n") + "\n```";
}

/** A horizontal "reel" of numbers with the center one focused — used for the spin animation. */
export function renderReel(window: number[], centerIdx: number): string {
  // 5 visible chars per cell: " 12● " normally, "[12●]" for the focused pocket.
  const cells = window.map((n, i) => {
    const c = colorOf(n);
    const txt = `${n.toString().padStart(2)}${SHAPE[c]}`;
    return i === centerIdx ? `${INVERSE}${COLOR[c]}[${txt}]${RESET}` : `${COLOR[c]} ${txt} ${RESET}`;
  });
  const pointer = " ".repeat(centerIdx * 5 + 2) + "▼";
  return "```ansi\n" + pointer + "\n" + cells.join("") + "\n```";
}

export function resultLine(n: number): string {
  return `${EMOJI[colorOf(n)]} **${n}**`;
}

export function historyStrip(history: number[]): string {
  if (history.length === 0) return "_no spins yet_";
  return history.map((n) => `${EMOJI[colorOf(n)]}${n}`).join("  ");
}

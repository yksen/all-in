import { colorOf } from "../games/engine/roulette.ts";

/**
 * Roulette table rendered as a colored ANSI block: the full European number layout
 * (3 rows of 12 + zero), each number tinted by its real color, with the last result
 * shown in inverse video. Plus a plain history strip using emoji.
 */

const ESC = String.fromCharCode(27);
const COLOR = { red: `${ESC}[1;31m`, black: `${ESC}[1;37m`, green: `${ESC}[1;32m` } as const;
const INVERSE = `${ESC}[7m`;
const RESET = `${ESC}[0m`;
const EMOJI = { red: "🔴", black: "⚫", green: "🟢" } as const;

function cell(n: number, last: number | null): string {
  const color = COLOR[colorOf(n)];
  const hi = n === last ? INVERSE : "";
  return `${hi}${color}${n.toString().padStart(2)}${RESET}`;
}

/** The betting layout as a colored code block; `last` (if any) is highlighted. */
export function renderGrid(last: number | null): string {
  const rowOf = (start: number) => {
    const cells: string[] = [];
    for (let n = start; n <= 36; n += 3) cells.push(cell(n, last));
    return cells.join(" ");
  };
  const lines = [`   ${rowOf(3)}`, `${cell(0, last)} ${rowOf(2)}`, `   ${rowOf(1)}`];
  return "```ansi\n" + lines.join("\n") + "\n```";
}

/** A horizontal "reel" of numbers with the center one focused — used for the spin animation. */
export function renderReel(window: number[], centerIdx: number): string {
  const cells = window.map((n, i) => {
    const color = COLOR[colorOf(n)];
    const txt = n.toString().padStart(2);
    return i === centerIdx ? `${INVERSE}${color}[${txt}]${RESET}` : `${color} ${txt} ${RESET}`;
  });
  const pointer = " ".repeat(centerIdx * 4 + 1) + "▼";
  return "```ansi\n" + pointer + "\n" + cells.join("") + "\n```";
}

export function resultLine(n: number): string {
  return `${EMOJI[colorOf(n)]} **${n}**`;
}

export function historyStrip(history: number[]): string {
  if (history.length === 0) return "_no spins yet_";
  return history.map((n) => `${EMOJI[colorOf(n)]}${n}`).join("  ");
}

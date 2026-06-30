import { BrailleCanvas } from "./braille.ts";

/**
 * A spinning coin drawn as a filled braille ellipse. `squash` is the horizontal scale:
 * 1 = full face, 0 = edge-on sliver. Animating squash = |cos(phase)| over frames makes the
 * coin flip end-over-end. Braille + shape carry the motion, so it reads on mobile too (where
 * code-block ANSI colour is dropped); the gold colour is just a desktop bonus.
 */

const ESC = String.fromCharCode(27);
const GOLD = `${ESC}[1;33m`;
const RESET = `${ESC}[0m`;

export function renderCoin(squash: number): string {
  const c = new BrailleCanvas(14, 7); // 28×28 sub-pixels
  const cx = (c.width - 1) / 2;
  const cy = (c.height - 1) / 2;
  const ry = c.height / 2 - 1;
  const rx = (c.width / 2 - 1) * Math.max(0, Math.min(1, squash));
  c.ellipse(cx, cy, rx, ry, true);
  return "```ansi\n" + c.rows().map((r) => GOLD + r + RESET).join("\n") + "\n```";
}

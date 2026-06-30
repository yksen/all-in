/**
 * The crash multiplier rendered as a climbing curve on a braille sub-pixel canvas
 * (see `./braille.ts`). The y-axis rescales to the current multiplier each frame, so the
 * curve stays convex and its tip rides the top — the "accelerating rocket" look. ANSI heat
 * colour is a desktop bonus; the curve shape + the multiplier number carry the meaning, so
 * it still reads on mobile where code-block colour is dropped.
 */

import { BrailleCanvas } from "./braille.ts";

const ESC = String.fromCharCode(27);
const GREEN = `${ESC}[1;32m`;
const YELLOW = `${ESC}[1;33m`;
const RED = `${ESC}[1;31m`;
const GRAY = `${ESC}[1;30m`;
const RESET = `${ESC}[0m`;

const COLS = 22;
const ROWS = 8;
const PX = COLS * 2; // 44 sub-pixels wide
const PY = ROWS * 4; // 32 sub-pixels tall

/** Hotter as the multiplier climbs: green → yellow → red. */
function heat(mult: number): string {
  if (mult >= 10) return RED;
  if (mult >= 3) return YELLOW;
  return GREEN;
}

function block(lines: string[], color: string, baseline = true): string {
  const body = lines.map((r) => color + r + RESET);
  if (baseline) body.push(`${GRAY}${"─".repeat(COLS)}${RESET}`);
  return "```ansi\n" + body.join("\n") + "\n```";
}

/** The climbing curve, plus a shimmering exhaust trail behind the tip (varies with `frame`). */
export function renderCurve(multiplier: number, k: number, elapsedSec: number, frame = 0): string {
  const canvas = new BrailleCanvas();
  const span = Math.max(elapsedSec, 0.001);
  const denom = Math.max(multiplier - 1, 1e-6);

  let prevY = PY - 1;
  let tipY = PY - 1;
  for (let x = 0; x < PX; x++) {
    const t = (span * x) / (PX - 1);
    const m = Math.exp(k * t);
    const frac = Math.min(1, (m - 1) / denom); // 0 at the start, 1 at the current tip
    const y = Math.round((PY - 1) * (1 - frac));
    for (let yy = Math.min(y, prevY); yy <= Math.max(y, prevY); yy++) canvas.set(x, yy); // connect columns
    prevY = y;
    tipY = y;
  }

  // Exhaust: a few dots trailing down-left of the tip, jittering per frame so it flickers.
  for (let i = 1; i <= 5; i++) {
    canvas.set(PX - 1 - i * 2, tipY + i + ((frame + i) % 3));
  }

  return block(canvas.rows(), heat(multiplier));
}

/** A braille star-burst that expands and thins to dust over `frame` 0→2. Used at the crash. */
export function renderExplosion(frame: number): string {
  const canvas = new BrailleCanvas();
  const cx = PX / 2;
  const cy = PY / 2;
  const radius = 5 + frame * 8;
  const inner = frame * 6;
  const rays = 12;
  for (let a = 0; a < rays; a++) {
    const ang = (Math.PI * 2 * a) / rays;
    for (let r = inner; r <= radius; r++) {
      if (frame >= 2 && r % 2 === 0) continue; // thin to scattered dust on the last frame
      canvas.set(Math.round(cx + Math.cos(ang) * r), Math.round(cy + Math.sin(ang) * r));
    }
  }
  return block(canvas.rows(), RED, false);
}

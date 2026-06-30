import { expect, test } from "bun:test";
import { renderCurve, renderExplosion } from "./crash.ts";

test("renderCurve: fenced ansi block, tip reaches the top row, start sits on the bottom row", () => {
  const k = Math.LN2 / 6;
  const elapsed = 8;
  const mult = Math.exp(k * elapsed); // consistent: in production multiplier === exp(k·elapsed)
  const out = renderCurve(mult, k, elapsed, 0);
  expect(out.startsWith("```ansi")).toBe(true);
  expect(out.trimEnd().endsWith("```")).toBe(true);
  // [0]=fence, [1..8]=braille rows (top→bottom), [9]=baseline, [10]=closing fence.
  const rows = out.split("\n");
  expect(/[⠁-⣿]/.test(rows[1]!)).toBe(true); // tip rescales to the top row
  expect(/[⠁-⣿]/.test(rows[8]!)).toBe(true); // start sits on the bottom row
});

test("renderExplosion: each frame is a fenced ansi block with braille content", () => {
  for (const f of [0, 1, 2]) {
    const out = renderExplosion(f);
    expect(out.startsWith("```ansi")).toBe(true);
    expect(/[⠁-⣿]/.test(out)).toBe(true);
  }
});

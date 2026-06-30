import { expect, test } from "bun:test";
import { BrailleCanvas, renderCurve, renderExplosion } from "./crash.ts";

test("braille: single top-left dot is U+2801 (⠁)", () => {
  const c = new BrailleCanvas();
  c.set(0, 0);
  expect(c.rows()[0]![0]).toBe("⠁");
});

test("braille: all 8 dots of a cell is U+28FF (⣿)", () => {
  const c = new BrailleCanvas();
  for (let px = 0; px < 2; px++) for (let py = 0; py < 4; py++) c.set(px, py);
  expect(c.rows()[0]![0]).toBe("⣿");
});

test("braille: empty cell is the blank braille char U+2800", () => {
  const c = new BrailleCanvas();
  expect(c.rows()[0]![0]).toBe("⠀");
});

test("braille: out-of-bounds writes are ignored (no throw)", () => {
  const c = new BrailleCanvas();
  c.set(-1, 0);
  c.set(0, -1);
  c.set(9999, 9999);
  expect(c.rows()[0]![0]).toBe("⠀");
});

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

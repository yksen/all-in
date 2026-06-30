import { expect, test } from "bun:test";
import { BrailleCanvas } from "./braille.ts";

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

test("braille: custom size and dimensions", () => {
  const c = new BrailleCanvas(10, 6);
  expect(c.width).toBe(20);
  expect(c.height).toBe(24);
  expect(c.rows().length).toBe(6);
  expect(c.rows()[0]!.length).toBe(10);
});

test("braille: line draws a connected diagonal (no gaps per column)", () => {
  const c = new BrailleCanvas(8, 8);
  c.line(0, 0, c.width - 1, c.height - 1);
  // Every character row should carry at least one lit dot along the diagonal.
  for (const row of c.rows()) expect(/[⠁-⣿]/.test(row)).toBe(true);
});

test("braille: ellipse outline lights cells and a thin (edge-on) ellipse degrades to a line", () => {
  const c = new BrailleCanvas(12, 8);
  c.ellipse(c.width / 2, c.height / 2, 8, 10, true);
  expect(c.rows().some((r) => /[⠁-⣿]/.test(r))).toBe(true);

  const edge = new BrailleCanvas(12, 8);
  edge.ellipse(edge.width / 2, edge.height / 2, 0, 10); // rx<0.5 → vertical diameter
  const lit = edge.rows().filter((r) => /[⠁-⣿]/.test(r)).length;
  expect(lit).toBeGreaterThan(1); // a vertical sliver spans multiple rows
});

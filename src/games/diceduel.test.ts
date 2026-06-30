import { expect, test } from "bun:test";
import { duelRoll } from "./diceduel.ts";

test("duelRoll: never ties, dice in range, winner matches higher total", () => {
  for (let i = 0; i < 500; i++) {
    const { a, b, aSum, bSum, challengerWins } = duelRoll();
    expect(aSum).not.toBe(bSum);
    for (const d of [...a, ...b]) {
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(6);
    }
    expect(aSum).toBe(a[0] + a[1]);
    expect(bSum).toBe(b[0] + b[1]);
    expect(challengerWins).toBe(aSum > bSum);
  }
});

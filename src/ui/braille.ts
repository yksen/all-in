/**
 * A monochrome sub-pixel canvas that packs into Unicode braille characters
 * (U+2800–U+28FF): each char is a 2×4 dot grid, so a `cols`×`rows` block of chars is a
 * `2·cols`×`4·rows` pixel canvas. Discord gives us ~8 ANSI colours but the full glyph
 * range, so braille is how we buy spatial resolution (the drawille/plotille trick).
 * Shared by crash (curve/explosion) and coinflip (spinning coin).
 *
 * IMPORTANT: braille glyphs render identically on Discord desktop AND mobile, and don't
 * depend on ANSI colour (which mobile code blocks drop) — so meaning carried by dots
 * survives everywhere; colour is only ever a desktop bonus.
 */

/** Braille dot bit by sub-pixel (row 0..3, col 0..1) within a cell. */
const DOT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
] as const;

export class BrailleCanvas {
  readonly cols: number;
  readonly rowsCount: number;
  /** Sub-pixel dimensions. */
  readonly width: number;
  readonly height: number;
  private cells: Uint8Array;

  constructor(cols = 22, rowsCount = 8) {
    this.cols = cols;
    this.rowsCount = rowsCount;
    this.width = cols * 2;
    this.height = rowsCount * 4;
    this.cells = new Uint8Array(cols * rowsCount);
  }

  /** Light a single sub-pixel (rounded; out-of-bounds is a no-op). */
  set(px: number, py: number): void {
    const x = Math.round(px);
    const y = Math.round(py);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    this.cells[(y >> 2) * this.cols + (x >> 1)]! |= DOT[y & 3]![x & 1]!;
  }

  /** Bresenham line between two sub-pixels. */
  line(x0: number, y0: number, x1: number, y1: number): void {
    let ax = Math.round(x0);
    let ay = Math.round(y0);
    const bx = Math.round(x1);
    const by = Math.round(y1);
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(ax, ay);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        ax += sx;
      }
      if (e2 <= dx) {
        err += dx;
        ay += sy;
      }
    }
  }

  /** Ellipse outline (or filled) centred at (cx,cy) with radii rx,ry. */
  ellipse(cx: number, cy: number, rx: number, ry: number, fill = false): void {
    if (rx < 0.5) {
      // Degenerate (edge-on): draw the vertical diameter so a "spinning coin" still shows.
      this.line(cx, cy - ry, cx, cy + ry);
      return;
    }
    const steps = Math.max(16, Math.ceil((rx + ry) * 3));
    for (let i = 0; i < steps; i++) {
      const a = (Math.PI * 2 * i) / steps;
      this.set(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
    if (fill) {
      for (let y = Math.ceil(cy - ry); y <= Math.floor(cy + ry); y++) {
        const t = (y - cy) / ry;
        if (Math.abs(t) > 1) continue;
        const halfW = rx * Math.sqrt(1 - t * t);
        for (let x = Math.round(cx - halfW); x <= Math.round(cx + halfW); x++) this.set(x, y);
      }
    }
  }

  /** Pack to braille text — one string per character row. */
  rows(): string[] {
    const out: string[] = [];
    for (let cy = 0; cy < this.rowsCount; cy++) {
      let line = "";
      for (let cx = 0; cx < this.cols; cx++) line += String.fromCharCode(0x2800 + this.cells[cy * this.cols + cx]!);
      out.push(line);
    }
    return out;
  }
}

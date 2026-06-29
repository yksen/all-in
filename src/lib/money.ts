import { config } from "../config.ts";

const nf = new Intl.NumberFormat("en-US");

/** "1,234 🪙" */
export function formatChips(amount: number): string {
  return `${nf.format(amount)} ${config.currency.emoji}`;
}

/** "+1,234 🪙" / "-50 🪙" — for showing a delta/result. */
export function formatSigned(amount: number): string {
  const sign = amount > 0 ? "+" : "";
  return `${sign}${nf.format(amount)} ${config.currency.emoji}`;
}

/** Plain grouped number without the emoji. */
export function formatNumber(amount: number): string {
  return nf.format(amount);
}

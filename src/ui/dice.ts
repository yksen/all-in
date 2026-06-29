const DIE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"] as const;

/** Unicode die face for a value 1..6. */
export function renderDie(value: number): string {
  return DIE_FACES[value - 1] ?? `(${value})`;
}

export function renderDice(values: number[]): string {
  return values.map(renderDie).join(" ");
}

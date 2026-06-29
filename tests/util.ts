import { Database } from "bun:sqlite";
import { migrations } from "../src/db/migrations.ts";
import type { Card, Suit } from "../src/games/engine/deck.ts";

/** Fresh in-memory DB with the schema applied — for wallet/ledger tests. */
export function memDb(): Database {
  const db = new Database(":memory:");
  for (const m of migrations) db.exec(m.sql);
  return db;
}

/** Terse card constructor: c(1, "S") = Ace of spades. */
export function c(rank: number, suit: Suit): Card {
  return { rank, suit };
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations.ts";
import { logger } from "../lib/logger.ts";

/**
 * Opens (creating if needed) the SQLite database in WAL mode and applies any
 * pending migrations. WAL + NORMAL synchronous gives us fast, durable-enough
 * writes for a single-process bot; busy_timeout avoids spurious "database is
 * locked" errors if a backup VACUUM overlaps a write.
 */
export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");

  runMigrations(db);
  return db;
}

function runMigrations(db: Database): void {
  const current = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug({ version: current }, "db: schema up to date");
    return;
  }

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      // user_version doesn't accept bound params; the value is a trusted integer.
      db.exec(`PRAGMA user_version = ${migration.version};`);
    });
    apply();
    logger.info({ version: migration.version }, "db: applied migration");
  }
}

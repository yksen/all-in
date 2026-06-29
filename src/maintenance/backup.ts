import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { logger } from "../lib/logger.ts";

/** How many rolling snapshots to keep (the systemd timer runs hourly => ~2 days). */
const RETENTION = 48;

function dbPath(): string {
  return join(config.dataDir, "bot.db");
}

/**
 * Take a consistent snapshot of the live database using SQLite's `VACUUM INTO`,
 * which works safely while the bot is running (WAL mode). Old snapshots beyond the
 * retention count are pruned. Returns the snapshot path.
 */
export function runBackup(): string {
  const source = dbPath();
  if (!existsSync(source)) throw new Error(`No database to back up at ${source}`);

  const backupsDir = join(config.dataDir, "backups");
  mkdirSync(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupsDir, `bot-${stamp}.db`);

  // Default open (read/write); existence is already guaranteed above. VACUUM INTO
  // writes a consistent copy to `dest` and is safe to run against the live WAL DB.
  const db = new Database(source);
  try {
    db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }

  prune(backupsDir);
  logger.info({ dest }, "backup: snapshot created");
  return dest;
}

function prune(backupsDir: string): void {
  const files = readdirSync(backupsDir)
    .filter((f) => f.startsWith("bot-") && f.endsWith(".db"))
    .map((f) => ({ f, mtime: statSync(join(backupsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  for (const { f } of files.slice(RETENTION)) {
    unlinkSync(join(backupsDir, f));
    logger.debug({ file: f }, "backup: pruned old snapshot");
  }
}

/**
 * Restore the database from a snapshot file. The bot MUST be stopped first
 * (`systemctl stop discord-all-in`) so nothing is mid-write.
 */
export function runRestore(file: string): void {
  if (!file || !existsSync(file)) throw new Error(`Backup file not found: ${file}`);
  const target = dbPath();
  // Remove the live DB and its WAL/SHM sidecars before copying the snapshot in.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = target + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
  copyFileSync(file, target);
  logger.info({ file, target }, "backup: database restored");
}

/** Restore the database from a snapshot: `bun run restore <backup-file>`.
 *  Stop the bot first so nothing is mid-write. */
import { runRestore } from "../src/maintenance/backup.ts";

const file = process.argv[2];
if (!file) {
  console.error("Użycie: bun run restore <plik-backupu>");
  process.exit(1);
}
runRestore(file);
console.log("Przywrócono bazę z:", file);

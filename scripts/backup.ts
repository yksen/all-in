/** Take a database snapshot now: `bun run backup`. */
import { runBackup } from "../src/maintenance/backup.ts";

console.log("Backup created:", runBackup());

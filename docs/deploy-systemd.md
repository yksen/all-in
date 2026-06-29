# Deploying with systemd (hardened)

An optional, hardened **systemd** deployment for Linux hosts — an alternative to the
Docker path in the main [README](../README.md). It runs the bot as a dedicated non-root
user from a read-only compiled binary, keeps writable state under `/var/lib/`, and adds an
hourly backup timer.

Key ideas:

- Runs as a dedicated **non-root user** (`botuser` in the shipped units — change it to the
  account you want the bot to run as).
- Code is a self-contained **Bun compiled binary** in read-only `/usr/share/discord-all-in/`.
- Writable state (SQLite DB + snapshots) lives in **`/var/lib/discord-all-in/`**, created
  automatically by `StateDirectory=` and owned by the service user.
- Logs go to the **journal**; `Restart=always` with a 10s backoff.
- systemd sandboxing: `ProtectSystem=strict`, `ProtectHome=yes`, `NoNewPrivileges`, etc.

The unit files referenced below live in [`../service/`](../service/).

## Build & install

```bash
# 1. Build the single-file binary (on the server, or build elsewhere and copy it over)
cd /path/to/discord-all-in        # the cloned repo
bun install
bun run build                      # -> dist/discord-all-in

# 2. Install the binary + secrets
sudo install -Dm755 dist/discord-all-in /usr/share/discord-all-in/discord-all-in
sudo install -Dm600 .env /usr/share/discord-all-in/.env   # fill in from .env.example first

# 3. Install the units (edit `User=` in them first to the account the bot should run as)
sudo cp service/discord-all-in.service /etc/systemd/system/
sudo cp service/discord-all-in-backup.service /etc/systemd/system/
sudo cp service/discord-all-in-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload

# 4. Register slash commands once (and again whenever commands change)
bun run deploy-commands

# 5. Start everything
sudo systemctl enable --now discord-all-in
sudo systemctl enable --now discord-all-in-backup.timer
sudo systemctl status discord-all-in
journalctl -u discord-all-in -f
```

## Backup / restore

- Hourly snapshots land in `/var/lib/discord-all-in/backups/` (last 48 kept).
- Manual snapshot now: `sudo systemctl start discord-all-in-backup` (or, with the source
  checkout, `bun run backup`).
- Restore (stop the bot first!), running as the service user:

  ```bash
  sudo systemctl stop discord-all-in
  sudo -u botuser /usr/share/discord-all-in/discord-all-in restore /var/lib/discord-all-in/backups/bot-XXXX.db
  sudo systemctl start discord-all-in
  ```

## Reset the economy from scratch

Wipe the database; migrations recreate an empty schema on the next start. This clears all
balances, the ledger, round history, escrow, and the persistent roulette table (re-run
`/admin-roulette setup` afterwards).

```bash
sudo systemctl stop discord-all-in
sudo rm -f /var/lib/discord-all-in/bot.db /var/lib/discord-all-in/bot.db-wal /var/lib/discord-all-in/bot.db-shm
sudo systemctl start discord-all-in
```

# systemd units

These are the systemd unit files for the hardened Linux deployment:

- `discord-all-in.service` — the bot (runs as a non-root `User=` you set, from the compiled binary).
- `discord-all-in-backup.service` + `discord-all-in-backup.timer` — hourly DB snapshots.

The full install / hardening / backup guide lives in
**[../docs/deploy-systemd.md](../docs/deploy-systemd.md)**.

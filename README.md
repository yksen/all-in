# discord-all-in 🎰

A Discord casino & economy bot: an activity-earned currency plus a set of casino games
as slash commands. Built with **TypeScript + discord.js v14** on **Bun**, with a local
**SQLite** database (`bun:sqlite`), an append-only transaction ledger (audit + rollback),
and fast, fully-native visuals — large colored ASCII cards and a live roulette board
rendered in ANSI code blocks (no image rendering).

## Features

### Single-player games (vs. the house / dealer)
- **`/blackjack`** — multiple hands per round, hit / stand / double / split, dealer hits to 17 (soft 17 configurable), blackjack pays 3:2. Replay buttons (same / ½ / 2× bet) after each round.
- **`/poker`** — Casino Hold'em vs. the dealer: ante → flop → call (2× ante) or fold; dealer qualifies with a pair of fours; ante-bonus paytable. Replay buttons.

### Roulette — persistent table
- **`/admin-roulette setup`** (admin) installs an always-on European roulette table on the current channel. It **survives restarts**, auto-spins every 30s, and reposts itself to the bottom of the channel shortly before each spin (when it's been buried) so it doesn't get lost in chat. Anyone can bet during each round — pick a bet from the menu (type **`all in`** in the amount field to stake the max you're allowed), or use the one-click **🔴 All in: Red** / **⚫ All in: Black** buttons. **`/admin-roulette stop`** (admin) closes it and refunds open bets.

### Multiplayer (PvP)
- **`/coinflip @player stake`** — challenge another player to a coin flip; winner takes the whole pot (zero-sum, no rake). Rematch buttons (same / ½ / 2× stake).

### Economy & stats
- **Voice earning** — being in a voice channel pays every minute. Anti-farm guards (minimum humans in the channel, requiring an unmuted/undeafened presence) are off by default and opt-in via env vars (see `.env.example`).
- **Welcome bonus** — a one-time starting balance, granted the first time the bot sees you (a command, a button, or your first voice payout).
- **`/stats`** — your profile: balance, leaderboard rank, games, net, best/worst, and chips earned from activity. `/stats player:@x` for someone else.
- **`/serverstats`** — server-wide totals (circulation, turnover, house P/L, minted from activity) + a "how to earn" panel (source + rate).
- **`/leaderboard`**, **`/topwins`**, **`/toplosses`**.
- **`/admin`** (owners only, hidden from non-admins): `adjust`, `rollback-ref`, `rollback-window`.

All amounts are whole **chips** (no floats). House edge comes from authentic odds (the zero
in roulette, blackjack rules, paytables) — that's the inflation sink. PvP (coinflip) is
zero-sum. Everything is tunable in [`src/config.ts`](src/config.ts).

## Setup

Create a Discord application and fill in `.env`. This is required once, before running the
bot in any environment.

1. **Create the bot.** Open the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**. Under **Bot**, click **Reset Token** and copy it → `DISCORD_TOKEN`. No privileged intents need to be enabled — the bot uses only the non-privileged *Guilds* and *Voice States* intents.
2. **Application ID.** On **General Information**, copy the **Application ID** → `CLIENT_ID`.
3. **Invite the bot.** Under **OAuth2 → URL Generator**, tick the **`bot`** and **`applications.commands`** scopes, then in bot permissions tick **Send Messages**, **Embed Links**, and **Read Message History**. Open the generated URL and add the bot to your server.
4. **Server & owner IDs.** In Discord, enable **Settings → Advanced → Developer Mode**. Then right-click your server icon → **Copy Server ID** → `GUILD_ID`, and right-click your own name → **Copy User ID** → `OWNER_IDS` (comma-separated for multiple owners; these users may run `/admin`).
5. **Write `.env`** and fill in the four values:

   ```bash
   cp .env.example .env
   ```

   ```ini
   DISCORD_TOKEN=your-bot-token
   CLIENT_ID=your-application-id
   GUILD_ID=your-server-id        # commands register here instantly; leave empty for global (~1h to propagate)
   OWNER_IDS=your-user-id
   ```

That's everything required. The optional earning/economy knobs (`WELCOME_BONUS`, `VOICE_*`)
are documented in [`.env.example`](.env.example) and can be left untouched.

## Quick start (dev)

After [Setup](#setup):

```bash
bun install
bun run deploy-commands       # register slash commands (guild-scoped = instant)
bun run start                 # run the bot
bun test                      # game-logic & economy tests
bun run typecheck             # tsc --noEmit
```

## Deployment

Wherever it runs, the bot needs the same three things: the variables from `.env` (see
[Setup](#setup)), a writable `DATA_DIR` for the SQLite DB + backups, and the slash commands
registered once.

### Docker (recommended)

```bash
docker compose up -d --build                          # build image + start (DB persists in the `data` volume)
docker compose run --rm bot bun run deploy-commands   # register slash commands (once, and whenever they change)
docker compose logs -f
```

Update to a new version with `git pull && docker compose up -d --build`. `docker compose down`
stops the bot but keeps the `data` volume (your economy is preserved).

### Bare binary

Compile to a single self-contained binary (Bun + `bun:sqlite` embedded) and run it under
whatever keeps a process alive:

```bash
bun install
bun run build                 # -> dist/discord-all-in
bun run deploy-commands       # register slash commands (once)
DATA_DIR=./data LOG_FORMAT=json ./dist/discord-all-in
```

### systemd (hardened Linux service)

For a hardened, non-root setup — read-only code in `/usr/share`, writable state in
`/var/lib` via `StateDirectory`, sandboxing, and an hourly backup timer — see
**[docs/deploy-systemd.md](docs/deploy-systemd.md)**.

## Configuration (env)

| Variable | Purpose |
|----------|---------|
| `DISCORD_TOKEN` | Bot token (required to run the bot) |
| `CLIENT_ID` | Application ID (required to register commands) |
| `GUILD_ID` | Guild for commands (empty = global) |
| `OWNER_IDS` | Comma-separated owner IDs for `/admin` |
| `DATA_DIR` | DB + backups directory (prod: `/var/lib/discord-all-in`) |
| `LOG_FORMAT` | `pretty` (dev) / `json` (prod, journal) |
| `LOG_LEVEL` | `info` by default |

Optional earning knobs (`WELCOME_BONUS`, `VOICE_AMOUNT_PER_TICK`, `VOICE_TICK_SECONDS`,
`VOICE_MIN_HUMANS`, `VOICE_PAY_WHILE_MUTED`, `VOICE_PAY_WHILE_DEAFENED`,
`VOICE_EXCLUDED_CHANNELS`) are documented in [`.env.example`](.env.example). The remaining
game parameters (edge/rake, payouts, bet limits) live in `src/config.ts`.

## Bet limits (defaults)

| Game | min | max | other |
|---|---|---|---|
| Blackjack | 10 | 10,000 / hand | up to 3 hands |
| Roulette | 10 | 5,000 / bet | 20,000 / round per player |
| Poker (ante) | 10 | 5,000 | |
| Coinflip | 10 | 50,000 | |

## Backups & rollback

- **Append-only ledger**: every balance change is a row with `delta`, `balance_after`, type and `ref` — the source of truth.
- **Snapshots**: a consistent `VACUUM INTO` copy lands in `$DATA_DIR/backups/`. Take one with `bun run backup` (source checkout) or `docker compose run --rm bot bun run backup` (Docker); the systemd deployment runs an hourly timer keeping the last 48. Restore with `... restore <file>` after stopping the bot.
- **Logical rollback**: `/admin rollback-ref <ref>` reverses one event; `/admin rollback-window <minutes>` reverses recent balance changes (e.g. after a bug). Recorded as `rollback` ledger entries (history is never deleted) and clamped to zero.
- **Restart-safe escrow**: every in-flight bet is tracked in `active_games` in the same transaction as the debit. On startup any unsettled game is automatically refunded — a restart for an update never loses a bet.

## Visuals

Cards render as large ASCII boxes inside Discord `ansi` code blocks, colored by suit
(red ♥♦, white ♠♣). Roulette shows the full colored number layout with the last result
highlighted, plus a recent-results strip. Clients without ANSI support fall back to plain
monospace.

## Architecture

```
src/
  index.ts            bootstrap + interaction router + CLI (backup/restore) + startup recovery
  config.ts           typed config (env + game/economy knobs)
  db/                 bun:sqlite (WAL) + inline migrations
  economy/            wallet (ledger + escrow tracking), rounds (stats), voiceTracker, locks
  games/
    engine/           rng, deck, handvalue, pokerEval, roulette (pure, tested logic)
    *.ts              command + component handler per game
  commands/, interactions/   static registries (no FS scan → work in the compiled binary)
  ui/                 cards (ANSI), roulette board (ANSI), dice, colors
  maintenance/        backup/restore (VACUUM INTO)
Dockerfile, docker-compose.yml   container deployment
service/              systemd unit files
docs/                 deploy-systemd.md (hardened systemd guide)
tests/                bun test — payouts, RTP (Monte Carlo), ledger atomicity, rollback, escrow recovery
```

## v1 notes / limitations
- Earning is voice-only (text / `/daily` are easy to add — see `config.ts`, `voiceTracker.ts`).
- Per-player game sessions live in memory (with a TTL); a restart ends in-progress games but escrowed bets are auto-refunded.

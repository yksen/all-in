import { Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { join } from "node:path";
import { assertBotConfig, config } from "./config.ts";
import { logger } from "./lib/logger.ts";
import { openDatabase } from "./db/index.ts";
import { buildServices } from "./services.ts";
import { commands } from "./commands/index.ts";
import { componentHandlers } from "./interactions/index.ts";
import { VoiceTracker } from "./economy/voiceTracker.ts";
import { resumeRouletteTables } from "./games/roulette.ts";
import { resumeCrashTables } from "./games/crash.ts";
import { parseCid } from "./lib/ids.ts";
import { replyError } from "./lib/reply.ts";
import { runBackup, runRestore } from "./maintenance/backup.ts";

// Maintenance subcommands, so the single compiled binary also does backups:
//   discord-all-in backup        | discord-all-in restore <file>
const mode = process.argv[2];
if (mode === "backup") {
  console.log("Backup created:", runBackup());
  process.exit(0);
} else if (mode === "restore") {
  runRestore(process.argv[3] ?? "");
  console.log("Database restored.");
  process.exit(0);
}

assertBotConfig();

const db = openDatabase(join(config.dataDir, "bot.db"));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const services = buildServices(db, client);

const commandMap = new Map(commands.map((c) => [c.data.name, c]));
const componentMap = new Map(componentHandlers.map((h) => [h.prefix, h]));

const voiceTracker = new VoiceTracker(services);

client.once(Events.ClientReady, async (c) => {
  logger.info({ user: c.user.tag, guilds: c.guilds.cache.size }, "ready");
  voiceTracker.start();
  await recoverInterruptedGames();
  await resumeRouletteTables(services, client);
  await resumeCrashTables(services, client);
});

/**
 * Any game still marked "open" in the DB was abandoned by a previous restart/crash
 * (in-memory sessions don't survive). Refund the escrowed chips and tell the players
 * by editing the original game message. Roulette-table rounds are refunded too, but
 * their message is left alone — the resumed table re-renders it itself.
 */
async function recoverInterruptedGames(): Promise<void> {
  const { count, total, items } = services.wallet.refundOpenGames();
  if (count === 0) return;
  logger.warn({ count, total }, "recovered interrupted games — escrow refunded to players");

  const edited = new Set<string>();
  for (const item of items) {
    if (item.game === "roulette" || item.game === "crash") continue; // the persistent table manages its own message
    if (!item.channel_id || !item.message_id) continue;
    const key = `${item.channel_id}:${item.message_id}`;
    if (edited.has(key)) continue;
    edited.add(key);
    try {
      const channel = await client.channels.fetch(item.channel_id);
      if (!channel?.isTextBased()) continue;
      const message = await channel.messages.fetch(item.message_id);
      await message.edit({
        embeds: [
          new EmbedBuilder()
            .setColor(0x95a5a6)
            .setTitle("♻️ Game interrupted")
            .setDescription("The bot restarted mid-game — your escrowed bets were refunded."),
        ],
        components: [],
      });
    } catch {
      // Message may have been deleted, or the channel is unreachable — ignore.
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.inCachedGuild()) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "🎰 This casino bot only works inside a server.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    // Make sure the account exists (and grant the one-time welcome bonus) before
    // any command or component handler touches the wallet.
    services.wallet.ensureAccount(interaction.guildId, interaction.user.id);

    if (interaction.isChatInputCommand()) {
      const command = commandMap.get(interaction.commandName);
      if (!command) return;
      if (command.ownerOnly && !config.discord.ownerIds.includes(interaction.user.id)) {
        await replyError(interaction, "This command is only available to the bot owners.");
        return;
      }
      await command.execute(interaction, services);
    } else if (interaction.isAutocomplete()) {
      await commandMap.get(interaction.commandName)?.autocomplete?.(interaction, services);
    } else if (
      interaction.isButton() ||
      interaction.isStringSelectMenu() ||
      interaction.isModalSubmit()
    ) {
      const { prefix } = parseCid(interaction.customId);
      const handler = componentMap.get(prefix);
      if (!handler) return;
      await handler.handle(interaction, services);
    }
  } catch (err) {
    logger.error({ err }, "interaction handler error");
    if (interaction.isRepliable()) {
      await replyError(interaction, "Something went wrong. Please try again.");
    }
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  voiceTracker.stop();
  try {
    await client.destroy();
  } catch {
    /* ignore */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await client.login(config.discord.token);

/**
 * Registers all slash commands with Discord. Guild-scoped when GUILD_ID is set
 * (updates are instant) or global otherwise (can take up to an hour to propagate).
 *
 *   bun run deploy-commands
 */
import { REST, Routes } from "discord.js";
import { assertBotConfig, config } from "../src/config.ts";
import { commands } from "../src/commands/index.ts";
import { logger } from "../src/lib/logger.ts";

assertBotConfig();

const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(config.discord.token);

const route = config.discord.guildId
  ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
  : Routes.applicationCommands(config.discord.clientId);

await rest.put(route, { body });

logger.info(
  { count: body.length, scope: config.discord.guildId ? `guild ${config.discord.guildId}` : "global" },
  "slash commands deployed",
);

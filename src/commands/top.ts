import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { gameLabel } from "../lib/gameLabels.ts";
import { Colors } from "../ui/theme.ts";

async function showTop(
  interaction: Parameters<Command["execute"]>[0],
  services: Services,
  kind: "wins" | "losses",
): Promise<void> {
  const rows = services.rounds.topRounds(interaction.guildId, kind, 10);
  if (rows.length === 0) {
    await interaction.reply({ content: "No data to show yet." });
    return;
  }
  const lines = rows.map(
    (r, i) =>
      `**${i + 1}.** **${formatSigned(r.net)}** • ${gameLabel(r.game)} • <@${r.user_id}> _(bet ${formatChips(r.wager)})_`,
  );
  const embed = new EmbedBuilder()
    .setColor(kind === "wins" ? Colors.win : Colors.loss)
    .setTitle(kind === "wins" ? "📈 Biggest wins" : "📉 Biggest losses")
    .setDescription(lines.join("\n"));
  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

export const topWins: Command = {
  data: new SlashCommandBuilder().setName("topwins").setDescription("Biggest single-round wins"),
  execute: (interaction, services) => showTop(interaction, services, "wins"),
};

export const topLosses: Command = {
  data: new SlashCommandBuilder().setName("toplosses").setDescription("Biggest single-round losses"),
  execute: (interaction, services) => showTop(interaction, services, "losses"),
};

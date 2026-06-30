import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../framework/types.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { gameLabel } from "../lib/gameLabels.ts";
import { Colors } from "../ui/theme.ts";

export const recent: Command = {
  data: new SlashCommandBuilder()
    .setName("recent")
    .setDescription("Your latest bets and their results, or another player's")
    .addUserOption((o) => o.setName("player").setDescription("Whose bets to show (default: you)").setRequired(false)),

  async execute(interaction, services) {
    const target = interaction.options.getUser("player") ?? interaction.user;
    const rows = services.rounds.recentRounds(interaction.guildId, target.id, 10);
    if (rows.length === 0) {
      await interaction.reply({ content: `No bets to show for ${target.displayName} yet.`, allowedMentions: { parse: [] } });
      return;
    }
    const lines = rows.map((r) => {
      const icon = r.net > 0 ? "✅" : r.net < 0 ? "💥" : "➖";
      // ponytail: substring beats JSON.parse here — details is JSON.stringify output (no spaces), only all-in rounds carry "allIn":true
      const allIn = r.details?.includes('"allIn":true') ? " 🔥**ALL IN**" : "";
      return `${icon} ${gameLabel(r.game)} • bet ${formatChips(r.wager)}${allIn} → **${formatSigned(r.net)}** • <t:${Math.floor(r.ended_at / 1000)}:R>`;
    });
    const embed = new EmbedBuilder()
      .setColor(Colors.table)
      .setAuthor({ name: `${target.displayName} — recent bets`, iconURL: target.displayAvatarURL() })
      .setDescription(lines.join("\n"));
    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

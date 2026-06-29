import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../framework/types.ts";
import { formatNumber } from "../lib/money.ts";
import { Colors, Emoji } from "../ui/theme.ts";

const MEDALS = ["🥇", "🥈", "🥉"];
const BAR_WIDTH = 14;

export const leaderboard: Command = {
  data: new SlashCommandBuilder().setName("leaderboard").setDescription("Richest players"),

  async execute(interaction, services) {
    const rows = services.rounds.topBalances(interaction.guildId, 10);
    if (rows.length === 0) {
      await interaction.reply({ content: "Nobody has any chips yet. 🪙" });
      return;
    }

    const top = rows[0]!.balance;
    const amountStrs = rows.map((r) => formatNumber(r.balance));
    const netStrs = rows.map((r) => (r.net >= 0 ? "+" : "") + formatNumber(r.net));
    const amountW = Math.max(...amountStrs.map((s) => s.length));
    const netW = Math.max(...netStrs.map((s) => s.length));

    // One line per player: medal/rank, then a single monospace inline-code pill
    // holding the fixed-width bar + right-padded balance + net (so those columns line
    // up across rows), a 📈/📉 marker, and finally the clickable mention at the end.
    const lines = rows.map((r, i) => {
      const rank = MEDALS[i] ?? `**#${i + 1}**`;
      const filled = Math.max(1, Math.round((r.balance / top) * BAR_WIDTH));
      const bar = "█".repeat(filled).padEnd(BAR_WIDTH, "░");
      const pill = `${bar}  ${amountStrs[i]!.padStart(amountW)}  ${netStrs[i]!.padStart(netW)}`;
      const arrow = r.net > 0 ? "📈" : r.net < 0 ? "📉" : "➖";
      return `${rank} \`${pill}\` ${arrow} <@${r.user_id}>`;
    });

    const server = services.rounds.serverStats(interaction.guildId);
    const me = services.rounds.balanceRank(interaction.guildId, interaction.user.id);

    const embed = new EmbedBuilder()
      .setColor(Colors.gold)
      .setTitle(`${Emoji.trophy} Richest players`)
      .setDescription(lines.join("\n"))
      .setFooter({
        text:
          `💰 ${formatNumber(server.inCirculation)} in circulation • ${server.players} players` +
          `\nbar = share of #1 · net = lifetime game P/L`,
      });

    if (me.rank > 10) {
      const myBalance = services.wallet.getBalance(interaction.guildId, interaction.user.id);
      embed.addFields({
        name: "Your position",
        value: `#${me.rank} of ${me.total} — ${formatNumber(myBalance)} 🪙`,
      });
    }

    await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  },
};

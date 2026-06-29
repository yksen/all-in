import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command } from "../framework/types.ts";
import { formatChips, formatNumber, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";

/** Where chips come from and the current rate — shown on /serverstats. */
function earningInfo(): string {
  const v = config.economy.voice;
  const perMin = (v.amountPerTick * 60) / v.tickSeconds;
  // Only list the requirements that are actually enforced by the current config.
  const reqs = ["not AFK"];
  if (v.minHumansInChannel > 1) reqs.unshift(`at least ${v.minHumansInChannel} people present`);
  if (!v.payWhileSelfMuted) reqs.push("not self-muted");
  if (!v.payWhileSelfDeafened) reqs.push("not self-deafened");
  return (
    `🎙️ **Voice activity** — **${formatNumber(perMin)} 🪙/min** while you're in a voice channel ` +
    `(${reqs.join(", ")}).\n` +
    `🎁 **Welcome bonus** — **${formatChips(config.economy.welcomeBonus)}** once, the first time you use the bot.`
  );
}

export const stats: Command = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Your profile & balance, or another player's")
    .addUserOption((o) => o.setName("player").setDescription("Whose profile to show (default: you)").setRequired(false)),

  async execute(interaction, services) {
    const target = interaction.options.getUser("player") ?? interaction.user;
    const balance = services.wallet.getBalance(interaction.guildId, target.id);
    const { rank, total } = services.rounds.balanceRank(interaction.guildId, target.id);
    const s = services.rounds.userStats(interaction.guildId, target.id);

    const rankText = rank > 0 ? `#${rank} of ${total}` : "unranked";
    const medal = rank === 1 ? "🥇 " : rank === 2 ? "🥈 " : rank === 3 ? "🥉 " : "";

    const embed = new EmbedBuilder()
      .setColor(Colors.gold)
      .setAuthor({ name: `${target.displayName} — profile`, iconURL: target.displayAvatarURL() })
      .setThumbnail(target.displayAvatarURL())
      .setDescription(`# ${formatChips(balance)}\n${medal}**${rankText}** on the leaderboard`)
      .addFields(
        { name: "🎲 Games", value: String(s.gamesPlayed), inline: true },
        { name: "📊 Net (games)", value: formatSigned(s.net), inline: true },
        { name: "💼 Wagered", value: formatChips(s.totalWagered), inline: true },
        { name: "🔥 Best win", value: s.biggestWin > 0 ? formatSigned(s.biggestWin) : "—", inline: true },
        { name: "💀 Worst loss", value: s.biggestLoss < 0 ? formatSigned(s.biggestLoss) : "—", inline: true },
        { name: "🎙️ From activity", value: formatChips(s.fromActivity), inline: true },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

export const serverstats: Command = {
  data: new SlashCommandBuilder().setName("serverstats").setDescription("Server-wide economy stats"),

  async execute(interaction, services) {
    const s = services.rounds.serverStats(interaction.guildId);
    // Realized house edge so far = house profit as a share of everything wagered.
    const edge = s.turnover > 0 ? (s.housePnL / s.turnover) * 100 : 0;
    const embed = new EmbedBuilder()
      .setColor(Colors.brand)
      .setTitle("📊 Server stats")
      .addFields(
        { name: "In circulation", value: formatChips(s.inCirculation), inline: true },
        { name: "Players", value: String(s.players), inline: true },
        { name: "Rounds played", value: String(s.roundsPlayed), inline: true },
        { name: "Earned from activity", value: formatChips(s.mintedFromActivity), inline: true },
        { name: "Welcome bonuses", value: formatChips(s.mintedWelcome), inline: true },
        { name: "Total wagered", value: formatChips(s.turnover), inline: true },
        {
          name: "House P/L",
          value:
            `${formatSigned(s.housePnL)} • **${edge.toFixed(1)}% edge** ` +
            `${s.housePnL >= 0 ? "(house ahead)" : "(players ahead)"}`,
        },
        { name: "💸 How to earn", value: earningInfo() },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

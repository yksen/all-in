import { EmbedBuilder, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "../framework/types.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";

export const admin: Command = {
  // Authorization is by OWNER_IDS at runtime; this also hides the command in the UI
  // from everyone who isn't a server administrator.
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Administrative commands (owners only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) =>
      s
        .setName("adjust")
        .setDescription("Add or remove chips from a player")
        .addUserOption((o) => o.setName("player").setDescription("Target player").setRequired(true))
        .addIntegerOption((o) =>
          o
            .setName("amount")
            .setDescription("How much (negative to remove)")
            .setRequired(true)
            .setMinValue(-1_000_000_000)
            .setMaxValue(1_000_000_000),
        )
        .addStringOption((o) => o.setName("reason").setDescription("Reason for the adjustment").setRequired(false)),
    )
    .addSubcommand((s) =>
      s
        .setName("rollback-ref")
        .setDescription("Reverse the money effect of an event by its ref")
        .addStringOption((o) => o.setName("ref").setDescription("Ledger ref to reverse").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("rollback-window")
        .setDescription("Reverse all balance changes from the last N minutes (emergency)")
        .addIntegerOption((o) =>
          o.setName("minutes").setDescription("How many minutes back").setRequired(true).setMinValue(1).setMaxValue(10_080),
        ),
    ),

  async execute(interaction, services) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === "adjust") {
      const target = interaction.options.getUser("player", true);
      const amount = interaction.options.getInteger("amount", true);
      const reason = interaction.options.getString("reason") ?? undefined;
      const { applied, balanceAfter } = services.wallet.adjust(guildId, target.id, amount, "admin_adjust", null, {
        by: interaction.user.id,
        reason,
      });
      const embed = new EmbedBuilder()
        .setColor(Colors.info)
        .setTitle("🛠️ Balance adjustment")
        .setDescription(
          `<@${target.id}>: ${formatSigned(applied)}` +
            (applied !== amount ? ` _(clamped from ${formatSigned(amount)} — balance can't go negative)_` : "") +
            `\nNew balance: **${formatChips(balanceAfter)}**`,
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === "rollback-ref") {
      const ref = interaction.options.getString("ref", true);
      const { affected, alreadyDone } = services.wallet.rollbackByRef(guildId, ref);
      if (alreadyDone) {
        await interaction.reply({ content: `Ref \`${ref}\` was already rolled back.`, flags: MessageFlags.Ephemeral });
        return;
      }
      const lines = affected.length
        ? affected.map((a) => `<@${a.userId}>: ${formatSigned(a.applied)}`).join("\n")
        : "_No ledger entries for that ref._";
      await interaction.reply({
        embeds: [new EmbedBuilder().setColor(Colors.warn).setTitle(`↩️ Rollback ref ${ref}`).setDescription(lines)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === "rollback-window") {
      const minutes = interaction.options.getInteger("minutes", true);
      const sinceTs = Date.now() - minutes * 60_000;
      const affected = services.wallet.rollbackWindow(guildId, sinceTs);
      const lines = affected.length
        ? affected.map((a) => `<@${a.userId}>: ${formatSigned(a.applied)}`).join("\n")
        : "_No changes in that window._";
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.warn)
            .setTitle(`↩️ Rollback last ${minutes} min`)
            .setDescription(lines.slice(0, 4000)),
        ],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }
  },
};

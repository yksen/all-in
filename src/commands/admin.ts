import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Command, ComponentHandler } from "../framework/types.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { cid, parseCid } from "../lib/ids.ts";
import { replyError } from "../lib/reply.ts";
import { config } from "../config.ts";
import { setupRouletteTable, stopRouletteTable } from "../games/roulette.ts";
import { setupCrashTable, stopCrashTable } from "../games/crash.ts";
import { setupCrapsTable, stopCrapsTable } from "../games/craps.ts";

const PREFIX = "admin";

type AdminAction =
  | "adjust"
  | "rollback-ref"
  | "rollback-window"
  | "roulette-setup"
  | "roulette-stop"
  | "crash-setup"
  | "crash-stop"
  | "craps-setup"
  | "craps-stop";

const ACTIONS: { value: AdminAction; label: string; description: string }[] = [
  { value: "adjust", label: "💰 Adjust balance", description: "Add or remove chips from a player" },
  { value: "rollback-ref", label: "↩️ Rollback by ref", description: "Reverse the money effect of one event" },
  { value: "rollback-window", label: "⏱️ Rollback last N minutes", description: "Emergency: undo a recent time window" },
  { value: "roulette-setup", label: "🎡 Roulette — setup table", description: "Install or refresh on this channel" },
  { value: "roulette-stop", label: "🎡 Roulette — stop table", description: "Stop and remove from this channel" },
  { value: "crash-setup", label: "🚀 Crash — setup table", description: "Install or refresh on this channel" },
  { value: "crash-stop", label: "🚀 Crash — stop table", description: "Stop and remove from this channel" },
  { value: "craps-setup", label: "🎲 Craps — setup table", description: "Install or refresh on this channel" },
  { value: "craps-stop", label: "🎲 Craps — stop table", description: "Stop and remove from this channel" },
];

function textRow(id: string, label: string, required: boolean): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(required),
  );
}

function buildModal(action: AdminAction): ModalBuilder | null {
  if (action === "adjust") {
    return new ModalBuilder()
      .setCustomId(cid(PREFIX, "modal", action))
      .setTitle("Adjust balance")
      .addComponents(
        textRow("player", "Player (@mention or numeric ID)", true),
        textRow("amount", "Amount (negative to remove)", true),
        textRow("reason", "Reason (optional)", false),
      );
  }
  if (action === "rollback-ref") {
    return new ModalBuilder()
      .setCustomId(cid(PREFIX, "modal", action))
      .setTitle("Rollback by ref")
      .addComponents(textRow("ref", "Ledger ref to reverse", true));
  }
  if (action === "rollback-window") {
    return new ModalBuilder()
      .setCustomId(cid(PREFIX, "modal", action))
      .setTitle("Rollback a time window")
      .addComponents(textRow("minutes", "Minutes back (1-10080)", true));
  }
  return null;
}

export const admin: Command = {
  // Authorization is by OWNER_IDS at runtime; this also hides the command in the UI
  // from everyone who isn't a server administrator.
  ownerOnly: true,
  data: new SlashCommandBuilder()
    .setName("admin")
    .setDescription("Administrative commands (owners only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    const menu = new StringSelectMenuBuilder()
      .setCustomId(cid(PREFIX, "menu"))
      .setPlaceholder("Choose an admin action…")
      .addOptions(ACTIONS);
    await interaction.reply({
      content: "🛠️ **Admin panel**",
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

export const adminComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    if (!config.discord.ownerIds.includes(interaction.user.id)) {
      await replyError(interaction, "This command is only available to the bot owners.");
      return;
    }
    const { parts } = parseCid(interaction.customId);

    if (interaction.isStringSelectMenu() && parts[0] === "menu") {
      const action = interaction.values[0] as AdminAction;
      const modal = buildModal(action);
      if (modal) {
        await interaction.showModal(modal);
        return;
      }
      switch (action) {
        case "roulette-setup":
          return setupRouletteTable(interaction, services);
        case "roulette-stop":
          return stopRouletteTable(interaction, services);
        case "crash-setup":
          return setupCrashTable(interaction, services);
        case "crash-stop":
          return stopCrashTable(interaction, services);
        case "craps-setup":
          return setupCrapsTable(interaction, services);
        case "craps-stop":
          return stopCrapsTable(interaction, services);
      }
      return;
    }

    if (interaction.isModalSubmit() && parts[0] === "modal") {
      const action = parts[1] as AdminAction;
      const guildId = interaction.guildId;

      if (action === "adjust") {
        const rawPlayer = interaction.fields.getTextInputValue("player").trim();
        const idMatch = rawPlayer.match(/^<@!?(\d{15,25})>$|^(\d{15,25})$/);
        const playerId = idMatch?.[1] ?? idMatch?.[2];
        if (!playerId) {
          await replyError(interaction, "Couldn't parse player — use an @mention or a numeric ID.");
          return;
        }
        const amount = Number.parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);
        if (!Number.isFinite(amount) || amount === 0) {
          await replyError(interaction, "Amount must be a non-zero whole number.");
          return;
        }
        const reason = interaction.fields.getTextInputValue("reason").trim() || undefined;
        const { applied, balanceAfter } = services.wallet.adjust(guildId, playerId, amount, "admin_adjust", null, {
          by: interaction.user.id,
          reason,
        });
        const embed = new EmbedBuilder()
          .setColor(Colors.info)
          .setTitle("🛠️ Balance adjustment")
          .setDescription(
            `<@${playerId}>: ${formatSigned(applied)}` +
              (applied !== amount ? ` _(clamped from ${formatSigned(amount)} — balance can't go negative)_` : "") +
              `\nNew balance: **${formatChips(balanceAfter)}**`,
          );
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
        return;
      }

      if (action === "rollback-ref") {
        const ref = interaction.fields.getTextInputValue("ref").trim();
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

      if (action === "rollback-window") {
        const minutes = Number.parseInt(interaction.fields.getTextInputValue("minutes").trim(), 10);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10_080) {
          await replyError(interaction, "Minutes must be a whole number between 1 and 10080.");
          return;
        }
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
      }
    }
  },
};

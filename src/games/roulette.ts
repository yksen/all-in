import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type Message,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Command, ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { type BetDef, OUTSIDE_BETS, resolveInsideBet, returnFor, spin, WHEEL_SEQUENCE } from "./engine/roulette.ts";
import { historyStrip, renderGrid, renderReel, resultLine } from "../ui/roulette.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatNumber, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "rlt";
const R = config.games.roulette;

interface PlacedBet extends BetDef {
  amount: number;
}

/** A persistent, always-on roulette table installed on one channel. */
interface LiveTable {
  guildId: string;
  channelId: string;
  message?: Message;
  roundId: string;
  roundStartedAt: number;
  roundEndsAt: number;
  bets: Map<string, PlacedBet[]>;
  history: number[];
  lastResult: number | null;
  /** Net winners of the most recent round that had bets, sorted high→low. */
  lastWinners?: { userId: string; net: number }[];
  spinning: boolean;
  repostTimer?: ReturnType<typeof setTimeout>;
  spinTimer?: ReturnType<typeof setTimeout>;
}

const tables = new Map<string, LiveTable>();
let servicesRef: Services;

const BET_OPTIONS = [
  { value: "inside", label: "Numbers — straight/split/street/corner/six-line", description: "Type numbers (35:1 to 5:1)" },
  { value: "red", label: "Red (1:1)" },
  { value: "black", label: "Black (1:1)" },
  { value: "green", label: "Green · 0 (35:1)" },
  { value: "even", label: "Even (1:1)" },
  { value: "odd", label: "Odd (1:1)" },
  { value: "low", label: "1-18 low (1:1)" },
  { value: "high", label: "19-36 high (1:1)" },
  { value: "dozen1", label: "1st dozen · 1-12 (2:1)" },
  { value: "dozen2", label: "2nd dozen · 13-24 (2:1)" },
  { value: "dozen3", label: "3rd dozen · 25-36 (2:1)" },
  { value: "column1", label: "Column 1 (2:1)" },
  { value: "column2", label: "Column 2 (2:1)" },
  { value: "column3", label: "Column 3 (2:1)" },
];

// --- rendering --------------------------------------------------------------

/** "🥇 @user +1,500" lines for the last round's winners, or a house-won note. */
function winnersField(winners: { userId: string; net: number }[]): string {
  if (winners.length === 0) return "No winners — the house took the round. 🏦";
  const medals = ["🥇", "🥈", "🥉"];
  return winners
    .slice(0, 10)
    .map((w, i) => `${medals[i] ?? "🏆"} <@${w.userId}> ${formatSigned(w.net)}`)
    .join("\n")
    .slice(0, 1024);
}

function tableEmbed(table: LiveTable): EmbedBuilder {
  const bettors = [...table.bets.entries()];
  const betsField = bettors.length
    ? bettors
        .map(([uid, bets]) => {
          const total = bets.reduce((s, x) => s + x.amount, 0);
          const list = bets.map((b) => ` • ${b.label} — ${formatChips(b.amount)}`).join("\n");
          return `<@${uid}> — ${formatChips(total)}\n${list}`;
        })
        .join("\n")
        .slice(0, 1024)
    : "_Place your bets!_";

  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setTitle("🎡 Roulette — European table")
    .setDescription(renderGrid(table.lastResult))
    .addFields(
      { name: "Last spin", value: table.lastResult === null ? "—" : resultLine(table.lastResult), inline: true },
      { name: "Next spin", value: `<t:${Math.floor(table.roundEndsAt / 1000)}:R>`, inline: true },
      { name: "Recent", value: historyStrip(table.history) },
    );

  // Winners of the most recent round that actually had bets (skipped for empty auto-spins).
  if (table.lastWinners) embed.addFields({ name: "🏆 Last round", value: winnersField(table.lastWinners) });

  return embed
    .addFields({ name: "Bets this round", value: betsField })
    .setFooter({ text: `Min ${R.minBet} • Max ${R.maxBet}/bet • ${R.maxTotalBetPerRound}/round per player` });
}

function tableComponents(table: LiveTable): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(cid(PREFIX, "select", table.channelId))
    .setPlaceholder("➕ Place a bet")
    .addOptions(BET_OPTIONS);
  // One-click "all in" on a colour (a modal can't host a button; these live on the message).
  const allIn = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "allin", table.channelId, "red"))
      .setLabel("All in: Red")
      .setEmoji("🔴")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "allin", table.channelId, "black"))
      .setLabel("All in: Black")
      .setEmoji("⚫")
      .setStyle(ButtonStyle.Secondary),
  );
  return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu), allIn];
}

function refreshMessage(table: LiveTable): void {
  void table.message?.edit({ embeds: [tableEmbed(table)], components: tableComponents(table) }).catch(() => {});
}

// --- spinning ---------------------------------------------------------------

function performSpin(table: LiveTable, services: Services, forced?: number): void {
  if (table.spinning) return;
  table.spinning = true;
  try {
    const result = forced ?? spin();
    const hadBets = table.bets.size > 0;
    const winners: { userId: string; net: number }[] = [];
    for (const [userId, bets] of table.bets) {
      const staked = bets.reduce((s, b) => s + b.amount, 0);
      let returned = 0;
      for (const b of bets) returned += returnFor(b, b.amount, result);
      if (returned > 0) {
        services.wallet.applyDelta({
          guildId: table.guildId,
          userId,
          delta: returned,
          type: "payout",
          game: "roulette",
          ref: table.roundId,
        });
      }
      const net = returned - staked;
      if (net > 0) winners.push({ userId, net });
      services.rounds.record({
        game: "roulette",
        guildId: table.guildId,
        userId,
        wager: staked,
        payout: returned,
        outcome: net > 0 ? "win" : net < 0 ? "loss" : "push",
        details: { result },
        startedAt: table.roundStartedAt,
      });
    }
    services.wallet.closeGame(table.roundId);

    // Remember winners only for rounds that had action, so the panel doesn't get wiped
    // by the empty auto-spins that happen when nobody's betting.
    if (hadBets) {
      winners.sort((a, b) => b.net - a.net);
      table.lastWinners = winners;
    }

    table.lastResult = result;
    table.history.unshift(result);
    if (table.history.length > R.historyLength) table.history.pop();

    // Open a fresh round.
    table.roundId = newId();
    table.bets.clear();
    table.roundStartedAt = Date.now();
    table.roundEndsAt = Date.now() + R.spinIntervalSeconds * 1000;
  } finally {
    table.spinning = false;
  }
  refreshMessage(table);
}

function reelEmbed(window: number[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.warn)
    .setTitle("🎡 No more bets — spinning…")
    .setDescription(renderReel(window, 3));
}

/**
 * When there are bets, play a decelerating reel animation that lands on `result`,
 * hold for a beat, then settle. The reel is a 7-wide window sliding across a strip of
 * consecutive pockets taken from the real European wheel order, built so the focused
 * center lands exactly on the result.
 */
async function animateAndSpin(table: LiveTable, services: Services): Promise<void> {
  if (table.bets.size === 0 || !table.message) {
    performSpin(table, services);
    return;
  }

  const result = spin();
  const FRAMES = 8;
  const CENTER = FRAMES + 2; // reel index that ends up under the pointer in the final frame
  const len = WHEEL_SEQUENCE.length;
  const pos = WHEEL_SEQUENCE.indexOf(result);
  // Consecutive pockets in real wheel order, with the result sitting at CENTER.
  const reel = Array.from({ length: FRAMES + 6 }, (_, i) => {
    const idx = (((pos - CENTER + i) % len) + len) % len;
    return WHEEL_SEQUENCE[idx]!;
  });

  for (let f = 0; f < FRAMES; f++) {
    await table.message.edit({ embeds: [reelEmbed(reel.slice(f, f + 7))], components: [] }).catch(() => {});
    await sleep(300 + f * 70); // slow down toward the stop
  }
  await sleep(900); // suspense before the reveal
  performSpin(table, services, result);
}

function clearTimers(table: LiveTable): void {
  if (table.repostTimer) clearTimeout(table.repostTimer);
  if (table.spinTimer) clearTimeout(table.spinTimer);
}

/**
 * Schedule the current round: shortly before the spin, if nobody has bet yet AND the
 * table has been buried under newer messages, repost it to the bottom of the channel
 * as a "place your bets" nudge. (If it's already the last message the nudge is still
 * visible, so we skip — no pointless bumping of a quiet channel.) Then the spin runs
 * and opens + re-schedules the next round.
 */
function scheduleRound(table: LiveTable, services: Services): void {
  clearTimers(table);
  const interval = R.spinIntervalSeconds * 1000;
  const lead = Math.min(R.repostLeadSeconds, R.spinIntervalSeconds - 1) * 1000;

  table.repostTimer = setTimeout(() => {
    void services.locks.run(`rlt:${table.channelId}`, async () => {
      if (table.bets.size === 0 && (await isBuried(table))) await repost(table, services);
    });
  }, interval - lead);

  table.spinTimer = setTimeout(() => {
    void services.locks.run(`rlt:${table.channelId}`, async () => {
      await animateAndSpin(table, services);
      scheduleRound(table, services);
    });
  }, interval);

  if ("unref" in table.repostTimer) table.repostTimer.unref();
  if ("unref" in table.spinTimer) table.spinTimer.unref();
}

/** True if newer messages have pushed the table message off the bottom of the channel. */
async function isBuried(table: LiveTable): Promise<boolean> {
  const channel = table.message?.channel;
  if (!channel?.isTextBased()) return false;
  try {
    const latest = (await channel.messages.fetch({ limit: 1 })).first();
    return !!latest && latest.id !== table.message!.id;
  } catch {
    return false;
  }
}

/** Move the table message to the bottom of the channel (delete old, send fresh). */
async function repost(table: LiveTable, services: Services): Promise<void> {
  const channel = table.message?.channel;
  if (!channel?.isSendable()) return;
  const old = table.message;
  try {
    table.message = await channel.send({ embeds: [tableEmbed(table)], components: tableComponents(table) });
    saveTable(services, {
      channelId: table.channelId,
      guildId: table.guildId,
      messageId: table.message.id,
      createdBy: "system",
    });
    await old?.delete().catch(() => {});
  } catch {
    table.message = old; // keep the old reference if reposting failed
  }
}

function refundRound(table: LiveTable, services: Services): void {
  for (const [userId, bets] of table.bets) {
    const total = bets.reduce((s, b) => s + b.amount, 0);
    if (total > 0) {
      services.wallet.applyDelta({
        guildId: table.guildId,
        userId,
        delta: total,
        type: "payout",
        game: "roulette",
        ref: table.roundId,
        meta: { refund: true },
      });
    }
  }
  services.wallet.closeGame(table.roundId);
  table.bets.clear();
}

function newRound(): Pick<LiveTable, "roundId" | "roundStartedAt" | "roundEndsAt" | "bets" | "spinning"> {
  return {
    roundId: newId(),
    roundStartedAt: Date.now(),
    roundEndsAt: Date.now() + R.spinIntervalSeconds * 1000,
    bets: new Map(),
    spinning: false,
  };
}

// --- DB persistence ---------------------------------------------------------

function saveTable(services: Services, t: { channelId: string; guildId: string; messageId: string; createdBy: string }): void {
  services.db
    .query(
      `INSERT INTO roulette_tables (channel_id, guild_id, message_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET message_id = excluded.message_id, created_by = excluded.created_by`,
    )
    .run(t.channelId, t.guildId, t.messageId, t.createdBy, Date.now());
}

function deleteTableRow(services: Services, channelId: string): void {
  services.db.query("DELETE FROM roulette_tables WHERE channel_id = ?").run(channelId);
}

/** Re-attach persisted tables after a restart and resume spinning. */
export async function resumeRouletteTables(services: Services, client: Client): Promise<void> {
  servicesRef ??= services;
  const rows = services.db
    .query("SELECT channel_id, guild_id, message_id FROM roulette_tables")
    .all() as { channel_id: string; guild_id: string; message_id: string }[];

  for (const row of rows) {
    const table: LiveTable = {
      guildId: row.guild_id,
      channelId: row.channel_id,
      history: [],
      lastResult: null,
      ...newRound(),
    };
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (channel?.isTextBased()) {
        table.message = await channel.messages.fetch(row.message_id).catch(() => undefined);
        if (!table.message && "send" in channel) {
          table.message = await channel.send({ embeds: [tableEmbed(table)], components: tableComponents(table) });
          saveTable(services, {
            channelId: row.channel_id,
            guildId: row.guild_id,
            messageId: table.message.id,
            createdBy: "system",
          });
        }
      }
    } catch {
      /* channel gone — keep the table logical, admin can re-setup */
    }
    tables.set(table.channelId, table);
    refreshMessage(table);
    scheduleRound(table, services);
  }
  if (rows.length) services.logger.info({ count: rows.length }, "roulette: resumed persistent tables");
}

// --- commands ---------------------------------------------------------------

function isAdmin(interaction: { memberPermissions: { has(p: bigint): boolean } | null }): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function setupTable(interaction: ChatInputCommandInteraction<"cached">, services: Services): Promise<void> {
  const existing = tables.get(interaction.channelId);
  if (existing) {
    refundRound(existing, services);
    clearTimers(existing);
  }

  const table: LiveTable = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    history: existing?.history ?? [],
    lastResult: existing?.lastResult ?? null,
    ...newRound(),
  };

  await interaction.reply({ embeds: [tableEmbed(table)], components: tableComponents(table) });
  table.message = await interaction.fetchReply();
  tables.set(table.channelId, table);
  saveTable(services, {
    channelId: table.channelId,
    guildId: table.guildId,
    messageId: table.message.id,
    createdBy: interaction.user.id,
  });
  scheduleRound(table, services);
}

async function stopTable(interaction: ChatInputCommandInteraction<"cached">, services: Services): Promise<void> {
  const table = tables.get(interaction.channelId);
  if (!table) {
    await interaction.reply({ content: "There's no roulette table on this channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  await services.locks.run(`rlt:${table.channelId}`, async () => {
    refundRound(table, services);
    clearTimers(table);
    tables.delete(table.channelId);
    deleteTableRow(services, table.channelId);
    await table.message
      ?.edit({
        embeds: [new EmbedBuilder().setColor(Colors.push).setTitle("🎡 Roulette — closed").setDescription("This table is closed.")],
        components: [],
      })
      .catch(() => {});
    await interaction.reply({ content: "Roulette table closed. Open bets were refunded.", flags: MessageFlags.Ephemeral });
  });
}

export const adminRouletteCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("admin-roulette")
    .setDescription("Manage the persistent roulette table on this channel (admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName("setup").setDescription("Install or refresh the table on this channel"))
    .addSubcommand((s) => s.setName("stop").setDescription("Stop and remove the table on this channel")),

  async execute(interaction, services) {
    servicesRef ??= services;
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "Only server admins can manage the roulette table.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.options.getSubcommand() === "stop") {
      await stopTable(interaction, services);
    } else {
      await setupTable(interaction, services);
    }
  },
};

// --- placing bets -----------------------------------------------------------

/**
 * Place one bet for a player. The caller must hold the table lock and have already
 * checked `table.spinning`. `stake` of "max" resolves to the most allowed right now —
 * capped by the per-bet max, the player's balance, and their remaining per-round
 * allowance. Returns an ephemeral error message to show the player, or null on success.
 */
function tryPlaceBet(
  table: LiveTable,
  services: Services,
  userId: string,
  def: BetDef,
  stake: number | "max",
): string | null {
  const userBets = table.bets.get(userId) ?? [];
  const userTotal = userBets.reduce((s, b) => s + b.amount, 0);

  let amount = stake === "max" ? 0 : stake;
  if (stake === "max") {
    const balance = services.wallet.getBalance(table.guildId, userId);
    amount = Math.min(R.maxBet, balance, R.maxTotalBetPerRound - userTotal);
    if (amount < R.minBet) {
      return `Can't go all in — you need at least ${formatChips(R.minBet)} of headroom (balance or round limit).`;
    }
  }
  if (userTotal + amount > R.maxTotalBetPerRound) {
    return `Your bets this round can't exceed ${formatChips(R.maxTotalBetPerRound)}.`;
  }
  try {
    services.wallet.placeBet({
      guildId: table.guildId,
      userId,
      amount,
      game: "roulette",
      ref: table.roundId,
      channelId: table.channelId,
      messageId: table.message?.id,
      meta: { kind: def.kind, numbers: def.numbers },
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return "You don't have enough chips for that bet.";
    throw err;
  }
  userBets.push({ ...def, amount });
  table.bets.set(userId, userBets);
  return null;
}

// --- component handler ------------------------------------------------------

export const rouletteComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    servicesRef ??= services;
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];
    const channelId = parts[1] ?? "";
    const table = tables.get(channelId);

    if (!table) {
      if (interaction.isRepliable())
        await interaction.reply({ content: "This roulette table is no longer active.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.isStringSelectMenu() && action === "select") {
      const betId = interaction.values[0]!;
      const isInside = betId === "inside";
      const balance = services.wallet.getBalance(table.guildId, interaction.user.id);
      const modal = new ModalBuilder()
        .setCustomId(cid(PREFIX, "modal", channelId, betId))
        .setTitle(isInside ? "Number bet" : "Set bet amount");
      if (isInside) {
        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("numbers")
              .setLabel("Numbers (0-36, comma-separated)")
              .setPlaceholder("e.g. 17  •  1,2  •  4,5,6")
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      }
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("amount")
            .setLabel(`Bet amount — balance ${formatNumber(balance)}`)
            .setPlaceholder(`min ${R.minBet} • max ${R.maxBet} • or "all in"`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true),
        ),
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && action === "modal") {
      const betId = parts[2] ?? "";
      const rawAmount = interaction.fields.getTextInputValue("amount").trim();
      // "all in" / "max" stakes the most this player is allowed to (resolved inside the lock).
      const wantsMax = /^(all[\s-]?in|all|max)$/i.test(rawAmount);
      const typedAmount = Number.parseInt(rawAmount, 10);
      if (!wantsMax && (!Number.isInteger(typedAmount) || typedAmount < R.minBet || typedAmount > R.maxBet)) {
        await interaction.reply({ content: `Amount must be between ${R.minBet} and ${R.maxBet}, or "all in".`, flags: MessageFlags.Ephemeral });
        return;
      }

      let def: BetDef | null;
      if (betId === "inside") {
        const numbers = interaction.fields
          .getTextInputValue("numbers")
          .split(/[^0-9]+/)
          .filter((s) => s.length > 0)
          .map((s) => Number.parseInt(s, 10));
        def = resolveInsideBet(numbers);
        if (!def) {
          await interaction.reply({ content: "Invalid number bet (must be a valid straight/split/street/corner/six-line).", flags: MessageFlags.Ephemeral });
          return;
        }
      } else {
        const factory = OUTSIDE_BETS[betId];
        def = factory ? factory() : null;
        if (!def) {
          await interaction.reply({ content: "Unknown bet type.", flags: MessageFlags.Ephemeral });
          return;
        }
      }

      await services.locks.run(`rlt:${table.channelId}`, async () => {
        if (table.spinning) {
          await interaction.reply({ content: "The wheel is spinning — try again in a moment.", flags: MessageFlags.Ephemeral });
          return;
        }
        const err = tryPlaceBet(table, services, interaction.user.id, def!, wantsMax ? "max" : typedAmount);
        if (err) {
          await interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
          return;
        }
        // No ephemeral confirmation — the bet now shows in the table's "Bets this round" list.
        if (interaction.isFromMessage()) {
          await interaction.update({ embeds: [tableEmbed(table)], components: tableComponents(table) });
        } else {
          // Unreachable in practice (the modal always opens from the table message); just ack.
          await interaction.reply({ content: "Bet placed.", flags: MessageFlags.Ephemeral });
          refreshMessage(table);
        }
      });
      return;
    }

    if (interaction.isButton() && action === "allin") {
      const def = OUTSIDE_BETS[parts[2] ?? ""]?.();
      if (!def) {
        await interaction.reply({ content: "Unknown bet.", flags: MessageFlags.Ephemeral });
        return;
      }
      await services.locks.run(`rlt:${table.channelId}`, async () => {
        if (table.spinning) {
          await interaction.reply({ content: "The wheel is spinning — try again in a moment.", flags: MessageFlags.Ephemeral });
          return;
        }
        const err = tryPlaceBet(table, services, interaction.user.id, def, "max");
        if (err) {
          await interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
          return;
        }
        await interaction.update({ embeds: [tableEmbed(table)], components: tableComponents(table) });
      });
      return;
    }
  },
};

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
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Command, ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import {
  comeOutOutcome,
  CRAPS_BET_LABELS,
  type CrapsBetKind,
  fieldReturn,
  lineReturn,
  pointOutcome,
  type RoundResult,
  rollPair,
} from "./engine/craps.ts";
import { renderDice } from "../ui/dice.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatNumber, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { intBetween } from "./engine/rng.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "crp";
const C = config.games.craps;

type Phase = "betting" | "rolling" | "cooldown";

interface PlacedCrapsBet {
  kind: CrapsBetKind;
  amount: number;
  allIn?: boolean;
}

/** A persistent, always-on craps table installed on one channel. */
interface LiveCrapsTable {
  guildId: string;
  channelId: string;
  message?: Message;
  roundId: string;
  roundStartedAt: number;
  bettingEndsAt: number;
  bets: Map<string, PlacedCrapsBet[]>;
  history: string[];
  point: number | null;
  phase: Phase;
  /** Set when the table is torn down so an in-flight round bails out of its loop. */
  closed?: boolean;
  /** Net winners of the most recent round that had bets, sorted high→low. */
  lastWinners?: { userId: string; net: number }[];
  repostTimer?: ReturnType<typeof setTimeout>;
  rollTimer?: ReturnType<typeof setTimeout>;
}

const tables = new Map<string, LiveCrapsTable>();
let servicesRef: Services;

const randFace = (): number => intBetween(1, 6);

// --- rendering --------------------------------------------------------------

function winnersField(winners: { userId: string; net: number }[]): string {
  if (winners.length === 0) return "No winners — the house took the round. 🏦";
  const medals = ["🥇", "🥈", "🥉"];
  return winners
    .slice(0, 10)
    .map((w, i) => `${medals[i] ?? "🏆"} <@${w.userId}> ${formatSigned(w.net)}`)
    .join("\n")
    .slice(0, 1024);
}

function betsField(table: LiveCrapsTable): string {
  const bettors = [...table.bets.entries()];
  if (!bettors.length) return "_Place your bets!_";
  return bettors
    .map(([uid, bets]) => {
      const total = bets.reduce((s, x) => s + x.amount, 0);
      const list = bets.map((b) => ` • ${CRAPS_BET_LABELS[b.kind]} — ${formatChips(b.amount)}`).join("\n");
      return `<@${uid}> — ${formatChips(total)}\n${list}`;
    })
    .join("\n")
    .slice(0, 1024);
}

/** The betting-window panel (with the bet buttons). */
function tableEmbed(table: LiveCrapsTable): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setTitle("🎲 Craps — table")
    .setDescription(
      "Bet the **Pass Line** or **Don't Pass** for the whole round, or the **Field** on the come-out roll.",
    )
    .addFields(
      { name: "Come-out roll", value: `<t:${Math.floor(table.bettingEndsAt / 1000)}:R>`, inline: true },
      { name: "Recent", value: table.history.length ? table.history.join("  ") : "—", inline: true },
    );
  if (table.lastWinners) embed.addFields({ name: "🏆 Last round", value: winnersField(table.lastWinners) });
  return embed
    .addFields({ name: "Bets this round", value: betsField(table) })
    .setFooter({
      text: `Pass/Don't 1:1 • Field: 3,4,9,10,11 pay 1:1, 2 pays 2:1, 12 pays 3:1 • Min ${C.minBet} • Max ${C.maxBet}/bet`,
    });
}

function betButtons(table: LiveCrapsTable): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid(PREFIX, "bet", table.channelId, "pass")).setLabel("Pass Line").setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(cid(PREFIX, "bet", table.channelId, "dontpass"))
        .setLabel("Don't Pass")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(cid(PREFIX, "bet", table.channelId, "field")).setLabel("Field").setStyle(ButtonStyle.Primary),
    ),
  ];
}

/** A single roll being shown — tumbling (revealed=false) or the landed dice (revealed=true). */
function rollingEmbed(table: LiveCrapsTable, d1: number, d2: number, title: string, revealed: boolean): EmbedBuilder {
  const lines = [`# ${renderDice([d1, d2])}${revealed ? `  =  **${d1 + d2}**` : ""}`];
  if (table.point !== null) lines.push(`🎯 Point: **${table.point}**`);
  return new EmbedBuilder().setColor(Colors.warn).setTitle(`🎲 ${title}`).setDescription(lines.join("\n"));
}

function resultEmbed(table: LiveCrapsTable, label: string, d1: number, d2: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.win)
    .setTitle("🎲 Craps — round over")
    .setDescription(`# ${renderDice([d1, d2])}  =  **${d1 + d2}**\n${label}`)
    .addFields({ name: "🏆 Winners", value: winnersField(table.lastWinners ?? []) });
}

function refreshMessage(table: LiveCrapsTable): void {
  void table.message?.edit({ embeds: [tableEmbed(table)], components: betButtons(table) }).catch(() => {});
}

// --- the round --------------------------------------------------------------

/** Short history-strip label for a resolved round, from the table's perspective. */
function roundLabel(result: RoundResult, comeOutSum: number, point: number | null): string {
  if (point === null) {
    if (result.type === "pass") return `${comeOutSum}✓`;
    if (result.type === "dontpass") return `${comeOutSum}✗`;
    return "12·bar";
  }
  return result.type === "pass" ? `${point}✓` : "7out";
}

function pushHistory(table: LiveCrapsTable, label: string): void {
  table.history.unshift(label);
  if (table.history.length > C.historyLength) table.history.pop();
}

/** Resolve a whole round silently (no animation, no payouts) and return its history label. */
function silentRoundLabel(): string {
  const [c1, c2] = rollPair();
  const comeOutSum = c1 + c2;
  let result = comeOutOutcome(comeOutSum);
  let point: number | null = null;
  if (result.type === "point") {
    point = result.point;
    for (;;) {
      const [d1, d2] = rollPair();
      const r = pointOutcome(d1 + d2, point);
      if (r) {
        result = r;
        break;
      }
    }
  }
  return roundLabel(result, comeOutSum, point);
}

/** Tumble the dice on the message, then reveal the real pair. Runs without the table lock. */
async function animateRoll(table: LiveCrapsTable, d1: number, d2: number, title: string): Promise<void> {
  if (!table.message) return;
  for (let f = 0; f < 4; f++) {
    await table.message.edit({ embeds: [rollingEmbed(table, randFace(), randFace(), title, false)], components: [] }).catch(() => {});
    await sleep(220);
  }
  await table.message.edit({ embeds: [rollingEmbed(table, d1, d2, title, true)], components: [] }).catch(() => {});
  await sleep(700);
}

/** Pay out every bet against the resolved round and record stats. Caller holds the lock. */
function settle(table: LiveCrapsTable, services: Services, result: RoundResult, comeOutSum: number, label: string): void {
  const winners: { userId: string; net: number }[] = [];
  for (const [userId, bets] of table.bets) {
    const staked = bets.reduce((s, b) => s + b.amount, 0);
    let returned = 0;
    for (const b of bets) {
      returned += b.kind === "field" ? fieldReturn(b.amount, comeOutSum) : lineReturn(b.kind, b.amount, result);
    }
    if (returned > 0) {
      services.wallet.applyDelta({
        guildId: table.guildId,
        userId,
        delta: returned,
        type: "payout",
        game: "craps",
        ref: table.roundId,
      });
    }
    const net = returned - staked;
    if (net > 0) winners.push({ userId, net });
    services.rounds.record({
      game: "craps",
      guildId: table.guildId,
      userId,
      wager: staked,
      payout: returned,
      outcome: net > 0 ? "win" : net < 0 ? "loss" : "push",
      details: { result: result.type, comeOutSum, point: table.point },
      startedAt: table.roundStartedAt,
    });
  }
  services.wallet.closeGame(table.roundId);

  winners.sort((a, b) => b.net - a.net);
  table.lastWinners = winners;
  pushHistory(table, label);
}

/** Reset to a fresh betting window and re-arm the timers. Caller holds the lock. */
function openNextRound(table: LiveCrapsTable, services: Services): void {
  if (table.closed) return;
  Object.assign(table, newRound());
  refreshMessage(table);
  scheduleBetting(table, services);
}

/**
 * Run one full round: come-out roll, then (if a point is set) keep rolling until the
 * point or a seven-out. The betting→rolling and settle transitions take the channel
 * lock briefly; the rolls and animation in between run without it, so a player's bet
 * click during a roll is rejected fast (phase !== "betting") instead of blocking past
 * Discord's interaction ack window.
 */
async function runRound(table: LiveCrapsTable, services: Services): Promise<void> {
  let proceed = false;
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    if (table.closed || table.phase !== "betting") return;
    if (table.bets.size === 0) {
      // Nobody bet — still roll a silent result for the Recent strip (like roulette's/crash's
      // empty rounds), skipping the animation, then reopen betting. lastWinners is left intact
      // so the panel keeps the last real round's winners through idle rounds.
      pushHistory(table, silentRoundLabel());
      openNextRound(table, services);
      return;
    }
    table.phase = "rolling";
    proceed = true;
  });
  if (!proceed) return;

  const [c1, c2] = rollPair();
  await animateRoll(table, c1, c2, "Come-out roll");
  if (table.closed) return;
  const comeOutSum = c1 + c2;
  let result = comeOutOutcome(comeOutSum);
  let lastD1 = c1;
  let lastD2 = c2;

  if (result.type === "point") {
    table.point = result.point;
    for (;;) {
      await sleep(C.rollIntervalSeconds * 1000);
      if (table.closed) return;
      const [d1, d2] = rollPair();
      await animateRoll(table, d1, d2, `Chasing the point (${table.point})`);
      if (table.closed) return;
      lastD1 = d1;
      lastD2 = d2;
      const r = pointOutcome(d1 + d2, table.point);
      if (r) {
        result = r;
        break;
      }
    }
  }

  const label = roundLabel(result, comeOutSum, table.point);
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    if (table.closed) return;
    settle(table, services, result, comeOutSum, label);
    table.phase = "cooldown";
  });
  if (table.closed) return;

  void table.message?.edit({ embeds: [resultEmbed(table, label, lastD1, lastD2)], components: [] }).catch(() => {});
  await sleep(C.cooldownSeconds * 1000);
  if (table.closed) return;
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    openNextRound(table, services);
  });
}

function clearTimers(table: LiveCrapsTable): void {
  if (table.repostTimer) clearTimeout(table.repostTimer);
  if (table.rollTimer) clearTimeout(table.rollTimer);
}

/** Arm the betting window: optional repost nudge, then the come-out roll. */
function scheduleBetting(table: LiveCrapsTable, services: Services): void {
  clearTimers(table);
  const interval = C.bettingSeconds * 1000;
  const lead = Math.min(C.repostLeadSeconds, C.bettingSeconds - 1) * 1000;

  table.repostTimer = setTimeout(() => {
    void services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
      if (table.phase === "betting" && table.bets.size === 0 && (await isBuried(table))) await repost(table, services);
    });
  }, interval - lead);

  table.rollTimer = setTimeout(() => {
    void runRound(table, services);
  }, interval);

  if ("unref" in table.repostTimer) table.repostTimer.unref();
  if ("unref" in table.rollTimer) table.rollTimer.unref();
}

/** True if newer messages have pushed the table message off the bottom of the channel. */
async function isBuried(table: LiveCrapsTable): Promise<boolean> {
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
async function repost(table: LiveCrapsTable, services: Services): Promise<void> {
  const channel = table.message?.channel;
  if (!channel?.isSendable()) return;
  const old = table.message;
  try {
    table.message = await channel.send({ embeds: [tableEmbed(table)], components: betButtons(table) });
    saveTable(services, { channelId: table.channelId, guildId: table.guildId, messageId: table.message.id, createdBy: "system" });
    await old?.delete().catch(() => {});
  } catch {
    table.message = old;
  }
}

function refundRound(table: LiveCrapsTable, services: Services): void {
  for (const [userId, bets] of table.bets) {
    const total = bets.reduce((s, b) => s + b.amount, 0);
    if (total > 0) {
      services.wallet.applyDelta({
        guildId: table.guildId,
        userId,
        delta: total,
        type: "payout",
        game: "craps",
        ref: table.roundId,
        meta: { refund: true },
      });
    }
  }
  services.wallet.closeGame(table.roundId);
  table.bets.clear();
}

function newRound(): Pick<LiveCrapsTable, "roundId" | "roundStartedAt" | "bettingEndsAt" | "bets" | "point" | "phase"> {
  return {
    roundId: newId(),
    roundStartedAt: Date.now(),
    bettingEndsAt: Date.now() + C.bettingSeconds * 1000,
    bets: new Map(),
    point: null,
    phase: "betting",
  };
}

// --- DB persistence ---------------------------------------------------------

function saveTable(services: Services, t: { channelId: string; guildId: string; messageId: string; createdBy: string }): void {
  services.db
    .query(
      `INSERT INTO craps_tables (channel_id, guild_id, message_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET message_id = excluded.message_id, created_by = excluded.created_by`,
    )
    .run(t.channelId, t.guildId, t.messageId, t.createdBy, Date.now());
}

function deleteTableRow(services: Services, channelId: string): void {
  services.db.query("DELETE FROM craps_tables WHERE channel_id = ?").run(channelId);
}

/** Re-attach persisted tables after a restart and resume the round loop. In-flight bets
 *  at restart are refunded by the wallet's refundOpenGames() before this runs. */
export async function resumeCrapsTables(services: Services, client: Client): Promise<void> {
  servicesRef ??= services;
  const rows = services.db
    .query("SELECT channel_id, guild_id, message_id FROM craps_tables")
    .all() as { channel_id: string; guild_id: string; message_id: string }[];

  for (const row of rows) {
    const table: LiveCrapsTable = {
      guildId: row.guild_id,
      channelId: row.channel_id,
      history: [],
      ...newRound(),
    };
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (channel?.isTextBased()) {
        table.message = await channel.messages.fetch(row.message_id).catch(() => undefined);
        if (!table.message && "send" in channel) {
          table.message = await channel.send({ embeds: [tableEmbed(table)], components: betButtons(table) });
          saveTable(services, { channelId: row.channel_id, guildId: row.guild_id, messageId: table.message.id, createdBy: "system" });
        }
      }
    } catch {
      /* channel gone — keep the table logical, admin can re-setup */
    }
    tables.set(table.channelId, table);
    refreshMessage(table);
    scheduleBetting(table, services);
  }
  if (rows.length) services.logger.info({ count: rows.length }, "craps: resumed persistent tables");
}

// --- commands ---------------------------------------------------------------

function isAdmin(interaction: { memberPermissions: { has(p: bigint): boolean } | null }): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function setupTable(interaction: ChatInputCommandInteraction<"cached">, services: Services): Promise<void> {
  const existing = tables.get(interaction.channelId);
  if (existing) {
    existing.closed = true;
    refundRound(existing, services);
    clearTimers(existing);
  }

  const table: LiveCrapsTable = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    history: existing?.history ?? [],
    ...newRound(),
  };

  await interaction.reply({ embeds: [tableEmbed(table)], components: betButtons(table) });
  table.message = await interaction.fetchReply();
  tables.set(table.channelId, table);
  saveTable(services, { channelId: table.channelId, guildId: table.guildId, messageId: table.message.id, createdBy: interaction.user.id });
  scheduleBetting(table, services);
}

async function stopTable(interaction: ChatInputCommandInteraction<"cached">, services: Services): Promise<void> {
  const table = tables.get(interaction.channelId);
  if (!table) {
    await interaction.reply({ content: "There's no craps table on this channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    table.closed = true;
    refundRound(table, services);
    clearTimers(table);
    tables.delete(table.channelId);
    deleteTableRow(services, table.channelId);
    await table.message
      ?.edit({
        embeds: [new EmbedBuilder().setColor(Colors.push).setTitle("🎲 Craps — closed").setDescription("This table is closed.")],
        components: [],
      })
      .catch(() => {});
    await interaction.reply({ content: "Craps table closed. Open bets were refunded.", flags: MessageFlags.Ephemeral });
  });
}

export const adminCrapsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("admin-craps")
    .setDescription("Manage the persistent craps table on this channel (admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((s) => s.setName("setup").setDescription("Install or refresh the table on this channel"))
    .addSubcommand((s) => s.setName("stop").setDescription("Stop and remove the table on this channel")),

  async execute(interaction, services) {
    servicesRef ??= services;
    if (!isAdmin(interaction)) {
      await interaction.reply({ content: "Only server admins can manage the craps table.", flags: MessageFlags.Ephemeral });
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
 * Place one bet for a player. Caller holds the table lock and has checked the phase.
 * `stake` of "max" resolves to the most allowed now (per-bet max, balance, per-round
 * allowance). Returns an ephemeral error string, or null on success.
 */
function tryPlaceBet(table: LiveCrapsTable, services: Services, userId: string, kind: CrapsBetKind, stake: number | "max"): string | null {
  const userBets = table.bets.get(userId) ?? [];
  const userTotal = userBets.reduce((s, b) => s + b.amount, 0);

  let amount = stake === "max" ? 0 : stake;
  if (stake === "max") {
    const balance = services.wallet.getBalance(table.guildId, userId);
    amount = Math.min(C.maxBet, balance, C.maxTotalBetPerRound - userTotal);
    if (amount < C.minBet) {
      return `Can't go all in — you need at least ${formatChips(C.minBet)} of headroom (balance or round limit).`;
    }
  }
  if (userTotal + amount > C.maxTotalBetPerRound) {
    return `Your bets this round can't exceed ${formatChips(C.maxTotalBetPerRound)}.`;
  }
  try {
    services.wallet.placeBet({
      guildId: table.guildId,
      userId,
      amount,
      game: "craps",
      ref: table.roundId,
      channelId: table.channelId,
      messageId: table.message?.id,
      meta: { kind },
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) return "You don't have enough chips for that bet.";
    throw err;
  }
  userBets.push({ kind, amount, allIn: stake === "max" });
  table.bets.set(userId, userBets);
  return null;
}

// --- component handler ------------------------------------------------------

export const crapsComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    servicesRef ??= services;
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];
    const channelId = parts[1] ?? "";
    const table = tables.get(channelId);

    if (!table) {
      if (interaction.isRepliable())
        await interaction.reply({ content: "This craps table is no longer active.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.isButton() && action === "bet") {
      const kind = parts[2] as CrapsBetKind;
      if (!(kind in CRAPS_BET_LABELS)) {
        await interaction.reply({ content: "Unknown bet.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (table.phase !== "betting") {
        await interaction.reply({ content: "Betting is closed — the dice are rolling.", flags: MessageFlags.Ephemeral });
        return;
      }
      const balance = services.wallet.getBalance(table.guildId, interaction.user.id);
      const modal = new ModalBuilder()
        .setCustomId(cid(PREFIX, "modal", channelId, kind))
        .setTitle(`${CRAPS_BET_LABELS[kind]} — set amount`)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("amount")
              .setLabel(`Bet amount — balance ${formatNumber(balance)}`)
              .setPlaceholder(`min ${C.minBet} • max ${C.maxBet} • or "all in"`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && action === "modal") {
      const kind = parts[2] as CrapsBetKind;
      if (!(kind in CRAPS_BET_LABELS)) {
        await interaction.reply({ content: "Unknown bet.", flags: MessageFlags.Ephemeral });
        return;
      }
      const rawAmount = interaction.fields.getTextInputValue("amount").trim();
      const wantsMax = /^(all[\s-]?in|all|max)$/i.test(rawAmount);
      const typedAmount = Number.parseInt(rawAmount, 10);
      if (!wantsMax && (!Number.isInteger(typedAmount) || typedAmount < C.minBet || typedAmount > C.maxBet)) {
        await interaction.reply({ content: `Amount must be between ${C.minBet} and ${C.maxBet}, or "all in".`, flags: MessageFlags.Ephemeral });
        return;
      }

      await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
        if (table.phase !== "betting") {
          await interaction.reply({ content: "Betting is closed — the dice are rolling.", flags: MessageFlags.Ephemeral });
          return;
        }
        const err = tryPlaceBet(table, services, interaction.user.id, kind, wantsMax ? "max" : typedAmount);
        if (err) {
          await interaction.reply({ content: err, flags: MessageFlags.Ephemeral });
          return;
        }
        refreshMessage(table);
        await interaction.deferUpdate(); // the bet shows on the panel; ack silently (no extra message)
      });
      return;
    }
  },
};

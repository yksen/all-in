import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type Client,
  EmbedBuilder,
  type Message,
  MessageFlags,
  ModalBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { growthRate, multiplierAt, rollCrashPoint, timeToReach } from "./engine/crash.ts";
import { renderCurve, renderExplosion } from "../ui/crash.ts";
import { type BettorResult, resultsField } from "../ui/roundResults.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatNumber } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "crh";
const C = config.games.crash;
/** m(t) = e^(k·t); k chosen so the multiplier doubles every `doubleEverySeconds`. */
const k = growthRate(C.doubleEverySeconds);

type Phase = "betting" | "flying" | "crashed";

interface CrashBet {
  amount: number;
  /** Player used the "All in" button / max stake. */
  allIn?: boolean;
  /** Multiplier locked in, set when the player cashes out (undefined = still riding). */
  cashedOutAt?: number;
}

/** A persistent, always-on crash table installed on one channel. */
interface LiveCrashTable {
  guildId: string;
  channelId: string;
  message?: Message;
  phase: Phase;
  roundId: string;
  bets: Map<string, CrashBet>;
  /** When the current betting window closes (epoch ms). */
  bettingEndsAt: number;
  /** When the current flight started (epoch ms). */
  flightStartedAt: number;
  crashPoint: number;
  /** Recent crash multipliers, newest first. */
  history: number[];
  /** Every bettor's net + resulting balance from the most recent round that had bets,
   *  sorted net high→low. */
  lastResults?: BettorResult[];
  /** Set on stop/re-setup so the in-flight loop bails instead of settling. */
  closed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const tables = new Map<string, LiveCrashTable>();

const lockKey = (table: LiveCrashTable): string => `crash:${table.channelId}`;
const currentMultiplier = (table: LiveCrashTable): number =>
  multiplierAt(k, (Date.now() - table.flightStartedAt) / 1000);

// --- rendering --------------------------------------------------------------

function crashHistory(history: number[]): string {
  if (history.length === 0) return "_no flights yet_";
  return history.map((m) => `${m >= 10 ? "🔥" : m >= 2 ? "🚀" : "💥"}${m.toFixed(2)}x`).join("  ");
}

function bettingEmbed(table: LiveCrashTable): EmbedBuilder {
  const bettors = [...table.bets.entries()];
  const list = bettors.length
    ? bettors
        .map(([uid, b]) => `• <@${uid}> — ${formatChips(b.amount)}`)
        .join("\n")
        .slice(0, 1024)
    : "_Place your bets!_";
  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setTitle("🚀 Crash — place your bets")
    .setDescription(
      `Next flight: <t:${Math.floor(table.bettingEndsAt / 1000)}:R>\n` +
        "Cash out before it crashes — the higher the multiplier climbs, the bigger your payout.",
    )
    .addFields(
      { name: "Bets this round", value: list },
      { name: "Recent crashes", value: crashHistory(table.history) },
    );
  if (table.lastResults) embed.addFields({ name: "💰 Last round", value: resultsField(table.lastResults) });
  return embed.setFooter({ text: `Min ${C.minBet} • Max ${C.maxBet} • one bet per round` });
}

function flyingEmbed(table: LiveCrashTable, mult: number, frame = 0): EmbedBuilder {
  const elapsed = (Date.now() - table.flightStartedAt) / 1000;
  const entries = [...table.bets.entries()];
  const riding = entries.filter(([, b]) => b.cashedOutAt == null);
  const cashed = entries.filter(([, b]) => b.cashedOutAt != null);
  const ridingText = riding.length
    ? riding
        .map(([uid, b]) => `• <@${uid}> ${formatChips(b.amount)} → **${formatChips(Math.floor(b.amount * mult))}**`)
        .join("\n")
        .slice(0, 1024)
    : "_everyone cashed out_";

  const embed = new EmbedBuilder()
    .setColor(Colors.warn)
    .setTitle("🚀 Crash — in flight! No more bets.")
    .setDescription(`${renderCurve(mult, k, elapsed, frame)}\n📈 **${mult.toFixed(2)}x** · ${elapsed.toFixed(0)}s\n💸 Cash out before it crashes!`)
    .addFields({ name: "Still flying", value: ridingText });
  if (cashed.length) {
    embed.addFields({
      name: "✅ Cashed out",
      value: cashed
        .map(([uid, b]) => `<@${uid}> @${b.cashedOutAt!.toFixed(2)}x +${formatChips(Math.floor(b.amount * b.cashedOutAt!))}`)
        .join("\n")
        .slice(0, 1024),
    });
  }
  return embed;
}

function crashedEmbed(table: LiveCrashTable): EmbedBuilder {
  const crashMs = timeToReach(k, table.crashPoint) * 1000;
  return new EmbedBuilder()
    .setColor(Colors.loss)
    .setTitle(`💥 Crashed at ${table.crashPoint.toFixed(2)}x`)
    .setDescription(`${renderCurve(table.crashPoint, k, crashMs / 1000)}\n💥 **${table.crashPoint.toFixed(2)}x**`)
    .addFields(
      { name: "💰 Results", value: resultsField(table.lastResults ?? []) },
      { name: "Recent crashes", value: crashHistory(table.history) },
    );
}

/** One frame (0→2) of the crash explosion burst — purely cosmetic, money is already settled. */
function explosionEmbed(table: LiveCrashTable, frame: number): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.loss)
    .setTitle(`💥 BOOM — crashed at ${table.crashPoint.toFixed(2)}x`)
    .setDescription(`${renderExplosion(frame)}\n💥 **${table.crashPoint.toFixed(2)}x**`);
}

function bettingComponents(table: LiveCrashTable): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid(PREFIX, "bet", table.channelId)).setLabel("Place bet").setEmoji("🎰").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cid(PREFIX, "allin", table.channelId)).setLabel("All in").setStyle(ButtonStyle.Danger),
    ),
  ];
}

function cashOutRow(table: LiveCrashTable): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid(PREFIX, "cashout", table.channelId)).setLabel("Cash Out").setEmoji("💸").setStyle(ButtonStyle.Success),
  );
}

function refreshMessage(table: LiveCrashTable): void {
  const embed =
    table.phase === "betting" ? bettingEmbed(table) : table.phase === "crashed" ? crashedEmbed(table) : flyingEmbed(table, currentMultiplier(table));
  const components = table.phase === "betting" ? bettingComponents(table) : table.phase === "flying" ? [cashOutRow(table)] : [];
  void table.message?.edit({ embeds: [embed], components }).catch(() => {});
}

// --- round lifecycle --------------------------------------------------------

function openBetting(table: LiveCrashTable): void {
  table.phase = "betting";
  table.roundId = newId();
  table.bets = new Map();
  table.bettingEndsAt = Date.now() + C.bettingSeconds * 1000;
  table.crashPoint = 0;
}

/** Add a crash result to the history strip (newest first), capped. */
function recordCrash(table: LiveCrashTable, crashPoint: number): void {
  table.history.unshift(crashPoint);
  if (table.history.length > 12) table.history.pop();
}

function settleCrash(table: LiveCrashTable, services: Services): void {
  const results: BettorResult[] = [];
  for (const [userId, bet] of table.bets) {
    if (bet.cashedOutAt != null) {
      // Winners were already paid + recorded at cash-out time — just report their net.
      const payout = Math.floor(bet.amount * bet.cashedOutAt);
      results.push({ userId, net: payout - bet.amount, balance: services.wallet.getBalance(table.guildId, userId) });
      continue;
    }
    services.rounds.record({
      game: "crash",
      guildId: table.guildId,
      userId,
      wager: bet.amount,
      payout: 0,
      outcome: "loss",
      details: { crashPoint: table.crashPoint, allIn: bet.allIn },
      startedAt: table.flightStartedAt,
    });
    results.push({ userId, net: -bet.amount, balance: services.wallet.getBalance(table.guildId, userId) });
  }
  services.wallet.closeGame(table.roundId); // drop the losers' escrow rows — the house keeps the chips
  results.sort((a, b) => b.net - a.net);
  table.lastResults = results;
  recordCrash(table, table.crashPoint);
}

function scheduleNext(table: LiveCrashTable, services: Services, delayMs: number): void {
  if (table.closed) return;
  table.timer = setTimeout(() => void runRound(table, services), delayMs);
  if (table.timer && typeof table.timer === "object" && "unref" in table.timer) table.timer.unref();
}

function clearTimer(table: LiveCrashTable): void {
  if (table.timer) clearTimeout(table.timer);
}

/** True if newer messages have pushed the table message off the bottom of the channel. */
async function isBuried(table: LiveCrashTable): Promise<boolean> {
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
async function repost(table: LiveCrashTable, services: Services): Promise<void> {
  const channel = table.message?.channel;
  if (!channel?.isSendable()) return;
  const old = table.message;
  try {
    table.message = await channel.send({ embeds: [bettingEmbed(table)], components: bettingComponents(table) });
    saveTable(services, { channelId: table.channelId, guildId: table.guildId, messageId: table.message.id, createdBy: "system" });
    await old?.delete().catch(() => {});
  } catch {
    table.message = old; // keep the old reference if reposting failed
  }
}

/**
 * Run one round: wait out the (already-open) betting window, fly the multiplier until
 * it crashes, settle, hold the result, then open the next betting window and reschedule.
 * `table.closed` short-circuits every phase so a stop/re-setup never settles a dead table.
 */
async function runRound(table: LiveCrashTable, services: Services): Promise<void> {
  if (table.closed) return;

  // Betting window. Shortly before it closes, bump the panel to the bottom of the channel
  // if nobody has bet yet and it's been buried under newer chat (mirrors roulette).
  const lead = Math.min(C.repostLeadSeconds, C.bettingSeconds - 1) * 1000;
  await sleep(Math.max(0, table.bettingEndsAt - lead - Date.now()));
  if (table.closed) return;
  await services.locks.run(lockKey(table), async () => {
    if (table.phase === "betting" && table.bets.size === 0 && (await isBuried(table))) await repost(table, services);
  });
  await sleep(Math.max(0, table.bettingEndsAt - Date.now()));
  if (table.closed) return;

  // Freeze betting and decide the crash point (only if anyone actually bet).
  let hasBets = false;
  await services.locks.run(lockKey(table), () => {
    hasBets = table.bets.size > 0;
    if (hasBets) {
      table.phase = "flying";
      table.crashPoint = rollCrashPoint(C.houseEdge, C.maxMultiplier);
      table.flightStartedAt = Date.now();
    }
  });

  if (!hasBets) {
    // Nobody bet — still roll a result for the history strip (like roulette's silent
    // empty spin), just skip the per-second flight animation, then reopen betting.
    recordCrash(table, rollCrashPoint(C.houseEdge, C.maxMultiplier));
    openBetting(table);
    refreshMessage(table);
    scheduleNext(table, services, 0);
    return;
  }

  // Flight: edit the message every refreshMs until the real elapsed time hits the crash.
  const crashMs = timeToReach(k, table.crashPoint) * 1000;
  let frame = 0;
  while (!table.closed) {
    const elapsed = Date.now() - table.flightStartedAt;
    if (elapsed >= crashMs) break;
    const mult = multiplierAt(k, elapsed / 1000);
    void table.message?.edit({ embeds: [flyingEmbed(table, mult, frame)], components: [cashOutRow(table)] }).catch(() => {});
    frame++;
    await sleep(C.refreshMs);
  }
  if (table.closed) return;

  await services.locks.run(lockKey(table), () => {
    if (table.closed || table.phase !== "flying") return; // a stop/cash-all raced us — don't double-settle
    table.phase = "crashed";
    settleCrash(table, services);
  });
  if (table.closed) return;

  // Explosion burst (cosmetic — settlement already happened above). A short 3-frame
  // animation centred on the crash, then the static result card.
  for (let f = 0; f < 3; f++) {
    void table.message?.edit({ embeds: [explosionEmbed(table, f)], components: [] }).catch(() => {});
    await sleep(450);
    if (table.closed) return;
  }
  void table.message?.edit({ embeds: [crashedEmbed(table)], components: [] }).catch(() => {});

  await sleep(C.cooldownSeconds * 1000);
  if (table.closed) return;
  openBetting(table);
  refreshMessage(table);
  scheduleNext(table, services, 0);
}

/** Refund every still-open bet of the current round (used on stop / re-setup). */
function refundRound(table: LiveCrashTable, services: Services): void {
  // Only betting/flying rounds have open escrow; a crashed round is already settled.
  if (table.phase === "betting" || table.phase === "flying") {
    for (const [userId, bet] of table.bets) {
      if (bet.cashedOutAt != null) continue; // already settled at cash-out
      if (bet.amount > 0) {
        services.wallet.applyDelta({
          guildId: table.guildId,
          userId,
          delta: bet.amount,
          type: "payout",
          game: "crash",
          ref: table.roundId,
          meta: { refund: true },
        });
      }
    }
    services.wallet.closeGame(table.roundId);
  }
  table.bets = new Map();
}

// --- DB persistence (mirrors roulette_tables) -------------------------------

function saveTable(services: Services, t: { channelId: string; guildId: string; messageId: string; createdBy: string }): void {
  services.db
    .query(
      `INSERT INTO crash_tables (channel_id, guild_id, message_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET message_id = excluded.message_id, created_by = excluded.created_by`,
    )
    .run(t.channelId, t.guildId, t.messageId, t.createdBy, Date.now());
}

function deleteTableRow(services: Services, channelId: string): void {
  services.db.query("DELETE FROM crash_tables WHERE channel_id = ?").run(channelId);
}

/** Re-attach persisted tables after a restart and resume the round loop. */
export async function resumeCrashTables(services: Services, client: Client): Promise<void> {
  const rows = services.db
    .query("SELECT channel_id, guild_id, message_id FROM crash_tables")
    .all() as { channel_id: string; guild_id: string; message_id: string }[];

  for (const row of rows) {
    const table: LiveCrashTable = {
      guildId: row.guild_id,
      channelId: row.channel_id,
      phase: "betting",
      roundId: newId(),
      bets: new Map(),
      bettingEndsAt: 0,
      flightStartedAt: 0,
      crashPoint: 0,
      history: [],
      closed: false,
    };
    openBetting(table);
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (channel?.isTextBased()) {
        table.message = await channel.messages.fetch(row.message_id).catch(() => undefined);
        if (!table.message && "send" in channel) {
          table.message = await channel.send({ embeds: [bettingEmbed(table)], components: bettingComponents(table) });
          saveTable(services, { channelId: row.channel_id, guildId: row.guild_id, messageId: table.message.id, createdBy: "system" });
        }
      }
    } catch {
      /* channel gone — keep the table logical, admin can re-setup */
    }
    tables.set(table.channelId, table);
    refreshMessage(table);
    scheduleNext(table, services, 0);
  }
  if (rows.length) services.logger.info({ count: rows.length }, "crash: resumed persistent tables");
}

// --- commands ---------------------------------------------------------------

export async function setupCrashTable(interaction: ChatInputCommandInteraction<"cached"> | StringSelectMenuInteraction<"cached">, services: Services): Promise<void> {
  const existing = tables.get(interaction.channelId);
  if (existing) {
    existing.closed = true;
    clearTimer(existing);
    await services.locks.run(lockKey(existing), () => refundRound(existing, services));
  }

  const table: LiveCrashTable = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    phase: "betting",
    roundId: newId(),
    bets: new Map(),
    bettingEndsAt: 0,
    flightStartedAt: 0,
    crashPoint: 0,
    history: existing?.history ?? [],
    closed: false,
  };
  openBetting(table);

  await interaction.reply({ embeds: [bettingEmbed(table)], components: bettingComponents(table) });
  table.message = await interaction.fetchReply();
  tables.set(table.channelId, table);
  saveTable(services, { channelId: table.channelId, guildId: table.guildId, messageId: table.message.id, createdBy: interaction.user.id });
  scheduleNext(table, services, 0);
}

export async function stopCrashTable(interaction: ChatInputCommandInteraction<"cached"> | StringSelectMenuInteraction<"cached">, services: Services): Promise<void> {
  const table = tables.get(interaction.channelId);
  if (!table) {
    await interaction.reply({ content: "There's no crash table on this channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  table.closed = true;
  clearTimer(table);
  await services.locks.run(lockKey(table), async () => {
    refundRound(table, services);
    tables.delete(table.channelId);
    deleteTableRow(services, table.channelId);
    await table.message
      ?.edit({
        embeds: [new EmbedBuilder().setColor(Colors.push).setTitle("🚀 Crash — closed").setDescription("This table is closed.")],
        components: [],
      })
      .catch(() => {});
    await interaction.reply({ content: "Crash table closed. Open bets were refunded.", flags: MessageFlags.Ephemeral });
  });
}


// --- placing bets / cashing out ---------------------------------------------

async function placeBet(
  interaction: ButtonInteraction<"cached"> | ModalSubmitInteraction<"cached">,
  table: LiveCrashTable,
  services: Services,
  stake: number | "max",
): Promise<void> {
  const userId = interaction.user.id;
  await services.locks.run(lockKey(table), async () => {
    if (table.phase !== "betting") {
      await interaction.reply({ content: "Betting is closed for this round — wait for the next one.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (table.bets.has(userId)) {
      await interaction.reply({ content: "You already have a bet this round.", flags: MessageFlags.Ephemeral });
      return;
    }

    const amount = stake === "max" ? Math.min(C.maxBet, services.wallet.getBalance(table.guildId, userId)) : stake;
    if (stake === "max" && amount < C.minBet) {
      await interaction.reply({ content: `You need at least ${formatChips(C.minBet)} to go all in.`, flags: MessageFlags.Ephemeral });
      return;
    }

    try {
      services.wallet.placeBet({
        guildId: table.guildId,
        userId,
        amount,
        game: "crash",
        ref: table.roundId,
        channelId: table.channelId,
        messageId: table.message?.id,
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await interaction.reply({ content: "You don't have enough chips for that bet.", flags: MessageFlags.Ephemeral });
        return;
      }
      throw err;
    }

    table.bets.set(userId, { amount, allIn: stake === "max" });
    refreshMessage(table);
    await interaction.deferUpdate(); // bet shows on the panel; just ack silently so Discord doesn't flag a failed interaction
  });
}

export const crashComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];
    const channelId = parts[1] ?? "";
    const table = tables.get(channelId);

    if (!table) {
      if (interaction.isRepliable()) await interaction.reply({ content: "This crash table is no longer active.", flags: MessageFlags.Ephemeral });
      return;
    }

    // Open the bet modal.
    if (interaction.isButton() && action === "bet") {
      const balance = services.wallet.getBalance(table.guildId, interaction.user.id);
      const modal = new ModalBuilder().setCustomId(cid(PREFIX, "betmodal", channelId)).setTitle("Place your crash bet");
      modal.addComponents(
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

    if (interaction.isModalSubmit() && action === "betmodal") {
      const raw = interaction.fields.getTextInputValue("amount").trim();
      const wantsMax = /^(all[\s-]?in|all|max)$/i.test(raw);
      const typed = Number.parseInt(raw, 10);
      if (!wantsMax && (!Number.isInteger(typed) || typed < C.minBet || typed > C.maxBet)) {
        await interaction.reply({ content: `Amount must be between ${C.minBet} and ${C.maxBet}, or "all in".`, flags: MessageFlags.Ephemeral });
        return;
      }
      await placeBet(interaction, table, services, wantsMax ? "max" : typed);
      return;
    }

    if (interaction.isButton() && action === "allin") {
      await placeBet(interaction, table, services, "max");
      return;
    }

    if (interaction.isButton() && action === "cashout") {
      await services.locks.run(lockKey(table), async () => {
        const bet = table.bets.get(interaction.user.id);
        if (table.phase !== "flying" || !bet) {
          await interaction.reply({ content: "Nothing to cash out right now.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (bet.cashedOutAt != null) {
          await interaction.reply({ content: "You already cashed out.", flags: MessageFlags.Ephemeral });
          return;
        }
        const mult = currentMultiplier(table);
        if (mult >= table.crashPoint) {
          await interaction.reply({ content: "Too late — it already crashed! 💥", flags: MessageFlags.Ephemeral });
          return;
        }

        const payoutMult = Math.floor(mult * 100) / 100; // what the player sees, floored to 2dp
        const payout = Math.floor(bet.amount * payoutMult);
        services.wallet.applyDelta({
          guildId: table.guildId,
          userId: interaction.user.id,
          delta: payout,
          type: "payout",
          game: "crash",
          ref: table.roundId,
          meta: { mult: payoutMult },
        });
        services.wallet.trackEscrow({ ref: table.roundId, userId: interaction.user.id, guildId: table.guildId, game: "crash", amount: 0 });
        bet.cashedOutAt = payoutMult;

        services.rounds.record({
          game: "crash",
          guildId: table.guildId,
          userId: interaction.user.id,
          wager: bet.amount,
          payout,
          outcome: "win",
          details: { cashedAt: payoutMult, crashPoint: table.crashPoint, allIn: bet.allIn },
          startedAt: table.flightStartedAt,
        });

        await interaction.deferUpdate(); // the cash-out shows on the panel; just ack silently
      });
      return;
    }
  },
};

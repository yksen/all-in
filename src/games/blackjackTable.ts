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
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { type Card, Shoe } from "./engine/deck.ts";
import { handTotal, isBlackjack, isBust } from "./engine/handvalue.ts";
import { canSplit, dealerShouldHit, firstUnfinished, type Hand, makeHand, OUTCOME_LABEL, settleHand } from "./engine/blackjack.ts";
import { dealerField, handField } from "../ui/blackjack.ts";
import { type CardView, renderCards } from "../ui/cards.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatNumber, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "bjt";
const GAME = "blackjack_table";
const BJ = config.games.blackjack;

type Phase = "idle" | "betting" | "playing" | "dealer" | "cooldown";

interface Seat {
  userId: string;
  /** The seat's stake, set at sit-time; hands (with their own `bet`) exist once dealt. */
  bet: number;
  hands: Hand[];
}

/** A persistent, always-on multiplayer blackjack table installed on one channel. */
interface LiveBlackjackTable {
  guildId: string;
  channelId: string;
  message?: Message;
  roundId: string;
  roundStartedAt: number;
  /** Only meaningful in "betting" — fixed at the first bet, doesn't extend on new joins. */
  bettingEndsAt: number;
  phase: Phase;
  seats: (Seat | null)[];
  shoe?: Shoe;
  dealer: Card[];
  activeSeat: number;
  activeHand: number;
  turnEndsAt?: number;
  /** A one-off status line (e.g. an auto-stand) shown on the next "playing" render. */
  lastNote?: string;
  /** Each user's bet amounts from their last completed round (seat order), for the
   *  Repeat button. Survives idle resets; only touched by users who actually played. */
  lastBets: Map<string, number[]>;
  /** Set when the table is torn down so an in-flight animation bails out. */
  closed?: boolean;
  dealTimer?: ReturnType<typeof setTimeout>;
  turnTimer?: ReturnType<typeof setTimeout>;
  repostTimer?: ReturnType<typeof setTimeout>;
  /** Runs for the table's whole lifetime, independent of phase transitions — periodically
   *  reposts while idle so a busy channel doesn't bury it for good. */
  idleRepostTimer?: ReturnType<typeof setInterval>;
}

const tables = new Map<string, LiveBlackjackTable>();
let servicesRef: Services;

function newRound(
  seats: number,
): Pick<LiveBlackjackTable, "roundId" | "roundStartedAt" | "bettingEndsAt" | "phase" | "seats" | "dealer" | "activeSeat" | "activeHand"> {
  return {
    roundId: newId(),
    roundStartedAt: Date.now(),
    bettingEndsAt: 0,
    phase: "idle",
    seats: Array.from({ length: seats }, () => null),
    dealer: [],
    activeSeat: -1,
    activeHand: -1,
  };
}

/** First (seat, hand) still being played, scanning seats from `fromSeat` in order. */
function firstOpenTurn(table: LiveBlackjackTable, fromSeat = 0): { seat: number; hand: number } | null {
  for (let s = fromSeat; s < table.seats.length; s++) {
    const seat = table.seats[s];
    if (!seat) continue;
    const h = firstUnfinished(seat.hands);
    if (h !== -1) return { seat: s, hand: h };
  }
  return null;
}

// --- rendering --------------------------------------------------------------

function seatsField(table: LiveBlackjackTable): string {
  return table.seats
    .map((seat, i) => (seat ? `${i + 1}. <@${seat.userId}> — ${formatChips(seat.bet)}` : `${i + 1}. _empty_`))
    .join("\n");
}

function closedEmbed(): EmbedBuilder {
  return new EmbedBuilder().setColor(Colors.push).setTitle("🃏 Blackjack — closed").setDescription("This table is closed.");
}

/** The idle/betting panel (seats list + Sit & Bet button). */
function tableEmbed(table: LiveBlackjackTable): EmbedBuilder {
  const occupied = table.seats.filter((s) => s !== null).length;
  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setTitle("🃏 Blackjack — table")
    .setDescription("Sit down and place a bet — once the first bet lands, a countdown starts for others to join.")
    .addFields({ name: `Seats (${occupied}/${table.seats.length})`, value: seatsField(table) });
  if (table.phase === "betting") {
    embed.addFields({ name: "Round starts", value: `<t:${Math.floor(table.bettingEndsAt / 1000)}:R>` });
  }
  return embed.setFooter({
    text: `Min ${BJ.minBet} • Max ${BJ.maxBet}/seat • Same rules as /blackjack (3:2 blackjack, dealer hits soft 17)`,
  });
}

function tableComponents(table: LiveBlackjackTable): ActionRowBuilder<ButtonBuilder>[] {
  const full = table.seats.every((s) => s !== null);
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(cid(PREFIX, "sit", table.channelId))
        .setLabel("🪑 Sit & Bet")
        .setStyle(ButtonStyle.Success)
        .setDisabled(full),
      new ButtonBuilder()
        .setCustomId(cid(PREFIX, "repeat", table.channelId))
        .setLabel("🔁 Repeat bet")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(full),
    ),
  ];
}

/** A leading rule on every hand field so adjacent hands don't blur together in a wall
 *  of stacked embed fields — Discord gives non-inline fields only a faint margin. */
const HAND_SEPARATOR = "─".repeat(24);

/** Every occupied seat's hand fields, in seat order. Discord doesn't resolve mentions in
 *  embed field *names* (only values/description), so the seat's mention goes in the value.
 *  The active hand gets a "whose turn" line instead of a plain mention — this is a shared
 *  message, so a bare "your turn" would be ambiguous about who "you" is. */
function seatFields(table: LiveBlackjackTable, reveal: boolean): { name: string; value: string }[] {
  const fields: { name: string; value: string }[] = [];
  for (let s = 0; s < table.seats.length; s++) {
    const seat = table.seats[s];
    if (!seat) continue;
    for (let h = 0; h < seat.hands.length; h++) {
      const active = !reveal && s === table.activeSeat && h === table.activeHand;
      const label = seat.hands.length > 1 ? `Seat ${s + 1} • Hand ${h + 1}` : `Seat ${s + 1}`;
      const field = handField(seat.hands[h]!, label, active, reveal);
      const who = active ? `👉 **<@${seat.userId}> — turn**` : `<@${seat.userId}>`;
      fields.push({ name: field.name, value: `${HAND_SEPARATOR}\n${who}\n${field.value}` });
    }
  }
  return fields;
}

/** The in-progress panel: dealer's upcard, every seat's hands, whose turn it is. */
function playEmbed(table: LiveBlackjackTable): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(Colors.brand).setTitle("🃏 Blackjack — table").addFields(dealerField(table.dealer, false));
  for (const f of seatFields(table, false)) embed.addFields(f);
  const turnSeat = table.seats[table.activeSeat];
  if (turnSeat) {
    embed.setDescription(`▶ <@${turnSeat.userId}>'s turn — <t:${Math.floor((table.turnEndsAt ?? Date.now()) / 1000)}:R>`);
  }
  if (table.lastNote) embed.setFooter({ text: table.lastNote });
  return embed;
}

function actionButtons(table: LiveBlackjackTable, services: Services): ActionRowBuilder<ButtonBuilder>[] {
  const seat = table.seats[table.activeSeat];
  const hand = seat?.hands[table.activeHand];
  if (!seat || !hand) return [];
  const balance = services.wallet.getBalance(table.guildId, seat.userId);
  const twoCards = hand.cards.length === 2;
  const canDouble = twoCards && !hand.doubled && balance >= hand.bet;
  const canSplitHand = canSplit(hand, seat.hands.length) && balance >= hand.bet;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid(PREFIX, "hit", table.channelId)).setLabel("Hit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid(PREFIX, "stand", table.channelId)).setLabel("Stand").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "double", table.channelId))
      .setLabel("Double")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "split", table.channelId))
      .setLabel("Split")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSplitHand),
  );
  if (BJ.allowSurrender) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(cid(PREFIX, "surrender", table.channelId))
        .setLabel("Surrender")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!(twoCards && !hand.fromSplit)),
    );
  }
  return [row];
}

function holeFlipEmbed(table: LiveBlackjackTable, holeCards: Card[], view: CardView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setTitle("🃏 Blackjack — table")
    .addFields({ name: "🤵 Dealer", value: renderCards(holeCards, ["face", view]) });
  for (const f of seatFields(table, true)) embed.addFields(f);
  return embed;
}

function dealerRevealEmbed(table: LiveBlackjackTable, dealerCards: Card[]): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(Colors.table).setTitle("🃏 Blackjack — table").addFields(dealerField(dealerCards, true));
  for (const f of seatFields(table, true)) embed.addFields(f);
  return embed;
}

function resultEmbed(table: LiveBlackjackTable, lines: string[]): EmbedBuilder {
  return dealerRevealEmbed(table, table.dealer).addFields({
    name: "Results",
    value: lines.length ? lines.join("\n").slice(0, 1024) : "_No seats this round._",
  });
}

function refreshMessage(table: LiveBlackjackTable, services: Services): void {
  const embed = table.phase === "playing" ? playEmbed(table) : tableEmbed(table);
  const components = table.phase === "playing" ? actionButtons(table, services) : tableComponents(table);
  void table.message?.edit({ embeds: [embed], components }).catch(() => {});
}

// --- timers -------------------------------------------------------------

function clearTimers(table: LiveBlackjackTable): void {
  if (table.dealTimer) clearTimeout(table.dealTimer);
  if (table.turnTimer) clearTimeout(table.turnTimer);
  if (table.repostTimer) clearTimeout(table.repostTimer);
  if (table.idleRepostTimer) clearInterval(table.idleRepostTimer);
}

/** True if newer messages have pushed the table message off the bottom of the channel. */
async function isBuried(table: LiveBlackjackTable): Promise<boolean> {
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
async function repost(table: LiveBlackjackTable, services: Services): Promise<void> {
  const channel = table.message?.channel;
  if (!channel?.isSendable()) return;
  const old = table.message;
  try {
    table.message = await channel.send({ embeds: [tableEmbed(table)], components: tableComponents(table) });
    saveTable(services, { channelId: table.channelId, guildId: table.guildId, messageId: table.message.id, createdBy: "system" });
    await old?.delete().catch(() => {});
  } catch {
    table.message = old; // keep the old reference if reposting failed
  }
}

/** Runs for as long as the table exists; independent of dealTimer/turnTimer since it
 *  isn't tied to a round — only fires while idle, so it's a no-op during an active round. */
function armIdleRepostTimer(table: LiveBlackjackTable, services: Services): void {
  if (table.idleRepostTimer) clearInterval(table.idleRepostTimer);
  table.idleRepostTimer = setInterval(() => {
    void services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
      if (table.phase === "idle" && (await isBuried(table))) await repost(table, services);
    });
  }, BJ.tableIdleRepostSeconds * 1000);
  if ("unref" in table.idleRepostTimer) table.idleRepostTimer.unref();
}

/**
 * Arm the deal timer, plus (unlike roulette/craps, which skip the repost when a round
 * already has bets) an unconditional repost nudge shortly before the deal — the betting
 * phase only exists once someone's already sat, so the point is letting *others* still
 * see the table and join before the countdown ends.
 */
function armDealTimer(table: LiveBlackjackTable, services: Services): void {
  if (table.dealTimer) clearTimeout(table.dealTimer);
  if (table.repostTimer) clearTimeout(table.repostTimer);
  const delay = Math.max(0, table.bettingEndsAt - Date.now());
  const lead = Math.min(BJ.tableRepostLeadSeconds, BJ.tableBettingSeconds - 1) * 1000;

  table.repostTimer = setTimeout(() => {
    void services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
      if (table.phase === "betting" && (await isBuried(table))) await repost(table, services);
    });
  }, Math.max(0, delay - lead));

  table.dealTimer = setTimeout(() => void dealRound(table, services), delay);
  if ("unref" in table.dealTimer) table.dealTimer.unref();
  if ("unref" in table.repostTimer) table.repostTimer.unref();
}

function armTurnTimer(table: LiveBlackjackTable, services: Services): void {
  if (table.turnTimer) clearTimeout(table.turnTimer);
  table.turnEndsAt = Date.now() + BJ.tableActionSeconds * 1000;
  table.turnTimer = setTimeout(() => void onTurnTimeout(table, services), BJ.tableActionSeconds * 1000);
  if ("unref" in table.turnTimer) table.turnTimer.unref();
}

// --- the round ------------------------------------------------------------

/** Deal every seated hand and the dealer, then either open play or resolve immediately
 *  (dealer/player naturals). Caller is the deal timer; runs under the table lock. */
async function dealRound(table: LiveBlackjackTable, services: Services): Promise<void> {
  let needsDealer = false;
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    if (table.closed || table.phase !== "betting") return;
    const shoe = new Shoe(4);
    for (const seat of table.seats) {
      if (!seat) continue;
      seat.hands = [makeHand(seat.bet, shoe.drawMany(2))];
    }
    table.shoe = shoe;
    table.dealer = shoe.drawMany(2);
    for (const seat of table.seats) {
      if (!seat) continue;
      for (const hand of seat.hands) if (isBlackjack(hand.cards)) hand.done = true;
    }

    const first = firstOpenTurn(table);
    if (isBlackjack(table.dealer) || !first) {
      table.phase = "dealer";
      needsDealer = true;
      return;
    }
    table.lastNote = undefined;
    table.phase = "playing";
    table.activeSeat = first.seat;
    table.activeHand = first.hand;
    armTurnTimer(table, services);
    refreshMessage(table, services);
  });
  if (needsDealer) await runDealerAndSettle(table, services);
}

/** Move to the next unfinished hand (same seat, then next seat). Returns true if there's
 *  none left and the dealer should resolve the round. Pure state — caller holds the lock. */
function advanceTurn(table: LiveBlackjackTable, services: Services): boolean {
  const seat = table.seats[table.activeSeat];
  const sameSeatNext = seat ? firstUnfinished(seat.hands) : -1;
  if (seat && sameSeatNext !== -1) {
    table.activeHand = sameSeatNext;
    armTurnTimer(table, services);
    return false;
  }
  const next = firstOpenTurn(table, table.activeSeat + 1);
  if (next) {
    table.activeSeat = next.seat;
    table.activeHand = next.hand;
    armTurnTimer(table, services);
    return false;
  }
  if (table.turnTimer) clearTimeout(table.turnTimer);
  table.activeSeat = -1;
  table.activeHand = -1;
  table.phase = "dealer";
  return true;
}

async function onTurnTimeout(table: LiveBlackjackTable, services: Services): Promise<void> {
  let needsDealer = false;
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    if (table.closed || table.phase !== "playing") return;
    const seat = table.seats[table.activeSeat];
    const hand = seat?.hands[table.activeHand];
    if (!hand || hand.done) return; // already handled by a click that raced the timer
    hand.done = true;
    table.lastNote = `⏱️ Seat ${table.activeSeat + 1} timed out — auto-stood.`;
    needsDealer = advanceTurn(table, services);
    if (!needsDealer) refreshMessage(table, services);
  });
  if (needsDealer) await runDealerAndSettle(table, services);
}

/** Pay out every seat/hand against the resolved dealer and record stats. Caller holds the lock. */
function settle(table: LiveBlackjackTable, services: Services): string[] {
  const lines: string[] = [];
  for (let s = 0; s < table.seats.length; s++) {
    const seat = table.seats[s];
    if (!seat) continue;
    let seatReturn = 0;
    for (let h = 0; h < seat.hands.length; h++) {
      const hand = seat.hands[h]!;
      const { ret, outcome } = settleHand(hand, table.dealer);
      seatReturn += ret;
      services.rounds.record({
        game: GAME,
        guildId: table.guildId,
        userId: seat.userId,
        wager: hand.bet,
        payout: ret,
        outcome,
        details: { seat: s + 1, hand: h + 1, fromSplit: hand.fromSplit, doubled: hand.doubled },
        startedAt: table.roundStartedAt,
      });
      const label = seat.hands.length > 1 ? `Seat ${s + 1} • Hand ${h + 1}` : `Seat ${s + 1}`;
      lines.push(`${label} <@${seat.userId}> — ${OUTCOME_LABEL[outcome]} • ${formatSigned(ret - hand.bet)}`);
    }
    if (seatReturn > 0) {
      services.wallet.applyDelta({ guildId: table.guildId, userId: seat.userId, delta: seatReturn, type: "payout", game: GAME, ref: table.roundId });
    }
  }
  services.wallet.closeGame(table.roundId);
  return lines;
}

/** Remember each player's bets this round for the Repeat button, then reset to idle.
 *  Only overwrites entries for users who actually played this round — someone who sat
 *  out still repeats whatever their last completed round was. */
function resetToIdle(table: LiveBlackjackTable): void {
  const touched = new Set<string>();
  for (const seat of table.seats) {
    if (!seat) continue;
    if (!touched.has(seat.userId)) {
      table.lastBets.set(seat.userId, []);
      touched.add(seat.userId);
    }
    table.lastBets.get(seat.userId)!.push(seat.bet);
  }
  Object.assign(table, newRound(table.seats.length));
}

/**
 * Reveal the dealer's hole card and play it out, then settle. The animation runs
 * without the table lock (so a stray click during it fails fast instead of blocking
 * past Discord's interaction ack window); settling and the idle reset each take the
 * lock briefly, mirroring craps.ts's runRound.
 */
async function runDealerAndSettle(table: LiveBlackjackTable, services: Services): Promise<void> {
  if (table.closed) return;
  const shoe = table.shoe!;
  const anyLive = table.seats.some((seat) => seat && seat.hands.some((h) => !h.surrendered && !isBust(h.cards)));
  const steps: Card[][] = [table.dealer.slice()];
  if (anyLive && !isBlackjack(table.dealer)) {
    while (dealerShouldHit(table.dealer)) {
      table.dealer.push(shoe.draw());
      steps.push(table.dealer.slice());
    }
  }

  const hole = steps[0]!;
  await table.message?.edit({ embeds: [holeFlipEmbed(table, hole, "back")], components: [] }).catch(() => {});
  await sleep(450);
  if (table.closed) return;
  await table.message?.edit({ embeds: [holeFlipEmbed(table, hole, "flip")] }).catch(() => {});
  await sleep(450);
  if (table.closed) return;
  await table.message?.edit({ embeds: [dealerRevealEmbed(table, hole)] }).catch(() => {});
  for (let k = 1; k < steps.length; k++) {
    await sleep(800);
    if (table.closed) return;
    await table.message?.edit({ embeds: [dealerRevealEmbed(table, steps[k]!)] }).catch(() => {});
  }
  await sleep(steps.length > 1 ? 600 : 350);
  if (table.closed) return;

  let resultLines: string[] = [];
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    if (table.closed) return;
    resultLines = settle(table, services);
    table.phase = "cooldown";
  });
  if (table.closed) return;

  await table.message?.edit({ embeds: [resultEmbed(table, resultLines)], components: [] }).catch(() => {});
  await sleep(BJ.tableCooldownSeconds * 1000);
  if (table.closed) return;
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    if (table.closed) return;
    resetToIdle(table);
    refreshMessage(table, services);
  });
}

function refundTable(table: LiveBlackjackTable, services: Services): void {
  for (const seat of table.seats) {
    if (!seat) continue;
    const staked = seat.hands.length ? seat.hands.reduce((sum, h) => sum + h.bet, 0) : seat.bet;
    if (staked > 0) {
      services.wallet.applyDelta({
        guildId: table.guildId,
        userId: seat.userId,
        delta: staked,
        type: "payout",
        game: GAME,
        ref: table.roundId,
        meta: { refund: true },
      });
    }
  }
  services.wallet.closeGame(table.roundId);
}

// --- DB persistence ---------------------------------------------------------

function saveTable(services: Services, t: { channelId: string; guildId: string; messageId: string; createdBy: string }): void {
  services.db
    .query(
      `INSERT INTO blackjack_tables (channel_id, guild_id, message_id, created_by, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET message_id = excluded.message_id, created_by = excluded.created_by`,
    )
    .run(t.channelId, t.guildId, t.messageId, t.createdBy, Date.now());
}

function deleteTableRow(services: Services, channelId: string): void {
  services.db.query("DELETE FROM blackjack_tables WHERE channel_id = ?").run(channelId);
}

/** Re-attach persisted tables after a restart. They resume idle (empty seats); any
 *  in-flight bets at restart are refunded by the wallet's refundOpenGames() before this runs. */
export async function resumeBlackjackTables(services: Services, client: Client): Promise<void> {
  servicesRef ??= services;
  const rows = services.db.query("SELECT channel_id, guild_id, message_id FROM blackjack_tables").all() as {
    channel_id: string;
    guild_id: string;
    message_id: string;
  }[];

  for (const row of rows) {
    const table: LiveBlackjackTable = {
      guildId: row.guild_id,
      channelId: row.channel_id,
      ...newRound(BJ.tableSeats),
      lastBets: new Map(),
    };
    try {
      const channel = await client.channels.fetch(row.channel_id);
      if (channel?.isTextBased()) {
        table.message = await channel.messages.fetch(row.message_id).catch(() => undefined);
        if (!table.message && "send" in channel) {
          table.message = await channel.send({ embeds: [tableEmbed(table)], components: tableComponents(table) });
          saveTable(services, { channelId: row.channel_id, guildId: row.guild_id, messageId: table.message.id, createdBy: "system" });
        }
      }
    } catch {
      /* channel gone — keep the table logical, admin can re-setup */
    }
    tables.set(table.channelId, table);
    refreshMessage(table, services);
    armIdleRepostTimer(table, services);
  }
  if (rows.length) services.logger.info({ count: rows.length }, "blackjack table: resumed persistent tables");
}

// --- admin commands ----------------------------------------------------------

export async function setupBlackjackTable(
  interaction: ChatInputCommandInteraction<"cached"> | StringSelectMenuInteraction<"cached">,
  services: Services,
): Promise<void> {
  servicesRef ??= services;
  const existing = tables.get(interaction.channelId);
  if (existing) {
    existing.closed = true;
    refundTable(existing, services);
    clearTimers(existing);
  }

  const table: LiveBlackjackTable = {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    ...newRound(BJ.tableSeats),
    lastBets: existing?.lastBets ?? new Map(),
  };

  await interaction.reply({ embeds: [tableEmbed(table)], components: tableComponents(table) });
  table.message = await interaction.fetchReply();
  tables.set(table.channelId, table);
  saveTable(services, { channelId: table.channelId, guildId: table.guildId, messageId: table.message.id, createdBy: interaction.user.id });
  armIdleRepostTimer(table, services);
}

export async function stopBlackjackTable(
  interaction: ChatInputCommandInteraction<"cached"> | StringSelectMenuInteraction<"cached">,
  services: Services,
): Promise<void> {
  servicesRef ??= services;
  const table = tables.get(interaction.channelId);
  if (!table) {
    await interaction.reply({ content: "There's no blackjack table on this channel.", flags: MessageFlags.Ephemeral });
    return;
  }
  await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
    table.closed = true;
    refundTable(table, services);
    clearTimers(table);
    tables.delete(table.channelId);
    deleteTableRow(services, table.channelId);
    await table.message?.edit({ embeds: [closedEmbed()], components: [] }).catch(() => {});
    await interaction.reply({ content: "Blackjack table closed. Open bets were refunded.", flags: MessageFlags.Ephemeral });
  });
}

// --- component handler -------------------------------------------------------

export const blackjackTableComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    servicesRef ??= services;
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];
    const channelId = parts[1] ?? "";
    const table = tables.get(channelId);

    if (!table) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: "This blackjack table is no longer active.", flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (interaction.isButton() && action === "sit") {
      if (table.phase !== "idle" && table.phase !== "betting") {
        await interaction.reply({ content: "A round is in progress — wait for the next one.", flags: MessageFlags.Ephemeral });
        return;
      }
      if (table.seats.every((s) => s !== null)) {
        await interaction.reply({ content: "This table is full.", flags: MessageFlags.Ephemeral });
        return;
      }
      const balance = services.wallet.getBalance(table.guildId, interaction.user.id);
      const modal = new ModalBuilder()
        .setCustomId(cid(PREFIX, "modal", channelId, "sit"))
        .setTitle("Sit & bet")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("amount")
              .setLabel(`Bet amount — balance ${formatNumber(balance)}`)
              .setPlaceholder(`min ${BJ.minBet} • max ${BJ.maxBet}`)
              .setStyle(TextInputStyle.Short)
              .setRequired(true),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && action === "repeat") {
      if (table.phase !== "idle" && table.phase !== "betting") {
        await interaction.reply({ content: "A round is in progress — wait for the next one.", flags: MessageFlags.Ephemeral });
        return;
      }
      const last = table.lastBets.get(interaction.user.id);
      if (!last || last.length === 0) {
        await interaction.reply({ content: "No previous bet to repeat — sit down first.", flags: MessageFlags.Ephemeral });
        return;
      }

      await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
        if (table.phase !== "idle" && table.phase !== "betting") {
          await interaction.reply({ content: "A round is in progress — wait for the next one.", flags: MessageFlags.Ephemeral });
          return;
        }
        const freeSeats: number[] = [];
        table.seats.forEach((s, i) => {
          if (s === null) freeSeats.push(i);
        });
        if (freeSeats.length === 0) {
          await interaction.reply({ content: "This table is full.", flags: MessageFlags.Ephemeral });
          return;
        }

        const amounts = last.slice(0, freeSeats.length).map((a) => Math.min(BJ.maxBet, Math.max(BJ.minBet, a)));
        let seated = 0;
        for (const amount of amounts) {
          try {
            services.wallet.placeBet({
              guildId: table.guildId,
              userId: interaction.user.id,
              amount,
              game: GAME,
              ref: table.roundId,
              channelId: table.channelId,
              messageId: table.message?.id,
              meta: { seat: freeSeats[seated] },
            });
          } catch (err) {
            if (err instanceof InsufficientFundsError) break;
            throw err;
          }
          table.seats[freeSeats[seated]!] = { userId: interaction.user.id, bet: amount, hands: [] };
          seated++;
        }

        if (seated === 0) {
          await interaction.reply({ content: "You don't have enough chips to repeat that bet.", flags: MessageFlags.Ephemeral });
          return;
        }
        if (table.phase === "idle") {
          table.phase = "betting";
          table.bettingEndsAt = Date.now() + BJ.tableBettingSeconds * 1000;
          armDealTimer(table, services);
        }
        refreshMessage(table, services);
        if (seated < last.length) {
          const reason = freeSeats.length < last.length ? "not enough free seats" : "not enough chips";
          await interaction.reply({ content: `Seated ${seated} of ${last.length} — ${reason} for the rest.`, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.deferUpdate();
        }
      });
      return;
    }

    if (interaction.isModalSubmit() && action === "modal" && parts[2] === "sit") {
      const amount = Number.parseInt(interaction.fields.getTextInputValue("amount").trim(), 10);
      if (!Number.isInteger(amount) || amount < BJ.minBet || amount > BJ.maxBet) {
        await interaction.reply({ content: `Amount must be between ${BJ.minBet} and ${BJ.maxBet}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
        if (table.phase !== "idle" && table.phase !== "betting") {
          await interaction.reply({ content: "A round is in progress — wait for the next one.", flags: MessageFlags.Ephemeral });
          return;
        }
        const seatIdx = table.seats.findIndex((s) => s === null);
        if (seatIdx === -1) {
          await interaction.reply({ content: "This table is full.", flags: MessageFlags.Ephemeral });
          return;
        }
        try {
          services.wallet.placeBet({
            guildId: table.guildId,
            userId: interaction.user.id,
            amount,
            game: GAME,
            ref: table.roundId,
            channelId: table.channelId,
            messageId: table.message?.id,
            meta: { seat: seatIdx },
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) {
            await interaction.reply({ content: "You don't have enough chips for that bet.", flags: MessageFlags.Ephemeral });
            return;
          }
          throw err;
        }
        table.seats[seatIdx] = { userId: interaction.user.id, bet: amount, hands: [] };
        if (table.phase === "idle") {
          table.phase = "betting";
          table.bettingEndsAt = Date.now() + BJ.tableBettingSeconds * 1000;
          armDealTimer(table, services);
        }
        refreshMessage(table, services);
        await interaction.deferUpdate();
      });
      return;
    }

    if (interaction.isButton() && ["hit", "stand", "double", "split", "surrender"].includes(action ?? "")) {
      if (table.phase !== "playing") {
        await interaction.reply({ content: "No active turn right now.", flags: MessageFlags.Ephemeral });
        return;
      }
      const seat = table.seats[table.activeSeat];
      if (!seat || interaction.user.id !== seat.userId) {
        await interaction.reply({
          content: seat ? `It's <@${seat.userId}>'s turn.` : "No active turn right now.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const state: { outcome: "handled" | "advance" | "dealer" } = { outcome: "advance" };
      await services.locks.run(`${PREFIX}:${table.channelId}`, async () => {
        if (table.phase !== "playing" || table.seats[table.activeSeat] !== seat) {
          state.outcome = "handled";
          return;
        }
        const hand = seat.hands[table.activeHand];
        if (!hand) {
          state.outcome = "handled";
          return;
        }

        try {
          switch (action) {
            case "hit": {
              hand.cards.push(table.shoe!.draw());
              if (isBust(hand.cards) || handTotal(hand.cards).total === 21) hand.done = true;
              break;
            }
            case "stand": {
              hand.done = true;
              break;
            }
            case "double": {
              if (hand.cards.length !== 2 || hand.doubled) {
                await interaction.reply({ content: "You can't double now.", flags: MessageFlags.Ephemeral });
                state.outcome = "handled";
                return;
              }
              services.wallet.placeBet({
                guildId: table.guildId,
                userId: seat.userId,
                amount: hand.bet,
                game: GAME,
                ref: table.roundId,
                channelId: table.channelId,
                messageId: table.message?.id,
              });
              hand.bet *= 2;
              hand.doubled = true;
              hand.cards.push(table.shoe!.draw());
              hand.done = true;
              break;
            }
            case "split": {
              if (!canSplit(hand, seat.hands.length)) {
                await interaction.reply({ content: "You can't split now.", flags: MessageFlags.Ephemeral });
                state.outcome = "handled";
                return;
              }
              services.wallet.placeBet({
                guildId: table.guildId,
                userId: seat.userId,
                amount: hand.bet,
                game: GAME,
                ref: table.roundId,
                channelId: table.channelId,
                messageId: table.message?.id,
              });
              const moved = hand.cards.pop()!;
              const newHand = makeHand(hand.bet, [moved], true);
              hand.fromSplit = true;
              hand.cards.push(table.shoe!.draw());
              newHand.cards.push(table.shoe!.draw());
              seat.hands.splice(table.activeHand + 1, 0, newHand);
              if (moved.rank === 1) {
                hand.done = true;
                newHand.done = true;
              }
              break;
            }
            case "surrender": {
              if (!BJ.allowSurrender || hand.cards.length !== 2 || hand.fromSplit) {
                await interaction.reply({ content: "You can't surrender now.", flags: MessageFlags.Ephemeral });
                state.outcome = "handled";
                return;
              }
              hand.surrendered = true;
              hand.done = true;
              break;
            }
            default:
              state.outcome = "handled";
              return;
          }
        } catch (err) {
          if (err instanceof InsufficientFundsError) {
            await interaction.reply({ content: "You don't have enough chips for that.", flags: MessageFlags.Ephemeral });
            state.outcome = "handled";
            return;
          }
          throw err;
        }

        table.lastNote = undefined;
        const needsDealer = advanceTurn(table, services);
        if (!needsDealer) refreshMessage(table, services);
        state.outcome = needsDealer ? "dealer" : "advance";
      });

      if (state.outcome === "handled") return;
      await interaction.deferUpdate().catch(() => {});
      if (state.outcome === "dealer") await runDealerAndSettle(table, services);
    }
  },
};

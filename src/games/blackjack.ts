import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Message,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { type Card, cardValue, Shoe } from "./engine/deck.ts";
import { handTotal, isBlackjack, isBust } from "./engine/handvalue.ts";
import { type SessionBase, SessionStore } from "../lib/sessions.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { replayStakes } from "../lib/stakes.ts";
import { type CardView, renderCards, renderHand } from "../ui/cards.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { replyError } from "../lib/reply.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "bj";
const MAX_TOTAL_HANDS = 4;
const BJ = config.games.blackjack;

type Outcome = "win" | "loss" | "push" | "blackjack" | "surrender";

interface Hand {
  cards: Card[];
  bet: number;
  done: boolean;
  doubled: boolean;
  surrendered: boolean;
  fromSplit: boolean;
}

interface BlackjackSession extends SessionBase {
  guildId: string;
  channelId: string;
  playerName: string;
  playerIcon: string;
  betPerHand: number;
  numHands: number;
  shoe: Shoe;
  dealer: Card[];
  hands: Hand[];
  active: number;
  startedAt: number;
  finished: boolean;
  message?: Message;
}

let store: SessionStore<BlackjackSession>;
let servicesRef: Services;

function getStore(services: Services): SessionStore<BlackjackSession> {
  servicesRef ??= services;
  store ??= new SessionStore<BlackjackSession>(config.sessionTimeoutSeconds * 1000, (session) => {
    void onTimeout(session);
  });
  return store;
}

// --- pure-ish helpers -------------------------------------------------------

function makeHand(bet: number, cards: Card[], fromSplit = false): Hand {
  return { cards, bet, done: false, doubled: false, surrendered: false, fromSplit };
}

function firstUnfinished(session: BlackjackSession): number {
  return session.hands.findIndex((h) => !h.done);
}

function dealerShouldHit(cards: Card[]): boolean {
  const { total, soft } = handTotal(cards);
  if (total < 17) return true;
  return total === 17 && soft && BJ.dealerHitsSoft17;
}

/** Play out the dealer's hand, returning a snapshot after each card (for the reveal
 *  animation). The first snapshot is the 2-card hole-card flip. */
function playDealerSteps(session: BlackjackSession): Card[][] {
  const steps: Card[][] = [session.dealer.slice()];
  const live = session.hands.some((h) => !h.surrendered && !isBust(h.cards));
  if (live && !isBlackjack(session.dealer)) {
    while (dealerShouldHit(session.dealer)) {
      session.dealer.push(session.shoe.draw());
      steps.push(session.dealer.slice());
    }
  }
  return steps;
}

/** Chips returned to the player for one hand (stake + winnings), and the outcome. */
function settleHand(hand: Hand, dealer: Card[]): { ret: number; outcome: Outcome } {
  if (hand.surrendered) return { ret: Math.floor(hand.bet / 2), outcome: "surrender" };
  if (isBust(hand.cards)) return { ret: 0, outcome: "loss" };

  const dealerNatural = isBlackjack(dealer);
  const playerNatural = isBlackjack(hand.cards) && !hand.fromSplit;

  if (playerNatural) {
    if (dealerNatural) return { ret: hand.bet, outcome: "push" };
    const profit = Math.floor((hand.bet * BJ.blackjackPayoutNum) / BJ.blackjackPayoutDen);
    return { ret: hand.bet + profit, outcome: "blackjack" };
  }
  if (dealerNatural) return { ret: 0, outcome: "loss" };

  const dealerTotal = handTotal(dealer).total;
  const playerTotal = handTotal(hand.cards).total;
  if (dealerTotal > 21 || playerTotal > dealerTotal) return { ret: hand.bet * 2, outcome: "win" };
  if (playerTotal === dealerTotal) return { ret: hand.bet, outcome: "push" };
  return { ret: 0, outcome: "loss" };
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  win: "✅ Win",
  loss: "❌ Loss",
  push: "➖ Push",
  blackjack: "🃏 Blackjack!",
  surrender: "🏳️ Surrender",
};

// --- rendering --------------------------------------------------------------

function totalString(cards: Card[]): string {
  const { total, soft } = handTotal(cards);
  return soft && total <= 21 ? `${total - 10}/${total}` : String(total);
}

function handField(hand: Hand, idx: number, active: boolean, reveal: boolean): { name: string; value: string } {
  const tags: string[] = [];
  if (hand.doubled) tags.push("doubled");
  if (hand.fromSplit) tags.push("split");
  const tagStr = tags.length ? ` (${tags.join(", ")})` : "";
  const marker = active && !reveal ? "▶ " : "";
  return {
    name: `${marker}Hand ${idx + 1} — bet ${formatChips(hand.bet)}${tagStr}`,
    value: `${renderHand(hand.cards)}\n**Total: ${totalString(hand.cards)}**`,
  };
}

function render(session: BlackjackSession, opts: { reveal: boolean }): EmbedBuilder {
  const dealerValue = opts.reveal
    ? `**Total: ${handTotal(session.dealer).total}**`
    : `**Showing: ${handTotal([session.dealer[0]!]).total}+**`;

  const embed = new EmbedBuilder()
    .setColor(opts.reveal ? Colors.table : Colors.brand)
    .setAuthor({ name: session.playerName, iconURL: session.playerIcon })
    .setTitle("🃏 Blackjack")
    .addFields({
      name: "🤵 Dealer",
      value: `${renderHand(session.dealer, { hideFrom: opts.reveal ? undefined : 1 })}\n${dealerValue}`,
    });

  for (let i = 0; i < session.hands.length; i++) {
    embed.addFields(handField(session.hands[i]!, i, i === session.active, opts.reveal));
  }
  return embed;
}

function actionButtons(session: BlackjackSession, services: Services): ActionRowBuilder<ButtonBuilder>[] {
  const hand = session.hands[session.active];
  if (!hand) return [];
  const balance = services.wallet.getBalance(session.guildId, session.userId);
  const twoCards = hand.cards.length === 2;
  const canDouble = twoCards && !hand.doubled && balance >= hand.bet;
  const canSplit =
    twoCards &&
    cardValue(hand.cards[0]!) === cardValue(hand.cards[1]!) &&
    session.hands.length < MAX_TOTAL_HANDS &&
    balance >= hand.bet;

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(cid(PREFIX, "hit", session.id)).setLabel("Hit").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(cid(PREFIX, "stand", session.id)).setLabel("Stand").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "double", session.id))
      .setLabel("Double")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "split", session.id))
      .setLabel("Split")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSplit),
  );
  if (BJ.allowSurrender) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(cid(PREFIX, "surrender", session.id))
        .setLabel("Surrender")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!(twoCards && !hand.fromSplit)),
    );
  }
  return [row];
}

function replayRow(betPerHand: number, numHands: number): ActionRowBuilder<ButtonBuilder> {
  const buttons = replayStakes(betPerHand, BJ.minBet, BJ.maxBet, "Replay").map((o, i) =>
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "replay", o.amt, numHands))
      .setLabel(o.label)
      .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

// --- settlement -------------------------------------------------------------

function resolve(session: BlackjackSession, services: Services): { embed: EmbedBuilder; steps: Card[][] } {
  session.finished = true;
  const steps = playDealerSteps(session);

  let totalReturn = 0;
  let totalBet = 0;
  const resultLines: string[] = [];

  for (let i = 0; i < session.hands.length; i++) {
    const hand = session.hands[i]!;
    const { ret, outcome } = settleHand(hand, session.dealer);
    totalReturn += ret;
    totalBet += hand.bet;

    services.rounds.record({
      game: "blackjack",
      guildId: session.guildId,
      userId: session.userId,
      wager: hand.bet,
      payout: ret,
      outcome,
      details: { hand: i + 1, fromSplit: hand.fromSplit, doubled: hand.doubled },
      startedAt: session.startedAt,
    });

    resultLines.push(
      `**Hand ${i + 1}** (${handTotal(hand.cards).total}) — ${OUTCOME_LABEL[outcome]} • ${formatSigned(ret - hand.bet)}`,
    );
  }

  if (totalReturn > 0) {
    services.wallet.applyDelta({
      guildId: session.guildId,
      userId: session.userId,
      delta: totalReturn,
      type: "payout",
      game: "blackjack",
      ref: session.id,
    });
  }
  services.wallet.closeGame(session.id);

  const net = totalReturn - totalBet;
  const balance = services.wallet.getBalance(session.guildId, session.userId);
  const embed = render(session, { reveal: true })
    .setColor(net > 0 ? Colors.win : net < 0 ? Colors.loss : Colors.push)
    .addFields(
      { name: "Result", value: resultLines.join("\n") },
      { name: "Total", value: `${formatSigned(net)} • balance: **${formatChips(balance)}**` },
    );
  return { embed, steps };
}

/** A reveal frame: dealer shown with `dealerCards` face-up, plus the final player hands. */
function revealFrame(session: BlackjackSession, dealerCards: Card[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setAuthor({ name: session.playerName, iconURL: session.playerIcon })
    .setTitle("🃏 Blackjack")
    .addFields({ name: "🤵 Dealer", value: `${renderHand(dealerCards)}\n**Total: ${handTotal(dealerCards).total}**` });
  for (let i = 0; i < session.hands.length; i++) embed.addFields(handField(session.hands[i]!, i, false, true));
  return embed;
}

/** A hole-card flip frame: dealer's upcard face-up, the hole card drawn per `holeView`. */
function holeFlipFrame(session: BlackjackSession, holeCards: Card[], holeView: CardView): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.table)
    .setAuthor({ name: session.playerName, iconURL: session.playerIcon })
    .setTitle("🃏 Blackjack")
    .addFields({ name: "🤵 Dealer", value: renderCards(holeCards, ["face", holeView]) });
  for (let i = 0; i < session.hands.length; i++) embed.addFields(handField(session.hands[i]!, i, false, true));
  return embed;
}

async function onTimeout(session: BlackjackSession): Promise<void> {
  if (session.finished || !session.message) return;
  await servicesRef.locks.run(`${session.guildId}:${session.userId}`, async () => {
    if (session.finished) return;
    for (const hand of session.hands) hand.done = true; // stand the rest
    const { embed } = resolve(session, servicesRef);
    embed.setFooter({ text: "⏱️ Timed out — auto-stood." });
    await session.message!
      .edit({ embeds: [embed], components: [replayRow(session.betPerHand, session.numHands)] })
      .catch(() => {});
  });
}

// --- starting a game (shared by the slash command and the replay buttons) ---

async function startBlackjack(
  interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached">,
  services: Services,
  bet: number,
  numHands: number,
): Promise<void> {
  const total = bet * numHands;
  const key = `${interaction.guildId}:${interaction.user.id}`;

  await services.locks.run(key, async () => {
    const balance = services.wallet.getBalance(interaction.guildId, interaction.user.id);
    if (balance < total) {
      await replyError(
        interaction,
        `You need ${formatChips(total)} for ${numHands} hand(s), but you have ${formatChips(balance)}.`,
      );
      return;
    }

    const id = newId();
    services.wallet.placeBet({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      amount: total,
      game: "blackjack",
      ref: id,
      channelId: interaction.channelId,
      meta: { hands: numHands, betPerHand: bet },
    });

    const shoe = new Shoe(4);
    const hands: Hand[] = [];
    for (let i = 0; i < numHands; i++) hands.push(makeHand(bet, shoe.drawMany(2)));
    const dealer = shoe.drawMany(2);

    const session: BlackjackSession = {
      id,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      playerName: interaction.user.displayName,
      playerIcon: interaction.user.displayAvatarURL(),
      betPerHand: bet,
      numHands,
      shoe,
      dealer,
      hands,
      active: 0,
      startedAt: Date.now(),
      finished: false,
    };

    for (const hand of hands) if (isBlackjack(hand.cards)) hand.done = true;
    session.active = firstUnfinished(session);

    if (isBlackjack(dealer) || session.active === -1) {
      const { embed } = resolve(session, services);
      await interaction.reply({ embeds: [embed], components: [replayRow(bet, numHands)] });
      return;
    }

    getStore(services).create(session);
    await interaction.reply({ embeds: [render(session, { reveal: false })], components: actionButtons(session, services) });
    session.message = await interaction.fetchReply();
    services.wallet.setGameMessage(session.id, session.channelId, session.message.id);
  });
}

// --- command ----------------------------------------------------------------

export const blackjackCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("Play blackjack against the dealer")
    .addIntegerOption((o) =>
      o.setName("bet").setDescription("Bet per hand").setRequired(true).setMinValue(BJ.minBet).setMaxValue(BJ.maxBet),
    )
    .addIntegerOption((o) =>
      o
        .setName("hands")
        .setDescription("How many hands to play at once (default 1)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(BJ.maxHands),
    ),

  async execute(interaction, services) {
    const bet = interaction.options.getInteger("bet", true);
    const numHands = interaction.options.getInteger("hands") ?? 1;
    await startBlackjack(interaction, services, bet, numHands);
  },
};

// --- component handler ------------------------------------------------------

export const blackjackComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    if (!interaction.isButton()) return;
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];

    if (action === "replay") {
      const bet = Math.min(BJ.maxBet, Math.max(BJ.minBet, Number.parseInt(parts[1] ?? "0", 10)));
      const hands = Number.parseInt(parts[2] ?? "1", 10);
      await startBlackjack(interaction, services, bet, hands);
      return;
    }

    const sessionId = parts[1];
    const session = getStore(services).get(sessionId ?? "");
    if (!session || session.finished) {
      await interaction.reply({ content: "This game has ended.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== session.userId) {
      await interaction.reply({ content: "This isn't your game.", flags: MessageFlags.Ephemeral });
      return;
    }

    await services.locks.run(`${session.guildId}:${session.userId}`, async () => {
      if (session.finished) {
        await interaction.reply({ content: "This game has ended.", flags: MessageFlags.Ephemeral });
        return;
      }
      const hand = session.hands[session.active];
      if (!hand) return;

      try {
        switch (action) {
          case "hit": {
            hand.cards.push(session.shoe.draw());
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
              return;
            }
            chargeExtra(services, session, hand.bet);
            hand.bet *= 2;
            hand.doubled = true;
            hand.cards.push(session.shoe.draw());
            hand.done = true;
            break;
          }
          case "split": {
            if (
              hand.cards.length !== 2 ||
              cardValue(hand.cards[0]!) !== cardValue(hand.cards[1]!) ||
              session.hands.length >= MAX_TOTAL_HANDS
            ) {
              await interaction.reply({ content: "You can't split now.", flags: MessageFlags.Ephemeral });
              return;
            }
            chargeExtra(services, session, hand.bet);
            const moved = hand.cards.pop()!;
            const newHand = makeHand(hand.bet, [moved], true);
            hand.fromSplit = true;
            hand.cards.push(session.shoe.draw());
            newHand.cards.push(session.shoe.draw());
            session.hands.splice(session.active + 1, 0, newHand);
            if (moved.rank === 1) {
              hand.done = true;
              newHand.done = true;
            }
            break;
          }
          case "surrender": {
            if (!BJ.allowSurrender || hand.cards.length !== 2 || hand.fromSplit) {
              await interaction.reply({ content: "You can't surrender now.", flags: MessageFlags.Ephemeral });
              return;
            }
            hand.surrendered = true;
            hand.done = true;
            break;
          }
          default:
            return;
        }
      } catch (err) {
        if (err instanceof InsufficientFundsError) {
          await interaction.reply({ content: "You don't have enough chips for that.", flags: MessageFlags.Ephemeral });
          return;
        }
        throw err;
      }

      const next = firstUnfinished(session);
      if (next === -1) {
        const { embed, steps } = resolve(session, services);
        getStore(services).delete(session.id);
        // Flip the hole card (back → edge → face), then draw the dealer out card by card.
        const hole = steps[0]!; // the dealer's starting two cards
        await interaction.update({ embeds: [holeFlipFrame(session, hole, "back")], components: [] });
        await sleep(450);
        await interaction.editReply({ embeds: [holeFlipFrame(session, hole, "flip")] }).catch(() => {});
        await sleep(450);
        await interaction.editReply({ embeds: [revealFrame(session, hole)] }).catch(() => {});
        for (let k = 1; k < steps.length; k++) {
          await sleep(800);
          await interaction.editReply({ embeds: [revealFrame(session, steps[k]!)] }).catch(() => {});
        }
        await sleep(steps.length > 1 ? 600 : 350);
        // Little flourish on a natural 21.
        if (session.hands.some((h) => isBlackjack(h.cards))) embed.setTitle("🃏 Blackjack — ✨ 21!");
        await interaction.editReply({ embeds: [embed], components: [replayRow(session.betPerHand, session.numHands)] });
        return;
      }
      session.active = next;
      getStore(services).touch(session.id);
      await interaction.update({
        embeds: [render(session, { reveal: false })],
        components: actionButtons(session, services),
      });
      session.message = interaction.message;
    });
  },
};

/** Debit an additional bet (double/split). Throws InsufficientFundsError if broke. */
function chargeExtra(services: Services, session: BlackjackSession, amount: number): void {
  services.wallet.placeBet({
    guildId: session.guildId,
    userId: session.userId,
    amount,
    game: "blackjack",
    ref: session.id,
  });
}

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Message,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { type Card, freshDeck } from "./engine/deck.ts";
import { shuffle } from "./engine/rng.ts";
import { bestOf, compareRanks, type HandRank } from "./engine/pokerEval.ts";
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

const PREFIX = "chp";
const HE = config.games.casinoHoldem;

interface PokerSession extends SessionBase {
  guildId: string;
  channelId: string;
  playerName: string;
  playerIcon: string;
  ante: number;
  player: Card[];
  dealer: Card[];
  community: Card[];
  finished: boolean;
  startedAt: number;
  message?: Message;
}

let store: SessionStore<PokerSession>;
let servicesRef: Services;

function getStore(services: Services): SessionStore<PokerSession> {
  servicesRef ??= services;
  store ??= new SessionStore<PokerSession>(config.sessionTimeoutSeconds * 1000, (s) => void onTimeout(s));
  return store;
}

/** Ante-bonus paytable, "to one", by the player's best 5-card hand category. */
function anteOdds(best: HandRank): number {
  const cat = best.score[0]!;
  if (cat === 9) return 100; // royal flush
  if (cat === 8) return 20; // straight flush
  if (cat === 7) return 10; // four of a kind
  if (cat === 6) return 3; // full house
  if (cat === 5) return 2; // flush
  return 1; // straight or lower
}

/** Dealer qualifies with a pair of fours or better. */
function dealerQualifies(best: HandRank): boolean {
  const [cat, top] = best.score;
  if (cat! >= 2) return true;
  return cat === 1 && (top ?? 0) >= 4;
}

function flopEmbed(session: PokerSession): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.brand)
    .setAuthor({ name: session.playerName, iconURL: session.playerIcon })
    .setTitle("🃏 Casino Hold'em")
    .addFields(
      { name: "Flop", value: renderHand(session.community.slice(0, 3)) },
      { name: "Your cards", value: renderHand(session.player) },
    )
    .setFooter({ text: `Ante: ${session.ante}. Call for 2× ante, or fold?` });
}

function replayRow(ante: number): ActionRowBuilder<ButtonBuilder> {
  const buttons = replayStakes(ante, HE.minAnte, HE.maxAnte, "Replay").map((o, i) =>
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "replay", o.amt))
      .setLabel(o.label)
      .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

interface Settlement {
  net: number;
  resultText: string;
  playerName: string; // best-hand category name
  dealerName: string;
  balance: number;
}

/** Decide the hand, move the money, record the round. Call ONCE, before any reveal animation. */
function settle(session: PokerSession, services: Services, opts: { folded: boolean }): Settlement {
  const playerBest = bestOf([...session.player, ...session.community]);
  const dealerBest = bestOf([...session.dealer, ...session.community]);
  const call = session.ante * 2;

  let returned = 0;
  let resultText: string;
  let outcome: string;

  if (opts.folded) {
    resultText = "You folded — the ante is lost.";
    outcome = "fold";
  } else {
    const qualifies = dealerQualifies(dealerBest);
    const cmp = compareRanks(playerBest.score, dealerBest.score);
    const anteWin = session.ante + Math.floor(session.ante * anteOdds(playerBest));

    if (!qualifies) {
      returned = anteWin + call; // ante pays per paytable, call pushes
      resultText = "Dealer doesn't qualify — ante pays, call is returned.";
      outcome = "win";
    } else if (cmp > 0) {
      returned = anteWin + call * 2;
      resultText = "You beat the dealer!";
      outcome = "win";
    } else if (cmp === 0) {
      returned = session.ante + call;
      resultText = "Tie — bets are returned.";
      outcome = "push";
    } else {
      returned = 0;
      resultText = "Dealer wins.";
      outcome = "loss";
    }
  }

  const totalWager = opts.folded ? session.ante : session.ante + call;
  if (returned > 0) {
    services.wallet.applyDelta({
      guildId: session.guildId,
      userId: session.userId,
      delta: returned,
      type: "payout",
      game: "holdem",
      ref: session.id,
    });
  }
  services.wallet.closeGame(session.id);
  services.rounds.record({
    game: "holdem",
    guildId: session.guildId,
    userId: session.userId,
    wager: totalWager,
    payout: returned,
    outcome,
    details: { folded: opts.folded, player: playerBest.name, dealer: dealerBest.name },
    startedAt: session.startedAt,
  });

  return {
    net: returned - totalWager,
    resultText,
    playerName: playerBest.name,
    dealerName: dealerBest.name,
    balance: services.wallet.getBalance(session.guildId, session.userId),
  };
}

/** The final showdown card — everything face-up with the result. Built from a prior settle(). */
function finalEmbed(session: PokerSession, s: Settlement): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(s.net > 0 ? Colors.win : s.net < 0 ? Colors.loss : Colors.push)
    .setAuthor({ name: session.playerName, iconURL: session.playerIcon })
    .setTitle("🃏 Casino Hold'em — showdown")
    .addFields(
      { name: "Board", value: renderHand(session.community) },
      { name: `You — ${s.playerName}`, value: renderHand(session.player) },
      { name: `Dealer — ${s.dealerName}`, value: renderHand(session.dealer) },
      { name: "Result", value: `${s.resultText}\n${formatSigned(s.net)} • balance: **${formatChips(s.balance)}**` },
    );
}

/** One in-progress reveal frame (no result yet) — community/dealer drawn per the given views. */
function showdownEmbed(session: PokerSession, communityViews: CardView[], dealerViews: CardView[]): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.brand)
    .setAuthor({ name: session.playerName, iconURL: session.playerIcon })
    .setTitle("🃏 Casino Hold'em — showdown")
    .addFields(
      { name: "Board", value: renderCards(session.community, communityViews) },
      { name: "Your cards", value: renderHand(session.player) },
      { name: "Dealer", value: renderCards(session.dealer, dealerViews) },
    );
}

/** Burst-reveal turn+river, then flip the dealer's hole cards. Cosmetic — settle() ran first. */
async function animateShowdown(interaction: ButtonInteraction<"cached">, session: PokerSession, s: Settlement): Promise<void> {
  const community: CardView[] = ["face", "face", "face", "back", "back"];
  const dealer: CardView[] = ["back", "back"];
  await interaction.update({ embeds: [showdownEmbed(session, community, dealer)], components: [] });

  const steps: (() => void)[] = [
    () => (community[3] = "face"), // turn
    () => (community[4] = "face"), // river
    () => ((dealer[0] = "flip"), (dealer[1] = "flip")), // dealer cards on edge
    () => ((dealer[0] = "face"), (dealer[1] = "face")), // dealer revealed
  ];
  for (const step of steps) {
    await sleep(600);
    step();
    await interaction.editReply({ embeds: [showdownEmbed(session, community, dealer)] }).catch(() => {});
  }
  await sleep(500);
  // No silent catch on the result edit — if it ever fails we want it in the logs, not hidden.
  await interaction.editReply({ embeds: [finalEmbed(session, s)], components: [replayRow(session.ante)] });
}

async function onTimeout(session: PokerSession): Promise<void> {
  if (session.finished || !session.message) return;
  await servicesRef.locks.run(`${session.guildId}:${session.userId}`, async () => {
    if (session.finished) return;
    session.finished = true;
    const s = settle(session, servicesRef, { folded: true });
    const embed = finalEmbed(session, s).setFooter({ text: "⏱️ Timed out — auto-folded." });
    await session.message!.edit({ embeds: [embed], components: [replayRow(session.ante)] }).catch(() => {});
  });
}

async function startPoker(
  interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached">,
  services: Services,
  ante: number,
): Promise<void> {
  const key = `${interaction.guildId}:${interaction.user.id}`;
  await services.locks.run(key, async () => {
    const balance = services.wallet.getBalance(interaction.guildId, interaction.user.id);
    if (balance < ante) {
      await replyError(interaction, `You need ${formatChips(ante)} for the ante, but you have ${formatChips(balance)}.`);
      return;
    }

    const id = newId();
    services.wallet.placeBet({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      amount: ante,
      game: "holdem",
      ref: id,
      channelId: interaction.channelId,
      meta: { stage: "ante" },
    });

    const deck = shuffle(freshDeck());
    const session: PokerSession = {
      id,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      playerName: interaction.user.displayName,
      playerIcon: interaction.user.displayAvatarURL(),
      ante,
      player: [deck.pop()!, deck.pop()!],
      dealer: [deck.pop()!, deck.pop()!],
      community: [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!],
      finished: false,
      startedAt: Date.now(),
    };
    getStore(services).create(session);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(cid(PREFIX, "call", session.id))
        .setLabel(`Call (${formatChips(ante * 2)})`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid(PREFIX, "fold", session.id)).setLabel("Fold").setStyle(ButtonStyle.Danger),
    );
    await interaction.reply({ embeds: [flopEmbed(session)], components: [row] });
    session.message = await interaction.fetchReply();
    services.wallet.setGameMessage(session.id, session.channelId, session.message.id);
  });
}

export const pokerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("poker")
    .setDescription("Casino Hold'em — play against the dealer")
    .addIntegerOption((o) =>
      o.setName("ante").setDescription("Ante bet").setRequired(true).setMinValue(HE.minAnte).setMaxValue(HE.maxAnte),
    ),

  async execute(interaction, services) {
    await startPoker(interaction, services, interaction.options.getInteger("ante", true));
  },
};

export const pokerComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    if (!interaction.isButton()) return;
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];

    if (action === "replay") {
      const ante = Math.min(HE.maxAnte, Math.max(HE.minAnte, Number.parseInt(parts[1] ?? "0", 10)));
      await startPoker(interaction, services, ante);
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
      if (session.finished) return;

      if (action === "fold") {
        session.finished = true;
        getStore(services).delete(session.id);
        const s = settle(session, services, { folded: true });
        await interaction.update({ embeds: [finalEmbed(session, s)], components: [replayRow(session.ante)] });
        return;
      }

      if (action === "call") {
        const call = session.ante * 2;
        try {
          services.wallet.placeBet({
            guildId: session.guildId,
            userId: session.userId,
            amount: call,
            game: "holdem",
            ref: session.id,
            meta: { stage: "call" },
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) {
            await interaction.reply({
              content: `You don't have enough chips to call (${formatChips(call)}).`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw err;
        }
        session.finished = true;
        getStore(services).delete(session.id);
        const s = settle(session, services, { folded: false }); // money settles first; the reveal is cosmetic
        await animateShowdown(interaction, session, s);
      }
    });
  },
};

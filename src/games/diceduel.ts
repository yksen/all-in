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
import { intBetween } from "./engine/rng.ts";
import { type SessionBase, SessionStore } from "../lib/sessions.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { replayStakes } from "../lib/stakes.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { replyError } from "../lib/reply.ts";
import { sleep } from "../lib/sleep.ts";
import { renderDice } from "../ui/dice.ts";

const PREFIX = "dd";
const DD = config.games.diceDuel;

interface DiceDuelSession extends SessionBase {
  guildId: string;
  channelId: string;
  challengerId: string;
  opponentId: string;
  stake: number;
  finished: boolean;
  startedAt: number;
  message?: Message;
}

let store: SessionStore<DiceDuelSession>;
let servicesRef: Services;

function getStore(services: Services): SessionStore<DiceDuelSession> {
  servicesRef ??= services;
  store ??= new SessionStore<DiceDuelSession>(DD.challengeTimeoutSeconds * 1000, (s) => void onTimeout(s));
  return store;
}

/** Roll 2d6 for each side; reroll until the sums differ so there's always a winner. */
export function duelRoll(): { a: [number, number]; b: [number, number]; aSum: number; bSum: number; challengerWins: boolean } {
  for (;;) {
    const a: [number, number] = [intBetween(1, 6), intBetween(1, 6)];
    const b: [number, number] = [intBetween(1, 6), intBetween(1, 6)];
    const aSum = a[0] + a[1];
    const bSum = b[0] + b[1];
    if (aSum !== bSum) return { a, b, aSum, bSum, challengerWins: aSum > bSum };
  }
}

function refundChallenger(session: DiceDuelSession, services: Services): void {
  services.wallet.applyDelta({
    guildId: session.guildId,
    userId: session.challengerId,
    delta: session.stake,
    type: "payout",
    game: "diceduel",
    ref: session.id,
    meta: { refund: true },
  });
  services.wallet.closeGame(session.id); // only the challenger has escrow at this point
}

function matchup(challengerId: string, opponentId: string): string {
  return `🎲 <@${challengerId}> vs <@${opponentId}>`;
}

/** One frame of the rolling animation; pass real dice for the final reveal, random faces while tumbling. */
function rollFrame(
  challengerId: string,
  opponentId: string,
  a: [number, number],
  b: [number, number],
  title = "🎲 Rolling…",
): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(Colors.gold)
    .setTitle(title)
    .setDescription(
      `${matchup(challengerId, opponentId)}\n\n` +
        `<@${challengerId}>: ${renderDice(a)}\n` +
        `<@${opponentId}>: ${renderDice(b)}`,
    );
}

const randPair = (): [number, number] => [intBetween(1, 6), intBetween(1, 6)];

/** Rematch buttons: same / half / double stake between the same two players. */
function rematchRow(aId: string, bId: string, stake: number): ActionRowBuilder<ButtonBuilder> {
  const buttons = replayStakes(stake, DD.minBet, DD.maxBet, "Rematch").map((o, i) =>
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "rematch", aId, bId, o.amt))
      .setLabel(o.label)
      .setStyle(i === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
}

async function onTimeout(session: DiceDuelSession): Promise<void> {
  if (session.finished || !session.message) return;
  await servicesRef.locks.run(`${session.guildId}:${session.challengerId}`, async () => {
    if (session.finished) return;
    session.finished = true;
    refundChallenger(session, servicesRef);
    const embed = new EmbedBuilder()
      .setColor(Colors.push)
      .setTitle("🎲 Dice duel — challenge expired")
      .setDescription(`⏱️ <@${session.opponentId}> didn't respond. The stake was refunded.`);
    await session.message!
      .edit({ embeds: [embed], components: [rematchRow(session.challengerId, session.opponentId, session.stake)] })
      .catch(() => {});
  });
}

async function startDuel(
  interaction: ChatInputCommandInteraction<"cached"> | ButtonInteraction<"cached">,
  services: Services,
  opponentId: string,
  stake: number,
): Promise<void> {
  const challengerId = interaction.user.id;
  const key = `${interaction.guildId}:${challengerId}`;

  await services.locks.run(key, async () => {
    services.wallet.ensureAccount(interaction.guildId, opponentId);

    const id = newId();
    try {
      services.wallet.placeBet({
        guildId: interaction.guildId,
        userId: challengerId,
        amount: stake,
        game: "diceduel",
        ref: id,
        channelId: interaction.channelId,
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await replyError(interaction, `You don't have enough chips. Your balance: ${formatChips(err.balance)}.`);
        return;
      }
      throw err;
    }

    const session: DiceDuelSession = {
      id,
      userId: challengerId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      challengerId,
      opponentId,
      stake,
      finished: false,
      startedAt: Date.now(),
    };
    getStore(services).create(session);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(cid(PREFIX, "accept", session.id)).setLabel("Accept").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(cid(PREFIX, "decline", session.id)).setLabel("Decline").setStyle(ButtonStyle.Danger),
    );
    const embed = new EmbedBuilder()
      .setColor(Colors.gold)
      .setTitle("🎲 Dice duel challenge")
      .setDescription(
        `<@${challengerId}> challenges <@${opponentId}> for **${formatChips(stake)}**!\n\n` +
          `Each rolls two dice — higher total wins. Pot: **${formatChips(stake * 2)}**, winner takes all.\n` +
          `<@${opponentId}>, do you accept?`,
      );
    await interaction.reply({
      content: `<@${opponentId}>`,
      embeds: [embed],
      components: [row],
      allowedMentions: { users: [opponentId] },
    });
    session.message = await interaction.fetchReply();
    services.wallet.setGameMessage(session.id, session.channelId, session.message.id);
  });
}

export const diceDuelCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("diceduel")
    .setDescription("Challenge another player to a dice duel for chips (higher 2d6 total wins)")
    .addUserOption((o) => o.setName("opponent").setDescription("Who to challenge").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("stake").setDescription("Stake from each player").setRequired(true).setMinValue(DD.minBet).setMaxValue(DD.maxBet),
    ),

  async execute(interaction, services) {
    const opponent = interaction.options.getUser("opponent", true);
    const stake = interaction.options.getInteger("stake", true);
    if (opponent.bot) {
      await replyError(interaction, "You can't challenge a bot.");
      return;
    }
    if (opponent.id === interaction.user.id) {
      await replyError(interaction, "You can't challenge yourself.");
      return;
    }
    await startDuel(interaction, services, opponent.id, stake);
  },
};

export const diceDuelComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    if (!interaction.isButton()) return;
    const { parts } = parseCid(interaction.customId);
    const action = parts[0];

    if (action === "rematch") {
      const [, aId, bId, stakeStr] = parts;
      const presser = interaction.user.id;
      const opponentId = presser === aId ? bId : presser === bId ? aId : null;
      if (!opponentId) {
        await interaction.reply({ content: "Only the two players can start a rematch.", flags: MessageFlags.Ephemeral });
        return;
      }
      const stake = Math.min(DD.maxBet, Math.max(DD.minBet, Number.parseInt(stakeStr ?? "0", 10)));
      await startDuel(interaction, services, opponentId, stake);
      return;
    }

    const sessionId = parts[1];
    const session = getStore(services).get(sessionId ?? "");
    if (!session || session.finished) {
      await interaction.reply({ content: "This challenge has ended.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== session.opponentId) {
      await interaction.reply({ content: "This challenge isn't directed at you.", flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === "decline") {
      await services.locks.run(`${session.guildId}:${session.challengerId}`, async () => {
        if (session.finished) return;
        session.finished = true;
        refundChallenger(session, services);
        getStore(services).delete(session.id);
        const embed = new EmbedBuilder()
          .setColor(Colors.push)
          .setTitle("🎲 Dice duel — declined")
          .setDescription(`<@${session.opponentId}> declined. The stake was refunded.`);
        await interaction.update({
          embeds: [embed],
          components: [rematchRow(session.challengerId, session.opponentId, session.stake)],
          allowedMentions: { parse: [] },
        });
      });
      return;
    }

    if (action === "accept") {
      await services.locks.run(`${session.guildId}:${session.opponentId}`, async () => {
        if (session.finished) return;

        try {
          services.wallet.placeBet({
            guildId: session.guildId,
            userId: session.opponentId,
            amount: session.stake,
            game: "diceduel",
            ref: session.id,
          });
        } catch (err) {
          if (err instanceof InsufficientFundsError) {
            await interaction.reply({
              content: `You don't have enough chips to accept (${formatChips(session.stake)}).`,
              flags: MessageFlags.Ephemeral,
            });
            return;
          }
          throw err;
        }

        session.finished = true;
        getStore(services).delete(session.id);

        const { a, b, aSum, bSum, challengerWins } = duelRoll();
        const winnerId = challengerWins ? session.challengerId : session.opponentId;
        const loserId = challengerWins ? session.opponentId : session.challengerId;
        const prize = session.stake * 2; // winner takes the whole pot (no rake)

        services.wallet.applyDelta({
          guildId: session.guildId,
          userId: winnerId,
          delta: prize,
          type: "payout",
          game: "diceduel",
          ref: session.id,
        });
        services.wallet.closeGame(session.id);

        services.rounds.record({
          game: "diceduel",
          guildId: session.guildId,
          userId: winnerId,
          wager: session.stake,
          payout: prize,
          outcome: "win",
          details: { opponent: loserId, rolls: { winner: challengerWins ? aSum : bSum, loser: challengerWins ? bSum : aSum } },
          startedAt: session.startedAt,
        });
        services.rounds.record({
          game: "diceduel",
          guildId: session.guildId,
          userId: loserId,
          wager: session.stake,
          payout: 0,
          outcome: "loss",
          details: { opponent: winnerId },
          startedAt: session.startedAt,
        });

        // Tumbling-dice animation (money is already settled above, so this is cosmetic).
        await interaction.update({
          content: "",
          embeds: [rollFrame(session.challengerId, session.opponentId, randPair(), randPair())],
          components: [],
        });
        for (let i = 1; i <= 6; i++) {
          await sleep(200);
          await interaction
            .editReply({ embeds: [rollFrame(session.challengerId, session.opponentId, randPair(), randPair())] })
            .catch(() => {});
        }

        const embed = new EmbedBuilder()
          .setColor(Colors.win)
          .setTitle("🎲 Dice duel — result")
          .setDescription(
            `${matchup(session.challengerId, session.opponentId)}\n\n` +
              `<@${session.challengerId}>: ${renderDice(a)} = **${aSum}**\n` +
              `<@${session.opponentId}>: ${renderDice(b)} = **${bSum}**\n\n` +
              `🏆 <@${winnerId}> wins **${formatChips(prize)}**! <@${loserId}> loses ${formatChips(session.stake)}.`,
          )
          .addFields({ name: "Winner's net", value: formatSigned(prize - session.stake), inline: true });
        await interaction.editReply({
          embeds: [embed],
          components: [rematchRow(session.challengerId, session.opponentId, session.stake)],
        });
      });
    }
  },
};

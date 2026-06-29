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
import { secureInt } from "./engine/rng.ts";
import { type SessionBase, SessionStore } from "../lib/sessions.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { replyError } from "../lib/reply.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "cf";
const CF = config.games.coinflip;

interface CoinflipSession extends SessionBase {
  guildId: string;
  channelId: string;
  challengerId: string;
  opponentId: string;
  stake: number;
  finished: boolean;
  startedAt: number;
  message?: Message;
}

let store: SessionStore<CoinflipSession>;
let servicesRef: Services;

function getStore(services: Services): SessionStore<CoinflipSession> {
  servicesRef ??= services;
  store ??= new SessionStore<CoinflipSession>(CF.challengeTimeoutSeconds * 1000, (s) => void onTimeout(s));
  return store;
}

function refundChallenger(session: CoinflipSession, services: Services): void {
  services.wallet.applyDelta({
    guildId: session.guildId,
    userId: session.challengerId,
    delta: session.stake,
    type: "payout",
    game: "coinflip",
    ref: session.id,
    meta: { refund: true },
  });
  services.wallet.closeGame(session.id); // only the challenger has escrow at this point
}

function coinArt(side: "HEADS" | "TAILS"): string {
  return ["```", "   ╭───────────╮", "   │           │", `   │   ${side}   │`, "   │           │", "   ╰───────────╯", "```"].join("\n");
}

function legend(challengerId: string, opponentId: string): string {
  return `🦅 **Heads** — <@${challengerId}>\n🌙 **Tails** — <@${opponentId}>`;
}

/** One frame of the coin-flip animation (faces alternate so the coin looks like it spins). */
function flipFrame(i: number, challengerId: string, opponentId: string): EmbedBuilder {
  const side = i % 2 === 0 ? "HEADS" : "TAILS";
  return new EmbedBuilder()
    .setColor(Colors.gold)
    .setTitle("🪙 Flipping…")
    .setDescription(`${legend(challengerId, opponentId)}\n${coinArt(side)}`);
}

/** Rematch buttons: same / half / double stake between the same two players. */
function rematchRow(aId: string, bId: string, stake: number): ActionRowBuilder<ButtonBuilder> {
  const half = Math.max(CF.minBet, Math.floor(stake / 2));
  const dbl = Math.min(CF.maxBet, stake * 2);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "rematch", aId, bId, stake))
      .setLabel(`Rematch (${stake})`)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "rematch", aId, bId, half))
      .setLabel(`½ (${half})`)
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "rematch", aId, bId, dbl))
      .setLabel(`2× (${dbl})`)
      .setStyle(ButtonStyle.Secondary),
  );
}

async function onTimeout(session: CoinflipSession): Promise<void> {
  if (session.finished || !session.message) return;
  await servicesRef.locks.run(`${session.guildId}:${session.challengerId}`, async () => {
    if (session.finished) return;
    session.finished = true;
    refundChallenger(session, servicesRef);
    const embed = new EmbedBuilder()
      .setColor(Colors.push)
      .setTitle("🪙 Coinflip — challenge expired")
      .setDescription(`⏱️ <@${session.opponentId}> didn't respond. The stake was refunded.`);
    await session.message!
      .edit({ embeds: [embed], components: [rematchRow(session.challengerId, session.opponentId, session.stake)] })
      .catch(() => {});
  });
}

async function startCoinflip(
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
        game: "coinflip",
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

    const session: CoinflipSession = {
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
      .setTitle("🪙 Coinflip challenge")
      .setDescription(
        `<@${challengerId}> challenges <@${opponentId}> for **${formatChips(stake)}**!\n\n` +
          `Pot: **${formatChips(stake * 2)}** — winner takes all.\n` +
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

export const coinflipCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Challenge another player to a coin flip for chips")
    .addUserOption((o) => o.setName("opponent").setDescription("Who to challenge").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("stake").setDescription("Stake from each player").setRequired(true).setMinValue(CF.minBet).setMaxValue(CF.maxBet),
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
    await startCoinflip(interaction, services, opponent.id, stake);
  },
};

export const coinflipComponent: ComponentHandler = {
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
      const stake = Math.min(CF.maxBet, Math.max(CF.minBet, Number.parseInt(stakeStr ?? "0", 10)));
      await startCoinflip(interaction, services, opponentId, stake);
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
          .setTitle("🪙 Coinflip — declined")
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
            game: "coinflip",
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

        const challengerWins = secureInt(2) === 0;
        const winnerId = challengerWins ? session.challengerId : session.opponentId;
        const loserId = challengerWins ? session.opponentId : session.challengerId;
        const prize = session.stake * 2; // winner takes the whole pot (no rake)

        services.wallet.applyDelta({
          guildId: session.guildId,
          userId: winnerId,
          delta: prize,
          type: "payout",
          game: "coinflip",
          ref: session.id,
        });
        services.wallet.closeGame(session.id);

        services.rounds.record({
          game: "coinflip",
          guildId: session.guildId,
          userId: winnerId,
          wager: session.stake,
          payout: prize,
          outcome: "win",
          details: { opponent: loserId },
          startedAt: session.startedAt,
        });
        services.rounds.record({
          game: "coinflip",
          guildId: session.guildId,
          userId: loserId,
          wager: session.stake,
          payout: 0,
          outcome: "loss",
          details: { opponent: winnerId },
          startedAt: session.startedAt,
        });

        // Coin-flip animation (money is already settled above, so this is cosmetic).
        await interaction.update({
          content: "",
          embeds: [flipFrame(0, session.challengerId, session.opponentId)],
          components: [],
        });
        for (let i = 1; i <= 5; i++) {
          await sleep(520);
          await interaction.editReply({ embeds: [flipFrame(i, session.challengerId, session.opponentId)] }).catch(() => {});
        }

        const landed: "HEADS" | "TAILS" = challengerWins ? "HEADS" : "TAILS";
        const sideLabel = challengerWins ? "Heads 🦅" : "Tails 🌙";
        const embed = new EmbedBuilder()
          .setColor(Colors.win)
          .setTitle("🪙 Coin flip — result")
          .setDescription(
            `${legend(session.challengerId, session.opponentId)}\n${coinArt(landed)}\n` +
              `It landed on **${sideLabel}** — 🏆 <@${winnerId}> wins **${formatChips(prize)}**!\n` +
              `<@${loserId}> loses ${formatChips(session.stake)}.`,
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

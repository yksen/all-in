import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, ComponentHandler } from "../framework/types.ts";
import type { Services } from "../services.ts";
import { type Card, Shoe } from "./engine/deck.ts";
import { decideWinner, playHand, type Side, settle, total, type Winner } from "./engine/baccarat.ts";
import { type CardView, renderCards } from "../ui/cards.ts";
import { cid, newId, parseCid } from "../lib/ids.ts";
import { formatChips, formatSigned } from "../lib/money.ts";
import { Colors } from "../ui/theme.ts";
import { config } from "../config.ts";
import { InsufficientFundsError } from "../economy/wallet.ts";
import { sleep } from "../lib/sleep.ts";

const PREFIX = "bac";
const BAC = config.games.baccarat;

const SIDE_EMOJI: Record<Side, string> = { player: "🟦", banker: "🟥", tie: "🟩" };
const SIDE_LABEL: Record<Side, string> = { player: "Player", banker: "Banker", tie: "Tie" };

/** The three betting boxes, at a fixed stake. Same buttons open the table and offer a rebet. */
function boxRow(bet: number, invokerId: string): ActionRowBuilder<ButtonBuilder> {
  const bankerOdds = `${(100 - BAC.bankerCommissionPct) / 100}:1`; // e.g. "0.95:1"
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "bet", "player", bet, invokerId))
      .setLabel("Player 1:1")
      .setEmoji(SIDE_EMOJI.player)
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "bet", "banker", bet, invokerId))
      .setLabel(`Banker ${bankerOdds}`)
      .setEmoji(SIDE_EMOJI.banker)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(cid(PREFIX, "bet", "tie", bet, invokerId))
      .setLabel(`Tie ${BAC.tiePayout}:1`)
      .setEmoji(SIDE_EMOJI.tie)
      .setStyle(ButtonStyle.Secondary),
  );
}

const views = (n: number, v: CardView): CardView[] => Array.from({ length: n }, () => v);

/** One reveal frame: the two hands with per-card views; totals shown only when a side is defined. */
function frame(opts: {
  player: Card[];
  banker: Card[];
  pViews: CardView[];
  bViews: CardView[];
  pTotal?: number;
  bTotal?: number;
  color: number;
  desc?: string;
}): EmbedBuilder {
  const pTotal = opts.pTotal !== undefined ? `\n**Total: ${opts.pTotal}**` : "";
  const bTotal = opts.bTotal !== undefined ? `\n**Total: ${opts.bTotal}**` : "";
  const embed = new EmbedBuilder().setColor(opts.color).setTitle("🀄 Baccarat");
  if (opts.desc) embed.setDescription(opts.desc);
  return embed.addFields(
    { name: `${SIDE_EMOJI.player} Player`, value: `${renderCards(opts.player, opts.pViews)}${pTotal}` },
    { name: `${SIDE_EMOJI.banker} Banker`, value: `${renderCards(opts.banker, opts.bViews)}${bTotal}` },
  );
}

function resultDesc(betOn: Side, win: Winner, ret: number, bet: number): string {
  const winLine = win === "tie" ? "🟩 **Tie**" : `${SIDE_EMOJI[win]} **${SIDE_LABEL[win]} wins**`;
  const yours =
    ret === 0
      ? `You bet ${SIDE_LABEL[betOn]} — lost ${formatChips(bet)}.`
      : ret === bet
        ? `Your ${SIDE_LABEL[betOn]} bet pushes — stake returned.`
        : `You bet ${SIDE_LABEL[betOn]} — won ${formatChips(ret - bet)}! 🏆`;
  return `${winLine}\n${yours}`;
}

/** Post a fresh table prompt (slash command only). No money moves until a box is tapped. */
async function startTable(interaction: ChatInputCommandInteraction<"cached">, services: Services, bet: number): Promise<void> {
  services.wallet.ensureAccount(interaction.guildId, interaction.user.id);
  const balance = services.wallet.getBalance(interaction.guildId, interaction.user.id);
  const bankerOdds = `${(100 - BAC.bankerCommissionPct) / 100}:1`;
  const embed = new EmbedBuilder()
    .setColor(Colors.brand)
    .setAuthor({ name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() })
    .setTitle("🀄 Baccarat")
    .setDescription(
      `Wager **${formatChips(bet)}** — tap a box to deal:\n\n` +
        `${SIDE_EMOJI.player} **Player** — pays 1:1\n` +
        `${SIDE_EMOJI.banker} **Banker** — pays ${bankerOdds} (${BAC.bankerCommissionPct}% commission)\n` +
        `${SIDE_EMOJI.tie} **Tie** — pays ${BAC.tiePayout}:1\n\n` +
        `Both sides draw toward **9**; tens and face cards count as 0.\n` +
        `You have **${formatChips(balance)}**.`,
    );
  await interaction.reply({ embeds: [embed], components: [boxRow(bet, interaction.user.id)] });
}

/** Deal, settle the money, then play the reveal animation and offer a rebet. */
async function playRound(
  interaction: ButtonInteraction<"cached">,
  services: Services,
  betOn: Side,
  bet: number,
  invokerId: string,
): Promise<void> {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  await services.locks.run(`${guildId}:${userId}`, async () => {
    const startedAt = Date.now();
    const ref = newId();
    try {
      services.wallet.placeBet({ guildId, userId, amount: bet, game: "baccarat", ref, channelId: interaction.channelId, meta: { betOn } });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await interaction.reply({ content: `You don't have enough chips. Your balance: ${formatChips(err.balance)}.`, flags: MessageFlags.Ephemeral });
        return;
      }
      throw err;
    }

    // Settle first (matches "settle-then-animate"): the coup is resolved and paid out
    // before any cosmetic frames, so a crash mid-animation can't lose or double-pay chips.
    const shoe = new Shoe(8); // ponytail: fresh 8-deck shoe per hand; no persistent shoe / counting
    const { player, banker } = playHand(() => shoe.draw());
    const win = decideWinner(player, banker);
    const { ret, outcome } = settle(bet, betOn, win, BAC);
    if (ret > 0) services.wallet.applyDelta({ guildId, userId, delta: ret, type: "payout", game: "baccarat", ref });
    services.wallet.closeGame(ref);
    services.rounds.record({
      game: "baccarat",
      guildId,
      userId,
      wager: bet,
      payout: ret,
      outcome,
      details: { betOn, win, player: total(player), banker: total(banker) },
      startedAt,
    });

    const author = { name: interaction.user.displayName, iconURL: interaction.user.displayAvatarURL() };
    const p2 = player.slice(0, 2);
    const b2 = banker.slice(0, 2);

    // Opening two cards each: dealt face-down, flipped edge-on, then revealed.
    await interaction.update({
      embeds: [frame({ player: p2, banker: b2, pViews: views(2, "back"), bViews: views(2, "back"), color: Colors.table }).setAuthor(author)],
      components: [],
    });
    await sleep(450);
    await interaction
      .editReply({ embeds: [frame({ player: p2, banker: b2, pViews: views(2, "flip"), bViews: views(2, "flip"), color: Colors.table }).setAuthor(author)] })
      .catch(() => {});
    await sleep(350);
    await interaction
      .editReply({
        embeds: [
          frame({ player: p2, banker: b2, pViews: views(2, "face"), bViews: views(2, "face"), pTotal: total(p2), bTotal: total(b2), color: Colors.table }).setAuthor(author),
        ],
      })
      .catch(() => {});
    await sleep(700);

    // Third cards (if the tableau drew them), player then banker.
    if (player.length === 3) {
      await interaction
        .editReply({
          embeds: [frame({ player, banker: b2, pViews: ["face", "face", "flip"], bViews: views(2, "face"), bTotal: total(b2), color: Colors.table }).setAuthor(author)],
        })
        .catch(() => {});
      await sleep(350);
      await interaction
        .editReply({
          embeds: [
            frame({ player, banker: b2, pViews: views(3, "face"), bViews: views(2, "face"), pTotal: total(player), bTotal: total(b2), color: Colors.table }).setAuthor(author),
          ],
        })
        .catch(() => {});
      await sleep(600);
    }
    if (banker.length === 3) {
      await interaction
        .editReply({
          embeds: [
            frame({ player, banker, pViews: views(player.length, "face"), bViews: ["face", "face", "flip"], pTotal: total(player), color: Colors.table }).setAuthor(author),
          ],
        })
        .catch(() => {});
      await sleep(350);
      await interaction
        .editReply({
          embeds: [
            frame({ player, banker, pViews: views(player.length, "face"), bViews: views(3, "face"), pTotal: total(player), bTotal: total(banker), color: Colors.table }).setAuthor(author),
          ],
        })
        .catch(() => {});
      await sleep(600);
    }

    // Final settlement frame + rebet boxes at the same stake.
    const net = ret - bet;
    const balance = services.wallet.getBalance(guildId, userId);
    const result = frame({
      player,
      banker,
      pViews: views(player.length, "face"),
      bViews: views(banker.length, "face"),
      pTotal: total(player),
      bTotal: total(banker),
      color: net > 0 ? Colors.win : net < 0 ? Colors.loss : Colors.push,
      desc: resultDesc(betOn, win, ret, bet),
    })
      .setAuthor(author)
      .addFields({ name: "Net", value: `${formatSigned(net)} • balance: **${formatChips(balance)}**` });
    await interaction.editReply({ embeds: [result], components: [boxRow(bet, invokerId)] }).catch(() => {});
  });
}

export const baccaratCommand: Command = {
  data: new SlashCommandBuilder()
    .setName("baccarat")
    .setDescription("Play baccarat — bet on Player, Banker, or Tie")
    .addIntegerOption((o) =>
      o.setName("bet").setDescription("How many chips to wager").setRequired(true).setMinValue(BAC.minBet).setMaxValue(BAC.maxBet),
    ),

  async execute(interaction, services) {
    const bet = interaction.options.getInteger("bet", true);
    await startTable(interaction, services, bet);
  },
};

export const baccaratComponent: ComponentHandler = {
  prefix: PREFIX,
  async handle(interaction, services) {
    if (!interaction.isButton()) return;
    const { parts } = parseCid(interaction.customId);
    // parts: ["bet", side, amount, invokerId]
    if (parts[0] !== "bet") return;
    const betOn = parts[1] as Side;
    const invokerId = parts[3] ?? "";

    if (interaction.user.id !== invokerId) {
      await interaction.reply({
        content: `This table is <@${invokerId}>'s — run \`/baccarat\` to play your own.`,
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      return;
    }

    const bet = Math.min(BAC.maxBet, Math.max(BAC.minBet, Number.parseInt(parts[2] ?? "0", 10)));
    await playRound(interaction, services, betOn, bet, invokerId);
  },
};

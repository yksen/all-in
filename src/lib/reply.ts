import { MessageFlags, type RepliableInteraction } from "discord.js";

/** Reply (or follow up) with an ephemeral error, regardless of interaction state. */
export async function replyError(
  interaction: RepliableInteraction,
  message: string,
): Promise<void> {
  const payload = { content: `⚠️ ${message}`, flags: MessageFlags.Ephemeral as const };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch {
    // The interaction token may have expired; nothing more we can do.
  }
}

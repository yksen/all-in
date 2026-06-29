import type { Services } from "../services.ts";

/**
 * Flat-rate voice earning. On every tick we read the *current* voice state from the
 * gateway cache and credit each eligible member a fixed amount. Reading current
 * state (rather than tracking join/leave deltas) makes this naturally crash-safe:
 * a restart just resumes crediting whoever is in voice now.
 *
 * Eligibility: a non-bot member, in a voice channel that is neither the server's
 * Inactive/AFK channel nor an explicitly excluded one, not self-muted/deafened
 * (configurable), in a channel with at least `minHumansInChannel` humans (anti
 * solo-farming). Requires the GuildVoiceStates intent.
 */
export class VoiceTracker {
  private interval?: ReturnType<typeof setInterval>;

  constructor(private readonly services: Services) {}

  start(): void {
    const { tickSeconds } = this.services.config.economy.voice;
    this.interval = setInterval(() => this.tick(), tickSeconds * 1000);
    this.services.logger.info({ tickSeconds }, "voice: earning loop started");
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
  }

  private tick(): void {
    const { config, client, wallet, logger } = this.services;
    const { amountPerTick, minHumansInChannel, payWhileSelfMuted, payWhileSelfDeafened, excludedChannelIds } =
      config.economy.voice;
    const excluded = new Set(excludedChannelIds);

    let credited = 0;
    for (const guild of client.guilds.cache.values()) {
      const afkChannelId = guild.afkChannelId;

      for (const voiceState of guild.voiceStates.cache.values()) {
        const member = voiceState.member;
        if (!member || member.user.bot) continue;
        if (!voiceState.channelId || voiceState.channelId === afkChannelId) continue;
        if (excluded.has(voiceState.channelId)) continue;
        if (!payWhileSelfMuted && voiceState.selfMute) continue;
        if (!payWhileSelfDeafened && voiceState.selfDeaf) continue;

        const channel = voiceState.channel;
        const humans = channel
          ? channel.members.filter((m) => !m.user.bot).size
          : 0;
        if (humans < minHumansInChannel) continue;

        try {
          // Grant the one-time welcome bonus here too: a member can start earning from
          // voice before ever running a command, and they should still receive it
          // (ensureAccount is idempotent — it only grants once).
          wallet.ensureAccount(guild.id, member.id);
          wallet.applyDelta({
            guildId: guild.id,
            userId: member.id,
            delta: amountPerTick,
            type: "earn_voice",
            meta: { channelId: voiceState.channelId },
          });
          credited++;
        } catch (err) {
          logger.error({ err, userId: member.id }, "voice: failed to credit");
        }
      }
    }

    if (credited > 0) logger.debug({ credited }, "voice: tick credited members");
  }
}

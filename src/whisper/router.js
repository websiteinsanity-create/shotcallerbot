'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  createAudioResource,
  StreamType,
} = require('discord.js');
const log = require('../logger');

/**
 * WhisperRouter
 *
 * Party 1  → any member may whisper (no restriction)
 * Party 2–12 → one assigned whisperer per party
 *
 * Whisper audio captured from relay bots is piped into the main bot's
 * voice connection so the Shotcaller can hear it.
 */
class WhisperRouter {
  constructor(mainClient) {
    this._main = mainClient;
    /** guildId → { partyIndex: userId } */
    this._config = new Map();
  }

  // ── Config ─────────────────────────────────────────────────────────────────

  setWhisperer(guildId, partyIndex, userId) {
    if (!this._config.has(guildId)) this._config.set(guildId, {});
    this._config.get(guildId)[partyIndex] = userId;
    log.info(`Whisper config: guild ${guildId} party ${partyIndex} → user ${userId}`);
  }

  getConfig(guildId) {
    return this._config.get(guildId) ?? {};
  }

  /**
   * Returns true if userId is allowed to whisper from partyIndex.
   * Party 1: always true.
   * Parties 2+: only the assigned whisperer.
   */
  isAllowedWhisperer(guildId, partyIndex, userId) {
    if (partyIndex === 1) return true;
    const config = this._config.get(guildId) ?? {};
    return config[partyIndex] === userId;
  }

  // ── Audio routing ──────────────────────────────────────────────────────────

  /**
   * Route an Opus stream from a relay party back to the main bot's voice connection,
   * so the Shotcaller hears the whisper.
   */
  routeToMain(guildId, opusStream, userId, partyIndex) {
    const session = this._main.sessions.get(guildId);
    if (!session?.mainConnection) return;

    log.debug(`Routing whisper from user ${userId} (party ${partyIndex}) → main`);

    // We subscribe the stream as an audio resource on the main bot's player.
    // In practice you'd want a mixer; for a self-hosted setup one whisper at a
    // time is the typical use case, so a simple play is sufficient.
    const resource = createAudioResource(opusStream, { inputType: StreamType.Opus });
    const { createAudioPlayer, AudioPlayerStatus } = require('@discordjs/voice');

    // Use a throw-away player per whisper so it doesn't interrupt music
    const player = createAudioPlayer();
    session.mainConnection.subscribe(player);
    player.play(resource);
    player.once(AudioPlayerStatus.Idle, () => player.stop());
  }

  // ── Voice state updates ────────────────────────────────────────────────────

  handleVoiceStateUpdate(oldState, newState) {
    // Could be extended to clear whisper config when a user leaves the server.
  }

  // ── Discord UI panel ───────────────────────────────────────────────────────

  async sendSetupPanel(interaction) {
    const session = this._main.sessions.get(interaction.guild.id);
    const partyCount = session?.partyCount ?? 12;
    const config = this.getConfig(interaction.guild.id);

    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('🔊 Whisper Routing Setup')
      .setDescription(
        '**Party 1:** any member may whisper.\n' +
        `**Parties 2–${partyCount}:** one assigned whisperer each.\n\n` +
        'Current assignments:\n' +
        Array.from({ length: partyCount - 1 }, (_, i) => {
          const p = i + 2;
          const uid = config[p];
          return `Party **${p}**: ${uid ? `<@${uid}>` : '_Not set_'}`;
        }).join('\n')
      )
      .setFooter({ text: 'Use /whisper set <party> <user> to assign whisperers.' });

    // Quick-action buttons for clearing assignments
    const rows = [];
    for (let p = 2; p <= Math.min(partyCount, 5); p++) {
      const btn = new ButtonBuilder()
        .setCustomId(`whisper:clear:${p}`)
        .setLabel(`Clear Party ${p}`)
        .setStyle(ButtonStyle.Danger);
      if (!rows.length || rows[rows.length - 1].components.length >= 5) {
        rows.push(new ActionRowBuilder());
      }
      rows[rows.length - 1].addComponents(btn);
    }

    await interaction.editReply({ embeds: [embed], components: rows });
  }

  async handleButton(interaction, parts) {
    const [action, partyStr] = parts;
    if (action === 'clear') {
      const party = parseInt(partyStr, 10);
      const config = this._config.get(interaction.guild.id) ?? {};
      delete config[party];
      this._config.set(interaction.guild.id, config);
      await interaction.reply({ content: `✅ Party **${party}** whisperer cleared.`, ephemeral: true });
    }
  }

  async handleSelect() {
    // Reserved for future dropdown-based assignment UI
  }
}

module.exports = { WhisperRouter };

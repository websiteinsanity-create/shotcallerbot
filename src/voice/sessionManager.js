'use strict';

const {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
} = require('@discordjs/voice');
const log = require('../logger');

/**
 * One active session per guild.
 * Stores the main voice connection, party channel IDs, mute state, etc.
 */
class SessionManager {
  constructor() {
    /** @type {Map<string, Session>} guildId → Session */
    this._sessions = new Map();
  }

  get(guildId) {
    return this._sessions.get(guildId) ?? null;
  }

  count() {
    return this._sessions.size;
  }

  /** Start a new session for the guild. */
  async start(client, guild, textChannel, partyCount, mode) {
    if (this._sessions.has(guild.id)) {
      await this.stop(client, guild);
    }

    // The Shotcaller joins party 1 (first party channel)
    const category = guild.channels.cache.find(
      c => c.name === (process.env.PARTY_CATEGORY_NAME || 'Shotcaller Parties') && c.type === 4,
    );
    if (!category) throw new Error('Party category not found. Run `/shotcaller start` first to create channels.');

    const partyChannels = guild.channels.cache
      .filter(c => c.parentId === category.id && c.type === 2)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map(c => c.id);

    if (!partyChannels.length) throw new Error('No party voice channels found.');

    // Connect main bot to party 1
    const mainChannel = guild.channels.cache.get(partyChannels[0]);
    const connection = joinVoiceChannel({
      channelId:      mainChannel.id,
      guildId:        guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:       false,
      selfMute:       false,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 10_000).catch(() => {
      throw new Error('Could not connect to voice channel within 10 s.');
    });

    const session = {
      guildId:         guild.id,
      textChannelId:   textChannel.id,
      mode,
      partyCount,
      partyChannelIds: partyChannels,
      mainConnection:  connection,
      muted:           false,
      dedicatedCaller: null,
      currentSpeaker:  null,
      startedAt:       Date.now(),
    };

    this._sessions.set(guild.id, session);
    log.info(`Session started for guild ${guild.id} — ${mode} mode, ${partyCount} parties`);

    // Wire up relay bots
    await client.relays.connectToParties(guild, partyChannels.slice(1));

    return session;
  }

  async stop(client, guild) {
    const session = this._sessions.get(guild.id);
    if (!session) return;

    // Stop music
    client.music.stop();

    // Disconnect relay bots
    await client.relays.disconnectFromParties(guild.id);

    // Disconnect main bot
    const conn = getVoiceConnection(guild.id);
    if (conn) conn.destroy();

    this._sessions.delete(guild.id);
    log.info(`Session stopped for guild ${guild.id}`);
  }

  setMuted(guildId, muted) {
    const s = this._sessions.get(guildId);
    if (s) s.muted = muted;
  }

  setDedicatedCaller(guildId, userId) {
    const s = this._sessions.get(guildId);
    if (s) {
      s.dedicatedCaller = userId;
      s.currentSpeaker  = userId; // immediately apply
    }
  }

  /** Called from voiceStateUpdate — tracks who is speaking for auto-speaker. */
  handleVoiceStateUpdate(oldState, newState) {
    // No-op here; actual speaking detection happens in RelayManager audio pipelines.
    // This hook can be extended to react to channel moves.
  }

  /** Update the auto-selected current speaker (called by RelayManager). */
  setCurrentSpeaker(guildId, userId) {
    const s = this._sessions.get(guildId);
    if (s && !s.dedicatedCaller) {
      s.currentSpeaker = userId;
    }
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  export() {
    const out = {};
    for (const [gid, s] of this._sessions) {
      out[gid] = {
        mode:            s.mode,
        partyCount:      s.partyCount,
        partyChannelIds: s.partyChannelIds,
        muted:           s.muted,
        dedicatedCaller: s.dedicatedCaller,
        textChannelId:   s.textChannelId,
        startedAt:       s.startedAt,
      };
    }
    return out;
  }

  restore(saved) {
    // Sessions need live voice connections — we only restore metadata here.
    // Full voice reconnection happens in RelayManager.startAll().
    log.info(`Restored ${Object.keys(saved).length} session metadata entries.`);
  }
}

module.exports = { SessionManager };

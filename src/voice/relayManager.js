'use strict';

const {
  Client,
  GatewayIntentBits,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  getVoiceConnection,
  EndBehaviorType,
} = require('@discordjs/voice');
const { PassThrough } = require('stream');
const log = require('../logger');

/**
 * RelayManager
 * ─ Boots one Discord bot per relay token.
 * ─ Connects each relay bot to its assigned party channel.
 * ─ Receives audio from the main bot's connection and broadcasts it to every
 *   relay bot's audio player so all party channels hear the Shotcaller.
 * ─ Receives whisper audio from each relay bot and pipes it back to main.
 */
class RelayManager {
  constructor(mainClient) {
    this._main   = mainClient;
    /** @type {{ client: Client, token: string, partyChannelId: string|null, connection: any, player: any }[]} */
    this._relays = [];
  }

  async startAll() {
    const tokens = (process.env.RELAY_BOT_TOKENS || '').split(',').map(t => t.trim()).filter(Boolean);
    log.info(`Starting ${tokens.length} relay bot(s)…`);

    for (let i = 0; i < tokens.length; i++) {
      const relay = {
        index:          i,
        token:          tokens[i],
        client:         null,
        partyChannelId: null,
        connection:     null,
        player:         createAudioPlayer(),
        connected:      false,
      };

      relay.client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      });

      relay.client.once('ready', () => {
        log.info(`Relay bot ${i + 1} online: ${relay.client.user.tag}`);
        relay.connected = true;
      });

      relay.client.on('error', (err) => log.error(`Relay bot ${i + 1} error:`, err));

      await relay.client.login(relay.token).catch(err => {
        log.error(`Relay bot ${i + 1} login failed:`, err.message);
      });

      this._relays.push(relay);
    }
  }

  /** Connect relay bots to the given party channel IDs (index 0 = party 2). */
  async connectToParties(guild, partyChannelIds) {
    for (let i = 0; i < partyChannelIds.length && i < this._relays.length; i++) {
      const relay  = this._relays[i];
      const chanId = partyChannelIds[i];

      if (!relay.connected) {
        log.warn(`Relay bot ${i + 1} not connected — skipping party ${i + 2}`);
        continue;
      }

      // Find the channel from the relay bot's perspective
      const relayGuild = relay.client.guilds.cache.get(guild.id);
      if (!relayGuild) {
        log.warn(`Relay bot ${i + 1} not in guild ${guild.id}`);
        continue;
      }

      relay.partyChannelId = chanId;

      const conn = joinVoiceChannel({
        channelId:      chanId,
        guildId:        guild.id,
        adapterCreator: relayGuild.voiceAdapterCreator,
        selfDeaf:       false,
        selfMute:       false,
      });

      try {
        await entersState(conn, VoiceConnectionStatus.Ready, 10_000);
        relay.connection = conn;
        conn.subscribe(relay.player);
        log.info(`Relay bot ${i + 1} connected to party channel ${chanId}`);

        // Start receiving whisper audio from this party's channel
        this._startWhisperReceive(guild.id, relay, i + 2);
      } catch {
        log.warn(`Relay bot ${i + 1} failed to connect to channel ${chanId}`);
      }
    }
  }

  /**
   * Broadcast an audio resource to all connected relay bots.
   * Called by the broadcast pipeline (e.g. after creating a mixed PCM stream).
   */
  broadcast(resource) {
    for (const relay of this._relays) {
      if (relay.connection && relay.player) {
        const r = createAudioResource(resource.stream, { inputType: resource.inputType });
        relay.player.play(r);
      }
    }
  }

  /**
   * Pipe the main bot's speaking into a broadcast stream to all relays.
   * This creates a pass-through pipeline from the main voice receiver.
   */
  startBroadcastPipeline(mainConnection, guildId) {
    const receiver = mainConnection.receiver;

    receiver.speaking.on('start', (userId) => {
      const session = this._main.sessions.get(guildId);
      if (!session || session.muted) return;

      // Auto-speaker tracking
      if (!session.dedicatedCaller) {
        this._main.sessions.setCurrentSpeaker(guildId, userId);
      }

      // Only relay audio from the designated speaker
      const activeSpeaker = session.dedicatedCaller || session.currentSpeaker;
      if (userId !== activeSpeaker) return;

      const audioStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 100 },
      });

      const pass = new PassThrough();
      audioStream.pipe(pass);

      const resource = createAudioResource(pass, { inputType: StreamType.Opus });
      for (const relay of this._relays) {
        if (relay.connection) {
          const r = createAudioResource(pass, { inputType: StreamType.Opus });
          relay.player.play(r);
        }
      }
    });
  }

  /**
   * Listen for whisper audio in a party channel and route it to the main bot.
   */
  _startWhisperReceive(guildId, relay, partyIndex) {
    if (!relay.connection) return;

    relay.connection.receiver.speaking.on('start', (userId) => {
      const router = this._main.whisper;
      if (!router.isAllowedWhisperer(guildId, partyIndex, userId)) return;

      const stream = relay.connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: parseInt(process.env.WHISPER_SILENCE_MS || '700') },
      });

      router.routeToMain(guildId, stream, userId, partyIndex);
    });
  }

  async disconnectFromParties(guildId) {
    for (const relay of this._relays) {
      if (relay.connection) {
        relay.connection.destroy();
        relay.connection     = null;
        relay.partyChannelId = null;
      }
      relay.player.stop();
    }
    log.info(`All relay bots disconnected from guild ${guildId}`);
  }

  async destroyAll() {
    for (const relay of this._relays) {
      if (relay.connection) relay.connection.destroy();
      relay.client?.destroy();
    }
    this._relays = [];
  }

  connectedCount() {
    return this._relays.filter(r => r.connected).length;
  }
}

module.exports = { RelayManager };

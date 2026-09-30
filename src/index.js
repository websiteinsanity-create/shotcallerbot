'use strict';
require('dotenv').config();

const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const http = require('http');
const { registerCommands } = require('./commands/register');
const { handleInteraction } = require('./commands/handler');
const { RelayManager } = require('./voice/relayManager');
const { SessionManager } = require('./voice/sessionManager');
const { MusicPlayer } = require('./music/player');
const { WhisperRouter } = require('./whisper/router');
const { BridgeManager } = require('./bridge/bridge');
const { GuildManager } = require('./guild/manager');
const { loadRuntime, saveRuntime } = require('./state');
const log = require('./logger');

// ── Validate required env vars ───────────────────────────────────────────────
const REQUIRED = ['MAIN_BOT_TOKEN', 'CLIENT_ID', 'RELAY_BOT_TOKENS'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    log.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const PORT = parseInt(process.env.PORT || '8787', 10);

// ── Build main client ────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ── Shared managers (attached to client for access in handlers) ───────────────
client.sessions = new SessionManager();
client.relays   = new RelayManager(client);
client.music    = new MusicPlayer();
client.whisper  = new WhisperRouter(client);
client.bridge   = new BridgeManager(client);
client.guild    = new GuildManager(client);
client.commands = new Collection();

// ── Ready ────────────────────────────────────────────────────────────────────
client.once('ready', async () => {
  log.info(`Main bot online: ${client.user.tag}`);

  // Restore any previous session state
  const saved = await loadRuntime();
  if (saved) client.sessions.restore(saved);

  // Register slash commands
  await registerCommands(client);

  // Start relay bots
  await client.relays.startAll();

  // Start bridge if configured
  if (process.env.BRIDGE_PARTNERS) {
    await client.bridge.init();
  }

  log.info('Shotcaller ready.');
});

// ── Interactions ─────────────────────────────────────────────────────────────
client.on('interactionCreate', (interaction) => handleInteraction(client, interaction));

// ── Voice state updates ──────────────────────────────────────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  client.whisper.handleVoiceStateUpdate(oldState, newState);
  client.sessions.handleVoiceStateUpdate(oldState, newState);
});

// ── Save state periodically ───────────────────────────────────────────────────
setInterval(async () => {
  await saveRuntime(client.sessions.export());
}, 30_000);

// ── HTTP health endpoint ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    const status = client.isReady() ? 'ok' : 'starting';
    res.writeHead(client.isReady() ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      tag: client.user?.tag ?? null,
      sessions: client.sessions.count(),
      relays: client.relays.connectedCount(),
      uptime: process.uptime(),
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(PORT, () => log.info(`Health endpoint listening on port ${PORT}`));

// ── Graceful shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal) {
  log.info(`${signal} received — shutting down`);
  await saveRuntime(client.sessions.export());
  await client.relays.destroyAll();
  client.destroy();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Login ─────────────────────────────────────────────────────────────────────
client.login(process.env.MAIN_BOT_TOKEN).catch((err) => {
  log.error('Failed to login main bot:', err);
  process.exit(1);
});

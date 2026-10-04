const { Client, GatewayIntentBits } = require("discord.js");
const { watchSpeakingFlags } = require("./speakingflags");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  StreamType, entersState, VoiceConnectionStatus
} = require("@discordjs/voice");

function withTimeout(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error(message)), ms); })])
    .finally(() => clearTimeout(t));
}

class Relay {
  constructor(token, index, opts = {}) {
    this.token = token;
    this.index = index;
    this.onFlags = opts.onFlags || null; // called with (userId, speakingFlags) from the raw voice socket
    this.readyTimeoutMs = opts.readyTimeoutMs || 20000; // login -> client ready
    this.voiceTimeoutMs = opts.voiceTimeoutMs || 20000; // join -> voice connection ready
    this.maxAttempts = opts.maxAttempts || 3;           // startup: join tries before giving up on this relay
    this.graceMs = opts.graceMs || 5000;                // after a drop: wait this long for a self-recovery before rejoining
    this.rejoins = 0;
    this.client = new Client({
      intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]
    });
    this.connection = null;
    this.voicePlayer = createAudioPlayer();
    this.client.once("ready",()=>console.log(`[relay ${index+1}] ${this.client.user.tag} ready`));
    this.client.on("error",e=>console.error(`[relay ${index+1}] client error:`,e));
    this.voicePlayer.on("error",e=>console.error(`[relay ${index+1}] player error:`,e));
    this.voicePlayer.on("stateChange",(oldS,newS)=>console.log(`[relay ${index+1}] player: ${oldS.status} -> ${newS.status}`));
  }

  async login(){
    // client.login() can resolve before the gateway has finished logging the bot in. Joining voice in that
    // gap leaves the connection stuck at "disconnected" (the voice-state message can't be sent yet), so
    // wait for the client's own ready event first. Both names are listened for: it was renamed in discord.js 14.22.
    const ready = new Promise(resolve => {
      this.client.once("clientReady", resolve);
      this.client.once("ready", resolve);
    });
    await this.client.login(this.token);
    await withTimeout(ready, this.readyTimeoutMs, `Relay ${this.index+1} logged in but never became ready`);
  }

  _join(channel,guildId){
    this.connection = joinVoiceChannel({
      channelId:channel.id,guildId,
      adapterCreator:channel.guild.voiceAdapterCreator,
      // Not deafened: every relay doubles as the ear for its own party (it captures additional callers),
      // and as far as I know a deafened connection is not sent other people's audio.
      selfDeaf:false,selfMute:false,
      group:`shotcaller-relay-${this.index}`
    });
    this.connection.on("error",e=>console.error(`[relay ${this.index+1}] connection error:`,e));
    this.connection.on("stateChange",(oldS,newS)=>console.log(`[relay ${this.index+1}] connection: ${oldS.status} -> ${newS.status}`));
    this.connection.subscribe(this.voicePlayer);
    watchSpeakingFlags(this.connection,`relay ${this.index+1}`,this.onFlags);
    console.log(`[relay ${this.index+1}] connected to channel "${channel.name}", initial status: ${this.connection.state.status}`);
  }

  async connect(channelId,guildId){
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Relay ${this.index+1}: channel unavailable`);
    // Don't call the relay "up" until its voice connection really is — a relay stuck anywhere else would
    // otherwise leave its party silent while the session looks like it started fine. With a dozen relays
    // joining, the odd one stumbles, so give each a few tries before failing the session.
    let lastStatus = "unknown";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this._join(channel,guildId);
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, this.voiceTimeoutMs);
        this._watchDrops();
        return;
      } catch {
        lastStatus = this.connection.state.status;
        console.log(`[relay ${this.index+1}] attempt ${attempt}/${this.maxAttempts} to join "${channel.name}" did not reach ready (status "${lastStatus}")`);
        try { this.connection.destroy(); } catch {}
        this.connection = null;
      }
    }
    throw new Error(`Relay ${this.index+1} could not establish voice in "${channel.name}" after ${this.maxAttempts} attempts (last status "${lastStatus}")`);
  }

  // A connection that drops mid-session stays dropped unless something rejoins it. Discord moving us to
  // another voice server shows up as signalling/connecting within moments; anything else we rejoin.
  _watchDrops(){
    const conn = this.connection;
    conn.on(VoiceConnectionStatus.Ready, () => { this.rejoins = 0; });
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, this.graceMs),
          entersState(conn, VoiceConnectionStatus.Connecting, this.graceMs)
        ]);
      } catch {
        if (this.connection !== conn || conn.state.status === VoiceConnectionStatus.Destroyed) return;
        if (this.rejoins >= 5) { console.error(`[relay ${this.index+1}] still disconnected after ${this.rejoins} rejoin attempts — giving up on this relay`); return; }
        this.rejoins++;
        console.log(`[relay ${this.index+1}] dropped — rejoining (attempt ${this.rejoins})`);
        try { conn.rejoin(); } catch (e) { console.error(`[relay ${this.index+1}] rejoin failed:`, e.message); }
      }
    });
  }

  playOpus(stream){
    if (!this.connection) { console.log(`[relay ${this.index+1}] playOpus called but no connection`); return; }
    if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
      // Don't queue audio on a relay that isn't connected: the player would sit "autopaused" and then
      // blurt out stale audio the moment the connection comes back. Drop it instead.
      console.log(`[relay ${this.index+1}] not connected (status "${this.connection.state.status}") — skipping this audio`);
      stream.resume();
      return;
    }
    this.voicePlayer.play(createAudioResource(stream,{inputType:StreamType.Opus}));
  }

  destroy(){
    this.voicePlayer.stop(true);
    try { this.connection?.destroy(); } catch {}
    this.connection = null;
    // Log the relay out too — otherwise every start/stop cycle leaves another live gateway session behind.
    try { this.client.destroy(); } catch {}
  }
}
module.exports = { Relay };

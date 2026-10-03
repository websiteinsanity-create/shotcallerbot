const { Client, GatewayIntentBits } = require("discord.js");
const { watchSpeakingFlags } = require("./speakingflags");
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  StreamType
} = require("@discordjs/voice");

class Relay {
  constructor(token, index, opts = {}) {
    this.token = token;
    this.index = index;
    this.onFlags = opts.onFlags || null; // called with (userId, speakingFlags) from the raw voice socket
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

  async login(){ await this.client.login(this.token); }

  async connect(channelId,guildId){
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Relay ${this.index+1}: channel unavailable`);
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

  playOpus(stream){
    if (!this.connection) { console.log(`[relay ${this.index+1}] playOpus called but no connection`); return; }
    console.log(`[relay ${this.index+1}] playOpus called, connection status: ${this.connection.state.status}`);
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

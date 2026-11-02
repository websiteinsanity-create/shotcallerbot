const { Client, GatewayIntentBits, PermissionFlagsBits } = require("discord.js");
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

const accounts=new Map();
class Relay {
  constructor(token, index, opts = {}) {
    this.token = token;
    this.index = index;
    this.onFlags = opts.onFlags || null;
    this.onVoiceState=opts.onVoiceState || null;this.operation=opts.operation || null; // called with (userId, speakingFlags) from the raw voice socket
    this.readyTimeoutMs = opts.readyTimeoutMs || 20000; // login -> client ready
    this.voiceTimeoutMs = opts.voiceTimeoutMs || 20000; // join -> voice connection ready
    this.maxAttempts = opts.maxAttempts || 3;           // startup: join tries before giving up on this relay
    this.graceMs = opts.graceMs || 5000;                // after a drop: wait this long for a self-recovery before rejoining
    this.rejoins = 0;
    let account=accounts.get(token);if(!account){account={client:new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildVoiceStates]}),refs:0,login:null,guilds:new Set()};accounts.set(token,account);}this.account=account;account.refs++;this.client=account.client;
    this.gatewayHandlers=[];const listen=(event,fn)=>{this.client.on(event,fn);this.gatewayHandlers.push([event,fn]);};
    this.connection = null;
    listen('shardDisconnect',()=>{this.disconnectedSince ||= Date.now();this.voicePlayer?.stop(true);this.onVoiceState?.(this.index,'gateway-disconnected',this);this.operation?.event('relay.gateway.disconnected',{relay:this.index+1});});
    for(const event of ['shardResume','clientReady'])listen(event,()=>{if(this.connection){if(this.connection.state.status==='ready')this.disconnectedSince=null;this.onVoiceState?.(this.index,this.connection.state.status,this);}});
    // maxMissedFrames: by default the player gives up after 5 empty 20ms ticks (100ms). Network jitter easily causes
    // that, so let it ride out up to a second of gap instead of dropping the rest of the sentence.
    this.voicePlayer = createAudioPlayer({ behaviors: { maxMissedFrames: 50 } });
    listen("ready",()=>this.operation?.event("relay.gateway.ready",{relay:index+1,status:"ready"}));
    listen("error",error=>this.operation?.event("relay.gateway.error",{relay:index+1,error}));
    this.voicePlayer.on("error",error=>this.operation?.event("relay.audio.error",{relay:index+1,error}));
    this.voicePlayer.on("stateChange",(oldS,newS)=>this.operation?.event("relay.audio.state",{relay:index+1,from:oldS.status,to:newS.status}));
  }

  async login(){
    if(this.account.login)return this.account.login;
    this.account.login=this._login().catch(error=>{this.account.login=null;throw error;});return this.account.login;
  }
  async _login(){
    if(this.client.isReady?.())return;
    const started=Date.now();this.operation?.event("relay.login",{relay:this.index+1,status:"starting"});
    // client.login() can resolve before the gateway has finished logging the bot in. Joining voice in that
    // gap leaves the connection stuck at "disconnected" (the voice-state message can't be sent yet), so
    // wait for the client's own ready event first. Both names are listened for: it was renamed in discord.js 14.22.
    let onReady;
    const ready = new Promise(resolve => {onReady=resolve;this.client.once("clientReady",onReady);this.client.once("ready",onReady);});
    try{await withTimeout(Promise.all([this.client.login(this.token),ready]),this.readyTimeoutMs,`Relay ${this.index+1} did not complete gateway login in time`);}
    catch(error){this.operation?.event("relay.login.failed",{relay:this.index+1,durationMs:Date.now()-started,error});throw error;}
    finally{this.client.removeListener("clientReady",onReady);this.client.removeListener("ready",onReady);}

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
    this.connection.on("error",error=>this.operation?.event("relay.voice.error",{relay:this.index+1,channelId:channel.id,error}));
    this.connection.on("stateChange",(oldS,newS)=>{
      this.operation?.event('relay.state',{relay:this.index+1,channelId:channel.id,from:oldS.status,to:newS.status});
      if(newS.status!==VoiceConnectionStatus.Ready)this.voicePlayer.stop(true);
      this.onVoiceState?.(this.index,newS.status,this);
    });
    this.connection.subscribe(this.voicePlayer);
    watchSpeakingFlags(this.connection,`relay ${this.index+1}`,this.onFlags);
  }

  async connect(channelId,guildId){
    if(this.guildId && this.guildId!==guildId)throw Error('Relay connection is bound to one guild.');
    if(!this.guildId){if(this.account.guilds.has(guildId))throw Error('Relay account already has a voice connection in this guild.');this.account.guilds.add(guildId);}
    this.channelId=channelId;this.guildId=guildId;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Relay ${this.index+1}: channel unavailable`);
    const permissions=channel.permissionsFor?.(channel.guild.members.me);
    if(permissions && !permissions.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw Error(`Relay ${this.index+1} cannot view, connect or speak in the selected channel.`);
    // Don't call the relay "up" until its voice connection really is — a relay stuck anywhere else would
    // otherwise leave its party silent while the session looks like it started fine. With a dozen relays
    // joining, the odd one stumbles, so give each a few tries before failing the session.
    let lastStatus = "unknown",lastError;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      if(this.destroyed)throw Error(`Relay ${this.index+1} start cancelled.`);
      const started=Date.now();this.operation?.event("relay.connect",{relay:this.index+1,channelId,attempt,status:"starting"});
      this._join(channel,guildId);
      const connection=this.connection;
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, this.voiceTimeoutMs);
        if(this.destroyed || this.connection!==connection)throw Error("Relay start cancelled.");
        this.disconnectedSince=null;this.recoveryFailed=false;this._watchDrops();
        this.operation?.event("relay.ready",{relay:this.index+1,channelId,attempt,durationMs:Date.now()-started,status:"ready"});
        this.onVoiceState?.(this.index,"ready",this);
        return;
      } catch (error) {
        lastError=error;
        this.operation?.event("relay.connect.failed",{relay:this.index+1,channelId,attempt,durationMs:Date.now()-started,status:connection.state.status,error});
        lastStatus = connection.state.status;
        if(this.destroyed)throw Error(`Relay ${this.index+1} start cancelled.`);
        try { this.connection.destroy(); } catch {}
        this.connection = null;
        if(attempt<this.maxAttempts)await new Promise(resolve=>setTimeout(resolve,250*attempt));
      }
    }
    throw new Error(`Relay ${this.index+1} could not establish voice in "${channel.name}" after ${this.maxAttempts} attempts (last status "${lastStatus}"; reason: ${this.operation?.sanitize?.(lastError?.message || "unknown") || String(lastError?.message || "unknown").split(this.token).join("[redacted]")})`);
  }

  // A connection that drops mid-session stays dropped unless something rejoins it. Discord moving us to
  // another voice server shows up as signalling/connecting within moments; anything else we rejoin.
  _watchDrops(){
    const conn = this.connection;
    conn.on('stateChange',(_old,next)=>{
      if(next.status===VoiceConnectionStatus.Ready){this.rejoins=0;this.recoveryFailed=false;this.disconnectedSince=null;return;}
      this.disconnectedSince ||= Date.now();
      if(!this.destroyed && this.connection===conn)this._recover(conn).catch(error=>this.operation?.event('relay.recovery.error',{relay:this.index+1,channelId:this.channelId,error}));
    });
  }

  async _recover(conn){
    if(this.recovering || this.destroyed || this.connection!==conn)return;
    this.recovering=true;const started=Date.now();
    try{
      this.disconnectedSince ||= Date.now();
      let attempt=0,warned=false;
      while(!this.destroyed){
        conn=this.connection;
        if(conn?.state.status===VoiceConnectionStatus.Ready){this.disconnectedSince=null;this.recoveryFailed=false;return;}
        if(Date.now()-this.disconnectedSince>=30000 && !warned){warned=true;this.recoveryFailed=true;this.operation?.event('relay.recovery.warning',{relay:this.index+1,channelId:this.channelId,durationMs:Date.now()-this.disconnectedSince});}
        try{
          if(!conn || conn.state.status===VoiceConnectionStatus.Destroyed){await this.connect(this.channelId,this.guildId);return;}
          await entersState(conn,VoiceConnectionStatus.Ready,this.graceMs);this.disconnectedSince=null;return;
        }catch(error){
          if(this.destroyed)return;
          this.rejoins++;try{conn?.rejoin();}catch{}
          const delay=[1000,2000,5000,10000,30000][Math.min(attempt++,4)];
          await new Promise(resolve=>{this.recoveryWake=resolve;this.recoveryTimer=setTimeout(resolve,delay);});this.recoveryWake=null;
        }
      }
    }finally{this.recovering=false;}
  }

  playOpus(stream){
    if (!this.connection || this.destroyed) { stream.destroy();return; }
    if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
      // Don't queue audio on a relay that isn't connected: the player would sit "autopaused" and then
      // blurt out stale audio the moment the connection comes back. Drop it instead.
      console.log(`[relay ${this.index+1}] not connected (status "${this.connection.state.status}") — skipping this audio`);
      stream.destroy();
      return;
    }
    this.voicePlayer.play(createAudioResource(stream,{inputType:StreamType.Opus}));
  }

  async destroy(){
    if(this.destroyed)return;this.destroyed=true;clearTimeout(this.recoveryTimer);this.recoveryWake?.();for(const [event,fn] of this.gatewayHandlers)this.client.removeListener(event,fn);
    const errors=[];
    try { this.voicePlayer.stop(true); } catch(e) { errors.push(e); }
    try { this.connection?.destroy(); } catch(e) { errors.push(e); }
    this.connection = null;
    // Wait for gateway logout too, while all voice/audio shutdown above stays immediate.
    try { this.account.guilds.delete(this.guildId);if(--this.account.refs===0){accounts.delete(this.token);await this.client.destroy();} } catch(e) { errors.push(e); }
    if(errors.length)throw new AggregateError(errors,'Relay cleanup failed.');
  }
}
module.exports = { Relay };

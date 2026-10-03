const {
  ChannelType, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  UserSelectMenuBuilder
} = require("discord.js");
const { joinVoiceChannel, createAudioPlayer } = require("@discordjs/voice");
const config = require("./config");
const { Relay } = require("./relay");
const { AudioRouter } = require("./audio");
const { canWhisper } = require("./permissions");

class Session {
  constructor(guild, member, count) {
    this.guild=guild; this.commandVoice=member.voice.channel; this.count=count;
    // this.channels[0] is always the shotcaller's own channel ("Party 1") — never created or deleted by the bot.
    // this.createdChannels holds only the bot-made Party 2..N channels, which DO get relay bots and DO get deleted on stop.
    this.channels=[]; this.createdChannels=[]; this.relays=[]; this.muted=false;
    // Whoever runs /shotcaller start is the primary caller by default — adjustable afterward via the Dedicated button.
    this.dedicated=new Set([member.id]);
    this.bridge=null; this.panelMessage=null; this.main=null; this.mainPlayer=null;
    this.partyReceivers=new Map(); this.config=config;
    this.audio=null; this.relayActive=new Map(); // userId -> bool, toggled via button (whisper: private to shotcaller)
    // Secondary callers: a small allow-list (set by the primary caller) who can push a momentary
    // callout from ANY party channel out to every OTHER party + the shotcaller — same effect as the
    // primary caller speaking, just time-limited and from wherever they happen to be.
    this.secondaryCallers=new Set(); this.secondaryActive=new Map();
  }

  async start(){
    this.channels=[this.commandVoice];

    if(this.count>1){
      let cat=this.guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name===config.partyCategoryName);
      if(!cat) cat=await this.guild.channels.create({name:config.partyCategoryName,type:ChannelType.GuildCategory});
      for(let i=1;i<this.count;i++){
        const c=await this.guild.channels.create({
          name:`Party ${i+1}`,type:ChannelType.GuildVoice,parent:cat.id,
          permissionOverwrites:[{id:this.guild.roles.everyone.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]}]
        });
        this.channels.push(c);
        this.createdChannels.push(c);
      }
    }

    for(const c of this.createdChannels){
      await c.send({
        content:`🎙️ Talk normally with your party here.\n• **${config.whisperRoleName}** role: use the first button for a brief, PRIVATE callout to the shotcaller only.\n• Designated secondary callers: use the second button for a brief callout heard by EVERY party + the shotcaller.`,
        components:[this.whisperToggleRow(),this.secondaryToggleRow()]
      }).catch(()=>{});
    }

    this.main=joinVoiceChannel({
      channelId:this.commandVoice.id,guildId:this.guild.id,
      adapterCreator:this.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false,
      group:"shotcaller-main"
    });
    this.main.on("error",e=>console.error("[main] connection error:",e));
    this.main.on("stateChange",(oldS,newS)=>console.log(`[main] connection: ${oldS.status} -> ${newS.status}`));
    console.log(`[main] connected to "${this.commandVoice.name}", initial status: ${this.main.state.status}`);
    this.mainPlayer=createAudioPlayer();
    this.main.subscribe(this.mainPlayer);

    // One relay per created party (Party 1 is the shotcaller's own channel — no relay needed there).
    for(let j=0;j<this.createdChannels.length;j++){
      const token=config.relayTokens[j];
      if(!token) throw new Error(`Missing relay token for Party ${j+2}.`);
      const relay=new Relay(token,j);
      await relay.login();
      await relay.connect(this.createdChannels[j].id,this.guild.id);
      this.relays.push(relay);
    }

    this.audio=new AudioRouter(this);
    this.main.receiver.speaking.on("start",u=>{console.log(`[main] speaking.start detected for ${u}`);this.audio.broadcast(u);});

    // Each relay is also a receiver for its own party, allowing whisper routing back to the shotcaller.
    for(let j=0;j<this.relays.length;j++){
      const r=this.relays[j];
      const receiver=r.connection?.receiver;
      if(!receiver) continue;
      this.partyReceivers.set(j,receiver);
      receiver.speaking.on("start",userId=>{
        if(this.whisperAllowed(userId)) this.routeWhisper(j,userId);
        if(this.secondaryCallActive(userId)) this.routeSecondaryCall(j,userId);
      });
    }
  }

  get partyReceiver(){
    // Set temporarily by routeWhisper; AudioRouter reads this.
    return this._partyReceiver;
  }

  whisperAllowed(userId){
    const member=this.guild.members.cache.get(userId);
    if(!member || !canWhisper(member)) return false;
    return this.relayActive.get(userId) === true;
  }

  toggleRelay(userId){
    // Clear any pending auto-off timer regardless of direction — either we're turning off early
    // (nothing to clear is fine) or turning on fresh (don't want a stale timer from last time firing early).
    clearTimeout(this.whisperTimers?.get(userId));
    if(!this.whisperTimers) this.whisperTimers=new Map();

    const next = !(this.relayActive.get(userId) === true);
    this.relayActive.set(userId, next);

    if(next){
      const timer=setTimeout(()=>{ this.relayActive.set(userId,false); this.whisperTimers.delete(userId); }, this.config.whisperAutoOffMs);
      this.whisperTimers.set(userId,timer);
    }else{
      this.whisperTimers.delete(userId);
    }
    return next;
  }

  whisperToggleRow(){
    const secs=Math.round(this.config.whisperAutoOffMs/1000);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("whisper_toggle").setLabel(`🎙️ Call Out to Shotcaller (${secs}s)`).setStyle(ButtonStyle.Primary)
    );
  }

  routeWhisper(index,userId){
    const receiver=this.partyReceivers.get(index);
    if(!receiver) return;
    this._partyReceiver=receiver;
    this.audio.whisper(userId);
  }

  // --- Secondary callers: momentary callout from any party, heard by every OTHER party + the shotcaller ---

  secondaryCallActive(userId){
    return this.secondaryCallers.has(userId) && this.secondaryActive.get(userId)===true;
  }

  toggleSecondary(userId){
    if(!this.secondaryCallers.has(userId)) return null; // not authorized — caller checks this separately for the error message
    clearTimeout(this.secondaryTimers?.get(userId));
    if(!this.secondaryTimers) this.secondaryTimers=new Map();

    const next=!(this.secondaryActive.get(userId)===true);
    this.secondaryActive.set(userId,next);

    if(next){
      const timer=setTimeout(()=>{ this.secondaryActive.set(userId,false); this.secondaryTimers.delete(userId); }, this.config.whisperAutoOffMs);
      this.secondaryTimers.set(userId,timer);
    }else{
      this.secondaryTimers.delete(userId);
    }
    return next;
  }

  secondaryToggleRow(){
    const secs=Math.round(this.config.whisperAutoOffMs/1000);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("secondary_toggle").setLabel(`📢 Callout to Everyone (${secs}s)`).setStyle(ButtonStyle.Success)
    );
  }

  secondaryMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("secondary_select").setPlaceholder("Pick secondary callers (up to 6) — select none to clear").setMinValues(0).setMaxValues(6)
    );
  }

  routeSecondaryCall(sourceIndex,userId){
    const receiver=this.partyReceivers.get(sourceIndex);
    if(!receiver) return;
    this.audio.secondaryBroadcast(sourceIndex,userId,receiver);
  }

  async destroy(){
    this.audio?.stop();
    if(this.whisperTimers) for(const t of this.whisperTimers.values()) clearTimeout(t);
    if(this.secondaryTimers) for(const t of this.secondaryTimers.values()) clearTimeout(t);
    this.relays.forEach(r=>r.destroy());
    try{this.main?.destroy()}catch{}
    // Only delete channels that are now empty — never force-disconnect people still using them.
    // Non-empty ones are simply left behind (the bots have already left via the destroy() calls above).
    for(const c of this.createdChannels){
      const fresh=await c.fetch().catch(()=>c);
      if((fresh.members?.size ?? 0)===0) await fresh.delete("Shotcaller session ended").catch(()=>{});
    }
    this.channels=[]; this.createdChannels=[];
  }

  panel(){
    const parties=this.channels.map((c,i)=>{
      const count=c.members?.size ?? 0;
      return `**Party ${i+1}**${i===0?" (you)":""} <#${c.id}> — ${count} connected`;
    }).join("\n");
    const e=new EmbedBuilder().setTitle("📣 Shotcaller Panel")
      .setDescription(`${parties}\n\n**${config.whisperRoleName}**-role members can open a direct line to you using the button in their party's voice chat.`)
      .addFields(
        {name:"Audio",value:this.muted?"🔇 Muted":"🔊 Active",inline:true},
        {name:"Dedicated",value:this.dedicated.size?[...this.dedicated].map(id=>`<@${id}>`).join(", "):"Off (anyone)",inline:true},
        {name:"Secondary callers",value:this.secondaryCallers.size?[...this.secondaryCallers].map(id=>`<@${id}>`).join(", "):"None set",inline:true},
        {name:"Bridge",value:this.bridge?.active?"Active":"Off",inline:true}
      );
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mute").setLabel(this.muted?"Unmute":"Mute").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dedicated").setLabel("Dedicated").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("secondary_setup").setLabel("Secondary Callers").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bridge").setLabel(this.bridge?.active?"End Bridge":"Bridge").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger)
    );
    return {embeds:[e],components:[buttons]};
  }

  dedicatedMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("dedicated_select").setPlaceholder("Pick dedicated caller(s) — select none to clear").setMinValues(0).setMaxValues(10)
    );
  }
}
module.exports={Session};

const {
  ChannelType, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  UserSelectMenuBuilder
} = require("discord.js");
const { joinVoiceChannel } = require("@discordjs/voice");
const config = require("./config");
const { Relay } = require("./relay");
const { AudioRouter } = require("./audio");
const { watchSpeakingFlags } = require("./speakingflags");
const janitor = require("./janitor");

// Discord's user-select menu allows at most 25 choices, so this can go up to 25.
const MAX_ADDITIONAL_CALLERS=16;

class Session {
  constructor(guild, member, count) {
    this.guild=guild; this.commandVoice=member.voice.channel; this.count=count;
    // channels[0] is the shotcaller's own channel ("Party 1") — never created or deleted by the bot.
    // createdChannels holds the bot-made Party 2..N channels, deleted on stop if empty.
    // relays[j] is the relay bot sitting in channels[j] — one per party, Party 1 included.
    this.channels=[]; this.createdChannels=[]; this.relays=[]; this.muted=false;
    // Whoever runs /shotcaller start is the primary caller by default (adjustable with the Dedicated button).
    this.dedicated=new Set([member.id]);
    // Additional callers (up to MAX_ADDITIONAL_CALLERS): can push a time-limited callout from ANY party out to every other party.
    // Anyone with the configured role is an additional caller automatically (see isAdditionalCaller);
    // this set is just optional per-game extras on top of that.
    this.additionalCallers=new Set();
    this.callerRoleId=null; this.fetchingMembers=new Set();
    this.calloutOpen=new Map(); this.calloutTimers=new Map();   // button window: userId -> bool / timer
    this.priorityHeld=new Map(); this.priorityTimers=new Map(); // held Push to Talk (Priority) key
    this.bridge=null; this.panelMessage=null; this.main=null;
    this.config=config; this.audio=null;
  }

  async start(){
    // One relay bot per party, including the shotcaller's own. Check BEFORE creating anything so a
    // shortage of tokens can't leave half-built channels behind.
    if(config.relayTokens.length<this.count){
      throw new Error(`Need one relay bot per party (including your own): ${this.count} parties but only ${config.relayTokens.length} relay token(s) configured.`);
    }

    await this.loadCallers();

    this.channels=[this.commandVoice];
    if(this.count>1){
      // Clear out any "Party N" channels an earlier run left behind (empty ones go now, occupied ones when they empty).
      await janitor.sweep(this.guild).catch(e=>console.warn("[cleanup] sweep failed:",e.message));
      let cat=this.guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name===config.partyCategoryName);
      const wantPos=config.partyCategoryPosition;
      if(!cat) cat=await this.guild.channels.create({name:config.partyCategoryName,type:ChannelType.GuildCategory,...(wantPos!==null?{position:wantPos}:{})});
      else if(wantPos!==null && cat.position!==wantPos) await cat.setPosition(wantPos).catch(e=>console.warn(`[cleanup] couldn't move the category to position ${wantPos}: ${e.message}`));
      for(let i=1;i<this.count;i++){
        const c=await this.guild.channels.create({
          name:`Party ${i+1}`,type:ChannelType.GuildVoice,parent:cat.id,
          permissionOverwrites:[{id:this.guild.roles.everyone.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]}]
        });
        this.channels.push(c);
        this.createdChannels.push(c);
      }
    }

    // Post the callout button in every party's chat (the shotcaller's own channel too — best effort,
    // since that's an existing channel the bot may not be allowed to post in).
    const secs=Math.round(config.calloutAutoOffMs/1000);
    for(const c of this.channels){
      await c.send({
        content:`🎙️ Talk normally with your party here.\nAdditional callers (**${config.additionalCallerRoleName}** role): press the button for a ${secs}-second callout heard by every other party.`,
        components:[this.calloutRow()]
      }).catch(()=>{});
    }

    this.main=joinVoiceChannel({
      channelId:this.commandVoice.id,guildId:this.guild.id,
      adapterCreator:this.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false,
      group:"shotcaller-main"
    });
    this.main.on("error",e=>console.error("[main] connection error:",e));
    this.main.on("stateChange",(oldS,newS)=>console.log(`[main] connection: ${oldS.status} -> ${newS.status}`));
    watchSpeakingFlags(this.main,"main",(u,f)=>this.onSpeakingFlags(u,f));
    console.log(`[main] connected to "${this.commandVoice.name}", initial status: ${this.main.state.status}`);

    for(let j=0;j<this.channels.length;j++){
      const relay=new Relay(config.relayTokens[j],j,{onFlags:(u,f)=>this.onSpeakingFlags(u,f)});
      this.relays.push(relay); // registered first, so destroy() cleans it up even if login/connect fails
      await relay.login();
      await relay.connect(this.channels[j].id,this.guild.id);
    }

    this.audio=new AudioRouter(this);
    this.main.receiver.speaking.on("start",u=>this.audio.broadcast(u));

    // Every relay also listens to its own party, so an additional caller is picked up wherever they stand.
    for(let j=0;j<this.relays.length;j++){
      const receiver=this.relays[j].connection?.receiver;
      if(!receiver) continue;
      receiver.speaking.on("start",userId=>{
        if(this.additionalCallActive(userId)) this.audio.additionalBroadcast(j,userId,receiver);
      });
    }
  }

  // ---- Additional callers ----

  // Find the caller role and warm the member cache so role checks can be answered instantly while audio is flowing.
  async loadCallers(){
    const want=config.additionalCallerRoleName.toLowerCase();
    const role=this.guild.roles?.cache?.find(r=>r.name.toLowerCase()===want);
    this.callerRoleId=role?.id||null;
    if(!role){
      console.warn(`[callers] no role named "${config.additionalCallerRoleName}" found — only extra callers added by hand will work`);
      return;
    }
    try{ await this.guild.members.fetch(); }
    catch(e){ console.warn(`[callers] couldn't load the full member list (${e.message}) — members are picked up as they speak`); }
    console.log(`[callers] role "${role.name}": ${role.members?.size ?? "?"} member(s) can call out`);
  }

  hasCallerRole(userId){
    if(!this.callerRoleId) return false;
    const member=this.guild.members.cache.get(userId);
    if(!member){
      // Not in the cache yet (e.g. a very large server): fetch them once in the background so the next try works.
      if(!this.fetchingMembers.has(userId)){
        this.fetchingMembers.add(userId);
        this.guild.members.fetch(userId).catch(()=>{}).finally(()=>this.fetchingMembers.delete(userId));
      }
      return false;
    }
    return member.roles.cache.has(this.callerRoleId);
  }

  // Role holders are additional callers automatically; the manual picker only adds extras on top.
  isAdditionalCaller(userId){
    return this.additionalCallers.has(userId) || this.hasCallerRole(userId);
  }

  // Is this person allowed to be heard by everyone right now? (button window open, or priority key held)
  additionalCallActive(userId){
    if(!this.isAdditionalCaller(userId)) return false;
    if(this.dedicated.has(userId)) return false; // the primary caller is already handled by the main broadcast
    return this.calloutOpen.get(userId)===true || this.priorityHeld.get(userId)===true;
  }

  stopIfIdle(userId){
    if(!this.additionalCallActive(userId)) this.audio?.stopAdditionalFor(userId);
  }

  // If someone opens their window while already mid-sentence, start relaying straight away
  // instead of waiting for their next pause.
  startIfSpeaking(userId){
    if(!this.audio || !this.additionalCallActive(userId)) return;
    for(let j=0;j<this.relays.length;j++){
      const receiver=this.relays[j].connection?.receiver;
      if(receiver?.speaking?.users?.has?.(userId)){ this.audio.additionalBroadcast(j,userId,receiver); return; }
    }
  }

  // Button: opens a window of calloutAutoOffMs, closes itself, or click again to close early.
  toggleCallout(userId){
    if(!this.isAdditionalCaller(userId)) return null; // caller shows the "not authorised" message
    clearTimeout(this.calloutTimers.get(userId));
    const next=!(this.calloutOpen.get(userId)===true);
    this.calloutOpen.set(userId,next);
    if(next){
      this.calloutTimers.set(userId,setTimeout(()=>{
        this.calloutOpen.set(userId,false); this.calloutTimers.delete(userId); this.stopIfIdle(userId);
      },this.config.calloutAutoOffMs));
      this.startIfSpeaking(userId);
    }else{
      this.calloutTimers.delete(userId);
      this.stopIfIdle(userId);
    }
    return next;
  }

  // Raw speaking flags from any voice connection. Bit 4 is "priority speaker", which is what Discord's
  // "Push to Talk (Priority)" keybind should set — held key = open line, released = closed.
  // (Unverified until the [flags] log lines have been checked against a real key press.)
  onSpeakingFlags(userId,flags){
    if(!this.isAdditionalCaller(userId)) return;
    const held=(Number(flags)&4)!==0;
    if(held===(this.priorityHeld.get(userId)===true)) return;
    clearTimeout(this.priorityTimers.get(userId));
    this.priorityHeld.set(userId,held);
    console.log(`[callout] ${userId} priority key ${held?"held":"released"}`);
    if(held){
      // Safety net: a lost "released" message must never leave a line stuck open.
      this.priorityTimers.set(userId,setTimeout(()=>{
        this.priorityHeld.set(userId,false); this.priorityTimers.delete(userId); this.stopIfIdle(userId);
      },this.config.calloutAutoOffMs));
      this.startIfSpeaking(userId);
    }else{
      this.priorityTimers.delete(userId);
      this.stopIfIdle(userId);
    }
  }

  calloutRow(){
    const secs=Math.round(this.config.calloutAutoOffMs/1000);
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("callout_toggle").setLabel(`📢 Callout to Everyone (${secs}s)`).setStyle(ButtonStyle.Success)
    );
  }

  additionalMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("additional_select").setPlaceholder(`Extra callers for this game, on top of the role (up to ${MAX_ADDITIONAL_CALLERS}) — none to clear`).setMinValues(0).setMaxValues(MAX_ADDITIONAL_CALLERS)
    );
  }

  dedicatedMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("dedicated_select").setPlaceholder("Pick dedicated caller(s) — select none to clear").setMinValues(0).setMaxValues(10)
    );
  }

  async destroy(){
    for(const m of [this.calloutTimers,this.priorityTimers]) for(const t of m.values()) clearTimeout(t);
    this.audio?.stop();
    this.relays.forEach(r=>r.destroy());
    try{this.main?.destroy()}catch{}
    // Empty channels are deleted now. Ones with people still in them are left alone (nobody gets kicked) and
    // deleted by the janitor the moment they empty.
    for(const c of this.createdChannels) await janitor.retire(c);
    this.channels=[]; this.createdChannels=[];
  }

  panel(){
    const secs=Math.round(config.calloutAutoOffMs/1000);
    const parties=this.channels.map((c,i)=>{
      const humans=c.members ? [...c.members.values()].filter(m=>!m.user?.bot).length : 0;
      return `**Party ${i+1}**${i===0?" (you)":""} <#${c.id}> — ${humans} connected`;
    }).join("\n");
    const names=set=>[...set].map(id=>`<@${id}>`).join(", ");
    const e=new EmbedBuilder().setTitle("📣 Shotcaller Panel")
      .setDescription(`${parties}\n\nAnyone with the **${config.additionalCallerRoleName}** role can call out to every other party (button in each party's chat, ${secs}s).`)
      .addFields(
        {name:"Audio",value:this.muted?"🔇 Muted":"🔊 Active",inline:true},
        {name:"Dedicated",value:this.dedicated.size?names(this.dedicated):"Off (anyone)",inline:true},
        {name:"Additional callers",value:[this.callerRoleId?`<@&${this.callerRoleId}> role`:`⚠️ role "${config.additionalCallerRoleName}" not found`,...(this.additionalCallers.size?[`+ extras: ${names(this.additionalCallers)}`]:[])].join("\n"),inline:true},
        {name:"Bridge",value:this.bridge?.active?"Active":"Off",inline:true}
      );
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mute").setLabel(this.muted?"Unmute":"Mute").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dedicated").setLabel("Dedicated").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("additional_setup").setLabel("Extra Callers").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bridge").setLabel(this.bridge?.active?"End Bridge":"Bridge").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger)
    );
    return {embeds:[e],components:[buttons]};
  }
}
module.exports={Session,MAX_ADDITIONAL_CALLERS};

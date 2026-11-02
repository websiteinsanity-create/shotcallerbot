const {
  ChannelType, PermissionFlagsBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  UserSelectMenuBuilder
} = require("discord.js");
const { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, StreamType } = require("@discordjs/voice");
const {MainCaller}=require("./main-caller");
const config = require("./config");
const { Relay } = require("./relay");
const { AudioRouter } = require("./audio");
const { watchSpeakingFlags } = require("./speakingflags");
const janitor = require("./janitor");

// Discord's user-select menu allows at most 25 choices, so this can go up to 25.
const MAX_ADDITIONAL_CALLERS=16;

class Session {
  // channel: the voice channel that becomes Party 1 ("commandVoice") - the Discord command passes whoever ran
  // it is already standing in (i.member.voice.channel); the HTTP control API passes one picked explicitly,
  // since nobody is "standing" anywhere when a session is started from a web panel instead of Discord.
  // callerId: the dedicated caller to start with, or null/undefined for none. The Discord command passes
  // whoever ran it (unchanged behaviour); the HTTP API passes whatever Guild Hall's own "Shotcaller" picker
  // was explicitly set to - a caller is never inferred, only ever asked for.
  constructor(guild, channel, callerId, count) {
    this.guild=guild; this.commandVoice=channel; this.count=Math.min(12,count);
    // channels[0] is the shotcaller's own channel ("Party 1") — never created or deleted by the bot.
    // createdChannels holds the bot-made Party 2..N channels, deleted on stop if empty.
    // relays[j] is the relay bot sitting in channels[j] — one per party, Party 1 included.
    this.channels=[]; this.createdChannels=[]; this.relays=[]; this.muted=false;
    this.dedicated=callerId?new Set([callerId]):new Set();
    this.mainCaller=new MainCaller(callerId);this.paused=false;this.followGeneration=0;this.followSignature=null;this.followRetryAt=0;
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

  cancelStart(){this.startCancelled=true;}
  ensureStarting(){if(this.startCancelled)throw Error("Session start cancelled.");}
  async start(){
    this.ensureStarting();
    if(!Number.isInteger(this.count) || this.count<1)throw Error("Choose a positive whole party count.");
    // One relay bot per party, including the shotcaller's own. Check BEFORE creating anything so a
    // shortage of tokens can't leave half-built channels behind.
    if(config.relayTokens.length<this.count){
      throw new Error(`Need one relay bot per party (including your own): ${this.count} parties but only ${config.relayTokens.length} relay token(s) configured.`);
    }

    const tokens=config.relayTokens.slice(0,this.count);
    if(new Set(tokens).size!==tokens.length || tokens.includes(config.mainToken))throw Error("Main and relay bots must use distinct tokens.");
    const perms=this.commandVoice.permissionsFor?.(this.guild.members.me);
    if(perms && !perms.has(PermissionFlagsBits.ViewChannel))throw Error("Main control bot cannot view the selected voice channel.");
    await this.loadCallers();
    this.ensureStarting();

    this.channels=[this.commandVoice];
    if(this.restoreSpec?.channels?.length){
      for(let index=1;index<this.count;index++){const item=this.restoreSpec.channels[index];let c;
        if(item)try{c=await this.guild.channels.fetch(item.id);}catch{}
        if(c && c.guild.id===this.guild.id && c.type===ChannelType.GuildVoice){this.channels[index]=c;if(item.created)this.createdChannels.push(c);}
      }
      if(this.count>1)await this.createPartyChannels();
    }else if(this.count>1) await this.createPartyChannels();
    this.ensureStarting();

    // Post the callout button in every party's chat (the shotcaller's own channel too — best effort,
    // since that's an existing channel the bot may not be allowed to post in).
    const secs=Math.round(config.calloutAutoOffMs/1000);
    for(const c of this.channels){
      this.ensureStarting();
      await c.send({
        content:`🎙️ Talk normally with your party here.\nAdditional callers (**${config.additionalCallerRoleName}** role): press the button for a ${secs}-second callout to the main caller, or all other parties when no main caller is available.`,
        components:[this.calloutRow()]
      }).catch(()=>{});
    }

    this.ensureStarting();
    for(let j=0;j<this.channels.length;j++){
      const relay=new Relay(config.relayTokens[j],j,{onFlags:(u,f)=>this.onSpeakingFlags(u,f),operation:this.operation,onVoiceState:(index,status,relay)=>this.onRelayState(index,status,relay)});
      this.relays.push(relay); // registered first, so destroy() cleans it up even if login/connect fails
      await relay.login();
      this.ensureStarting();
      if(relay.client.user.id===this.guild.client.user.id || this.relays.some(r=>r!==relay && r.client.user?.id===relay.client.user.id))throw Error("Each relay must have a distinct bot identity.");
    this.ensureStarting();
      await relay.connect(this.channels[j].id,this.guild.id);
    this.ensureStarting();
    }

    await Promise.all(this.relays.map(r=>entersState(r.connection,VoiceConnectionStatus.Ready,20000)));
    this.ensureStarting();
    if(this.relays.some(r=>r.client.isReady?.()===false || r.connection?.state.status!==VoiceConnectionStatus.Ready))throw Error("Not all relays are ready.");
    this.audio=new AudioRouter(this);
    this.wireReceivers();
    this.voiceListener=()=>this.syncMainCaller();
    this.guild.client.on("voiceStateUpdate",this.voiceListener);
    this.followTimer=setInterval(()=>this.syncMainCaller(),1000);this.followTimer.unref?.();
    this.syncMainCaller();if(this.restoreSpec?.paused)this.setPaused(true);this.onChanged?.();
  }

  resumeSpeaking(){
    if(this.startCancelled || !this.audio || this.paused || this.muted)return;
    for(let i=-1;i<this.relays.length;i++){const receiver=i<0?this.main?.receiver:this.relays[i]?.connection?.receiver;
      for(const user of receiver?.speaking?.users?.keys?.() || []){
        if(this.dedicated.has(user))this.audio.broadcast(user,i,receiver);
        else if(this.additionalCallActive(user))this.audio.additionalBroadcast(i,user,receiver);
      }
    }
  }
  // Who is listened to where:
  //  - the main bot listens to the shotcaller's own channel (party 1) and relays the dedicated caller from there;
  //  - every relay listens to its own party, so a dedicated caller who has been moved to another party is still
  //    heard by everyone else, and an additional caller's callout is picked up wherever they stand.
  wireReceiver(index){
    const receiver=this.relays[index]?.connection?.receiver;
    if(!receiver || this.wiredReceivers?.has(receiver))return;
    this.wiredReceivers ||= new WeakSet();this.wiredReceivers.add(receiver);
    receiver.speaking.on('start',userId=>{
      const relay=this.relays[index];if(relay?.connection?.receiver!==receiver || relay.connection.state.status!=='ready' || relay.client?.isReady?.()===false)return;
      if(this.dedicated.has(userId))return this.audio.broadcast(userId,index,receiver);
      if(this.additionalCallActive(userId))this.audio.additionalBroadcast(index,userId,receiver);
    });
  }
  wireReceivers(){for(let index=0;index<this.relays.length;index++)this.wireReceiver(index);}
  onRelayState(index,status,relay){
    if(!this.audio || this.startCancelled)return;
    if(status!=='ready'){
      this.audio.dropTarget(relay);this.audio.dropReceiver(relay.connection?.receiver);
      this.syncMainCaller();this.bridge?.reconcile();this.audio.refreshTargets();return;
    }
    this.wireReceiver(index);this.syncMainCaller();this.audio.refreshTargets();
    const receiver=relay.connection?.receiver;
    for(const user of receiver?.speaking?.users?.keys?.() || []){
      if(this.dedicated.has(user))this.audio.broadcast(user,index,receiver);
      else if(this.additionalCallActive(user))this.audio.additionalBroadcast(index,user,receiver);
    }
  }

  setDedicated(ids){
    this.mainCaller.select(ids);this.dedicated=new Set(ids);this.audio?.stopBroadcast();
    for(const id of ids)this.audio?.stopAdditionalFor(id);
    this.followSignature=null;this.syncMainCaller();this.onChanged?.();this.onChanged?.();
  }
  setPaused(value){
    this.paused=!!value;this.mainCaller.pause(this.paused);this.audio?.stop();
    for(const map of [this.calloutTimers,this.priorityTimers]){for(const t of map.values())clearTimeout(t);map.clear();}
    this.calloutOpen.clear();this.priorityHeld.clear();
    this.onChanged?.();this.bridge?.reconcile();
    if(!this.paused){
      this.syncMainCaller();
      const user=this.mainCaller.id;
      for(let i=0;i<this.relays.length;i++){const receiver=this.relays[i].connection?.receiver;if(user && receiver?.speaking?.users?.has(user))this.audio?.broadcast(user,i,receiver);}
      if(user && this.main?.receiver?.speaking?.users?.has(user))this.audio?.broadcast(user,-1,this.main.receiver);
    }
  }
  syncMainCaller(){
    if(this.startCancelled || this.paused)return;
    const id=this.mainCaller.id;
    const voice=id?(this.guild.voiceStates?.cache.get(id) || this.guild.members.cache.get(id)?.voice):null;
    const channelId=voice?.channelId || null;
    const index=this.channels.findIndex(c=>c.id===channelId);
    const managed=index>=0;
    const signature=(id || '')+':'+(channelId || '');
    const ready=managed?(this.relays[index]?.connection?.state.status==='ready' && this.relays[index]?.client?.isReady?.()!==false):this.mainChannelId===channelId && this.main?.state.status==='ready';
    this.mainCaller.observe(channelId,!!ready,this.followError || null);
    if(signature===this.followSignature && (managed || !channelId || ready || this.followPending || Date.now()<this.followRetryAt))return;
    this.followSignature=signature;this.followRetryAt=Date.now()+5000;
    const generation=++this.followGeneration;this.followPending=false;
    this.audio?.stopBroadcast();this.audio?.dropTarget(this.followTarget);this.followPlayer?.stop(true);const previousMain=this.main;this.main=null;try{previousMain?.destroy();}catch{}
    this.main=null;this.mainChannelId=null;this.followTarget=null;this.followError=null;
    this.audio?.refreshTargets();
    if(!id || !channelId || managed)return;
    this.followPending=true;
    this.followMain(channelId,generation).catch(error=>{
      if(generation!==this.followGeneration || this.startCancelled)return;
      this.followError=error.message;this.mainCaller.observe(channelId,false,error.message);
      try{this.main?.destroy();}catch{}this.main=null;this.mainChannelId=null;this.followTarget=null;
      console.warn('[main-follow] failed:',error.message);
    }).finally(()=>{if(generation===this.followGeneration)this.followPending=false;});
  }
  async followMain(channelId,generation){
    let timer;let channel;
    try{channel=this.guild.channels.cache.get(channelId) || await Promise.race([this.guild.channels.fetch(channelId),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("Main caller channel lookup timed out.")),3000);})]);}finally{clearTimeout(timer);}
    if(generation!==this.followGeneration || this.startCancelled || this.paused)return;
    if(!channel || channel.type!==ChannelType.GuildVoice)throw Error('Main caller is not in an accessible voice channel.');
    const permissions=channel.permissionsFor?.(this.guild.members.me);
    if(permissions && !permissions.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw Error('Main bot cannot view, connect or speak in the main caller channel.');
    const conn=joinVoiceChannel({channelId,guildId:this.guild.id,adapterCreator:this.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false,group:'shotcaller-main'});
    this.main=conn;this.mainChannelId=channelId;
    conn.on('error',error=>this.operation?.event('main.follow.error',{channelId,error}));
    conn.on('stateChange',(_old,next)=>{if(this.startCancelled || this.main!==conn)return;this.operation?.event('main.follow.state',{channelId,from:_old.status,to:next.status});if(next.status!=='ready'){this.followPlayer?.stop(true);this.audio?.dropTarget(this.followTarget);this.audio?.dropReceiver(conn.receiver);this.mainCaller.observe(channelId,false);this.audio?.refreshTargets();}});
    if(!this.followPlayer){this.followPlayer=createAudioPlayer();this.followPlayer.on('error',error=>console.error('[main-follow] audio:',error.message));}
    conn.subscribe(this.followPlayer);
    await entersState(conn,VoiceConnectionStatus.Ready,20000);
    if(generation!==this.followGeneration || this.startCancelled){try{conn.destroy();}catch{}return;}
    this.followTarget={playOpus:stream=>{if(this.paused || this.main!==conn || conn.state.status!=='ready'){stream.destroy();return;}this.followPlayer.play(createAudioResource(stream,{inputType:StreamType.Opus}));}};
    conn.receiver.speaking.on('start',user=>{if(this.main===conn && this.dedicated.has(user))this.audio.broadcast(user,-1,conn.receiver);});
    this.mainCaller.observe(channelId,true);this.audio?.refreshTargets();
  }

  // Creates Party 2..N. Where they go depends on PARTY_PLACEMENT:
  //  "inplace"  — in the same category as the shotcaller's own channel, with that channel's permissions copied
  //               across, so exactly the people who can see and join the shotcaller's channel can see and join
  //               the parties (and nothing is accidentally opened up to the whole server).
  //  "category" — the old behaviour: a separate "Shotcaller Parties" category, open to everyone.
  async createPartyChannels(){
    // Clear out any channels an earlier run left behind (empty ones go now, occupied ones when they empty).
    await janitor.sweep(this.guild,this.channels.filter(Boolean).map(c=>c.id)).catch(e=>console.warn("[cleanup] sweep failed:",e.message));

    let parentId=null, overwrites;
    if(config.partyPlacement==="category"){
      let cat=this.guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name===config.partyCategoryName);
      const wantPos=config.partyCategoryPosition;
      if(!cat) cat=await this.guild.channels.create({name:config.partyCategoryName,type:ChannelType.GuildCategory,...(wantPos!==null?{position:wantPos}:{})});
      else if(wantPos!==null && cat.position!==wantPos) await cat.setPosition(wantPos).catch(e=>console.warn(`[cleanup] couldn't move the category to position ${wantPos}: ${e.message}`));
      parentId=cat.id;
      overwrites=[{id:this.guild.roles.everyone.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]}];
    }else{
      parentId=this.commandVoice.parentId||null;
      overwrites=[...(this.commandVoice.permissionOverwrites?.cache?.values?.()||[])].map(o=>({id:o.id,type:o.type,allow:o.allow.bitfield,deny:o.deny.bitfield}));
    }

    for(let i=1;i<this.count;i++){
      if(this.channels[i])continue;
      this.ensureStarting();
      const began=Date.now();
      const c=await this.makePartyChannel(`Party ${i+1}`,parentId,overwrites);
      this.operation?.event("channel.created",{channelId:c.id,relay:i+1,durationMs:Date.now()-began});
      janitor.track(c); // remembered on disk straight away, so cleanup can still find it after a restart
      this.channels[i]=c;
      this.createdChannels.push(c);
      this.ensureStarting();
    }
  }

  async makePartyChannel(name,parentId,overwrites){
    const base={name,type:ChannelType.GuildVoice,...(parentId?{parent:parentId}:{})};
    try{
      return await this.guild.channels.create({...base,permissionOverwrites:overwrites});
    }catch(e){
      // Discord refuses to hand out a permission the bot doesn't hold itself, so copying a channel that grants
      // something unusual can be rejected. Fall back to simply inheriting from the category.
      if(e.code!==50013 || config.partyPlacement==="category") throw e;
      console.warn(`[session] couldn't copy your channel's permissions onto "${name}" (${e.message}) — creating it to inherit from its category instead`);
      return await this.guild.channels.create(base);
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
    if(this.paused || !this.isAdditionalCaller(userId)) return false;
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
    if(this.paused || !this.isAdditionalCaller(userId)) return null; // caller shows the "not authorised" message
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
    this.lastPrioritySignal={at:Date.now(),userId,flags:Number(flags),authorised:this.isAdditionalCaller(userId),paused:this.paused};
    if(this.paused || !this.isAdditionalCaller(userId)) return;
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
      new ButtonBuilder().setCustomId("callout_toggle").setLabel(`📢 Callout (${secs}s)`).setStyle(ButtonStyle.Success)
    );
  }

  additionalMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("additional_select").setPlaceholder(`Extra callers for this game, on top of the role (up to ${MAX_ADDITIONAL_CALLERS}) — none to clear`).setMinValues(0).setMaxValues(MAX_ADDITIONAL_CALLERS)
    );
  }

  dedicatedMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("dedicated_select").setPlaceholder("Pick one main caller — select none to clear").setMinValues(0).setMaxValues(1)
    );
  }

  async destroy({preserveChannels=false}={}){
    this.startCancelled=true;this.bridge?.reconcile();
    clearInterval(this.followTimer);if(this.voiceListener)this.guild.client.removeListener("voiceStateUpdate",this.voiceListener);this.followGeneration++;
    this.followPlayer?.stop(true);
    for(const m of [this.calloutTimers,this.priorityTimers]) for(const t of m.values()) clearTimeout(t);
    const errors=[],pending=[];
    try{this.audio?.stop();}catch(e){errors.push(e);}
    // Invoke every relay immediately: no slow gateway request delays the next voice disconnect.
    for(const r of this.relays)try{pending.push(Promise.resolve(r.destroy()));}catch(e){errors.push(e);}
    try{if(this.main?.state?.status!=='destroyed')this.main?.destroy();this.main=null;}catch(e){errors.push(e);}
    for(const result of await Promise.allSettled(pending))if(result.status==='rejected')errors.push(result.reason);
    // Occupied channels are retired without kicking listeners; the janitor deletes them when empty.
    for(const c of preserveChannels?[]:this.createdChannels)try{await janitor.retire(c);}catch(e){errors.push(e);}
    if(errors.length)throw new AggregateError(errors,'Session cleanup failed; retry Stop.');
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
      .setDescription(`${parties}\n\nThe main caller is heard by every other party. Anyone with the **${config.additionalCallerRoleName}** role can call out to the main caller, or all other parties when the main caller is unavailable (button in each party's chat, ${secs}s).`)
      .addFields(
        {name:"Audio",value:this.muted?"🔇 Muted":"🔊 Active",inline:true},
        {name:"Dedicated",value:this.dedicated.size?names(this.dedicated):"None (PTT-Prio to all parties)",inline:true},
        {name:"Additional callers",value:[this.callerRoleId?`<@&${this.callerRoleId}> role`:`⚠️ role "${config.additionalCallerRoleName}" not found`,...(this.additionalCallers.size?[`+ extras: ${names(this.additionalCallers)}`]:[])].join("\n"),inline:true},
        {name:"Bridge",value:this.bridge?.desired?this.bridge.state:"Off",inline:true}
      );
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mute").setLabel(this.muted?"Unmute":"Mute").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dedicated").setLabel("Dedicated").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("additional_setup").setLabel("Extra Callers").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bridge").setLabel(this.bridge?.desired?"End Bridge":"Bridge").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger)
    );
    return {embeds:[e],components:[buttons]};
  }
}
module.exports={Session,MAX_ADDITIONAL_CALLERS};

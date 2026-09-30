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
    this.channels=[]; this.createdChannels=[]; this.relays=[]; this.muted=false; this.dedicated=null;
    this.bridge=null; this.panelMessage=null; this.main=null; this.mainPlayer=null;
    this.partyReceivers=new Map(); this.config=config;
    this.audio=null; this.relayActive=new Map(); // userId -> bool, toggled via button
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
        content:`🎙️ Talk normally with your party here. If you have the **${config.whisperRoleName}** role, use this button to open or close a direct line to the shotcaller.`,
        components:[this.whisperToggleRow()]
      }).catch(()=>{});
    }

    this.main=joinVoiceChannel({
      channelId:this.commandVoice.id,guildId:this.guild.id,
      adapterCreator:this.guild.voiceAdapterCreator,selfDeaf:false,selfMute:false,
      group:"shotcaller-main"
    });
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
    this.main.receiver.speaking.on("start",u=>this.audio.broadcast(u));

    // Each relay is also a receiver for its own party, allowing whisper routing back to the shotcaller.
    for(let j=0;j<this.relays.length;j++){
      const r=this.relays[j];
      const receiver=r.connection?.receiver;
      if(!receiver) continue;
      this.partyReceivers.set(j,receiver);
      receiver.speaking.on("start",userId=>{
        if(this.whisperAllowed(userId)) this.routeWhisper(j,userId);
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
    const next = !(this.relayActive.get(userId) === true);
    this.relayActive.set(userId, next);
    return next;
  }

  whisperToggleRow(){
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("whisper_toggle").setLabel("🎙️ Toggle Whisper to Shotcaller").setStyle(ButtonStyle.Primary)
    );
  }

  routeWhisper(index,userId){
    const receiver=this.partyReceivers.get(index);
    if(!receiver) return;
    this._partyReceiver=receiver;
    this.audio.whisper(userId);
  }

  async destroy(){
    this.audio?.stop();
    this.relays.forEach(r=>r.destroy());
    try{this.main?.destroy()}catch{}
    for(const c of this.createdChannels) await c.delete("Shotcaller session ended").catch(()=>{});
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
        {name:"Dedicated",value:this.dedicated?`<@${this.dedicated}>`:"Off",inline:true},
        {name:"Bridge",value:this.bridge?.active?"Active":"Off",inline:true}
      );
    const buttons=new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("mute").setLabel(this.muted?"Unmute":"Mute").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dedicated").setLabel("Dedicated").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bridge").setLabel(this.bridge?.active?"End Bridge":"Bridge").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("stop").setLabel("Stop").setStyle(ButtonStyle.Danger)
    );
    return {embeds:[e],components:[buttons]};
  }

  dedicatedMenu(){
    return new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId("dedicated_select").setPlaceholder("Pick the dedicated caller").setMinValues(1).setMaxValues(1)
    );
  }
}
module.exports={Session};

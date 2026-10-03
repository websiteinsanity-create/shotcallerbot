const {
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder,
  ActionRowBuilder, StringSelectMenuBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle
} = require("discord.js");
const http=require("http");
const config=require("./config");
const {Session}=require("./session");
const {canUse,canBridge,canWhisper}=require("./permissions");

if(!config.mainToken||!config.clientId) throw new Error("Set MAIN_BOT_TOKEN and CLIENT_ID in .env");

// Safety net: a Discord API hiccup (rate limit, expired interaction token, network blip) must never
// take down the whole bot and every active session with it. Log it and keep running.
process.on("unhandledRejection",e=>console.error("Unhandled rejection (bot kept running):",e));
process.on("uncaughtException",e=>console.error("Uncaught exception (bot kept running):",e));

const client=new Client({intents:[
  GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildVoiceStates
]});
const sessions=new Map();

const command=new SlashCommandBuilder()
  .setName("shotcaller").setDescription("Shotcaller control")
  .addSubcommand(s=>s.setName("start").setDescription("Start a Shotcaller session"))
  .addSubcommand(s=>s.setName("stop").setDescription("Stop the active Shotcaller session and clean up party channels"));

async function register(){
  const rest=new REST({version:"10"}).setToken(config.mainToken);
  const route=config.devGuildId?Routes.applicationGuildCommands(config.clientId,config.devGuildId):Routes.applicationCommands(config.clientId);
  await rest.put(route,{body:[command.toJSON()]});
}

client.once("ready",async()=>{console.log(`Shotcaller online as ${client.user.tag}`);await register()});

client.on("interactionCreate",async i=>{
  try{
    if(i.isChatInputCommand()){
      const sub=i.options.getSubcommand();

      if(sub==="stop"){
        const s=sessions.get(i.guildId);
        if(!s) return i.reply({content:"No active Shotcaller session to stop.",ephemeral:true}).catch(e=>console.error(e));
        if(!canUse(i.member)) return i.reply({content:"You need the Shotcaller, Officer, Leader or Administrator permission.",ephemeral:true}).catch(e=>console.error(e));
        await i.reply({content:"Stopping Shotcaller and cleaning up party channels…",ephemeral:true}).catch(e=>console.error(e));
        await s.destroy();sessions.delete(i.guildId);
        try{ await s.panelMessage?.edit({content:"Shotcaller stopped.",embeds:[],components:[]}); }catch{}
        return;
      }

      if(!canUse(i.member)) return i.reply({content:"You need the Shotcaller, Officer, Leader or Administrator permission.",ephemeral:true}).catch(e=>console.error(e));
      if(!i.member.voice.channel) return i.reply({content:"Join a voice channel first.",ephemeral:true}).catch(e=>console.error(e));
      if(sessions.has(i.guildId)) return i.reply({content:"A Shotcaller session is already active.",ephemeral:true}).catch(e=>console.error(e));
      const menu=new StringSelectMenuBuilder().setCustomId("mode").setPlaceholder("Choose a mode").addOptions(
        {label:"GvG — 8 parties",value:"8"},
        {label:"Full Guild — 12 parties",value:"12"},
        {label:"Bridge — 8 parties",value:"bridge"},
        {label:"Custom — 1 to 12",value:"custom"}
      );
      return i.reply({content:"Choose a mode:",components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true}).catch(e=>console.error(e));
    }

    if(i.isStringSelectMenu() && i.customId==="mode"){
      if(i.values[0]==="custom"){
        const modal=new ModalBuilder().setCustomId("custom_count").setTitle("Custom Shotcaller");
        const input=new TextInputBuilder().setCustomId("count").setLabel("Number of parties (1–12)").setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setPlaceholder("8");
        return i.showModal(modal.addComponents(new ActionRowBuilder().addComponents(input))).catch(e=>console.error(e));
      }
      const count=i.values[0]==="bridge"?8:Number(i.values[0]);
      return startSession(i,count,i.values[0]==="bridge");
    }

    if(i.isModalSubmit() && i.customId==="custom_count"){
      const n=Number(i.fields.getTextInputValue("count"));
      if(!Number.isInteger(n)||n<1||n>12) return i.reply({content:"Enter a whole number from 1 to 12.",ephemeral:true}).catch(e=>console.error(e));
      return startSession(i,n,false);
    }

    const s=sessions.get(i.guildId);
    if(!s) return;

    if(i.isButton() && i.customId==="whisper_toggle"){
      if(!canWhisper(i.member)) return i.reply({content:`You need the ${config.whisperRoleName} role to use this.`,ephemeral:true}).catch(e=>console.error(e));
      const on=s.toggleRelay(i.user.id);
      const secs=Math.round(config.whisperAutoOffMs/1000);
      return i.reply({content:on?`🎙️ Line to the shotcaller is **OPEN** for the next ${secs}s — say your callout now. It'll close itself automatically, or click again to close it early.`:"🔇 Line closed — back to normal party chat.",ephemeral:true}).catch(e=>console.error(e));
    }

    if(i.isButton() && i.customId==="secondary_toggle"){
      if(!s.secondaryCallers.has(i.user.id)) return i.reply({content:"You're not currently set as a secondary caller.",ephemeral:true}).catch(e=>console.error(e));
      const on=s.toggleSecondary(i.user.id);
      const secs=Math.round(config.whisperAutoOffMs/1000);
      return i.reply({content:on?`📢 You're **LIVE to everyone** for the next ${secs}s — every party and the shotcaller can hear you now. It'll close itself automatically, or click again to close it early.`:"🔇 Callout closed.",ephemeral:true}).catch(e=>console.error(e));
    }

    if(!canUse(i.member)) return i.reply({content:"No permission.",ephemeral:true}).catch(e=>console.error(e));

    if(i.isButton()){
      if(i.customId==="mute"){s.muted=!s.muted;if(s.muted)s.audio.stopBroadcast();}
      if(i.customId==="dedicated") return i.reply({content:"Choose the dedicated caller(s):",components:[s.dedicatedMenu()],ephemeral:true}).catch(e=>console.error(e));
      if(i.customId==="secondary_setup") return i.reply({content:"Choose up to 6 secondary callers — they'll get a button in their party chat to call out to everyone:",components:[s.secondaryMenu()],ephemeral:true}).catch(e=>console.error(e));
      if(i.customId==="bridge"){
        if(!canBridge(i.member)) return i.reply({content:"Officer/Leader/Admin required.",ephemeral:true}).catch(e=>console.error(e));
        if(s.bridge?.active) s.bridge=null;
        else {
          const partner=config.bridgePartners.get(i.guildId);
          if(!partner) return i.reply({content:"No partner guild is configured for this guild.",ephemeral:true}).catch(e=>console.error(e));
          s.bridge={active:false,partnerGuildId:partner,requestedBy:i.guildId};
          return i.reply({content:`Bridge request created for partner guild ${partner}. The partner side must accept.`,ephemeral:true}).catch(e=>console.error(e));
        }
      }
      if(i.customId==="stop"){
        await i.update({content:"Shotcaller stopped.",embeds:[],components:[]}).catch(e=>console.error(e));
        await s.destroy();sessions.delete(i.guildId);
        return;
      }
    }

    if(i.isUserSelectMenu() && i.customId==="dedicated_select"){
      s.dedicated=new Set(i.values);s.audio.stopBroadcast();
      const msg=s.dedicated.size?`Dedicated caller(s) set to ${[...s.dedicated].map(id=>`<@${id}>`).join(", ")}.`:"Dedicated mode cleared — anyone can broadcast again.";
      await i.update({content:msg,components:[]}).catch(e=>console.error(e));
      await s.panelMessage?.edit(s.panel());
      return;
    }

    if(i.isUserSelectMenu() && i.customId==="secondary_select"){
      s.secondaryCallers=new Set(i.values);
      const msg=s.secondaryCallers.size?`Secondary callers set to ${[...s.secondaryCallers].map(id=>`<@${id}>`).join(", ")}.`:"Secondary callers cleared.";
      await i.update({content:msg,components:[]}).catch(e=>console.error(e));
      await s.panelMessage?.edit(s.panel());
      return;
    }

    await s.panelMessage?.edit(s.panel());
    if(!i.replied&&!i.deferred) await i.reply({content:"Updated.",ephemeral:true}).catch(e=>console.error(e));
  }catch(e){
    console.error(e);
    if(!i.replied&&!i.deferred) await i.reply({content:`Error: ${e.message}`,ephemeral:true}).catch(err=>console.error(err));
  }
});

// Acknowledges the interaction FIRST (deferUpdate, must happen within Discord's 3-second window),
// then does the slow work (creating channels, logging in every relay bot one at a time — this alone
// can easily take longer than 3 seconds with several relays). This function is never allowed to
// reject: every Discord API call inside it is individually caught, so it's always safe for a caller
// to do `return startSession(...)` without awaiting it.
async function startSession(i,count,bridge){
  // Hard guard: reserve this guild's session slot immediately, synchronously, before any slow/async
  // work. Without this, two near-simultaneous start attempts (e.g. a rare Discord gateway hiccup
  // re-delivering an interaction) could both pass the earlier "already active" check and each spin up
  // their own independent Session/relay set for the same guild — duplicate relay bots, duplicate
  // listeners, chaos. Whoever gets here first claims the slot; anyone else bails out immediately.
  if(sessions.has(i.guildId)){
    try{ await i.deferUpdate(); }catch{}
    return;
  }
  sessions.set(i.guildId,null); // placeholder, replaced with the real Session once start() finishes
  try{
    await i.deferUpdate();
  }catch(e){
    console.error("Could not acknowledge the start interaction in time:",e);
    sessions.delete(i.guildId);
    return;
  }
  try{
    const s=new Session(i.guild,i.member,count);
    await s.start();
    if(bridge)s.bridge={active:false,partnerGuildId:config.bridgePartners.get(i.guildId)||null};
    sessions.set(i.guildId,s);
    s.panelMessage=await i.channel.send(s.panel());
    await i.editReply({content:"Shotcaller started.",components:[]}).catch(e=>console.error("Could not confirm the start:",e));
  }catch(e){
    console.error("Shotcaller failed to start:",e);
    sessions.delete(i.guildId); // release the reserved slot so a retry isn't permanently blocked
    await i.editReply({content:`Could not start Shotcaller: ${e.message}`,components:[]}).catch(err=>console.error("Could not report the start failure:",err));
  }
}

http.createServer((req,res)=>{
  if(req.method==="GET" && (req.url==="/" || req.url==="/health")){
    res.writeHead(200,{"content-type":"text/plain"});
    return res.end("Shotcaller OK\n");
  }
  res.writeHead(404);res.end();
}).listen(config.port,()=>console.log(`Health endpoint on :${config.port}`));

client.login(config.mainToken);

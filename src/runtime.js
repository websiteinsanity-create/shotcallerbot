'use strict';
const fs=require('node:fs'),path=require('node:path');
const {AllianceBridge}=require('./bridge');
const {loadRuntimeState}=require('./runtime-state');
const {reserveStart,completeStart,stopSession}=require('./lifecycle');
class Runtime {
 constructor(sessions,client,config){
  this.sessions=sessions;this.client=client;this.config=config;this.file=path.join(config.dataDir,'runtime.json');
  if(!!config.insanityGuildId!==!!config.allianceGuildId || (config.insanityGuildId && (!/^\d{15,25}$/.test(config.insanityGuildId) || !/^\d{15,25}$/.test(config.allianceGuildId) || config.insanityGuildId===config.allianceGuildId)))throw Error('Set two distinct Discord ids in INSANITY_GUILD_ID and ALLIANCE_GUILD_ID.');
  // Legacy data is migrated, damaged data is preserved under a new name; see runtime-state.js.
  const loaded=loadRuntimeState(this.file,{now:config.now,log:config.log});this.saved=loaded.state;this.loadResult={kind:loaded.kind,notes:loaded.notes,preservedAs:loaded.preservedAs?path.basename(loaded.preservedAs):null};
  this.restoring=new Set();this.retryAt=new Map();
  this.bridge=config.insanityGuildId && config.allianceGuildId?new AllianceBridge({sessions,insanityGuildId:config.insanityGuildId,allianceGuildId:config.allianceGuildId,saved:this.saved.bridge,save:value=>{this.saved.bridge=value;this.write();}}):null;
  sessions.runtime=this;
 }
 write(){fs.mkdirSync(this.config.dataDir,{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(this.saved,null,2),{mode:0o600});fs.renameSync(temp,this.file);}
 capture(s){return {channelId:s.commandVoice.id,count:s.count,callerId:s.mainCaller.id,additionalCallers:[...s.additionalCallers],paused:!!s.paused,muted:!!s.muted,channels:s.channels.map(c=>({id:c.id,name:c.name,created:s.createdChannels.includes(c)}))};}
 started(s){s.onChanged=()=>{if(this.sessions.get(s.guild.id)===s)this.remember(s);};this.remember(s);this.bridge?.reconcile();s.resumeSpeaking?.();}
 remember(s){this.saved.sessions[s.guild.id]=this.capture(s);this.write();}
 beforeStop(guildId,choice){
  if(this.bridge?.desired && this.bridge.belongs(guildId)){
   if(!['keep','end'].includes(choice))throw Object.assign(Error('Choose Keep Bridge Waiting or End Alliance Bridge.'),{status:409,choices:['keep','end']});
   if(choice==='end')this.bridge.end(guildId);
  }
  delete this.saved.sessions[guildId];this.write();
 }
 stopped(){this.bridge?.reconcile();}
 snapshot(guildId,admin=false){if(!this.bridge?.belongs(guildId))return null;return this.bridge.snapshot(guildId,admin);}
 async restoreOne(guildId){
  const record=this.saved.sessions[guildId];if(this.shuttingDown || !record || this.sessions.has(guildId) || this.restoring.has(guildId) || Date.now()<(this.retryAt.get(guildId)||0))return;
  this.restoring.add(guildId);
  try{
   const guild=this.client.guilds.cache.get(guildId);if(!guild)throw Error('Restore guild unavailable');
   const channel=await guild.channels.fetch(record.channelId);if(!channel || channel.guild.id!==guildId)throw Error('Restore channel unavailable');
   if(this.shuttingDown || this.saved.sessions[guildId]!==record || this.sessions.has(guildId))return;
   const {preflight}=require('./preflight');await preflight({guild,channel,count:record.count,config:this.config,client:this.client});
   if(this.shuttingDown || this.saved.sessions[guildId]!==record || this.sessions.has(guildId))return;
   const reservation=reserveStart(this.sessions,guildId);
   const {Session}=require('./session');
   await completeStart(this.sessions,guildId,reservation,async()=>{const s=new Session(guild,channel,record.callerId,record.count);s.restoreSpec=record;s.additionalCallers=new Set(record.additionalCallers || []);s.muted=!!record.muted;return s;});
  }catch(error){this.retryAt.set(guildId,Date.now()+30000);console.error('[restore]',guildId,error.message);}
  finally{this.restoring.delete(guildId);}
 }
 async start(){
  await Promise.all(Object.keys(this.saved.sessions).map(id=>this.restoreOne(id)));
  this.timer=setInterval(()=>{this.bridge?.reconcile();for(const id of Object.keys(this.saved.sessions))this.restoreOne(id).catch(e=>console.error('[restore]',e.message));},1000);this.timer.unref?.();
 }
 async shutdown(){this.shuttingDown=true;clearInterval(this.timer);for(const s of this.sessions.values())s.cancelStart?.();await Promise.allSettled([...this.sessions.values()].map(s=>(s.session || s).destroy?.({preserveChannels:true})));}
}
module.exports={Runtime};

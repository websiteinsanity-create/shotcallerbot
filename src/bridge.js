'use strict';
const {randomUUID}=require('node:crypto');
const fail=(message,status=409)=>Object.assign(Error(message),{status});
// Policy and lifecycle only. AudioRouter owns decoding; all sources share one output mixer per target.
class AllianceBridge {
 constructor({sessions,insanityGuildId,allianceGuildId,save=()=>{},saved={}}){
  this.sessions=sessions;this.guilds=[insanityGuildId,allianceGuildId];this.save=save;
  this.originalMains={...saved.originalMains};this.id=saved.id || randomUUID();this.desired=!!saved.desired;this.paused=this.desired && saved.paused===true;this.state='off';this.everActive=false;
  this.mainEnabled={...Object.fromEntries(this.guilds.map(id=>[id,true])),...saved.mainEnabled};
  this.allowAllianceManage=!!saved.allowAllianceManage;this.bufferMs=saved.bufferMs ?? 40;
  this.swipe=false;this.mixers=new Map();this.attached=new Set();this.events=[];this.lastRoutingReady=false;
 }
 // Caller presence is a routing concern, not proof of transport failure.
 health(id){const s=this.session(id);if(!s)return {present:false,ready:false,failure:false};
  const gateway=s.guild.client.isReady?.()!==false;
  const relays=s.relays || [],readyRelays=relays.filter(r=>r.connection?.state.status==='ready' && r.client.isReady?.()!==false).length;
  const expected=s.count || s.channels?.length || relays.length;
  const caller=s.mainCaller.snapshot(),needsFollow=!!caller.channelId && !s.channels?.some(c=>c.id===caller.channelId);
  const followReady=!needsFollow || !!s.followTarget && s.main?.state.status==='ready';
  const failure=!!(needsFollow && (s.followError || s.main && ['disconnected','destroyed'].includes(s.main.state.status))) || !gateway || relays.some(r=>r.disconnectedSince || r.recovering || r.recoveryFailed || r.connection && ['disconnected','destroyed'].includes(r.connection.state.status) || r.client.isReady?.()===false);
  return {present:true,paused:!!s.paused,ready:!!s.audio && !s.paused && gateway && expected>0 && readyRelays===expected && followReady,failure};
 }
 get active(){return this.state==='active';}
 // A targeted relay recovery does not silence the remaining healthy paths.
 get routingReady(){return this.desired && !this.paused && this.guilds.every(id=>{const s=this.session(id);return s?.audio && !s.paused && s.guild.client.isReady?.()!==false && s.relays.some(r=>r.connection?.state.status==='ready' && r.client.isReady?.()!==false);});}
 belongs(id){return this.guilds.includes(id);}
 session(id){const s=this.sessions.get(id);return s && !s.lifecycle && !s.startCancelled?s:null;}
 persist(){this.save({id:this.id,desired:this.desired,paused:this.paused,mainEnabled:this.mainEnabled,allowAllianceManage:this.allowAllianceManage,bufferMs:this.bufferMs,originalMains:this.originalMains});}
 event(type,actor){this.events.unshift({at:new Date().toISOString(),type,actor});this.events=this.events.slice(0,30);}
 resetAudio(){for(const s of this.attached){s.audio?.stop();for(const r of s.relays)r.voicePlayer?.stop(true);s.followPlayer?.stop(true);}for(const m of this.mixers.values())m.stop();this.mixers.clear();}
 reconcile(){
  for(const s of this.attached)if(this.session(s.guild.id)!==s){s.audio?.stop();if(s.bridge===this)s.bridge=null;this.attached.delete(s);}
  for(const id of this.guilds){const s=this.session(id);if(this.desired && s && s.bridge!==this){s.audio?.stop();if(!(id in this.originalMains)){this.originalMains[id]=[...s.dedicated];this.persist();}s.bridge=this;this.attached.add(s);}}
  const health=this.guilds.map(id=>this.health(id));
  const ready=health.every(h=>h.ready);
  const failed=health.some(h=>h.failure);
  const infrastructureState=ready?'active':health.some(h=>!h.present || h.paused)?'waiting':failed?'reconnecting':'connecting';
  this.infrastructureState=infrastructureState;
  const next=!this.desired?'off':this.paused?'paused':infrastructureState;
  const routing=this.routingReady;if(routing!==this.lastRoutingReady){this.resetAudio();this.lastRoutingReady=routing;}
  if(next!==this.state){this.state=next;if(next!=='active' && next!=='paused')this.swipe=false;else if(next==='active')this.everActive=true;this.event(next);}
  if(this.paused && infrastructureState!=='active')this.swipe=false;
  if(!this.desired){for(const s of this.attached){if(s.bridge===this)s.bridge=null;s.resumeSpeaking?.();}this.attached.clear();}
  for(const s of this.attached){s.audio?.refreshTargets();s.resumeSpeaking?.();}
 }
 start(actor){if(!this.desired){this.id=randomUUID();this.mainEnabled=Object.fromEntries(this.guilds.map(id=>[id,true]));this.everActive=false;this.originalMains={};this.paused=false;}this.desired=true;this.persist();this.event('start',actor);this.reconcile();}
 setPaused(value,actor){
  if(!this.desired)throw fail('Start the bridge first.');
  if(this.paused===value){this.reconcile();return;}
  // Discard all pre-transition source and output queues synchronously. Sessions and connections stay intact.
  this.paused=value;this.resetAudio();this.persist();this.event(value?'pause':'resume',actor);this.reconcile();
 }
 restart(actor){
  if(!this.desired)throw fail('Start the bridge first.');
  // Restart only bridge audio routing: never tear down relays, reset mains or end/start sessions.
  this.resetAudio();this.event('restart',actor);this.reconcile();
 }
 end(actor){this.desired=false;this.paused=false;this.persist();this.resetAudio();
  for(const id of this.guilds){const s=this.session(id);if(s && this.originalMains[id] && s.setDedicated){s.setDedicated(this.originalMains[id]);}}
  this.event('end',actor);this.reconcile();}
 configure(actorGuild,action,body={},admin=false){
  if(!this.belongs(actorGuild))throw fail('Guild is not part of this bridge.',403);
  const own=actorGuild===this.guilds[0];
  if(action==='start')this.start(actorGuild);
  else if(action==='end')this.end(actorGuild);
  else if(action==='pause')this.setPaused(true,actorGuild);
  else if(action==='resume')this.setPaused(false,actorGuild);
  else if(action==='restart')this.restart(actorGuild);
  else if(action==='mains'){
   if(!own && !this.allowAllianceManage)throw fail('Alliance main configuration is not permitted.',403);
   if(!this.desired)throw fail('Start the bridge first.');
   if(!body.mainEnabled || this.guilds.some(id=>typeof body.mainEnabled[id]!=='boolean') || Object.keys(body.mainEnabled).some(id=>!this.belongs(id)))throw fail('Supply a boolean for each bridge main.',400);
   this.mainEnabled={...body.mainEnabled};this.persist();this.resetAudio();this.event('mains',actorGuild);
  }else if(action==='swipe'){
   if(!own)throw fail('Swipe is restricted to Insanity.',403);
   if(!this.active || typeof body.enabled!=='boolean')throw fail('Swipe needs an active bridge and a boolean enabled value.');
   this.swipe=body.enabled;this.resetAudio();this.event('swipe',actorGuild);
  }else if(action==='settings'){
   if(!own || !admin)throw fail('Insanity administrator required.',403);
   if(body.allowAllianceManage!==undefined && typeof body.allowAllianceManage!=='boolean')throw fail('Permission must be boolean.',400);
   if(body.bufferMs!==undefined && (!Number.isInteger(body.bufferMs) || body.bufferMs<20 || body.bufferMs>100 || body.bufferMs%20))throw fail('Buffer must be 20, 40, 60, 80 or 100 ms.',400);
   if(body.allowAllianceManage!==undefined)this.allowAllianceManage=body.allowAllianceManage;
   if(body.bufferMs!==undefined)this.bufferMs=body.bufferMs;
   this.persist();this.resetAudio();this.event('settings',actorGuild);
  }else throw fail('Unknown bridge action.',400);
  this.reconcile();return this.snapshot(actorGuild,admin);
 }
 // Local conversations are still native Discord audio. Never ingest any bot identity as an original source.
 botSource(user){for(const s of this.attached){if(s.guild.client.user?.id===user || s.relays.some(r=>r.client.user?.id===user) || s.guild.members.cache.get(user)?.user?.bot)return true;}return false;}
 targets(sourceSession,sourceId,additional,user){
  if(!this.routingReady)return [];
  if(this.botSource(user))return [];
  if(this.swipe && sourceSession.guild.id===this.guilds[1] && sourceSession.dedicated.has(user))return [];
  const all=[];
  for(const id of this.guilds){const s=this.session(id);if(!s || s.paused || s.muted)continue;
   for(let i=0;i<s.relays.length;i++){const r=s.relays[i];if(r.connection?.state.status==='ready' && r.client.isReady?.()!==false && !(s===sourceSession && s.channels[i]?.id===sourceId))all.push({target:r,session:s,channel:s.channels[i]?.id});}
   if(s.followTarget && s.main?.state.status==='ready' && !(s===sourceSession && s.mainChannelId===sourceId))all.push({target:s.followTarget,session:s,channel:s.mainChannelId});
  }
  if(additional){const configured=this.guilds.some(id=>this.mainEnabled[id] && this.session(id)?.mainCaller.id);
   const mains=this.guilds.flatMap(id=>{const s=this.session(id),m=s?.mainCaller.snapshot();return this.mainEnabled[id] && s?.mainCaller.id && m?.available?[{guild:id,channel:m.channelId}]:[];});
   if(configured)return all.filter(t=>mains.some(m=>m.guild===t.session.guild.id && m.channel===t.channel)).map(t=>t.target);
  }
  return all.map(t=>t.target);
 }
 snapshot(guildId,admin=false){return {id:this.id,active:this.active,routingReady:this.routingReady,desired:this.desired,state:this.state,paused:this.paused,infrastructureState:this.infrastructureState,canPause:true,canRestart:this.desired,partnerGuildId:this.guilds.find(id=>id!==guildId),mainEnabled:{...this.mainEnabled},swipe:this.swipe,canManageMains:guildId===this.guilds[0] || this.allowAllianceManage,canSwipe:guildId===this.guilds[0],events:this.events.slice(0,10),sessions:this.guilds.map(id=>{const s=this.session(id);return {guildId:id,ready:this.health(id).ready,transportFailure:this.health(id).failure,paused:!!s?.paused,callerId:s?.mainCaller.id || null,callerName:s?.guild.members.cache.get(s?.mainCaller.id)?.displayName || null,mainAvailable:!!s?.mainCaller.snapshot().available,relayHealth:s?.relays.map((r,i)=>({relay:i+1,channelId:s.channels[i]?.id,voiceState:r.connection?.state.status || 'disconnected',gatewayReady:r.client.isReady?.()!==false,reconnecting:!!r.recovering,rejoinAttempts:r.rejoins || 0})) || [],relays:s?.relays.length || 0,readyRelays:s?.relays.filter(r=>r.connection?.state.status==='ready' && r.client.isReady?.()!==false).length || 0,warnings:s?.relays.flatMap((r,i)=>r.disconnectedSince && Date.now()-r.disconnectedSince>=30000?[{relay:i+1,channelId:s.channels[i]?.id,since:r.disconnectedSince}]:[]) || []};}),...(admin && guildId===this.guilds[0]?{audio:{bufferMs:this.bufferMs,endToEndLatencyMs:null,mixers:[...this.mixers.values()].map(m=>({...m.stats}))},allowAllianceManage:this.allowAllianceManage}:{})};}
}
module.exports={AllianceBridge};

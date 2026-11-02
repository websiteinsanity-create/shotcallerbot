'use strict';
const {EndBehaviorType}=require('@discordjs/voice');
const {OpusEncoder}=require('@discordjs/opus');
const {VoiceMixer}=require('./mixer');
class AudioRouter {
 constructor(session){this.s=session;this.streams=new Map();this.mixers=new Map();this.stats={started:0,packets:0,lastRoute:null,recentRoutes:[]};}
 mixer(target){if(this.s.bridge?.active){this.mixers=this.s.bridge.mixers;}if(!this.mixers.has(target))this.mixers.set(target,new VoiceMixer({bufferMs:this.s.bridge?.active?this.s.bridge.bufferMs:0,encoder:new OpusEncoder(48000,2),play:stream=>target.playOpus(stream)}));return this.mixers.get(target);}
 route(userId,sourceIndex,receiver,additional){
 if(this.s.muted || this.s.paused || !receiver || !userId || this.s.guild?.members?.cache.get(userId)?.user?.bot || this.s.relays.some(r=>r.client?.user?.id===userId) || this.s.guild?.client?.user?.id===userId)return;
 const source=sourceIndex<0?this.s.main:this.s.relays[sourceIndex]?.connection;
 if(!source || source.state.status!=='ready' || source.receiver!==receiver || (sourceIndex>=0 && this.s.relays[sourceIndex]?.client?.isReady?.()===false))return;
 if(additional?!this.s.additionalCallActive(userId):!this.s.dedicated.has(userId))return;
 const key=(this.s.bridge?.active?this.s.guild.id+':':'')+(additional?'extra:':'main:')+userId;if(this.streams.get(key)?.receiver===receiver)return;
 if(this.streams.has(key))this.stopKey(key);
 const sourceId=sourceIndex<0?this.s.mainChannelId:this.s.channels[sourceIndex]?.id;
 const targets=this.targets(sourceId,additional,userId);
 if(!targets.length)return;
 let stream=receiver.subscribe(userId,{end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}});
 if(stream.destroyed){receiver.subscriptions?.delete(userId);stream=receiver.subscribe(userId,{end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}});}
 const decoder=new OpusEncoder(48000,2),mixers=targets.map(t=>this.mixer(t));let ended=false;
 this.streams.set(key,{stream,mixers,receiver,sourceId,additional,userId});mixers.forEach(m=>m.add(key));this.stats.started++;this.stats.lastRoute={at:Date.now(),kind:additional?'callout':'main',sourceChannelId:sourceId,sourceGuildId:this.s.guild?.id || null,targetChannelIds:targets.map(t=>{for(const s of this.s.bridge?.active?this.s.bridge.attached:[this.s]){if(t===s.followTarget)return s.mainChannelId;const i=s.relays.indexOf(t);if(i>=0)return s.channels[i]?.id;}return null;})};
 this.stats.recentRoutes.unshift(this.stats.lastRoute);this.stats.recentRoutes=this.stats.recentRoutes.slice(0,20);
 const end=()=>{if(ended)return;ended=true;if(this.streams.get(key)?.stream!==stream)return;this.streams.delete(key);mixers.forEach(m=>m.end(key));};
 stream.on('data',packet=>{if(this.s.muted || this.s.paused)return;try{const pcm=decoder.decode(packet);this.stats.packets++;mixers.forEach(m=>m.push(key,pcm));}catch(error){console.error('[audio] decode failed:',error.message);}});
 stream.once('end',end);stream.once('close',end);stream.once('error',error=>{console.error('[audio] receive error:',error.message);end();});
 }
 targets(sourceId,additional,userId){
  if(this.s.bridge?.active)return this.s.bridge.targets(this.s,sourceId,additional,userId);
  let targets=this.s.relays.filter((r,i)=>this.s.channels[i]?.id!==sourceId && r.connection?.state.status==='ready' && r.client?.isReady?.()!==false);
  const main=this.s.mainCaller.snapshot();
  if(additional && main.available)targets=targets.filter(r=>this.s.channels[this.s.relays.indexOf(r)]?.id===main.channelId);
  if(this.s.followTarget && this.s.main?.state.status==='ready' && this.s.mainChannelId!==sourceId && (!additional || !main.available || main.channelId===this.s.mainChannelId))targets.push(this.s.followTarget);
  return targets;
 }
 dropTarget(target){const mixer=this.mixers.get(target);if(!mixer)return;for(const item of this.streams.values()){const index=item.mixers.indexOf(mixer);if(index>=0)item.mixers.splice(index,1);}mixer.stop();this.mixers.delete(target);}
 dropReceiver(receiver){for(const [key,item] of [...this.streams])if(item.receiver===receiver)this.stopKey(key);}
 refreshTargets(){if(this.s.paused || this.s.muted)return;for(const [key,item] of this.streams){const wanted=this.targets(item.sourceId,item.additional,item.userId).map(target=>this.mixer(target));for(const mixer of [...item.mixers])if(!wanted.includes(mixer)){mixer.remove(key);item.mixers.splice(item.mixers.indexOf(mixer),1);}for(const mixer of wanted)if(!item.mixers.includes(mixer)){item.mixers.push(mixer);mixer.add(key);}}}
 broadcast(user,index=0,receiver){this.route(user,index,receiver,false);}
 additionalBroadcast(index,user,receiver){this.route(user,index,receiver,true);}
 stopKey(key){const item=this.streams.get(key);if(!item)return;this.streams.delete(key);item.mixers.forEach(m=>m.remove(key));item.stream.destroy();}
 stopBroadcast(){for(const key of [...this.streams.keys()])if(key.includes('main:'))this.stopKey(key);}
 stopAdditionalFor(id){for(const [key,item] of this.streams)if(item.additional && item.userId===id)this.stopKey(key);}
 stopAdditional(){for(const key of [...this.streams.keys()])if(key.includes('extra:'))this.stopKey(key);}
 stop(){for(const key of [...this.streams.keys()])this.stopKey(key);if(this.mixers!==this.s.bridge?.mixers){for(const mixer of this.mixers.values())mixer.stop();this.mixers.clear();}this.mixers=new Map();}
}
module.exports={AudioRouter};

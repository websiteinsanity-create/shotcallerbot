'use strict';
const {ChannelType,PermissionFlagsBits,REST,Routes}=require('discord.js');
const identityCache=new Map();
const fault=(message,status=400)=>Object.assign(Error(message),{status});
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(fault(label,504)),ms);})]);}finally{clearTimeout(timer);}}
async function defaultIdentity(token,operationId){const cached=identityCache.get(token);if(cached && cached.operationId===operationId && cached.until>Date.now())return cached.promise;
 const entry={operationId,until:Date.now()+30000,promise:null};entry.promise=bounded(new REST({timeout:5000,retries:0}).setToken(token).get(Routes.user('@me')),5500,'Relay identity lookup timed out.').catch(error=>{if(identityCache.get(token)===entry)identityCache.delete(token);throw error;});identityCache.set(token,entry);return entry.promise;}
async function preflight({guild,channel,count,config,client,operation,fetchIdentity=defaultIdentity}){
 const started=Date.now();const requestedCount=Number(count);if(!Number.isInteger(requestedCount) || requestedCount<1)throw fault('Choose a positive whole party count.');count=Math.min(12,requestedCount);
 operation?.event('preflight.begin',{channelId:channel?.id,count});
 try{
  if(client?.isReady?.()===false || guild?.available===false)throw fault('Discord gateway is unavailable.',503);
  if(!channel || channel.type!==ChannelType.GuildVoice || channel.guild?.id!==guild.id)throw fault('Choose a voice channel in this Discord server.');
  const tokens=config.relayTokens.slice(0,count);
  if(tokens.length<count)throw fault(`Need ${count} relay bots; only ${tokens.length} are configured.`);
  if(new Set(tokens).size!==tokens.length || tokens.includes(config.mainToken))throw fault('Main and relay bots must use distinct tokens.');
  const main=guild.members.me || await bounded(guild.members.fetchMe(),5000,'Main bot membership lookup timed out.');
  const permissions=channel.permissionsFor(main);
  if(!permissions?.has(PermissionFlagsBits.ViewChannel))throw fault('Main control bot cannot view the selected channel.');
  if(count>1 && !permissions.has(PermissionFlagsBits.ManageChannels))throw fault('Main bot needs Manage Channels to create party channels.');
  const identities=new Set([client?.user?.id || main.id]);
  // Sequential bounded REST reads avoid a gateway-login storm. No channels or messages are changed.
  for(let index=0;index<tokens.length;index++){
   let user;try{user=await fetchIdentity(tokens[index],operation?.id);}catch(error){operation?.event('preflight.identity.failed',{relay:index+1,error});throw fault(`Relay ${index+1} identity could not be verified. Check its token and Discord connectivity.`,502);}
   if(!user?.id || identities.has(user.id))throw fault(`Relay ${index+1} does not have a distinct bot identity.`);identities.add(user.id);
   let member;try{member=await bounded(guild.members.fetch(user.id),5000,`Relay ${index+1} membership lookup timed out.`);}catch{throw fault(`Relay ${index+1} is unavailable in this Discord server.`,502);}
   // In-place channels inherit the anchor's overwrites. Relay 1 always needs anchor access.
   if(index===0 || config.partyPlacement!=='category')if(!channel.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw fault(`Relay ${index+1} cannot view, connect or speak in the planned party channels.`);
   if(index>0 && config.partyPlacement==='category'){
    const category=guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory && c.name===config.partyCategoryName);
    if(category && !category.permissionsFor(member)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak]))throw fault(`Relay ${index+1} cannot access the party category.`);
   }
   operation?.event('preflight.relay',{relay:index+1,channelId:channel.id,status:'verified'});
  }
  operation?.event('preflight.ready',{count,channelId:channel.id,durationMs:Date.now()-started,status:'ready'});
  return {ok:true,operationId:operation?.id || null,requestedCount,count,availableRelays:tokens.length,skippedPartyCount:Math.max(0,requestedCount-count)};
 }catch(error){operation?.event('preflight.failed',{channelId:channel?.id,count,durationMs:Date.now()-started,error});throw error;}
}
module.exports={preflight,bounded};

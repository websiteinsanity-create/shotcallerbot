'use strict';
const fs=require('node:fs'),path=require('node:path');
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const discordId=value=>typeof value==='string' && /^\d{15,25}$/.test(value);
function checkUpgrade({dataDir='./data',insanityGuildId='',allianceGuildId=''}={}){
 const file=path.resolve(dataDir,'runtime.json'),errors=[],warnings=[];
 if(!!insanityGuildId!==!!allianceGuildId || (insanityGuildId && (!discordId(insanityGuildId) || !discordId(allianceGuildId) || insanityGuildId===allianceGuildId)))errors.push('INSANITY_GUILD_ID and ALLIANCE_GUILD_ID must both be absent or contain two distinct Discord server IDs.');
 if(!insanityGuildId && !allianceGuildId)warnings.push('Bridge is disabled because neither server ID is configured.');
 let state;
 try{state=JSON.parse(fs.readFileSync(file,'utf8'));}
 catch(error){if(error.code==='ENOENT')return{ok:errors.length===0,file,exists:false,errors,warnings};errors.push('runtime.json cannot be read as JSON. Preserve it and inspect it before updating; this check does not move or overwrite it.');return{ok:false,file,exists:true,errors,warnings};}
 if(!object(state) || state.version!==1 || !object(state.sessions) || !object(state.bridge))errors.push('runtime.json uses an unsupported state format. Preserve it and inspect it before updating.');
 else{
  for(const [guild,session] of Object.entries(state.sessions))if(!discordId(guild) || !object(session) || !discordId(session.channelId) || !Number.isInteger(session.count) || session.count<1 || session.count>12 || !Array.isArray(session.channels) || session.channels.length!==session.count || session.channels.some(c=>!object(c) || !discordId(c.id)) || (session.callerId!=null && !discordId(session.callerId)) || (session.additionalCallers!==undefined && (!Array.isArray(session.additionalCallers) || session.additionalCallers.some(id=>!discordId(id)))))errors.push('runtime.json contains an incompatible saved session.');
  const b=state.bridge;
  if((b.desired!==undefined && typeof b.desired!=='boolean') || (b.bufferMs!==undefined && (![20,40,60,80,100].includes(b.bufferMs))) || (b.mainEnabled!==undefined && (!object(b.mainEnabled) || Object.entries(b.mainEnabled).some(([id,value])=>!discordId(id) || typeof value!=='boolean'))) || (b.originalMains!==undefined && (!object(b.originalMains) || Object.entries(b.originalMains).some(([id,users])=>!discordId(id) || !Array.isArray(users) || users.length>1 || users.some(u=>!discordId(u))))))errors.push('runtime.json contains incompatible saved Bridge settings.');
  if(Object.keys(state.sessions).length)warnings.push('Previously active sessions will be restored automatically, with new session IDs. Existing attendance runs can become incomplete.');
  if(b.desired)warnings.push('The saved Alliance Bridge request will reconnect after both sessions are ready. Swipe will be reset.');
 }
 return{ok:errors.length===0,file,exists:true,errors:[...new Set(errors)],warnings};
}
if(require.main===module){
 // Read only .env defaults; never import the bot or connect to Discord.
 const env={};try{for(const line of fs.readFileSync('.env','utf8').split(/\r?\n/)){const m=/^\s*(DATA_DIR|INSANITY_GUILD_ID|ALLIANCE_GUILD_ID)\s*=\s*(.*?)\s*$/.exec(line);if(m)env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');}}catch(error){if(error.code!=='ENOENT')throw error;}
 const result=checkUpgrade({dataDir:process.argv[2] || process.env.DATA_DIR || env.DATA_DIR || './data',insanityGuildId:process.env.INSANITY_GUILD_ID ?? env.INSANITY_GUILD_ID ?? '',allianceGuildId:process.env.ALLIANCE_GUILD_ID ?? env.ALLIANCE_GUILD_ID ?? ''});
 console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1;
}
module.exports={checkUpgrade};

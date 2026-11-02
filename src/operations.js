'use strict';
const {randomUUID}=require('node:crypto');
const recent=[];
const validId=id=>typeof id==='string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id);
function operationId(id){return validId(id)?id:randomUUID();}
function scrub(value,secrets=[]){let text=String(value ?? '');for(const secret of secrets.filter(s=>typeof s==='string' && s.length>3))text=text.split(secret).join('[redacted]');return text.replace(/\b(?:Bot|Bearer)\s+[^\s"<>]+/gi,'[redacted credential]').replace(/\b[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g,'[redacted token]').slice(0,1000);}
function createOperation({id,guildId,sessionId,secrets=[],sink=console.info}={}){
 const op={id:operationId(id),guildId,sessionId,startedAt:Date.now()};
 op.sanitize=value=>scrub(value,secrets);
 op.event=(event,fields={})=>{
  const row={at:new Date().toISOString(),component:'shotcaller',elapsedMs:Date.now()-op.startedAt,operationId:op.id,guildId:op.guildId || null,sessionId:op.sessionId || null,event};
  for(const key of ['relay','channelId','attempt','durationMs','status','from','to','count','phase'])if(fields[key]!==undefined)row[key]=typeof fields[key]==='string'?scrub(fields[key],secrets):fields[key];
  if(fields.error){row.error=scrub(fields.error.message || fields.error,secrets);if(fields.error.code)row.errorCode=scrub(fields.error.code,secrets);if(fields.error.cause?.message)row.cause=scrub(fields.error.cause.message,secrets);}
  recent.push(row);if(recent.length>200)recent.shift();sink(JSON.stringify(row));return row;
 };
 return op;
}
function recentOperations(guildId){return recent.filter(r=>r.guildId===guildId).slice(-30);}
module.exports={createOperation,operationId,recentOperations,scrub};

'use strict';
const {randomUUID}=require('node:crypto');
function fault(message,status=409){const e=Error(message);e.status=status;return e;}
function idOf(session){if(session && !session.sessionId)session.sessionId=randomUUID();return session?.sessionId || null;}
function activeSession(sessions,guildId){const s=sessions.get(guildId);return s && !s.lifecycle?s:null;}
function reserveStart(sessions,guildId){
 if(sessions.has(guildId))throw fault('A Shotcaller session is active, starting or stopping.');
 let resolve;const record={lifecycle:'starting',sessionId:randomUUID(),cancelRequested:false,session:null,done:new Promise(r=>resolve=r),resolve:()=>resolve()};
 sessions.set(guildId,record);return record;
}
async function completeStart(sessions,guildId,record,factory){
 let session;
 try{
  session=await factory();record.session=session;session.sessionId=record.sessionId;session.operationId=session.operationId || record.operationId || record.sessionId;
  session.operation?.event("session.start",{count:session.count,status:"starting"});
  if(record.cancelRequested)throw fault('Session start cancelled.');
  await session.start();
  if(record.cancelRequested || sessions.get(guildId)!==record)throw fault('Session start cancelled.');
  session.operation?.event("session.active",{count:session.count,status:"active"});
  sessions.set(guildId,session);return session;
 }catch(error){
  session?.operation?.event("session.start.failed",{error,status:"failed"});
  if(session){try{await session.destroy();}catch(cleanup){record.lifecycle='stop-failed';record.cleanupError=true;console.error('[lifecycle] start cleanup failed:',cleanup);throw error;}}
  if(sessions.get(guildId)===record)sessions.delete(guildId);throw error;
 }finally{record.resolve();}
}
function stopSession(sessions,guildId,expectedId){
 const current=sessions.get(guildId);
 if(!current)return{ok:true,sessionState:'inactive',sessionId:null};
 const id=idOf(current);if(expectedId && expectedId!==id)throw fault('This session has changed. Refresh before stopping it.');
 if(current.lifecycle==='starting' || (current.lifecycle==='stopping' && current.cancelRequested)){
  current.cancelRequested=true;current.lifecycle='stopping';current.session?.cancelStart?.();
  return{ok:true,sessionState:'stopping',sessionId:id};
 }
 if(current.lifecycle==='stopping')return{ok:true,sessionState:'stopping',sessionId:id};
 const session=current.lifecycle==='stop-failed'?current.session:current;
 const record={lifecycle:'stopping',sessionId:id,operationId:session.operationId,session};session.operation?.event('session.stop',{status:'stopping'});sessions.set(guildId,record);
 // destroy() stops audio/voice synchronously before its first slow channel-retirement await.
 let cleanup;try{cleanup=session.destroy();}catch(error){cleanup=Promise.reject(error);}
 record.done=Promise.resolve(cleanup).then(()=>{session.operation?.event('session.stopped',{status:'inactive'});if(sessions.get(guildId)===record)sessions.delete(guildId);},error=>{session.operation?.event('session.stop.failed',{status:'stop-failed',error});record.lifecycle='stop-failed';record.cleanupError=true;console.error('[lifecycle] stop cleanup failed:',error);});
 // Message updates can be rate-limited; they never delay audio shutdown or unlock a session early.
 Promise.resolve().then(()=>session.panelMessage?.edit({content:'Shotcaller stopped.',embeds:[],components:[]})).catch(()=>{});
 return{ok:true,sessionState:'stopping',sessionId:id};
}
module.exports={idOf,activeSession,reserveStart,completeStart,stopSession};

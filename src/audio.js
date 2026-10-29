const { EndBehaviorType } = require("@discordjs/voice");
const { PassThrough } = require("stream");

// The relays' players expect every read to return exactly ONE Opus packet. A plain (byte-mode) PassThrough
// glues together whatever has piled up between two 20ms player ticks, so two packets come out as one
// malformed blob — which listeners hear as robotic, compressed, glitchy audio. Object mode keeps each
// packet separate.
const packetTee=()=>new PassThrough({objectMode:true});

// receiver.subscribe() hands back the SAME stream if one is already registered for that user, and a stream we
// have just destroy()ed stays registered until its "close" event fires. So subscribing straight after a destroy
// returns a dead stream — the pipeline built on it ends instantly with 0 bytes. Always make sure we get a live one.
function liveSubscribe(receiver,userId,options){
  let st=receiver.subscribe(userId,options);
  if(st.destroyed){
    receiver.subscriptions?.delete?.(userId);
    st=receiver.subscribe(userId,options);
  }
  return st;
}

// Every party has a relay bot (relays[j] sits in channels[j]; relays[0] is in the shotcaller's own
// channel). The relays do two jobs: they PLAY audio into their party's channel, and they LISTEN to
// their party so an additional caller can be picked up from whichever party they're standing in.
class AudioRouter {
  constructor(session){
    this.s=session;
    this.broadcastStream=null; this.broadcastUser=null;
    this.additionalStreams=new Map(); // userId -> live subscription
  }

  // The dedicated caller goes to every party EXCEPT the one they're standing in — the people there already hear
  // them live. Normally that's the shotcaller's own channel (sourceIndex 0, heard by the main bot), but if the
  // dedicated caller is moved to another party, that party's relay picks them up instead (sourceIndex = its party).
  broadcast(userId,sourceIndex=0,receiver=this.s.main?.receiver){
    if(this.s.muted || !userId || !receiver) return;
    if(this.s.dedicated.size && !this.s.dedicated.has(userId)) return;
    const targets=this.s.relays.filter((_,i)=>i!==sourceIndex);
    if(!targets.length) return;
    // Discord reports a fresh "speaking start" after every pause over ~100ms, even mid-sentence. If we're already
    // relaying this person, carry on with the live stream — it keeps delivering their audio until a real silence.
    // Rebuilding the pipeline on every little pause cuts the tail off what's still queued and leaves a gap.
    if(this.broadcastStream && !this.broadcastStream.destroyed && this.broadcastUser===userId) return;
    console.log(`[audio] broadcast() starting for ${userId} from party ${sourceIndex+1}, to ${targets.length} parties`);
    this.stopBroadcast();
    const stream=liveSubscribe(receiver,userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.broadcastStream=stream; this.broadcastUser=userId;
    const tees=targets.map(packetTee);
    tees.forEach((t,i)=>targets[i].playOpus(t));
    let byteCount=0,chunkCount=0,done=false;
    const end=()=>{
      if(done) return; done=true; // 'end' and 'close' both fire — only wrap up once
      console.log(`[audio] broadcast() ended for ${userId} — ${chunkCount} chunks, ${byteCount} bytes`);
      tees.forEach(t=>t.end());
      if(this.broadcastStream===stream){this.broadcastStream=null;this.broadcastUser=null;}
    };
    stream.on("data",b=>{
      chunkCount++;byteCount+=b.length;
      if(!this.s.muted)tees.forEach(t=>t.write(b));
    });
    stream.once("end",end);stream.once("close",end);
    stream.once("error",e=>{console.error(`[audio] broadcast stream error for ${userId}:`,e);end();});
  }

  // An additional caller's callout: picked up by the relay of whichever party they're in
  // (sourceIndex) and played into EVERY OTHER party's channel — including the shotcaller's own, so the
  // caller and their party hear it too. The source party is skipped; they hear the caller live.
  additionalBroadcast(sourceIndex,userId,receiver){
    if(this.s.muted || !userId) return;
    if(this.additionalStreams.has(userId)) return; // already relaying this person
    const targets=this.s.relays.filter((_,i)=>i!==sourceIndex);
    if(!targets.length) return;
    console.log(`[audio] additional callout starting for ${userId} from party ${sourceIndex+1}, to ${targets.length} parties`);
    const stream=liveSubscribe(receiver,userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.additionalStreams.set(userId,stream);
    const tees=targets.map(packetTee);
    tees.forEach((t,i)=>targets[i].playOpus(t));
    let byteCount=0,chunkCount=0,done=false;
    const end=()=>{
      if(done) return; done=true;
      console.log(`[audio] additional callout ended for ${userId} — ${chunkCount} chunks, ${byteCount} bytes`);
      tees.forEach(t=>t.end());
      if(this.additionalStreams.get(userId)===stream) this.additionalStreams.delete(userId);
    };
    stream.on("data",b=>{
      chunkCount++;byteCount+=b.length;
      if(!this.s.muted)tees.forEach(t=>t.write(b));
    });
    stream.once("end",end);stream.once("close",end);
    stream.once("error",e=>{console.error(`[audio] additional callout stream error for ${userId}:`,e);end();});
  }

  stopBroadcast(){try{this.broadcastStream?.destroy()}catch{}this.broadcastStream=null;this.broadcastUser=null}
  stopAdditionalFor(userId){try{this.additionalStreams.get(userId)?.destroy()}catch{}}
  stopAdditional(){for(const st of this.additionalStreams.values()){try{st.destroy()}catch{}}this.additionalStreams.clear()}
  stop(){this.stopBroadcast();this.stopAdditional()}
}
module.exports={AudioRouter};

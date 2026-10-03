const { EndBehaviorType } = require("@discordjs/voice");
const { PassThrough } = require("stream");

// Every party has a relay bot (relays[j] sits in channels[j]; relays[0] is in the shotcaller's own
// channel). The relays do two jobs: they PLAY audio into their party's channel, and they LISTEN to
// their party so an additional caller can be picked up from whichever party they're standing in.
class AudioRouter {
  constructor(session){
    this.s=session;
    this.broadcastStream=null;
    this.additionalStreams=new Map(); // userId -> live subscription
  }

  // The primary caller, heard from the shotcaller's own channel, goes to every party EXCEPT that
  // channel (relays[0]) — the people there already hear the caller live.
  broadcast(userId){
    if(this.s.muted || !userId) return;
    if(this.s.dedicated.size && !this.s.dedicated.has(userId)) return;
    const targets=this.s.relays.slice(1);
    if(!targets.length) return;
    console.log(`[audio] broadcast() starting for ${userId}, parties: ${targets.length}`);
    this.stopBroadcast();
    const stream=this.s.main.receiver.subscribe(userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.broadcastStream=stream;
    const tees=targets.map(()=>new PassThrough());
    tees.forEach((t,i)=>targets[i].playOpus(t));
    let byteCount=0,chunkCount=0;
    const end=()=>{
      console.log(`[audio] broadcast() ended for ${userId} — ${chunkCount} chunks, ${byteCount} bytes`);
      tees.forEach(t=>t.end());
      if(this.broadcastStream===stream)this.broadcastStream=null;
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
    const stream=receiver.subscribe(userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.additionalStreams.set(userId,stream);
    const tees=targets.map(()=>new PassThrough());
    tees.forEach((t,i)=>targets[i].playOpus(t));
    let byteCount=0,chunkCount=0;
    const end=()=>{
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

  stopBroadcast(){try{this.broadcastStream?.destroy()}catch{}this.broadcastStream=null}
  stopAdditionalFor(userId){try{this.additionalStreams.get(userId)?.destroy()}catch{}}
  stopAdditional(){for(const st of this.additionalStreams.values()){try{st.destroy()}catch{}}this.additionalStreams.clear()}
  stop(){this.stopBroadcast();this.stopAdditional()}
}
module.exports={AudioRouter};

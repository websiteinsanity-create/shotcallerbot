const { EndBehaviorType, createAudioResource, StreamType } = require("@discordjs/voice");
const { PassThrough } = require("stream");

class AudioRouter {
  constructor(session){
    this.s=session;
    this.broadcastStream=null;
    this.whisperStreams=new Map();
  }

  broadcast(userId){
    if(this.s.muted || !userId) return;
    if(this.s.dedicated.size && !this.s.dedicated.has(userId)) return;
    console.log(`[audio] broadcast() starting for ${userId}, relays: ${this.s.relays.length}`);
    this.stopBroadcast();
    const stream=this.s.main.receiver.subscribe(userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.broadcastStream=stream;
    const tees=this.s.relays.map(()=>new PassThrough());
    tees.forEach((t,i)=>this.s.relays[i].playOpus(t));
    let byteCount=0,chunkCount=0;
    const end=()=>{
      console.log(`[audio] broadcast() ended for ${userId} — received ${chunkCount} chunks, ${byteCount} bytes total`);
      tees.forEach(t=>t.end());
      if(this.broadcastStream===stream)this.broadcastStream=null;
    };
    stream.on("data",b=>{
      chunkCount++;byteCount+=b.length;
      if(chunkCount===1) console.log(`[audio] first chunk received from ${userId}: ${b.length} bytes`);
      if(!this.s.muted)tees.forEach(t=>t.write(b));
    });
    stream.once("end",end);stream.once("close",end);
    stream.once("error",e=>{console.error(`[audio] broadcast stream error for ${userId}:`,e);end();});
  }

  whisper(userId){
    if(!userId || !this.s.whisperAllowed(userId)) return;
    if(this.whisperStreams.has(userId)) return;
    console.log(`[audio] whisper() starting for ${userId}`);
    const stream=this.s.partyReceiver.subscribe(userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.whisperStreams.set(userId,stream);
    // Play straight into the shotcaller's own voice connection.
    this.s.mainPlayer?.play(createAudioResource(stream,{inputType:StreamType.Opus}));
    let byteCount=0;
    stream.on("data",b=>{byteCount+=b.length;});
    const end=()=>{
      console.log(`[audio] whisper() ended for ${userId} — ${byteCount} bytes total`);
      this.whisperStreams.delete(userId);
    };
    stream.once("end",end);stream.once("close",end);
    stream.once("error",e=>{console.error(`[audio] whisper stream error for ${userId}:`,e);end();});
  }

  // A secondary caller's momentary callout: captured from whichever party channel they're actually in
  // (via that party's own relay receiver), fanned out to every OTHER party's relay AND into the
  // shotcaller's own connection — same reach as the primary caller speaking, just time-limited and
  // sourced from wherever the secondary caller happens to be standing.
  secondaryBroadcast(sourceIndex,userId,receiver){
    if(this.s.muted || !userId) return;
    if(!this.secondaryStreams) this.secondaryStreams=new Map();
    if(this.secondaryStreams.has(userId)) return; // already actively relaying this person
    console.log(`[audio] secondaryBroadcast() starting for ${userId} from party index ${sourceIndex}`);
    const stream=receiver.subscribe(userId,{
      end:{behavior:EndBehaviorType.AfterSilence,duration:this.s.config.whisperSilenceMs}
    });
    this.secondaryStreams.set(userId,stream);
    const targets=this.s.relays.filter((_,i)=>i!==sourceIndex); // never echo back into their own party
    const tees=targets.map(()=>new PassThrough());
    tees.forEach((t,i)=>targets[i].playOpus(t));
    const mainTee=new PassThrough(); // separate tee for the shotcaller's own connection, avoids two consumers on one stream
    tees.push(mainTee);
    this.s.mainPlayer?.play(createAudioResource(mainTee,{inputType:StreamType.Opus}));
    let byteCount=0,chunkCount=0;
    const end=()=>{
      console.log(`[audio] secondaryBroadcast() ended for ${userId} — ${chunkCount} chunks, ${byteCount} bytes total`);
      tees.forEach(t=>t.end());
      this.secondaryStreams.delete(userId);
    };
    stream.on("data",b=>{
      chunkCount++;byteCount+=b.length;
      if(!this.s.muted)tees.forEach(t=>t.write(b));
    });
    stream.once("end",end);stream.once("close",end);
    stream.once("error",e=>{console.error(`[audio] secondaryBroadcast stream error for ${userId}:`,e);end();});
  }

  stopBroadcast(){try{this.broadcastStream?.destroy()}catch{}this.broadcastStream=null}
  stopWhispers(){for(const s of this.whisperStreams.values()){try{s.destroy()}catch{}}this.whisperStreams.clear()}
  stopSecondary(){if(this.secondaryStreams)for(const s of this.secondaryStreams.values()){try{s.destroy()}catch{}}this.secondaryStreams?.clear()}
  stop(){this.stopBroadcast();this.stopWhispers();this.stopSecondary()}
}
module.exports={AudioRouter};

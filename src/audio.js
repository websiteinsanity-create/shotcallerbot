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
    if(this.s.dedicated && this.s.dedicated !== userId) return;
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

  stopBroadcast(){try{this.broadcastStream?.destroy()}catch{}this.broadcastStream=null}
  stopWhispers(){for(const s of this.whisperStreams.values()){try{s.destroy()}catch{}}this.whisperStreams.clear()}
  stop(){this.stopBroadcast();this.stopWhispers()}
}
module.exports={AudioRouter};

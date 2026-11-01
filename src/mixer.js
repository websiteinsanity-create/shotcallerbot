'use strict';
const {PassThrough}=require('node:stream');
// 48 kHz stereo, 20ms frames. Bounded queues drop old speech instead of adding latency.
class VoiceMixer {
 constructor({encoder,play,setIntervalFn=setInterval,clearIntervalFn=clearInterval}){this.encoder=encoder;this.play=play;this.sources=new Map();this.timer=null;this.output=null;this.setInterval=setIntervalFn;this.clearInterval=clearIntervalFn;}
 add(id){if(this.sources.has(id) && !this.sources.get(id).ended)return;this.sources.set(id,{queue:[],ended:false});if(!this.timer){this.output=new PassThrough({objectMode:true});this.output.on('error',()=>this.stop());this.play(this.output);this.timer=this.setInterval(()=>{try{this.tick();}catch(error){console.error('[audio] mix failed:',error.message);this.stop();}},20);}}
 push(id,pcm){const s=this.sources.get(id);if(!s)return;for(let offset=0;offset+3840<=pcm.length;offset+=3840){s.queue.push(pcm.subarray(offset,offset+3840));if(s.queue.length>3)s.queue.shift();}}
 end(id){const s=this.sources.get(id);if(s)s.ended=true;}
 remove(id){this.sources.delete(id);if(!this.sources.size)this.stop();}
 tick(){const frames=[];for(const [id,s] of this.sources){if(s.queue.length)frames.push(s.queue.shift());else if(s.ended)this.sources.delete(id);}
 if(!this.sources.size && !frames.length){this.stop();return;}
 const mixed=Buffer.alloc(3840);for(let i=0;i<3840;i+=2){let value=0;for(const frame of frames)value+=frame.readInt16LE(i);mixed.writeInt16LE(Math.max(-32768,Math.min(32767,value)),i);}
 if(this.output && !this.output.destroyed && this.output.writableLength<3)this.output.write(this.encoder.encode(mixed));
 }
 stop(){if(this.timer)this.clearInterval(this.timer);this.timer=null;this.sources.clear();this.output?.destroy();this.output=null;}
}
module.exports={VoiceMixer};

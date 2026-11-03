const {test}=require('node:test'),assert=require('node:assert/strict');
const {PassThrough}=require('node:stream');
const {AllianceBridge}=require('../src/bridge');const {AudioRouter}=require('../src/audio');const {MainCaller}=require('../src/main-caller');const {OpusEncoder}=require('@discordjs/opus');
const A='111111111111111111',B='222222222222222222',U='333333333333333333',V='444444444444444444',X='555555555555555555';
function harness(){const sessions=new Map(),outputs=[];
 for(const [id,caller] of [[A,U],[B,V]]){const inputs=new Map();const receiver={subscriptions:inputs,subscribe(user){let stream=inputs.get(user);if(!stream || stream.destroyed){stream=new PassThrough({objectMode:true});inputs.set(user,stream);}return stream;},speaking:{users:new Map()}};
  const s={guild:{id,client:{isReady:()=>true,user:{id:'control-bot'}},members:{cache:new Map()}},config:{whisperSilenceMs:50},dedicated:new Set([caller]),mainCaller:new MainCaller(caller),channels:Array.from({length:12},(_,i)=>({id:id+'-'+i})),additionalCallActive:u=>u===X,relays:Array.from({length:12},(_,i)=>({client:{isReady:()=>true,user:{id:'relay-'+i}},connection:{state:{status:'ready'},receiver},playOpus:stream=>{outputs.push({id,i,stream});stream.resume();}}))};s.mainCaller.observe(s.channels[0].id,true);s.audio=new AudioRouter(s);s.inputs=inputs;sessions.set(id,s);
 }
 const saved=[];const b=new AllianceBridge({sessions,insanityGuildId:A,allianceGuildId:B,save:s=>saved.push(JSON.parse(JSON.stringify(s)))});return {b,sessions,a:sessions.get(A),c:sessions.get(B),outputs,saved,stop(){b.end(A);for(const s of sessions.values())s.audio.stop();}};
}
test('bridge waits, activates, reconnects and resets swipe; ending remains durable',()=>{const h=harness();try{h.sessions.delete(B);h.b.start(A);assert.equal(h.b.state,'waiting');h.sessions.set(B,h.c);h.b.reconcile();assert(h.b.active);h.b.configure(A,'swipe',{enabled:true});h.c.mainCaller.observe(null,false);h.b.reconcile();assert.equal(h.b.state,'active');assert.equal(h.b.swipe,true);h.c.relays[0].connection.state.status='disconnected';h.b.reconcile();assert.equal(h.b.state,'reconnecting');assert.equal(h.b.swipe,false);h.c.relays[0].connection.state.status='ready';h.c.mainCaller.observe(h.c.channels[0].id,true);h.b.reconcile();assert(h.b.active);h.b.end(B);assert.equal(h.saved.at(-1).desired,false);h.b.reconcile();assert.equal(h.b.state,'off');assert.equal(h.a.bridge,null);assert.deepEqual([...h.a.dedicated],[U]);}finally{h.stop();}});
test('normal speech targets 23 channels; PTT targets both mains, one main or all parties',()=>{const h=harness();try{h.b.start(A);assert.equal(h.b.targets(h.a,h.a.channels[1].id,false,U).length,23);assert.equal(h.b.targets(h.a,h.a.channels[1].id,true,X).length,2);h.b.configure(A,'mains',{mainEnabled:{[A]:false,[B]:true}});assert.deepEqual(h.b.targets(h.a,h.a.channels[1].id,true,X),[h.c.relays[0]]);h.b.configure(A,'mains',{mainEnabled:{[A]:false,[B]:false}});assert.equal(h.b.targets(h.a,h.a.channels[1].id,true,X).length,23);}finally{h.stop();}});
test('swipe blocks only the Alliance shotcaller source; inbound PTT and other callers survive',()=>{const h=harness();try{h.b.start(A);h.b.configure(A,'swipe',{enabled:true});assert.equal(h.b.targets(h.c,h.c.channels[0].id,false,V).length,0);assert.equal(h.b.targets(h.c,h.c.channels[0].id,true,V).length,0);assert(h.b.targets(h.a,h.a.channels[1].id,true,X).includes(h.c.relays[0]));assert(h.b.targets(h.a,h.a.channels[0].id,false,U).includes(h.c.relays[0]));assert.equal(h.b.targets(h.c,h.c.channels[1].id,true,X).length,2);}finally{h.stop();}});
test('partner cannot configure mains by default or settings/swipe even after delegation',()=>{const h=harness();try{h.b.start(B);assert.throws(()=>h.b.configure(B,'mains',{mainEnabled:{[A]:true,[B]:false}}),e=>e.status===403);assert.throws(()=>h.b.configure(A,'settings',{bufferMs:60},false),e=>e.status===403);h.b.configure(A,'settings',{allowAllianceManage:true},true);h.b.configure(B,'mains',{mainEnabled:{[A]:false,[B]:true}});assert.throws(()=>h.b.configure(B,'settings',{bufferMs:60},true),e=>e.status===403);assert.throws(()=>h.b.configure(B,'swipe',{enabled:true}),e=>e.status===403);assert.equal(h.b.snapshot(B).audio,undefined);h.b.end(B);assert(!h.b.desired);}finally{h.stop();}});
test('bot accounts and source channel are excluded, and one relay loss preserves healthy routing during recovery',()=>{const h=harness();try{h.b.start(A);assert.equal(h.b.targets(h.a,h.a.channels[0].id,false,'relay-0').length,0);assert(!h.b.targets(h.a,h.a.channels[0].id,false,U).includes(h.a.relays[0]));h.c.relays[7].connection.state.status='disconnected';h.b.reconcile();assert.equal(h.b.state,'reconnecting');assert(h.b.routingReady);assert(!h.b.targets(h.a,h.a.channels[0].id,false,U).includes(h.c.relays[7]));}finally{h.stop();}});
test('two servers feed one central mixer per output with real Opus and distinct source keys',async()=>{const h=harness();try{h.b.start(A);h.a.audio.broadcast(U,0,h.a.relays[0].connection.receiver);h.c.audio.broadcast(V,0,h.c.relays[0].connection.receiver);const target=h.a.relays[3],m=h.b.mixers.get(target);assert(m);assert.equal(m.sources.size,2);assert.equal(h.outputs.filter(o=>o.id===A && o.i===3).length,1);const e=new OpusEncoder(48000,2),packet=e.encode(Buffer.alloc(3840));for(let n=0;n<3;n++){h.a.inputs.get(U).write(packet);h.c.inputs.get(V).write(packet);}await new Promise(r=>setTimeout(r,65));assert(m.stats.frames>0);assert.equal(m.stats.bufferMs,40);h.b.configure(A,'swipe',{enabled:true});assert(![...h.b.mixers.values()].some(m=>[...m.sources.keys()].some(k=>k===B+':main:'+V)));}finally{h.stop();}});
test('off bridge reconciliation never interrupts independent sessions',()=>{const h=harness();let stops=0;h.a.audio.stop=()=>stops++;h.c.audio.stop=()=>stops++;for(let n=0;n<5;n++)h.b.reconcile();assert.equal(stops,0);});

test('bridge end restores original internal callers after a temporary caller replacement',()=>{const h=harness();try{
 for(const s of h.sessions.values())s.setDedicated=ids=>{s.dedicated=new Set(ids);s.mainCaller.select(ids);};
 h.b.start(A);h.a.setDedicated([X]);assert.equal(h.a.mainCaller.id,X);h.b.end(B);assert.equal(h.a.mainCaller.id,U);assert.equal(h.c.mainCaller.id,V);
}finally{h.stop();}});

test('caller presence changes never affect verified transport readiness or Swipe',()=>{const h=harness();try{
 h.b.start(A);h.b.configure(A,'swipe',{enabled:true});
 for(const [a,b] of [[false,false],[true,false],[false,true],[true,true],[false,true],[true,true]]){
  h.a.mainCaller.observe(a?h.a.channels[0].id:null,a);h.c.mainCaller.observe(b?h.c.channels[0].id:null,b);h.b.reconcile();
  assert.equal(h.b.state,'active');assert.equal(h.b.swipe,true);
 }
}finally{h.stop();}});

test('waiting, connecting, real failure, targeted recovery and session replacement are distinct',()=>{const h=harness();try{
 h.sessions.delete(B);h.b.start(A);assert.equal(h.b.state,'waiting');
 h.sessions.set(B,h.c);const audio=h.c.audio;h.c.audio=null;h.b.reconcile();assert.equal(h.b.state,'connecting');assert(!h.b.routingReady);
 h.c.audio=audio;h.b.reconcile();assert(h.b.active);
 h.c.relays[3].connection.state.status='disconnected';h.b.reconcile();assert.equal(h.b.state,'reconnecting');assert(h.b.routingReady);
 assert.equal(h.b.targets(h.a,h.a.channels[0].id,false,U).length,22);
 h.c.relays[3].connection.state.status='ready';h.b.reconcile();assert(h.b.active);
 h.sessions.delete(A);h.sessions.delete(B);h.b.reconcile();assert.equal(h.b.state,'waiting');assert(!h.b.routingReady);
 h.sessions.set(A,h.a);h.sessions.set(B,h.c);h.b.reconcile();assert(h.b.active);
 h.a.paused=true;h.b.reconcile();assert.equal(h.b.state,'waiting');h.a.paused=false;
 h.a.guild.client.isReady=()=>false;h.b.reconcile();assert.equal(h.b.state,'reconnecting');assert(!h.b.routingReady);
 h.a.guild.client.isReady=()=>true;h.b.reconcile();assert(h.b.active);
}finally{h.stop();}});

test('configured absent mains never fall back to party broadcasts in either direction',()=>{const h=harness();try{
 h.b.start(A);for(const source of [h.a,h.c]){
  for(const target of [h.a,h.c])target.mainCaller.observe(null,false);
  assert.deepEqual(h.b.targets(source,source.channels[1].id,true,X),[]);
  h.a.mainCaller.observe(h.a.channels[0].id,true);assert.deepEqual(h.b.targets(source,source.channels[1].id,true,X),[h.a.relays[0]]);
 }
 h.b.configure(A,'mains',{mainEnabled:{[A]:false,[B]:false}});
 for(const source of [h.a,h.c])assert.equal(h.b.targets(source,source.channels[1].id,true,X).length,23);
}finally{h.stop();}});

test('real Session priority flags and Discord button route selected callers symmetrically, without an extra role',()=>{const {Session}=require('../src/session'),{EventEmitter}=require('node:events');
 const h=harness();try{
  for(const s of [h.a,h.c]){
   Object.setPrototypeOf(s,Session.prototype);delete s.additionalCallActive;
   s.additionalCallers=new Set([X]);s.calloutOpen=new Map();s.priorityHeld=new Map();s.calloutTimers=new Map();s.priorityTimers=new Map();s.fetchingMembers=new Set();s.config.calloutAutoOffMs=20000;
   for(const relay of s.relays){const subscriptions=new Map();relay.connection.receiver={subscriptions,subscribe(user){const stream=new PassThrough({objectMode:true});subscriptions.set(user,stream);return stream;},speaking:Object.assign(new EventEmitter(),{users:new Map()})};}s.wireReceivers();
  }
  h.b.start(A);
  for(const [source,user] of [[h.a,U],[h.c,V]]){
   const receiver=source.relays[1].connection.receiver;receiver.speaking.users.set(user,true);
   assert(source.canCallout(user));source.onSpeakingFlags(user,5);assert(source.additionalCallActive(user));
   let routes=[...source.audio.streams.values()];assert.equal(routes.length,1);assert(routes[0].additional);assert.equal(routes[0].mixers.length,2);
   receiver.speaking.emit('start',user);assert.equal(source.audio.streams.size,1);
   h.b.configure(A,'pause');assert(!source.additionalCallActive(user));assert([...source.audio.streams.values()].every(r=>!r.additional && r.mixers.length===11));
   h.b.configure(A,'resume');assert(source.additionalCallActive(user));assert.equal(source.audio.streams.size,1);assert([...source.audio.streams.values()].every(r=>r.additional && r.mixers.length===2));
   source.onSpeakingFlags(user,1);routes=[...source.audio.streams.values()];assert.equal(routes.length,1);assert(!routes[0].additional);
   assert(source.toggleCallout(user));assert([...source.audio.streams.values()].every(r=>r.additional));source.toggleCallout(user);
   receiver.speaking.users.clear();source.audio.stop();
   source.onSpeakingFlags('unauthorised',5);assert(!source.priorityHeld.has('unauthorised'));
  }
  h.b.configure(A,'swipe',{enabled:true});h.c.onSpeakingFlags(V,5);assert.equal(h.b.targets(h.c,h.c.channels[1].id,true,V).length,0);
  assert(h.b.targets(h.a,h.a.channels[1].id,true,X).includes(h.c.relays[0]));
 }finally{for(const s of [h.a,h.c])for(const map of [s.calloutTimers,s.priorityTimers])for(const t of map?.values() || [])clearTimeout(t);h.stop();}});

test('external caller absence is harmless but a failing external voice connection is real recovery',()=>{const h=harness();try{
 h.b.start(A);h.a.mainCaller.observe('external',false);h.b.reconcile();assert.equal(h.b.state,'connecting');
 h.a.main={state:{status:'ready'}};h.a.followTarget={playOpus(){}};h.a.mainCaller.observe('external',true);h.b.reconcile();assert(h.b.active);
 h.a.main.state.status='disconnected';h.b.reconcile();assert.equal(h.b.state,'reconnecting');assert(h.b.routingReady);
 h.a.mainCaller.observe(null,false);h.a.main=null;h.a.followTarget=null;h.b.reconcile();assert(h.b.active);
}finally{h.stop();}});

test('a waiting bridge never turns an authorised PTT callout into an internal party broadcast',()=>{const h=harness();try{
 h.b.start(A);h.sessions.delete(B);h.b.reconcile();assert.equal(h.b.state,'waiting');
 h.a.mainCaller.observe(null,false);h.a.audio.additionalBroadcast(1,X,h.a.relays[1].connection.receiver);assert.equal(h.a.audio.streams.size,0);assert.equal(h.outputs.length,0);
}finally{h.stop();}});

test('a waiting bridge still delivers internal callouts to the own available main caller only',()=>{const h=harness();try{
 h.b.start(A);h.sessions.delete(B);h.b.reconcile();assert.equal(h.b.state,'waiting');h.a.mainCaller.observe(h.a.channels[0].id,true);
 const t=h.a.audio.targets(h.a.channels[1].id,true);assert.deepEqual(t,[h.a.relays[0]]);
}finally{h.stop();}});

test('partial relay recovery preserves healthy central mixer/player instances',()=>{const h=harness();try{
 h.b.start(A);h.a.audio.broadcast(U,0,h.a.relays[0].connection.receiver);
 const bad=h.c.relays[3],healthy=h.c.relays[4],original=h.b.mixers.get(healthy);
 bad.connection.state.status='disconnected';h.c.audio.dropTarget(bad);h.b.reconcile();
 assert.equal(h.b.state,'reconnecting');assert.equal(h.b.mixers.get(healthy),original);assert.equal(h.outputs.filter(o=>o.id===B && o.i===4).length,1);
 bad.connection.state.status='ready';h.b.reconcile();assert(h.b.active);assert.equal(h.b.mixers.get(healthy),original);
}finally{h.stop();}});

test('pause discards cross-guild buffers immediately, preserves connections and permits independent internal audio',()=>{const h=harness();try{
 h.b.start(A);h.b.configure(A,'swipe',{enabled:true});const before=h.a.relays.map(r=>r.connection),mains={...h.b.mainEnabled};let stops=0;for(const session of [h.a,h.c])for(const relay of session.relays)relay.voicePlayer={stop:force=>{assert.equal(force,true);stops++;}};
 h.a.audio.broadcast(U,0,h.a.relays[0].connection.receiver);const old=[...h.b.mixers.values()];for(const m of old)for(const key of m.sources.keys())m.push(key,Buffer.alloc(3840,1));
 h.b.configure(A,'pause');assert(stops>=24);assert.equal(h.b.state,'paused');assert(!h.b.routingReady);assert.equal(h.b.mixers.size,0);assert(old.every(m=>m.output===null && m.sources.size===0));
 assert.deepEqual(h.a.relays.map(r=>r.connection),before);assert.deepEqual(h.b.mainEnabled,mains);assert(h.b.swipe);assert(!h.a.paused && !h.c.paused);
 assert.equal(h.b.targets(h.a,h.a.channels[1].id,true,X).length,0);
 const local=h.a.audio.targets(h.a.channels[1].id,true,X);assert.deepEqual(local,[h.a.relays[0]]);
 h.a.audio.broadcast(U,0,h.a.relays[0].connection.receiver);assert.equal(h.a.audio.streams.size,1);assert.equal(h.a.audio.streams.values().next().value.mixers.length,11);
 const localMixer=h.a.audio.mixers.get(h.a.relays[3]);h.b.configure(A,'pause');assert.equal(h.a.audio.mixers.get(h.a.relays[3]),localMixer);
 h.b.configure(A,'resume');assert(h.b.active);assert(h.b.swipe);assert.deepEqual(h.a.relays.map(r=>r.connection),before);assert.deepEqual(h.b.mainEnabled,mains);
 const count=h.b.events.filter(e=>e.type==='resume').length;h.b.configure(A,'resume');assert.equal(h.b.events.filter(e=>e.type==='resume').length,count);
 h.a.audio.broadcast(U,0,h.a.relays[0].connection.receiver);assert.equal(h.a.audio.streams.size,1);assert.equal(h.a.audio.streams.values().next().value.mixers.length,23);
 assert([...h.b.mixers.values()].every(m=>[...m.sources.values()].every(source=>source.queue.length===0)));
}finally{h.stop();}});

test('pause intent dominates transport health; resume reports actual readiness and end is durable',()=>{const h=harness();try{
 h.b.start(A);h.b.configure(B,'pause');h.c.relays[1].connection.state.status='disconnected';h.b.reconcile();assert.equal(h.b.state,'paused');assert.equal(h.b.snapshot(A).infrastructureState,'reconnecting');
 h.b.configure(B,'resume');assert.equal(h.b.state,'reconnecting');assert(!h.b.active);
 h.b.configure(A,'pause');h.sessions.delete(B);h.b.reconcile();assert.equal(h.b.state,'paused');assert.equal(h.b.infrastructureState,'waiting');h.b.configure(A,'resume');assert.equal(h.b.state,'waiting');
 h.sessions.set(B,h.c);h.c.relays[1].connection.state.status='ready';h.b.reconcile();assert(h.b.active);
 h.b.configure(A,'pause');h.b.end(B);assert.equal(h.b.state,'off');assert(!h.b.paused);assert.equal(h.saved.at(-1).desired,false);assert.throws(()=>h.b.configure(A,'resume'),/Start the bridge/);
}finally{h.stop();}});

test('pause persistence restores intentional pause and restart never starts sessions or resets configuration',()=>{const h=harness();try{
 h.b.start(A);h.b.configure(A,'mains',{mainEnabled:{[A]:false,[B]:true}});h.b.configure(A,'pause');const saved=h.saved.at(-1);
 const restored=new AllianceBridge({sessions:h.sessions,insanityGuildId:A,allianceGuildId:B,saved});restored.reconcile();assert.equal(restored.state,'paused');assert(!restored.routingReady);
 const id=restored.id,mains={...restored.mainEnabled},connections=h.c.relays.map(r=>r.connection);restored.configure(A,'restart');assert.equal(restored.state,'paused');assert.equal(restored.id,id);assert.deepEqual(restored.mainEnabled,mains);assert.deepEqual(h.c.relays.map(r=>r.connection),connections);
 restored.configure(A,'resume');assert(restored.active);assert.deepEqual(restored.mainEnabled,mains);restored.end(A);
 for(const action of ['pause','resume','restart'])assert.throws(()=>h.b.configure('unknown-guild',action),e=>e.status===403);
}finally{h.stop();}});

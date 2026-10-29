// Regression coverage for the patched API and shared Discord/HTTP lifecycle.
// Voice/Discord transport is mocked; production lifecycle code is exercised.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),{EventEmitter}=require('node:events');
const GUILD='111111111111111111',CHANNEL='200000000000000001';
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function harness(){
 const sessions=new Map(),created=[],config={controlApiKey:'key',relayTokens:['fake-token']};
 const channel={id:CHANNEL,name:'Anchor',type:2,members:new Map()};
 const guild={id:GUILD,channels:{fetch:async()=>channel}};
 class Session {constructor(){this.channels=[channel];this.relays=[];this.dedicated=new Set();this.additionalCallers=new Set();this.destroyed=false;this.audioStopped=false;created.push(this);}async start(){}async destroy(){this.destroyed=true;this.audioStopped=true;}}
 const module={exports:{}},context={module,exports:module.exports,URL,Buffer,console,require:name=>name==='discord.js'?{ChannelType:{GuildVoice:2}}:name==='./config'?config:name==='./session'?{Session}:name==='./lastchannel'?{get:()=>null,remember(){}}:name==='./lifecycle'?require('../src/lifecycle'):name==='./diagnostics'?{diagnosticsFor:()=>({schemaVersion:1})}:(()=>{throw Error(name)})()};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/api.js'),'utf8'),context);
 const client={guilds:{cache:new Map([[GUILD,guild]])}};
 function call(sub,body={}){const req=new EventEmitter();req.method='POST';req.url=`/api/guilds/${GUILD}/session/${sub}`;req.headers={authorization:'Bearer key'};let status,result;const res={writeHead:s=>status=s,end:data=>result=JSON.parse(data)};const done=module.exports.handleApi(req,res,sessions,client);queueMicrotask(()=>{req.emit('data',JSON.stringify(body));req.emit('end');});return done.then(()=>({status,body:result}));}
 return{sessions,created,Session,call};
}
const lifecycle=require('../src/lifecycle');
test('concurrent API starts accept one session and reject the other with 409',async()=>{
 const h=harness(),replies=await Promise.all([h.call('start',{count:1,channelId:CHANNEL}),h.call('start',{count:1,channelId:CHANNEL})]);
 assert.deepEqual(replies.map(x=>x.status).sort(),[200,409]);assert.equal(h.created.length,1);assert.equal(h.sessions.size,1);assert(replies.find(x=>x.status===200).body.sessionId);
});
test('stop shuts audio down before a slow panel update and holds reservation through teardown',async()=>{
 const h=harness(),old=new h.Session();let finish,editDone=false;
 old.destroy=async()=>{old.audioStopped=true;await new Promise(r=>finish=r);old.destroyed=true;};old.panelMessage={edit:()=>new Promise(()=>{})};h.sessions.set(GUILD,old);
 const stop=await h.call('stop');assert.equal(stop.status,200);assert.equal(stop.body.sessionState,'stopping');assert(old.audioStopped);assert.equal((await h.call('start',{count:1,channelId:CHANNEL})).status,409);
 finish();await flush();assert(!h.sessions.has(GUILD));assert.equal((await h.call('start',{count:1,channelId:CHANNEL})).status,200);
});
test('Discord and HTTP share the same start reservation',async()=>{
 const h=harness(),record=lifecycle.reserveStart(h.sessions,GUILD);assert.equal((await h.call('start',{count:1,channelId:CHANNEL})).status,409);
 lifecycle.stopSession(h.sessions,GUILD,record.sessionId);await assert.rejects(lifecycle.completeStart(h.sessions,GUILD,record,async()=>new h.Session()),/cancelled/);assert(!h.sessions.has(GUILD));
 await h.call('start',{count:1,channelId:CHANNEL});assert.throws(()=>lifecycle.reserveStart(h.sessions,GUILD),/active/);
});
test('stale session stop cannot stop a replacement, and failed cleanup remains retryable',async()=>{
 const h=harness(),a=new h.Session();h.sessions.set(GUILD,a);const id=lifecycle.idOf(a);lifecycle.stopSession(h.sessions,GUILD,id);await flush();
 const b=new h.Session();h.sessions.set(GUILD,b);assert.throws(()=>lifecycle.stopSession(h.sessions,GUILD,id),/changed/);assert(!b.destroyed);
 let fail=true;b.destroy=()=>{if(fail)throw Error('injected cleanup failure');b.destroyed=true;};lifecycle.stopSession(h.sessions,GUILD);await flush();assert.equal(h.sessions.get(GUILD).lifecycle,'stop-failed');assert.throws(()=>lifecycle.reserveStart(h.sessions,GUILD));
 fail=false;lifecycle.stopSession(h.sessions,GUILD);await flush();assert(!h.sessions.has(GUILD));assert(b.destroyed);
});
test('actual Session startup cancellation cleans partial relays before any audio router is created',async()=>{
 let release,relayDestroyed=false,mainDestroyed=false,routers=0;const login=new Promise(r=>release=r),module={exports:{}};
 const context={module,exports:module.exports,console,setTimeout,clearTimeout,require:name=>{
  if(name==='discord.js')return{};
  if(name==='@discordjs/voice')return{joinVoiceChannel:()=>({state:{status:'ready'},on(){},destroy(){mainDestroyed=true;}})};
  if(name==='./config')return{relayTokens:['dummy'],calloutAutoOffMs:20000};
  if(name==='./relay')return{Relay:class{async login(){await login;}async connect(){}destroy(){relayDestroyed=true;}}};
  if(name==='./audio')return{AudioRouter:class{constructor(){routers++;}}};
  if(name==='./speakingflags')return{watchSpeakingFlags(){}};
  if(name==='./janitor')return{retire:async()=>{}};throw Error(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/session.js'),'utf8'),context);
 const channel={id:CHANNEL,name:'Anchor',send:async()=>{}},session=new module.exports.Session({id:GUILD,voiceAdapterCreator:{}},channel,null,1);session.loadCallers=async()=>{};session.calloutRow=()=>({});
 const sessions=new Map(),r=lifecycle.reserveStart(sessions,GUILD),starting=lifecycle.completeStart(sessions,GUILD,r,async()=>session);await flush();lifecycle.stopSession(sessions,GUILD,r.sessionId);release();await assert.rejects(starting,/cancelled/);
 assert.equal(routers,0);assert(relayDestroyed);assert(mainDestroyed);assert(!sessions.has(GUILD));
});

test('Session cleanup disconnects all voices immediately and waits for gateway logout before unlocking',async()=>{
 const order=[],module={exports:{}};let release;
 const logout=new Promise(r=>release=r);
 const context={module,exports:module.exports,console,clearTimeout,require:name=>name==='./janitor'?{retire:async c=>{order.push('retire:'+c.id);}}:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/session.js'),'utf8'),context);
 const session=Object.create(module.exports.Session.prototype);
 Object.assign(session,{calloutTimers:new Map(),priorityTimers:new Map(),audio:{stop(){order.push('audio');}},relays:[{destroy(){order.push('relay1');return logout;}},{destroy(){order.push('relay2');}}],main:{destroy(){order.push('main');}},createdChannels:[{id:'empty'}],channels:[]});
 const sessions=new Map([[GUILD,session]]);lifecycle.stopSession(sessions,GUILD);
 assert.deepEqual(order,['audio','relay1','relay2','main']);assert.equal(sessions.get(GUILD).lifecycle,'stopping');
 release();await flush();assert.deepEqual(order,['audio','relay1','relay2','main','retire:empty']);assert(!sessions.has(GUILD));
});

test('actual Session cleanup failure can be retried without destroying the main connection twice',async()=>{
 const module={exports:{}};let fail=true,mainStops=0;
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/session.js'),'utf8'),{module,exports:module.exports,console,clearTimeout,require:name=>name==='./janitor'?{retire:async()=>{}}:{}});
 const session=Object.create(module.exports.Session.prototype);
 Object.assign(session,{calloutTimers:new Map(),priorityTimers:new Map(),audio:{stop(){}},relays:[{async destroy(){if(fail)throw Error('logout failed');}}],main:{destroy(){mainStops++;if(mainStops>1)throw Error('already destroyed');}},createdChannels:[],channels:[]});
 await assert.rejects(session.destroy(),/cleanup failed/);fail=false;await session.destroy();assert.equal(mainStops,1);
});

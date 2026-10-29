const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {diagnosticsFor}=require('../src/diagnostics');
const client={user:{id:'main',tag:'MainBot'},isReady:()=>true,ws:{ping:22}};
const session={count:1,main:{state:{status:'ready'}},guild:{client},channels:[{id:'channel',name:'Party 1',members:new Map()}],relays:[{client:{user:{id:'relay',tag:'RelayBot'},isReady:()=>true,ws:{ping:-1}},connection:{state:{status:'disconnected'}},voicePlayer:{state:{status:'idle'}},rejoins:2}],dedicated:new Set(['caller']),additionalCallers:new Set(),bridge:null,muted:false,callerRoleId:null};
test('snapshots expose connection observations without secrets or audio-side mutations',()=>{
 const before=session.relays[0].connection.state.status,d=diagnosticsFor(session,client,8);
 assert.equal(d.mainBot.gatewayReady,true);assert.equal(d.relays[0].voiceState,'disconnected');assert.equal(d.relays[0].gatewayPingMs,null);assert.equal(d.relays[0].rejoinAttempts,2);assert.equal(d.configuredRelays,8);assert.equal(d.expectedRelays,1);assert.equal(session.relays[0].connection.state.status,before);assert(Number.isFinite(d.uptimeSeconds));assert(!JSON.stringify(d).includes('token-value'));
 const idle=diagnosticsFor(null,client,8);assert.equal(idle.sessionState,'inactive');assert.equal(idle.mainBot.voiceState,null);assert.deepEqual(idle.relays,[]);assert.equal(diagnosticsFor(null,client,8,true).sessionState,'starting');
});
test('existing authenticated session API adds telemetry and keeps inactive/active shapes compatible',async()=>{
 const config={controlApiKey:'secret-test',relayTokens:['token-value']},module={exports:{}};
 const context={module,exports:module.exports,console,Buffer,URL,require:name=>name==='discord.js'?{ChannelType:{GuildVoice:2}}:name==='./config'?config:name==='./session'?{Session:class{}}:name==='./lastchannel'?{get:()=>null}:name==='./lifecycle'?require('../src/lifecycle'):name==='./diagnostics'?{diagnosticsFor}:(()=>{throw Error(name)})()};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/api.js'),'utf8'),context);
 const invoke=async(sessions,auth='Bearer secret-test')=>{let status,body;const res={writeHead:code=>status=code,end:data=>body=JSON.parse(data)};await module.exports.handleApi({method:'GET',url:'/api/guilds/111111111111111111/session',headers:{authorization:auth}},res,sessions,client);return{status,body};};
 const active=await invoke(new Map([['111111111111111111',session]]));assert.equal(active.status,200);assert.equal(active.body.active,true);assert.equal(active.body.parties[0].name,'Party 1');assert.equal(active.body.diagnostics.relays[0].rejoinAttempts,2);assert(!JSON.stringify(active.body).includes('secret-test'));assert(!JSON.stringify(active.body).includes('token-value'));
 const inactive=await invoke(new Map());assert.equal(inactive.body.active,false);assert.equal(inactive.body.diagnostics.mainBot.gatewayReady,true);
 const denied=await invoke(new Map(),'Bearer wrong');assert.equal(denied.status,401);assert.equal(denied.body.diagnostics,undefined);
});

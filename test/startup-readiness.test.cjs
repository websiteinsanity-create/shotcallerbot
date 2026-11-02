const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),{EventEmitter}=require('node:events');
function harness({count=12,failEarlier=false,duplicate=false}={}){
 const module={exports:{}},relays=[],client=new EventEmitter();client.user={id:'main'};const channel=i=>({id:'channel'+i,name:'Party '+(i+1),send:async()=>{}});let routers=0,voiceJoins=0;
 const config={relayTokens:Array.from({length:12},(_,i)=>duplicate?'same-token':'token-'+i),calloutAutoOffMs:20000};
 class Relay{constructor(token,index){this.index=index;this.client={user:{id:'relay'+index},isReady:()=>true};relays.push(this);}async login(){}async connect(){this.connection={state:{status:'ready'},receiver:{speaking:Object.assign(new EventEmitter(),{users:new Map()})}};if(failEarlier && this.index===1)relays[0].connection.state.status='disconnected';}async destroy(){this.destroyed=true;}}
 const context={module,console,setTimeout,clearTimeout,setInterval,clearInterval,require:name=>name==='discord.js'?{ChannelType:{GuildVoice:2}}:name==='./config'?config:name==='./relay'?{Relay}:name==='./audio'?{AudioRouter:class{constructor(){routers++;}stop(){}stopBroadcast(){}dropTarget(){}refreshTargets(){}}}:name==='./main-caller'?require('../src/main-caller'):name==='./janitor'?{retire:async()=>{},sweep:async()=>{},track(){}}:name==='@discordjs/voice'?{VoiceConnectionStatus:{Ready:'ready'},joinVoiceChannel:()=>{voiceJoins++;},entersState:async conn=>{if(conn.state.status!=='ready')throw Error('Relay not ready');return conn;}}:{}};
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../src/session.js'),'utf8'),context);
 const guild={id:'guild',client,members:{cache:new Map()},voiceStates:{cache:new Map()}};const session=new module.exports.Session(guild,channel(0),null,count);session.loadCallers=async()=>{};session.calloutRow=()=>({});session.createPartyChannels=async()=>{session.channels=Array.from({length:session.count},(_,i)=>channel(i));};return{session,relays,routers:()=>routers,voiceJoins:()=>voiceJoins};
}
test('real session starts twelve relay receivers/players and leaves main bot in background',async()=>{const h=harness();try{await h.session.start();assert.equal(h.relays.length,12);assert.equal(h.session.channels.length,12);assert.equal(h.routers(),1);assert.equal(h.voiceJoins(),0);assert(h.relays.every(r=>r.connection.state.status==='ready'));assert.equal(h.relays[0].connection.receiver.speaking.listenerCount('start'),1);}finally{await h.session.destroy();}});
test('session cannot become active when an earlier relay drops before the last relay finishes',async()=>{const h=harness({count:2,failEarlier:true});try{await assert.rejects(h.session.start(),/not ready/);assert.equal(h.routers(),0);}finally{await h.session.destroy();}assert(h.relays.every(r=>r.destroyed));});
test('duplicate tokens fail before channel or relay construction',async()=>{const h=harness({count:2,duplicate:true});await assert.rejects(h.session.start(),/distinct tokens/);assert.equal(h.session.channels.length,0);assert.equal(h.relays.length,0);});

test('restart reuses surviving party channels and creates only the missing party',async()=>{const h=harness({count:3}),s=h.session;let created=0;
 const old={id:'old-party-2',name:'Party 2',type:2,guild:s.guild,send:async()=>{}};
 s.guild.channels={fetch:async id=>id===old.id?old:null,create:async spec=>{created++;return{id:'new-party-3',name:spec.name,type:2,guild:s.guild,send:async()=>{}};}};
 s.restoreSpec={channels:[{id:'channel0'},{id:old.id,created:true},{id:'deleted',created:true}]};
 s.createPartyChannels=Object.getPrototypeOf(s).createPartyChannels.bind(s);
 try{await s.start();assert.equal(created,1);assert.equal(s.channels[1],old);assert.equal(s.channels[2].name,'Party 3');assert.equal(s.createdChannels.length,2);assert.equal(s.channels[0],s.commandVoice);}finally{await s.destroy({preserveChannels:true});}
});

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readPresence}=require('../src/presence');
const id='200000000000000001',gid='100000000000000001';
const member=(n,deaf=false)=>({id:String(n),user:{bot:false},voice:{mute:false,deaf}});
const channel=(members=[])=>({id,guild:{id:gid},type:2,members:new Map(members.map(m=>[m.id,m]))});
const guild=(cached,fetch)=>({id:gid,channels:{cache:new Map(cached?[[id,cached]]:[]),fetch}});
test('cache miss fetches the selected extra channel, preserves mute/deaf and excludes bots',async()=>{
const c=channel([member(1),member(2,true),{id:'bot',user:{bot:true}}]);let calls=0;
const result=await readPresence(guild(null,async()=>{calls++;return c}),[id,id],{voiceType:2});
assert.equal(calls,1);assert.equal(result.length,1);assert.equal(result[0].connected,2);assert.equal(result[0].connectedStates[1].deaf,true);
});
test('unresponsive Discord lookup returns unknown within a bounded interval',async()=>{
const result=await readPresence(guild(null,()=>new Promise(()=>{})),[id],{voiceType:2,timeoutMs:10});assert.equal(result[0].found,false);assert.match(result[0].error,/timed out/);assert.equal(result[0].connectedStates,undefined);
});
test('access denied, wrong guild/type and invalid IDs never masquerade as empty channels',async()=>{
for(const c of [null,{...channel(),guild:{id:'other'}},{...channel(),type:0}]){
const r=await readPresence(guild(c,async()=>{throw Error('access denied')}),[id],{voiceType:2});assert.equal(r[0].found,false);
}
assert.equal((await readPresence(guild(null),['bad'],{voiceType:2}))[0].found,false);
});
test('twelve channels with 100 people preserve all identities and deafened states',async()=>{
const cache=new Map();for(let i=0;i<12;i++){const key=String(BigInt(id)+BigInt(i));cache.set(key,channel(Array.from({length:i<4?9:8},(_,j)=>member(i*10+j,j===0))));}
const r=await readPresence({id:gid,channels:{cache}},[...cache.keys()],{voiceType:2});assert.equal(r.reduce((n,c)=>n+c.connected,0),100);assert.equal(new Set(r.flatMap(c=>c.connectedUserIds)).size,100);
});

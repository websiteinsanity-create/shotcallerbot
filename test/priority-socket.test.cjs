
const {test}=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events');
const {watchSpeakingFlags}=require('../src/speakingflags');
test('priority packets remain guild-local on shared accounts and reattach after socket replacement',()=>{
 const connect=()=>{const ws=new EventEmitter(),networking=Object.assign(new EventEmitter(),{state:{ws}}),connection=Object.assign(new EventEmitter(),{state:{networking}});return{connection,networking,ws};};
 const a=connect(),b=connect(),receivedA=[],receivedB=[];watchSpeakingFlags(a.connection,'Insanity',(u,f)=>receivedA.push([u,f]));watchSpeakingFlags(b.connection,'Alliance',(u,f)=>receivedB.push([u,f]));
 b.ws.emit('packet',{op:5,d:{user_id:'alliance-caller',speaking:5}});assert.deepEqual(receivedB,[['alliance-caller',5]]);assert.equal(receivedA.length,0);
 const next=new EventEmitter();b.networking.emit('stateChange',b.networking.state,{ws:next});next.emit('packet',{op:5,d:{user_id:'alliance-caller',speaking:1}});assert.deepEqual(receivedB.at(-1),['alliance-caller',1]);
 a.ws.emit('packet',{op:5,d:{user_id:'insanity-caller',speaking:5}});assert.deepEqual(receivedA,[['insanity-caller',5]]);
});

const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
test('occupied created channels survive cleanup and are removed only when the last human leaves',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shotcaller-cleanup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/janitor.js'),'utf8'),{module,console,require:name=>name==='fs'?fs:name==='path'?path:name==='./config'?{dataDir:dir}:name==='discord.js'?{ChannelType:{}}:{}});
 let deleted=0;const channel={id:'created',name:'Party 2',guildId:'guild',members:new Map([['human',{user:{bot:false}}]]),fetch:async()=>channel,delete:async()=>deleted++};
 const janitor=module.exports;janitor.track(channel);await janitor.retire(channel);assert.equal(deleted,0);assert(janitor._watched.has(channel.id));channel.members.clear();await janitor.onVoiceUpdate({channelId:channel.id},{channelId:null});assert.equal(deleted,1);assert.equal(janitor._watched.has(channel.id),false);
});

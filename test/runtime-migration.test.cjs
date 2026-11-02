// Startup with every kind of data/runtime.json found on real Docker volumes.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Runtime}=require('../src/runtime');const {loadRuntimeState}=require('../src/runtime-state');
const A='111111111111111111',B='222222222222222222',C='333333333333333333',D='444444444444444444';
const quiet=()=>{const lines=[];return {lines,log:{error:m=>lines.push(m),warn:m=>lines.push(m)}};};
function vol(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sc-runtime-'));try{return fn(dir,path.join(dir,'runtime.json'));}finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:30});}}
const runtime=(dir,extra={})=>new Runtime(new Map(),{guilds:{cache:new Map()}},{dataDir:dir,...extra});
// Exactly what the first generation (src/state.js + voice/sessionManager.js export()) wrote every 30 seconds.
const LEGACY={[A]:{mode:'gvg',partyCount:8,partyChannelIds:[B,C],muted:false,dedicatedCaller:D,textChannelId:C,startedAt:1727700000000}};
const CURRENT={version:1,sessions:{[A]:{channelId:B,count:2,callerId:D,additionalCallers:[C],paused:false,muted:true,channels:[{id:B,name:'Party 1',created:false},{id:C,name:'Party 2',created:true}]}},bridge:{id:'bridge-1',desired:true,mainEnabled:{[A]:true,[B]:false},allowAllianceManage:true,bufferMs:60,originalMains:{[A]:[D]}}};

test('missing runtime file: fresh state, nothing written',()=>vol((dir,file)=>{const q=quiet();const r=runtime(dir,{log:q.log});assert.deepEqual(r.saved,{version:1,sessions:{},bridge:{}});assert.equal(r.loadResult.kind,'missing');assert.deepEqual(fs.readdirSync(dir),[]);assert.deepEqual(q.lines,[]);}));

test('current v1 data loads unchanged: sessions, callers, relay channels and Bridge settings are kept',()=>vol((dir,file)=>{const raw=JSON.stringify(CURRENT,null,2);fs.writeFileSync(file,raw);const q=quiet();const r=runtime(dir,{log:q.log,insanityGuildId:A,allianceGuildId:B});
 assert.equal(r.loadResult.kind,'current');assert.deepEqual(r.saved,CURRENT);assert.equal(fs.readFileSync(file,'utf8'),raw,'file untouched');assert.deepEqual(fs.readdirSync(dir),['runtime.json']);
 assert.equal(r.bridge.desired,true);assert.equal(r.bridge.bufferMs,60);assert.equal(r.bridge.allowAllianceManage,true);assert.deepEqual(r.bridge.mainEnabled,{[A]:true,[B]:false});assert.deepEqual(r.bridge.originalMains,{[A]:[D]});assert.deepEqual(q.lines,[]);}));

test('legacy first-generation data is migrated: original backed up byte-for-byte, embedded, not restarted',()=>vol((dir,file)=>{const raw=JSON.stringify(LEGACY,null,2);fs.writeFileSync(file,raw);const q=quiet();const r=runtime(dir,{log:q.log,now:()=>Date.UTC(2026,10,2,13,0,0)});
 assert.equal(r.loadResult.kind,'legacy');assert.deepEqual(r.saved.sessions,{},'old sessions are not auto-started');assert.deepEqual(r.saved.bridge,{});assert.deepEqual(r.saved.legacy.sessions,LEGACY);
 const backup=fs.readdirSync(dir).find(n=>n.startsWith('runtime.json.legacy-'));assert(backup);assert.equal(fs.readFileSync(path.join(dir,backup),'utf8'),raw);assert.equal(r.saved.legacy.backupFile,backup);
 const migrated=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(migrated.version,1);assert.deepEqual(migrated.legacy.sessions,LEGACY);assert(q.lines.some(l=>l.includes(backup)));
 // Second start: the migrated file is current data, no second backup is created.
 const again=runtime(dir,{log:quiet().log});assert.equal(again.loadResult.kind,'current');assert.deepEqual(again.saved.legacy.sessions,LEGACY);assert.equal(fs.readdirSync(dir).filter(n=>n.startsWith('runtime.json.legacy-')).length,1);}));

test('empty legacy file ({} written by the old bot with no sessions) is migrated too',()=>vol((dir,file)=>{fs.writeFileSync(file,'{}');const r=runtime(dir,{log:quiet().log});assert.equal(r.loadResult.kind,'legacy');assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).version,1);assert(fs.readdirSync(dir).some(n=>n.startsWith('runtime.json.legacy-')));}));

test('migrated legacy volume then works normally: Bridge settings and sessions persist across restarts',()=>vol((dir,file)=>{fs.writeFileSync(file,JSON.stringify(LEGACY));const r=runtime(dir,{log:quiet().log,insanityGuildId:A,allianceGuildId:B});r.bridge.configure(A,'settings',{allowAllianceManage:true,bufferMs:80},true);
 const again=runtime(dir,{log:quiet().log,insanityGuildId:A,allianceGuildId:B});assert.equal(again.bridge.bufferMs,80);assert.equal(again.bridge.allowAllianceManage,true);assert.deepEqual(again.saved.legacy.sessions,LEGACY);}));

test('malformed JSON is preserved under a new name and startup continues',()=>vol((dir,file)=>{fs.writeFileSync(file,'{"version":1,"sess');const q=quiet();const r=runtime(dir,{log:q.log});assert.equal(r.loadResult.kind,'corrupt');assert.deepEqual(r.saved.sessions,{});
 const kept=fs.readdirSync(dir).find(n=>n.startsWith('runtime.json.corrupt-'));assert(kept);assert.equal(fs.readFileSync(path.join(dir,kept),'utf8'),'{"version":1,"sess');assert(!fs.existsSync(file),'nothing written over it');
 r.write();assert.equal(fs.readFileSync(path.join(dir,kept),'utf8'),'{"version":1,"sess','later writes never touch the preserved copy');assert(q.lines[0].includes('not valid JSON'));}));

test('unrecognised shapes and newer schema versions are preserved, never interpreted',()=>vol((dir,file)=>{for(const raw of ['[]','"text"','null',JSON.stringify({version:2,sessions:{}}),JSON.stringify({version:1,sessions:[]}),JSON.stringify({foo:{bar:1}})]){fs.writeFileSync(file,raw);const r=runtime(dir,{log:quiet().log});assert.equal(r.loadResult.kind,'corrupt',raw);assert.deepEqual(r.saved.sessions,{});}
 const kept=fs.readdirSync(dir).filter(n=>n.startsWith('runtime.json.corrupt-'));assert.equal(kept.length,6,'each damaged file kept separately');}));

test('partly invalid v1 data keeps every valid session and Bridge field and backs up the original',()=>vol((dir,file)=>{const raw=JSON.stringify({version:1,sessions:{[A]:CURRENT.sessions[A],[C]:{count:99}},bridge:{desired:true,bufferMs:41,allowAllianceManage:true,mainEnabled:{[A]:true,[B]:true}}});fs.writeFileSync(file,raw);const r=runtime(dir,{log:quiet().log,insanityGuildId:A,allianceGuildId:B});
 assert.equal(r.loadResult.kind,'repaired');assert.deepEqual(Object.keys(r.saved.sessions),[A]);assert.deepEqual(r.saved.sessions[A],CURRENT.sessions[A]);assert.equal(r.saved.bridge.desired,true);assert.equal(r.saved.bridge.allowAllianceManage,true);assert.equal(r.saved.bridge.bufferMs,undefined);assert.equal(r.bridge.bufferMs,40,'invalid buffer falls back to the default');
 const backup=fs.readdirSync(dir).find(n=>n.startsWith('runtime.json.before-repair-'));assert.equal(fs.readFileSync(path.join(dir,backup),'utf8'),raw);}));

test('an unreadable runtime path refuses startup instead of guessing',()=>vol((dir,file)=>{fs.mkdirSync(file);assert.throws(()=>runtime(dir,{log:quiet().log}),/Cannot read runtime state/);assert(fs.statSync(file).isDirectory());}));

test('half-configured Bridge IDs still refuse startup before any file is touched',()=>vol((dir,file)=>{fs.writeFileSync(file,JSON.stringify(LEGACY));assert.throws(()=>runtime(dir,{insanityGuildId:A}),/two distinct Discord ids/);assert.deepEqual(fs.readdirSync(dir),['runtime.json']);assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),LEGACY);}));

test('loader never deletes: every outcome leaves the original bytes on disk',()=>vol((dir,file)=>{const samples=[JSON.stringify(LEGACY),'{bad',JSON.stringify({version:1,sessions:{[A]:{count:0}}})];for(const raw of samples){for(const n of fs.readdirSync(dir))fs.rmSync(path.join(dir,n));fs.writeFileSync(file,raw);loadRuntimeState(file,{log:quiet().log});const contents=fs.readdirSync(dir).map(n=>fs.readFileSync(path.join(dir,n),'utf8'));assert(contents.includes(raw),raw);}}));

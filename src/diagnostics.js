'use strict';
// Read-only snapshots. Never touches voice queues, codecs, subscriptions or session controls.
const finite = value => typeof value==='number' && Number.isFinite(value) && value>=0 ? value : null;
function botInfo(client,connection) {
 return {id:client?.user?.id || null,name:client?.user?.tag || client?.user?.username || null,gatewayReady:typeof client?.isReady==='function'?client.isReady():null,gatewayPingMs:finite(client?.ws?.ping),voiceState:connection?.state?.status || null};
}
function diagnosticsFor(session,client,configuredRelays,starting=false) {
 const memory=process.memoryUsage();
 return {schemaVersion:1,addonVersion:'status-1',sampledAt:new Date().toISOString(),sessionState:session?'active':starting?'starting':'inactive',uptimeSeconds:Math.floor(process.uptime()),memoryRssMiB:Math.round(memory.rss/1048576),heapUsedMiB:Math.round(memory.heapUsed/1048576),configuredRelays:finite(configuredRelays),expectedRelays:session?finite(session.count):null,mainBot:botInfo(client,session?.main),relays:(session?.relays || []).map((relay,index)=>({...botInfo(relay.client,relay.connection),index:index+1,channelId:session.channels?.[index]?.id || null,playerState:relay.voicePlayer?.state?.status || null,rejoinAttempts:finite(relay.rejoins)}))};
}
module.exports={diagnosticsFor};

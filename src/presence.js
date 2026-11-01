"use strict";

// REST channel discovery is bounded independently of Discord's retry queue.
// A failed read is unknown, never an empty channel.
async function readPresence(guild, ids, {voiceType, timeoutMs=3000}={}) {
  return Promise.all([...new Set(ids)].map(async channelId => {
    let timer;
    try {
      if (!/^\d{15,25}$/.test(channelId)) throw Error('Invalid channel id');
      const channel = guild.channels.cache.get(channelId) || await Promise.race([
        guild.channels.fetch(channelId),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Channel lookup timed out')),timeoutMs);})
      ]);
      if (guild.available===false || !channel || channel.viewable===false || channel.guild?.id !== guild.id || channel.type !== voiceType) throw Error('Voice channel unavailable');
      return {channelId,found:true,...presenceOf(channel)};
    } catch(error) {
      return {channelId,found:false,error:error.message};
    } finally { clearTimeout(timer); }
  }));
}
function presenceOf(channel) {
  const humans = channel?.members ? [...channel.members.values()].filter(m=>!m.user?.bot) : [];
  return {connected:humans.length,connectedUserIds:humans.map(m=>m.id),
    connectedStates:humans.map(m=>({id:m.id,mute:!!m.voice?.mute,deaf:!!m.voice?.deaf}))};
}
module.exports={readPresence,presenceOf};

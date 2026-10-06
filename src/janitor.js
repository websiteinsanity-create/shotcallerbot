// Cleans up the party channels the bot creates.
//
// - When a session stops, a channel with nobody in it is deleted straight away. One that still has people in it
//   is NOT touched (nobody gets kicked) — it's remembered, and deleted the moment the last person leaves.
// - On startup, and before each new session, any "Party N" channel left in the Shotcaller category by an earlier
//   run (e.g. the bot was restarted mid-session, so its in-memory list was lost) gets the same treatment.
// - Failures are logged, never swallowed, so a permissions problem is visible instead of silently leaving channels.

const { ChannelType } = require("discord.js");
const config = require("./config");

const watched = new Map();   // channelId -> channel, waiting for the last person to leave
const warned = new Set();    // channelIds we've already logged a failure for (don't spam the log)

const humans = (ch) => (ch.members ? [...ch.members.values()].filter((m) => !m.user?.bot).length : 0);

async function tryDelete(ch, reason) {
  try {
    await ch.delete(reason);
    watched.delete(ch.id); warned.delete(ch.id);
    return true;
  } catch (e) {
    if (e.code === 10003) { watched.delete(ch.id); warned.delete(ch.id); return true; } // already gone
    if (!warned.has(ch.id)) {
      warned.add(ch.id);
      console.warn(`[cleanup] could not delete "${ch.name}": ${e.message} — will keep retrying whenever it changes`);
    }
    return false;
  }
}

// Delete now if empty, otherwise keep watching it.
async function retire(ch) {
  const fresh = await ch.fetch().catch(() => ch);
  if (humans(fresh) === 0 && (await tryDelete(fresh, "Shotcaller session ended"))) return;
  watched.set(fresh.id, fresh);
  if (humans(fresh) > 0) console.log(`[cleanup] "${fresh.name}" still has people in it — it will be deleted when it empties`);
}

// Wired to Discord's voiceStateUpdate: someone joined, left or moved.
async function onVoiceUpdate(oldState, newState) {
  for (const id of new Set([oldState && oldState.channelId, newState && newState.channelId])) {
    if (!id || !watched.has(id)) continue;
    const ch = watched.get(id);
    if (humans(ch) === 0) await tryDelete(ch, "Shotcaller party channel emptied");
  }
}

function forget(channelId) { watched.delete(channelId); warned.delete(channelId); }

// Find "Party N" voice channels left in the Shotcaller category by an earlier run.
async function sweep(guild) {
  const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === config.partyCategoryName);
  if (!cat) return 0;
  const leftovers = [...guild.channels.cache.values()].filter(
    (c) => c.parentId === cat.id && c.type === ChannelType.GuildVoice && /^Party \d+$/.test(c.name)
  );
  if (leftovers.length) console.log(`[cleanup] found ${leftovers.length} leftover party channel(s) in "${cat.name}"`);
  for (const c of leftovers) await retire(c);
  return leftovers.length;
}

module.exports = { retire, onVoiceUpdate, forget, sweep, _watched: watched };

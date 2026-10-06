// Cleans up the party channels the bot creates.
//
// - When a session stops, a channel with nobody in it is deleted straight away. One that still has people in it
//   is NOT touched (nobody gets kicked) — it's remembered, and deleted the moment the last person leaves.
// - On startup, and before each new session, any "Party N" channel left in the Shotcaller category by an earlier
//   run (e.g. the bot was restarted mid-session, so its in-memory list was lost) gets the same treatment.
// - Failures are logged, never swallowed, so a permissions problem is visible instead of silently leaving channels.

const fs = require("fs");
const path = require("path");
const { ChannelType } = require("discord.js");
const config = require("./config");

const watched = new Map();   // channelId -> channel, waiting for the last person to leave
const warned = new Set();    // channelIds we've already logged a failure for (don't spam the log)

// The ids of channels this bot created, kept in a small file so they can still be found after a restart.
// Only channels listed here (or legacy ones inside the old Shotcaller category) are ever deleted — never
// something that merely happens to be called "Party 2".
let registryWarned = false;
const registryFile = () => path.join(config.dataDir, "party-channels.json");
function loadRegistry() { try { return JSON.parse(fs.readFileSync(registryFile(), "utf8")); } catch { return {}; } }
function saveRegistry(reg) {
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(registryFile(), JSON.stringify(reg)); }
  catch (e) {
    if (!registryWarned) { registryWarned = true; console.warn(`[cleanup] couldn't save the channel list (${e.message}) — channels left behind by a restart won't be found`); }
  }
}
function track(ch) {
  const gid = ch.guildId || (ch.guild && ch.guild.id) || "unknown";
  const reg = loadRegistry();
  reg[gid] = [...new Set([...(reg[gid] || []), ch.id])];
  saveRegistry(reg);
}
function untrack(channelId) {
  const reg = loadRegistry(); let changed = false;
  for (const gid of Object.keys(reg)) {
    const kept = reg[gid].filter((id) => id !== channelId);
    if (kept.length !== reg[gid].length) { changed = true; reg[gid] = kept; }
    if (!reg[gid].length) delete reg[gid];
  }
  if (changed) saveRegistry(reg);
}

const humans = (ch) => (ch.members ? [...ch.members.values()].filter((m) => !m.user?.bot).length : 0);

async function tryDelete(ch, reason) {
  try {
    await ch.delete(reason);
    watched.delete(ch.id); warned.delete(ch.id); untrack(ch.id);
    return true;
  } catch (e) {
    if (e.code === 10003) { watched.delete(ch.id); warned.delete(ch.id); untrack(ch.id); return true; } // already gone
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

// A channel was deleted by someone (or by us): stop tracking it.
function forget(ch) { watched.delete(ch.id); warned.delete(ch.id); untrack(ch.id); }

// Find channels an earlier run left behind: everything on the bot's own list, plus (from before that list
// existed) "Party N" voice channels inside the old Shotcaller category.
async function sweep(guild) {
  const found = new Map();
  for (const id of loadRegistry()[guild.id] || []) {
    const ch = guild.channels.cache.get(id);
    if (ch) found.set(id, ch); else untrack(id); // already gone
  }
  const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === config.partyCategoryName);
  if (cat) {
    for (const c of guild.channels.cache.values()) {
      if (c.parentId === cat.id && c.type === ChannelType.GuildVoice && /^Party \d+$/.test(c.name)) found.set(c.id, c);
    }
  }
  if (found.size) console.log(`[cleanup] found ${found.size} leftover party channel(s) from an earlier session`);
  for (const c of found.values()) await retire(c);

  // The bot no longer uses its own category in "inplace" mode, so tidy an empty one away.
  if (cat && config.partyPlacement === "inplace") {
    const kids = [...guild.channels.cache.values()].filter((c) => c.parentId === cat.id);
    if (!kids.length) {
      try { await cat.delete("Shotcaller no longer uses its own category"); console.log(`[cleanup] removed the empty "${cat.name}" category`); }
      catch (e) { console.warn(`[cleanup] couldn't remove the empty "${cat.name}" category: ${e.message}`); }
    }
  }
  return found.size;
}

module.exports = { track, retire, onVoiceUpdate, forget, sweep, _watched: watched };

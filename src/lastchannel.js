// Remembers the last voice channel a Shotcaller session was started from, per guild. The Discord command
// never needed this (whoever runs it is already standing in the channel), but an external control panel
// has nobody "standing" anywhere, so it needs something sensible to default its channel picker to. Best
// effort only: a failure to read or write this file never blocks starting or stopping a session.
const fs = require("fs");
const path = require("path");
const config = require("./config");

const file = () => path.join(config.dataDir, "last-voice-channel.json");
function load() { try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return {}; } }
function save(reg) {
  try { fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(file(), JSON.stringify(reg)); }
  catch (e) { console.warn(`[lastchannel] couldn't save (${e.message}) - "last used" won't be remembered for next time`); }
}

function remember(guildId, channel) {
  if (!channel) return;
  const reg = load();
  reg[guildId] = { channelId: channel.id, channelName: channel.name };
  save(reg);
}
function get(guildId) {
  return load()[guildId] || null;
}

module.exports = { remember, get };

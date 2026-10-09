"use strict";
// A small authenticated HTTP control API for an external panel (Guild Hall) to read and drive a session
// without going through Discord. Everything here mirrors an existing Discord button/menu handler in
// index.js one-for-one - same fields, same side effects - so the two control surfaces can never drift
// into disagreeing about what "muted" or "dedicated" means.
//
// Auth is a single shared secret (CONTROL_API_KEY), checked against every request's Authorization header.
// It authenticates the CALLING SERVER, not a specific Discord member - so unlike the Discord-side buttons,
// there is no per-member permission check here. Whoever holds the key can do anything this file exposes;
// keep it secret, and let the panel's own login system decide who gets to click its buttons.
const { ChannelType } = require("discord.js");
const config = require("./config");
const { Session } = require("./session");
const lastchannel = require("./lastchannel");

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error("Request body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error("Body must be valid JSON")); }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!config.controlApiKey) return false; // no key configured = control API stays off entirely
  const header = req.headers["authorization"] || "";
  const m = /^Bearer (.+)$/.exec(header);
  return !!m && m[1] === config.controlApiKey;
}

// The session's control-panel-facing shape: plain JSON-safe data, no Discord.js objects. Kept separate
// from Session#panel() (which builds a Discord embed) so a change to one can't silently break the other.
function sessionStatus(s) {
  const names = (set) => [...set];
  return {
    active: true,
    muted: s.muted,
    dedicated: names(s.dedicated),
    additionalCallers: names(s.additionalCallers),
    callerRoleId: s.callerRoleId,
    bridge: s.bridge ? { active: !!s.bridge.active, partnerGuildId: s.bridge.partnerGuildId || null } : null,
    parties: s.channels.map((c, i) => ({
      index: i + 1,
      channelId: c.id,
      name: c.name,
      connected: c.members ? [...c.members.values()].filter((m) => !m.user?.bot).length : 0,
    })),
  };
}

// Returns true if this request was an API call (handled here, response already sent or in flight),
// false if the caller (index.js's health server) should keep looking at it (e.g. GET /health).
async function handleApi(req, res, sessions, client) {
  let url;
  try { url = new URL(req.url, "http://localhost"); } catch { return false; }

  const chans = /^\/api\/guilds\/(\d{15,25})\/voice-channels\/?$/.exec(url.pathname);
  if (chans) {
    if (!authorized(req)) { send(res, 401, { error: "Unauthorized" }); return true; }
    if (req.method !== "GET") { send(res, 404, { error: "Not found" }); return true; }
    const guild = client.guilds.cache.get(chans[1]);
    if (!guild) { send(res, 404, { error: "This bot is not in that server." }); return true; }
    const channels = [...guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildVoice)
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((c) => ({ id: c.id, name: c.name }));
    send(res, 200, { channels });
    return true;
  }

  const m = /^\/api\/guilds\/(\d{15,25})\/session(\/[a-z-]+)?\/?$/.exec(url.pathname);
  if (!m) return false;

  if (!authorized(req)) { send(res, 401, { error: "Unauthorized" }); return true; }

  const guildId = m[1];
  const sub = m[2] || "";
  const s = sessions.get(guildId);

  try {
    if (sub === "" && req.method === "GET") {
      send(res, 200, s ? sessionStatus(s) : { active: false, lastVoiceChannel: lastchannel.get(guildId) });
      return true;
    }

    if (sub === "/start" && req.method === "POST") {
      // Same guard as the Discord command: one session per guild, whoever claims the (synchronous) slot
      // first wins. sessions.get can also be the null placeholder a start-in-progress reserves - either
      // way, something is already happening for this guild.
      if (sessions.has(guildId)) { send(res, 409, { error: "A Shotcaller session is already active." }); return true; }
      const body = await readJsonBody(req);
      const count = Number(body.count);
      if (!Number.isInteger(count) || count < 1 || count > 12) { send(res, 400, { error: "count must be a whole number from 1 to 12." }); return true; }
      const channelId = String(body.channelId || "");
      if (!/^\d{15,25}$/.test(channelId)) { send(res, 400, { error: "channelId must be a Discord voice channel id." }); return true; }
      const guild = client.guilds.cache.get(guildId);
      if (!guild) { send(res, 404, { error: "This bot is not in that server." }); return true; }
      let channel;
      try { channel = await guild.channels.fetch(channelId); } catch { channel = null; }
      if (!channel || channel.type !== ChannelType.GuildVoice) { send(res, 400, { error: "That channel is not a voice channel in this server." }); return true; }
      const dedicatedCallerId = body.dedicatedCallerId ? String(body.dedicatedCallerId) : null;
      // Renames for the bot-created channels only (index 1..N, i.e. Party 2 onward) - channel 0 (the anchor,
      // an existing channel the bot did not create) is deliberately left alone for now. partyNames[0] names
      // channel index 1, partyNames[1] names channel index 2, and so on.
      const partyNames = Array.isArray(body.partyNames) ? body.partyNames.map((x) => (x == null ? null : String(x).slice(0, 80))) : [];

      sessions.set(guildId, null); // reserve the slot before any slow/async work, same as the Discord command
      let s2 = null;
      try {
        s2 = new Session(guild, channel, dedicatedCallerId, count);
        await s2.start();
        for (let i = 1; i < s2.channels.length; i++) {
          const name = partyNames[i - 1];
          if (name) await s2.channels[i].setName(name).catch((e) => console.warn(`[api] couldn't rename party ${i + 1}:`, e.message));
        }
        sessions.set(guildId, s2);
        lastchannel.remember(guildId, channel);
        send(res, 200, sessionStatus(s2));
      } catch (e) {
        sessions.delete(guildId);
        try { await s2?.destroy(); } catch (err) { console.error("[api] cleanup after failed start also failed:", err); }
        send(res, 502, { error: e.message || "Could not start Shotcaller." });
      }
      return true;
    }

    if (!s) { send(res, 409, { error: "No active Shotcaller session for this guild." }); return true; }

    if (sub === "/stop" && req.method === "POST") {
      try { await s.panelMessage?.edit({ content: "Shotcaller stopped.", embeds: [], components: [] }); } catch {}
      await s.destroy();
      sessions.delete(guildId);
      send(res, 200, { ok: true });
      return true;
    }

    if (sub === "/mute" && req.method === "POST") {
      const body = await readJsonBody(req);
      s.muted = typeof body.muted === "boolean" ? body.muted : !s.muted;
      if (s.muted) s.audio.stop();
      await s.panelMessage?.edit(s.panel()).catch(() => {});
      send(res, 200, { muted: s.muted });
      return true;
    }

    if (sub === "/dedicated" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.userIds)) { send(res, 400, { error: "userIds must be an array of Discord user ids." }); return true; }
      s.dedicated = new Set(body.userIds.map(String));
      s.audio.stopBroadcast(); // same as the dedicated_select menu handler: cut any in-flight broadcast, the new set takes over from the next speech
      await s.panelMessage?.edit(s.panel()).catch(() => {});
      send(res, 200, { dedicated: [...s.dedicated] });
      return true;
    }

    if (sub === "/additional-callers" && req.method === "POST") {
      const body = await readJsonBody(req);
      if (!Array.isArray(body.userIds)) { send(res, 400, { error: "userIds must be an array of Discord user ids." }); return true; }
      s.additionalCallers = new Set(body.userIds.map(String));
      await s.panelMessage?.edit(s.panel()).catch(() => {});
      send(res, 200, { additionalCallers: [...s.additionalCallers] });
      return true;
    }

    if (sub === "/bridge" && req.method === "POST") {
      send(res, 501, { error: "Bridge control isn't available yet - it's still a work in progress." });
      return true;
    }

    send(res, 404, { error: "Not found" });
    return true;
  } catch (e) {
    console.error("[api]", req.method, url.pathname, e);
    send(res, 500, { error: e.message || "Internal error" });
    return true;
  }
}

module.exports = { handleApi };

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
const { diagnosticsFor } = require("./diagnostics");
const {idOf,reserveStart,completeStart,stopSession}=require("./lifecycle");
const {preflight}=require("./preflight");
const {createOperation,operationId,recentOperations}=require("./operations");
const newOperation=(guildId,id,sessionId)=>createOperation({id,guildId,sessionId,secrets:[config.mainToken,config.controlApiKey,...config.relayTokens]});

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
//
// connectedUserIds/connectedStates (alongside the existing `connected` count): who, not just how many, is
// a non-bot member of that party's voice channel right now. `channel.members` is discord.js's own live view
// (kept current by the gateway's voice-state events, not polled), so this is exact at the moment it's read.
// Added for Guild Hall's voice-presence attendance tracking - it already knows each player's Discord id
// (that's what "owner" already is on its side), so handing back the ids themselves is what lets it match
// "this person is in Party 2's channel" to "this character belongs to that person" without this bot needing
// to know anything about characters, parties-as-Guild-Hall-knows-them, or attendance at all.
// connectedStates adds each of those same people's own mute/deaf state (`.voice.mute`/`.voice.deaf` are
// discord.js's already-combined self-OR-server booleans) - Guild Hall's own "don't count someone fully
// muted" setting needs that, and would otherwise have no way to tell a player just listening along without
// a mic from one who's actually AFK with voice chat closed entirely. Kept alongside `connected`/
// `connectedUserIds`, not replacing them, so anything reading just those is unaffected.
const {readPresence,presenceOf}=require("./presence");
function sessionStatus(s, client) {
  if(s.lifecycle)return {active:false,sessionId:idOf(s),operationId:s.operationId || null,sessionState:s.lifecycle,operations:recentOperations(s.guild?.id || s.session?.guild?.id),diagnostics:{...diagnosticsFor(null,client,config.relayTokens.length,s.lifecycle==='starting'),sessionState:s.lifecycle}};
  const names = (set) => [...set];
  return {
    active: true,
    sessionId:idOf(s),operationId:s.operationId || null,sessionState:"active",connectionIssue:s.relays.some(r=>r.connection?.state.status!=="ready" || r.client?.isReady?.()===false),operations:recentOperations(s.guild?.id),
    diagnostics: diagnosticsFor(s, client || s.guild?.client, config.relayTokens.length),
    muted: s.muted,paused:!!s.paused,mainCaller:s.mainCaller?.snapshot() || null,audioTelemetry:s.audio?{...s.audio.stats,lastPrioritySignal:s.lastPrioritySignal || null}:null,
    dedicated: names(s.dedicated),
    additionalCallers: names(s.additionalCallers),
    callerRoleId: s.callerRoleId,
    bridge: s.bridge ? { active: !!s.bridge.active, partnerGuildId: s.bridge.partnerGuildId || null } : null,
    parties: s.channels.map((c, i) => ({ index: i + 1, channelId: c.id, name: c.name, voiceState:s.relays[i]?.connection?.state.status || null,connectionIssue:!!s.relays[i] && (s.relays[i].connection?.state.status!=="ready" || s.relays[i].client?.isReady?.()===false), ...presenceOf(c) })),
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

  // Presence for arbitrary voice channels, independent of any session - Guild Hall's "other channels always
  // tracked" setting (Admin > Events) needs this for channels that are never part of a Shotcaller session at
  // all (a standing "Main" voice channel, say), so it can't reuse the session-scoped `parties` list above.
  // ?channels=id1,id2,... ; a channel this bot can't find (wrong id, not a voice channel, bot kicked from it
  // since it was picked) comes back with found:false rather than failing the whole request - one stale
  // pick in Guild Hall's list shouldn't stop every other channel from reporting.
  const vp = /^\/api\/guilds\/(\d{15,25})\/voice-presence\/?$/.exec(url.pathname);
  if (vp) {
    if (!authorized(req)) { send(res, 401, { error: "Unauthorized" }); return true; }
    if (req.method !== "GET") { send(res, 404, { error: "Not found" }); return true; }
    const guild = client.guilds.cache.get(vp[1]);
    if (!guild) { send(res, 404, { error: "This bot is not in that server." }); return true; }
    if(client.isReady?.()===false){send(res,503,{error:"Discord gateway is not ready; voice presence is unknown."});return true;}
    const ids = (url.searchParams.get("channels") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const channels = await readPresence(guild,ids,{voiceType:ChannelType.GuildVoice});
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
      send(res, 200, s ? sessionStatus(s, client) : { active: false, sessionId:null,sessionState:"inactive",operations:recentOperations(guildId),lastVoiceChannel: lastchannel.get(guildId), diagnostics: diagnosticsFor(null, client, config.relayTokens.length, sessions.has(guildId)) });
      return true;
    }

    if(sub==="/preflight" && req.method==="POST"){
      const body=await readJsonBody(req),guild=client.guilds.cache.get(guildId),operation=newOperation(guildId,body.operationId);
      const existingId=idOf(sessions.get(guildId));
      try{
        if(sessions.has(guildId) && !(body.allowActive===true && !sessions.get(guildId).lifecycle))throw Object.assign(Error('Shotcaller is active or transitioning.'),{status:409});
        if(!guild)throw Object.assign(Error('This bot is not in that server.'),{status:404});
        const channel=await guild.channels.fetch(String(body.channelId || ''));
        const result=await preflight({guild,channel,count:body.count,config,client,operation});
        if(idOf(sessions.get(guildId))!==existingId)throw Object.assign(Error('Session changed during preflight. Try again.'),{status:409});
        send(res,200,{...result,operationId:operation.id,existingSessionId:existingId});
      }catch(error){send(res,error.status || 502,{error:error.message,operationId:operation.id});}
      return true;
    }

    if (sub === "/start" && req.method === "POST") {
      // Same guard as the Discord command: one session per guild, whoever claims the (synchronous) slot
      // first wins. Lifecycle records keep the slot reserved through start and teardown.
      if (sessions.has(guildId)) { send(res, 409, { error: "A Shotcaller session is already active." }); return true; }
      const body = await readJsonBody(req);
      const requestedCount = Number(body.count);
      const count = Math.min(12,requestedCount);
      if (!Number.isInteger(requestedCount) || requestedCount < 1) { send(res, 400, { error: "count must be a positive whole number; at most 12 channels are started." }); return true; }
      if(body.dedicatedCallerId && !/^\d{15,25}$/.test(String(body.dedicatedCallerId))){send(res,400,{error:"Choose a valid main caller Discord user id."});return true;}
      const channelId = String(body.channelId || "");
      if (!/^\d{15,25}$/.test(channelId)) { send(res, 400, { error: "channelId must be a Discord voice channel id." }); return true; }
      const guild = client.guilds.cache.get(guildId);
      if (!guild) { send(res, 404, { error: "This bot is not in that server." }); return true; }
      // Claim the common Discord/HTTP slot before the asynchronous channel lookup.
      const opId=operationId(body.operationId);
      const reservation=reserveStart(sessions,guildId);reservation.operationId=opId;
      const operation=newOperation(guildId,opId,reservation.sessionId);
      try {
        const s2=await completeStart(sessions,guildId,reservation,async()=>{
          let channel;try{channel=await guild.channels.fetch(channelId);}catch{}
          if(!channel || channel.type!==ChannelType.GuildVoice){const e=Error('That channel is not a voice channel in this server.');e.status=400;throw e;}
          await preflight({guild,channel,count,config,client,operation});
          const session=new Session(guild,channel,body.dedicatedCallerId?String(body.dedicatedCallerId):null,count);session.operation=operation;session.operationId=opId;return session;
        });
        // Optional display renames must not hold session activation or resurrect a stopped session.
        const names=Array.isArray(body.partyNames)?body.partyNames:[];
        for(let i=1;i<s2.channels.length;i++)if(names[i-1])s2.channels[i].setName(String(names[i-1]).slice(0,80)).catch(e=>console.warn('[api] party rename failed:',e.message));
        lastchannel.remember(guildId,s2.commandVoice);
        send(res,200,sessionStatus(s2,client));
      }catch(e){operation.event('start.failed',{error:e,status:'failed'});send(res,e.status || 502,{error:e.message || 'Could not start Shotcaller.',operationId:opId});}
      return true;
    }

    if (!s && sub !== "/stop") { send(res, 409, { error: "No active Shotcaller session for this guild." }); return true; }
    if(s?.lifecycle && sub!=="/stop"){send(res,409,{error:"Session is starting or stopping."});return true;}

    if (sub === "/stop" && req.method === "POST") {
      const body=await readJsonBody(req);
      if(!s && sessions.has(guildId)){const e=Error('This session changed. Refresh before stopping it.');e.status=409;throw e;}
      send(res,200,stopSession(sessions,guildId,body.sessionId || idOf(s))); 
      return true;
    }

    if ((sub === "/pause" || sub === "/main-wait") && req.method === "POST") {
      const body=await readJsonBody(req);
      if(sessions.get(guildId)!==s || s.lifecycle || body.sessionId!==idOf(s)){send(res,409,{error:"Session changed. Refresh and try again."});return true;}
      if(sub==="/pause") {if(typeof body.paused!=="boolean"){send(res,400,{error:"paused must be a boolean."});return true;}s.setPaused(body.paused);}
      else s.mainCaller.wait(body.absenceId);
      send(res,200,sessionStatus(s,client));return true;
    }

    if (sub === "/mute" && req.method === "POST") {
      const body = await readJsonBody(req);
      if(sessions.get(guildId)!==s || s.lifecycle){const e=Error('Session changed during this request.');e.status=409;throw e;}
      s.muted = typeof body.muted === "boolean" ? body.muted : !s.muted;
      if (s.muted) s.audio.stop();
      await s.panelMessage?.edit(s.panel()).catch(() => {});
      send(res, 200, { muted: s.muted });
      return true;
    }

    if (sub === "/dedicated" && req.method === "POST") {
      const body = await readJsonBody(req);
      if(sessions.get(guildId)!==s || s.lifecycle){const e=Error('Session changed during this request.');e.status=409;throw e;}
      if (!Array.isArray(body.userIds)) { send(res, 400, { error: "userIds must be an array of Discord user ids." }); return true; }
      const ids=[...new Set(body.userIds.map(String))];
      if(ids.length>1 || ids.some(id=>!/^\d{15,25}$/.test(id))){send(res,400,{error:"Choose zero or one main caller."});return true;}
      if(body.sessionId && body.sessionId!==idOf(s)){send(res,409,{error:"Session changed."});return true;}
      if(body.absenceId && (body.absenceId!==s.mainCaller?.snapshot().absenceId || !s.mainCaller?.snapshot().showReplacement)){send(res,409,{error:"Main caller availability changed."});return true;}
      s.setDedicated(ids);
      s.audio.stopBroadcast(); // same as the dedicated_select menu handler: cut any in-flight broadcast, the new set takes over from the next speech
      await s.panelMessage?.edit(s.panel()).catch(() => {});
      send(res, 200, { dedicated: [...s.dedicated] });
      return true;
    }

    if (sub === "/additional-callers" && req.method === "POST") {
      const body = await readJsonBody(req);
      if(sessions.get(guildId)!==s || s.lifecycle){const e=Error('Session changed during this request.');e.status=409;throw e;}
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
    send(res, e.status || 500, { error: e.message || "Internal error" });
    return true;
  }
}

module.exports = { handleApi };

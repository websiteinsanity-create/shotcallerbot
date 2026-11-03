'use strict';
// Loading, validation and migration of data/runtime.json.
//
// Root cause this module addresses: the very first Shotcaller generation (src/state.js + voice/sessionManager.js,
// September 2026) wrote data/runtime.json every 30 s as a bare map { "<guildId>": { mode, partyCount,
// partyChannelIds, muted, dedicatedCaller, textChannelId, startedAt } } - no "version", no "sessions" key.
// Versions 2.x-4.4.1 never read or wrote that file, so it stayed untouched on the persistent volume. 4.5.x
// reuses the same file name for its own schema (version 1) and therefore rejected the leftover at startup.
//
// Rules:
//  - Missing file            -> fresh state, nothing written.
//  - Current schema (v1)     -> loaded; individually invalid entries are dropped, everything valid is kept.
//  - Legacy map (v0)         -> migrated to v1. The original file is copied byte-for-byte to a backup first and
//                               its content is also embedded under `legacy`. Legacy sessions are NOT restarted:
//                               they describe a different implementation and no version since 2.x restored them.
//  - Unreadable JSON/unknown -> original renamed to a .corrupt-<time> file (never deleted), fresh state used, loud
//                               log entry. Shotcaller keeps working; only automatic session restore is lost.
//  - I/O errors (permissions, file is a directory, ...) -> startup is refused: nothing can be preserved safely.
const fs = require('node:fs');
const path = require('node:path');

const CURRENT_VERSION = 1;
const id = (v) => typeof v === 'string' && /^\d{15,25}$/.test(v);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const LEGACY_FIELDS = ['mode', 'partyCount', 'partyChannelIds', 'muted', 'dedicatedCaller', 'textChannelId', 'startedAt'];
const stamp = (now) => new Date(now()).toISOString().replace(/[:.]/g, '-');

function fresh() { return { version: CURRENT_VERSION, sessions: {}, bridge: {} }; }

function isLegacy(data) {
  if (!object(data) || 'version' in data || 'sessions' in data || 'bridge' in data) return false;
  return Object.entries(data).every(([key, value]) => id(key) && object(value) && Object.keys(value).some((k) => LEGACY_FIELDS.includes(k)));
}

// Structural check only: a stale channel id is handled later by the normal restore retry, so it is kept here.
const str = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
function validSession(s) {
  return object(s) && str(s.channelId) && Number.isInteger(s.count) && s.count >= 1 && s.count <= 12 &&
    (s.callerId == null || str(s.callerId)) &&
    (s.additionalCallers === undefined || (Array.isArray(s.additionalCallers) && s.additionalCallers.every(str))) &&
    (s.channels === undefined || (Array.isArray(s.channels) && s.channels.every((c) => object(c) && str(c.id))));
}

// Keeps every valid Bridge field; an invalid field is dropped on its own instead of discarding the whole object.
function cleanBridge(b, notes) {
  if (b === undefined) return {};
  if (!object(b)) { notes.push('bridge settings were not an object and were reset'); return {}; }
  const out = {};
  for (const [key, value] of Object.entries(b)) {
    let ok = true;
    if (key === 'desired' || key === 'paused' || key === 'allowAllianceManage') ok = typeof value === 'boolean';
    else if (key === 'bufferMs') ok = [20, 40, 60, 80, 100].includes(value);
    else if (key === 'id') ok = typeof value === 'string' && value.length <= 80;
    else if (key === 'mainEnabled') ok = object(value) && Object.entries(value).every(([k, v]) => id(k) && typeof v === 'boolean');
    else if (key === 'originalMains') ok = object(value) && Object.entries(value).every(([k, v]) => id(k) && Array.isArray(v) && v.length <= 1 && v.every(id));
    if (ok) out[key] = value; else notes.push(`bridge.${key} was invalid and was dropped`);
  }
  return out;
}

// Classifies parsed JSON without touching the disk. Returns {kind, state, notes}.
function classify(data, now = Date.now) {
  const notes = [];
  if (isLegacy(data)) {
    const state = fresh();
    state.legacy = { format: 'v0-session-metadata', migratedAt: new Date(now()).toISOString(), sessions: data };
    notes.push(`migrated legacy runtime data (${Object.keys(data).length} old session entr${Object.keys(data).length === 1 ? 'y' : 'ies'} kept under "legacy", not restarted)`);
    return { kind: 'legacy', state, notes };
  }
  if (object(data) && data.version === CURRENT_VERSION) {
    if (data.sessions !== undefined && !object(data.sessions)) return { kind: 'corrupt', state: fresh(), notes: ['"sessions" is not an object'] };
    const sessions = {};
    for (const [guild, s] of Object.entries(data.sessions || {})) {
      if (id(guild) && validSession(s)) sessions[guild] = s; else notes.push(`saved session ${String(guild).slice(0, 25)} was invalid and was dropped`);
    }
    const state = { ...data, version: CURRENT_VERSION, sessions, bridge: cleanBridge(data.bridge, notes) };
    return { kind: notes.length ? 'repaired' : 'current', state, notes };
  }
  if (object(data) && Number.isInteger(data.version) && data.version > CURRENT_VERSION) return { kind: 'corrupt', state: fresh(), notes: [`runtime.json was written by a newer Shotcaller (schema ${data.version})`] };
  return { kind: 'corrupt', state: fresh(), notes: ['runtime.json has an unrecognised format'] };
}

function writeAtomic(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function uniqueName(file, suffix, now) {
  let name = `${file}.${suffix}-${stamp(now)}`, n = 1;
  while (fs.existsSync(name)) name = `${file}.${suffix}-${stamp(now)}-${n++}`;
  return name;
}

// Loads (and if needed migrates/quarantines) the runtime file. Never deletes data.
function loadRuntimeState(file, { now = Date.now, log = console } = {}) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: fresh(), kind: 'missing', notes: [] };
    throw Error(`Cannot read runtime state ${file}: ${error.code || error.message}. Check the data volume permissions.`);
  }
  let data, parseError = null;
  try { data = JSON.parse(raw); } catch (error) { parseError = error; }
  const result = parseError ? { kind: 'corrupt', state: fresh(), notes: ['runtime.json is not valid JSON: ' + parseError.message] } : classify(data, now);

  if (result.kind === 'current') return { ...result, file };
  if (result.kind === 'corrupt') {
    const quarantine = uniqueName(file, 'corrupt', now);
    fs.renameSync(file, quarantine); // original bytes kept under a new name; a later write cannot overwrite them
    log.error(`[runtime] ${result.notes.join('; ')}. The file was preserved as ${path.basename(quarantine)}. Shotcaller starts without automatic session restore.`);
    return { ...result, file, preservedAs: quarantine };
  }
  // legacy or repaired: copy the original first, then replace atomically.
  const backup = uniqueName(file, result.kind === 'legacy' ? 'legacy' : 'before-repair', now);
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  if (result.kind === 'legacy') result.state.legacy.backupFile = path.basename(backup);
  writeAtomic(file, result.state);
  log.warn(`[runtime] ${result.notes.join('; ')}. Original preserved as ${path.basename(backup)}.`);
  return { ...result, file, preservedAs: backup };
}

module.exports = { loadRuntimeState, classify, writeAtomic, CURRENT_VERSION };

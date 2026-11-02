'use strict';
// Read-only pre-update check. Never imports the bot, never connects to Discord, never writes, moves or deletes files.
// It uses the same classifier the bot uses at startup (src/runtime-state.js), so the report matches what will happen.
const fs = require('node:fs'), path = require('node:path');
const { classify } = require('../src/runtime-state');
const discordId = (value) => typeof value === 'string' && /^\d{15,25}$/.test(value);

function checkUpgrade({ dataDir = './data', insanityGuildId = '', allianceGuildId = '' } = {}) {
  const file = path.resolve(dataDir, 'runtime.json'), errors = [], warnings = [];
  if (!!insanityGuildId !== !!allianceGuildId || (insanityGuildId && (!discordId(insanityGuildId) || !discordId(allianceGuildId) || insanityGuildId === allianceGuildId)))
    errors.push('INSANITY_GUILD_ID and ALLIANCE_GUILD_ID must both be absent or contain two distinct Discord server IDs. The bot refuses to start otherwise.');
  if (!insanityGuildId && !allianceGuildId) warnings.push('Bridge is disabled because neither server ID is configured.');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return { ok: errors.length === 0, file, exists: false, format: 'missing', errors, warnings };
    errors.push(`runtime.json cannot be read (${error.code || error.message}). Fix the volume permissions; the bot refuses to start otherwise.`);
    return { ok: false, file, exists: true, format: 'unreadable', errors, warnings };
  }
  let result;
  try { result = classify(JSON.parse(raw)); } catch { result = { kind: 'corrupt', state: null, notes: ['runtime.json is not valid JSON'] }; }
  if (result.kind === 'legacy') warnings.push('runtime.json comes from the first Shotcaller generation. It will be migrated at startup; the original is copied to runtime.json.legacy-<time> first. Old sessions are not restarted.');
  if (result.kind === 'repaired') warnings.push('Some saved entries are invalid and will be dropped at startup (' + result.notes.join('; ') + '). The original is copied to runtime.json.before-repair-<time> first.');
  if (result.kind === 'corrupt') warnings.push(result.notes.join('; ') + '. At startup the file is renamed to runtime.json.corrupt-<time> (kept, not deleted) and the bot starts without automatic session restore.');
  if (result.state && Object.keys(result.state.sessions).length) warnings.push('Previously active sessions will be restored automatically, with new session IDs. Existing attendance runs can become incomplete.');
  if (result.state?.bridge?.desired) warnings.push('The saved Alliance Bridge request will reconnect after both sessions are ready. Swipe will be reset.');
  return { ok: errors.length === 0, file, exists: true, format: result.kind, errors, warnings };
}

if (require.main === module) {
  // Read only .env defaults; never import the bot or connect to Discord.
  const env = {};
  try { for (const line of fs.readFileSync('.env', 'utf8').split(/\r?\n/)) { const m = /^\s*(DATA_DIR|INSANITY_GUILD_ID|ALLIANCE_GUILD_ID)\s*=\s*(.*?)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2'); } }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = checkUpgrade({ dataDir: process.argv[2] || process.env.DATA_DIR || env.DATA_DIR || './data', insanityGuildId: process.env.INSANITY_GUILD_ID ?? env.INSANITY_GUILD_ID ?? '', allianceGuildId: process.env.ALLIANCE_GUILD_ID ?? env.ALLIANCE_GUILD_ID ?? '' });
  console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
}
module.exports = { checkUpgrade };

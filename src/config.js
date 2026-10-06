require("dotenv").config();
const list = v => (v || "").split(",").map(x => x.trim()).filter(Boolean);
const bridgePartners = new Map();
for (const item of list(process.env.BRIDGE_PARTNERS)) {
  const [a,b] = item.split("=").map(x => x.trim());
  if (a && b) bridgePartners.set(a,b);
}
module.exports = {
  mainToken: process.env.MAIN_BOT_TOKEN,
  clientId: process.env.CLIENT_ID,
  relayTokens: list(process.env.RELAY_BOT_TOKENS),
  devGuildId: process.env.DEV_GUILD_ID || "",
  shotcallerRoleName: process.env.SHOTCALLER_ROLE_NAME || "Shotcaller",
  officerRoleName: process.env.OFFICER_ROLE_NAME || "Officer",
  leaderRoleName: process.env.LEADER_ROLE_NAME || "Leader",
  partyCategoryName: process.env.PARTY_CATEGORY_NAME || "Shotcaller Parties",
  // Anyone holding this role can make callouts to every party, automatically — no picking people each game.
  // "inplace" (default): party channels are created in the same category as the shotcaller's own channel, with the
  // same permissions. "category": the old behaviour — a separate "Shotcaller Parties" category.
  partyPlacement: (process.env.PARTY_PLACEMENT || "inplace").toLowerCase() === "category" ? "category" : "inplace",
  // Where the bot keeps its small list of the channels it created (so leftovers can be found after a restart).
  dataDir: process.env.DATA_DIR || "./data",
  // Where the Shotcaller category sits in the channel list (0 = very top). Leave unset to put it wherever you
  // dragged it — the bot reuses the same category every game, so a manual drag sticks.
  partyCategoryPosition: (() => { const r = process.env.PARTY_CATEGORY_POSITION; return r !== undefined && r.trim() !== "" && Number.isInteger(Number(r)) && Number(r) >= 0 ? Number(r) : null; })(),
  additionalCallerRoleName: process.env.ADDITIONAL_CALLER_ROLE_NAME || "Shotcaller-People",
  bridgePartners,
  port: Number(process.env.PORT || 8787),
  // How long a speaker must be silent before their relayed stream is ended.
  whisperSilenceMs: Number(process.env.WHISPER_SILENCE_MS || 700),
  // How long a single additional-caller callout stays open (button press, or a held priority key)
  // before closing itself, so a callout can never turn into a continuous open line.
  calloutAutoOffMs: Number(process.env.CALLOUT_AUTO_OFF_MS || process.env.WHISPER_AUTO_OFF_MS || 20000)
};

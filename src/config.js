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
  bridgePartners,
  port: Number(process.env.PORT || 8787),
  // How long a speaker must be silent before their relayed stream is ended.
  whisperSilenceMs: Number(process.env.WHISPER_SILENCE_MS || 700),
  // How long a single additional-caller callout stays open (button press, or a held priority key)
  // before closing itself, so a callout can never turn into a continuous open line.
  calloutAutoOffMs: Number(process.env.CALLOUT_AUTO_OFF_MS || process.env.WHISPER_AUTO_OFF_MS || 20000)
};

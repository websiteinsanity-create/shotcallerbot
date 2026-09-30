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
  whisperRoleName: process.env.WHISPER_ROLE_NAME || "Whisper",
  partyCategoryName: process.env.PARTY_CATEGORY_NAME || "Shotcaller Parties",
  bridgePartners,
  port: Number(process.env.PORT || 8787),
  whisperSilenceMs: Number(process.env.WHISPER_SILENCE_MS || 700)
};

// Checks every configured bot token against Discord and says which ones are valid.
// Never prints a token (only its length, to help spot a cut-off copy-paste).
// Run:  node check-tokens.js          (inside the container, or anywhere the same env vars are set)
require("dotenv").config();

const list = v => (v || "").split(",").map(x => x.trim()).filter(Boolean);
const main = (process.env.MAIN_BOT_TOKEN || "").trim();
const relays = list(process.env.RELAY_BOT_TOKENS);

async function check(label, token) {
  if (!token) return console.log(`${label}: MISSING`);
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bot ${token}` } });
    if (res.status === 200) {
      const u = await res.json();
      console.log(`${label}: OK      -> "${u.username}" (token length ${token.length})`);
    } else if (res.status === 401) {
      console.log(`${label}: INVALID -> Discord rejected it (token length ${token.length}). Reset it in the Developer Portal and paste the new one.`);
    } else {
      console.log(`${label}: unexpected response ${res.status}`);
    }
  } catch (e) {
    console.log(`${label}: could not reach Discord (${e.message})`);
  }
}

(async () => {
  console.log(`Found ${relays.length} relay token(s). You need one per party, including your own.\n`);
  await check("main   ", main);
  for (let i = 0; i < relays.length; i++) {
    const dup = relays.findIndex(t => t === relays[i]);
    await check(`relay ${String(i + 1).padStart(2)}`, relays[i]);
    if (dup !== i) console.log(`         ^ DUPLICATE of relay ${dup + 1} — two slots hold the same token`);
  }
  if (main && relays.includes(main)) console.log("\nWARNING: the main bot token is also in the relay list.");
})();

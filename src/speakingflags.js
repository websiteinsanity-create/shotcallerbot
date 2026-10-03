// Diagnostic probe — logging only, never throws, never changes behaviour.
//
// Discord's voice gateway tells every connected client (bots included) a "speaking" bitmask for each
// user: 1 = normal microphone, 4 = priority speaker (so 5 = voice + priority). We want to know whether
// a player holding Discord's "Push to Talk (Priority)" keybind shows up as a different value from
// normal talking, because that would give us a held, in-game keybind without any extra software.
//
// @discordjs/voice does not surface these flags, so we listen to the raw voice websocket packets.
// That relies on library internals, which is why this is a probe first and not a feature.

function watchSpeakingFlags(connection, label, onFlags) {
  const attach = (ws) => {
    if (!ws || ws.__flagsWatched) return;
    ws.__flagsWatched = true;
    ws.on("packet", (p) => {
      try {
        if (p && p.op === 5 && p.d) {
          const flags = Number(p.d.speaking);
          console.log(`[flags] ${label} user=${p.d.user_id} speaking=${flags}${flags & 4 ? "  <-- PRIORITY" : ""}`);
          if (onFlags) onFlags(p.d.user_id, flags);
        }
      } catch {}
    });
  };

  try {
    const hook = (networking) => {
      if (!networking || networking.__flagsHooked) return;
      networking.__flagsHooked = true;
      attach(networking.state && networking.state.ws);
      // The websocket is replaced when the connection renegotiates, so re-attach on every state change.
      networking.on("stateChange", (_old, next) => attach(next && next.ws));
    };
    hook(connection.state && connection.state.networking);
    connection.on("stateChange", (_old, next) => hook(next && next.networking));
  } catch (e) {
    console.error("[flags] could not attach probe:", e.message);
  }
}

module.exports = { watchSpeakingFlags };

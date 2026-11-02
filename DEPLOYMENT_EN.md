# GuildHub 1.43.24 + Shotcaller 4.4.1 — update guide

These are source packages for the existing home-server Docker / Portainer deployment. Update both applications. No new service, database, bot token or environment variable is required.

## Install with your server administrator

1. Finish the current event's attendance tracking. Stop the Shotcaller session.
2. Back up GuildHub's persistent data and both current application source folders/images. Keep your existing stack configuration and environment secrets.
3. Extract the GuildHub package into its application source folder and the Shotcaller package into the bot's source folder. Do not overwrite the server's `.env` files or persistent data volumes with example files.
4. Rebuild both Docker images from the updated source. A container restart by itself does not rebuild an image. If your Portainer stack references prebuilt images, the administrator must build/push updated images and change the stack's image references before redeploying.
5. Redeploy/recreate both containers with the existing networks, volume mounts and environment values. The bot Dockerfile now uses Node 22 and a lockfile. Its Voice dependency requires Node 22.12 or newer. Native Opus is built/installed in the image; do not copy local `node_modules` into it.
6. Confirm GuildHub reports **1.43.24** in Admin/Diagnostics. Check the bot startup log/package version reports **4.4.1**.
7. Open Shotcaller → System status. Confirm the Control API responds and 12 relay tokens are configured.
8. Start a small test session first; then run the checklist below before using it for a full event.

## Permissions

- Every relay needs View Channel, Connect and Speak in its party channel.
- The main bot needs access to the selected anchor channel and channel-management permissions for creating/retiring party channels.
- To follow the main caller outside managed channels, the main bot needs View Channel, Connect and Speak there too. Missing access triggers unavailable/fallback behaviour; the bot does not bypass permissions.
- PTT-Prio / Callout requires the configured additional-caller role or manual extra-caller assignment. Ordinary PTT does not open a callout.

## What changes

- Before a combined Discord post/start, a read-only preflight verifies count, distinct bot identities, token access, guild membership and planned voice permissions. Failure blocks the Discord post. The checks are repeated before real startup; permission/network changes after preflight can still fail the start.
- A maximum of 12 party voice channels is started, including Party 1. Extra real parties remain in the event and show **No Shotcaller channel** against the last setup. A stable party key keeps this coverage attached during renames/reordering. This is setup coverage, not a claim the channel still exists after the session stops. Placeholder parties after the anchor are skipped. Party leaders are optional for starting/tracking.
- One main caller can be selected. Relays handle input and output, including Relay 1. The main bot normally stays out of voice.
- The main caller's ordinary speech is routed to all other managed parties.
- Authorised PTT-Prio / Callout goes only to the available main caller's channel. If there is no selected or reachable main caller, it goes to all other managed party channels. The source channel is excluded.
- The main bot follows a selected main caller into accessible ordinary voice channels in the same Discord server. It leaves when a managed relay takes over. People in the followed channel can hear incoming callouts.
- Simultaneous routed speakers are mixed rather than replacing each other's player. A failed relay immediately stops its player and clears its output queues. Healthy outputs continue. Recovery waits for Ready and adds fresh frames only; late input from replaced/disconnected receivers is ignored.
- Each failed party is marked **Connection issue** on the Shotcaller page. A degraded active session remains distinct from Inactive, Starting, Stopping and an unavailable control API.
- Start, preflight, Discord post and relay events share an operation ID. Structured logs include relay/channel, attempt, elapsed time, status and sanitised original errors. Recent logs are visible under System status; full logs remain in the containers.
- Pause stops routed speech, callout windows, following and absence prompts. Existing voice connections remain. Attendance tracking stays independent and may continue or start while paused. Resume follows current positions; old queued audio is discarded. Stop remains available.
- Only a session started with a main caller enables the absence prompt. After 30 seconds of continuous unavailability, authorised officers on the Shotcaller page see **Main shotcaller unavailable** with **Set replacement** and **Wait**. Display is picked up by the normal page polling cycle. Wait suppresses this absence episode; returning closes it. A replacement remains main caller if the original returns.
- Extra-channel presence lookups are bounded. Unavailable/malformed reads retry, then finish as incomplete; they do not manufacture no-shows. Diagnostics shows the last attempt and failure. A disconnected main gateway is also treated as unknown presence.
- Dashboard and Shotcaller use one persisted per-officer session setup and the same form. Without saved choices, the voice channel and party mode require explicit selection; eight parties is not silently chosen. Failed status reads show unavailable.

## Live verification checklist

Use a second human listener; ready connections and routing counters do not prove audible delivery.

1. Start without a main caller. From Party 8, normal speech must remain local. Authorised PTT-Prio / Callout must be heard in the other parties, without echo in Party 8.
2. Select one main caller in Party 1. Repeat Party 8 PTT-Prio: it must be heard only in Party 1. Verify the main caller's ordinary speech reaches the other parties.
3. Move the main caller to an external accessible voice channel, then back to a managed party. Confirm the main bot follows/leaves and no duplicate speech is heard.
4. Disconnect the main caller. Callouts must fall back immediately when unavailability is observed. After 30 seconds plus page-polling delay, test Wait, return, and replacement. A session started without a main caller must not show this prompt.
5. Use two authorised extra callers simultaneously. Have the main caller confirm both are audible.
6. Pause during a call. Routed speech must stop; local conversation must still work. Move the main caller, then resume. Only current speech/positions should be used. Stop during pause must disconnect/clean up normally.
7. Run a 30-second attendance track with the configured mute/deafened exclusions. Repeat with a valid extra channel containing a known test player. Confirm raw sightings, credited attendance and event totals separately.
8. Test an inaccessible/deleted extra channel. Diagnostics must show the failure and the run must become incomplete instead of hanging or marking unknown players absent.
9. Complete a second event's track on the same Shotcaller session. Verify the first event's results remain unchanged.

## Troubleshooting and rollback

System status shows received priority flags and recent routing targets. These are observations, not an end-to-end latency measurement. If PTT-Prio produces no priority flag, capture bot `[flags]` logs during the keypress; the Discord button provides a separate test path.

The historical extra-channel failure and bot crash have not been root-caused from production logs. New structured logs make future failures traceable by operation ID; they do not establish an old crash cause. If a crash recurs, retain Portainer/Docker logs around it, container ExitCode, OOMKilled, restart count and timestamps. Do not paste tokens or environment secrets.

To roll back, stop the session and restore both previous images/source versions and the existing data backup if needed. This patch adds fields to tracking records and changes no database schema or historical attendance automatically. Active pre-update legacy tracks may finish incomplete and need a fresh track.

Bridge transport remains unavailable in this release; no alliance audio bridge is claimed or enabled.

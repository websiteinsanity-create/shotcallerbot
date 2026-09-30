# Shotcaller — Final Release

Self-hosted Discord Shotcaller with party relays, whisper routing, music playback and cross-guild bridge controls.

---

## Features

| Feature | Detail |
|---|---|
| `/shotcaller start` | Slash command to launch a session |
| GvG mode | 8 party channels |
| Full Guild mode | 12 party channels |
| Custom mode | 1–12 party channels |
| Auto channel management | Creates and deletes party channels |
| Main voice broadcast | Shotcaller audio pushed to all parties |
| Mute / unmute | Per-session controls |
| Dedicated caller | Assign a single voice source |
| Auto speaker selection | Picks the current loudest caller |
| Whisper routing | Party 1: everyone; Parties 2–12: one whisperer each |
| Whisper back-routing | Whisper audio flows back to the Shotcaller |
| Whisper setup panel | Discord UI panel for config |
| Music library | Local file playback via FFmpeg |
| Loop playback | Continuous looping |
| Music controls | Stop / restart |
| Bridge | Request / accept / live-side across guilds |
| Relay reconnection | Auto-reconnect on drop |
| Health endpoint | `GET /health` on `PORT` (default 8787) |

---

## Prerequisites

1. **Main bot** — one Discord application + token (the Shotcaller bot).
2. **Relay bots** — up to 12 Discord applications + tokens (one per party).
3. All bots invited to your guild with `bot` + `applications.commands` scope and the permissions listed below.
4. A VPS, home server, or Docker host that stays online during events.

### Required bot permissions
```
CONNECT, SPEAK, MUTE_MEMBERS, MOVE_MEMBERS,
MANAGE_CHANNELS, MANAGE_ROLES,
SEND_MESSAGES, EMBED_LINKS, READ_MESSAGE_HISTORY,
USE_APPLICATION_COMMANDS
```

---

## Repository layout

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example          ← copy to .env and fill in tokens
├── .gitignore
├── README.md
├── src/
│   └── index.js          ← application entry point
└── data/
    ├── runtime.json      ← auto-created, gitignored
    └── music/            ← drop .mp3/.wav/.ogg here
```

---

## Deploy with Docker Compose (recommended)

### 1 — Clone the repo on your server

```bash
git clone https://github.com/<you>/shotcaller.git
cd shotcaller
```

### 2 — Configure environment

```bash
cp .env.example .env
nano .env          # fill in MAIN_BOT_TOKEN, CLIENT_ID, RELAY_BOT_TOKENS
```

### 3 — Build and start

```bash
docker compose up -d --build
```

### 4 — Check logs

```bash
docker compose logs -f
```

### 5 — Health check

```bash
curl http://localhost:8787/health
```

---

## Deploy via Portainer

1. Push your repo to GitHub (`.env` is gitignored — set variables in Portainer instead).
2. In Portainer → **Stacks** → **Add stack** → **Repository**.
3. Set **Repository URL** to your GitHub repo and **Compose path** to `docker-compose.yml`.
4. Under **Environment variables** add every key from `.env.example` with the real values.
5. Click **Deploy the stack**.
6. Portainer will pull, build and start the container automatically.

> **Tip:** Use Portainer's **Update the stack** button to redeploy after pushing new commits.

---

## Add music files

Copy audio files into `data/music/` on the host — they are mounted into the container at `/app/data/music/`.  
Supported formats: `.mp3`, `.wav`, `.ogg`.

```bash
scp track.mp3 user@yourserver:/path/to/shotcaller/data/music/
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MAIN_BOT_TOKEN` | ✅ | — | Main Discord bot token |
| `CLIENT_ID` | ✅ | — | Main bot application ID |
| `RELAY_BOT_TOKENS` | ✅ | — | Comma-separated relay tokens (max 12) |
| `DEV_GUILD_ID` | — | — | Guild ID for instant dev slash commands |
| `SHOTCALLER_ROLE_NAME` | — | `Shotcaller` | Role the main bot looks up |
| `OFFICER_ROLE_NAME` | — | `Officer` | Role allowed to start sessions |
| `LEADER_ROLE_NAME` | — | `Leader` | Role with full control |
| `WHISPER_ROLE_NAME` | — | `Whisper` | Role assigned to whisperers |
| `PARTY_CATEGORY_NAME` | — | `Shotcaller Parties` | Category for party channels |
| `BRIDGE_PARTNERS` | — | — | Cross-guild mapping (see `.env.example`) |
| `PORT` | — | `8787` | HTTP health endpoint port |
| `WHISPER_SILENCE_MS` | — | `700` | Silence threshold to close whisper stream |

---

## Notes

- `network_mode: host` is intentional — Discord voice uses dynamic UDP ports that break with Docker NAT.
- Discord does not provide a "one-click install" for self-hosted bots. You must create the applications in the [Discord Developer Portal](https://discord.com/developers/applications) and invite each bot manually.
- Test in a private server before a live GvG event.

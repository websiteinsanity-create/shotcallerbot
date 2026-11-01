# Shotcaller 4.4.1

This package is a self-hosted Discord Shotcaller application.

## Release 4.4.1

Companion GuildHub version: **1.43.24**. Read **DEPLOYMENT_EN.md** before updating both applications.

## Features

- Discord and authenticated GuildHub session controls.
- Up to twelve party relay bots, including Party 1, with voice-ready checks and cleanup.
- One optional main caller; authorised PTT-Prio and time-limited Callout button routing.
- Background main bot, following the main caller into accessible external voice channels when needed.
- Concurrent caller audio mixing, bounded queues, and source-channel echo exclusion.
- Pause/Resume and Mute; attendance remains independent of pause.
- Main-caller unavailable/replacement/wait state shared between GuildHub clients.
- Voice-presence endpoint for extra-channel attendance, explicit unknown/error results and bounded lookups.
- Read-only connection and routing telemetry; Docker deployment and health endpoint.

Bridge transport and music playback are not implemented features of this release. Discord audio delivery and end-to-end latency require live verification.

## What you must provide

1. One main Discord bot application/token.
2. Up to 12 relay Discord bot applications/tokens.
3. A Discord guild where the bots are invited.
4. A PC/VPS/Docker host that stays online while the system is in use.
5. FFmpeg if running directly; Docker includes FFmpeg.

## Important

Discord does not provide a single "install this custom bot" button. You create the Discord applications, invite them to the guild, configure the tokens, then run this software.

Voice receiving/relaying is subject to Discord voice behavior and permissions. Test in a private server before a live event.

## Quick start

Windows:
  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

Linux:
  bash scripts/install-linux.sh

Docker:
  copy .env.example .env
  edit .env
  docker compose up -d --build

Then use:
  /shotcaller start

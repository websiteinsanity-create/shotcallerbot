# Shotcaller — Final Release

This package is a self-hosted Discord Shotcaller application.

## Features

- `/shotcaller start`
- GvG mode: 8 party channels
- Full Guild mode: 12 party channels
- Custom mode: 1–12 party channels
- Automatically creates/deletes party channels
- Main Shotcaller voice broadcast to all parties
- Mute/unmute
- Dedicated caller
- Automatic current-speaker selection
- Party whisper routing:
  - Party 1: everyone may whisper
  - Parties 2–12: one configured whisperer per party
- Whisper routing back to the Shotcaller
- Whisper setup panel
- Party identification in the panel
- Music library
- Looping FFmpeg playback
- Music stop/restart controls
- Bridge request/accept/live-side controls
- Relay bot reconnection
- Docker deployment
- Health endpoint

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

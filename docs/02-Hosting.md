# Hosting

## Recommended VPS

A small Linux VPS is normally sufficient for the control bot and relay processes.

Suggested starting point:
- 2 vCPU
- 4 GB RAM
- 20+ GB SSD
- stable network
- Linux distribution supported by Docker

The actual load depends on how many relay voice connections and music streams are active.

## Windows

A Windows PC can host it during events. It must stay online and connected to the internet.

Install:
- Node.js 20+
- FFmpeg
- the package

Run:
  npm start

## Docker

Install Docker and Docker Compose.

Then:
  cp .env.example .env
  nano .env
  docker compose up -d --build

Logs:
  docker compose logs -f

Stop:
  docker compose down

## Health check

The application exposes:
  http://HOST:8787/

It returns:
  Shotcaller OK

Do not expose bot tokens or .env through a web server.

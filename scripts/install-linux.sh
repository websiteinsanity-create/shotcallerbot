#!/usr/bin/env bash
set -e
echo "=== Shotcaller Installer ==="
command -v node >/dev/null 2>&1 || { echo "Node.js 20+ is required."; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || echo "WARNING: FFmpeg not found. Install it for music."
[ -f .env ] || cp .env.example .env
npm install
node --check src/index.js
echo
echo "Installation complete. Edit .env, then run: npm start"

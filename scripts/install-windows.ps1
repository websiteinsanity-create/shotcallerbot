$ErrorActionPreference = "Stop"
Write-Host "=== Shotcaller Installer ==="
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js 20+ is required. Install it from https://nodejs.org/ and rerun this script."
  exit 1
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host "WARNING: FFmpeg is not installed or not on PATH. Music will not work until FFmpeg is installed."
}
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created .env from .env.example"
}
npm install
node --check src/index.js
Write-Host ""
Write-Host "Installation complete."
Write-Host "Edit .env, then run: npm start"

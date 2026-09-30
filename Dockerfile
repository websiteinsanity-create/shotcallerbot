FROM node:20-bookworm-slim

WORKDIR /app

# Build tools for native addons (opus) + FFmpeg for audio playback
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first (layer cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copy source
COPY . .

# Health endpoint
EXPOSE 8787

CMD ["node", "src/index.js"]

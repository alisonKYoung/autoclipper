FROM node:20-bookworm-slim

# Install ffmpeg + curl (curl needed to fetch yt-dlp binary)
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp as a standalone binary — no Python/pip needed
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp

# Verify both binaries are present and executable before continuing
RUN ffmpeg -version | head -1 && yt-dlp --version

WORKDIR /autoclipper
COPY package*.json ./
RUN npm install
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]

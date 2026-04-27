FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /autoclipper
COPY package*.json ./
RUN npm install
COPY . .
RUN pip install yt-dlp --break-system-packages
EXPOSE 3000
CMD ["node", "server.js"]
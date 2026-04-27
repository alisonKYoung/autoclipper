FROM node:24
WORKDIR /autoclipper
COPY . .
RUN npm install
RUN pip install yt-dlp --break-system-packages
RUN pip install ffmpeg
EXPOSE 3000
CMD ["node", "server.js"]
# 1678 Auto Clipper v2 — with yt-dlp backend

All video downloading and clipping now happens **server-side** via `yt-dlp` + `ffmpeg`.  
No browser extensions, no manual MP4 links needed — just paste a YouTube URL and go.

## Project Structure

```
frc-clipper/
├── public/
│   └── index.html     ← Full frontend (single file)
├── clips/             ← Finished .avi clips are saved here
├── server.js          ← Express backend (yt-dlp + ffmpeg)
├── package.json
├── render.yaml        ← One-click Render deployment config
└── README.md
```

---

## Running Locally

### Requirements
- Node.js 18+
- Python 3 + pip (for yt-dlp)
- ffmpeg installed and on PATH

### Install & run

```bash
# 1. Install Node dependencies
npm install

# 2. Install yt-dlp
pip install yt-dlp

# 3. Start server
node server.js

# Open http://localhost:3000
```

---

## Deploying to Render

### Option A: render.yaml (easiest)
1. Push this folder to a GitHub repo
2. Go to https://render.com → New → Blueprint
3. Connect your repo — Render will auto-detect `render.yaml`
4. Click **Apply** — done

### Option B: Manual Web Service
1. New → **Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Environment**: Node
   - **Build Command**: `npm install && pip install yt-dlp --break-system-packages`
   - **Start Command**: `node server.js`
4. Add a **Disk** (under Advanced):
   - Mount path: `/opt/render/project/src/clips`
   - Size: 5 GB (or however much you need)
5. Deploy

> **Note**: ffmpeg is pre-installed on Render's Node environment. yt-dlp is installed during build.

---

## Workflow

1. Enter **team number** + **field position**
2. Paste a **YouTube match video URL**, click **Fetch from YouTube**
   - The server downloads the video via yt-dlp (progress shown in the UI)
   - Video streams directly into the player
3. Scrub to the **start of auto** using `,` / `.` keys
4. Press `[` → **Set Start**
5. Scrub to when the robot **reaches the centerline**
6. Press `]` → **Set End**
7. Time to centerline is calculated to 4 decimal places automatically
8. Press **Enter** or click **+ Add to Queue**
9. Repeat for other robots/matches
10. Click **⚙ Process** on individual clips, or **⚙ Process & Download All**
    - FFmpeg clips and encodes to AVI server-side
    - Files download automatically when ready

## Clip naming

```
[Team] [TimeToCenterline] [Position].avi
Example: 1678 1.2500 Close Red.avi
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `,` | Prev frame |
| `.` | Next frame |
| `Space` / `K` | Play / Pause |
| `[` | Set Start frame |
| `]` | Set End frame |
| `Enter` | Add to clip queue |

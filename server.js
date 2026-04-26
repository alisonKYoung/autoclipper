const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Required for ffmpeg.wasm fallback (not used server-side but harmless)
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// Temp dir for working files
const WORK_DIR = path.join(os.tmpdir(), 'frc-clipper');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

// Clips output dir
const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

// Track active jobs: jobId -> { status, progress, message, filePath, filename }
const jobs = {};

// ─── Helper: find yt-dlp binary ───────────────────────────────────────────────
function findBinary(name) {
  const candidates = [
    name,
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
    path.join(os.homedir(), '.local/bin', name),
    // Python pip installs
    `/root/.local/bin/${name}`,
  ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return name; // fall back, let PATH handle it
}

const YTDLP = findBinary('yt-dlp');
const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

// ─── GET /api/info — get video metadata + FPS ─────────────────────────────────
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  execFile(YTDLP, [
    '--dump-json',
    '--no-playlist',
    url
  ], { timeout: 30000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: 'yt-dlp failed: ' + err.message });
    try {
      const info = JSON.parse(stdout);
      res.json({
        title: info.title,
        duration: info.duration,
        fps: info.fps || 60,
        thumbnail: info.thumbnail,
        uploader: info.uploader,
        formats: (info.formats || [])
          .filter(f => f.ext === 'mp4' && f.vcodec !== 'none')
          .map(f => ({ format_id: f.format_id, height: f.height, fps: f.fps, tbr: f.tbr }))
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .slice(0, 5),
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// ─── POST /api/download — download video with yt-dlp ─────────────────────────
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const jobId = crypto.randomUUID();
  const outPath = path.join(WORK_DIR, `${jobId}.mp4`);

  jobs[jobId] = { status: 'downloading', progress: 0, message: 'Starting download...', filePath: outPath };
  res.json({ jobId });

  const proc = spawn(YTDLP, [
    '-f', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', outPath,
    url,
  ]);

  proc.stdout.on('data', (data) => {
    const line = data.toString();
    // Parse yt-dlp progress: [download]  45.2% of ...
    const match = line.match(/\[download\]\s+([\d.]+)%/);
    if (match) {
      const pct = parseFloat(match[1]);
      jobs[jobId].progress = Math.round(pct * 0.9); // 0-90% for download
      jobs[jobId].message = `Downloading... ${match[1]}%`;
    }
  });

  proc.stderr.on('data', (data) => {
    const line = data.toString();
    if (line.includes('Merging')) {
      jobs[jobId].progress = 92;
      jobs[jobId].message = 'Merging audio/video...';
    }
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      jobs[jobId].status = 'error';
      jobs[jobId].message = 'Download failed (yt-dlp exit code ' + code + ')';
      return;
    }
    // Check file exists
    if (!fs.existsSync(outPath)) {
      // yt-dlp might have added extension
      jobs[jobId].status = 'error';
      jobs[jobId].message = 'Output file not found after download';
      return;
    }
    jobs[jobId].status = 'ready';
    jobs[jobId].progress = 100;
    jobs[jobId].message = 'Download complete';
  });
});

// ─── GET /api/job/:id — poll job status ──────────────────────────────────────
app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── GET /api/video/:id — stream downloaded video to browser ─────────────────
app.get('/api/video/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'ready') return res.status(404).json({ error: 'Not ready' });

  const filePath = job.filePath;
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing' });

  const stat = fs.statSync(filePath);
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ─── POST /api/clip — clip with ffmpeg server-side ───────────────────────────
app.post('/api/clip', (req, res) => {
  const { jobId, startTime, duration, filename } = req.body;
  if (!jobId || startTime == null || !duration || !filename) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const srcJob = jobs[jobId];
  if (!srcJob || srcJob.status !== 'ready') {
    return res.status(400).json({ error: 'Source video not ready' });
  }

  const clipJobId = crypto.randomUUID();
  const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_');
  const outPath = path.join(CLIPS_DIR, safeFilename);

  jobs[clipJobId] = { status: 'processing', progress: 0, message: 'Starting clip...', filePath: outPath, filename: safeFilename };
  res.json({ jobId: clipJobId });

  const args = [
    '-y',
    '-ss', String(startTime),
    '-i', srcJob.filePath,
    '-t', String(duration),
    '-c:v', 'mpeg4',
    '-q:v', '5',
    '-c:a', 'mp3',
    '-b:a', '128k',
    outPath,
  ];

  const proc = spawn(FFMPEG, args);
  let duration_total = duration;

  proc.stderr.on('data', (data) => {
    const line = data.toString();
    const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (timeMatch) {
      const elapsed = parseInt(timeMatch[1]) * 3600 + parseInt(timeMatch[2]) * 60 + parseFloat(timeMatch[3]);
      const pct = Math.min(99, Math.round((elapsed / duration_total) * 100));
      jobs[clipJobId].progress = pct;
      jobs[clipJobId].message = `Encoding... ${pct}%`;
    }
  });

  proc.on('close', (code) => {
    if (code !== 0 || !fs.existsSync(outPath)) {
      jobs[clipJobId].status = 'error';
      jobs[clipJobId].message = 'FFmpeg failed';
      return;
    }
    jobs[clipJobId].status = 'ready';
    jobs[clipJobId].progress = 100;
    jobs[clipJobId].message = 'Clip ready';
  });
});

// ─── GET /api/clips — list all clips in /clips dir ───────────────────────────
app.get('/api/clips', (req, res) => {
  try {
    const files = fs.readdirSync(CLIPS_DIR)
      .filter(f => f.endsWith('.avi'))
      .map(f => {
        const stat = fs.statSync(path.join(CLIPS_DIR, f));
        return { filename: f, size: stat.size, created: stat.mtimeMs };
      })
      .sort((a, b) => b.created - a.created);
    res.json({ clips: files });
  } catch {
    res.json({ clips: [] });
  }
});

// ─── GET /api/download-clip/:filename — download a finished clip ──────────────
app.get('/api/download-clip/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(CLIPS_DIR, safe);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath, safe);
});

// ─── DELETE /api/clip/:filename — remove a clip ───────────────────────────────
app.delete('/api/clip/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const filePath = path.join(CLIPS_DIR, safe);
  try { fs.unlinkSync(filePath); } catch {}
  res.json({ ok: true });
});

app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🤖 FRC 1678 Auto Clipper running → http://localhost:${PORT}\n`));

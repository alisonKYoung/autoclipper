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

app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const WORK_DIR = path.join(os.tmpdir(), 'frc-clipper');
if (!fs.existsSync(WORK_DIR)) fs.mkdirSync(WORK_DIR, { recursive: true });

const CLIPS_DIR = path.join(__dirname, 'clips');
if (!fs.existsSync(CLIPS_DIR)) fs.mkdirSync(CLIPS_DIR, { recursive: true });

const jobs = {};

// ─── Binary resolution ────────────────────────────────────────────────────────
function findBinary(name) {
  if (name === 'ffmpeg') {
    try {
      const p = require('ffmpeg-static');
      if (p && fs.existsSync(p)) { console.log('ffmpeg: ffmpeg-static →', p); return p; }
    } catch {}
  }

  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        `C:\\ffmpeg\\bin\\${name}.exe`,
        `C:\\Program Files\\ffmpeg\\bin\\${name}.exe`,
        path.join(os.homedir(), 'ffmpeg', 'bin', `${name}.exe`),
        name + '.exe',
        name,
      ]
    : [
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
        path.join(os.homedir(), '.local/bin', name),
        `/root/.local/bin/${name}`,
        name,
      ];

  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); console.log(`${name}: found at ${c}`); return c; } catch {}
  }

  console.warn(`WARNING: ${name} not found — install it or run: npm install ffmpeg-static`);
  return name;
}

function findYtDlp() {
  const isWin = process.platform === 'win32';
  const candidates = isWin
    ? [
        'yt-dlp.exe',
        path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'yt-dlp', 'yt-dlp.exe'),
        path.join(os.homedir(), 'scoop', 'shims', 'yt-dlp.exe'),
        'yt-dlp',
      ]
    : [
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp',
        path.join(os.homedir(), '.local/bin/yt-dlp'),
        '/root/.local/bin/yt-dlp',
        'yt-dlp',
      ];
  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); console.log('yt-dlp: found at', c); return c; } catch {}
  }
  console.log('yt-dlp: using PATH');
  return 'yt-dlp';
}

const YTDLP  = findYtDlp();
const FFMPEG = findBinary('ffmpeg');

// ─── GET /api/check ───────────────────────────────────────────────────────────
app.get('/api/check', (req, res) => {
  const results = { ytdlp: false, ffmpeg: false, ytdlpPath: YTDLP, ffmpegPath: FFMPEG };

  execFile(YTDLP, ['--version'], { timeout: 8000 }, (err, stdout) => {
    results.ytdlp = !err;
    results.ytdlpVersion = stdout?.trim();

    execFile(FFMPEG, ['-version'], { timeout: 8000 }, (err2, stdout2) => {
      results.ffmpeg = !err2;
      results.ffmpegVersion = stdout2?.split('\n')[0]?.trim();
      res.json(results);
    });
  });
});

// ─── GET /api/info ────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  execFile(YTDLP, [
    '--no-check-certificate', '--no-colors', '--dump-json', '--no-playlist', url,
  ], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stdout + stderr).split('\n').filter(l => l.includes('ERROR')).pop() || err.message;
      return res.status(500).json({ error: msg.slice(0, 200) });
    }
    try {
      const info = JSON.parse(stdout);
      res.json({ title: info.title, duration: info.duration, fps: info.fps || 60, uploader: info.uploader });
    } catch {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// ─── POST /api/download ───────────────────────────────────────────────────────
app.post('/api/download', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const jobId   = crypto.randomUUID();
  const jobDir  = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const pathFile    = path.join(jobDir, 'filepath.txt');
  const outTemplate = path.join(jobDir, 'video.%(ext)s');

  jobs[jobId] = { status: 'downloading', progress: 0, message: 'Starting...', filePath: null, log: [] };
  res.json({ jobId });

  const args = [
    '--no-check-certificate', '--no-colors', '--newline', '--no-playlist',
    '-f', 'bestvideo[ext=mp4][height<=360]+bestaudio[ext=m4a]/best[ext=mp4][height<=360]/best[height<=360]/best',
    '--merge-output-format', 'mp4',
    '--print-to-file', 'after_move:filepath', pathFile,
    '-o', outTemplate,
    url,
  ];

  console.log('[download] yt-dlp', args.join(' '));
  const proc = spawn(YTDLP, args);

  function handleLine(line) {
    line = line.trim();
    if (!line) return;
    jobs[jobId].log.push(line);
    const pct = line.match(/\[download\]\s+([\d.]+)%/);
    if (pct) {
      jobs[jobId].progress = Math.min(88, Math.round(parseFloat(pct[1]) * 0.88));
      jobs[jobId].message  = `Downloading... ${pct[1]}%`;
    } else if (line.includes('Merging formats'))   { jobs[jobId].progress = 92; jobs[jobId].message = 'Merging audio/video...'; }
      else if (line.includes('Deleting original')) { jobs[jobId].progress = 97; jobs[jobId].message = 'Finishing up...'; }
  }

  let outBuf = '';
  proc.stdout.on('data', d => { outBuf += d; const lines = outBuf.split('\n'); outBuf = lines.pop(); lines.forEach(handleLine); });
  proc.stdout.on('end',  () => { if (outBuf) handleLine(outBuf); });
  let errBuf = '';
  proc.stderr.on('data', d => { errBuf += d.toString(); });

  proc.on('error', err => {
    jobs[jobId].status  = 'error';
    jobs[jobId].message = `Could not start yt-dlp: ${err.message}. Make sure yt-dlp is installed.`;
  });

  proc.on('close', code => {
    console.log(`[download] exit code=${code}, dir:`, fs.readdirSync(jobDir).join(', ') || '(empty)');

    if (code !== 0) {
      const errLine = (errBuf + jobs[jobId].log.join('\n'))
        .split('\n').filter(l => l.includes('ERROR')).pop() || ('yt-dlp exit ' + code);
      jobs[jobId].status  = 'error';
      jobs[jobId].message = errLine.replace(/^ERROR:\s*/, '').slice(0, 200);
      return;
    }

    let finalPath = null;
    try {
      const txt = fs.readFileSync(pathFile, 'utf8').trim();
      if (txt && fs.existsSync(txt)) { finalPath = txt; console.log('[download] path from sidecar:', txt); }
    } catch {}

    if (!finalPath) {
      const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v']);
      const dirFiles = fs.readdirSync(jobDir);
      const candidates = dirFiles
        .filter(f => VIDEO_EXTS.has(path.extname(f).toLowerCase()) && !f.endsWith('.part'))
        .map(f => { const fp = path.join(jobDir, f); return { fp, size: fs.statSync(fp).size }; })
        .sort((a, b) => b.size - a.size);
      if (candidates.length) { finalPath = candidates[0].fp; console.log('[download] path from glob:', finalPath); }
    }

    if (!finalPath) {
      const dirFiles = fs.readdirSync(jobDir);
      jobs[jobId].status  = 'error';
      jobs[jobId].message = `Download finished but no video file found. Dir: [${dirFiles.join(', ')}]`;
      return;
    }

    jobs[jobId].filePath = finalPath;
    jobs[jobId].status   = 'ready';
    jobs[jobId].progress = 100;
    jobs[jobId].message  = 'Download complete';
  });
});

// ─── GET /api/job/:id ─────────────────────────────────────────────────────────
app.get('/api/job/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const { log, ...safe } = job;
  res.json(safe);
});

app.get('/api/job/:id/log', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ log: job.log || [] });
});

// ─── GET /api/video/:id ───────────────────────────────────────────────────────
app.get('/api/video/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== 'ready' || !job.filePath) return res.status(404).json({ error: 'Not ready' });
  if (!fs.existsSync(job.filePath)) return res.status(404).json({ error: 'File missing on disk' });

  const stat  = fs.statSync(job.filePath);
  const ext   = path.extname(job.filePath).toLowerCase();
  const mime  = { '.webm': 'video/webm', '.mkv': 'video/x-matroska' }[ext] || 'video/mp4';
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(s, 10);
    const end    = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': mime });
    fs.createReadStream(job.filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(job.filePath).pipe(res);
  }
});

// ─── POST /api/clip ───────────────────────────────────────────────────────────
app.post('/api/clip', (req, res) => {
  const { jobId, startTime, duration, filename } = req.body;
  if (!jobId || startTime == null || !duration || !filename) return res.status(400).json({ error: 'Missing fields' });
  const srcJob = jobs[jobId];
  if (!srcJob || srcJob.status !== 'ready' || !srcJob.filePath) return res.status(400).json({ error: 'Source not ready' });
  if (!fs.existsSync(srcJob.filePath)) return res.status(400).json({ error: 'Source file missing' });

  const clipJobId    = crypto.randomUUID();
  const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_');
  const outPath      = path.join(CLIPS_DIR, safeFilename);

  jobs[clipJobId] = { status: 'processing', progress: 0, message: 'Starting...', filePath: outPath, filename: safeFilename };
  res.json({ jobId: clipJobId });

  const proc = spawn(FFMPEG, [
    '-y', '-ss', String(startTime), '-i', srcJob.filePath,
    '-t', String(duration), '-c:v', 'mpeg4', '-q:v', '5',
    '-c:a', 'mp3', '-b:a', '128k', outPath,
  ]);

  proc.on('error', err => {
    jobs[clipJobId].status  = 'error';
    jobs[clipJobId].message = `ffmpeg not found: ${err.message}. Run: npm install ffmpeg-static`;
  });

  proc.stderr.on('data', d => {
    const m = d.toString().match(/time=(\d+):(\d+):(\d+\.\d+)/);
    if (m) {
      const elapsed = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
      jobs[clipJobId].progress = Math.min(99, Math.round(elapsed / duration * 100));
      jobs[clipJobId].message  = `Encoding... ${jobs[clipJobId].progress}%`;
    }
  });

  proc.on('close', code => {
    if (code !== 0 || !fs.existsSync(outPath)) {
      jobs[clipJobId].status  = 'error';
      jobs[clipJobId].message = 'FFmpeg encoding failed (code ' + code + ')';
      return;
    }
    jobs[clipJobId].status = 'ready'; jobs[clipJobId].progress = 100; jobs[clipJobId].message = 'Clip ready';
  });
});

// ─── GET /api/clips ───────────────────────────────────────────────────────────
app.get('/api/clips', (req, res) => {
  try {
    const files = fs.readdirSync(CLIPS_DIR).filter(f => f.endsWith('.avi'))
      .map(f => { const s = fs.statSync(path.join(CLIPS_DIR, f)); return { filename: f, size: s.size, created: s.mtimeMs }; })
      .sort((a, b) => b.created - a.created);
    res.json({ clips: files });
  } catch { res.json({ clips: [] }); }
});

// ─── POST /api/upload-local ───────────────────────────────────────────────────
app.post('/api/upload-local', (req, res) => {
  const jobId  = crypto.randomUUID();
  const jobDir = path.join(WORK_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const origName = req.headers['x-filename'] || 'video.mp4';
  const extMatch = origName.match(/\.[a-zA-Z0-9]+$/);
  const safeExt  = extMatch ? extMatch[0].slice(0, 6) : '.mp4';
  const outPath  = path.join(jobDir, 'video' + safeExt);

  const ws = fs.createWriteStream(outPath);
  req.pipe(ws);

  ws.on('finish', () => {
    jobs[jobId] = { status: 'ready', progress: 100, message: 'Upload complete', filePath: outPath };
    res.json({ jobId });
  });
  ws.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
  req.on('error', err => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
});

// ─── GET /api/stream-clip/:filename ──────────────────────────────────────────
app.get('/api/stream-clip/:filename', (req, res) => {
  const fp = path.join(CLIPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });

  const stat  = fs.statSync(fp);
  const ext   = path.extname(fp).toLowerCase();
  const mime  = { '.avi': 'video/x-msvideo', '.mp4': 'video/mp4', '.webm': 'video/webm' }[ext] || 'video/mp4';
  const range = req.headers.range;

  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(s, 10);
    const end    = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   mime,
    });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
});

app.get('/api/download-clip/:filename', (req, res) => {
  const fp = path.join(CLIPS_DIR, path.basename(req.params.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.download(fp);
});

app.delete('/api/clip/:filename', (req, res) => {
  try { fs.unlinkSync(path.join(CLIPS_DIR, path.basename(req.params.filename))); } catch {}
  res.json({ ok: true });
});

app.get('/compare', (req, res) => res.sendFile(path.join(__dirname, 'public', 'compare.html')));

app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 FRC 1678 Auto Clipper → http://localhost:${PORT}`);
  console.log('Run GET /api/check to verify ffmpeg + yt-dlp are working\n');
});

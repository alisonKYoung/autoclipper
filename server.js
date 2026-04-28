const express = require('express');
const cors = require('cors');
const multer = require('multer');
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

const uploadMiddleware = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, WORK_DIR),
    filename:    (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname)),
  }),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ─── Binary resolution ────────────────────────────────────────────────────────
function findBinary(name) {
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
        `/usr/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/opt/homebrew/bin/${name}`,
        path.join(os.homedir(), '.local/bin', name),
        `/root/.local/bin/${name}`,
        name,
      ];

  for (const c of candidates) {
    try { fs.accessSync(c, fs.constants.X_OK); console.log(`${name}: found at ${c}`); return c; } catch {}
  }

  console.warn(`WARNING: ${name} not found — make sure ffmpeg is installed (apt-get install ffmpeg)`);
  return name; // last resort, let PATH resolve it
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
  // On Windows, .exe may not be needed if it's on PATH
  console.log('yt-dlp: using PATH');
  return 'yt-dlp';
}

const YTDLP  = findYtDlp();
const FFMPEG = findBinary('ffmpeg');

// ─── GET /api/check — verify binaries are working ────────────────────────────
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

    // Strategy 1: read sidecar file yt-dlp wrote with the final path
    let finalPath = null;
    try {
      const txt = fs.readFileSync(pathFile, 'utf8').trim();
      if (txt && fs.existsSync(txt)) { finalPath = txt; console.log('[download] path from sidecar:', txt); }
    } catch {}

    // Strategy 2: glob job dir for largest video file
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

  const clipJobId = crypto.randomUUID();
  const safeBase  = filename.replace(/[/\\?%*:|"<>]/g, '_').replace(/\.[^.]+$/, '');
  const outPath   = path.join(CLIPS_DIR, safeBase + '.mp4');

  jobs[clipJobId] = { status: 'processing', progress: 0, message: 'Starting...', filePath: outPath, filename: safeBase + '.avi' };
  res.json({ jobId: clipJobId });

  const proc = spawn(FFMPEG, [
    '-y', '-ss', String(startTime), '-i', srcJob.filePath,
    '-t', String(duration),
    '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
    '-an',
    '-movflags', '+faststart',
    outPath,
  ]);

  proc.on('error', err => {
    jobs[clipJobId].status  = 'error';
    jobs[clipJobId].message = `ffmpeg not found: ${err.message}. Make sure ffmpeg is installed (apt-get install ffmpeg).`;
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
    const files = fs.readdirSync(CLIPS_DIR).filter(f => /\.mp4$/i.test(f))
      .map(f => { const s = fs.statSync(path.join(CLIPS_DIR, f)); return { filename: f.replace(/\.mp4$/i, '.avi'), size: s.size, created: s.mtimeMs }; })
      .sort((a, b) => b.created - a.created);
    res.json({ clips: files });
  } catch { res.json({ clips: [] }); }
});

// Download as AVI — find the stored MP4, convert to AVI on the fly via ffmpeg pipe
app.get('/api/download-clip/:filename', (req, res) => {
  const base    = path.basename(req.params.filename).replace(/\.[^.]+$/, '');
  const mp4Path = path.join(CLIPS_DIR, base + '.mp4');
  if (!fs.existsSync(mp4Path)) return res.status(404).json({ error: 'Not found' });
  const aviName = base + '.avi';
  res.setHeader('Content-Disposition', `attachment; filename="${aviName}"`);
  res.setHeader('Content-Type', 'video/x-msvideo');
  const proc = spawn(FFMPEG, [
    '-i', mp4Path,
    '-c:v', 'mpeg4', '-q:v', '5',
    '-an',
    '-f', 'avi', 'pipe:1',
  ]);
  proc.stdout.pipe(res);
  proc.stderr.on('data', () => {});
  req.on('close', () => { try { proc.kill(); } catch {} });
});

// Stream for browser playback — serves the stored MP4 directly with range-request support
app.get('/api/stream-clip/:filename', (req, res) => {
  const base = path.basename(req.params.filename).replace(/\.[^.]+$/, '');
  const fp   = path.join(CLIPS_DIR, base + '.mp4');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  const stat  = fs.statSync(fp);
  const range = req.headers.range;
  if (range) {
    const [s, e] = range.replace(/bytes=/, '').split('-');
    const start  = parseInt(s, 10);
    const end    = e ? parseInt(e, 10) : stat.size - 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4' });
    fs.createReadStream(fp, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
    fs.createReadStream(fp).pipe(res);
  }
});

app.delete('/api/clip/:filename', (req, res) => {
  try { fs.unlinkSync(path.join(CLIPS_DIR, path.basename(req.params.filename))); } catch {}
  res.json({ ok: true });
});

// Upload a local video file for compare-page streaming.
// Native browser formats (mp4/webm/mov) are served as-is via /api/video/:id.
// Everything else (avi, mkv, etc.) is converted to MP4 first.
app.post('/api/upload-for-compare', uploadMiddleware.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received' });
  const inPath = req.file.path;
  const ext    = path.extname(req.file.originalname).toLowerCase();
  const id     = crypto.randomUUID();

  const nativeExts = new Set(['.mp4', '.webm', '.ogg', '.mov', '.m4v']);
  if (nativeExts.has(ext)) {
    jobs[id] = { status: 'ready', filePath: inPath, message: 'Ready' };
    return res.json({ streamUrl: '/api/video/' + id });
  }

  const outPath  = path.join(WORK_DIR, id + '.mp4');
  let responded  = false;

  const proc = spawn(FFMPEG, [
    '-y', '-i', inPath,
    '-c:v', 'libx264', '-crf', '23', '-preset', 'fast',
    '-an',
    '-movflags', '+faststart',
    outPath,
  ]);
  proc.stderr.on('data', () => {});

  proc.on('error', err => {
    if (responded) return; responded = true;
    try { fs.unlinkSync(inPath); } catch {}
    res.status(500).json({ error: 'ffmpeg error: ' + err.message });
  });

  proc.on('close', code => {
    if (responded) return; responded = true;
    try { fs.unlinkSync(inPath); } catch {}
    if (code !== 0 || !fs.existsSync(outPath))
      return res.status(500).json({ error: 'Conversion failed (ffmpeg code ' + code + ')' });
    jobs[id] = { status: 'ready', filePath: outPath, message: 'Ready' };
    res.json({ streamUrl: '/api/video/' + id });
  });
});

app.get('/compare', (req, res) => res.sendFile(path.join(__dirname, 'public', 'compare.html')));

app.get('/{*path}', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 30000;
app.listen(PORT, () => {
  console.log(`\n🤖 FRC 1678 Auto Clipper → http://localhost:${PORT}`);
  console.log('Run GET /api/check to verify ffmpeg + yt-dlp are working\n');
});

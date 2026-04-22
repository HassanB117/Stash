const path = require('path');
const fs   = require('fs');
const { execFile, spawn } = require('child_process');

let sharp;
try { sharp = require('sharp'); } catch { console.log('  [thumbs] sharp not installed — image thumbnails disabled'); }

const THUMB_DIR = path.join(__dirname, 'data', 'thumbs');
const SIZE      = 480;   // thumbnail long-edge px
const PREV_W    = 320;   // preview clip width px
const pending   = new Map();
let ffmpegOk    = null;

function checkFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, err => {
      ffmpegOk = !err;
      if (!ffmpegOk) console.log('  [thumbs] ffmpeg not found — video processing disabled');
      resolve(ffmpegOk);
    });
  });
}

function getSafeRelPath(relPath) {
  // Normalize and strip leading ".." and slashes to stay within THUMB_DIR
  return path.normalize(relPath)
    .replace(/^(\.\.[\/\\])+/, '')
    .replace(/^[\\\/]+/, '');
}

function thumbAbsPath(relPath) {
  const safeRel = getSafeRelPath(relPath);
  const p = path.parse(safeRel.replace(/\\/g, '/'));
  return path.join(THUMB_DIR, p.dir, p.name + '.jpg');
}

function previewAbsPath(relPath) {
  const safeRel = getSafeRelPath(relPath);
  const p = path.parse(safeRel.replace(/\\/g, '/'));
  return path.join(THUMB_DIR, p.dir, p.name + '_preview.mp4');
}

// ── Image thumbnail via sharp ─────────────────────────────────────────
async function makeImageThumb(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await sharp(src)
    .resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toFile(dest);
}

// ── Video thumbnail (single frame) ───────────────────────────────────
async function makeVideoThumb(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-ss', '1', '-i', src,
      '-frames:v', '1',
      '-vf', `scale=${SIZE}:-2`,
      '-y', dest,
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, err => {
      if (err) reject(err); else resolve();
    });
  });
}

// ── Video preview clip (2 s, low-res, with terminal progress bar) ─────
function makeVideoPreview(relPath, src, dest) {
  return new Promise(async (resolve, reject) => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });

    const label  = relPath.length > 40 ? '…' + relPath.slice(-39) : relPath.padEnd(40);
    const BAR_W  = 20;
    const DURATION_US = 2_000_000; // 2 seconds in microseconds

    function drawBar(pct) {
      const filled = Math.round(pct / 100 * BAR_W);
      const bar    = '█'.repeat(filled) + '░'.repeat(BAR_W - filled);
      process.stdout.write(`\r  [render] ${label} [${bar}] ${String(pct).padStart(3)}%`);
    }

    drawBar(0);

    const child = spawn('ffmpeg', [
      '-i', src,
      '-t', '2',
      // Scale to PREV_W wide, height divisible by 2, bicubic for better quality
      '-vf', `scale=${PREV_W}:-2:flags=bicubic`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '26',
      // Modern browser compat (main profile allows better compression than baseline)
      '-profile:v', 'main',
      '-pix_fmt', 'yuv420p',
      // No audio
      '-an',
      // Move moov atom to front so browser can play before full download
      '-movflags', '+faststart',
      // Structured progress → child stdout; suppress normal log spam
      '-progress', 'pipe:1',
      '-loglevel', 'error',
      '-y', dest,
    ]);

    let stderrBuf = '';
    child.stderr.on('data', d => { stderrBuf += d.toString(); });

    child.stdout.on('data', data => {
      const text = data.toString();
      // out_time_us=1234567  (microseconds of encoded video so far)
      const m = text.match(/out_time_us=(\d+)/);
      if (m) {
        const pct = Math.min(100, Math.round(parseInt(m[1], 10) / DURATION_US * 100));
        drawBar(pct);
      }
    });

    child.on('error', err => {
      process.stdout.write('\n');
      reject(err);
    });

    child.on('close', code => {
      if (code === 0) {
        let sizeStr = '?';
        try {
          const bytes = fs.statSync(dest).size;
          sizeStr = bytes < 1024 * 1024
            ? (bytes / 1024).toFixed(0) + ' KB'
            : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        } catch {}
        const bar = '█'.repeat(BAR_W);
        process.stdout.write(`\r  [render] ${label} [${bar}] 100% · ${sizeStr}\n`);
        resolve();
      } else {
        process.stdout.write('\n');
        const errMsg = stderrBuf.trim() || `ffmpeg exited with code ${code}`;
        reject(new Error(errMsg));
      }
    });
  });
}

// ── ensureThumb ───────────────────────────────────────────────────────
async function ensureThumb(relPath, fullSrcPath, isVideo) {
  const dest = thumbAbsPath(relPath);
  if (fs.existsSync(dest)) return dest;

  if (pending.has(relPath)) {
    try { await pending.get(relPath); } catch {}
    if (fs.existsSync(dest)) return dest;
    throw new Error('thumbnail generation failed');
  }

  if (isVideo) {
    if (!await checkFfmpeg()) throw new Error('ffmpeg not available');
  } else {
    if (!sharp) throw new Error('sharp not available');
  }

  const work = (isVideo ? makeVideoThumb(fullSrcPath, dest) : makeImageThumb(fullSrcPath, dest))
    .finally(() => pending.delete(relPath));
  pending.set(relPath, work);
  await work;
  return dest;
}

// ── ensurePreview ─────────────────────────────────────────────────────
async function ensurePreview(relPath, fullSrcPath) {
  const dest = previewAbsPath(relPath);
  if (fs.existsSync(dest)) return dest;

  const key = 'preview:' + relPath;
  if (pending.has(key)) {
    try { await pending.get(key); } catch {}
    if (fs.existsSync(dest)) return dest;
    throw new Error('preview generation failed');
  }

  if (!await checkFfmpeg()) throw new Error('ffmpeg not available');

  const work = makeVideoPreview(relPath, fullSrcPath, dest)
    .finally(() => pending.delete(key));
  pending.set(key, work);
  await work;
  return dest;
}

// ── Batch pre-generation ──────────────────────────────────────────────
function pregenerate(capturesMap, sanitizeFn, limit = Infinity) {
  if (limit <= 0) return;
  setImmediate(async () => {
    // Collect work
    const todo = [];
    for (const [, files] of Object.entries(capturesMap)) {
      for (const file of files) {
        if (todo.length >= limit) break;
        const needThumb   = !fs.existsSync(thumbAbsPath(file.path));
        const needPreview = file.type === 'video' && !fs.existsSync(previewAbsPath(file.path));
        if (needThumb || needPreview) todo.push({ file, needThumb, needPreview });
      }
      if (todo.length >= limit) break;
    }

    if (todo.length === 0) return;

    const total = todo.length;
    console.log(`\n  [render] ${total} file(s) to process\n`);

    let done = 0;
    for (const { file, needThumb, needPreview } of todo) {
      const src = sanitizeFn(file.path);
      if (!src) continue;
      try {
        if (needThumb) {
          process.stdout.write(`  [thumb]  ${file.path}\n`);
          await ensureThumb(file.path, src, file.type === 'video');
        }
        if (needPreview) {
          await ensurePreview(file.path, src);
        }
        done++;
      } catch (err) {
        console.error(`  [render] FAILED ${file.path}: ${err.message}`);
      }
    }

    console.log(`\n  [render] complete — ${done}/${total} processed\n`);
  });
}

async function getImageMeta(src) {
  if (!sharp) return null;
  try {
    const info = await sharp(src).metadata();
    return info.width && info.height ? { width: info.width, height: info.height } : null;
  } catch { return null; }
}

module.exports = { thumbAbsPath, previewAbsPath, ensureThumb, ensurePreview, pregenerate, getImageMeta };

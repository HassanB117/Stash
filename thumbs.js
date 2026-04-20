const path = require('path');
const fs   = require('fs');
const { execFile } = require('child_process');

let sharp;
try { sharp = require('sharp'); } catch { console.log('  [thumbs] sharp not installed — image thumbnails disabled'); }

const THUMB_DIR = path.join(__dirname, 'data', 'thumbs');
const SIZE = 480;
const pending = new Map();
let ffmpegOk = null;

function checkFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, err => {
      ffmpegOk = !err;
      if (!ffmpegOk) console.log('  [thumbs] ffmpeg not found — video thumbnails disabled');
      resolve(ffmpegOk);
    });
  });
}

function thumbAbsPath(relPath) {
  const p = path.parse(relPath.replace(/\\/g, '/'));
  return path.join(THUMB_DIR, p.dir, p.name + '.jpg');
}

async function makeImageThumb(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await sharp(src)
    .resize(SIZE, SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toFile(dest);
}

async function makeVideoThumb(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-ss', '1', '-i', src,
      '-frames:v', '1',
      '-vf', `scale=${SIZE}:-2`,
      '-y', dest,
    ], { timeout: 20000 }, err => err ? reject(err) : resolve());
  });
}

async function ensureThumb(relPath, fullSrcPath, isVideo) {
  const dest = thumbAbsPath(relPath);
  if (fs.existsSync(dest)) return dest;

  if (pending.has(relPath)) {
    try { await pending.get(relPath); } catch {}
    if (fs.existsSync(dest)) return dest;
    throw new Error('generation failed');
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

function pregenerate(capturesMap, sanitizeFn) {
  setImmediate(async () => {
    for (const files of Object.values(capturesMap)) {
      for (const file of files) {
        if (fs.existsSync(thumbAbsPath(file.path))) continue;
        const src = sanitizeFn(file.path);
        if (!src) continue;
        try { await ensureThumb(file.path, src, file.type === 'video'); } catch {}
      }
    }
    console.log('  [thumbs] pre-generation complete');
  });
}

async function getImageMeta(src) {
  if (!sharp) return null;
  try {
    const info = await sharp(src).metadata();
    return info.width && info.height ? { width: info.width, height: info.height } : null;
  } catch { return null; }
}

module.exports = { thumbAbsPath, ensureThumb, pregenerate, getImageMeta };

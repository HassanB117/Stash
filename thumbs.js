// Thumbnail and preview rendering. Owns everything under data/thumbs/.
//
// Mid-session driver changes (e.g. a GPU appearing/disappearing) require a
// render-mode toggle from Settings to re-probe — the encoder probe is cached
// for the process lifetime and only invalidated by setRenderMode().

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const term = require('./term');

const THUMB_DIR = path.join(__dirname, 'data', 'thumbs');
const TMP_DIR = path.join(THUMB_DIR, '_tmp');
const THUMB_SIZE = 480;
const PREV_W = THUMB_SIZE;

function readPositiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const PREGENERATE_CONCURRENCY = Math.max(1, Math.min(8, readPositiveIntEnv('PREGENERATE_CONCURRENCY', 3)));
const RENDER_FAILURE_BACKOFF_MS = readPositiveIntEnv('RENDER_FAILURE_BACKOFF_MS', 30 * 60 * 1000);

const DEFAULT_PREVIEW_FILTER = `scale=${PREV_W}:-2:flags=bicubic`;
// mjpeg requires even dims for yuvj420p output.
const THUMB_SCALE_FILTER =
  `scale='min(iw,${THUMB_SIZE})':'min(ih,${THUMB_SIZE})':` +
  `force_original_aspect_ratio=decrease:force_divisible_by=2`;
const SOFTWARE_ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '26'];
const YUV420_OUTPUT_ARGS = ['-pix_fmt', 'yuv420p'];
const AUTO_HARDWARE_DEVICE = 'auto';

// ── Path helpers ───────────────────────────────────────────────────────

function getSafeRelPath(relPath) {
  const normalized = path.normalize(String(relPath || '')).replace(/\\/g, '/');
  return normalized
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..' && !/^[a-zA-Z]:$/.test(part))
    .join('/');
}

function thumbAbsPath(relPath) {
  const parsed = path.parse(getSafeRelPath(relPath));
  return path.join(THUMB_DIR, parsed.dir, parsed.name + '.jpg');
}

function previewAbsPath(relPath) {
  const parsed = path.parse(getSafeRelPath(relPath));
  return path.join(THUMB_DIR, parsed.dir, `${parsed.name}_preview_${PREV_W}.mp4`);
}

// ── Temp file helpers ──────────────────────────────────────────────────

function tempRenderPath(dest) {
  const parsed = path.parse(dest);
  const ext = parsed.ext || '.tmp';
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(TMP_DIR, `${parsed.name}-${tag}${ext}`);
}

async function publishRenderedFile(tmpPath, dest) {
  const stat = await fs.promises.stat(tmpPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('render produced an empty file');
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.rename(tmpPath, dest);
}

async function renderToTempFile(dest, renderFn) {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
  const tmpPath = tempRenderPath(dest);
  try {
    await renderFn(tmpPath);
    await publishRenderedFile(tmpPath, dest);
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

async function cleanupStaleTempFiles(maxAgeMs = 60 * 60 * 1000) {
  let entries;
  try { entries = await fs.promises.readdir(TMP_DIR, { withFileTypes: true }); }
  catch { return 0; }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile()) return;
    const full = path.join(TMP_DIR, entry.name);
    try {
      const stat = await fs.promises.stat(full);
      if (stat.mtimeMs > cutoff) return;
      await fs.promises.unlink(full);
      removed++;
    } catch {}
  }));
  return removed;
}

// ── ffmpeg runner ──────────────────────────────────────────────────────

function runFfmpeg(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, _stdout, stderr) => {
      if (!err) return resolve();
      const tail = (stderr || err.message || '').trim().split('\n').slice(-3).join(' | ');
      reject(new Error(tail.slice(0, 300) || 'ffmpeg failed'));
    });
  });
}

// ── Hardware encoders ──────────────────────────────────────────────────
// `ffmpeg -encoders` only lists what the binary was compiled with. Most
// Windows builds ship nvenc/amf/qsv all enabled, so the listing is useless
// for picking what actually works on the host. We run a tiny synthetic test
// encode against each candidate.

function findVaapiDevice() {
  if (process.platform === 'win32') return null;
  const envDevice = process.env.VAAPI_DEVICE;
  if (envDevice && fs.existsSync(envDevice)) return envDevice;
  try {
    const entries = fs.readdirSync('/dev/dri')
      .filter((name) => /^renderD\d+$/.test(name))
      .sort();
    if (entries.length > 0) return path.join('/dev/dri', entries[0]);
  } catch {}
  return null;
}

function getGpuEncoders() {
  const encoders = [
    {
      id: 'h264_nvenc:auto',
      name: 'h264_nvenc',
      label: 'NVIDIA NVENC',
      encodeArgs: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '26', '-b:v', '0'],
      outputArgs: YUV420_OUTPUT_ARGS,
    },
    {
      id: 'h264_amf:auto',
      name: 'h264_amf',
      label: 'AMD AMF',
      encodeArgs: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26'],
      outputArgs: YUV420_OUTPUT_ARGS,
    },
    {
      id: 'h264_qsv:auto',
      name: 'h264_qsv',
      label: 'Intel QSV',
      encodeArgs: ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '26'],
      outputArgs: YUV420_OUTPUT_ARGS,
    },
  ];

  const vaapiDevice = findVaapiDevice();
  if (vaapiDevice) {
    encoders.push({
      id: `h264_vaapi:${vaapiDevice}`,
      name: 'h264_vaapi',
      label: `VAAPI ${vaapiDevice}`,
      inputArgs: ['-vaapi_device', vaapiDevice],
      previewFilter: `${DEFAULT_PREVIEW_FILTER},format=nv12,hwupload`,
      encodeArgs: ['-c:v', 'h264_vaapi', '-qp', '26'],
      outputArgs: [],
    });
  }

  return encoders;
}

function testEncoder(encoder) {
  return new Promise((resolve) => {
    // 320x240 stays above AMF's minimum frame size; smaller dims false-negative.
    const args = [
      '-hide_banner', '-loglevel', 'error',
      ...(encoder.inputArgs || []),
      '-f', 'lavfi', '-i', 'color=black:s=320x240:r=25',
      '-frames:v', '1',
    ];
    if (encoder.previewFilter) args.push('-vf', encoder.previewFilter);
    args.push(...encoder.encodeArgs, ...(encoder.outputArgs || []), '-f', 'null', '-');
    execFile('ffmpeg', args, { timeout: 10000, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true });
      const firstLine = (stderr || err.message || '')
        .split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'failed';
      resolve({ ok: false, reason: firstLine.replace(/^\[[^\]]+\]\s*/, '').slice(0, 140) });
    });
  });
}

let encoderProbe = null;
let renderMode = 'software';
let hardwareDevice = AUTO_HARDWARE_DEVICE;

async function probeEncoders() {
  if (encoderProbe) return encoderProbe;

  const listStdout = await new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000 },
      (err, out) => resolve(err ? '' : out));
  });
  const candidates = getGpuEncoders().filter((e) =>
    new RegExp('\\s' + e.name + '\\s', 'i').test(listStdout));

  // Serial — concurrent hardware inits step on each other.
  const available = [];
  for (const enc of candidates) {
    const result = await testEncoder(enc);
    if (result.ok) {
      available.push(enc);
      term.logInfo('render', `${term.badge('HW', 'success')} ${enc.label} (${enc.name}) available`);
    } else {
      term.logInfo('render', `${term.badge('SKIP', 'muted')} ${enc.label} (${enc.name}) ${result.reason}`);
    }
  }

  const best = available[0] || null;
  encoderProbe = { available, best };
  if (best) term.logSuccess('render', `${term.badge('HW', 'success')} selected ${best.label} (${best.name})`);
  else term.logInfo('render', `${term.badge('SW', 'muted')} no hardware encoder available - software only`);
  return encoderProbe;
}

function setRenderMode(mode, device) {
  renderMode = (mode === 'hardware' || mode === 'gpu') ? 'hardware' : 'software';
  if (device !== undefined) {
    const trimmed = typeof device === 'string' ? device.trim() : '';
    hardwareDevice = trimmed || AUTO_HARDWARE_DEVICE;
  }
  encoderProbe = null;
  hardwareFallbackWarned = false;
  hardwareDeviceFallbackWarned = false;
  renderFailures.clear();
}

let hardwareFallbackWarned = false;
let hardwareDeviceFallbackWarned = false;

function getHardwareDevice() { return hardwareDevice; }
function getRenderCapabilities() { return probeEncoders(); }

async function pickVideoEncodeArgs() {
  const softwareChoice = {
    inputArgs: [],
    filter: DEFAULT_PREVIEW_FILTER,
    args: SOFTWARE_ENCODE_ARGS,
    outputArgs: YUV420_OUTPUT_ARGS,
    encoder: 'libx264',
    hardware: false,
  };
  if (renderMode !== 'hardware') return softwareChoice;

  const probe = await probeEncoders();
  const explicit = hardwareDevice !== AUTO_HARDWARE_DEVICE
    ? probe.available.find((enc) => enc.id === hardwareDevice)
    : null;
  if (hardwareDevice !== AUTO_HARDWARE_DEVICE && !explicit && !hardwareDeviceFallbackWarned) {
    term.logWarn('render', `selected hardware device unavailable (${hardwareDevice}) - using auto`);
    hardwareDeviceFallbackWarned = true;
  }
  const chosen = explicit || probe.best;
  if (!chosen) {
    if (!hardwareFallbackWarned) {
      term.logWarn('render', 'hardware mode selected but no hardware encoder available - using software');
      hardwareFallbackWarned = true;
    }
    return softwareChoice;
  }
  return {
    inputArgs: chosen.inputArgs || [],
    filter: chosen.previewFilter || DEFAULT_PREVIEW_FILTER,
    args: chosen.encodeArgs,
    outputArgs: chosen.outputArgs || [],
    encoder: chosen.name,
    hardware: true,
  };
}

// ── Image thumbs (incl. JPEG XR via Windows WIC) ───────────────────────
// Xbox Game Bar emits .jxr for HDR captures. Stock ffmpeg has no jpegxr
// decoder, so on Windows we transcode to PNG via WPF's WmpBitmapDecoder first.
// Paths are passed through env vars to avoid PowerShell quoting issues.

const JXR_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
$in = [System.IO.File]::OpenRead($env:JXR_IN)
try {
  $decoder = New-Object System.Windows.Media.Imaging.WmpBitmapDecoder(
    $in,
    [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
    [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $frame = $decoder.Frames[0]
  $encoder = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
  $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($frame))
  $out = [System.IO.File]::Create($env:JXR_OUT)
  try { $encoder.Save($out) } finally { $out.Close() }
} finally { $in.Close() }
`;

function convertJxrToPng(src, tmpPng) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', JXR_PS_SCRIPT],
      {
        timeout: 20000,
        env: { ...process.env, JXR_IN: src, JXR_OUT: tmpPng },
        maxBuffer: 2 * 1024 * 1024,
      },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const msg = (stderr || err.message || 'jxr decode failed')
          .trim().split('\n').filter(Boolean)[0] || 'jxr decode failed';
        reject(new Error(msg.slice(0, 300)));
      });
  });
}

async function makeImageThumb(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });

  let effectiveSrc = src;
  let tmpToCleanup = null;
  if (path.extname(src).toLowerCase() === '.jxr') {
    if (process.platform !== 'win32') {
      throw new Error('.jxr decoding requires Windows (WIC JPEG XR codec)');
    }
    await fs.promises.mkdir(TMP_DIR, { recursive: true });
    tmpToCleanup = path.join(TMP_DIR,
      `jxr-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
    await convertJxrToPng(src, tmpToCleanup);
    effectiveSrc = tmpToCleanup;
  }

  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', effectiveSrc,
      '-vf', THUMB_SCALE_FILTER,
      '-frames:v', '1',
      '-q:v', '4',
      '-f', 'image2',
      '-y', dest,
    ], 30000);
  } finally {
    if (tmpToCleanup) fs.promises.unlink(tmpToCleanup).catch(() => {});
  }
}

// ── Video thumb + preview ──────────────────────────────────────────────

function runVideoThumbFfmpeg(src, dest, seekSeconds) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (seekSeconds > 0) args.push('-ss', String(seekSeconds));
  args.push(
    '-i', src,
    '-frames:v', '1',
    '-vf', THUMB_SCALE_FILTER,
    '-q:v', '4',
    '-y', dest,
  );
  return runFfmpeg(args, 30000);
}

async function makeVideoThumb(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  // Frames near t=0 can be black or a title card; try t=1s first.
  try { await runVideoThumbFfmpeg(src, dest, 1); }
  catch { await runVideoThumbFfmpeg(src, dest, 0); }
}

function buildPreviewArgs(src, dest, choice) {
  return [
    '-hide_banner', '-loglevel', 'error',
    ...choice.inputArgs,
    '-i', src,
    '-t', '2',
    '-vf', choice.filter,
    ...choice.args,
    ...choice.outputArgs,
    '-an',
    '-movflags', '+faststart',
    '-y', dest,
  ];
}

const SOFTWARE_PREVIEW_CHOICE = {
  inputArgs: [],
  filter: DEFAULT_PREVIEW_FILTER,
  args: SOFTWARE_ENCODE_ARGS,
  outputArgs: YUV420_OUTPUT_ARGS,
  encoder: 'libx264',
  hardware: false,
};

async function makeVideoPreview(src, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const chosen = await pickVideoEncodeArgs();
  try {
    await runFfmpeg(buildPreviewArgs(src, dest, chosen), 60000);
    return chosen;
  } catch (err) {
    if (!chosen.hardware) throw err;
    // Transient hardware-encoder failure (e.g. NVENC session-limit while a game
    // is recording). Retry once in software so we don't lock this file out of
    // preview generation via the render-failure backoff.
    term.logWarn('render', `${chosen.encoder} failed (${err.message}) - retrying in software`);
    await runFfmpeg(buildPreviewArgs(src, dest, SOFTWARE_PREVIEW_CHOICE), 60000);
    return SOFTWARE_PREVIEW_CHOICE;
  }
}

// ── Render-failure backoff ─────────────────────────────────────────────

const renderFailures = new Map();

function getBackoffFailure(file, now = Date.now()) {
  const record = file && file.path ? renderFailures.get(file.path) : null;
  if (!record) return null;
  if (record.mtime !== file.mtime || (now - record.failedAt) >= RENDER_FAILURE_BACKOFF_MS) {
    renderFailures.delete(file.path);
    return null;
  }
  return record;
}

function rememberRenderFailure(file, err) {
  if (!file || !file.path) return;
  renderFailures.set(file.path, {
    mtime: file.mtime,
    failedAt: Date.now(),
    message: err && err.message ? err.message : 'render failed',
  });
}

function forgetRenderFailure(file) {
  if (file && file.path) renderFailures.delete(file.path);
}

// ── Pregenerate ────────────────────────────────────────────────────────

async function ensureThumb(relPath, src, isVideo) {
  const dest = thumbAbsPath(relPath);
  if (fs.existsSync(dest)) return;
  await renderToTempFile(dest, (tmp) =>
    isVideo ? makeVideoThumb(src, tmp) : makeImageThumb(src, tmp));
}

async function ensurePreview(relPath, src) {
  const dest = previewAbsPath(relPath);
  if (fs.existsSync(dest)) return null;
  let chosen = null;
  await renderToTempFile(dest, async (tmp) => { chosen = await makeVideoPreview(src, tmp); });
  return chosen;
}

async function buildPregenerateTodo(capturesMap, limit) {
  const todo = [];
  const now = Date.now();
  for (const [, files] of Object.entries(capturesMap || {})) {
    for (const file of files) {
      const needThumb = !fs.existsSync(thumbAbsPath(file.path));
      const needPreview = file.type === 'video' && !fs.existsSync(previewAbsPath(file.path));
      if (!needThumb && !needPreview) {
        forgetRenderFailure(file);
        continue;
      }
      todo.push({ file, needThumb, needPreview, backoff: getBackoffFailure(file, now) });
    }
    await new Promise((r) => setImmediate(r));
  }
  todo.sort((a, b) => (b.file.mtime || 0) - (a.file.mtime || 0));
  return Number.isFinite(limit) ? todo.slice(0, limit) : todo;
}

async function runPregeneratePass(capturesMap, sanitizeFn, limit) {
  const removedTemps = await cleanupStaleTempFiles();
  if (removedTemps) term.logInfo('render', `${term.badge('CLEAN', 'muted')} removed ${removedTemps} stale temp file(s)`);

  const todo = await buildPregenerateTodo(capturesMap, limit);
  if (todo.length === 0) return;

  const total = todo.length;
  term.writeLine(term.divider('render'));
  term.logInfo('render', `queued ${total} newest-first file(s), concurrency ${PREGENERATE_CONCURRENCY}`);

  let done = 0;
  let failed = 0;
  let skipped = 0;
  let nextIndex = 0;

  async function runOne(item, index) {
    const { file, needThumb, needPreview, backoff } = item;
    const tag = `${index + 1}/${total}`;
    if (backoff) {
      skipped++;
      term.logWarn('render', `[${tag}] backoff ${term.shortPath(file.path)}: ${backoff.message}`);
      return;
    }
    const src = sanitizeFn(file.path);
    if (!src) {
      skipped++;
      term.logWarn('render', `[${tag}] skipped ${term.shortPath(file.path)}`);
      return;
    }
    try {
      const isVideo = file.type === 'video';
      const start = Date.now();
      if (needThumb) await ensureThumb(file.path, src, isVideo);
      let encTag = isVideo ? 'PREV' : 'IMG';
      let encTone = 'muted';
      if (needPreview) {
        const chosen = await ensurePreview(file.path, src);
        if (chosen) {
          encTag = chosen.hardware ? 'HW' : 'SW';
          encTone = chosen.hardware ? 'accent' : 'muted';
        }
      }
      forgetRenderFailure(file);
      done++;
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      term.logInfo('render', `[${tag}] ${term.badge(encTag, encTone)} ${term.shortPath(file.path)} ${elapsed}s`);
    } catch (err) {
      failed++;
      rememberRenderFailure(file, err);
      term.logError('render', `[${tag}] failed ${term.shortPath(file.path)}: ${err.message}`);
    }
  }

  async function worker() {
    while (nextIndex < todo.length) {
      const index = nextIndex++;
      await runOne(todo[index], index);
      await new Promise((r) => setImmediate(r));
    }
  }

  const workerCount = Math.min(PREGENERATE_CONCURRENCY, todo.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const suffix = [
    `${done}/${total} processed`,
    failed ? `${failed} failed` : '',
    skipped ? `${skipped} skipped` : '',
  ].filter(Boolean).join(', ');
  term.logSuccess('render', `complete - ${suffix}`);
}

let pregenerateActive = false;
let pregenerateQueued = null;

function pregenerate(capturesMap, sanitizeFn, limit = Infinity) {
  if (limit <= 0) return;
  const request = { capturesMap, sanitizeFn, limit };
  if (pregenerateActive) {
    pregenerateQueued = request;
    term.logInfo('render', `${term.badge('QUEUE', 'muted')} render pass already active; scheduled one follow-up pass`);
    return;
  }

  pregenerateActive = true;
  setImmediate(async () => {
    let current = request;
    try {
      while (current) {
        pregenerateQueued = null;
        await runPregeneratePass(current.capturesMap, current.sanitizeFn, current.limit);
        current = pregenerateQueued;
      }
    } finally {
      pregenerateActive = false;
    }
  });
}

// ── Extras ─────────────────────────────────────────────────────────────

// Delete cached previews so a mode switch is observable — otherwise the
// library is already encoded and the new encoder is never exercised.
async function clearVideoPreviews() {
  let removed = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && /_preview(?:_\d+)?\.mp4$/.test(entry.name)) {
        try { await fs.promises.unlink(full); removed++; } catch {}
      }
    }
  }
  await walk(THUMB_DIR);
  return removed;
}

function getImageMeta(src) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'json',
      src,
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        const s = data && Array.isArray(data.streams) ? data.streams[0] : null;
        resolve(s && s.width && s.height ? { width: s.width, height: s.height } : null);
      } catch { resolve(null); }
    });
  });
}

module.exports = {
  thumbAbsPath,
  previewAbsPath,
  setRenderMode,
  getHardwareDevice,
  getRenderCapabilities,
  pregenerate,
  clearVideoPreviews,
  getImageMeta,
};

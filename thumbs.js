const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const term = require('./term');

const THUMB_DIR = path.join(__dirname, 'data', 'thumbs');
const THUMB_SIZE = 480;
const PREV_W = THUMB_SIZE;
const PREGENERATE_CONCURRENCY = 3;
const pending = new Map();

// One-time ffmpeg / ffprobe availability checks. Result is cached.
let ffmpegOk = null;
let ffprobeOk = null;

function checkBinary(bin, flagged) {
  return new Promise((resolve) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (err) => {
      const ok = !err;
      if (!ok) term.logWarn('thumbs', `${bin} not found - ${flagged} disabled`);
      resolve(ok);
    });
  });
}

function checkFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return checkBinary('ffmpeg', 'all thumbnail and preview rendering')
    .then((ok) => (ffmpegOk = ok));
}

function checkFfprobe() {
  if (ffprobeOk !== null) return Promise.resolve(ffprobeOk);
  return checkBinary('ffprobe', 'media metadata')
    .then((ok) => (ffprobeOk = ok));
}

// ── Hardware encoders ──────────────────────────────────────────────────
// Discrete hardware encoders first (NVENC, AMF), Intel QSV next, and Linux
// VAAPI last for containers or hosts that expose /dev/dri render devices.
const DEFAULT_PREVIEW_FILTER = `scale=${PREV_W}:-2:flags=bicubic`;
const YUV420_OUTPUT_ARGS = ['-pix_fmt', 'yuv420p'];
const AUTO_HARDWARE_DEVICE = 'auto';
const D3D11_ADAPTER_SCAN_LIMIT = 8;

function findVaapiDevice() {
  if (process.platform === 'win32') return null;
  const envDevice = process.env.VAAPI_DEVICE;
  if (envDevice && fs.existsSync(envDevice)) return envDevice;
  const driDir = '/dev/dri';
  try {
    const entries = fs.readdirSync(driDir)
      .filter((name) => /^renderD\d+$/.test(name))
      .sort();
    if (entries.length > 0) return path.join(driDir, entries[0]);
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
  ];

  if (process.platform === 'win32') {
    for (let index = 0; index < D3D11_ADAPTER_SCAN_LIMIT; index++) {
      encoders.push({
        id: `h264_amf:d3d11:${index}`,
        name: 'h264_amf',
        label: `AMD AMF adapter ${index}`,
        inputArgs: ['-init_hw_device', `d3d11va=stashhw:${index}`, '-filter_hw_device', 'stashhw'],
        previewFilter: `${DEFAULT_PREVIEW_FILTER},format=nv12,hwupload`,
        encodeArgs: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26'],
        outputArgs: [],
        captureDeviceName: true,
      });
    }
  }

  encoders.push({
    id: 'h264_amf:auto',
    name: 'h264_amf',
    label: 'AMD AMF auto',
    encodeArgs: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '26', '-qp_p', '26'],
    outputArgs: YUV420_OUTPUT_ARGS,
  });

  encoders.push({
    id: 'h264_qsv:auto',
    name: 'h264_qsv',
    label: 'Intel QSV',
    encodeArgs: ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '26'],
    outputArgs: YUV420_OUTPUT_ARGS,
  });

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

const SOFTWARE_ENCODE_ARGS = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '26'];

let encoderProbe = null;
let renderMode = 'software';
let hardwareDevice = AUTO_HARDWARE_DEVICE;
let hardwareFallbackWarned = false;
let hardwareDeviceFallbackWarned = false;

function normalizeRenderMode(mode) {
  // Accept old config/API values from versions that used cpu/gpu names.
  return (mode === 'hardware' || mode === 'gpu') ? 'hardware' : 'software';
}

function normalizeHardwareDevice(device) {
  const value = typeof device === 'string' ? device.trim() : '';
  return value || AUTO_HARDWARE_DEVICE;
}

function getEncoderLabel(encoder) {
  return encoder.deviceLabel ? `${encoder.label} - ${encoder.deviceLabel}` : encoder.label;
}

// `ffmpeg -encoders` only reports what the binary was compiled with. Most
// Windows ffmpeg builds ship nvenc/amf/qsv all enabled, so the listing is
// useless for picking what actually works on the host hardware. We run a tiny
// test encode against a synthetic source instead.
function testEncoder(encoder) {
  return new Promise((resolve) => {
    // 320x240 stays above AMF's
    // minimum frame size — AMF rejects tiny frames with a generic init error
    // which would false-negative on AMD hardware.
    const args = [
      '-hide_banner', '-loglevel', encoder.captureDeviceName ? 'verbose' : 'error',
      ...(encoder.inputArgs || []),
      '-f', 'lavfi', '-i', 'color=black:s=320x240:r=25',
      '-frames:v', '1',
    ];
    if (encoder.previewFilter) args.push('-vf', encoder.previewFilter);
    args.push(
      ...encoder.encodeArgs,
      ...(encoder.outputArgs || []),
      '-f', 'null', '-',
    );
    execFile('ffmpeg', args, { timeout: 10000 }, (err, _stdout, stderr) => {
      const output = stderr || '';
      const deviceMatch = output.match(/Using device\s+([0-9a-fA-F]{4}:[0-9a-fA-F]{4})\s+\(([^)]+)\)/);
      if (deviceMatch) encoder.deviceLabel = `${deviceMatch[2]} (${deviceMatch[1]})`;
      if (encoder.captureDeviceName && !deviceMatch) {
        return resolve({ ok: false, reason: 'adapter not found' });
      }
      if (!err) return resolve({ ok: true });
      const firstLine = (output || err.message || '')
        .split('\n').map((l) => l.trim()).filter(Boolean)[0] || 'failed';
      const reason = firstLine.replace(/^\[[^\]]+\]\s*/, '').slice(0, 140);
      resolve({ ok: false, reason });
    });
  });
}

async function probeEncoders() {
  if (encoderProbe) return encoderProbe;
  if (!await checkFfmpeg()) {
    encoderProbe = { available: [], best: null };
    return encoderProbe;
  }

  // Cheap first pass: which encoder modules does this ffmpeg build ship at all?
  const listStdout = await new Promise((resolve) => {
    execFile('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000 },
      (err, out) => resolve(err ? '' : out));
  });
  const candidates = getGpuEncoders().filter((e) =>
    new RegExp('\\s' + e.name + '\\s', 'i').test(listStdout));

  // Expensive second pass: actually try each. Serial so concurrent hardware inits
  // don't step on each other.
  const available = [];
  for (let i = 0; i < candidates.length; i++) {
    const enc = candidates[i];
    const result = await testEncoder(enc);
    if (result.ok) {
      available.push(enc);
      term.logInfo('render', `${getEncoderLabel(enc)} (${enc.name}) - available`);
    } else {
      term.logInfo('render', `${getEncoderLabel(enc)} (${enc.name}) - not available: ${result.reason}`);
      if (enc.id && enc.id.startsWith('h264_amf:d3d11:') && result.reason === 'adapter not found') {
        while (candidates[i + 1] && candidates[i + 1].id && candidates[i + 1].id.startsWith('h264_amf:d3d11:')) i++;
      }
    }
  }

  const best = available[0] || null;
  encoderProbe = { available, best };
  if (best) term.logSuccess('render', `hardware encoder selected: ${getEncoderLabel(best)} (${best.name})`);
  else term.logInfo('render', 'no hardware encoder available - software only');
  return encoderProbe;
}

function setRenderMode(mode, device) {
  renderMode = normalizeRenderMode(mode);
  if (device !== undefined) hardwareDevice = normalizeHardwareDevice(device);
  hardwareFallbackWarned = false;
  hardwareDeviceFallbackWarned = false;
}

function getRenderMode() { return renderMode; }
function getHardwareDevice() { return hardwareDevice; }
function getRenderCapabilities() { return probeEncoders(); }

async function pickVideoEncodeArgs() {
  if (renderMode !== 'hardware') {
    return {
      inputArgs: [],
      filter: DEFAULT_PREVIEW_FILTER,
      args: SOFTWARE_ENCODE_ARGS,
      outputArgs: YUV420_OUTPUT_ARGS,
      encoder: 'libx264',
      hardware: false,
    };
  }
  const probe = await probeEncoders();
  const preferred = hardwareDevice === AUTO_HARDWARE_DEVICE
    ? null
    : probe.available.find((enc) => enc.id === hardwareDevice);
  const chosen = preferred || probe.best;
  if (hardwareDevice !== AUTO_HARDWARE_DEVICE && !preferred && !hardwareDeviceFallbackWarned) {
    term.logWarn('render', `selected hardware device unavailable (${hardwareDevice}) - using auto`);
    hardwareDeviceFallbackWarned = true;
  }

  if (!chosen) {
    if (!hardwareFallbackWarned) {
      term.logWarn('render', 'hardware mode selected but no hardware encoder available - using software');
      hardwareFallbackWarned = true;
    }
    return {
      inputArgs: [],
      filter: DEFAULT_PREVIEW_FILTER,
      args: SOFTWARE_ENCODE_ARGS,
      outputArgs: YUV420_OUTPUT_ARGS,
      encoder: 'libx264',
      hardware: false,
    };
  }
  return {
    inputArgs: chosen.inputArgs || [],
    filter: chosen.previewFilter || DEFAULT_PREVIEW_FILTER,
    args: chosen.encodeArgs,
    outputArgs: chosen.outputArgs || [],
    encoder: chosen.name,
    target: getEncoderLabel(chosen),
    hardware: true,
  };
}

// ── Path helpers ───────────────────────────────────────────────────────

function getSafeRelPath(relPath) {
  return path.normalize(relPath)
    .replace(/^(\.\.[\/\\])+/, '')
    .replace(/^[\\\/]+/, '');
}

function thumbAbsPath(relPath) {
  const safeRel = getSafeRelPath(relPath);
  const parsed = path.parse(safeRel.replace(/\\/g, '/'));
  return path.join(THUMB_DIR, parsed.dir, parsed.name + '.jpg');
}

function previewAbsPath(relPath) {
  const safeRel = getSafeRelPath(relPath);
  const parsed = path.parse(safeRel.replace(/\\/g, '/'));
  return path.join(THUMB_DIR, parsed.dir, `${parsed.name}_preview_${PREV_W}.mp4`);
}

// ── ffmpeg helpers ─────────────────────────────────────────────────────

// Bound to 480x480, preserve aspect, never upscale, force even dimensions
// (mjpeg encoder requires even dims for yuvj420p output).
const THUMB_SCALE_FILTER =
  `scale='min(iw,${THUMB_SIZE})':'min(ih,${THUMB_SIZE})':` +
  `force_original_aspect_ratio=decrease:force_divisible_by=2`;

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

// JPEG XR (.jxr) — emitted by Xbox Game Bar for HDR captures. Standard ffmpeg
// builds have no jpegxr decoder (only wmv3image, which is a different format),
// so on Windows we transcode to PNG via WPF's WmpBitmapDecoder first and then
// hand that to ffmpeg for scaling. Paths are passed through env vars so they
// can't be interpreted as PowerShell syntax.
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

  const ext = path.extname(src).toLowerCase();
  let effectiveSrc = src;
  let tmpToCleanup = null;
  if (ext === '.jxr') {
    if (process.platform !== 'win32') {
      throw new Error('.jxr decoding requires Windows (WIC JPEG XR codec)');
    }
    const tmpDir = path.join(THUMB_DIR, '_tmp');
    await fs.promises.mkdir(tmpDir, { recursive: true });
    tmpToCleanup = path.join(
      tmpDir,
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
    if (tmpToCleanup) {
      fs.promises.unlink(tmpToCleanup).catch(() => {});
    }
  }
}

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
  try {
    await runVideoThumbFfmpeg(src, dest, 1);
  } catch {
    await runVideoThumbFfmpeg(src, dest, 0);
  }
}

// ── 2-second preview clip with progress bar ────────────────────────────

function runVideoPreviewFfmpeg(relPath, src, dest, encoderOptions, progressTag, animateProgress = true) {
  return new Promise((resolve, reject) => {
    const encodeArgs = encoderOptions.args;
    const encoderName = encoderOptions.encoder;
    const label = relPath.length > 40 ? '...' + relPath.slice(-37) : relPath.padEnd(40);
    const barWidth = 20;
    const durationUs = 2_000_000;
    const canAnimateProgress = animateProgress && term.isInteractive();
    const encoderTag = encoderName === 'libx264' ? 'SW' : 'HW';
    const countTag = progressTag ? term.muted('[' + progressTag + ']') : '';

    function buildProgressLine(pct, extra, tone) {
      const filled = Math.round(pct / 100 * barWidth);
      const bar = '#'.repeat(filled) + '-'.repeat(barWidth - filled);
      const parts = ['  ' + term.formatLabel('render', 'accent')];
      if (countTag) parts.push(countTag);
      parts.push(
        term.muted('[' + encoderTag + ']'),
        term.muted(label),
        tone === 'success' ? term.success('[' + bar + ']') : term.accent('[' + bar + ']'),
        term.muted(String(pct).padStart(3) + '%'),
      );
      if (extra) parts.push(term.muted(extra));
      return parts.join(' ');
    }

    function drawBar(pct) {
      if (!canAnimateProgress) return;
      term.write('\r' + buildProgressLine(pct), 'stdout');
    }

    const countPrefix = progressTag ? `[${progressTag}] ` : '';
    if (canAnimateProgress) drawBar(0);
    else term.logInfo('render', `${countPrefix}${relPath} [${encoderTag}:${encoderName}]`);

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      ...(encoderOptions.inputArgs || []),
      '-i', src,
      '-t', '2',
      '-vf', encoderOptions.filter || DEFAULT_PREVIEW_FILTER,
      ...encodeArgs,
      ...(encoderOptions.outputArgs || []),
      '-an',
      '-movflags', '+faststart',
      '-progress', 'pipe:1',
      '-y', dest,
    ];

    const child = spawn('ffmpeg', args);

    let stderrBuf = '';
    child.stderr.on('data', (data) => { stderrBuf += data.toString(); });

    child.stdout.on('data', (data) => {
      const match = data.toString().match(/out_time_us=(\d+)/);
      if (!match) return;
      const pct = Math.min(100, Math.round(parseInt(match[1], 10) / durationUs * 100));
      drawBar(pct);
    });

    child.on('error', (err) => {
      if (canAnimateProgress) term.write('\n', 'stdout');
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        let sizeStr = '?';
        try {
          const bytes = fs.statSync(dest).size;
          sizeStr = bytes < 1024 * 1024
            ? (bytes / 1024).toFixed(0) + ' KB'
            : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        } catch {}
        if (canAnimateProgress) {
          term.write('\r' + buildProgressLine(100, '- ' + sizeStr, 'success') + '\n', 'stdout');
        } else {
          term.logSuccess('render', `${countPrefix}${relPath} [${encoderTag}:${encoderName}] (${sizeStr})`);
        }
        resolve();
      } else {
        if (canAnimateProgress) term.write('\n', 'stdout');
        const tail = stderrBuf.trim().split('\n').slice(-3).join(' | ');
        reject(new Error(tail.slice(0, 300) || `ffmpeg exited with code ${code}`));
      }
    });
  });
}

async function makeVideoPreview(relPath, src, dest, progressTag, animateProgress = true) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const chosen = await pickVideoEncodeArgs();
  try {
    await runVideoPreviewFfmpeg(relPath, src, dest, chosen, progressTag, animateProgress);
  } catch (err) {
    // If hardware encode fails mid-stream (stale drivers, locked session),
    // retry once in software so the user still gets a preview.
    if (chosen.hardware) {
      term.logWarn('render', `${chosen.encoder} failed (${err.message}) - retrying in software`);
      await runVideoPreviewFfmpeg(relPath, src, dest, {
        inputArgs: [],
        filter: DEFAULT_PREVIEW_FILTER,
        args: SOFTWARE_ENCODE_ARGS,
        outputArgs: YUV420_OUTPUT_ARGS,
        encoder: 'libx264',
      }, progressTag, animateProgress);
    } else {
      throw err;
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────────

async function ensureThumb(relPath, fullSrcPath, isVideo, progressTag) {
  const dest = thumbAbsPath(relPath);
  if (fs.existsSync(dest)) return dest;

  if (pending.has(relPath)) {
    try { await pending.get(relPath); } catch {}
    if (fs.existsSync(dest)) return dest;
    throw new Error('thumbnail generation failed');
  }

  if (!await checkFfmpeg()) throw new Error('ffmpeg not available');

  const prefix = progressTag ? `[${progressTag}] ` : '';
  term.logInfo(isVideo ? 'vthumb' : 'thumb', `${prefix}${relPath}`);
  const work = (isVideo ? makeVideoThumb(fullSrcPath, dest) : makeImageThumb(fullSrcPath, dest))
    .finally(() => pending.delete(relPath));
  pending.set(relPath, work);
  await work;
  return dest;
}

async function ensurePreview(relPath, fullSrcPath, progressTag, animateProgress = true) {
  const dest = previewAbsPath(relPath);
  if (fs.existsSync(dest)) return dest;

  const key = 'preview:' + relPath;
  if (pending.has(key)) {
    try { await pending.get(key); } catch {}
    if (fs.existsSync(dest)) return dest;
    throw new Error('preview generation failed');
  }

  if (!await checkFfmpeg()) throw new Error('ffmpeg not available');

  const work = makeVideoPreview(relPath, fullSrcPath, dest, progressTag, animateProgress)
    .finally(() => pending.delete(key));
  pending.set(key, work);
  await work;
  return dest;
}

function pregenerate(capturesMap, sanitizeFn, limit = Infinity) {
  if (limit <= 0) return;
  setImmediate(async () => {
    const todo = [];
    for (const [, files] of Object.entries(capturesMap)) {
      if (todo.length >= limit) break;
      for (const file of files) {
        if (todo.length >= limit) break;
        const needThumb = !fs.existsSync(thumbAbsPath(file.path));
        const needPreview = file.type === 'video' && !fs.existsSync(previewAbsPath(file.path));
        if (needThumb || needPreview) todo.push({ file, needThumb, needPreview });
      }
      // Yield to the event loop between game directories
      await new Promise((r) => setImmediate(r));
    }

    if (todo.length === 0) return;
    const total = todo.length;
    term.logInfo('render', `${total} file(s) to process (${PREGENERATE_CONCURRENCY} at a time)`);

    let done = 0;
    let nextIndex = 0;

    async function runOne(item, index) {
      const { file, needThumb, needPreview } = item;
      const tag = `${index + 1}/${total}`;
      const src = sanitizeFn(file.path);
      if (!src) return;
      try {
        if (needThumb) await ensureThumb(file.path, src, file.type === 'video', tag);
        if (needPreview) await ensurePreview(file.path, src, tag, false);
        done++;
      } catch (err) {
        term.logError('render', `[${tag}] failed ${file.path}: ${err.message}`);
      }
    }

    async function worker() {
      while (nextIndex < todo.length) {
        const index = nextIndex++;
        await runOne(todo[index], index);
        // Yield between files so request handling stays responsive.
        await new Promise((r) => setImmediate(r));
      }
    }

    const workerCount = Math.min(PREGENERATE_CONCURRENCY, todo.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    term.logSuccess('render', `complete - ${done}/${total} processed`);
  });
}

// Delete all cached video preview files so a mode switch is
// actually observable — otherwise the library is already fully encoded and
// the new encoder is never exercised.
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

async function getImageMeta(src) {
  if (!await checkFfprobe()) return null;
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
        if (s && s.width && s.height) resolve({ width: s.width, height: s.height });
        else resolve(null);
      } catch { resolve(null); }
    });
  });
}

module.exports = {
  thumbAbsPath,
  previewAbsPath,
  ensureThumb,
  ensurePreview,
  pregenerate,
  getImageMeta,
  setRenderMode,
  getRenderMode,
  getHardwareDevice,
  getRenderCapabilities,
  clearVideoPreviews,
};

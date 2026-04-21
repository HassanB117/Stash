const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { ensureThumb, ensurePreview, pregenerate, getImageMeta } = require('./thumbs');
let sharp; try { sharp = require('sharp'); } catch {}

const app = express();
const PORT = process.env.PORT || 3000;
function getTrustProxySetting() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return 1;
  const lower = String(raw).trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(lower)) return false;
  if (['true', 'on', 'yes'].includes(lower)) return true;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 1;
}
app.set('trust proxy', getTrustProxySetting());
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CAPTURE_CACHE_TTL = Number(process.env.CAPTURE_CACHE_TTL || 5000);
const FILE_META_CACHE_LIMIT = Number(process.env.FILE_META_CACHE_LIMIT || 500);
const captureCache = {
  key: '',
  stamp: 0,
  value: {},
};
const fileMetaCache = new Map();

function pruneFileMetaCache() {
  while (fileMetaCache.size > FILE_META_CACHE_LIMIT) {
    const oldestKey = fileMetaCache.keys().next().value;
    fileMetaCache.delete(oldestKey);
  }
}

// --- Config ---
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return null; }
}
function saveConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
function isConfigured() {
  const cfg = loadConfig();
  return cfg && cfg.username && cfg.passwordHash && cfg.capturesPath;
}

function getSessionSecret() {
  const cfg = loadConfig();
  if (cfg && cfg.sessionSecret) return cfg.sessionSecret;
  return crypto.randomBytes(32).toString('hex');
}

// --- Favorites ---
function loadFavorites() {
  try { return JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8')); }
  catch { return []; }
}
function saveFavorites(arr) { fs.writeFileSync(FAVORITES_FILE, JSON.stringify(arr)); }

// --- Shares ---
function loadShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveShares(s) { fs.writeFileSync(SHARES_FILE, JSON.stringify(s)); }
function getShare(token) {
  const row = loadShares()[token];
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}
function addShare(token, filePath, expiresAt) {
  const shares = loadShares();
  shares[token] = { file_path: filePath, expires_at: expiresAt, created_at: Date.now() };
  saveShares(shares);
}
setInterval(() => {
  const shares = loadShares();
  let changed = false;
  for (const t of Object.keys(shares)) {
    if (shares[t].expires_at < Date.now()) { delete shares[t]; changed = true; }
  }
  if (changed) saveShares(shares);
}, 60 * 60 * 1000);

// --- Middleware ---
// Helmet with CSP that allows our own scripts (no inline scripts used anywhere)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// --- Helpers ---
function sanitizeRelPath(relPath) {
  const cfg = loadConfig();
  if (!cfg) return null;
  const capturesDir = path.resolve(cfg.capturesPath);
  const normalized = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.resolve(capturesDir, normalized);
  if (!fullPath.startsWith(capturesDir + path.sep) && fullPath !== capturesDir) return null;
  return fullPath;
}

function requireAuth(req, res, next) {
  if (!isConfigured()) return res.redirect('/setup');
  if (req.session.authed) return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthorized' });
}

function requireSetupNotDone(req, res, next) {
  if (isConfigured()) return res.status(403).json({ error: 'already configured' });
  next();
}

function scanCapturesFromDir(capturesDir) {
  if (!fs.existsSync(capturesDir)) return {};

  const result = {};
  const games = fs.readdirSync(capturesDir, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const game of games) {
    const gameDir = path.join(capturesDir, game.name);
    try {
      const files = fs.readdirSync(gameDir)
        .filter(f => ALLOWED_EXT.has(path.extname(f).toLowerCase()))
        .map(f => {
          const ext = path.extname(f).toLowerCase();
          const stat = fs.statSync(path.join(gameDir, f));
          return {
            name: f,
            path: `${game.name}/${f}`,
            type: VIDEO_EXT.has(ext) ? 'video' : 'image',
            mtime: stat.mtimeMs,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) result[game.name] = files;
    } catch { /* skip */ }
  }
  return result;
}

function getCapturesSnapshot(force = false) {
  const cfg = loadConfig();
  if (!cfg) return {};
  const capturesDir = path.resolve(cfg.capturesPath);
  const key = capturesDir;
  const now = Date.now();
  if (!force && captureCache.key === key && (now - captureCache.stamp) < CAPTURE_CACHE_TTL) {
    return captureCache.value;
  }
  const value = scanCapturesFromDir(capturesDir);
  captureCache.key = key;
  captureCache.stamp = now;
  captureCache.value = value;
  return value;
}

// --- Routes ---

app.get('/', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');
  if (!req.session.authed) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/setup', (req, res) => {
  if (isConfigured()) return res.redirect('/login');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.post('/api/setup/check-path', requireSetupNotDone, (req, res) => {
  const { path: folderPath } = req.body;
  if (!folderPath || typeof folderPath !== 'string') {
    return res.status(400).json({ ok: false, error: 'no path provided' });
  }
  try {
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved)) return res.json({ ok: false, error: 'folder does not exist' });
    if (!fs.statSync(resolved).isDirectory()) return res.json({ ok: false, error: 'that path is not a folder' });
    fs.readdirSync(resolved);
    return res.json({ ok: true, resolved });
  } catch {
    return res.json({ ok: false, error: 'cannot access folder (permissions?)' });
  }
});

app.post('/api/setup/complete', requireSetupNotDone, async (req, res) => {
  const { username, password, capturesPath } = req.body;
  if (!username || !password || !capturesPath) return res.status(400).json({ error: 'all fields required' });
  if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'username must be 2-32 characters' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  try {
    const resolved = path.resolve(capturesPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: 'captures folder does not exist' });
    }
  } catch {
    return res.status(400).json({ error: 'cannot access captures folder' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const sessionSecret = crypto.randomBytes(64).toString('hex');
  captureCache.stamp = 0;
  captureCache.key = '';
  captureCache.value = {};
  saveConfig({
    username: username.trim(),
    passwordHash,
    capturesPath: path.resolve(capturesPath),
    sessionSecret,
    createdAt: Date.now(),
  });
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');
  if (req.session.authed) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', loginLimiter, async (req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'setup not complete' });
  const cfg = loadConfig();
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'missing fields' });
  const userOk = username === cfg.username;
  const passOk = await bcrypt.compare(password, cfg.passwordHash);
  if (!userOk || !passOk) return res.status(401).json({ error: 'wrong username or password' });
  req.session.authed = true;
  res.json({ ok: true });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/captures', requireAuth, (req, res) => res.json(getCapturesSnapshot()));

app.get('/api/config', requireAuth, (req, res) => {
  const cfg = loadConfig();
  res.json({ username: cfg.username, capturesPath: cfg.capturesPath, siteUrl: cfg.siteUrl || '' });
});

app.post('/api/config/path', requireAuth, (req, res) => {
  const { capturesPath } = req.body;
  if (!capturesPath || typeof capturesPath !== 'string') return res.status(400).json({ error: 'no path' });
  try {
    const resolved = path.resolve(capturesPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: 'folder does not exist' });
    }
    const cfg = loadConfig();
    cfg.capturesPath = resolved;
    saveConfig(cfg);
    captureCache.stamp = 0;
    captureCache.key = '';
    captureCache.value = {};
    res.json({ ok: true, capturesPath: resolved });
  } catch {
    res.status(400).json({ error: 'cannot access folder' });
  }
});

app.post('/api/config/url', requireAuth, (req, res) => {
  let { siteUrl } = req.body;
  if (siteUrl && typeof siteUrl === 'string' && siteUrl.trim()) {
    siteUrl = siteUrl.trim().replace(/\/$/, '');
    try { new URL(siteUrl); } catch { return res.status(400).json({ error: 'invalid URL' }); }
    if (!siteUrl.startsWith('http')) return res.status(400).json({ error: 'URL must start with http' });
  } else {
    siteUrl = '';
  }
  const cfg = loadConfig();
  cfg.siteUrl = siteUrl;
  saveConfig(cfg);
  res.json({ ok: true, siteUrl });
});

app.post('/api/config/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = loadConfig();
  if (!await bcrypt.compare(currentPassword || '', cfg.passwordHash)) {
    return res.status(401).json({ error: 'current password wrong' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'new password must be 8+ characters' });
  }
  cfg.passwordHash = await bcrypt.hash(newPassword, 12);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.get('/api/favorites', requireAuth, (req, res) => res.json(loadFavorites()));

app.post('/api/favorites/toggle', requireAuth, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'bad request' });
  if (!sanitizeRelPath(filePath)) return res.status(400).json({ error: 'invalid path' });
  const favs = loadFavorites();
  const idx = favs.indexOf(filePath);
  const starred = idx === -1;
  if (starred) favs.push(filePath);
  else favs.splice(idx, 1);
  saveFavorites(favs);
  res.json({ starred });
});

app.get('/api/file-meta', requireAuth, async (req, res) => {
  const relPath = req.query.path;
  if (!relPath) return res.status(400).json({ error: 'no path' });
  const fullPath = sanitizeRelPath(relPath);
  if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'not found' });

  try {
    const stat = fs.statSync(fullPath);
    const cacheKey = `${fullPath}:${stat.mtimeMs}:${stat.size}`;
    const cached = fileMetaCache.get(cacheKey);
    if (cached) return res.json(cached);

    const bytes = stat.size;
    const size = bytes < 1024 * 1024
      ? (bytes / 1024).toFixed(1) + ' KB'
      : (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    const ext = path.extname(relPath).toLowerCase();
    const meta = { size };

    if (VIDEO_EXT.has(ext)) {
      try {
        const dur = await getVideoDuration(fullPath);
        if (dur != null) {
          const m = Math.floor(dur / 60);
          const s = Math.floor(dur % 60);
          meta.duration = m + ':' + String(s).padStart(2, '0');
        }
      } catch {}
    } else if (sharp) {
      try {
        const info = await getImageMeta(fullPath);
        if (info) meta.dimensions = info.width + '×' + info.height;
      } catch {}
    }

    fileMetaCache.set(cacheKey, meta);
    pruneFileMetaCache();
    res.json(meta);
  } catch {
    res.status(500).json({ error: 'failed to read metadata' });
  }
});

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', filePath,
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const data = JSON.parse(stdout);
        const dur = parseFloat(
          (data.format && data.format.duration) ||
          (data.streams && data.streams.find(s => s.codec_type === 'video') || {}).duration
        );
        resolve(isNaN(dur) ? null : dur);
      } catch { reject(new Error('parse error')); }
    });
  });
}

app.get('/files/*', requireAuth, (req, res) => {
  const relPath = decodeURIComponent(req.params[0]);
  const fullPath = sanitizeRelPath(relPath);
  if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).send('not found');
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(fullPath);
});

app.get('/thumb/*', requireAuth, async (req, res) => {
  const relPath = decodeURIComponent(req.params[0]);
  const fullSrcPath = sanitizeRelPath(relPath);
  if (!fullSrcPath || !fs.existsSync(fullSrcPath)) return res.status(404).send('not found');
  const ext = path.extname(relPath).toLowerCase();
  const isVideo = VIDEO_EXT.has(ext);
  try {
    const dest = await ensureThumb(relPath, fullSrcPath, isVideo);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(dest);
  } catch {
    res.status(404).send('thumbnail not available');
  }
});

app.get('/preview/*', requireAuth, async (req, res) => {
  const relPath = decodeURIComponent(req.params[0]);
  const fullSrcPath = sanitizeRelPath(relPath);
  if (!fullSrcPath || !fs.existsSync(fullSrcPath)) return res.status(404).send('not found');
  try {
    const dest = await ensurePreview(relPath, fullSrcPath);
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(dest);
  } catch {
    res.status(404).send('preview not available');
  }
});

app.post('/api/share', requireAuth, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'bad request' });
  const fullPath = sanitizeRelPath(filePath);
  if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'file not found' });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  addShare(token, filePath, expiresAt);
  res.json({ token, url: `/s/${token}`, expiresAt });
});

app.get('/s/:token', (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).sendFile(path.join(__dirname, 'public', 'expired.html'));
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get('/s/:token/file', (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).send('expired');
  const fullPath = sanitizeRelPath(row.file_path);
  if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).send('not found');
  res.sendFile(fullPath);
});

app.get('/s/:token/meta', (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).json({ error: 'expired' });
  const ext = path.extname(row.file_path).toLowerCase();
  res.json({
    name: path.basename(row.file_path),
    type: VIDEO_EXT.has(ext) ? 'video' : 'image',
    expiresAt: row.expires_at,
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log(`  │  stash running                   │`);
  console.log(`  │  → http://localhost:${PORT}                     │`);
  if (!isConfigured()) {
    console.log('  │  first run — open the URL to set up         │');
  }
  console.log('  └─────────────────────────────────────────────┘');
  console.log('');

  if (isConfigured()) {
    const limitEnv = process.env.PREGENERATE_THUMBS_LIMIT;
    const thumbLimit = limitEnv ? Math.max(1, Number.parseInt(limitEnv, 10)) : Infinity;
    pregenerate(getCapturesSnapshot(true), sanitizeRelPath, thumbLimit);
    setInterval(function () {
      pregenerate(getCapturesSnapshot(true), sanitizeRelPath, thumbLimit);
    }, 5 * 60 * 1000);
  }
});

const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const term = require('./term');
const { pregenerate, getImageMeta, setRenderMode, getRenderCapabilities, clearVideoPreviews, thumbAbsPath, previewAbsPath } = require('./thumbs');

const app = express();
const PORT = process.env.PORT || 7117;

function readPositiveIntEnv(name, fallback) {
  const raw = process.env[name];
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function readBooleanEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const lower = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(lower)) return true;
  if (['0', 'false', 'off', 'no'].includes(lower)) return false;
  return fallback;
}

function readSessionCookieSecure() {
  const raw = process.env.SESSION_COOKIE_SECURE;
  if (raw === undefined || raw === '') return process.env.NODE_ENV === 'production';
  const lower = String(raw).trim().toLowerCase();
  if (lower === 'auto') return 'auto';
  if (['1', 'true', 'on', 'yes'].includes(lower)) return true;
  if (['0', 'false', 'off', 'no'].includes(lower)) return false;
  return process.env.NODE_ENV === 'production';
}

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
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session.secret');
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov', '.jxr', '.avif', '.heic', '.heif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const CAPTURE_CACHE_TTL = readPositiveIntEnv('CAPTURE_CACHE_TTL', 5000);
const FILE_META_CACHE_LIMIT = readPositiveIntEnv('FILE_META_CACHE_LIMIT', 500);
const PREGENERATE_THUMBS = readBooleanEnv('PREGENERATE_THUMBS', true);
const PREGENERATE_THUMBS_LIMIT = readPositiveIntEnv('PREGENERATE_THUMBS_LIMIT', Infinity);
const captureCache = {
  key: '',
  stamp: 0,
  value: {},
  inFlight: null,
};
const fileMetaCache = new Map();

function pruneFileMetaCache() {
  while (fileMetaCache.size > FILE_META_CACHE_LIMIT) {
    const oldestKey = fileMetaCache.keys().next().value;
    fileMetaCache.delete(oldestKey);
  }
}

// --- Config ---
let configCache = null;
let configCacheMtime = 0;
function loadConfig() {
  try {
    const mt = fs.statSync(CONFIG_FILE).mtimeMs;
    if (configCache && configCacheMtime === mt) return configCache;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    configCache = parsed;
    configCacheMtime = mt;
    return parsed;
  } catch {
    configCache = null;
    configCacheMtime = 0;
    return null;
  }
}
function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  configCache = cfg;
  try { configCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
}
function safeDecodeURI(s) {
  try { return decodeURIComponent(s); } catch { return null; }
}
function isConfigured() {
  const cfg = loadConfig();
  return cfg && cfg.username && cfg.passwordHash && cfg.capturesPath;
}

function getSessionSecret() {
  const cfg = loadConfig();
  if (cfg && cfg.sessionSecret) return cfg.sessionSecret;
  try {
    if (fs.existsSync(SESSION_SECRET_FILE)) {
      return fs.readFileSync(SESSION_SECRET_FILE, 'utf8').trim();
    }
    const secret = crypto.randomBytes(64).toString('hex');
    fs.writeFileSync(SESSION_SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  } catch {
    return crypto.randomBytes(64).toString('hex');
  }
}

function ensureSessionCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const supplied = req.get('x-csrf-token') || req.body?.csrfToken || req.query?.csrfToken;
  const expected = ensureSessionCsrfToken(req);
  if (!supplied || !expected || supplied !== expected) {
    return res.status(403).json({ error: 'bad csrf token' });
  }
  next();
}

// --- Favorites ---
function loadFavorites() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FAVORITES_FILE, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const cfg = loadConfig();
    if (!cfg || !cfg.capturesPath) return parsed.filter(v => typeof v === 'string');
    const capturesDir = path.resolve(cfg.capturesPath);
    return parsed
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => {
        const full = sanitizeRelPath(v, cfg);
        if (!full) return v.replace(/\\/g, '/');
        return path.relative(capturesDir, full).split(path.sep).join('/');
      });
  }
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
function addShare(token, filePath, absPath, expiresAt) {
  const shares = loadShares();
  shares[token] = {
    file_path: filePath,
    abs_path: absPath,
    expires_at: expiresAt,
    created_at: Date.now(),
  };
  saveShares(shares);
}
const sharesCleanupTimer = setInterval(() => {
  if (!fs.existsSync(SHARES_FILE)) return;
  const shares = loadShares();
  const keys = Object.keys(shares);
  if (keys.length === 0) return;
  let changed = false;
  for (const t of keys) {
    if (shares[t].expires_at < Date.now()) { delete shares[t]; changed = true; }
  }
  if (changed) saveShares(shares);
}, 60 * 60 * 1000);
sharesCleanupTimer.unref();

// --- Middleware ---
// Helmet with CSP that allows our own scripts.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'", "https://static.cloudflareinsights.com"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'", "https://cloudflareinsights.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
// HTML files are only served via explicit routes (which apply auth/redirects);
// block direct fetches like /index.html that would bypass the redirect logic.
app.use((req, res, next) => {
  if (/\.html$/i.test(req.path)) return res.status(404).send('not found');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: readSessionCookieSecure(),
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

const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const shareLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { error: 'Too many share requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Thumbnails/previews are the scroll hot path - auth-gated + 24 h client-cached,
// so the cap is high enough that a gallery scroll through thousands of tiles is fine.
const thumbLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 5000,
  message: { error: 'Too many thumbnail requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const fileMetaLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 2000,
  message: { error: 'Too many metadata requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const fileLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 1000,
  message: { error: 'Too many media requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// --- Helpers ---
function sanitizeRelPath(relPath, cfg) {
  if (typeof relPath !== 'string') return null;
  cfg = cfg || loadConfig();
  if (!cfg || !cfg.capturesPath) return null;
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

function isTruthyFlag(value) {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'on', 'yes'].includes(String(value).trim().toLowerCase());
}

function shouldForceRefresh(req) {
  return isTruthyFlag(req.query.refresh) || isTruthyFlag(req.query.force);
}

function printStartupBanner() {
  const configured = isConfigured();
  const url = `http://localhost:${PORT}`;

  term.writeLine('');
  term.writeLine('  ' + term.accent('STASH'));
  term.writeLine('  ' + term.muted('-----'));
  term.writeLine('  ' + term.muted('URL    ') + term.accent(url));
  term.writeLine(
    '  ' + term.muted(configured ? 'STATUS ' : 'SETUP  ') +
    (configured ? term.success('archive online') : term.warn('first run - open the URL to set up'))
  );
  term.writeLine('');
}

app.get('/api/csrf', (req, res) => {
  res.json({ csrfToken: ensureSessionCsrfToken(req) });
});

const SCAN_GAME_CONCURRENCY = 8;

async function scanCapturesFromDir(capturesDir) {
  let topEntries;
  try {
    topEntries = await fs.promises.readdir(capturesDir, { withFileTypes: true });
  } catch {
    return {};
  }
  const games = topEntries.filter(d => d.isDirectory());
  const result = {};

  let cursor = 0;
  async function worker() {
    while (cursor < games.length) {
      const game = games[cursor++];
      const gameDir = path.join(capturesDir, game.name);
      try {
        const files = await fs.promises.readdir(gameDir);
        const candidates = files.filter(f => ALLOWED_EXT.has(path.extname(f).toLowerCase()));
        const statted = await Promise.all(candidates.map(async f => {
          try {
            const ext = path.extname(f).toLowerCase();
            const stat = await fs.promises.stat(path.join(gameDir, f));
            if (!stat.isFile()) return null;
            return {
              name: f,
              path: `${game.name}/${f}`,
              type: VIDEO_EXT.has(ext) ? 'video' : 'image',
              mtime: stat.mtimeMs,
            };
          } catch { return null; }
        }));
        const good = statted.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
        if (good.length > 0) result[game.name] = good;
      } catch { /* skip unreadable game dir */ }
    }
  }

  const workerCount = Math.min(SCAN_GAME_CONCURRENCY, games.length) || 1;
  await Promise.all(Array.from({ length: workerCount }, worker));
  return result;
}

function getCapturesSnapshot(force = false) {
  const cfg = loadConfig();
  if (!cfg) return Promise.resolve({});
  const capturesDir = path.resolve(cfg.capturesPath);
  const key = capturesDir;
  const now = Date.now();
  if (!force && captureCache.key === key && (now - captureCache.stamp) < CAPTURE_CACHE_TTL) {
    return Promise.resolve(captureCache.value);
  }
  // Coalesce concurrent scans so a burst of requests triggers one scan, not N.
  if (captureCache.inFlight && captureCache.inFlight.key === key) {
    return captureCache.inFlight.promise;
  }
  let promise;
  promise = (async () => {
    try {
      const value = await scanCapturesFromDir(capturesDir);
      // Only write the cache if we're still the active in-flight scan.
      // A concurrent path change or later scan may have taken over; stomping
      // a fresher result would force an unnecessary rescan next request.
      if (captureCache.inFlight && captureCache.inFlight.promise === promise) {
        captureCache.key = key;
        captureCache.stamp = Date.now();
        captureCache.value = value;
      }
      return value;
    } finally {
      if (captureCache.inFlight && captureCache.inFlight.promise === promise) {
        captureCache.inFlight = null;
      }
    }
  })();
  captureCache.inFlight = { key, promise };
  return promise;
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

app.post('/api/setup/check-path', requireSetupNotDone, requireCsrf, (req, res) => {
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

app.post('/api/setup/complete', requireSetupNotDone, requireCsrf, async (req, res) => {
  const { username, password, capturesPath, renderMode } = req.body;
  if (!username || !password || !capturesPath) return res.status(400).json({ error: 'all fields required' });
  const mode = renderMode === 'gpu' ? 'gpu' : 'cpu';
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
  const sessionSecret = getSessionSecret();
  // Re-check after the async bcrypt: another concurrent setup request may have completed
  // while we were hashing. Use the wx flag for a defensive atomic-create.
  if (isConfigured()) return res.status(409).json({ error: 'already configured' });
  const cfg = {
    username: username.trim(),
    passwordHash,
    capturesPath: path.resolve(capturesPath),
    sessionSecret,
    renderMode: mode,
    createdAt: Date.now(),
  };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') return res.status(409).json({ error: 'already configured' });
    return res.status(500).json({ error: 'failed to save config' });
  }
  configCache = cfg;
  try { configCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
  captureCache.stamp = 0;
  captureCache.key = '';
  captureCache.value = {};
  setRenderMode(mode);
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');
  if (req.session.authed) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', loginLimiter, requireCsrf, async (req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'setup not complete' });
  const cfg = loadConfig();
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'missing fields' });
  }
  if (!cfg.passwordHash || typeof cfg.passwordHash !== 'string') {
    return res.status(500).json({ error: 'config corrupted' });
  }
  const userOk = username === cfg.username;
  const passOk = await bcrypt.compare(password, cfg.passwordHash);
  if (!userOk || !passOk) return res.status(401).json({ error: 'wrong username or password' });
  req.session.authed = true;
  ensureSessionCsrfToken(req);
  res.json({ ok: true });
});

app.post('/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/captures', requireAuth, (req, res, next) => {
  if (shouldForceRefresh(req)) return mutationLimiter(req, res, next);
  next();
}, async (req, res) => {
  try { res.json(await getCapturesSnapshot(shouldForceRefresh(req))); }
  catch { res.status(500).json({ error: 'scan failed' }); }
});

app.get('/api/captures/recent', requireAuth, (req, res, next) => {
  if (shouldForceRefresh(req)) return mutationLimiter(req, res, next);
  next();
}, async (req, res) => {
  let snapshot;
  try { snapshot = await getCapturesSnapshot(shouldForceRefresh(req)); }
  catch { return res.status(500).json({ error: 'scan failed' }); }
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 120));

  const gameEntries = Object.entries(snapshot);
  let totalCount = 0;
  // cursors[i] = index of next item in gameEntries[i][1]
  const cursors = new Array(gameEntries.length).fill(0);
  for (const [, files] of gameEntries) totalCount += files.length;

  const result = [];
  const targetCount = Math.min(totalCount, offset + limit);

  for (let n = 0; n < targetCount; n++) {
    let bestGameIdx = -1;
    let bestMtime = -1;

    for (let i = 0; i < gameEntries.length; i++) {
      const files = gameEntries[i][1];
      const cur = cursors[i];
      if (cur < files.length) {
        if (files[cur].mtime > bestMtime) {
          bestMtime = files[cur].mtime;
          bestGameIdx = i;
        }
      }
    }

    if (bestGameIdx === -1) break;

    if (n >= offset) {
      const item = gameEntries[bestGameIdx][1][cursors[bestGameIdx]];
      result.push(Object.assign({}, item, { game: gameEntries[bestGameIdx][0] }));
    }
    cursors[bestGameIdx]++;
  }

  res.json({ total: totalCount, items: result });
});

app.get('/api/captures/version', requireAuth, async (req, res) => {
  let snapshot;
  try { snapshot = await getCapturesSnapshot(shouldForceRefresh(req)); }
  catch { return res.status(500).json({ error: 'scan failed' }); }
  let total = 0;
  let maxMtime = 0;
  for (const files of Object.values(snapshot)) {
    total += files.length;
    if (files.length > 0 && files[0].mtime > maxMtime) maxMtime = files[0].mtime;
  }
  res.json({ total, games: Object.keys(snapshot).length, maxMtime });
});

app.get('/api/config', requireAuth, (req, res) => {
  const cfg = loadConfig();
  res.json({
    username: cfg.username,
    capturesPath: cfg.capturesPath,
    siteUrl: cfg.siteUrl || '',
    renderMode: cfg.renderMode || 'cpu',
  });
});

app.get('/api/render-capabilities', requireAuth, async (req, res) => {
  const cfg = loadConfig();
  try {
    const caps = await getRenderCapabilities();
    res.json({
      available: caps.available.map((e) => ({ name: e.name, label: e.label })),
      best: caps.best ? { name: caps.best.name, label: caps.best.label } : null,
      current: cfg.renderMode || 'cpu',
    });
  } catch {
    res.status(500).json({ error: 'probe failed' });
  }
});

app.post('/api/config/render-mode', requireAuth, mutationLimiter, requireCsrf, async (req, res) => {
  const { mode } = req.body;
  if (mode !== 'cpu' && mode !== 'gpu') return res.status(400).json({ error: 'mode must be cpu or gpu' });
  const cfg = loadConfig();
  const changed = (cfg.renderMode || 'cpu') !== mode;
  cfg.renderMode = mode;
  saveConfig(cfg);
  setRenderMode(mode);
  term.logInfo('render', `mode set to ${mode}`);
  res.json({ ok: true, mode, rerendering: changed });
  if (changed) {
    try {
      const removed = await clearVideoPreviews();
      term.logInfo('render', `cleared ${removed} cached preview(s) - regenerating with ${mode}`);
      pregenerate(await getCapturesSnapshot(true), sanitizeRelPath);
    } catch (err) {
      term.logError('render', `regenerate after mode switch failed: ${err.message}`);
    }
  }
});

app.post('/api/config/path', requireAuth, mutationLimiter, requireCsrf, (req, res) => {
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

app.post('/api/config/url', requireAuth, mutationLimiter, requireCsrf, (req, res) => {
  let { siteUrl } = req.body;
  if (siteUrl && typeof siteUrl === 'string' && siteUrl.trim()) {
    siteUrl = siteUrl.trim().replace(/\/$/, '');
    let parsed;
    try { parsed = new URL(siteUrl); } catch { return res.status(400).json({ error: 'invalid URL' }); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'URL must use http or https' });
    }
  } else {
    siteUrl = '';
  }
  const cfg = loadConfig();
  cfg.siteUrl = siteUrl;
  saveConfig(cfg);
  res.json({ ok: true, siteUrl });
});

app.post('/api/config/password', requireAuth, mutationLimiter, requireCsrf, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = loadConfig();
  const current = typeof currentPassword === 'string' ? currentPassword : '';
  if (!await bcrypt.compare(current, cfg.passwordHash)) {
    return res.status(401).json({ error: 'current password wrong' });
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'new password must be 8+ characters' });
  }
  cfg.passwordHash = await bcrypt.hash(newPassword, 12);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.get('/api/favorites', requireAuth, (req, res) => res.json(loadFavorites()));

app.post('/api/favorites/toggle', requireAuth, mutationLimiter, requireCsrf, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'bad request' });
  const fullPath = sanitizeRelPath(filePath);
  if (!fullPath) return res.status(400).json({ error: 'invalid path' });
  const cfg = loadConfig();
  const canonical = path.relative(path.resolve(cfg.capturesPath), fullPath).split(path.sep).join('/');
  const favs = loadFavorites();
  const idx = favs.indexOf(canonical);
  const starred = idx === -1;
  if (starred) favs.push(canonical);
  else favs.splice(idx, 1);
  saveFavorites(favs);
  res.json({ starred });
});

app.get('/api/file-meta', requireAuth, fileMetaLimiter, async (req, res) => {
  const relPath = req.query.path;
  if (typeof relPath !== 'string' || !relPath) return res.status(400).json({ error: 'no path' });
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
    } else {
      try {
        const info = await getImageMeta(fullPath);
        if (info) meta.dimensions = info.width + 'x' + info.height;
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
        const fmtDur = data.format && data.format.duration;
        const videoStream = Array.isArray(data.streams)
          ? data.streams.find(s => s && s.codec_type === 'video')
          : null;
        const streamDur = videoStream && videoStream.duration;
        const dur = parseFloat(fmtDur || streamDur);
        resolve(Number.isFinite(dur) ? dur : null);
      } catch { reject(new Error('parse error')); }
    });
  });
}

app.get('/files/*', requireAuth, fileLimiter, (req, res) => {
  const relPath = safeDecodeURI(req.params[0]);
  if (relPath == null) return res.status(400).send('bad path');
  const fullPath = sanitizeRelPath(relPath);
  if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).send('not found');
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(fullPath);
});

// Thumbnail and preview routes serve only files that were already rendered
// by pregenerate (at startup, on the 5-minute rescan, or after a mode switch).
// On-demand rendering was removed per user request — everything renders at
// launch. Files added between scans return 404 until the next pregen pass.
app.get('/thumb/*', requireAuth, thumbLimiter, (req, res) => {
  const relPath = safeDecodeURI(req.params[0]);
  if (relPath == null) return res.status(400).send('bad path');
  const fullSrcPath = sanitizeRelPath(relPath);
  if (!fullSrcPath || !fs.existsSync(fullSrcPath)) return res.status(404).send('not found');
  const dest = thumbAbsPath(relPath);
  if (!fs.existsSync(dest)) return res.status(404).send('thumbnail not ready');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(dest);
});

app.get('/preview/*', requireAuth, thumbLimiter, (req, res) => {
  const relPath = safeDecodeURI(req.params[0]);
  if (relPath == null) return res.status(400).send('bad path');
  const fullSrcPath = sanitizeRelPath(relPath);
  if (!fullSrcPath || !fs.existsSync(fullSrcPath)) return res.status(404).send('not found');
  const dest = previewAbsPath(relPath);
  if (!fs.existsSync(dest)) return res.status(404).send('preview not ready');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(dest);
});

app.post('/api/share', requireAuth, shareLimiter, requireCsrf, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'bad request' });
  const fullPath = sanitizeRelPath(filePath);
  if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'file not found' });
  const cfg = loadConfig();
  const canonical = path.relative(path.resolve(cfg.capturesPath), fullPath).split(path.sep).join('/');
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  addShare(token, canonical, fullPath, expiresAt);
  const relUrl = `/s/${token}`;
  res.json({ token, url: cfg.siteUrl ? `${cfg.siteUrl}${relUrl}` : relUrl, expiresAt });
});

app.get('/s/:token', (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).sendFile(path.join(__dirname, 'public', 'expired.html'));
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get('/s/:token/file', (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).send('expired');
  // Prefer the absolute path pinned at share creation (tolerates capturesPath changes).
  // Fall back to re-resolving legacy share records.
  let fullPath = row.abs_path && typeof row.abs_path === 'string' ? row.abs_path : null;
  if (!fullPath) fullPath = sanitizeRelPath(row.file_path);
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
  printStartupBanner();

  if (isConfigured()) {
    const cfg = loadConfig();
    setRenderMode(cfg.renderMode || 'cpu');
    // Warm the encoder probe so the detection line lands in the startup log.
    getRenderCapabilities().catch(() => {});
    if (PREGENERATE_THUMBS) {
      (async () => {
        try { pregenerate(await getCapturesSnapshot(true), sanitizeRelPath, PREGENERATE_THUMBS_LIMIT); }
        catch (err) { term.logError('startup', `initial scan failed: ${err.message}`); }
      })();
      const pregenerateTimer = setInterval(async () => {
        try { pregenerate(await getCapturesSnapshot(true), sanitizeRelPath, PREGENERATE_THUMBS_LIMIT); }
        catch (err) { term.logError('pregen', `scan failed: ${err.message}`); }
      }, 5 * 60 * 1000);
      pregenerateTimer.unref();
    }
  }
});

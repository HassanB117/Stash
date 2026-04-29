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
const { pregenerate, getImageMeta, setRenderMode, getRenderCapabilities, getHardwareDevice, clearVideoPreviews, thumbAbsPath, previewAbsPath } = require('./thumbs');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 7117;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

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

function normalizeRenderMode(mode) {
  // Accept old config/API values from versions that used cpu/gpu names.
  return (mode === 'hardware' || mode === 'gpu') ? 'hardware' : 'software';
}

function normalizeHardwareDevice(device) {
  const value = typeof device === 'string' ? device.trim() : '';
  return value || 'auto';
}

function isLocalHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return lower === 'localhost' || lower === '::1' || lower.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(lower);
}

function normalizeSiteUrl(siteUrl) {
  const trimmed = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  if (!trimmed) return { ok: true, value: '' };
  let parsed;
  try { parsed = new URL(trimmed); } catch { return { ok: false, error: 'invalid URL' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not include credentials' };
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { ok: false, error: 'URL must be an origin only, like https://stash.example.com' };
  }
  if (parsed.protocol !== 'https:' && !isLocalHostname(parsed.hostname) &&
      !readBooleanEnv('ALLOW_INSECURE_SITE_URL', false)) {
    return { ok: false, error: 'public site URL must use https' };
  }
  return { ok: true, value: parsed.origin };
}

function publicHardwareTarget(target) {
  const label = target.deviceLabel ? `${target.label} - ${target.deviceLabel}` : target.label;
  return {
    id: target.id,
    name: target.name,
    label,
  };
}

function getTrustProxySetting() {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === '') return false;
  const lower = String(raw).trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(lower)) return false;
  if (['true', 'on', 'yes'].includes(lower)) return true;
  if (['loopback', 'linklocal', 'uniquelocal'].includes(lower)) return lower;
  if (String(raw).includes(',')) {
    const values = String(raw).split(',').map(v => v.trim()).filter(Boolean);
    if (values.length > 0) return values;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : false;
}
const TRUST_PROXY_SETTING = getTrustProxySetting();
app.set('trust proxy', TRUST_PROXY_SETTING);
const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');
const FAVORITES_FILE = path.join(DATA_DIR, 'favorites.json');
const SESSION_SECRET_FILE = path.join(DATA_DIR, 'session.secret');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const SETUP_TOKEN_FILE = path.join(DATA_DIR, 'setup.token');
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.webm', '.mov', '.jxr', '.avif', '.heic', '.heif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const SHARE_TOKEN_RE = /^[a-f0-9]{64}$/i;
const MAX_REL_PATH_LENGTH = readPositiveIntEnv('MAX_REL_PATH_LENGTH', 4096);
const MIN_PASSWORD_LENGTH = readPositiveIntEnv('MIN_PASSWORD_LENGTH', 12);
const MAX_PASSWORD_LENGTH = readPositiveIntEnv('MAX_PASSWORD_LENGTH', 1024);
const SESSION_MAX_AGE = readPositiveIntEnv('SESSION_MAX_AGE', 7 * 24 * 60 * 60 * 1000);
const REQUIRE_SETUP_TOKEN = readBooleanEnv('REQUIRE_SETUP_TOKEN', true);

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

function writePrivateFileSync(filePath, contents, options = {}) {
  fs.writeFileSync(filePath, contents, Object.assign({ mode: 0o600 }, options));
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function writeJsonFileSync(filePath, value, pretty = false) {
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
  const tmpPath = `${filePath}.${suffix}.tmp`;
  const json = JSON.stringify(value, null, pretty ? 2 : 0);
  writePrivateFileSync(tmpPath, json);
  fs.renameSync(tmpPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch {}
}

function safeCompareSecret(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  return suppliedBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(suppliedBuf, expectedBuf);
}

function validatePassword(password, label = 'password') {
  if (typeof password !== 'string') return `${label} is required`;
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `${label} must be at most ${MAX_PASSWORD_LENGTH} characters`;
  }
  return null;
}

class FileSessionStore extends session.Store {
  constructor(options) {
    super();
    this.dir = options.dir;
    this.ttlMs = options.ttlMs;
    fs.mkdirSync(this.dir, { recursive: true });
    this.pruneTimer = setInterval(() => this.pruneExpired(), 60 * 60 * 1000);
    this.pruneTimer.unref();
  }

  sessionFile(sid) {
    const digest = crypto.createHash('sha256').update(String(sid)).digest('hex');
    return path.join(this.dir, `${digest}.json`);
  }

  getExpires(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    const expires = cookieExpires ? new Date(cookieExpires).getTime() : NaN;
    return Number.isFinite(expires) ? expires : Date.now() + this.ttlMs;
  }

  get(sid, cb) {
    fs.readFile(this.sessionFile(sid), 'utf8', (err, raw) => {
      if (err && err.code === 'ENOENT') return cb(null, null);
      if (err) return cb(err);
      try {
        const row = JSON.parse(raw);
        if (!row || !row.sess || !Number.isFinite(row.expires) || row.expires < Date.now()) {
          return this.destroy(sid, () => cb(null, null));
        }
        return cb(null, row.sess);
      } catch {
        return this.destroy(sid, () => cb(null, null));
      }
    });
  }

  set(sid, sess, cb) {
    try {
      writePrivateFileSync(this.sessionFile(sid), JSON.stringify({
        expires: this.getExpires(sess),
        sess,
      }));
      cb && cb(null);
    } catch (err) {
      cb && cb(err);
    }
  }

  destroy(sid, cb) {
    fs.unlink(this.sessionFile(sid), (err) => {
      if (err && err.code !== 'ENOENT') return cb && cb(err);
      return cb && cb(null);
    });
  }

  touch(sid, sess, cb) {
    this.set(sid, sess, cb);
  }

  pruneExpired() {
    fs.readdir(this.dir, (err, files) => {
      if (err) return;
      files.filter(file => file.endsWith('.json')).forEach((file) => {
        const filePath = path.join(this.dir, file);
        fs.readFile(filePath, 'utf8', (readErr, raw) => {
          if (readErr) return;
          try {
            const row = JSON.parse(raw);
            if (row && Number.isFinite(row.expires) && row.expires >= Date.now()) return;
          } catch {}
          fs.unlink(filePath, () => {});
        });
      });
    });
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
  writeJsonFileSync(CONFIG_FILE, cfg, true);
  configCache = cfg;
  try { configCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
}
function safeDecodeURI(s) {
  return typeof s === 'string' ? s : null;
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
    writePrivateFileSync(SESSION_SECRET_FILE, secret);
    return secret;
  } catch {
    return crypto.randomBytes(64).toString('hex');
  }
}

function getSetupToken() {
  if (!REQUIRE_SETUP_TOKEN || isConfigured()) return null;
  const envToken = typeof process.env.SETUP_TOKEN === 'string' ? process.env.SETUP_TOKEN.trim() : '';
  if (envToken) return envToken;
  try {
    if (fs.existsSync(SETUP_TOKEN_FILE)) {
      const existing = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
      if (existing) return existing;
    }
    const token = crypto.randomBytes(24).toString('hex');
    writePrivateFileSync(SETUP_TOKEN_FILE, token + '\n', { flag: 'wx' });
    return token;
  } catch {
    try {
      const existing = fs.readFileSync(SETUP_TOKEN_FILE, 'utf8').trim();
      if (existing) return existing;
    } catch {}
    return null;
  }
}

function clearGeneratedSetupToken() {
  if (process.env.SETUP_TOKEN) return;
  try { fs.unlinkSync(SETUP_TOKEN_FILE); } catch {}
}

function ensureSessionCsrfToken(req) {
  if (!req.session) return null;
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function requireCsrf(req, res, next) {
  const supplied = req.get('x-csrf-token') || req.body?.csrfToken;
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
function saveFavorites(arr) { writeJsonFileSync(FAVORITES_FILE, arr); }

// --- Shares ---
function loadShares() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  }
  catch { return {}; }
}
function saveShares(s) { writeJsonFileSync(SHARES_FILE, s); }
function isShareToken(token) {
  return typeof token === 'string' && SHARE_TOKEN_RE.test(token);
}
function getShare(token) {
  if (!isShareToken(token)) return null;
  const row = loadShares()[token];
  if (!row || typeof row !== 'object') return null;
  if (typeof row.file_path !== 'string' || !Number.isFinite(row.expires_at)) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}
function addShare(token, filePath, absPath, expiresAt, cfg) {
  const shares = loadShares();
  let rootRealPath = '';
  try { rootRealPath = fs.realpathSync.native(path.resolve(cfg.capturesPath)); } catch {}
  shares[token] = {
    file_path: filePath,
    abs_path: absPath,
    root_real_path: rootRealPath,
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
    const row = shares[t];
    if (!isShareToken(t) || !row || typeof row !== 'object' ||
        !Number.isFinite(row.expires_at) || row.expires_at < Date.now()) {
      delete shares[t];
      changed = true;
    }
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
      baseUri: ["'none'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      mediaSrc: ["'self'"],
      connectSrc: ["'self'"],
    },
  },
  referrerPolicy: { policy: 'same-origin' },
  strictTransportSecurity: IS_PRODUCTION
    ? { maxAge: 15552000, includeSubDomains: true }
    : false,
  crossOriginEmbedderPolicy: false,
}));
app.use((_req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
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
  name: 'stash.sid',
  store: new FileSessionStore({ dir: SESSION_DIR, ttlMs: SESSION_MAX_AGE }),
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: readSessionCookieSecure(),
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE,
  },
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const csrfLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 300,
  message: { error: 'Too many requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  message: { error: 'Too many setup attempts. Try again later.' },
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

const publicShareLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 1000,
  message: { error: 'Too many share requests. Try again later.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// --- Helpers ---
function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !isTraversalPath(relative) && !path.isAbsolute(relative));
}

function isTraversalPath(normalizedPath) {
  return normalizedPath === '..' ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    normalizedPath.startsWith('../') ||
    normalizedPath.startsWith('..\\');
}

function sanitizeRelPath(relPath, cfg) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > MAX_REL_PATH_LENGTH) return null;
  if (relPath.includes('\0') || path.isAbsolute(relPath)) return null;
  cfg = cfg || loadConfig();
  if (!cfg || !cfg.capturesPath) return null;
  const capturesDir = path.resolve(cfg.capturesPath);
  const normalized = path.normalize(relPath);
  if (normalized === '.' || isTraversalPath(normalized) || path.isAbsolute(normalized)) return null;
  const fullPath = path.resolve(capturesDir, normalized);
  if (!isPathInside(capturesDir, fullPath)) return null;
  return fullPath;
}

function resolveCaptureFile(relPath, cfg) {
  cfg = cfg || loadConfig();
  const fullPath = sanitizeRelPath(relPath, cfg);
  if (!fullPath || !ALLOWED_EXT.has(path.extname(fullPath).toLowerCase())) return null;
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return null;
    const capturesReal = fs.realpathSync.native(path.resolve(cfg.capturesPath));
    const fileReal = fs.realpathSync.native(fullPath);
    if (!isPathInside(capturesReal, fileReal)) return null;
    return fileReal;
  } catch {
    return null;
  }
}

function canonicalCaptureRelPath(fullPath, cfg) {
  cfg = cfg || loadConfig();
  const capturesReal = fs.realpathSync.native(path.resolve(cfg.capturesPath));
  const fileReal = fs.realpathSync.native(fullPath);
  if (!isPathInside(capturesReal, fileReal)) return null;
  return path.relative(capturesReal, fileReal).split(path.sep).join('/');
}

function resolveSharedFile(row) {
  let fullPath = null;
  if (row.abs_path && typeof row.abs_path === 'string') {
    fullPath = path.resolve(row.abs_path);
    if (!ALLOWED_EXT.has(path.extname(fullPath).toLowerCase())) return null;
    try {
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return null;
      const fileReal = fs.realpathSync.native(fullPath);
      if (row.root_real_path && typeof row.root_real_path === 'string') {
        const rootReal = fs.realpathSync.native(row.root_real_path);
        if (!isPathInside(rootReal, fileReal)) return null;
      }
      return fileReal;
    } catch {
      return null;
    }
  }
  return resolveCaptureFile(row.file_path);
}

function requireAuth(req, res, next) {
  if (!isConfigured()) {
    if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'setup required' });
    return res.redirect('/setup');
  }
  if (req.session.authed) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: 'unauthorized' });
}

function requireSetupNotDone(req, res, next) {
  if (isConfigured()) return res.status(403).json({ error: 'already configured' });
  next();
}

function requireSetupToken(req, res, next) {
  if (!REQUIRE_SETUP_TOKEN) return next();
  const expected = getSetupToken();
  const supplied = req.get('x-setup-token') || req.body?.setupToken || '';
  if (!expected || !safeCompareSecret(supplied, expected)) {
    return res.status(403).json({ error: 'setup token required' });
  }
  next();
}

function isTruthyFlag(value) {
  if (value === undefined || value === null) return false;
  return ['1', 'true', 'on', 'yes'].includes(String(value).trim().toLowerCase());
}

function shouldForceRefresh(req) {
  return isTruthyFlag(req.query.refresh) || isTruthyFlag(req.query.force);
}

function describeTrustProxy(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return String(value);
}

function describeCookieSecure(value) {
  if (value === true) return 'secure';
  if (value === 'auto') return 'auto';
  return 'off';
}

function printStartupBanner() {
  const configured = isConfigured();
  const url = `http://localhost:${PORT}`;
  const cfg = configured ? loadConfig() : null;
  const rows = [
    { key: 'url', value: url, tone: 'accent' },
    {
      key: 'state',
      value: configured
        ? term.badge('ONLINE', 'success')
        : term.badge('SETUP REQUIRED', 'warn'),
    },
  ];

  if (cfg) {
    const mode = normalizeRenderMode(cfg.renderMode);
    const device = normalizeHardwareDevice(cfg.hardwareDevice);
    rows.push(
      { key: 'render', value: mode === 'hardware' ? `hardware (${device})` : 'software' },
      { key: 'sharing', value: cfg.siteUrl ? cfg.siteUrl : 'public URL not set', tone: cfg.siteUrl ? 'accent' : 'warn' },
    );
  } else {
    rows.push({ key: 'next', value: 'open the URL and complete setup' });
  }

  if (!configured && REQUIRE_SETUP_TOKEN) {
    const setupToken = getSetupToken();
    if (setupToken) {
      rows.push(
        { key: 'token', value: setupToken, tone: 'accent' },
        { key: 'hint', value: 'enter this setup token in the first-run wizard' },
      );
    }
  }

  rows.push(
    { type: 'divider', label: 'security' },
    { key: 'setup', value: REQUIRE_SETUP_TOKEN ? 'token required' : 'token disabled', tone: REQUIRE_SETUP_TOKEN ? 'success' : 'warn' },
    { key: 'cookies', value: describeCookieSecure(readSessionCookieSecure()) },
    { key: 'proxy', value: describeTrustProxy(TRUST_PROXY_SETTING) },
    { key: 'public', value: 'use HTTPS before exposing outside your LAN' },
  );

  term.banner('STASH', rows, { subtitle: 'capture archive server' });
}

app.get('/api/csrf', csrfLimiter, (req, res) => {
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
            const stat = await fs.promises.lstat(path.join(gameDir, f));
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
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/setup', (req, res) => {
  if (isConfigured()) return res.redirect('/login');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.post('/api/setup/check-path', setupLimiter, requireSetupNotDone, requireSetupToken, requireCsrf, (req, res) => {
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

app.post('/api/setup/complete', setupLimiter, requireSetupNotDone, requireSetupToken, requireCsrf, async (req, res) => {
  const { username, password, capturesPath, renderMode, hardwareDevice } = req.body;
  if (!username || !password || !capturesPath) return res.status(400).json({ error: 'all fields required' });
  const mode = normalizeRenderMode(renderMode);
  const device = normalizeHardwareDevice(hardwareDevice);
  if (typeof username !== 'string' || username.length < 2 || username.length > 32) {
    return res.status(400).json({ error: 'username must be 2-32 characters' });
  }
  const passwordError = validatePassword(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
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
    hardwareDevice: device,
    createdAt: Date.now(),
  };
  try {
    writePrivateFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { flag: 'wx' });
  } catch (e) {
    if (e && e.code === 'EEXIST') return res.status(409).json({ error: 'already configured' });
    return res.status(500).json({ error: 'failed to save config' });
  }
  clearGeneratedSetupToken();
  configCache = cfg;
  try { configCacheMtime = fs.statSync(CONFIG_FILE).mtimeMs; } catch {}
  captureCache.stamp = 0;
  captureCache.key = '';
  captureCache.value = {};
  setRenderMode(mode, device);
  res.json({ ok: true });
});

app.get('/login', (req, res) => {
  if (!isConfigured()) return res.redirect('/setup');
  if (req.session.authed) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', loginLimiter, requireCsrf, async (req, res) => {
  if (!isConfigured()) return res.status(400).json({ error: 'setup not complete' });
  const cfg = loadConfig();
  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'missing fields' });
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'password is too long' });
  }
  if (!cfg.passwordHash || typeof cfg.passwordHash !== 'string') {
    return res.status(500).json({ error: 'config corrupted' });
  }
  const userOk = username === cfg.username;
  const passOk = await bcrypt.compare(password, cfg.passwordHash);
  if (!userOk || !passOk) return res.status(401).json({ error: 'wrong username or password' });
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'login failed' });
    req.session.authed = true;
    ensureSessionCsrfToken(req);
    req.session.save((saveErr) => {
      if (saveErr) return res.status(500).json({ error: 'login failed' });
      res.json({ ok: true });
    });
  });
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
    renderMode: normalizeRenderMode(cfg.renderMode),
    hardwareDevice: normalizeHardwareDevice(cfg.hardwareDevice),
  });
});

app.get('/api/render-capabilities', requireAuth, async (req, res) => {
  const cfg = loadConfig();
  try {
    const caps = await getRenderCapabilities();
    res.json({
      available: caps.available.map(publicHardwareTarget),
      best: caps.best ? publicHardwareTarget(caps.best) : null,
      current: normalizeRenderMode(cfg.renderMode),
      hardwareDevice: normalizeHardwareDevice(cfg.hardwareDevice || getHardwareDevice()),
    });
  } catch {
    res.status(500).json({ error: 'probe failed' });
  }
});

app.post('/api/config/render-mode', requireAuth, mutationLimiter, requireCsrf, async (req, res) => {
  const requestedMode = req.body.mode;
  if (!['software', 'hardware', 'cpu', 'gpu'].includes(requestedMode)) {
    return res.status(400).json({ error: 'mode must be software or hardware' });
  }
  const mode = normalizeRenderMode(requestedMode);
  const hardwareDevice = normalizeHardwareDevice(req.body.hardwareDevice);
  const cfg = loadConfig();
  const changed = normalizeRenderMode(cfg.renderMode) !== mode ||
    normalizeHardwareDevice(cfg.hardwareDevice) !== hardwareDevice;
  cfg.renderMode = mode;
  cfg.hardwareDevice = hardwareDevice;
  saveConfig(cfg);
  setRenderMode(mode, hardwareDevice);
  term.logInfo('render', `${term.badge('MODE', 'accent')} ${mode} (${hardwareDevice})`);
  res.json({ ok: true, mode, hardwareDevice, rerendering: changed });
  if (changed) {
    try {
      const removed = await clearVideoPreviews();
      term.logInfo('render', `${term.badge('RESET', 'warn')} cleared ${removed} cached preview(s); regenerating with ${mode}`);
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
  const normalized = normalizeSiteUrl(req.body.siteUrl);
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  const cfg = loadConfig();
  cfg.siteUrl = normalized.value;
  saveConfig(cfg);
  res.json({ ok: true, siteUrl: normalized.value });
});

app.post('/api/config/password', requireAuth, mutationLimiter, requireCsrf, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const cfg = loadConfig();
  const current = typeof currentPassword === 'string' ? currentPassword : '';
  if (current.length > MAX_PASSWORD_LENGTH) {
    return res.status(400).json({ error: 'current password is too long' });
  }
  if (!await bcrypt.compare(current, cfg.passwordHash)) {
    return res.status(401).json({ error: 'current password wrong' });
  }
  const passwordError = validatePassword(newPassword, 'new password');
  if (passwordError) return res.status(400).json({ error: passwordError });
  cfg.passwordHash = await bcrypt.hash(newPassword, 12);
  saveConfig(cfg);
  res.json({ ok: true });
});

app.get('/api/favorites', requireAuth, (req, res) => res.json(loadFavorites()));

app.post('/api/favorites/toggle', requireAuth, mutationLimiter, requireCsrf, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'bad request' });
  const fullPath = resolveCaptureFile(filePath);
  if (!fullPath) return res.status(400).json({ error: 'invalid path' });
  const cfg = loadConfig();
  const canonical = canonicalCaptureRelPath(fullPath, cfg);
  if (!canonical) return res.status(400).json({ error: 'invalid path' });
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
  const fullPath = resolveCaptureFile(relPath);
  if (!fullPath) return res.status(404).json({ error: 'not found' });

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
  const fullPath = resolveCaptureFile(relPath);
  if (!fullPath) return res.status(404).send('not found');
  res.set('Cache-Control', 'private, max-age=3600');
  if (path.extname(fullPath).toLowerCase() === '.jxr') {
    res.set('Content-Type', 'image/vnd.ms-photo');
  }
  res.sendFile(fullPath);
});

// Thumbnail and preview routes serve only files that were already rendered
// by pregenerate (at startup, on the 5-minute rescan, or after a mode switch).
// On-demand rendering was removed per user request — everything renders at
// launch. Files added between scans return 404 until the next pregen pass.
app.get('/thumb/*', requireAuth, thumbLimiter, (req, res) => {
  const relPath = safeDecodeURI(req.params[0]);
  if (relPath == null) return res.status(400).send('bad path');
  const cfg = loadConfig();
  const fullSrcPath = resolveCaptureFile(relPath, cfg);
  if (!fullSrcPath) return res.status(404).send('not found');
  const canonical = canonicalCaptureRelPath(fullSrcPath, cfg);
  if (!canonical) return res.status(404).send('not found');
  const dest = thumbAbsPath(canonical);
  if (!fs.existsSync(dest)) return res.status(404).send('thumbnail not ready');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(dest);
});

app.get('/preview/*', requireAuth, thumbLimiter, (req, res) => {
  const relPath = safeDecodeURI(req.params[0]);
  if (relPath == null) return res.status(400).send('bad path');
  const cfg = loadConfig();
  const fullSrcPath = resolveCaptureFile(relPath, cfg);
  if (!fullSrcPath) return res.status(404).send('not found');
  const canonical = canonicalCaptureRelPath(fullSrcPath, cfg);
  if (!canonical) return res.status(404).send('not found');
  const dest = previewAbsPath(canonical);
  if (!fs.existsSync(dest)) return res.status(404).send('preview not ready');
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(dest);
});

app.post('/api/share', requireAuth, shareLimiter, requireCsrf, (req, res) => {
  const { filePath } = req.body;
  if (!filePath || typeof filePath !== 'string') return res.status(400).json({ error: 'bad request' });
  const fullPath = resolveCaptureFile(filePath);
  if (!fullPath) return res.status(404).json({ error: 'file not found' });
  const cfg = loadConfig();
  const canonical = canonicalCaptureRelPath(fullPath, cfg);
  if (!canonical) return res.status(400).json({ error: 'invalid path' });
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
  addShare(token, canonical, fullPath, expiresAt, cfg);
  const relUrl = `/s/${token}`;
  res.json({ token, url: cfg.siteUrl ? `${cfg.siteUrl}${relUrl}` : relUrl, expiresAt });
});

app.get('/s/:token', publicShareLimiter, (req, res) => {
  const row = getShare(req.params.token);
  res.set('Cache-Control', 'no-store');
  if (!row) return res.status(404).sendFile(path.join(__dirname, 'public', 'expired.html'));
  res.sendFile(path.join(__dirname, 'public', 'share.html'));
});

app.get('/s/:token/file', publicShareLimiter, (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).send('expired');
  const fullPath = resolveSharedFile(row);
  if (!fullPath) return res.status(404).send('not found');
  res.set('Cache-Control', 'private, no-store');
  if (path.extname(fullPath).toLowerCase() === '.jxr') {
    res.set('Content-Type', 'image/vnd.ms-photo');
  }
  res.sendFile(fullPath);
});

app.get('/s/:token/meta', publicShareLimiter, (req, res) => {
  const row = getShare(req.params.token);
  if (!row) return res.status(404).json({ error: 'expired' });
  res.set('Cache-Control', 'no-store');
  const ext = path.extname(row.file_path).toLowerCase();
  res.json({
    name: path.basename(row.file_path),
    type: VIDEO_EXT.has(ext) ? 'video' : 'image',
    expiresAt: row.expires_at,
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const message = err && err.message ? err.message : 'unknown error';
  term.logError('http', `${req.method} ${req.originalUrl}: ${message}`);
  const status = err && Number.isInteger(err.status) && err.status >= 400 ? err.status : 500;
  if (req.accepts('json')) return res.status(status).json({ error: 'internal server error' });
  return res.status(status).type('text/plain').send('internal server error');
});

app.listen(PORT, () => {
  printStartupBanner();

  if (isConfigured()) {
    const cfg = loadConfig();
    setRenderMode(normalizeRenderMode(cfg.renderMode), normalizeHardwareDevice(cfg.hardwareDevice));
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

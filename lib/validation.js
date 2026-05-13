const path = require('path');

function isLocalHostname(hostname) {
  const lower = String(hostname || '').toLowerCase();
  return lower === 'localhost' ||
    lower === '::1' ||
    lower === '[::1]' ||
    lower.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(lower);
}

function normalizeSiteUrl(siteUrl, options = {}) {
  const trimmed = typeof siteUrl === 'string' ? siteUrl.trim() : '';
  if (!trimmed) return { ok: true, value: '' };

  let parsed;
  try { parsed = new URL(trimmed); }
  catch { return { ok: false, error: 'invalid URL' }; }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use http or https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not include credentials' };
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { ok: false, error: 'URL must be an origin only, like https://stash.example.com' };
  }
  if (parsed.protocol !== 'https:' &&
      !isLocalHostname(parsed.hostname) &&
      !options.allowInsecurePublicHttp) {
    return { ok: false, error: 'public site URL must use https' };
  }

  return { ok: true, value: parsed.origin };
}

function validatePassword(password, label = 'password', options = {}) {
  const minLength = options.minLength || 8;
  const maxLength = options.maxLength || 1024;

  if (typeof password !== 'string') return `${label} is required`;
  if (password.length < minLength) {
    return `${label} must be at least ${minLength} characters`;
  }
  if (password.length > maxLength) {
    return `${label} must be at most ${maxLength} characters`;
  }
  return null;
}

function isTraversalPath(normalizedPath) {
  return normalizedPath === '..' ||
    normalizedPath.startsWith(`..${path.sep}`) ||
    normalizedPath.startsWith('../') ||
    normalizedPath.startsWith('..\\');
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !isTraversalPath(relative) && !path.isAbsolute(relative));
}

function resolveSafeRelPath(relPath, capturesPath, options = {}) {
  const maxRelPathLength = options.maxRelPathLength || 4096;
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > maxRelPathLength) return null;
  if (relPath.includes('\0') || path.isAbsolute(relPath)) return null;
  if (!capturesPath) return null;

  const capturesDir = path.resolve(capturesPath);
  const normalized = path.normalize(relPath);
  if (normalized === '.' || isTraversalPath(normalized) || path.isAbsolute(normalized)) return null;

  const fullPath = path.resolve(capturesDir, normalized);
  if (!isPathInside(capturesDir, fullPath)) return null;
  return fullPath;
}

module.exports = {
  isLocalHostname,
  isPathInside,
  normalizeSiteUrl,
  resolveSafeRelPath,
  validatePassword,
};

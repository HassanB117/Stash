const assert = require('assert/strict');
const path = require('path');
const test = require('node:test');
const {
  isPathInside,
  normalizeSiteUrl,
  resolveSafeRelPath,
  validatePassword,
} = require('../lib/validation');

test('normalizeSiteUrl accepts secure public origins', () => {
  assert.deepEqual(normalizeSiteUrl('https://stash.example.com'), {
    ok: true,
    value: 'https://stash.example.com',
  });
});

test('normalizeSiteUrl accepts local http origins', () => {
  assert.deepEqual(normalizeSiteUrl('http://localhost:7117'), {
    ok: true,
    value: 'http://localhost:7117',
  });
  assert.deepEqual(normalizeSiteUrl('http://127.0.0.1:7117'), {
    ok: true,
    value: 'http://127.0.0.1:7117',
  });
});

test('normalizeSiteUrl rejects credentials and non-origin URLs', () => {
  assert.deepEqual(normalizeSiteUrl('https://user:pass@stash.example.com'), {
    ok: false,
    error: 'URL must not include credentials',
  });
  assert.deepEqual(normalizeSiteUrl('https://stash.example.com/path'), {
    ok: false,
    error: 'URL must be an origin only, like https://stash.example.com',
  });
  assert.deepEqual(normalizeSiteUrl('https://stash.example.com?x=1'), {
    ok: false,
    error: 'URL must be an origin only, like https://stash.example.com',
  });
  assert.deepEqual(normalizeSiteUrl('https://stash.example.com#share'), {
    ok: false,
    error: 'URL must be an origin only, like https://stash.example.com',
  });
});

test('normalizeSiteUrl rejects insecure public http by default', () => {
  assert.deepEqual(normalizeSiteUrl('http://stash.example.com'), {
    ok: false,
    error: 'public site URL must use https',
  });
  assert.deepEqual(normalizeSiteUrl('http://stash.example.com', { allowInsecurePublicHttp: true }), {
    ok: true,
    value: 'http://stash.example.com',
  });
});

test('validatePassword enforces required, minimum, maximum, and valid passwords', () => {
  assert.equal(validatePassword(undefined, 'password', { minLength: 8, maxLength: 12 }), 'password is required');
  assert.equal(validatePassword('short', 'password', { minLength: 8, maxLength: 12 }), 'password must be at least 8 characters');
  assert.equal(validatePassword('x'.repeat(13), 'password', { minLength: 8, maxLength: 12 }), 'password must be at most 12 characters');
  assert.equal(validatePassword('longenough', 'password', { minLength: 8, maxLength: 12 }), null);
});

test('resolveSafeRelPath rejects unsafe relative paths', () => {
  const root = path.resolve('captures-root');
  assert.equal(resolveSafeRelPath('../secret.mp4', root), null);
  assert.equal(resolveSafeRelPath(path.resolve(root, 'absolute.mp4'), root), null);
  assert.equal(resolveSafeRelPath('game\0clip.mp4', root), null);
  assert.equal(resolveSafeRelPath('a'.repeat(12), root, { maxRelPathLength: 8 }), null);
});

test('resolveSafeRelPath accepts valid in-root relative paths', () => {
  const root = path.resolve('captures-root');
  assert.equal(
    resolveSafeRelPath('Game/clip.mp4', root),
    path.resolve(root, 'Game', 'clip.mp4')
  );
});

test('isPathInside accepts descendants and rejects siblings', () => {
  const root = path.resolve('captures-root');
  assert.equal(isPathInside(root, path.resolve(root, 'Game', 'clip.mp4')), true);
  assert.equal(isPathInside(root, path.resolve('captures-root-sibling', 'clip.mp4')), false);
});

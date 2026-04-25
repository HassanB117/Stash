# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install   # install dependencies
npm start     # run the server (http://localhost:7117)
```

There is no build step, test suite, or linter configured.

To reset to first-run state: delete `data/config.json` and restart.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | — | Set to `production` to mark session cookies secure |
| `TRUST_PROXY` | `1` | Express trust-proxy setting; set to `false` if not behind a proxy |
| `CAPTURE_CACHE_TTL` | `5000` | Filesystem scan cache TTL in ms |
| `FILE_META_CACHE_LIMIT` | `500` | Max entries in the in-memory file metadata LRU cache |
| `PREGENERATE_THUMBS` | `1` | Pre-generate thumbnails and video previews for the entire library on startup. Set to `0` to disable and render only on request. |
| `PREGENERATE_THUMBS_LIMIT` | unlimited | Optional cap on how many files are processed per pregeneration pass |

## Architecture

**server.js** is the entire backend — a single Express app with no sub-routers. Key sections in order:

1. **Config** (`data/config.json`) — username, bcrypt password hash, captures path, session secret, and `renderMode` (`'cpu'` or `'gpu'`). Read fresh from disk on every request; no in-memory config state. `renderMode` is chosen during first-run setup and changeable from the settings modal.
2. **Shares** (`data/shares.json`) — map of `token → { file_path, expires_at, created_at }`. Tokens are 256-bit random hex, 24-hour TTL, expired tokens are purged hourly.
3. **Favorites** (`data/favorites.json`) — plain array of relative file paths.
4. **Capture scanning** (`getCapturesSnapshot`) — reads the captures directory on each request, with a short in-memory TTL cache. Top-level subdirectories become game galleries; files are sorted newest-first by mtime.
5. **Path sanitization** (`sanitizeRelPath`) — resolves every user-supplied path against the configured captures root and rejects anything that escapes it.
6. **Thumbnail pipeline** (`thumbs.js`) — rendering is exclusively batch: `pregenerate` runs the whole library at startup, on a 5-minute interval for new captures, and after a CPU↔GPU mode switch (which also clears existing previews). `/thumb/*` and `/preview/*` only serve files already on disk — they never render on demand, so a capture added between scans returns 404 until the next pregen pass. Image thumbnails use ffmpeg mjpeg (480px max, even dims); video thumbnails use ffmpeg (seek 1s then 0s fallback). `.jxr` files (Xbox Game Bar HDR captures) are decoded via Windows' built-in WIC JPEG XR codec (WPF `WmpBitmapDecoder` invoked through PowerShell) to a temp PNG before ffmpeg scales them. Progress logs include a `[N/total]` counter during pregen. Thumbnails are cached to `data/thumbs/`. On-demand renders log `[thumb]` / `[vthumb]` / `[render]` lines to the server terminal; errors surface via `[thumb]` / `[vthumb]` / `[preview]` error logs. `probeEncoders` detects available hardware H.264 encoders by running a real 1-frame test encode against each candidate (NVENC → AMF → QSV) at startup — listing-only detection is not used because Windows ffmpeg builds advertise all three regardless of hardware. When `renderMode === 'gpu'`, video previews use that encoder and fall back to CPU if the hardware encode fails.

**Frontend** (`public/`) is plain HTML + vanilla JS with no framework or build tool:
- `app.js` — main gallery UI: three tabs (Recent / Games / Starred), lightbox, share modal, settings modal
- `share.js`, `setup.js`, `login.js` — standalone scripts for their respective pages
- `style.css` — all styles

**API surface:**
- `GET /api/captures` — full capture tree (auth required)
- `GET /files/*`, `GET /thumb/*`, `GET /preview/*` — serve raw files, still thumbnails, and 2-second video previews (auth required)
- `POST /api/share` → `GET /s/:token` — public share link flow (no auth needed to view)
- `/api/favorites/toggle`, `/api/config/*` — settings mutations
- `GET /api/render-capabilities` — lists detected GPU encoders and the current render mode
- `POST /api/config/render-mode` — switch between `'cpu'` and `'gpu'` rendering at runtime

## External dependencies

- **ffmpeg** and **ffprobe** (system binaries) — required for all thumbnailing. `ffmpeg` produces both image (mjpeg) and video thumbnails plus video previews; `ffprobe` reads image dimensions and video duration. If absent, thumbnails and previews return 404 and duration/dimension metadata is omitted.

# Changelog

All notable changes to this project are documented in this file.

Historical dates before this file was added were not reconstructed in detail, so older entries are grouped as baseline releases.

## [1.3.0] — 2026-04-24

### Added

- Manual `REFRESH` action in the main UI to force an immediate library rescan.
- Force-refresh support on capture endpoints so the client can bypass the short scan cache when needed.
- CPU vs GPU render mode with auto-detected hardware encoders (NVENC, AMD AMF, Intel QSV); chosen during first-run setup and changeable from the settings modal.
- `GET /api/render-capabilities` reports detected hardware encoders and the current mode.
- `POST /api/config/render-mode` switches between `cpu` and `gpu` at runtime; a real mode change clears cached previews and triggers a background regenerate with the new encoder.
- `renderMode` field persisted in `data/config.json`.
- Thumbnail and preview renders log to the server terminal with `[thumb]` / `[vthumb]` / `[render]` prefixes, including a `[N/total]` counter during pregeneration.
- Video preview progress bar now shows which encoder ran (`[cpu]` / `[gpu]`).
- Web-based first-run setup for account creation and capture-folder configuration.
- Recent, Games, and Starred gallery views for browsing large capture libraries.
- Lightbox playback for images and video clips, including keyboard navigation.
- Favorites, disposable share links, thumbnail generation, and video hover previews.
- Docker and Compose support for self-hosted deployment.

### Changed

- **Performance:** Optimized the `/api/captures/recent` endpoint using a multi-way merge of pre-sorted game lists. This drastically improves performance for large libraries, reducing complexity from O(N log N) to O(N * numGames).
- **Performance:** Streamlined library versioning by only checking the newest item in each game's sorted list for `maxMtime`.
- **Concurrency:** Refactored the `pregenerate` thumbnailing process to be non-blocking, adding asynchronous breaks to keep the event loop responsive during large library scans.
- Active library views now re-sync cleanly after a refresh or capture-path change.
- The refresh control now shows a busy state while a rescan is in progress.
- Setup wizard is now four steps (Account → Folder → Render → Done) to capture the initial CPU/GPU choice.
- Thumbnail pipeline rewritten to use `ffmpeg` / `ffprobe` for everything (image thumbnails, video thumbnails, previews, and metadata); the optional `sharp` dependency has been removed.
- Startup pregenerates thumbnails and video previews for the entire library by default. `PREGENERATE_THUMBS` now defaults to on, and `PREGENERATE_THUMBS_LIMIT` now defaults to unlimited.
- `/thumb/*` and `/preview/*` endpoints no longer render on demand — they only serve files already produced by pregeneration. Captures added between scans return 404 until the next 5-minute rescan picks them up.

### Fixed

- **Security:** Hardened `/api/captures` and `/api/captures/recent` with rate limiting when `force=1` is requested to prevent DoS via expensive disk scans.
- **Bug:** Fixed a directory misidentification bug where folders named with image/video extensions (e.g., `folder.jpg`) were incorrectly listed as media captures.
- **UI:** Added hour support to the video player duration display for long capture files.
- `.jxr` thumbnails (Xbox Game Bar HDR captures) now render correctly on Windows by decoding through WIC's JPEG XR codec before handing off to ffmpeg; previously these produced no thumbnail because stock ffmpeg builds lack a JPEG XR decoder.
- `PREGENERATE_THUMBS` now correctly controls background thumbnail warming.
- `PREGENERATE_THUMBS_LIMIT` is now enforced for each pregeneration pass.
- Invalid numeric env values now fall back cleanly for cache and pregeneration settings.
- Thumbnail and preview failures now log the underlying ffmpeg error instead of being silently swallowed, so missing tiles are diagnosable.
- GPU preview encodes fall back to CPU automatically on hardware-encode failure, avoiding blank tiles when drivers are stale or sessions are locked.
- GPU encoder detection now runs a real 1-frame test encode against each candidate instead of just trusting `ffmpeg -encoders`; Windows ffmpeg builds ship NVENC/AMF/QSV all enabled, so the old listing-based probe reported NVIDIA on AMD hosts.

### Security

- Password hashing with `bcrypt`.
- Session-based authentication with CSRF protection on non-GET requests.
- Path sanitization for filesystem-backed media access.
- Helmet-based security headers and a restrictive CSP.
- Rate limiting on login, share, media, metadata, and mutation endpoints.

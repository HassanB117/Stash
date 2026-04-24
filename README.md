# stash

A self-hosted gallery for your game captures. Point it at a folder, get a clean web UI, share clips via disposable links.

No uploads. No database. No cloud. Your files stay on your machine — stash just reads them.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Why

Screenshot and clip folders turn into a graveyard. OS file explorers are ugly. Discord compresses everything. Cloud services want your soul. Stash renders your captures as a tiled gallery and lets you hand one off via a link that dies in 24 hours.

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:7117`. The setup wizard asks for:

1. A username
2. A password (8+ characters)
3. The path to your captures folder

No config files to edit by hand.

## Docker

```bash
CAPTURES_PATH=/path/to/your/captures docker compose up -d
```

Open `http://localhost:7117` and enter `/captures` as the captures path in the setup wizard — that's where your host folder is mounted inside the container. App state (config, favorites, share tokens, generated thumbnails) lives in the `stash-data` named volume and survives container restarts.

Override defaults with env vars: `STASH_PORT` (host port), `CAPTURES_PATH` (host captures folder), `TRUST_PROXY` (set to `false` if not behind a proxy).

```bash
docker rm -f stash

docker run -d `
  --name stash `
  -p 7117:7117 `
  -v /path/to/your/captures:/captures `
  -v stash-data:/app/data `
  -e CAPTURES_PATH=/captures `
  -e STASH_PORT=7117 `
  -e TRUST_PROXY=true `
  ghcr.io/hassanb117/stash:latest
```

## Folder layout

One subfolder per game. Stash scans the top level and treats each folder as a gallery:

```
D:/Captures/
|-- Elden Ring/
|   |-- malenia-kill.mp4
|   `-- erdtree.png
|-- Cyberpunk 2077/
|   `-- night-city.jpg
`-- Hollow Knight/
    `-- radiance.webm
```

Drop new files in any time — the UI picks them up on the next 30 s poll (or refresh). Files are sorted newest-first by modified time.

**Supported formats:** `jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov` `jxr` `avif` `heic` `heif`

## Features

- **Recent / Games / Starred tabs** — browse everything at once, by game, or just your favorites. The Recent feed is paginated so thousands of captures scroll smoothly; hit LOAD MORE to pull the next page.
- **Lightbox** — full-screen viewer with keyboard navigation (`←/→` prev/next, `space`/`k` play-pause, `j/l` seek ±5 s, `m` mute, `f` fullscreen, `esc` close).
- **Hover previews** — video tiles play a short silent loop on hover, generated on demand via ffmpeg.
- **Sharing** — open any capture, hit share, copy the link. Recipients need no account. Links expire in 24 hours.
- **Settings** — change your password or swap the captures folder at any time from the UI.

## Sharing outside your network

To share links beyond your home network, the easiest option is a Cloudflare Tunnel (free, no port forwarding, no static IP):

```bash
# install cloudflared: https://github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://localhost:7117
```

You'll get a `*.trycloudflare.com` URL. Share links work through it.

When running behind HTTPS in production, set `NODE_ENV=production` so session cookies are marked secure.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `7117` | HTTP port |
| `NODE_ENV` | — | Set to `production` to mark session cookies secure |
| `TRUST_PROXY` | `1` | Express trust-proxy setting; set to `false` if not behind a proxy |
| `CAPTURE_CACHE_TTL` | `5000` | Filesystem scan cache TTL in ms |
| `FILE_META_CACHE_LIMIT` | `500` | Max entries in the in-memory file metadata LRU cache |
| `PREGENERATE_THUMBS` | — | Set to `1` to pre-generate thumbnails on startup and every 5 minutes afterward |
| `PREGENERATE_THUMBS_LIMIT` | `80` | Cap on thumbnails pre-generated per pass |
| `NO_COLOR` | - | Disable colored terminal output |

## Optional dependencies

- **sharp** — image thumbnail generation. If missing, image thumbnails 404 and the UI shows the full-size image instead.
- **ffmpeg** (system binary) — video thumbnails, hover previews, and duration metadata. If missing, video thumbnails return 404 and duration is omitted.

## Security

- Passwords hashed with **bcrypt** (cost 12)
- Login rate-limited (5 attempts / 15 min per IP)
- Per-endpoint rate limits on media, metadata, and file endpoints — sized so a gallery scroll through thousands of tiles stays well under any cap
- Session cookies `httpOnly` + `sameSite=lax`
- **Helmet** with a strict CSP (no inline scripts)
- CSRF token required on every non-GET API call
- Path traversal blocked via resolved-path checks
- No upload endpoint — captures can only appear via the filesystem
- Share tokens are 256-bit random, single-file scoped, and auto-expiring after 24 h

Don't expose stash directly to the public internet without a tunnel or reverse proxy with HTTPS.

## Scaling notes

Stash is designed for personal libraries but handles large ones fine:

- The Recent tab loads 120 items per page; scroll triggers `LOAD MORE` rather than loading everything up front.
- Filesystem scans run async with a bounded per-game worker pool and are cached for 5 s, so concurrent thumbnail requests don't queue behind a scan.
- A cheap `/api/captures/version` endpoint drives the 30 s change poller — the full library is only refetched when something actually changed.

Tested comfortably into 1k–10k captures on a typical home NAS or SSD.

## Resetting

Delete `data/config.json` and restart. The setup wizard runs again.

## Stack

- Node + Express
- Plain HTML / CSS / vanilla JS (no build step, no framework)
- JSON files for config, share tokens, and favorites (no database)

## License

MIT

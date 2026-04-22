# stash

A dead-simple, self-hosted gallery for your game captures. Point it at a folder, get a clean web UI, share clips with friends via disposable links.

No uploads. No database. No cloud. Your files stay on your machine - stash just reads them.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Why

Screenshot and clip folders turn into a graveyard. OS file explorers are ugly. Discord compresses everything. Cloud services want your soul. Stash shows your captures in a clean gallery and lets you share a single file via a link that dies in 24 hours.

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:7117`. The setup wizard asks for three things:

1. A username
2. A password (8+ characters)
3. The path to your captures folder

No config files to edit by hand.

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

Drop new files in at any time - refresh the page and they appear. Files are sorted newest-first by modified time.

**Supported formats:** `jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov` `jxr` `avif` `heic` `heif`

## Features

- **Recent / Games / Starred tabs** - browse everything at once, by game, or just your favorites
- **Lightbox** - full-screen viewer with keyboard navigation
- **Sharing** - open any capture -> hit share -> copy the link. Recipients need no account. Link expires in 24 hours
- **Settings** - change your password or swap the captures folder at any time from the UI

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
| `NODE_ENV` | - | Set to `production` to mark session cookies secure |
| `TRUST_PROXY` | `1` | Express trust-proxy setting; set to `false` if not behind a proxy |
| `CAPTURE_CACHE_TTL` | `5000` | Filesystem scan cache TTL in ms |
| `FILE_META_CACHE_LIMIT` | `500` | Max entries in the in-memory file metadata LRU cache |
| `PREGENERATE_THUMBS` | - | Set to `1` to pre-generate thumbnails on startup and every 5 minutes afterward |
| `PREGENERATE_THUMBS_LIMIT` | `80` | Cap on thumbnails pre-generated per pre-generation pass |

## Optional dependencies

- **sharp** - image thumbnail generation. If not installed, image thumbnails fall back to 404.
- **ffmpeg** (system binary) - video thumbnails and duration metadata. If absent, video thumbnails return 404 and duration is omitted.

## Security

- Passwords hashed with **bcrypt** (cost 12)
- Login rate-limited (5 attempts / 15 min per IP)
- Session cookies `httpOnly` + `sameSite=lax`
- **Helmet** with a strict CSP (no inline scripts)
- Path traversal blocked via resolved-path checks
- No upload endpoint - captures can only appear via the filesystem
- Share tokens are 256-bit random, single-file scoped, and auto-expiring

Don't expose stash directly to the public internet without a tunnel or reverse proxy with HTTPS.

## Resetting

Delete `data/config.json` and restart. The setup wizard runs again.

## Stack

- Node + Express
- Plain HTML / CSS / vanilla JS (no build step, no framework)
- JSON files for config, share tokens, and favorites (no database)

## License

MIT

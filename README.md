# Stash

A self-hosted gallery for game captures, screenshots, and clips. Point Stash at a folder, browse everything in a fast web UI, favorite the good stuff, and create disposable share links without uploading your files anywhere.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![Docker](https://img.shields.io/badge/docker-ready-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

## What It Does

Stash turns a capture folder into a private media gallery:

- Browse captures by Recent, Games, or Starred.
- Open images and videos in a keyboard-friendly lightbox.
- Generate thumbnails and short video hover previews with ffmpeg.
- Share one capture at a time with random 24-hour links.
- Keep all app state on disk as JSON files. No database required.
- Run locally with Node or self-host with Docker Compose.

Stash does not upload, sync, index into a cloud service, or modify your original capture files.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:7117` and complete the setup wizard:

1. Create a username.
2. Create a password.
3. Choose your captures folder.
4. Pick software or hardware video preview rendering.

## Docker Compose

```bash
CAPTURES_PATH=/path/to/your/captures docker compose up -d
```

Then open `http://localhost:7117`. In the setup wizard, use `/captures` as the captures path. The compose file mounts your host captures folder there as read-only.

App state is stored in the `stash-data` Docker volume:

- `config.json`
- `favorites.json`
- `shares.json`
- generated thumbnails and previews
- session secret

### Docker Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `STASH_PORT` | `7117` | Host port published by Docker Compose |
| `CAPTURES_PATH` | `./captures` | Host folder mounted into the container as `/captures` |
| `TRUST_PROXY` | `1` | Express trust-proxy setting |
| `SESSION_COOKIE_SECURE` | `auto` | Cookie secure mode for Docker: `true`, `false`, or `auto` |

### Docker Run

```bash
docker run -d \
  --name stash \
  -p 7117:7117 \
  -v /path/to/your/captures:/captures:ro \
  -v stash-data:/app/data \
  -e SESSION_COOKIE_SECURE=auto \
  -e TRUST_PROXY=true \
  ghcr.io/hassanb117/stash:latest
```

## Capture Folder Layout

Stash expects one folder per game or category:

```text
Captures/
|-- Elden Ring/
|   |-- malenia-kill.mp4
|   `-- erdtree.png
|-- Cyberpunk 2077/
|   `-- night-city.jpg
`-- Hollow Knight/
    `-- radiance.webm
```

Files are sorted newest-first by modified time. New files appear after the next background poll or manual refresh.

Supported formats:

```text
jpg jpeg png webp gif mp4 webm mov jxr avif heic heif
```

## Features

- Recent feed with pagination for large capture libraries.
- Game-grouped browsing based on top-level folders.
- Starred view backed by a local favorites JSON file.
- Full-screen lightbox for images and videos.
- Video controls for play/pause, seek, mute, fullscreen, and keyboard navigation.
- ffmpeg-generated thumbnails and video previews.
- Software/hardware rendering mode with hardware encoder detection where available.
- Disposable public share links that expire after 24 hours.
- Web settings for password, capture path, site URL, render mode, and hardware device.

## Sharing Outside Your Network

For temporary public sharing, run Stash behind an HTTPS tunnel or reverse proxy. A simple option is Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:7117
```

Set your public tunnel URL in Stash settings so generated share links use the external URL.

Do not expose Stash directly to the public internet over plain HTTP.

## App Environment Variables

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `7117` | HTTP port used by the Node server |
| `NODE_ENV` | empty | Set to `production` for production runtime behavior |
| `TRUST_PROXY` | `1` | Express trust-proxy setting; use `false` if not behind a proxy |
| `SESSION_COOKIE_SECURE` | `NODE_ENV === production` | Session cookie secure mode: `true`, `false`, or `auto` |
| `CAPTURE_CACHE_TTL` | `5000` | Filesystem scan cache TTL in milliseconds |
| `FILE_META_CACHE_LIMIT` | `500` | Max entries in the in-memory metadata cache |
| `PREGENERATE_THUMBS` | `true` | Enable background thumbnail and preview generation |
| `PREGENERATE_THUMBS_LIMIT` | unlimited | Max files processed per pregeneration pass |
| `NO_COLOR` | empty | Disable colored terminal output |

## Requirements

- Node.js 18 or newer.
- ffmpeg and ffprobe available on `PATH` for thumbnails, previews, and video metadata.
- Docker users do not need to install ffmpeg on the host; the image includes it.

### Hardware Encoding in Docker

Docker does not expose hardware encoders to containers by default. Use the
matching override when you want hardware preview rendering:

```bash
# NVIDIA
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d --build

# AMD / Intel on Linux through VAAPI
docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up -d --build
```

For VAAPI, the container uses `/dev/dri/renderD128` unless `VAAPI_DEVICE` is set.
Set `VIDEO_GID` and `RENDER_GID` if your host uses different group IDs for
`/dev/dri`.
If the app still reports software-only, check the startup log for the encoder
probe result; hardware mode intentionally falls back to software when ffmpeg cannot open a
hardware encoder.

JPEG XR (`.jxr`) thumbnail generation uses Windows WIC support when running directly on Windows. In Linux containers, `.jxr` files can still be listed and served, but thumbnail generation depends on decoder support available to ffmpeg.

## Security Model

- Passwords are hashed with bcrypt.
- Login attempts are rate-limited.
- Mutating requests require CSRF tokens.
- File access is restricted to the configured captures folder.
- Share tokens are random, scoped to one file, and expire after 24 hours.
- Helmet sets security headers and a restrictive CSP.
- There is no upload endpoint.

Stash is designed for personal self-hosting. Put it behind HTTPS before exposing it outside your LAN.

## Development

```bash
npm install
npm start
```

Useful checks:

```bash
node --check server.js
node --check thumbs.js
docker build -t stash:local .
docker compose config
```

There is currently no automated test suite.

## Reset Setup

Stop the app, delete `data/config.json`, and start it again. The setup wizard will run on the next visit.

For Docker Compose, the config lives in the `stash-data` volume.

## Stack

- Node.js and Express
- Plain HTML, CSS, and vanilla JavaScript
- ffmpeg / ffprobe for media processing
- JSON files for local state
- Docker and Docker Compose for self-hosted deployment

## License

MIT

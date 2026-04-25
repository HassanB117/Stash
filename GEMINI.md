# GEMINI.md - Stash Project Context

## Project Overview
**Stash** is a dead-simple, self-hosted gallery for game captures. It's built with Node.js and Express, designed to run locally and point to a folder containing game screenshots and clips. It provides a clean web UI for browsing media and sharing them via temporary, auto-expiring links.

### Key Features
- **Zero Database:** Uses local JSON files for configuration, shares, and favorites.
- **Auto-Scanning:** Automatically detects subfolders in the captures directory as games.
- **Media Support:** Supports common image and video formats (`jpg`, `png`, `webp`, `gif`, `mp4`, `webm`, `mov`, `jxr`, `avif`, `heic`, `heif`).
- **Thumbnail Generation:** Automatically generates thumbnails for images (via `sharp`) and videos (via `ffmpeg`).
- **Video Previews:** Generates 2-second hover-previews for video clips.
- **Sharing:** Generates 24-hour disposable links for sharing specific captures.
- **Setup Wizard:** Browser-based initial configuration for username, password, and capture path.

## Architecture
- **Backend:** Node.js + Express.
- **Frontend:** Vanilla HTML, CSS, and JavaScript. No build step or framework required.
- **Security:**
  - Password hashing with `bcryptjs`.
  - Content Security Policy (CSP) via `helmet`.
  - Rate limiting on login, mutations, and media requests.
  - Path traversal protection for file access.
- **Storage:** All application data is stored in the `data/` directory:
  - `config.json`: Project configuration.
  - `favorites.json`: List of starred captures.
  - `shares.json`: Active share tokens and metadata.
  - `session.secret`: Generated secret for session signing.
  - `thumbs/`: Cache directory for generated thumbnails and previews.

## Building and Running

### Prerequisites
- **Node.js**: v18 or higher recommended.
- **sharp**: (Optional, but recommended) For image thumbnail generation.
- **ffmpeg & ffprobe**: Must be installed and available in the system `PATH` for video thumbnails, previews, and duration metadata.

### Commands
- **Install dependencies:** `npm install`
- **Start the server:** `npm start`
- **Default Port:** 7117 (configurable via `PORT` environment variable).

### Environment Variables
- `PORT`: Port to listen on (default: `3000`).
- `NODE_ENV`: Set to `production` for secure cookies.
- `TRUST_PROXY`: Set if running behind a reverse proxy (e.g., Cloudflare Tunnel).
- `CAPTURE_CACHE_TTL`: Filesystem scan cache TTL in ms (default: `5000`).
- `FILE_META_CACHE_LIMIT`: Max entries in metadata cache (default: `500`).
- `PREGENERATE_THUMBS`: Set to `1` to pre-generate thumbnails on startup.
- `PREGENERATE_THUMBS_LIMIT`: Cap on startup pre-generation (default: `80`).

## Development Conventions
- **Direct File Access:** The app serves files directly from the configured `capturesPath`.
- **Thumbnail Naming:** Thumbnails and previews follow a strict naming convention in `data/thumbs/` based on their relative path from the captures root.
- **Frontend:** Interaction is handled via `fetch` calls to `/api/*` endpoints. UI state is managed in `public/app.js`.
- **Error Handling:** Backend returns JSON error objects `{ error: 'message' }`.

## Key Files
- `server.js`: Main application logic, API routing, and configuration management.
- `thumbs.js`: Media processing logic (sharp/ffmpeg integration).
- `public/index.html`: Main gallery interface.
- `public/app.js`: Frontend logic for gallery rendering, lightbox, and settings.
- `public/style.css`: Comprehensive styling for the gallery (dark mode oriented).

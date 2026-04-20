# stash

A dead-simple, self-hosted gallery for your game captures. Point it at a folder, get a clean web UI, share clips with friends via disposable links. That's it.

No uploads. No database. No cloud. Your files stay on your machine — stash just reads them.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## Why

Screenshot and clip folders turn into a graveyard. OS file explorers are ugly. Discord compresses your stuff into oblivion. Cloud services want your soul. Stash just shows your captures in a decent gallery and lets you share a single file with a link that dies in 24 hours.

## Quick start

```bash
npm install
npm start
```

Open `http://localhost:3000`. The setup wizard asks for three things:

1. A username
2. A password (8+ chars)
3. The path to your captures folder

Done. No config files to edit.

## Folder layout

One subfolder per game. Stash scans the top level and treats each folder as a gallery:

```
D:/Captures/
├── Elden Ring/
│   ├── malenia-kill.mp4
│   └── erdtree.png
├── Cyberpunk 2077/
│   └── night-city.jpg
└── Hollow Knight/
    └── radiance.webm
```

Drop new files in whenever. Refresh the page, they show up. Files are sorted newest-first by modified time.

**Supported:** `jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov`

## Sharing clips

Open any capture → hit **share** → copy the link. The recipient doesn't need an account. Link self-destructs after 24 hours.

To share outside your home network, the easiest route is Cloudflare Tunnel (free, no port forwarding, no static IP needed):

```bash
# install cloudflared first: https://github.com/cloudflare/cloudflared/releases
cloudflared tunnel --url http://localhost:3000
```

You'll get a `*.trycloudflare.com` URL. Share links work through it.

> When running behind HTTPS in production, set `NODE_ENV=production` so session cookies are marked secure.

## Settings

Click **settings** in the top bar to change your password or swap the captures folder. No need to touch files.

## Resetting

Delete `data/config.json` and restart. The setup wizard runs again.

## Security

Not a toy — this actually has decent hygiene:

- Passwords hashed with **bcrypt** (cost 12)
- Login rate-limited (5 attempts / 15 min / IP)
- Session cookies `httpOnly` + `sameSite=lax`
- **Helmet** with a strict CSP (no inline scripts)
- Path traversal blocked via resolved-path checks
- No upload endpoint exists — captures can only appear via the filesystem
- Share tokens are 256-bit random, single-file scoped, auto-expiring

That said: don't expose it to the public internet without a tunnel or reverse proxy with HTTPS.

## Stack

- Node + Express
- Plain HTML/CSS/vanilla JS frontend (no build step, no framework)
- JSON files for config and share tokens (no database)

## License

MIT

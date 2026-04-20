# stash

A dead-simple, self-hosted gallery for your game captures.
Point it at a folder → get a clean web UI → share clips with disposable links.

**No uploads. No database. No cloud.**
Your files stay on your machine — stash just reads them.

![Node](https://img.shields.io/badge/node-%3E%3D18-green)
![License](https://img.shields.io/badge/license-MIT-blue)

---

## ✨ What it does

* 📂 Turns your capture folders into a clean gallery
* 🎮 One folder = one game
* 🔗 Share any file with a temporary link (24h expiry)
* ⚡ Instant setup — no config files, no build step
* 🔒 Local-first: nothing leaves your machine unless *you* share it

---

## 🤔 Why

Screenshot folders turn into a graveyard.
File explorers are clunky.
Discord compresses everything into mush.
Cloud services want accounts, uploads, and your patience.

**stash just works:**

> Browse your captures locally and share a clip in seconds.

---

## 🚀 Quick start

```bash
npm install
npm start
```

Open:
`http://localhost:3000`

The setup wizard asks for:

1. Username
2. Password (8+ chars)
3. Path to your captures folder

Done.

---

## 📁 Folder layout

One subfolder per game:

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

* New files appear on refresh
* Sorted newest-first (by modified time)

**Supported formats:**
`jpg` `jpeg` `png` `webp` `gif` `mp4` `webm` `mov`

---

## 🔗 Sharing

Open any capture → hit **share** → copy link.
No account needed for the recipient.

* Links expire automatically after **24 hours**
* Each link is scoped to a single file

### 🌐 Sharing outside your network

Use Cloudflare Tunnel (no port forwarding needed):

```bash
cloudflared tunnel --url http://localhost:3000
```

You’ll get a `*.trycloudflare.com` URL.

> If running behind HTTPS, set `NODE_ENV=production` to enable secure cookies.

---

## ⚙️ Settings

Use the **Settings** page to:

* Change password
* Switch capture folder

No manual config editing needed.

---

## ♻️ Reset

Delete:

```
data/config.json
```

Then restart — setup wizard will run again.

---

## 🔒 Security

This isn’t just thrown together — it has solid basics:

* Passwords hashed with **bcrypt** (cost 12)
* Login rate limiting (5 attempts / 15 min / IP)
* Session cookies: `httpOnly`, `sameSite=lax`
* **Helmet** with strict CSP (no inline scripts)
* Path traversal protection
* No upload endpoint (filesystem-only access)
* Share tokens:

  * 256-bit random
  * Single-file scoped
  * Auto-expiring

> ⚠️ Don’t expose directly to the public internet without HTTPS (use a tunnel or reverse proxy).

---

## 🧱 Stack

* Node.js + Express
* Vanilla HTML/CSS/JS (no framework, no build step)
* JSON storage (no database)

---

## 🧠 Philosophy

* Keep it simple
* Avoid unnecessary dependencies
* Local-first always
* Fast startup > feature bloat

---

## 🛣️ Roadmap (maybe)

* Auto-cleanup for expired shares
* Smarter folder indexing / caching
* Faster thumbnail generation
* Docker support

---

## 📜 License

MIT

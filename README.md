# captures

Personal game capture gallery. Drop game folders, share clips, done.

## Setup (2 commands)

```
npm install
npm start
```

Open `http://localhost:3000` and the setup wizard guides you through:

1. Pick a username + password
2. Paste the path to your captures folder
3. Done

That's it. No config files, no editing scripts.

## How it works

Your captures folder should look like this — one subfolder per game:

```
YourCapturesFolder/
  Elden Ring/
    boss-kill.mp4
    sunset.png
  Cyberpunk 2077/
    night-city.jpg
```

Drop new files in anytime — refresh the page and they show up.

**Supported files:** jpg, jpeg, png, webp, gif, mp4, webm, mov

## Sharing clips with friends

Open any capture → click **share** → copy the link. Link works for 24 hours, then dies. Friends don't need a password.

For friends to access links from outside your home network, run **Cloudflare Tunnel**:

1. Install cloudflared: https://github.com/cloudflare/cloudflared/releases
2. Run: `cloudflared tunnel --url http://localhost:3000`
3. You get a public `*.trycloudflare.com` URL — share links work through it.

When running behind HTTPS, set `NODE_ENV=production` in the environment so cookies stay secure.

## Changing things later

Click **settings** in the top bar. You can change your password and the captures folder path from the web UI.

## Resetting everything

Delete `data/config.json` and restart the server. The setup wizard runs again.

## Security

- Passwords bcrypt-hashed (cost 12)
- Login rate-limited (5 tries / 15 min per IP)
- Session cookies httpOnly + sameSite=lax
- Helmet sets CSP and other security headers
- Path traversal blocked
- No upload UI exists

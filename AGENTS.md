# Repository Guidelines

## Project Structure & Module Organization

`server.js` is the main Express server and API entry point. `thumbs.js` handles thumbnail/preview generation and media metadata helpers. Static frontend files live in `public/` (`app.js`, `login.js`, `setup.js`, HTML pages, and `style.css`). Runtime data such as config, shares, favorites, and generated thumbnails are stored under `data/` at runtime and should not be committed.

## Build, Test, and Development Commands

- `npm install`: install server dependencies.
- `npm start`: run the app locally on `http://localhost:3000`.
- `node --check server.js`: quick syntax check for backend changes.
- `node --check thumbs.js`: quick syntax check for thumbnail pipeline changes.

There is currently no `npm test` script or build step.

## Coding Style & Naming Conventions

Use plain JavaScript with 2-space indentation and semicolons, matching the existing files. Prefer `camelCase` for variables/functions, `UPPER_SNAKE_CASE` for constants like `VIDEO_EXT`, and clear route names such as `/api/config/password`. Keep frontend code framework-free and colocated in `public/` by page or feature. Avoid inline scripts and handlers in HTML; keep behavior in `.js` files so CSP stays simple.

## Testing Guidelines

This repository does not include an automated test framework yet. For now, verify changes by:

- running `node --check` on edited JS files,
- starting the app with `npm start`,
- exercising the affected flow manually in the browser.

For UI or share-link changes, confirm login, setup, gallery refresh, favorites, and shared media still work. If you add tests later, place them in a dedicated `tests/` folder and wire them into `package.json`.

## Commit & Pull Request Guidelines

Recent commits use short, informal subjects (`improve`, `better things`). Keep commit messages brief, imperative, and specific, for example: `fix share page html injection`. PRs should include a short summary, the user-visible impact, any config/env changes, and screenshots for UI changes.

## Security & Configuration Tips

Do not commit `data/` contents, secrets, or local capture paths. Respect path sanitization and CSRF protections when changing routes. If you touch sharing, auth, CSP, or file-serving logic, call out the security impact explicitly in the PR.

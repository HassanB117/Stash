## [1.4.1] - 2026-05-13

### Highlights
- Cleaned up the gallery codebase without changing the app's public behavior.
- Fixed the Games tab card layout and the Recent tab footer behavior.
- Added a lightweight verification workflow for syntax checks and Node's built-in test runner.

### Added
- Added `npm run check`, `npm test`, and `npm run verify` for repeatable local verification.
- Added focused `node:test` coverage for URL validation, password validation, and capture path safety.
- Added pure validation/path helper coverage so security-sensitive checks can be tested without starting the server.

### Changed
- Made `server.js` importable by exporting `app` and `startServer()`, while keeping `npm start` behavior the same.
- Updated development docs to describe the new verification workflow.
- Bumped static asset cache-busters for CSS and browser scripts so browsers and edge caches load the matching frontend files after upgrade and visual polish updates.

### Fixed
- Fixed Games tab cards rendering as collapsed or thin strips by consolidating card/grid CSS around responsive 16:10 artwork.
- Fixed hidden game card metadata so game name, capture count, and date remain visible below thumbnails.
- Fixed the Recent tab "LOAD MORE" footer so it appears at the natural end of the gallery instead of staying pinned to the viewport.
- Fixed a stale-cache upgrade issue where new HTML could load an old cached `app.js`, causing the Games tab to stop before rendering cards.
- Fixed Games search field alignment by moving the search icon to the right side of the input.
- Tightened video duration badges so the play icon and duration text sit on a smaller, cleaner baseline.
- Rebuilt lightbox previous/next controls with centered SVG chevrons so both arrows align visually in the middle of their buttons.

### Removed
- Removed the unused hidden filters DOM/JS/CSS flow that was kept only for compatibility with old `renderFilters()` code.
- Removed the tracked zero-byte `testwrite` scratch artifact.
- Added `.claude/` to `.gitignore` so local assistant settings stay out of version control.

### Verification
- `npm run verify`
- `docker compose config`
- HTTP smoke check for `/healthz`, `/login`, `/api/version`, and cache-busted `/app.js`

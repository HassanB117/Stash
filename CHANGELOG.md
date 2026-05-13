# Changelog

## 1.4.1 - 2026-05-13

### Fixed
- Restored Games tab rendering after the cleanup pass by cache-busting the browser bundle loaded by the main app page.
- Tightened gallery UI alignment for the search icon, lightbox navigation arrows, and video duration badge.
- Replaced the old favicon with a dark-theme capture mark and refined the center media glyph so the play icon is centered.

### Changed
- Removed stale hidden filter UI and related unused browser code while keeping Recent, Games, Starred, and platform pill behavior unchanged.
- Added a small verification workflow with `npm run check`, `npm test`, and `npm run verify`.
- Refactored server startup so the Express app can be imported by tests without changing route behavior.
- Extracted validation and path-safety helpers for focused unit coverage.
- Updated development notes to describe the new check and test workflow.

### Verified
- `npm run verify`
- `docker compose config`

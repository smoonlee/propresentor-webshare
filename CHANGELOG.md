# Changelog

All notable changes to ProPresenter WebShare are documented in this file.

The release workflow adds an entry whenever it publishes a validated npm Dependabot update.

## [Unreleased]

## [1.1.0] - 2026-07-12

### Added

- **Permission controls** — per-site toggles in Settings for camera/microphone, location, and notifications (previously all were silently denied).
- **Launch on startup** — checkbox in Settings to register the app as a Windows login item; takes effect immediately on save.
- **Enter to save** — pressing Enter anywhere in the Settings panel now triggers Save (except when focus is on a button).

### Fixed

- Unhandled `server.ready` rejection now shows an error dialog if the port is already in use.
- `apply-settings` (live preview) no longer echoes unsanitized values back to the renderer.
- Diagnostics overlay interval was not cleared on window close, causing a dangling timer.
- `bindAddress` accepted any arbitrary string; it now requires a valid IPv4 address or `localhost`.
- `allowpopups` attribute removed from the webview; popup URLs are now routed through `shell.openExternal` after a protocol check.
- Overlapping `capturePage()` calls are now blocked by a guard flag to prevent frame pile-up.
- LAN IP socket was recreated on every call; it is now cached after the first successful lookup.
- `alert()` in the renderer (crashed webview handler) replaced with a silent reset to avoid blocking the UI.

## [1.0.1] - 2026-03-16

### Added

- Automated validation, release, and changelog workflow for npm Dependabot updates.

# Changelog

All notable changes to ProPresenter WebShare are documented in this file.

The release workflow adds an entry whenever it publishes a validated npm Dependabot update.

## [Unreleased]

## [1.3.0] - 2026-07-12

### Added

- **H.264 streaming** — default stream mode; frames are encoded to fragmented MP4 via ffmpeg and delivered over WebSocket to a MediaSource Extensions `<video>` element in the viewer. Hardware encoders (NVENC, QSV, AMF) are auto-detected at startup with automatic fallback to libx264 (software).
- **Dual stream modes** — Settings → Streaming lets the operator switch between H.264 (low-latency, hardware-accelerated) and JPEG (maximum compatibility). Mode changes apply live.
- **Encoder info** — Settings → Streaming shows which H.264 encoder is in use after detection completes.
- **MSE buffer management** — viewer trims the SourceBuffer to at most 5 seconds to prevent unbounded memory growth.
- **Init-segment seeding** — late-joining viewers receive the MP4 initialisation segment (ftyp+moov) before live fragments so the MSE SourceBuffer decodes immediately.
- **ffmpeg-static** bundled — static ffmpeg binary (~70 MB) included via `asarUnpack`; no separate install required.

### Fixed

- **H.264 stderr deadlock** — ffmpeg's stderr pipe was never drained; the OS buffer filled and blocked ffmpeg. Stderr is now consumed continuously and logged.
- **NVENC probe resolution** — encoder availability probe used a 64×64 test frame, below NVENC's minimum supported dimension. Fixed to 320×240; GPU encoders now detect correctly.
- **Codec/profile string mismatch** — MSE codec string `avc1.4D4028` (Main Profile) did not match ffmpeg's default High Profile output. All encoders now explicitly set `-profile:v high -level 4.0 -pix_fmt yuv420p` and the codec string is `avc1.640028`.
- **Viewer `mode` race** — `mode` was set before `setupMSE()` ran `teardownH264()` internally, resetting it to `null`. All subsequent binary H.264 fragments were silently discarded. `mode` is now assigned after `setupMSE()` returns.
- **Zero-dimension frame guard** — capture loop now skips frames where width or height is 0 (webview not yet rendered), preventing ffmpeg from receiving invalid raw input.
- **Encoder-specific options leak** — `-keyint_min` and `-sc_threshold 0` are libx264-only flags; passing them to hardware encoders caused silent warnings. They are now conditionally applied only when `libx264` is selected.

## [1.2.0] - 2026-07-12

### Added

- **Update checker** — app silently checks for a newer GitHub release 10 seconds after launch; an amber banner appears if one is available with a direct Download link.
- **Manual update check** — Settings → About section now shows the current version and a "Check for updates" button.

### Changed

- **Settings panel redesign** — section headers changed from red to a calm steel-blue accent; each section grouped in a subtle card; labels, inputs, and buttons refined for better spacing and readability; toggles now pin to the right edge of each row.

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

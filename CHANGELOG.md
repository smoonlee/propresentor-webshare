# Changelog

All notable changes to ProPresenter WebShare are documented in this file.

The release workflow adds an entry whenever it publishes a validated npm Dependabot update.

## [Unreleased]

## [1.6.0] - 2026-07-14

### Added

- **Audio streaming** — enable in Settings → Streaming → Audio loopback. Captures system audio via Windows WASAPI loopback (`getDisplayMedia` + Chromium's built-in loopback), encodes as WebM/Opus (200 ms chunks) using the browser's native `MediaRecorder`, and streams to viewers via HTTP chunked transfer (`/webshare/audio`). No external software, virtual audio cable, or system-installed ffmpeg required.
- **Browser unmute button** — remote viewers see a "🔇 Tap to enable audio" button that appears once the server confirms audio is flowing. Clicking satisfies the browser autoplay policy and starts playback. The button does not reappear after dismissal.
- **Audio pre-warm** — a brief inaudible white-noise pulse plays at app startup to wake the Windows audio endpoint, reducing WASAPI loopback initialisation delay.
- **QR code** — a **QR** button in the status bar generates a scannable code for the viewer URL (`http://<LAN IP>:<port>/webshare`). Eliminates manual URL typing on phones and tablets.

### Changed

- **Single WebSocket server** — removed the unused `/webshare/ws-audio` WebSocket server. Audio is delivered exclusively via HTTP chunked streaming which is more compatible with mobile browsers.
- **Cache-busting** — the viewer page is now served with `Cache-Control: no-store` so phone/tablet browsers always load the latest code after an app update.

### Fixed

- **WebSocket write EOF crash** — added `ws.on('error', ...)` handler on each viewer connection so that asynchronous write failures are silently absorbed instead of propagating as an uncaught main-process exception.
- **ArrayBuffer IPC handling** — Electron IPC delivers `ArrayBuffer` (not `Buffer`) from the renderer; the main process now converts immediately to avoid silent failures in EBML header detection.

### Notes

- Audio is captured from the Windows default playback device (WASAPI loopback). Only audio routed through that device is captured.
- WASAPI loopback may take a few seconds to warm up after the app starts before audio flows.
- Safari/iOS does not support `audio/webm;codecs=opus` — those viewers receive video only.

## [1.5.3] - 2026-07-12

### Fixed

- **WebSocket write EOF crash** — added `ws.on('error', ...)` handler on each viewer connection so that asynchronous write failures (e.g. client disconnecting mid-frame at high fps or JPEG quality 100) are silently absorbed instead of propagating as an uncaught main-process exception.

## [1.5.2] - 2026-07-12

### Fixed

- **Node.js engines constraint** — corrected overly strict `>=26.5.0` floor (introduced in v1.4.0) to `>=26`, removing the `EBADENGINE` warning on Node.js 26.4.x.

## [1.5.1] - 2026-07-12

### Fixed

- **Update check retry** — the automatic update check (10 s after launch) now retries once after 60 s when a network error occurs. This fixes the check silently failing on virtual machines where the network stack is not yet ready at startup.

## [1.5.0] - 2026-07-12

### Added

- **Code signing** — installer is now signed via Azure Trusted Signing when the required repository secrets are configured (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_CODE_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`, `AZURE_TRUSTED_SIGNING_PROFILE_NAME`). The signing step is skipped gracefully if secrets are absent, so unsigned builds continue to work.
- **Publisher name** — NSIS installer metadata now records the publisher name, replacing the "Unknown" entry shown in Windows Programs and Features and UAC prompts.

## [1.4.0] - 2026-07-12

### Changed

- **Node.js 26** — minimum runtime updated from v18 to v26; all CI/CD workflows updated to Node.js 26.

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

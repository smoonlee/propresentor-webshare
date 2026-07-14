# Changelog

All notable changes to ProPresenter WebShare are documented in this file.

The release workflow adds an entry whenever it publishes a validated npm Dependabot update.

## [Unreleased]

## [1.6.4] - 2026-07-13

### Changed

- **Native audio loopback via Electron `getDisplayMedia`** — removed all ffmpeg-based audio capture (WASAPI / DirectShow). Audio is now captured entirely through Chromium's built-in WASAPI loopback by calling `navigator.mediaDevices.getDisplayMedia({ audio: true })` in the Electron renderer; `session.setDisplayMediaRequestHandler` intercepts the call and provides `audio: 'loopback'` without any system dialog. Encoded as WebM/Opus using the browser's native `MediaRecorder` (500 ms chunks) and relayed to browsers via HTTP chunked streaming (`/webshare/audio`). No external software, no virtual audio cable, and no system-installed ffmpeg required. Safari/iOS does not support `audio/webm;codecs=opus` and will receive video only.
- **Separate audio HTTP stream** — browser viewers connect to `/webshare/audio` (HTTP chunked) for audio and receive a “Tap to enable audio” button once the EBML init segment is parsed. Video (`/webshare/ws`) is unchanged.
- **Audio device dropdown removed** — the device-selection UI is no longer needed; only an Audio loopback ON/OFF toggle remains.

### Fixed

- **`ws` dual-server path conflict** — using two `WebSocketServer` instances with `path` filtering on the same HTTP server caused each server to call `abortHandshake(400)` and destroy sockets owned by the other. The audio server now uses `noServer: true` with a manual `upgrade` router, matching the pattern recommended in the `ws` README.

### Changed

- **Auto-detect system ffmpeg with WASAPI** — `getFfmpegPath()` now checks `PATH` for a system-installed ffmpeg (e.g. `winget install Gyan.FFmpeg`) before falling back to the bundled essentials build. If a full-build ffmpeg with WASAPI support is found, it is used for all encoding and device listing. This means audio loopback just works after installing the full ffmpeg, with no manual configuration. The amber warning in Settings is only shown when no WASAPI-capable ffmpeg is available.

## [1.6.2] - 2026-07-12

### Changed

- **Audio capture: WASAPI → dshow fallback** — the bundled `ffmpeg-static` is the essentials build which does not include WASAPI (needed for system audio loopback). `listAudioDevices()` now detects which formats the ffmpeg binary supports at runtime: WASAPI is used when available (full build), otherwise DirectShow devices are listed (useful when "Stereo Mix" or a virtual audio cable is present). The `-loopback` WASAPI flag is reordered to appear immediately after `-f wasapi` for more reliable option parsing.

### Added

- **Audio settings note** — when only DirectShow is available (essentials build), a yellow warning is shown below the audio device dropdown explaining that system audio loopback requires either the full ffmpeg build (`winget install Gyan.FFmpeg`) or Stereo Mix enabled in Windows Sound settings.

## [1.6.1] - 2026-07-12

### Fixed

- **ffmpeg stdin write EOF crash** — when ffmpeg exits (e.g. WASAPI loopback fails to open or the audio device is unavailable), the capture loop emits an unhandled `'error'` event on `ffmpegProc.stdin` as it tries to write the next frame. Added `ffmpegProc.stdin.on('error', () => {})` to absorb these asynchronous write errors, matching the same fix applied to WebSocket sends in v1.5.3.

## [1.6.0] - 2026-07-12

### Added

- **Audio streaming (H.264 mode)** — the H.264 pipeline can now capture and mux system audio alongside video. Enable in Settings → Streaming → Audio, then select your Windows output device (WASAPI loopback). Viewers hear live audio in their browser; a "Tap to enable audio" button appears if the browser blocks autoplay with sound. Audio is disabled in JPEG mode.
- **QR code** — a **QR** button in the status bar generates a scannable code for the viewer URL (`http://<LAN IP>:<port>/webshare`). Eliminates manual URL typing on phones and tablets.

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

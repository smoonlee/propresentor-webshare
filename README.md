# ProPresenter WebShare

An Electron desktop app that loads any web page, captures it, and streams it live (H.264 via hardware-accelerated ffmpeg, or JPEG) over WebSocket at `http://<LAN-IP>:4983/webshare` — ready for ProPresenter (or any browser) to display.

## How It Works

```
┌──────────────┐                  ┌──────────────┐   WebSocket    ┌───────────────────┐
│  Web Page    │   capturePage()  │  Electron App │  ──────────►  │  /webshare viewer │
│  (webview)   │  ─────────────►  │  (operator)   │               │  (ProPresenter /  │
└──────────────┘                  └──────────────┘                │   any browser)    │
                                                                  └───────────────────┘
```

1. **Operator** navigates to a URL inside the app's built-in browser (webview).
2. **Capture loop** grabs frames via `capturePage()` at a configurable FPS and encodes them — H.264 fragmented MP4 (via ffmpeg, GPU-accelerated when available) or JPEG.
3. **Express + WebSocket server** streams the encoded data to all connected viewers.
4. **ProPresenter** (or any browser on the LAN) loads the viewer URL to see the live feed.

## Features

- **H.264 hardware-accelerated streaming** — NVENC (NVIDIA), QSV (Intel), AMF (AMD), with automatic fallback to libx264 (CPU); played back via MediaSource Extensions in the viewer
- **Dual stream modes** — H.264 (low-latency, hardware-accelerated) or JPEG (maximum compatibility), switchable live from Settings
- **Encoder auto-detection** — available H.264 encoders are probed at startup; active encoder shown in Settings
- Configurable capture FPS (1–60) and JPEG quality (10–100)
- Frame deduplication — identical frames are skipped to save bandwidth
- WebSocket backpressure — slow viewers are skipped (256 KB buffer limit)
- LAN IP auto-detection (UDP route trick)
- Configurable permission controls per site — camera/microphone, location, notifications
- Settings flyout (port, bind address, FPS, quality, startup URL, always-on-top, launch on startup, diagnostics)
- Enter key saves settings; ESC closes the panel
- Draggable diagnostics overlay (FPS, bandwidth, frame size, memory, viewer count, uptime)
- Status bar with viewer count and clickable/copyable server URL
- Pin (always-on-top) toggle
- Launch on startup — registers as a Windows login item
- Auto-load startup URL on launch
- No menu bar — clean, minimal UI
- Fake fullscreen containment — video fullscreen stays inside the webview, toolbar and status bar remain visible
- NSIS installer for Windows (x64) with custom app icon

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
- Windows 10/11 (x64) for building the installer

## Getting Started

```bash
npm install
npm start          # production mode
npm run dev        # with DevTools open
```

## Usage

1. Launch the app — a web server starts on port **4983** (configurable in Settings).
2. Paste a URL into the address bar and press **Go** (or Enter).
3. The status bar shows the shareable URL, e.g. `http://192.168.1.50:4983/webshare`.
4. In ProPresenter, add a **Web** content source pointing to that URL.
5. The page is now live-streamed as a JPEG feed.

## Building

See [BUILD.md](BUILD.md) for full build instructions.

Quick build:

```bash
npm run build            # NSIS installer → dist/ProPresenter_WebShare_Setup_1.3.0.exe
npm run build:portable   # Portable .exe  → dist/
```

### Automated dependency releases

Dependabot opens npm update pull requests weekly. Every pull request to `main` runs syntax checks, smoke tests, and a Windows installer build. When an npm Dependabot pull request is merged, the release workflow repeats those checks, increments the patch version, updates [CHANGELOG.md](CHANGELOG.md), builds the installer, creates a `vX.Y.Z` tag, and publishes a GitHub Release. If either workflow fails, it creates a GitHub issue and mentions `@smoon_lee`.

## Project Structure

```
src/
  main.js              Electron main process (capture loop, IPC, encoder lifecycle)
  preload.js           Context bridge for the host page (index.html)
  webview-preload.js   Injected into the webview guest (fake fullscreen override)
  index.html           Operator UI (toolbar, webview, settings, diagnostics)
  server.js            Express + WebSocket streaming server (H.264 and JPEG modes)
  encoder.js           H.264 encoder detection, codec probing, ffmpeg process management
  settings.js          JSON settings persistence
  public/
    index.html         Viewer page (MSE-based H.264 video + JPEG fallback)
    favicon.png        App icon served to viewers
assets/
  webshare-icon-square.png   1024×1024 app icon (runtime, taskbar)
  webshare-icon.ico          Multi-size ICO (16–256px) for installer & exe
build/
  afterPack.js         Post-build hook — embeds ICO into exe via rcedit
```

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Port | 4983 | HTTP/WebSocket server port (restart required) |
| Bind address | 0.0.0.0 | Network interface to bind to (restart required) |
| FPS | 30 | Capture frames per second (1–60, live) |
| JPEG quality | 70 | Compression quality (10–100, live; H.264 mode only uses this as fallback) |
| Stream mode | H.264 | `H.264` (hardware-accelerated, low latency) or `JPEG` (maximum compatibility); live |
| HW encoder | auto | Preferred H.264 encoder: `auto`, `h264_nvenc`, `h264_qsv`, `h264_amf`, `libx264` |
| Startup URL | _(empty)_ | Auto-load this URL on launch |
| Always on top | off | Keep window above all others |
| Launch on startup | off | Register app as a Windows login item (packaged build only) |
| Show diagnostics | off | Show the draggable diagnostics overlay |
| Allow camera/mic | on | Permit camera and microphone access requests from the loaded page |
| Allow location | on | Permit geolocation access requests from the loaded page |
| Allow notifications | on | Permit notification permission requests from the loaded page |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+,` | Open/close Settings |
| `F11` | (Blocked) Fullscreen is contained within the webview |

## License

MIT

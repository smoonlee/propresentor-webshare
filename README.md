# ProPresenter WebShare

An Electron desktop app that loads any web page, captures it as a live JPEG stream, and serves it over WebSocket at `http://<LAN-IP>:4983/webshare` — ready for ProPresenter (or any browser) to display.

## How It Works

```
┌──────────────┐                  ┌──────────────┐   WebSocket    ┌───────────────────┐
│  Web Page    │   capturePage()  │  Electron App │  ──────────►  │  /webshare viewer │
│  (webview)   │  ─────────────►  │  (operator)   │               │  (ProPresenter /  │
└──────────────┘                  └──────────────┘               │   any browser)    │
                                                                  └───────────────────┘
```

1. **Operator** navigates to a URL inside the app's built-in browser (webview).
2. **Capture loop** grabs JPEG frames via `capturePage()` at a configurable FPS.
3. **Express + WebSocket server** streams frames to all connected viewers.
4. **ProPresenter** (or any browser on the LAN) loads the viewer URL to see the live feed.

## Features

- Configurable capture FPS (1–60) and JPEG quality (10–100)
- Frame deduplication — identical frames are skipped to save bandwidth
- WebSocket backpressure — slow viewers are skipped (256 KB buffer limit)
- LAN IP auto-detection (UDP route trick)
- Settings flyout (port, bind address, FPS, quality, startup URL, always-on-top, diagnostics)
- Draggable diagnostics overlay (FPS, bandwidth, frame size, memory, viewer count, uptime)
- Status bar with viewer count and clickable/copyable server URL
- Pin (always-on-top) toggle
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
npm run build            # NSIS installer → dist/ProPresenter_WebShare_Setup_1.0.0.exe
npm run build:portable   # Portable .exe  → dist/
```

### Automated releases

Push a version tag to trigger the GitHub Actions release pipeline:

```bash
git tag v1.0.0
git push origin main --tags
```

This builds the Windows installer and publishes it as a GitHub Release. See [BUILD.md](BUILD.md) for details.

## Project Structure

```
src/
  main.js              Electron main process (capture loop, IPC, session setup)
  preload.js           Context bridge for the host page (index.html)
  webview-preload.js   Injected into the webview guest (fake fullscreen override)
  index.html           Operator UI (toolbar, webview, settings, diagnostics)
  server.js            Express + WebSocket streaming server
  settings.js          JSON settings persistence
  public/
    index.html         Viewer page (WebSocket JPEG receiver)
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
| JPEG quality | 70 | Compression quality (10–100, live) |
| Startup URL | _(empty)_ | Auto-load this URL on launch |
| Always on top | off | Keep window above all others |
| Show diagnostics | off | Show the draggable diagnostics overlay |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+,` | Open/close Settings |
| `Ctrl+Shift+I` | Toggle DevTools |
| `F11` | (Blocked) Fullscreen is contained within the webview |

## License

MIT

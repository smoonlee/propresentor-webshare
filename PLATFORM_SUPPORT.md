# Platform support

This project supports Windows x64 and has macOS release scaffolding for Intel
and Apple Silicon. The live stream is platform-independent: the app captures
its own Electron webview, encodes frames locally, and serves the same viewer URL
to ProPresenter or any modern browser on the LAN.

| Capability | Windows x64 | macOS Intel (x64) | macOS Apple Silicon (arm64) |
|---|---|---|---|
| App, webview capture, JPEG stream | Supported | CI-built; device validation pending | CI-built; device validation pending |
| H.264 stream | NVENC, QSV, AMF, then `libx264` fallback | `h264_videotoolbox`, then `libx264` fallback | `h264_videotoolbox`, then `libx264` fallback |
| Audio relay | All system audio through Windows WASAPI | Loaded web page audio only (preview) | Loaded web page audio only (preview) |
| Login item / launch on startup | Supported in packaged app | Implemented; device validation pending | Implemented; device validation pending |
| Installer format | NSIS installer and portable `.exe` | Unsigned DMG and ZIP | Unsigned DMG and ZIP |
| Code signing and notarization | Not configured | Not configured | Not configured |

## Important limitations

- Windows captures the system mixer through WASAPI. macOS captures audio from
  the loaded webview directly, so it streams the page's audio but not other Mac
  applications or the system-wide mixer.
- `app.disableHardwareAcceleration()` applies to Electron's rendering process
  on both platforms. H.264 hardware encoding still runs in the separate FFmpeg
  process, subject to a successful encoder probe.
- macOS artifacts have not yet been tested on a physical device. Until the
  first-device checks in [MACOS.md](MACOS.md) are complete, macOS should be
  treated as preview support.
- The macOS build config sets `identity: null`. macOS will show Gatekeeper
  warnings until Developer ID signing and notarization are configured.

## Builds and releases

`ffmpeg-static` installs one native FFmpeg executable. Each macOS architecture
is therefore built on its matching native runner, rather than using one install
to cross-package both architectures.

- Pull requests to `main` validate Windows plus Intel and Apple Silicon macOS.
  The unsigned macOS DMG/ZIP artifacts are retained for seven days.
- A manually pushed `v*` tag runs the multi-platform tag-release workflow and
  attaches Windows and macOS artifacts to the GitHub Release.
- The Dependabot-only automatic release workflow currently runs on Windows and
  publishes only the Windows installer. Use a manual release tag for a release
  that includes macOS artifacts.

See [BUILD.md](BUILD.md) for Windows builds and [MACOS.md](MACOS.md) for macOS
build and first-device validation instructions.

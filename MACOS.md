# macOS release guide

macOS builds support the same webview capture, JPEG stream, and H.264 stream as
Windows. On Apple hardware the app probes FFmpeg's `h264_videotoolbox` encoder
before falling back to `libx264`. These builds are preview support until tested
on physical Intel and Apple Silicon Macs; see [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md).

System-audio loopback is intentionally unavailable on macOS. The existing audio
implementation uses Windows WASAPI; macOS needs a separately designed capture
and permission flow. The Audio loopback control is hidden in the macOS build.

## Build a release

Build on the same architecture as the intended release. `ffmpeg-static` installs
one native FFmpeg executable, so one installation must not be used to produce
both architectures.

```bash
npm ci
npm run build:mac            # native architecture: DMG and ZIP
npm run build:mac:x64        # Intel macOS host only
npm run build:mac:arm64      # Apple Silicon macOS host only
```

The output is written to `dist/`:

```
ProPresenter_WebShare_<version>_mac_x64.dmg
ProPresenter_WebShare_<version>_mac_x64.zip
ProPresenter_WebShare_<version>_mac_arm64.dmg
ProPresenter_WebShare_<version>_mac_arm64.zip
```

A DMG can only be created on macOS because it uses Apple's disk-image tooling.
The pull-request workflow builds both architectures on GitHub-hosted macOS
runners and keeps the unsigned artifacts for seven days, which is useful when a
local Mac is unavailable. A manually pushed `v*` tag publishes both macOS
architectures with the Windows installer. The separate Dependabot release
automation currently publishes Windows only.

## Signing before public distribution

The scaffold deliberately sets `build.mac.identity` to `null`, producing
unsigned builds suitable for internal testing. Before publishing outside a
controlled team, configure a Developer ID Application certificate, hardened
runtime entitlements, and Apple notarization in CI. Users will otherwise receive
Gatekeeper warnings.

## First-device validation

Test one Intel Mac and one Apple Silicon Mac before calling the release stable:

1. Load a page with video and confirm the webview is captured at the chosen FPS.
2. Confirm the H.264 encoder label is `h264_videotoolbox`; also test JPEG and
   software H.264 fallback.
3. Connect a viewer on another device on the LAN and test reconnects.
4. Confirm the Audio loopback option is absent and that login-item and
   always-on-top settings behave as expected.

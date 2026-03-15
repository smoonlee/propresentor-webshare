# Build Guide — ProPresenter WebShare

How to compile the Windows installer (`.exe`) from source.

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | 18+ | Runtime & npm |
| npm | (bundled with Node) | Package manager |
| Windows 10/11 | x64 | Build host (NSIS target is Windows-only) |

> **Note:** `electron-builder` downloads NSIS and other build tools automatically on first run. No separate NSIS installation is required.

## Step-by-step

### 1. Clone and install dependencies

```bash
git clone <repo-url> propresenter-webshare
cd propresenter-webshare
npm install
```

### 2. Verify the app runs

```bash
npm start
```

The app should launch and show the toolbar + blank webview. Close it before building.

### 3. Build the NSIS installer

```bash
npm run build
```

This runs `electron-builder --win` which:
- Packages the Electron app with all dependencies
- Creates an NSIS installer at `dist/ProPresenter_WebShare Setup <version>.exe`

The output is in the `dist/` folder:

```
dist/
  ProPresenter_WebShare_Setup_1.0.0.exe    ← installer (~95 MB)
  win-unpacked/                            ← unpacked app directory
```

### 4. (Optional) Build a portable executable

```bash
npm run build:portable
```

Creates a standalone `.exe` that runs without installation.

## Build scripts reference

| Script | Command | Output |
|--------|---------|--------|
| `npm run build` | `electron-builder --win` | NSIS installer |
| `npm run build:portable` | `electron-builder --win portable` | Portable `.exe` |

## Build configuration

All build settings live in `package.json` under the `"build"` key:

```jsonc
{
  "build": {
    "appId": "com.propresenter.webshare",
    "productName": "ProPresenter WebShare",
    "icon": "assets/webshare-icon.ico",
    "afterPack": "build/afterPack.js",
    "directories": { "output": "dist" },
    "files": ["src/**/*", "assets/**/*", "package.json"],
    "win": {
      "icon": "assets/webshare-icon.ico",
      "target": [{ "target": "nsis", "arch": ["x64"] }]
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "ProPresenter WebShare",
      "artifactName": "ProPresenter_WebShare_Setup_${version}.${ext}"
    }
  }
}
```

### afterPack hook

The `build/afterPack.js` script runs after electron-builder packages the app. It uses `rcedit` to embed the `.ico` file directly into the exe's Windows resource table, ensuring the desktop shortcut and taskbar icon display correctly.

## Known build issue — winCodeSign symlink error

On Windows, `electron-builder` may fail with:

```
Exit code: 2. Command failed: 7z ...darwin...
```

This is caused by 7zip trying to create macOS symlinks from the `winCodeSign` package. It is cosmetic and does **not** affect the build output. If it causes a hard failure, apply this one-line patch to `node_modules/builder-util/out/util.js`:

Find (~line 387):
```js
reject(error);
```

In the block where `exitCode === 2`, change it to:
```js
resolve("");
```

This tells builder-util to ignore exit code 2 (symlink warnings) from 7zip. The patch lives in `node_modules` and is lost on `npm install` — reapply if needed.

## Changing the app icon

Two icon files are needed:

| File | Purpose |
|------|---------|
| `assets/webshare-icon-square.png` | 1024×1024 PNG — runtime icon (title bar, taskbar) |
| `assets/webshare-icon.ico` | Multi-size ICO (16–256px) — embedded in exe by afterPack hook |

To replace the icon:

1. Replace `assets/webshare-icon-square.png` with a square PNG (ideally 1024×1024, minimal transparent padding).
2. Regenerate the `.ico` from it:

```js
const sharp = require('sharp');
const fs = require('fs');
const pti = require('png-to-ico');

const sizes = [16, 24, 32, 48, 64, 128, 256];
const src = 'assets/webshare-icon-square.png';
const tmpFiles = [];
for (const s of sizes) {
  const f = `assets/tmp_${s}.png`;
  await sharp(src).resize(s, s).png().toFile(f);
  tmpFiles.push(f);
}
const ico = await (pti.default || pti)(tmpFiles);
fs.writeFileSync('assets/webshare-icon.ico', ico);
tmpFiles.forEach(f => fs.unlinkSync(f));
```

3. Rebuild: `npm run build`

## Updating the version number

Edit the `"version"` field in `package.json`, then rebuild:

```bash
# In package.json: "version": "1.1.0"
npm run build
```

The installer filename and Windows file properties will reflect the new version automatically.

## CI/CD — GitHub Actions release pipeline

The repo includes a GitHub Actions workflow at `.github/workflows/release.yml` that automatically builds and publishes the Windows installer when you push a version tag.

### How to trigger a release

```bash
# 1. Update the version in package.json
#    "version": "1.1.0"

# 2. Commit the change
git add package.json
git commit -m "Bump version to 1.1.0"

# 3. Create and push a version tag
git tag v1.1.0
git push origin main --tags
```

This will:
1. Run `npm ci` + `npm run build` on a `windows-latest` runner
2. Upload `ProPresenter_WebShare_Setup_1.1.0.exe` as a build artifact
3. Create a GitHub Release with the installer attached and auto-generated release notes

### What the pipeline does

| Step | Description |
|------|-------------|
| Checkout | Clones the repo at the tagged commit |
| Setup Node.js | Installs Node 20 with npm cache |
| Install deps | `npm ci` (clean install from lockfile) |
| Build | `npm run build` → NSIS installer in `dist/` |
| Upload artifact | Stores the `.exe` as a workflow artifact (30-day retention) |
| GitHub Release | Creates a release at the tag with the installer attached |

# Build Guide — ProPresenter WebShare

How to compile the Windows installer (`.exe`) from source.

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| [Node.js](https://nodejs.org/) | 26.5.0 | Runtime & npm |
| npm | (bundled with Node) | Package manager |
| Windows 10/11 | x64 | Build host (NSIS target is Windows-only) |

> **Note:** `electron-builder` downloads NSIS and other build tools automatically on first run. No separate NSIS installation is required.>
> **ffmpeg:** `ffmpeg-static` (~70 MB) is bundled automatically via the `asarUnpack` config. No separate ffmpeg installation is needed.
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
  ProPresenter_WebShare_Setup_1.3.0.exe    ← installer (~165 MB, includes ffmpeg)
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

Dependabot opens weekly npm update pull requests. Each PR to `main` runs `npm run check` (JavaScript syntax checks plus the server/WebSocket smoke test) and a Windows installer build. If either fails, the CI workflow opens a GitHub issue mentioning `@smoon_lee`.

After a validated npm Dependabot PR is merged, `.github/workflows/release.yml` repeats the checks, increments the patch version, writes the dependency update to `CHANGELOG.md`, commits those release files to `main`, creates a matching `vX.Y.Z` tag, and publishes the Windows installer as a GitHub Release. Dependabot updates for GitHub Actions do not create application releases.

The workflow needs GitHub Actions to have **Read and write permissions** for workflow `GITHUB_TOKEN`s (repository Settings → Actions → General). If `main` is protected, permit `github-actions[bot]` to push release-version commits, or exempt this workflow through your branch-protection/ruleset configuration.

### What the pipeline does

| Step | Description |
|------|-------------|
| Checkout | Clones merged `main` after the Dependabot PR closes |
| Setup Node.js | Installs Node 26.5.0 with npm cache |
| Install deps | `npm ci` (clean install from lockfile) |
| Validate | `npm run check` verifies syntax and the HTTP/WebSocket smoke test |
| Build | `npm run build` → NSIS installer in `dist/` |
| Sign | Signs the installer via Azure Trusted Signing (skipped if secrets are absent) |
| GitHub Release | Commits the patch version, tags it, and attaches the installer with generated notes |

## Code signing — Azure Trusted Signing

The release workflow signs the installer using [Azure Trusted Signing](https://learn.microsoft.com/en-us/azure/trusted-signing/), which removes the "Publisher: Unknown" SmartScreen warning. Signing is skipped automatically when the secrets below are not configured, so unsigned local builds continue to work.

### One-time Azure setup

**1. Create an Azure Trusted Signing account**

```bash
az extension add --name trustedsigning
az group create --name rg-codesigning --location eastus
az trustedsigning create \
  --name <account-name> \
  --resource-group rg-codesigning \
  --location eastus \
  --sku Basic
```

**2. Create a Certificate Profile** (Public Trust for public distribution)

```bash
az trustedsigning certificate-profile create \
  --account-name <account-name> \
  --resource-group rg-codesigning \
  --profile-name <profile-name> \
  --profile-type PublicTrust \
  --identity-validation-id <identity-validation-id>
```

> Identity validation must be completed first — submit your organisation details in the Azure Portal under the Trusted Signing account → Identity Validation.

**3. Create a service principal and grant it the signer role**

```bash
# Create the service principal
az ad sp create-for-rbac --name sp-codesigning --sdk-auth

# Grant the signer role on the certificate profile
az role assignment create \
  --assignee <client-id> \
  --role "Trusted Signing Certificate Profile Signer" \
  --scope "/subscriptions/<sub>/resourceGroups/rg-codesigning/providers/Microsoft.CodeSigning/codeSigningAccounts/<account-name>/certificateProfiles/<profile-name>"
```

**4. Get the endpoint URL**

In the Azure Portal, open the Trusted Signing account → Overview. The endpoint is shown as:
```
https://<region>.codesigning.azure.net
```

### GitHub repository secrets

Add these six secrets to the repository (Settings → Secrets and variables → Actions):

| Secret | Value |
|--------|-------|
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | Service principal client (application) ID |
| `AZURE_CLIENT_SECRET` | Service principal secret |
| `AZURE_CODE_SIGNING_ENDPOINT` | Endpoint URL, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE_NAME` | Certificate profile name |

Once all six secrets are present, the next tag push will produce a signed installer and the SmartScreen warning will be suppressed.

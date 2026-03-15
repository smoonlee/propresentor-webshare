const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const icoPath = path.resolve(__dirname, '..', 'assets', 'webshare-icon.ico');

  if (!fs.existsSync(exePath) || !fs.existsSync(icoPath)) return;

  // Find rcedit - electron-builder ships it or fall back to electron-winstaller's copy
  let rcedit;
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', 'rcedit', 'bin', 'rcedit.exe'),
    path.resolve(__dirname, '..', 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { rcedit = c; break; }
  }
  if (!rcedit) {
    console.warn('afterPack: rcedit not found, skipping icon embed');
    return;
  }

  console.log('afterPack: setting exe icon via rcedit');
  execFileSync(rcedit, [exePath, '--set-icon', icoPath]);
};

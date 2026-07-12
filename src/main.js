const { app, BrowserWindow, Menu, globalShortcut, ipcMain, shell, webContents, session, dialog } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const { createServer } = require('./server');
const settings = require('./settings');

// Fake fullscreen JS — injected into guest pages via executeJavaScript (bypasses CSP).
// Replaces the Fullscreen API with a CSS-based visual fake so video fills the
// webview area but never triggers Chromium's native fullscreen.
const FAKE_FULLSCREEN_JS = require('./fake-fullscreen-code');

// Disable hardware acceleration entirely so video renders via software
// and is visible both in the webview and in capturePage() output.
// Must be called before app is ready.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow;
let server;
let captureInterval = null;
let captureWebContentsId = null;
let guestWebContentsId = null;
let currentCaptureFps = null;
let currentJpegQuality = null;
let lastFrameBuffer = null;

// Diagnostics counters
let diagFrameCount = 0;
let diagBytesSent = 0;
let diagLastFrameSize = 0;
let diagFps = 0;
let diagBandwidth = 0;
let diagAvgFrameSize = 0;
let diagSkippedFrames = 0;
let diagSkippedInSec = 0;
let diagInterval = null;

diagInterval = setInterval(() => {
  diagFps = diagFrameCount;
  diagBandwidth = diagBytesSent;
  diagAvgFrameSize = diagFrameCount > 0 ? diagBytesSent / diagFrameCount : 0;
  diagSkippedInSec = diagSkippedFrames;
  diagFrameCount = 0;
  diagBytesSent = 0;
  diagSkippedFrames = 0;
}, 1000);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1130,
    height: 780,
    minWidth: 500,
    minHeight: 400,
    icon: path.join(__dirname, '..', 'assets', 'webshare-icon-square.png'),
    title: 'ProPresenter WebShare',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Prevent the BrowserWindow from ever entering OS-level fullscreen
  mainWindow.setFullScreenable(false);

  // When the webview guest attaches, inject fake fullscreen override into every
  // page it loads.  executeJavaScript runs in the main world and bypasses CSP.
  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    guestWebContentsId = guest.id;
    function injectFakeFullscreen() {
      if (!guest.isDestroyed()) {
        guest.executeJavaScript(FAKE_FULLSCREEN_JS).catch(() => {});
      }
    }
    guest.on('dom-ready', injectFakeFullscreen);

    // Safety net: if native fullscreen somehow triggers, force-exit it.
    guest.on('enter-html-full-screen', () => {
      if (!guest.isDestroyed()) {
        guest.executeJavaScript('document.exitFullscreen().catch(function(){})').catch(() => {});
      }
    });
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

function stopCapture() {
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  captureWebContentsId = null;
  lastFrameBuffer = null;
}

function startCaptureLoop(wcId) {
  stopCapture();
  captureWebContentsId = wcId;
  const fps = currentCaptureFps || settings.get('captureFps');
  const quality = currentJpegQuality || settings.get('jpegQuality');
  let capturing = false;
  captureInterval = setInterval(() => {
    if (capturing) { diagSkippedFrames++; return; }
    capturing = true;
    try {
      const wc = webContents.fromId(captureWebContentsId);
      if (!wc || wc.isDestroyed()) { stopCapture(); capturing = false; return; }
      wc.capturePage().then((image) => {
        capturing = false;
        if (server && !image.isEmpty()) {
          const jpeg = image.toJPEG(quality);
          // Skip if frame is identical to previous
          if (lastFrameBuffer && jpeg.length === lastFrameBuffer.length && jpeg.equals(lastFrameBuffer)) {
            diagSkippedFrames++;
            return;
          }
          lastFrameBuffer = jpeg;
          diagFrameCount++;
          diagBytesSent += jpeg.length;
          diagLastFrameSize = jpeg.length;
          server.broadcastFrame(jpeg);
        }
      }).catch(() => { capturing = false; });
    } catch (_) { stopCapture(); capturing = false; }
  }, 1000 / fps);
}

// ── IPC: start capturing the webview content ──
ipcMain.on('start-capture', (_event, webContentsId) => {
  if (webContentsId !== guestWebContentsId) return;
  startCaptureLoop(webContentsId);
});

ipcMain.on('stop-capture', () => {
  stopCapture();
});

// ── IPC: get webview preload path ──
ipcMain.handle('get-webview-preload', () => {
  return path.join(__dirname, 'webview-preload.js');
});

// ── IPC: get connected viewer count ──
ipcMain.handle('get-viewer-count', () => {
  return server ? server.getViewerCount() : 0;
});

// ── IPC: get server port ──
ipcMain.handle('get-port', () => settings.get('port'));

// ── IPC: diagnostics ──
let cachedLanIp = null;
function getLanIp() {
  if (cachedLanIp) return Promise.resolve(cachedLanIp);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    // connect() doesn't send data — it just triggers OS route resolution
    sock.connect(53, '1.1.1.1', () => {
      const ip = sock.address().address;
      sock.close();
      cachedLanIp = ip;
      resolve(ip);
    });
    sock.on('error', () => {
      sock.close();
      // Fallback: pick first non-internal IPv4 from os.networkInterfaces()
      const ifaces = os.networkInterfaces();
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name]) {
          if (iface.family === 'IPv4' && !iface.internal) {
            cachedLanIp = iface.address;
            resolve(iface.address);
            return;
          }
        }
      }
      cachedLanIp = '127.0.0.1';
      resolve('127.0.0.1');
    });
  });
}

ipcMain.handle('get-lan-ip', () => getLanIp());

ipcMain.handle('get-diagnostics', () => {
  const mem = process.memoryUsage();
  return {
    fps: diagFps,
    avgFrameSize: diagAvgFrameSize,
    lastFrameSize: diagLastFrameSize,
    bandwidthBytesPerSec: diagBandwidth,
    viewers: server ? server.getViewerCount() : 0,
    memoryMB: mem.rss / (1024 * 1024),
    skippedFrames: diagSkippedInSec,
  };
});

// ── IPC: open URL in default browser ──
ipcMain.on('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// ── IPC: toggle always-on-top ──
ipcMain.on('toggle-always-on-top', () => {
  if (!mainWindow) return;
  const next = !mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(next);
  mainWindow.webContents.send('always-on-top-changed', next);
});

ipcMain.handle('get-always-on-top', () => {
  return mainWindow ? mainWindow.isAlwaysOnTop() : false;
});

// ── IPC: settings ──
function sanitizeSettings(s) {
  return {
    port: Math.max(1, Math.min(65535, parseInt(s.port, 10) || 4983)),
    bindAddress: /^(\d{1,3}\.){3}\d{1,3}$|^localhost$/.test(s.bindAddress) ? s.bindAddress : '0.0.0.0',
    captureFps: Math.max(1, Math.min(60, parseInt(s.captureFps, 10) || 30)),
    jpegQuality: Math.max(10, Math.min(100, parseInt(s.jpegQuality, 10) || 70)),
    startupUrl: typeof s.startupUrl === 'string' && /^https?:\/\//i.test(s.startupUrl) ? s.startupUrl : '',
    alwaysOnTop: !!s.alwaysOnTop,
    showDiagnostics: !!s.showDiagnostics,
    launchOnStartup: !!s.launchOnStartup,
    allowMedia: !!s.allowMedia,
    allowGeolocation: !!s.allowGeolocation,
    allowNotifications: !!s.allowNotifications,
  };
}

ipcMain.handle('get-settings', () => settings.getAll());
ipcMain.handle('get-defaults', () => settings.getDefaults());
ipcMain.handle('save-settings', (_event, s) => {
  const sanitized = sanitizeSettings(s);
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: sanitized.launchOnStartup });
  }
  return settings.save(sanitized);
});

ipcMain.on('apply-settings', (_event, s) => {
  // Apply live-changeable settings without restart (clamped to safe ranges)
  currentCaptureFps = Math.max(1, Math.min(60, parseInt(s.captureFps, 10) || 12));
  currentJpegQuality = Math.max(10, Math.min(100, parseInt(s.jpegQuality, 10) || 70));

  // Restart capture with new FPS/quality if active
  if (captureWebContentsId != null) {
    startCaptureLoop(captureWebContentsId);
  }

  // Always on top
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(!!s.alwaysOnTop);
    mainWindow.webContents.send('always-on-top-changed', !!s.alwaysOnTop);
  }

  // Notify the main window so it can update UI (e.g. status bar visibility)
  if (mainWindow) {
    mainWindow.webContents.send('settings-changed', sanitizeSettings(s));
  }
});

function openSettingsPanel() {
  if (mainWindow) mainWindow.webContents.send('toggle-settings');
}

// ── Application menu ──
// Remove the default menu bar; settings is accessible via the gear button
// or Ctrl+, keyboard shortcut registered in app lifecycle below.
function setupMenu() {
  Menu.setApplicationMenu(null);
}

// ── App lifecycle ──
app.whenReady().then(() => {
  const cfg = settings.load();
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: cfg.launchOnStartup });
  }
  server = createServer(cfg.port, cfg.bindAddress);
  server.ready.catch((err) => {
    dialog.showErrorBox('Server failed to start', err.message);
  });

  // Strip Content-Security-Policy headers from HTTP responses so the
  // webview preload's <script> injection (first-pass) is not blocked by CSP.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('http')) {
      const responseHeaders = {};
      for (const [key, value] of Object.entries(details.responseHeaders)) {
        if (key.toLowerCase() !== 'content-security-policy') {
          responseHeaders[key] = value;
        }
      }
      callback({ responseHeaders });
      return;
    }
    callback({});
  });

  // Block the native fullscreen permission so Chromium never enters real
  // fullscreen for the webview.  Our JS fake fullscreen (injected via
  // executeJavaScript) provides the visual fullscreen experience instead.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'fullscreen') { callback(false); return; }
    const cfg = settings.load();
    if (permission === 'media' && !cfg.allowMedia) { callback(false); return; }
    if (permission === 'geolocation' && !cfg.allowGeolocation) { callback(false); return; }
    if (permission === 'notifications' && !cfg.allowNotifications) { callback(false); return; }
    callback(true);
  });

  setupMenu();
  createWindow();

  // Ctrl+, opens settings panel (replaces the old menu accelerator)
  globalShortcut.register('CmdOrCtrl+,', openSettingsPanel);

  // Apply startup settings
  if (cfg.alwaysOnTop && mainWindow) {
    mainWindow.setAlwaysOnTop(true);
    mainWindow.webContents.send('always-on-top-changed', true);
  }
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (diagInterval) clearInterval(diagInterval);
  if (server) server.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

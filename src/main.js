const { app, BrowserWindow, Menu, globalShortcut, ipcMain, shell, webContents, session, desktopCapturer, dialog } = require('electron');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const https = require('https');
const { createServer } = require('./server');
const settings = require('./settings');
const { detectCodec, spawnEncoder, MSE_CODEC_STRING } = require('./encoder');
const QRCode = require('qrcode');

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
let ffmpegProc = null;
let encoderInfo = null;

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

  // Check for updates 10 s after the window loads — no startup impact.
  // If the check fails (e.g. VM network not yet ready), retry once after 60 s.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      const result = await checkForUpdates();
      if (result.networkError) setTimeout(checkForUpdates, 60000);
    }, 10000);
  });

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
    guest.on('destroyed', () => { if (guestWebContentsId === guest.id) guestWebContentsId = null; });

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

// Scan a Buffer for the byte offset of a named MP4 box (e.g. 'moof')
function findMp4BoxOffset(buf, type) {
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset);
    const boxType = buf.slice(offset + 4, offset + 8).toString('ascii');
    if (boxType === type) return offset;
    if (size < 8 || offset + size > buf.length) break;
    offset += size;
  }
  return -1;
}

function stopCapture() {
  if (captureInterval) { clearInterval(captureInterval); captureInterval = null; }
  captureWebContentsId = null;
  lastFrameBuffer = null;
  if (server) { server.clearLastFrame(); server.clearH264Init(); }
  if (ffmpegProc) {
    try { ffmpegProc.stdin.end(); } catch (_) {}
    ffmpegProc.kill();
    ffmpegProc = null;
  }
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

function startH264CaptureLoop(wcId) {
  stopCapture();
  captureWebContentsId = wcId;
  const fps = currentCaptureFps || settings.get('captureFps');
  let capturing = false;
  let ffmpegWidth = 0;
  let ffmpegHeight = 0;
  let initBuffer = Buffer.alloc(0);
  let initExtracted = false;

  function spawnFfmpegForSize(w, h) {
    if (ffmpegProc) {
      try { ffmpegProc.stdin.end(); } catch (_) {}
      ffmpegProc.kill();
      ffmpegProc = null;
    }
    initBuffer = Buffer.alloc(0);
    initExtracted = false;
    ffmpegWidth = w;
    ffmpegHeight = h;
    if (server) server.clearH264Init();

    ffmpegProc = spawnEncoder(encoderInfo.codec, w, h, fps);

    // Suppress write EOF errors on stdin — emitted asynchronously when ffmpeg
    // exits while the capture loop is still writing frames to the pipe.
    // The 'close' event on the process handles fallback/restart.
    ffmpegProc.stdin.on('error', () => {});

    // Drain stderr so the OS pipe buffer never fills and blocks ffmpeg
    ffmpegProc.stderr.on('data', (d) => console.error('[Encoder]', d.toString().trimEnd()));

    ffmpegProc.stdout.on('data', (chunk) => {
      if (!initExtracted) {
        initBuffer = Buffer.concat([initBuffer, chunk]);
        const moofOff = findMp4BoxOffset(initBuffer, 'moof');
        if (moofOff > 0) {
          const initSeg = initBuffer.slice(0, moofOff);
          const remaining = initBuffer.slice(moofOff);
          initExtracted = true;
          initBuffer = Buffer.alloc(0);
          if (server) server.setH264Init(initSeg);
          if (remaining.length > 0) {
            diagBytesSent += remaining.length;
            diagLastFrameSize = remaining.length;
            if (server) server.broadcastChunk(remaining);
          }
        }
        return;
      }
      diagBytesSent += chunk.length;
      diagLastFrameSize = chunk.length;
      if (server) server.broadcastChunk(chunk);
    });

    ffmpegProc.on('error', (err) => {
      console.error('[Encoder] ffmpeg error:', err.message);
    });

    ffmpegProc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        console.error('[Encoder] ffmpeg exited with code', code, '\u2014 falling back to JPEG');
        // Fall back to JPEG so the stream remains usable
        if (captureWebContentsId != null && server) {
          server.setMode('jpeg', '');
          startCaptureLoop(captureWebContentsId);
        }
      }
    });
  }

  captureInterval = setInterval(() => {
    if (capturing) { diagSkippedFrames++; return; }
    capturing = true;
    try {
      const wc = webContents.fromId(captureWebContentsId);
      if (!wc || wc.isDestroyed()) { stopCapture(); capturing = false; return; }
      wc.capturePage().then((image) => {
        capturing = false;
        if (!server || image.isEmpty()) return;
        const { width: w, height: h } = image.getSize();
        if (w === 0 || h === 0) return; // webview not yet rendered
        if (w !== ffmpegWidth || h !== ffmpegHeight) {
          spawnFfmpegForSize(w, h);
        }
        if (!ffmpegProc) return;
        diagFrameCount++;
        const bitmap = image.toBitmap();
        if (!ffmpegProc.stdin.destroyed) {
          try { ffmpegProc.stdin.write(bitmap); } catch (_) {}
        }
      }).catch(() => { capturing = false; });
    } catch (_) { stopCapture(); capturing = false; }
  }, 1000 / fps);
}

// ── IPC: start capturing the webview content ──
ipcMain.on('start-capture', (_event, webContentsId) => {
  if (webContentsId !== guestWebContentsId) return;
  const mode = settings.get('streamMode') || 'h264';
  if (mode === 'h264' && encoderInfo) {
    server.setMode('h264', MSE_CODEC_STRING);
    startH264CaptureLoop(webContentsId);
  } else {
    server.setMode('jpeg', '');
    startCaptureLoop(webContentsId);
  }
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

ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('check-for-updates', () => checkForUpdates());

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
    port: Math.max(1024, Math.min(65535, parseInt(s.port, 10) || 4983)),
    bindAddress: /^(\d{1,3}\.){3}\d{1,3}$|^localhost$/.test(s.bindAddress) && s.bindAddress.split('.').every(o => +o <= 255) ? s.bindAddress : '0.0.0.0',
    captureFps: Math.max(1, Math.min(60, parseInt(s.captureFps, 10) || 30)),
    jpegQuality: Math.max(10, Math.min(100, parseInt(s.jpegQuality, 10) || 70)),
    startupUrl: typeof s.startupUrl === 'string' && /^https?:\/\//i.test(s.startupUrl) ? s.startupUrl : '',
    alwaysOnTop: !!s.alwaysOnTop,
    showDiagnostics: !!s.showDiagnostics,
    launchOnStartup: !!s.launchOnStartup,
    allowMedia: !!s.allowMedia,
    allowGeolocation: !!s.allowGeolocation,
    allowNotifications: !!s.allowNotifications,
    streamMode: ['h264', 'jpeg'].includes(s.streamMode) ? s.streamMode : 'h264',
    hwEncoder: ['auto', 'nvenc', 'qsv', 'amf', 'software'].includes(s.hwEncoder) ? s.hwEncoder : 'auto',
    audioEnabled: !!s.audioEnabled,
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

ipcMain.handle('get-encoder-info', () => encoderInfo || null);

// ── IPC: relay audio chunks (WebM/Opus) from renderer to WebSocket clients ──
let _ipcAudioChunkCount = 0;

ipcMain.on('audio-chunk', (_event, rawBuffer) => {
  if (!server) return;
  // Electron IPC delivers ArrayBuffer (which has .byteLength, not .length, and
  // no index access). Convert to Node.js Buffer for consistent API.
  const buffer = Buffer.from(rawBuffer);
  _ipcAudioChunkCount++;
  if (_ipcAudioChunkCount === 1) {
    console.log('[Audio] First IPC chunk — size:', buffer.length);
    // Notify video viewers immediately so the phone's unmute button appears
    // without waiting for EBML detection or loadedmetadata.
    server.setAudioFlowing();
  } else if (_ipcAudioChunkCount % 50 === 0) {
    console.log('[Audio] IPC chunk count:', _ipcAudioChunkCount, 'size:', buffer.length);
  }
  // WebM streams begin with an EBML header (magic bytes 1A 45 DF A3).
  // Store the full first chunk as the init segment (replayed to late-joining viewers).
  // Don't strip the cluster — the first chunk from MediaRecorder is typically
  // just header (274B) with no or tiny cluster data; stripping risks corrupting it.
  if (buffer && buffer.length >= 4 &&
      buffer[0] === 0x1A && buffer[1] === 0x45 &&
      buffer[2] === 0xDF && buffer[3] === 0xA3) {
    console.log('[Audio] EBML init segment stored, size:', buffer.length);
    server.setAudioInit(Buffer.from(buffer));
  }
  server.broadcastAudioChunk(buffer);
});

// ── IPC: generate QR code data URL for the viewer URL ──
ipcMain.handle('get-qr-code', async () => {
  const ip = await getLanIp();
  const port = settings.get('port');
  const url = `http://${ip}:${port}/webshare`;
  try {
    return await QRCode.toDataURL(url, { width: 200, margin: 2 });
  } catch (_) {
    return null;
  }
});

ipcMain.on('apply-settings', (_event, s) => {
  // Apply live-changeable settings without restart (clamped to safe ranges)
  currentCaptureFps = Math.max(1, Math.min(60, parseInt(s.captureFps, 10) || 30));
  currentJpegQuality = Math.max(10, Math.min(100, parseInt(s.jpegQuality, 10) || 70));

  // Restart capture in the correct mode if active
  if (captureWebContentsId != null) {
    const mode = s.streamMode || 'h264';
    if (mode === 'h264' && encoderInfo) {
      server.setMode('h264', MSE_CODEC_STRING);
      startH264CaptureLoop(captureWebContentsId);
    } else {
      server.setMode('jpeg', '');
      startCaptureLoop(captureWebContentsId);
    }
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

// ── Update checker ──
function isNewer(tag, current) {
  const parse = v => v.replace(/^v/, '').split('.').map(Number);
  const [lM, lm, lp = 0] = parse(tag);
  const [cM, cm, cp = 0] = parse(current);
  return lM > cM || (lM === cM && lm > cm) || (lM === cM && lm === cm && lp > cp);
}

function checkForUpdates() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.github.com',
      path: '/repos/smoonlee/propresentor-webshare/releases/latest',
      headers: { 'User-Agent': 'propresentor-webshare-updater' },
    };
    const req = https.get(options, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ available: false }); return; }
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 65536) { res.destroy(); resolve({ available: false }); }
      });
      res.on('end', () => {
        try {
          const release = JSON.parse(body);
          const tag = release.tag_name;
          if (tag && isNewer(tag, app.getVersion())) {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update-available', { version: tag, url: release.html_url });
            }
            resolve({ available: true, version: tag, url: release.html_url });
          } else {
            resolve({ available: false });
          }
        } catch (_) { resolve({ available: false }); }
      });
    });
    req.setTimeout(8000, () => req.destroy());
    req.on('error', () => resolve({ available: false, networkError: true }));
  });
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

  // Intercept getDisplayMedia() calls from the renderer.
  // Use system-wide WASAPI loopback to capture audio from the default output device.
  // This captures everything playing through the speakers, including the webview's audio.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources || sources.length === 0) {
        console.warn('[Audio] No screen sources available');
        callback({});
        return;
      }
      console.log('[Audio] Using screen source:', sources[0].name, '+ WASAPI loopback');
      callback({ video: sources[0], audio: 'loopback' });
    }).catch((err) => {
      console.error('[Audio] desktopCapturer.getSources failed:', err.message);
      callback({});
    });
  }, { useSystemPicker: false });
  server = createServer(cfg.port, cfg.bindAddress);
  server.ready.catch((err) => {
    dialog.showErrorBox('Server failed to start', err.message);
  });

  // Detect best H.264 encoder in the background; switch mode once ready
  if ((cfg.streamMode || 'h264') !== 'jpeg') {
    detectCodec(cfg.hwEncoder || 'auto').then((info) => {
      encoderInfo = info;
      console.log('[Encoder] Using:', info.label);
      // If a capture is already running in JPEG fallback, upgrade it to H.264
      if (captureWebContentsId != null) {
        server.setMode('h264', MSE_CODEC_STRING);
        startH264CaptureLoop(captureWebContentsId);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('encoder-detected', info);
      }
    }).catch((err) => {
      console.error('[Encoder] Detection failed:', err.message);
      encoderInfo = { codec: 'libx264', hw: false, label: 'libx264 (software)' };
    });
  }

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
  if (ffmpegProc) { try { ffmpegProc.stdin.end(); } catch (_) {} ffmpegProc.kill(); }
  if (server) server.close();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

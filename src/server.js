const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

function createServer(port, bindAddress) {
  bindAddress = bindAddress || '0.0.0.0';
  const app = express();
  const httpServer = http.createServer(app);
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  // Serve the webshare viewer page
  app.use('/webshare', express.static(path.join(__dirname, 'public')));

  // WebSocket for streaming live frames to viewers
  const wss = new WebSocketServer({ server: httpServer, path: '/webshare/ws' });

  // Audio loopback stream (WebM/Opus chunks).
  // Use noServer so ws does not register its own 'upgrade' listener — having
  // two path-filtered WebSocketServers on the same http.Server causes the
  // second one to call abortHandshake(400) for paths it doesn't own, which
  // destroys the socket that the first server is already handling.
  const wssAudio = new WebSocketServer({ noServer: true });

  // Route /webshare/ws-audio upgrades to wssAudio manually.
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ? req.url.split('?')[0] : '';
    if (url === '/webshare/ws-audio') {
      wssAudio.handleUpgrade(req, socket, head, (ws) => {
        wssAudio.emit('connection', ws, req);
      });
    }
    // All other paths fall through to wss (which is registered with path:'/webshare/ws')
  });

  wssAudio.on('connection', (ws) => {
    ws.on('error', () => {});
  });

  let lastFrame = null;
  let currentMode = 'jpeg';
  let currentCodecStr = '';
  let h264InitSegment = null;
  let pendingH264Viewers = []; // viewers waiting for the H.264 init segment

  wss.on('connection', (ws) => {
    console.log(`[WebShare] Viewer connected (${wss.clients.size} total)`);
    // First message: mode config so the viewer sets up the correct display path
    try {
      ws.send(JSON.stringify({ type: 'config', mode: currentMode, codec: currentCodecStr }));
    } catch (_) {}
    // Seed the viewer:
    if (currentMode === 'h264') {
      if (h264InitSegment) {
        // Init segment already available — send immediately
        try { ws.send(h264InitSegment); } catch (_) {}
      } else {
        // Encoder not yet started; queue viewer until init segment is ready
        pendingH264Viewers.push(ws);
      }
    } else if (currentMode === 'jpeg' && lastFrame) {
      try { ws.send(lastFrame); } catch (_) {}
    }
    ws.on('error', () => {
      // Suppress async write errors (e.g. write EOF when client disconnects
      // mid-send at high fps / large frame size). The 'close' event still fires.
    });
    ws.on('close', () => {
      const idx = pendingH264Viewers.indexOf(ws);
      if (idx !== -1) pendingH264Viewers.splice(idx, 1);
      console.log(`[WebShare] Viewer disconnected (${wss.clients.size} total)`);
    });
  });

  const MAX_BUFFERED = 256 * 1024; // 256 KB — skip frames for slow clients

  function broadcastFrame(jpegBuffer) {
    lastFrame = jpegBuffer;
    if (wss.clients.size === 0) return;
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) {
        try { client.send(jpegBuffer); } catch (_) {}
      }
    }
  }

  // Broadcast an H.264 fragment chunk (no deduplication or caching needed)
  function broadcastChunk(chunk) {
    if (wss.clients.size === 0) return;
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) {
        try { client.send(chunk); } catch (_) {}
      }
    }
  }

  // Broadcast a WebM/Opus audio chunk to all connected audio viewers
  function broadcastAudioChunk(chunk) {
    if (wssAudio.clients.size === 0) return;
    for (const client of wssAudio.clients) {
      if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) {
        try { client.send(chunk); } catch (_) {}
      }
    }
  }

  function clearLastFrame() {
    lastFrame = null;
  }

  // Store the H.264 initialisation segment (ftyp+moov) so late-joining viewers
  // receive it before live fragments, allowing their MSE SourceBuffer to decode.
  function setH264Init(buf) {
    h264InitSegment = buf;
    // Flush any viewers that connected before the init segment was ready
    if (pendingH264Viewers.length > 0) {
      const pending = pendingH264Viewers.splice(0);
      for (const ws of pending) {
        if (ws.readyState === 1) {
          try { ws.send(buf); } catch (_) {}
        }
      }
    }
  }

  function clearH264Init() {
    h264InitSegment = null;
    pendingH264Viewers = [];
  }

  // Switch stream mode; disconnects all current viewers so they reconnect
  // and receive the correct mode config message.
  function setMode(mode, codecStr) {
    currentMode = mode;
    currentCodecStr = codecStr || '';
    h264InitSegment = null;
    pendingH264Viewers = [];
    for (const client of wss.clients) {
      try { client.close(1000, 'mode-change'); } catch (_) {}
    }
  }

  function getViewerCount() {
    return wss.clients.size;
  }

  httpServer.on('error', (err) => {
    console.error(`[WebShare] Server failed to start: ${err.message}`);
    readyReject(err);
  });

  httpServer.listen(port, bindAddress, () => {
    const display = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress;
    const address = httpServer.address();
    const listenPort = typeof address === 'object' && address ? address.port : port;
    console.log(`[WebShare] Server running at http://${display}:${listenPort}/webshare`);
    readyResolve();
  });

  return {
    broadcastFrame,
    broadcastChunk,
    broadcastAudioChunk,
    clearLastFrame,
    setMode,
    setH264Init,
    clearH264Init,
    getViewerCount,
    ready,
    address: () => httpServer.address(),
    close: () => {
      for (const client of wss.clients) client.terminate();
      for (const client of wssAudio.clients) client.terminate();
      wss.close();
      wssAudio.close();
      httpServer.close();
    },
  };
}

module.exports = { createServer };

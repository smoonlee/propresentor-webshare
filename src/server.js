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

  // HTTP chunked audio streaming — serves WebM/Opus directly to <audio> elements.
  // More compatible than WebSocket+MSE: the browser's native audio demuxer handles
  // the container format without needing explicit SourceBuffer management.
  //
  // NOTE: visiting this URL in a browser address bar will spin forever — that is
  // correct.  The HTTP response intentionally never completes (it keeps streaming).
  // The <audio> element handles this by buffering and playing as bytes arrive.
  let audioHttpClients = [];
  app.get('/webshare/audio', (req, res) => {
    // Browsers (Chrome/Edge) send Range requests for <audio> elements.  We don't
    // support seeking into a live stream, so respond with 200 and Accept-Ranges:none
    // to stop the browser retrying with a range request we can't satisfy.
    res.writeHead(200, {
      'Content-Type': 'audio/webm',
      'Cache-Control': 'no-cache, no-store',
      'Accept-Ranges': 'none',
      'X-Accel-Buffering': 'no',  // disable nginx proxy buffering if present
    });
    // Send headers immediately even before the first audio chunk.  Without this,
    // the browser gets no response bytes until write() is called, which may
    // never happen if audio hasn't started yet — the connection appears to hang.
    res.flushHeaders();
    // Disable Nagle's algorithm so each write() reaches the client without delay.
    if (req.socket) req.socket.setNoDelay(true);
    // Replay stored init segment so late-joining viewers can decode the stream.
    if (audioInitChunk) {
      try { res.write(Buffer.from(audioInitChunk)); } catch (_) {}
    }
    audioHttpClients.push(res);
    console.log(`[WebShare] Audio HTTP viewer connected (${audioHttpClients.length} total)`);
    const remove = () => {
      const i = audioHttpClients.indexOf(res);
      if (i !== -1) { audioHttpClients.splice(i, 1); }
      console.log(`[WebShare] Audio HTTP viewer disconnected (${audioHttpClients.length} remaining)`);
    };
    req.on('close', remove);
    req.on('error', () => { remove(); try { res.end(); } catch (_) {} });
  });

  // Both WebSocket servers use noServer:true so neither registers its own
  // 'upgrade' listener.  A single manual router dispatches by path.
  // Using { server, path } on either server causes it to call
  // abortHandshake(400) for unmatched paths, destroying sockets the other
  // server was about to claim — even if the other server was registered first.
  const wss = new WebSocketServer({ noServer: true });
  const wssAudio = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ? req.url.split('?')[0] : '';
    if (url === '/webshare/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else if (url === '/webshare/ws-audio') {
      wssAudio.handleUpgrade(req, socket, head, (ws) => {
        wssAudio.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  let audioInitChunk = null; // First WebM chunk (EBML header) — replayed to every new audio viewer

  wssAudio.on('connection', (ws) => {
    console.log(`[WebShare] Audio viewer connected (${wssAudio.clients.size} total)`);
    ws.on('error', () => {});
    ws.on('close', () => {
      console.log(`[WebShare] Audio viewer disconnected (${wssAudio.clients.size} total)`);
    });
    // Replay the WebM init segment so viewers that connect after capture started
    // can still decode the stream.  Without it, the SourceBuffer rejects every
    // subsequent cluster and audio never plays.
    if (audioInitChunk) {
      try { ws.send(audioInitChunk); } catch (_) {}
    }
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

  // Store the WebM init segment (EBML header).  Called when the first chunk
  // of a new MediaRecorder session is detected.
  // If a previous init segment already existed, the audio capture restarted.
  // Existing audio viewers have the old WebM stream's EBML header in their
  // MSE SourceBuffer — appending a new EBML header would throw InvalidStateError
  // and silently break the SourceBuffer.  Close them so they reconnect fresh
  // and receive the new stream from scratch.
  function setAudioInit(buf) {
    const isRestart = audioInitChunk !== null;
    audioInitChunk = buf;
    if (isRestart) {
      const wsCount = wssAudio.clients.size;
      const httpCount = audioHttpClients.length;
      console.log(`[WebShare] Audio stream restarted — closing ${wsCount} WS + ${httpCount} HTTP audio viewer(s) for clean reconnect`);
      for (const client of wssAudio.clients) {
        try { client.close(1001, 'stream-restart'); } catch (_) {}
      }
      // End HTTP streaming connections so clients reconnect with fresh init segment
      for (const res of audioHttpClients) {
        try { res.end(); } catch (_) {}
      }
      audioHttpClients = [];
    }
  }

  function clearAudioInit() {
    audioInitChunk = null;
  }

  // Broadcast a WebM/Opus audio chunk to all connected audio viewers
  function broadcastAudioChunk(chunk) {
    // WebSocket clients
    for (const client of wssAudio.clients) {
      if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) {
        try { client.send(chunk); } catch (_) {}
      }
    }
    // HTTP streaming clients
    if (audioHttpClients.length > 0) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      audioHttpClients = audioHttpClients.filter(res => {
        try { res.write(buf); return true; } catch (_) { return false; }
      });
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
    setAudioInit,
    clearAudioInit,
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
      for (const res of audioHttpClients) { try { res.end(); } catch (_) {} }
      wss.close();
      wssAudio.close();
      httpServer.close();
    },
  };
}

module.exports = { createServer };

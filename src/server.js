const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

function createServer(port, bindAddress) {
  bindAddress = bindAddress || '0.0.0.0';
  const app = express();
  const httpServer = http.createServer(app);

  // Serve the webshare viewer page
  app.use('/webshare', express.static(path.join(__dirname, 'public')));

  // WebSocket for streaming live frames to viewers
  const wss = new WebSocketServer({ server: httpServer, path: '/webshare/ws' });

  wss.on('connection', (ws) => {
    console.log(`[WebShare] Viewer connected (${wss.clients.size} total)`);
    ws.on('close', () => {
      console.log(`[WebShare] Viewer disconnected (${wss.clients.size} total)`);
    });
  });

  const MAX_BUFFERED = 256 * 1024; // 256 KB — skip frames for slow clients

  function broadcastFrame(jpegBuffer) {
    if (wss.clients.size === 0) return;
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.bufferedAmount < MAX_BUFFERED) {
        client.send(jpegBuffer);
      }
    }
  }

  function getViewerCount() {
    return wss.clients.size;
  }

  httpServer.on('error', (err) => {
    console.error(`[WebShare] Server failed to start: ${err.message}`);
  });

  httpServer.listen(port, bindAddress, () => {
    const display = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress;
    console.log(`[WebShare] Server running at http://${display}:${port}/webshare`);
  });

  return {
    broadcastFrame,
    getViewerCount,
    close: () => {
      wss.close();
      httpServer.close();
    },
  };
}

module.exports = { createServer };

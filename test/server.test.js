const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { WebSocket } = require('ws');
const { createServer } = require('../src/server');

function request(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

// Wait for the config text message then return a promise for the next message.
function afterConfig(ws) {
  return new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('message', (data) => {
      // First message is always the JSON config — swallow it
      if (typeof data === 'string' || (Buffer.isBuffer(data) && data[0] === 0x7b)) {
        // Now wait for the next (binary) message
        ws.once('message', resolve);
        ws.once('error', reject);
      } else {
        resolve(data);
      }
    });
  });
}

// Collect the next `n` messages from a WebSocket with an explicit timeout.
function collectMessages(ws, n, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`Timeout: expected ${n} messages, got ${msgs.length}`));
    }, timeoutMs);
    function onMsg(data) {
      msgs.push(data);
      if (msgs.length >= n) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(msgs);
      }
    }
    ws.on('message', onMsg);
  });
}

// Open a WebSocket that buffers ALL messages from the moment the socket is
// created — before 'open' fires — so no message can be lost to a listener-
// registration race on a fast loopback connection.
function wsConnectBuffered(url) {
  const ws = new WebSocket(url);
  const buf = [];           // buffered messages waiting to be consumed
  const waiters = [];       // resolve callbacks waiting for the next message

  ws.on('message', (data) => {
    if (waiters.length > 0) {
      waiters.shift()(data);
    } else {
      buf.push(data);
    }
  });

  // Return the next queued message, or wait for one (with optional timeout).
  ws.nextMessage = (timeoutMs = 2000) => {
    if (buf.length > 0) return Promise.resolve(buf.shift());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        const i = waiters.indexOf(fn);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error('Timeout waiting for message'));
      }, timeoutMs);
      function fn(data) { clearTimeout(t); resolve(data); }
      waiters.push(fn);
    });
  };

  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('serves the viewer and streams JPEG frames over WebSocket', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());

  const { port } = server.address();
  const viewer = await request(`http://127.0.0.1:${port}/webshare/`);
  assert.equal(viewer.status, 200);
  assert.match(viewer.body, /WebSocket/);

  const client = new WebSocket(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.close());
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });

  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const message = afterConfig(client);
  server.broadcastFrame(frame);
  assert.deepEqual(await message, frame);
});

test('sends last frame immediately to a newly connected viewer', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());

  const { port } = server.address();
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  // Broadcast a frame before the second client connects
  server.broadcastFrame(frame);

  // New client: skip config, then expect the cached JPEG frame
  const late = new WebSocket(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => late.close());
  const seed = await afterConfig(late);
  assert.deepEqual(seed, frame);
});

// ── H.264 mode tests ──────────────────────────────────────────────────────────

test('H.264: sends config with mode=h264 and codec string on connect', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  const msg = await client.nextMessage();
  const cfg = JSON.parse(msg.toString());
  assert.equal(cfg.mode, 'h264');
  assert.equal(cfg.codec, 'avc1.640028');
});

test('H.264: viewer receives init segment immediately when already available', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const initSeg = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70]);
  server.setH264Init(initSeg);

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  // Message 1: JSON config; Message 2: binary init segment
  const configMsg = await client.nextMessage();
  const cfg = JSON.parse(configMsg.toString());
  assert.equal(cfg.mode, 'h264');

  const binaryMsg = await client.nextMessage();
  assert.deepEqual(binaryMsg, initSeg);
});

test('H.264: pending viewer gets init segment when setH264Init is called later', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');
  // No init segment yet — client is queued in pendingH264Viewers

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  // Consume the config message, then wait for the init segment
  const configMsg = await client.nextMessage();
  assert.equal(JSON.parse(configMsg.toString()).mode, 'h264');

  const initSeg = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76]);
  server.setH264Init(initSeg);  // flushes the pending viewer

  const binaryMsg = await client.nextMessage();
  assert.deepEqual(binaryMsg, initSeg);
});

test('H.264: pending viewer removed from queue on disconnect before init arrives', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  await new Promise((resolve) => { client.once('close', resolve); client.close(); });

  // setH264Init should not throw even with a closed client previously in the queue
  const initSeg = Buffer.from([0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76]);
  assert.doesNotThrow(() => server.setH264Init(initSeg));
});

test('H.264: setMode jpeg clears init segment, new viewer gets jpeg config only', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');
  server.setH264Init(Buffer.from([1, 2, 3, 4]));

  server.setMode('jpeg', '');
  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  const configMsg = await client.nextMessage();
  const cfg = JSON.parse(configMsg.toString());
  assert.equal(cfg.mode, 'jpeg');

  // No second message should arrive within 150 ms (no H.264 init sent)
  const extra = await Promise.race([
    client.nextMessage(150).then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(extra, false, 'no H.264 init segment should follow a jpeg mode config');
});

// ── JPEG mode tests ───────────────────────────────────────────────────────────

test('clearLastFrame prevents cached frame being sent to new viewers', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());

  const { port } = server.address();
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

  server.broadcastFrame(frame);
  server.clearLastFrame();

  const client = new WebSocket(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.close());
  await new Promise((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });

  // After the config message, no binary frame should arrive within 150 ms
  let configReceived = false;
  const received = await Promise.race([
    new Promise((resolve) => {
      client.on('message', (data) => {
        if (!configReceived && (typeof data === 'string' || (Buffer.isBuffer(data) && data[0] === 0x7b))) {
          configReceived = true;
          return; // skip config
        }
        resolve(true); // unexpected binary message
      });
    }),
    new Promise((resolve) => setTimeout(() => resolve(false), 150)),
  ]);
  assert.equal(received, false, 'should not receive a frame after clearLastFrame');
});

// ── Audio availability signalling (WebSocket) tests ───────────────────────────

test('config message includes audioAvailable:false when no audio has started', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  const msg = await client.nextMessage();
  const cfg = JSON.parse(msg.toString());
  assert.equal(cfg.audioAvailable, false);
});

test('config message includes audioAvailable:true when audio init is already stored', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');
  // setAudioInit internally calls setAudioFlowing, setting audioFlowing = true
  server.setAudioInit(Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01]));

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  const msg = await client.nextMessage();
  const cfg = JSON.parse(msg.toString());
  assert.equal(cfg.audioAvailable, true);
});

test('setAudioFlowing sets audioAvailable:true in config for new viewers', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');
  // Simulate first IPC chunk arriving (no EBML yet)
  server.setAudioFlowing();

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  const msg = await client.nextMessage();
  const cfg = JSON.parse(msg.toString());
  assert.equal(cfg.audioAvailable, true);
});

test('setAudioFlowing broadcasts audio-available to connected video viewers', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());
  await client.nextMessage(); // consume config

  server.setAudioFlowing();

  const notification = await client.nextMessage();
  const msg = JSON.parse(notification.toString());
  assert.equal(msg.type, 'audio-available');
});

test('setAudioFlowing is idempotent — only one notification is sent', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());
  await client.nextMessage(); // consume config

  server.setAudioFlowing(); // first call — should broadcast
  const first = await client.nextMessage();
  assert.equal(JSON.parse(first.toString()).type, 'audio-available');

  server.setAudioFlowing(); // second call — should be silent
  const extra = await Promise.race([
    client.nextMessage(200).then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 200)),
  ]);
  assert.equal(extra, false, 'setAudioFlowing must not broadcast a second time');
});

test('setAudioInit broadcasts audio-available to connected video viewers', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  // Consume the config message first
  await client.nextMessage();

  // Trigger the first audio init — should broadcast audio-available
  server.setAudioInit(Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01]));

  const notification = await client.nextMessage();
  const msg = JSON.parse(notification.toString());
  assert.equal(msg.type, 'audio-available');
});

test('setAudioInit restart does NOT broadcast audio-available again', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();
  server.setMode('h264', 'avc1.640028');

  // Pre-store an init chunk so the next setAudioInit is treated as a restart
  server.setAudioInit(Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01]));

  const client = await wsConnectBuffered(`ws://127.0.0.1:${port}/webshare/ws`);
  t.after(() => client.terminate());

  // Consume config (audioAvailable: true)
  await client.nextMessage();

  // Trigger a restart — should NOT send another audio-available
  server.setAudioInit(Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x02]));

  const extra = await Promise.race([
    client.nextMessage(200).then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 200)),
  ]);
  assert.equal(extra, false, 'no audio-available should be sent on stream restart');
});

// ── Audio HTTP endpoint tests ─────────────────────────────────────────────────

// Collect exactly n bytes from an HTTP response then destroy the request.
function readNBytes(url, n, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let total = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Timeout: expected ${n} bytes, got ${total}`));
    }, timeoutMs);
    const req = http.get(url, (res) => {
      resolve._statusCode = res.statusCode;
      resolve._headers    = res.headers;
      res.on('data', (chunk) => {
        parts.push(chunk);
        total += chunk.length;
        if (total >= n) {
          clearTimeout(timer);
          req.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).slice(0, n) });
        }
      });
      res.on('error', () => {});
    });
    req.on('error', (e) => {
      if (e.code !== 'ECONNRESET') { clearTimeout(timer); reject(e); }
    });
  });
}

// Open an HTTP connection, capture headers, then immediately destroy it.
function headRequest(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, timeoutMs);
    const req = http.get(url, (res) => {
      clearTimeout(timer);
      req.destroy();
      resolve({ status: res.statusCode, headers: res.headers });
    });
    req.on('error', (e) => {
      if (e.code !== 'ECONNRESET') { clearTimeout(timer); reject(e); }
    });
  });
}

test('/webshare/audio: returns 200 with audio/webm content-type', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();

  const { status, headers } = await headRequest(`http://127.0.0.1:${port}/webshare/audio`);
  assert.equal(status, 200);
  assert.equal(headers['content-type'], 'audio/webm');
  assert.equal(headers['accept-ranges'], 'none');
});

test('/webshare/audio: replays stored EBML init chunk to connecting viewer', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();

  const initChunk = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x02, 0x03, 0x04]);
  server.setAudioInit(initChunk);

  const { body } = await readNBytes(
    `http://127.0.0.1:${port}/webshare/audio`,
    initChunk.length,
  );
  assert.deepEqual(body, initChunk);
});

test('/webshare/audio: broadcasts subsequent chunks to connected viewers', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();

  const audioChunk = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x0A, 0x0B, 0x0C, 0x0D]);

  const received = readNBytes(`http://127.0.0.1:${port}/webshare/audio`, audioChunk.length);
  // Give the connection time to register before broadcasting
  await new Promise((resolve) => setTimeout(resolve, 50));
  server.broadcastAudioChunk(audioChunk);

  const { body } = await received;
  assert.deepEqual(body, audioChunk);
});

test('/webshare/audio: setAudioInit on restart closes existing HTTP viewers', async (t) => {
  const server = createServer(0, '127.0.0.1');
  await server.ready;
  t.after(() => server.close());
  const { port } = server.address();

  const init1 = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0xAA]);
  server.setAudioInit(init1);

  // Connect a viewer and drain the init segment
  const ended = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/webshare/audio`, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(true));
      res.on('error', () => resolve(true)); // destroyed connection also resolves
    });
    req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); else resolve(true); });
    // Simulate a capture restart after the viewer has connected
    setTimeout(() => {
      const init2 = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0xBB]);
      server.setAudioInit(init2); // should close existing HTTP clients
    }, 100);
    setTimeout(() => { req.destroy(); resolve(false); }, 2000);
  });
  assert.equal(ended, true, 'existing HTTP viewer should be closed on stream restart');
});

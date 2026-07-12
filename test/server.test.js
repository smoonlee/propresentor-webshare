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

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
  const message = new Promise((resolve, reject) => {
    client.once('message', resolve);
    client.once('error', reject);
  });
  server.broadcastFrame(frame);
  assert.deepEqual(await message, frame);
});

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { MSE_CODEC_STRING, MSE_AUDIO_CODEC_STRING, getMseCodecString } = require('../src/encoder');

test('builds the correct MSE codec string with and without audio', () => {
  assert.equal(getMseCodecString(false), MSE_CODEC_STRING);
  assert.equal(getMseCodecString(true), `${MSE_CODEC_STRING}, ${MSE_AUDIO_CODEC_STRING}`);
});

test('spawnEncoder includes Windows audio loopback args when audio pass-through is enabled', (t) => {
  const childProcess = require('node:child_process');
  let capturedArgs = null;

  t.mock.method(childProcess, 'spawn', (_command, args) => {
    capturedArgs = args;
    return {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { end() {} },
      on() {},
      kill() {},
    };
  });

  delete require.cache[require.resolve('../src/encoder')];
  const { spawnEncoder } = require('../src/encoder');

  spawnEncoder('libx264', 1280, 720, 30, { includeAudio: true });

  assert.ok(capturedArgs, 'ffmpeg should be spawned');
  assert.deepEqual(capturedArgs.slice(9, 16), ['-thread_queue_size', '1024', '-f', 'wasapi', '-loopback', '1', '-i']);
  assert.equal(capturedArgs[16], 'default');
  assert.ok(capturedArgs.includes('-c:a'));
  assert.ok(capturedArgs.includes('aac'));
  assert.ok(capturedArgs.includes('-ar'));
  assert.ok(capturedArgs.includes('48000'));
  assert.ok(capturedArgs.includes('-ac'));
  assert.ok(capturedArgs.includes('2'));

  delete require.cache[require.resolve('../src/encoder')];
});

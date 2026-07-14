const assert = require('node:assert/strict');
const test = require('node:test');

const { MSE_CODEC_STRING, MSE_AUDIO_CODEC_STRING, getMseCodecString } = require('../src/encoder');

test('builds the correct MSE codec string with and without audio', () => {
  assert.equal(getMseCodecString(false), MSE_CODEC_STRING);
  assert.equal(getMseCodecString(true), `${MSE_CODEC_STRING}, ${MSE_AUDIO_CODEC_STRING}`);
});

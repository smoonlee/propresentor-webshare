const assert = require('node:assert/strict');
const test = require('node:test');

const { buildAudioCapturePlan } = require('../src/audio-capture');

test('routes Windows audio passthrough through WASAPI loopback', () => {
  const plan = buildAudioCapturePlan({ enabled: true, platform: 'win32' });
  assert.equal(plan.enabled, true);
  assert.equal(plan.supported, true);
  assert.ok(plan.inputArgs.includes('wasapi'));
  assert.ok(plan.inputArgs.includes('-loopback'));
});

test('routes Linux audio passthrough through pulse audio', () => {
  const plan = buildAudioCapturePlan({ enabled: true, platform: 'linux', source: 'alsa_output.pci-0000_00_1f.3.analog-stereo.monitor' });
  assert.equal(plan.enabled, true);
  assert.equal(plan.supported, true);
  assert.ok(plan.inputArgs.includes('pulse'));
  assert.ok(plan.inputArgs.includes('alsa_output.pci-0000_00_1f.3.analog-stereo.monitor'));
});

test('requires a source on macOS', () => {
  const plan = buildAudioCapturePlan({ enabled: true, platform: 'darwin' });
  assert.equal(plan.enabled, false);
  assert.equal(plan.supported, false);
  assert.match(plan.warning, /loopback device/i);
});

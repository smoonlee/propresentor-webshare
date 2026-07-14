'use strict';

const { execFileSync } = require('child_process');

function normalizeSource(source) {
  return typeof source === 'string' && source.trim() ? source.trim() : '';
}

function resolveLinuxPulseMonitor(explicitSource) {
  const source = normalizeSource(explicitSource);
  if (source) {
    return { source, label: `PulseAudio/PipeWire source: ${source}` };
  }

  try {
    const sink = execFileSync('pactl', ['get-default-sink'], {
      encoding: 'utf8',
      timeout: 1000,
      windowsHide: true,
    }).trim();
    if (sink) {
      return { source: `${sink}.monitor`, label: `PulseAudio/PipeWire monitor: ${sink}.monitor` };
    }
  } catch (_) {}

  return {
    source: 'default',
    label: 'PulseAudio/PipeWire default source',
  };
}

function buildAudioCapturePlan({ enabled, source, platform = process.platform }) {
  if (!enabled) {
    return {
      enabled: false,
      supported: false,
      label: 'Audio passthrough disabled',
      inputArgs: [],
      outputArgs: [],
      warning: null,
    };
  }

  const normalizedSource = normalizeSource(source);

  if (platform === 'win32') {
    return {
      enabled: true,
      supported: true,
      label: 'Windows WASAPI loopback',
      inputArgs: ['-thread_queue_size', '1024', '-f', 'wasapi', '-loopback', '1', '-i', normalizedSource || 'default'],
      outputArgs: ['-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
      warning: null,
    };
  }

  if (platform === 'linux') {
    const resolved = resolveLinuxPulseMonitor(normalizedSource);
    return {
      enabled: true,
      supported: true,
      label: resolved.label,
      inputArgs: ['-thread_queue_size', '1024', '-f', 'pulse', '-i', resolved.source],
      outputArgs: ['-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
      warning: null,
    };
  }

  if (platform === 'darwin') {
    if (!normalizedSource) {
      return {
        enabled: false,
        supported: false,
        label: 'macOS audio passthrough requires a loopback device',
        inputArgs: [],
        outputArgs: [],
        warning: 'Set an Audio source to a loopback device such as BlackHole/Loopback.',
      };
    }

    return {
      enabled: true,
      supported: true,
      label: `AVFoundation audio source: ${normalizedSource}`,
      inputArgs: ['-thread_queue_size', '1024', '-f', 'avfoundation', '-i', normalizedSource],
      outputArgs: ['-map', '0:v:0', '-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'],
      warning: null,
    };
  }

  return {
    enabled: false,
    supported: false,
    label: `Audio passthrough unavailable on ${platform}`,
    inputArgs: [],
    outputArgs: [],
    warning: 'This platform does not have a supported system-audio backend in the current build.',
  };
}

module.exports = { buildAudioCapturePlan };

'use strict';

const { execFile, spawn } = require('child_process');
const { app } = require('electron');

// MSE codec strings — H.264 High Profile Level 4.0
// Matches the explicit -profile:v high -level 4.0 applied to every encoder below.
const MSE_CODEC_STRING = 'avc1.640028';
// With AAC-LC audio track (mp4a.40.2 = MPEG-4 AAC Low Complexity)
const MSE_CODEC_STRING_WITH_AUDIO = 'avc1.640028, mp4a.40.2';

function getFfmpegPath() {
  const base = require('ffmpeg-static');
  // In a packaged ASAR, the binary is unpacked via asarUnpack config
  if (app.isPackaged) {
    return base.replace(/app\.asar[\\/]/g, 'app.asar.unpacked/');
  }
  return base;
}

// Test whether a given H.264 encoder is available on this machine
function probeCodec(ffmpegPath, codec) {
  return new Promise((resolve) => {
    const args = [
      '-f', 'lavfi', '-i', 'color=black:s=320x240:r=1',  // 64x64 is below NVENC min dimension
      '-vframes', '1',
      '-c:v', codec,
      '-f', 'null', '-',
      '-y',
    ];
    execFile(ffmpegPath, args, { timeout: 4000 }, (err) => resolve(!err));
  });
}

// Detect the best available H.264 encoder, respecting user preference
async function detectCodec(hwPreference) {
  const ffmpegPath = getFfmpegPath();

  // Honour an explicit encoder choice first
  if (hwPreference && hwPreference !== 'auto' && hwPreference !== 'software') {
    const map = { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf' };
    const forced = map[hwPreference];
    if (forced && await probeCodec(ffmpegPath, forced)) {
      return { codec: forced, hw: true, label: forced };
    }
  }

  // Auto-detect: NVENC → QSV → AMF
  if (hwPreference !== 'software') {
    for (const codec of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      if (await probeCodec(ffmpegPath, codec)) {
        return { codec, hw: true, label: codec };
      }
    }
  }

  // Always-available software fallback
  return { codec: 'libx264', hw: false, label: 'libx264 (software)' };
}

// Common output constraints appended to every encoder to ensure the emitted
// H.264 bitstream matches MSE_CODEC_STRING (High Profile Level 4.0, YUV 4:2:0).
const COMMON_OUTPUT = [
  '-profile:v', 'high',
  '-level:v', '4.0',
  '-pix_fmt', 'yuv420p',
];

function buildCodecArgs(codec) {
  switch (codec) {
    case 'h264_nvenc':
      // -keyint_min and -sc_threshold are x264-only; use -g in spawnEncoder for NVENC GOP control
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll',
              '-rc', 'cbr', '-b:v', '4M', '-maxrate', '4M', '-bufsize', '2M',
              ...COMMON_OUTPUT];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '4M',
              ...COMMON_OUTPUT];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-b:v', '4M',
              ...COMMON_OUTPUT];
    default: // libx264
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '23',
              ...COMMON_OUTPUT];
  }
}

// Keyframe every ~100 ms at the given FPS (used for fragmentation)
function keyframeInterval(fps) {
  return Math.max(1, Math.ceil(fps / 10));
}

// List WASAPI render (output) devices available for loopback capture.
// Loopback captures system audio playback from an output device.
function listAudioDevices() {
  const ffmpegPath = getFfmpegPath();
  return new Promise((resolve) => {
    execFile(ffmpegPath, ['-f', 'wasapi', '-list_devices', 'true', '-i', 'dummy'],
      { timeout: 5000 },
      (_err, _stdout, stderr) => {
        const devices = [];
        let inRender = false;
        for (const line of (stderr || '').split('\n')) {
          if (line.includes('WASAPI render devices')) { inRender = true; continue; }
          if (line.includes('WASAPI capture devices')) { inRender = false; continue; }
          if (inRender) {
            const m = line.match(/"([^"@][^"]*)"/); // skip @device_cm_ alternative names
            if (m) devices.push(m[1]);
          }
        }
        resolve(devices);
      }
    );
  });
}

// Spawn an ffmpeg process: reads raw BGRA frames on stdin, outputs fragmented MP4 on stdout.
// When audioDevice is a non-empty string, adds a WASAPI loopback input before the video pipe.
function spawnEncoder(codec, width, height, fps, audioDevice = null) {
  const ffmpegPath = getFfmpegPath();
  const kf = keyframeInterval(fps);

  // -keyint_min and -sc_threshold are libx264-specific; omit for HW encoders
  const x264Only = codec === 'libx264'
    ? ['-keyint_min', String(kf), '-sc_threshold', '0']
    : [];

  // When audio is requested, WASAPI render device (input 0) precedes the video pipe (input 1)
  const audioInputArgs = audioDevice
    ? ['-f', 'wasapi', '-thread_queue_size', '512', '-loopback', '-i', audioDevice]
    : [];
  const mapArgs = audioDevice
    ? ['-map', '1:v:0', '-map', '0:a:0']
    : [];
  const audioOutputArgs = audioDevice
    ? ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000']
    : [];

  const args = [
    '-hide_banner', '-loglevel', 'error',   // suppress banner/progress; only real errors
    ...audioInputArgs,
    '-f', 'rawvideo', '-pix_fmt', 'bgra',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
    ...mapArgs,
    ...buildCodecArgs(codec),
    '-g', String(kf),
    ...x264Only,
    ...audioOutputArgs,
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset',
    '-f', 'mp4',
    'pipe:1',
  ];

  return spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

module.exports = { detectCodec, spawnEncoder, listAudioDevices, MSE_CODEC_STRING, MSE_CODEC_STRING_WITH_AUDIO };

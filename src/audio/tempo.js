'use strict';
// Speech pacing (per-channel `speech_rate`).
//
// NavyAI's ElevenLabs models expose NO speed parameter — their `speed` option is OpenAI-models-only —
// so a channel's pacing is applied here as a pitch-preserving time-stretch on the generated audio
// (ffmpeg `atempo`). The voice keeps its pitch and character; only the tempo changes.
//
// Only the SPEECH is re-timed. The pauses between hook/chapters/CTAs are inserted later by the
// stitcher at their exact configured lengths, so `pause_seconds` stays literal regardless of rate.
//
// rate > 1 = faster, rate < 1 = slower. Modest rates (~0.85-1.2) are transparent; well beyond that
// you start to hear time-stretch artifacts.

const fs = require('fs');
const { execFile } = require('child_process');
const FFMPEG = require('./ffmpegPath');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 64 }, (err, _o, stderr) => {
      if (err) return reject(new Error(stderr ? String(stderr).split('\n').slice(-3).join(' ') : err.message));
      resolve();
    });
  });
}

// ffmpeg's atempo is only valid for factors in 0.5..2.0, so build a chain whose product equals `rate`.
// e.g. 0.4 -> "atempo=0.500000,atempo=0.800000"
function atempoChain(rate) {
  const parts = [];
  let r = Number(rate);
  while (r < 0.5) { parts.push(0.5); r /= 0.5; }
  while (r > 2.0) { parts.push(2.0); r /= 2.0; }
  parts.push(r);
  return parts.map((x) => 'atempo=' + Number(x).toFixed(6)).join(',');
}

// Re-time an audio file in place. Returns true if it changed the file, false when it was a no-op
// (rate missing, invalid, or effectively 1.0).
async function retime(file, rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0 || Math.abs(r - 1) < 0.001) return false;
  const tmp = file + '.rt.mp3';
  await runFfmpeg(['-y', '-i', file, '-filter:a', atempoChain(r), '-c:a', 'libmp3lame', '-q:a', '2', tmp]);
  fs.renameSync(tmp, file);
  return true;
}

module.exports = { retime, atempoChain };

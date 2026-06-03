'use strict';
// Mock TTS: produces a real mp3 whose duration scales with the text length, so the whole
// pipeline (stitch, naming, dashboard playback, Trello attach) can be tested without any
// 69labs account. A soft low tone marks where each segment is, so boundaries are audible.

const { execFile } = require('child_process');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 32 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(stderr ? stderr.split('\n').slice(-3).join(' ') : err.message));
      resolve();
    });
  });
}

function estimateSeconds(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  // ~150 wpm narration => 2.5 words/sec. Clamp so mock jobs stay quick.
  const seconds = words / 2.5;
  return Math.max(1.5, Math.min(seconds, 30));
}

async function synthesize({ text, outPath }) {
  const duration = estimateSeconds(text).toFixed(2);
  // Quiet 180 Hz tone at low volume; mono; 44.1k; mp3.
  await runFfmpeg([
    '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=180:duration=${duration}`,
    '-filter:a', 'volume=0.15',
    '-ar', '44100',
    '-ac', '1',
    '-c:a', 'libmp3lame',
    '-q:a', '5',
    outPath,
  ]);
}

module.exports = { synthesize, name: 'mock' };

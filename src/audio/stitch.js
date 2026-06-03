'use strict';
// Stitch ordered segments into one mp3, inserting a pause before each segment after the first.
// Pause length depends on the boundary: after the hook => pauses.after_hook; between chapters
// => pauses.between_chapters. Uses ffmpeg's concat filter with per-input normalization, so it
// works no matter what format each segment came back in (mock mp3 today, 69labs audio later).

const { execFile } = require('child_process');
const FFMPEG = require('./ffmpegPath');

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 64 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(stderr ? stderr.split('\n').slice(-4).join(' ') : err.message));
      resolve();
    });
  });
}

// Build the ordered list of inputs: real segment files interleaved with silence.
function buildPlan(segments, pauses) {
  const afterHook = Number(pauses.after_hook ?? 0.8);
  const betweenChapters = Number(pauses.between_chapters ?? 0.6);
  const plan = [];

  segments.forEach((seg, i) => {
    if (i > 0) {
      // Prefer an explicit per-segment pause (the skill sets this per the channel's voiceover
      // config); otherwise fall back to the kind-based default map.
      let dur;
      if (typeof seg.pause_before === 'number') {
        dur = seg.pause_before;
      } else {
        const prev = segments[i - 1];
        dur = prev.kind === 'hook' ? afterHook : betweenChapters;
      }
      if (dur > 0) plan.push({ type: 'silence', dur });
    }
    plan.push({ type: 'file', path: seg.file });
  });

  return plan;
}

async function stitch({ segments, pauses = {}, outPath }) {
  if (!segments || !segments.length) throw new Error('stitch: no segments');

  const plan = buildPlan(segments, pauses);

  const inputArgs = [];
  const filterParts = [];
  const concatLabels = [];

  plan.forEach((item, idx) => {
    if (item.type === 'file') {
      inputArgs.push('-i', item.path);
    } else {
      inputArgs.push('-f', 'lavfi', '-t', String(item.dur), '-i', 'anullsrc=r=44100:cl=mono');
    }
    // Normalize every input to the same sr/layout/format so concat is safe across providers.
    filterParts.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=mono[a${idx}]`);
    concatLabels.push(`[a${idx}]`);
  });

  const filter =
    filterParts.join(';') +
    ';' +
    concatLabels.join('') +
    `concat=n=${plan.length}:v=0:a=1[out]`;

  const args = [
    '-y',
    ...inputArgs,
    '-filter_complex', filter,
    '-map', '[out]',
    '-c:a', 'libmp3lame',
    '-q:a', '2',
    outPath,
  ];

  await runFfmpeg(args);
  return outPath;
}

module.exports = { stitch, buildPlan };

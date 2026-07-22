'use strict';
// Stitch ordered segments into one mp3, inserting a pause before each segment after the first.
// Pause length depends on the boundary: after the hook => pauses.after_hook; between chapters
// => pauses.between_chapters. Uses ffmpeg's concat filter with per-input normalization, so it
// works no matter what format each segment came back in.
//
// CHUNKED STITCHING (22 Jul 2026): one giant ffmpeg invocation breaks at high input counts —
// a 62-segment job (62 files + 61 silence gaps = 123 inputs in one filtergraph) made libmp3lame
// fail with EINVAL at encoder init, reproducibly, while 17–21 segment jobs were fine. So above
// MAX_INPUTS_PER_PASS the plan is stitched in groups: each group -> a lossless WAV intermediate
// (identical params: 44.1kHz mono s16), then the few intermediates are concatenated and encoded
// to mp3 ONCE. Same output quality as before (single mp3 encode), any segment count.

const fs = require('fs');
const { execFile } = require('child_process');
const FFMPEG = require('./ffmpegPath');

// Highest input count per ffmpeg invocation. 21-segment jobs (43 inputs) are proven fine in
// production; 123 inputs is proven broken. 28 keeps every pass well inside proven territory.
const MAX_INPUTS_PER_PASS = 28;

function runFfmpeg(args, label) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 1024 * 1024 * 64 }, (err, _stdout, stderr) => {
      if (err) {
        const tail = stderr ? stderr.split('\n').slice(-4).join(' ') : err.message;
        // Include what we asked ffmpeg to do — without this, stitch failures are undebuggable.
        const preview = args.join(' ').slice(0, 400);
        return reject(new Error(`${label || 'ffmpeg'}: ${tail} | cmd: ffmpeg ${preview}…`));
      }
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

// One ffmpeg pass over a slice of the plan. `codecArgs` decides the output format:
// lossless WAV for intermediates, libmp3lame for the final file.
async function stitchPass(planSlice, outPath, codecArgs, label) {
  const inputArgs = [];
  const filterParts = [];
  const concatLabels = [];

  planSlice.forEach((item, idx) => {
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
    `concat=n=${planSlice.length}:v=0:a=1[out]`;

  const args = ['-y', ...inputArgs, '-filter_complex', filter, '-map', '[out]', ...codecArgs, outPath];
  await runFfmpeg(args, label);
  return outPath;
}

const MP3_ARGS = ['-c:a', 'libmp3lame', '-q:a', '2'];
const WAV_ARGS = ['-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1'];

async function stitch({ segments, pauses = {}, outPath }) {
  if (!segments || !segments.length) throw new Error('stitch: no segments');

  const plan = buildPlan(segments, pauses);

  // Small jobs: single pass straight to mp3, exactly as before.
  if (plan.length <= MAX_INPUTS_PER_PASS) {
    return stitchPass(plan, outPath, MP3_ARGS, 'stitch');
  }

  // Big jobs: group the plan, render each group to a lossless WAV intermediate, then join the
  // intermediates and encode mp3 once. Group boundaries preserve order exactly, so pauses that
  // land at a boundary still play at their configured length.
  const groups = [];
  for (let i = 0; i < plan.length; i += MAX_INPUTS_PER_PASS) {
    groups.push(plan.slice(i, i + MAX_INPUTS_PER_PASS));
  }
  if (groups.length > MAX_INPUTS_PER_PASS) {
    // ~780+ inputs (≈390 segments) — far beyond anything real; refuse loudly rather than guess.
    throw new Error(`stitch: plan of ${plan.length} inputs exceeds two-level chunking capacity`);
  }

  const intermediates = [];
  try {
    for (let g = 0; g < groups.length; g++) {
      const part = `${outPath}.group${String(g).padStart(2, '0')}.wav`;
      await stitchPass(groups[g], part, WAV_ARGS, `stitch-group ${g + 1}/${groups.length}`);
      intermediates.push(part);
    }
    const finalPlan = intermediates.map((p) => ({ type: 'file', path: p }));
    await stitchPass(finalPlan, outPath, MP3_ARGS, 'stitch-final');
    return outPath;
  } finally {
    for (const p of intermediates) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }
  }
}

module.exports = { stitch, buildPlan };

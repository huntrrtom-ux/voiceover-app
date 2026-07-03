'use strict';
// Loudness QC. Detects a SUSTAINED quiet stretch inside a chapter's audio — the "voice drops off
// for a minute" artifact the TTS occasionally produces — so the queue can regenerate just that
// chapter instead of the whole video. We only DETECT here; we never alter levels.
//
// Method: run ffmpeg's ebur128 filter over each segment and read its short-term (3s) loudness
// (LUFS) roughly every 0.1s. Pool all segments' samples to get the track's TYPICAL level (median),
// then flag any segment that contains a contiguous run of >= minDropSeconds sitting >= dropDb below
// that typical level. Short-term (3s) smoothing means normal sentence pauses never trip it — only a
// genuine, sustained drop does.

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

// Profile one audio file: returns { file, samples:[{t,s}], duration }. s = short-term LUFS.
// Never rejects — a QC read failure must not fail the job (caller treats empty samples as "clean").
function profileSegment(file) {
  return new Promise((resolve) => {
    execFile(
      FFMPEG,
      ['-hide_banner', '-nostats', '-i', file, '-filter_complex', 'ebur128', '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 * 256 },
      (_err, _stdout, stderr) => {
        const text = stderr || '';
        const samples = [];
        let duration = 0;
        // Lines look like: "... t: 12.3  TARGET:-23 LUFS  M: -20.1 S: -19.8  I: -20.0 LUFS ..."
        const re = /t:\s*([\d.]+).*?S:\s*(-?[\d.]+|-?inf|nan)/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const t = parseFloat(m[1]);
          let s = parseFloat(m[2]);
          if (!Number.isFinite(s)) s = -120; // -inf / nan → treat as digital silence
          samples.push({ t, s });
          if (t > duration) duration = t;
        }
        resolve({ file, samples, duration });
      }
    );
  });
}

function median(arr) {
  if (!arr.length) return NaN;
  const a = [...arr].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Given per-segment profiles, return one result per segment describing its worst sustained drop
// relative to the whole track's typical loudness. opts: { dropDb, minDropSeconds, warmupSeconds,
// silenceFloor }.
function detectDrops(profiles, opts) {
  const dropDb = Number(opts.dropDb);
  const minDropSeconds = Number(opts.minDropSeconds);
  const warmup = Number(opts.warmupSeconds);
  const silenceFloor = Number(opts.silenceFloor);

  // Typical level = median of all real-speech short-term samples across every segment (skip each
  // segment's 3s warm-up where short-term loudness is not yet valid, and skip digital silence).
  const pool = [];
  for (const p of profiles) {
    for (const s of p.samples) {
      if (s.t >= warmup && s.s > silenceFloor) pool.push(s.s);
    }
  }
  const typical = median(pool);
  const threshold = typical - dropDb;

  return profiles.map((p, index) => {
    let best = null; // { dur, start, end, vals }
    let curStart = null;
    let curEnd = null;
    let curVals = [];
    const flush = () => {
      if (curStart != null) {
        const dur = curEnd - curStart;
        if (!best || dur > best.dur) best = { dur, start: curStart, end: curEnd, vals: curVals };
      }
      curStart = null;
      curEnd = null;
      curVals = [];
    };
    for (const s of p.samples) {
      if (s.t < warmup) continue;
      if (s.s < threshold) {
        if (curStart == null) curStart = s.t;
        curEnd = s.t;
        curVals.push(s.s);
      } else {
        flush();
      }
    }
    flush();

    const flagged = Number.isFinite(typical) && best != null && best.dur >= minDropSeconds;
    const runMean = best && best.vals.length ? best.vals.reduce((a, b) => a + b, 0) / best.vals.length : 0;
    return {
      index,
      flagged,
      runSeconds: best ? best.dur : 0,
      worstStart: best ? best.start : 0,
      worstEnd: best ? best.end : 0,
      belowBy: best ? typical - runMean : 0,
      typical,
      threshold,
      duration: p.duration,
    };
  });
}

// Cumulative start time of each segment in the FINAL stitched track, mirroring stitch.buildPlan's
// pause logic, so a flagged in-segment window can be reported as an absolute timestamp.
function segmentOffsets(segments, durations, pauses = {}) {
  const afterHook = Number(pauses.after_hook ?? 0.8);
  const between = Number(pauses.between_chapters ?? 0.6);
  const offs = [];
  let off = 0;
  segments.forEach((seg, i) => {
    if (i > 0) {
      let dur;
      if (typeof seg.pause_before === 'number') dur = seg.pause_before;
      else dur = segments[i - 1].kind === 'hook' ? afterHook : between;
      if (dur > 0) off += dur;
    }
    offs[i] = off;
    off += durations[i] || 0;
  });
  return offs;
}

function hms(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n, w) => String(n).padStart(w, '0');
  return (h ? h + ':' + pad(m, 2) : m) + ':' + pad(ss, 2);
}

// Lift a quiet window [start, end] (seconds) inside an audio file by `gainDb`, with a short ramp at
// each edge so there is no audible volume step. Rewrites `file` in place. This is the ONE place the
// pipeline changes levels, and only on a sustained drop that regeneration could not clear — the goal
// is to bring the dip up to the rest of the file, so the video is internally consistent.
async function levelWindow(file, start, end, gainDb, opts = {}) {
  const R = Number(opts.rampSeconds ?? 0.6);
  const Gf = Math.pow(10, Number(gainDb) / 20);           // dB -> linear amplitude factor
  const S = Math.max(0, Number(start));
  const E = Math.max(S, Number(end));
  const s0 = (S - R).toFixed(3);
  const e1 = (E + R).toFixed(3);
  const r = R.toFixed(3);
  const g = Gf.toFixed(5);
  // Trapezoidal envelope: 1.0 outside [S-R, E+R], ramps up to Gf across R, holds Gf across [S, E].
  // ffmpeg's min/max take exactly two args, so they're nested. Commas are escaped (\,) so ffmpeg
  // doesn't read them as filter separators.
  const env = `max(0\\,min(1\\,min((t-(${s0}))/${r}\\,((${e1})-t)/${r})))`;
  const expr = `1+(${g}-1)*${env}`;
  const tmp = file + '.lvl.mp3';
  await runFfmpeg(['-y', '-i', file, '-af', `volume=eval=frame:volume=${expr}`, '-c:a', 'libmp3lame', '-q:a', '2', tmp]);
  fs.renameSync(tmp, file);
}

module.exports = { profileSegment, detectDrops, segmentOffsets, hms, median, levelWindow };

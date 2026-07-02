'use strict';
// Sequential in-process job runner. Good for one-person volume; jobs run one at a time so a
// big stitch never starves the box. Each stage retries up to config.maxRetries, then the job
// is flagged "error" (never silently dropped).

const fs = require('fs');
const path = require('path');
const config = require('../config');
const store = require('./store');
const { getProvider } = require('../tts');
const { stitch } = require('../audio/stitch');
const loudness = require('../audio/loudness');
const trello = require('../trello/client');

let running = false;
const pending = [];

async function withRetry(jobId, stage, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      store.log(jobId, stage + ' attempt ' + attempt + ' failed: ' + err.message);
    }
  }
  throw new Error(stage + ' failed after ' + config.maxRetries + ' attempts: ' + lastErr.message);
}

function sanitizeFilename(name) {
  return String(name).replace(/[^\w\- .]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180);
}

// Split a chapter's text into roughly-equal chunks at sentence boundaries, for re-rolling a flagged
// chapter as several smaller TTS requests. Returns [text] when it can't be meaningfully split.
function splitText(text, k) {
  const src = String(text);
  const sentences = src.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [src];
  if (sentences.length < 2 || k < 2) return [src];
  const target = src.length / k;
  const buckets = [];
  let cur = '';
  for (const s of sentences) {
    cur += s;
    if (cur.length >= target && buckets.length < k - 1) { buckets.push(cur); cur = ''; }
  }
  if (cur.trim()) buckets.push(cur);
  return buckets.filter((b) => b.trim().length);
}

// Re-roll a flagged chapter by re-synthesizing it SPLIT into `parts` smaller chunks, then stitching
// the chunks back into the chapter's file. A long single TTS request is what makes 69labs render a
// chapter quiet, and it does so deterministically — re-rolling the identical whole text reproduces
// the same drop. Splitting changes the inputs and almost always breaks the quiet render, with NO
// level changes. `synth(seg, outPath)` is the job's segment synthesizer.
async function regenerateSplit(jobId, seg, workDir, parts, synth) {
  const chunks = splitText(seg.text, parts);
  if (chunks.length < 2) {
    // Unsplittable (e.g. one very long sentence) — fall back to a plain full re-synth.
    await withRetry(jobId, 'tts-regen[' + seg.kind + '#' + seg.index + ']', () => synth(seg, seg.file));
    return;
  }
  const partFiles = [];
  for (let i = 0; i < chunks.length; i++) {
    const pf = path.join(workDir, String(seg.index).padStart(3, '0') + '-' + seg.kind + '.part' + i + '.mp3');
    const chunkSeg = { text: chunks[i], kind: seg.kind, index: seg.index };
    await withRetry(jobId, `tts-regen[${seg.kind}#${seg.index}.p${i}]`, () => synth(chunkSeg, pf));
    // Tiny sentence-gap between chunks (not a level change) so the chapter plays as one piece.
    partFiles.push({ file: pf, kind: seg.kind, pause_before: i === 0 ? undefined : 0.12 });
  }
  await withRetry(jobId, `regen-concat[${seg.kind}#${seg.index}]`, () =>
    stitch({ segments: partFiles, pauses: {}, outPath: seg.file })
  );
}

async function process(jobId) {
  const job = store.get(jobId);
  if (!job) return;
  store.update(jobId, { status: 'running' });
  store.log(jobId, 'job started');

  const payload = job.payload;

  // Description-only update (timestamped channels): no audio — just set the card description on the
  // card the original voiceover job already created.
  if (payload.description_only) {
    try {
      const t = payload.trello || {};
      if (!config.trello.enabled) {
        store.log(jobId, 'trello skipped: TRELLO_KEY/TRELLO_TOKEN not set');
      } else {
        const cardId = await withRetry(jobId, 'trello-desc', () =>
          trello.setDescriptionByCard({
            boardId: t.board_id,
            label: t.label,
            title: t.card_title || payload.working_title,
            description: t.description,
            due: t.due,
          })
        );
        store.update(jobId, { trello_card_id: cardId });
        store.log(jobId, 'updated description on Trello card ' + cardId);
      }
      store.update(jobId, { status: 'done', error: null });
      store.log(jobId, 'job done');
    } catch (err) {
      store.update(jobId, { status: 'error', error: err.message });
      store.log(jobId, 'JOB FAILED: ' + err.message);
    }
    return;
  }

  const provider = getProvider();
  const workDir = path.join(config.paths.AUDIO_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // A segment's TTS call, reused for the initial synth and for QC regeneration.
    const synthSegment = (seg, outPath) =>
      provider.synthesize({
        text: seg.text,
        voiceId: payload.voice_id,
        model: payload.model,
        voiceProvider: payload.voice_provider,
        voiceCloneId: payload.voice_clone_id,
        voiceSettings: payload.voice_settings,
        minimaxSettings: payload.minimax_settings,
        outPath,
      });

    // 1) Synthesize each segment (retry per segment).
    const segmentFiles = [];
    for (const seg of payload.segments) {
      const outPath = path.join(workDir, String(seg.index).padStart(3, '0') + '-' + seg.kind + '.mp3');
      await withRetry(jobId, 'tts[' + seg.kind + '#' + seg.index + ']', () => synthSegment(seg, outPath));
      segmentFiles.push(Object.assign({}, seg, { file: outPath }));
      store.log(jobId, 'synthesized ' + seg.kind + ' #' + seg.index);
    }

    // 1.5) Loudness QC: find any chapter with a sustained quiet stretch and regenerate ONLY that
    // chapter (up to maxRegenRounds). Detection-only; we never touch levels. Fail-open — a QC error
    // must never fail the job. Anything still quiet after the regen budget ships with a warning.
    let loudnessWarnings = [];
    if (config.loudnessCheck.enabled) {
      try {
        const lc = config.loudnessCheck;
        for (let round = 0; round <= lc.maxRegenRounds; round++) {
          const profiles = await Promise.all(segmentFiles.map((s) => loudness.profileSegment(s.file)));
          const results = loudness.detectDrops(profiles, lc);
          const flagged = results.filter((r) => r.flagged);
          if (!flagged.length) { loudnessWarnings = []; break; }

          if (round === lc.maxRegenRounds) {
            // Out of regen budget: record warnings with absolute timestamps in the final track.
            const durations = profiles.map((p) => p.duration);
            const offs = loudness.segmentOffsets(segmentFiles, durations, payload.pauses || {});
            loudnessWarnings = flagged.map((f) => {
              const seg = segmentFiles[f.index];
              return {
                index: seg.index,
                chapter: seg.kind + ' #' + seg.index,
                start_hms: loudness.hms(offs[f.index] + f.worstStart),
                end_hms: loudness.hms(offs[f.index] + f.worstEnd),
                run_seconds: Math.round(f.runSeconds),
                below_db: Math.round(f.belowBy * 10) / 10,
              };
            });
            loudnessWarnings.forEach((w) =>
              store.log(jobId, `loudness: ${w.chapter} still ~${w.below_db}dB low for ${w.run_seconds}s at ${w.start_hms}-${w.end_hms} after ${lc.maxRegenRounds} regens — shipping with warning`)
            );
            break;
          }

          // Re-roll each flagged chapter SPLIT into smaller chunks (more each round: 2, then 3...).
          // Splitting changes the TTS inputs, which breaks 69labs' deterministic quiet render without
          // touching levels. Then re-analyze on the next round.
          const parts = round + 2;
          for (const f of flagged) {
            const seg = segmentFiles[f.index];
            store.log(jobId, `loudness: ${seg.kind} #${seg.index} has a ${Math.round(f.runSeconds)}s quiet stretch (~${Math.round(f.belowBy * 10) / 10}dB below typical) — re-rolling split into ${parts} parts`);
            await regenerateSplit(jobId, seg, workDir, parts, synthSegment);
          }
        }
      } catch (qcErr) {
        store.log(jobId, 'loudness QC skipped (error): ' + qcErr.message);
        loudnessWarnings = [];
      }
      store.update(jobId, { loudness_warnings: loudnessWarnings });
    }

    // 2) Stitch with pauses (retry).
    const baseName = sanitizeFilename(payload.output_name || payload.working_title || jobId);
    const finalName = baseName + '.mp3';
    const finalPath = path.join(config.paths.AUDIO_DIR, jobId + '__' + finalName);
    await withRetry(jobId, 'stitch', () =>
      stitch({ segments: segmentFiles, pauses: payload.pauses || {}, outPath: finalPath })
    );
    const audioUrl = config.publicBaseUrl + '/audio/' + jobId + '__' + encodeURIComponent(finalName);
    store.update(jobId, { audio_file: finalName, audio_url: audioUrl });
    store.log(jobId, 'stitched -> ' + finalName);

    // 3) Trello (retry). Prefer board+label (web app owns the card); else a direct card id; else skip.
    const t = payload.trello;
    if (t && t.board_id && t.label) {
      if (!config.trello.enabled) {
        store.log(jobId, 'trello skipped: TRELLO_KEY/TRELLO_TOKEN not set');
      } else {
        const cardId = await withRetry(jobId, 'trello', () =>
          trello.placeOnCard({
            boardId: t.board_id,
            listId: t.list_id,
            listName: t.list_name,
            label: t.label,
            title: t.card_title || payload.working_title,
            description: t.description,
            thumbnailPrompt: t.thumbnail_prompt,
            ebookComment: t.ebook_comment,
            ebookUrl: t.ebook_url,
            due: t.due,
            filePath: finalPath,
            fileName: finalName,
          })
        );
        store.update(jobId, { trello_attached: true, trello_card_id: cardId });
        store.log(jobId, 'placed on Trello card ' + cardId);
        // If a quiet stretch survived regeneration, leave a heads-up comment so the editor can
        // check that spot. Best-effort — never fails the job.
        if (loudnessWarnings.length) {
          const lines = loudnessWarnings
            .map((w) => `• ${w.chapter}: ~${w.start_hms}-${w.end_hms} (~${w.below_db}dB below the rest, ${w.run_seconds}s)`)
            .join('\n');
          await trello
            .addComment(cardId, `Audio QC — possible quiet stretch(es) worth a manual listen:\n${lines}`)
            .catch((e) => store.log(jobId, 'loudness note comment failed: ' + e.message));
        }
      }
    } else if (payload.trello_card_id) {
      if (!config.trello.enabled) {
        store.log(jobId, 'trello skipped: TRELLO_KEY/TRELLO_TOKEN not set');
      } else {
        await withRetry(jobId, 'trello', () =>
          trello.attachToCard({ cardId: payload.trello_card_id, filePath: finalPath, fileName: finalName })
        );
        store.update(jobId, { trello_attached: true });
        store.log(jobId, 'attached to Trello card ' + payload.trello_card_id);
      }
    } else {
      store.log(jobId, 'no trello target provided; skipping attach');
    }

    store.update(jobId, { status: 'done', error: null });
    store.log(jobId, 'job done');
  } catch (err) {
    store.update(jobId, { status: 'error', error: err.message });
    store.log(jobId, 'JOB FAILED: ' + err.message);
  }
}

async function drain() {
  if (running) return;
  running = true;
  // Stop pulling NEW jobs while production is paused. A job already running finishes; the rest
  // wait in `pending` (and in the store as status:queued) until resume() kicks the drain again.
  while (pending.length && !store.getControl().paused) {
    const id = pending.shift();
    const job = store.get(id);
    if (!job || job.status === 'deleted') continue; // cancelled while queued
    await process(id);
  }
  running = false;
}

function enqueue(jobId) {
  if (!pending.includes(jobId)) pending.push(jobId);
  setImmediate(drain);
}

// Remove a still-queued job from the in-memory queue (used when it's deleted/redone before it runs).
function cancel(jobId) {
  const i = pending.indexOf(jobId);
  if (i !== -1) pending.splice(i, 1);
}

// Called after unpausing to restart processing.
function resume() {
  setImmediate(drain);
}

// On startup, re-enqueue anything left queued in the store (survives a restart). Honors pause.
function recover() {
  for (const j of store.list()) {
    if (j.status === 'queued') enqueue(j.job_id);
  }
}

module.exports = { enqueue, process, cancel, resume, recover, isPaused: () => store.getControl().paused };

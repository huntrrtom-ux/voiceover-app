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

async function process(jobId) {
  const job = store.get(jobId);
  if (!job) return;
  store.update(jobId, { status: 'running' });
  store.log(jobId, 'job started');

  const payload = job.payload;
  const provider = getProvider();
  const workDir = path.join(config.paths.AUDIO_DIR, jobId);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    // 1) Synthesize each segment (retry per segment).
    const segmentFiles = [];
    for (const seg of payload.segments) {
      const outPath = path.join(workDir, String(seg.index).padStart(3, '0') + '-' + seg.kind + '.mp3');
      await withRetry(jobId, 'tts[' + seg.kind + '#' + seg.index + ']', () =>
        provider.synthesize({
          text: seg.text,
          voiceId: payload.voice_id,
          model: payload.model,
          voiceProvider: payload.voice_provider,
          voiceCloneId: payload.voice_clone_id,
          voiceSettings: payload.voice_settings,
          minimaxSettings: payload.minimax_settings,
          outPath,
        })
      );
      segmentFiles.push(Object.assign({}, seg, { file: outPath }));
      store.log(jobId, 'synthesized ' + seg.kind + ' #' + seg.index);
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
            filePath: finalPath,
            fileName: finalName,
          })
        );
        store.update(jobId, { trello_attached: true, trello_card_id: cardId });
        store.log(jobId, 'placed on Trello card ' + cardId);
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
  while (pending.length) {
    const id = pending.shift();
    await process(id);
  }
  running = false;
}

function enqueue(jobId) {
  pending.push(jobId);
  setImmediate(drain);
}

module.exports = { enqueue, process };

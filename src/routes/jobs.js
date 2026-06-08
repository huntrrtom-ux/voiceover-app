'use strict';
const express = require('express');
const store = require('../jobs/store');
const queue = require('../jobs/queue');

const router = express.Router();

function validatePayload(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['body must be JSON'];

  // Description-only update job (timestamped channels): no audio, just sets the card description on
  // an existing card. Requires a trello target + description, but no segments.
  if (body.description_only) {
    const t = body.trello || {};
    if (!t.board_id) errors.push('description_only: trello.board_id is required');
    if (!t.label) errors.push('description_only: trello.label is required');
    if (!t.card_title && !body.working_title) errors.push('description_only: trello.card_title (or working_title) is required');
    if (typeof t.description !== 'string' || !t.description.trim()) errors.push('description_only: trello.description is required');
    return errors;
  }

  if (!body.slug) errors.push('slug is required');
  if (!body.working_title) errors.push('working_title is required');
  if (!Array.isArray(body.segments) || body.segments.length === 0) {
    errors.push('segments must be a non-empty array');
  } else {
    body.segments.forEach((s, i) => {
      if (typeof s.text !== 'string' || !s.text.trim()) errors.push(`segments[${i}].text is empty`);
      if (!s.kind) errors.push(`segments[${i}].kind is required (hook|chapter)`);
    });
  }
  return errors;
}

// Create a job (the skill's handoff target).
router.post('/jobs', (req, res) => {
  const errors = validatePayload(req.body);
  if (errors.length) return res.status(400).json({ error: 'invalid payload', details: errors });

  const job = store.create(req.body);
  queue.enqueue(job.job_id);
  res.status(202).json({ job_id: job.job_id, status: job.status });
});

// List jobs (for the dashboard).
router.get('/jobs', (_req, res) => {
  res.json(store.list().map(publicView));
});

// Job status.
router.get('/jobs/:id', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  res.json(publicView(job));
});

// Re-run a job (e.g. after a transient failure) reusing its original payload.
router.post('/jobs/:id/retry', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  store.update(job.job_id, { status: 'queued', error: null });
  store.log(job.job_id, 're-queued via /retry');
  queue.enqueue(job.job_id);
  res.json({ job_id: job.job_id, status: 'queued' });
});

// Delete a job and its audio from the app (Trello attachments are unaffected).
router.delete('/jobs/:id', (req, res) => {
  queue.cancel(req.params.id);
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, deleted: req.params.id });
});

// Redo = delete this job AND record a remake request so its idea is re-added to the channel's
// local ideas-queue (the watcher does the local write-back). Use when a script came out wrong.
router.post('/jobs/:id/redo', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const remake = store.addRemake({
    channel_id: job.payload?.channel_id,
    working_title: job.payload?.working_title,
    slug: job.payload?.slug,
  });
  queue.cancel(job.job_id);
  store.remove(job.job_id);
  res.json({ ok: true, deleted: job.job_id, remake });
});

// Clear all finished (done + error) jobs and their audio. Queued/running are untouched.
router.post('/jobs/clear-finished', (_req, res) => res.json({ ok: true, removed: store.clearFinished() }));

// ---- Global production control ----
router.get('/control', (_req, res) => res.json(store.getControl()));
router.post('/control/pause', (_req, res) => res.json(store.setPaused(true)));
router.post('/control/resume', (_req, res) => { const c = store.setPaused(false); queue.resume(); res.json(c); });

// ---- Remake queue (the local watcher drains this and writes back to the ideas-queue files) ----
router.get('/remakes', (_req, res) => res.json(store.listRemakes()));
router.post('/remakes/:id/ack', (req, res) => {
  const ok = store.ackRemake(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

function publicView(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    channel_id: job.payload?.channel_id || null,
    working_title: job.payload?.working_title || null,
    slug: job.payload?.slug || null,
    segments: (job.segment_count != null ? job.segment_count : (job.payload?.segments?.length || 0)),
    chars: (job.char_count != null ? job.char_count : store.countChars(job.payload)),
    created_at: job.created_at,
    updated_at: job.updated_at,
    audio_file: job.audio_file,
    audio_url: job.audio_url,
    trello_card_id: job.payload?.trello_card_id || null,
    trello_attached: job.trello_attached,
    error: job.error,
    log: job.log,
  };
}

module.exports = router;
module.exports.publicView = publicView;

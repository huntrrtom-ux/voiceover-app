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
  const ok = store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true, deleted: req.params.id });
});

function publicView(job) {
  return {
    job_id: job.job_id,
    status: job.status,
    channel_id: job.payload?.channel_id || null,
    working_title: job.payload?.working_title || null,
    slug: job.payload?.slug || null,
    segments: job.payload?.segments?.length || 0,
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

'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const jobsRouter = require('./routes/jobs');

const app = express();
app.use(express.json({ limit: '5mb' }));

// Health check (Render hits /healthz).
app.get('/healthz', (_req, res) => res.json({ ok: true, provider: config.ttsProvider }));

// Serve stitched audio files.
fs.mkdirSync(config.paths.AUDIO_DIR, { recursive: true });
app.use('/audio', express.static(config.paths.AUDIO_DIR));

// Dashboard (no key required to view; it only reads job metadata on this private deployment).
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// API key guard for everything under /api.
app.use('/api', (req, res, next) => {
  if (!config.apiKey) return next(); // if unset (local dev), allow.
  if (req.get('x-api-key') === config.apiKey) return next();
  return res.status(401).json({ error: 'unauthorized: missing or wrong x-api-key' });
});
app.use('/api', jobsRouter);

// The dashboard reads jobs without the secret key (read-only listing on a private box).
const store = require('./jobs/store');
const queue = require('./jobs/queue');
app.get('/dashboard-data', (_req, res) => res.json(store.list().map((j) => ({
  job_id: j.job_id, status: j.status, working_title: j.payload?.working_title,
  channel_id: j.payload?.channel_id, slug: j.payload?.slug,
  segments: (j.segment_count != null ? j.segment_count : (j.payload?.segments?.length || 0)),
  chars: (j.char_count != null ? j.char_count : store.countChars(j.payload)),
  audio_url: j.audio_url,
  trello_attached: j.trello_attached, error: j.error,
  created_at: j.created_at, updated_at: j.updated_at, log: j.log,
}))));

// Queue dashboard data: jobs + the global pause state, in one read.
app.get('/queue-data', (_req, res) => res.json({
  control: store.getControl(),
  jobs: store.list().map((j) => ({
    job_id: j.job_id, status: j.status, working_title: j.payload?.working_title,
    channel_id: j.payload?.channel_id, slug: j.payload?.slug,
    segments: (j.segment_count != null ? j.segment_count : (j.payload?.segments?.length || 0)),
    chars: (j.char_count != null ? j.char_count : store.countChars(j.payload)),
    audio_url: j.audio_url, trello_attached: j.trello_attached, error: j.error,
    created_at: j.created_at, updated_at: j.updated_at,
  })),
}));

// Pause / resume all production (unguarded, like the other dashboard controls on this private box).
app.post('/dashboard-pause', (_req, res) => res.json(store.setPaused(true)));
app.post('/dashboard-resume', (_req, res) => { const c = store.setPaused(false); queue.resume(); res.json(c); });

// Clear all finished jobs + their audio (frees space). Queued/running are never removed.
app.post('/dashboard-clear-finished', (_req, res) => res.json({ ok: true, removed: store.clearFinished() }));

app.post('/dashboard-retry/:id', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  store.update(job.job_id, { status: 'queued', error: null });
  queue.enqueue(job.job_id);
  res.json({ ok: true });
});

app.post('/dashboard-delete/:id', (req, res) => {
  queue.cancel(req.params.id);
  const ok = store.remove(req.params.id);
  res.json({ ok });
});

// Redo: delete the job + record a remake request (watcher re-adds the idea to its ideas-queue).
app.post('/dashboard-redo/:id', (req, res) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const remake = store.addRemake({
    channel_id: job.payload?.channel_id, working_title: job.payload?.working_title, slug: job.payload?.slug,
  });
  queue.cancel(job.job_id);
  store.remove(job.job_id);
  res.json({ ok: true, remake });
});

app.listen(config.port, () => {
  console.log(`voiceover-app listening on :${config.port} (tts provider: ${config.ttsProvider})`);
  if (!config.apiKey) console.log('WARNING: API_KEY is unset — /api is unprotected (ok for local dev only).');
  queue.recover(); // re-enqueue any jobs left queued from before a restart (honors pause)
});

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
app.get('/dashboard-data', (_req, res) => res.json(store.list().map((j) => ({
  job_id: j.job_id, status: j.status, working_title: j.payload?.working_title,
  channel_id: j.payload?.channel_id, slug: j.payload?.slug,
  segments: j.payload?.segments?.length || 0, audio_url: j.audio_url,
  trello_attached: j.trello_attached, error: j.error,
  created_at: j.created_at, updated_at: j.updated_at, log: j.log,
}))));
app.post('/dashboard-retry/:id', (req, res) => {
  const queue = require('./jobs/queue');
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  store.update(job.job_id, { status: 'queued', error: null });
  queue.enqueue(job.job_id);
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`voiceover-app listening on :${config.port} (tts provider: ${config.ttsProvider})`);
  if (!config.apiKey) console.log('WARNING: API_KEY is unset — /api is unprotected (ok for local dev only).');
});

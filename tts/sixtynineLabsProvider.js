'use strict';
// 69labs TTS provider — wired from the official API docs (https://69labs.vip).
//
// TTS is asynchronous and job-based:
//   1. POST /api/v1/tts/generate            -> { id, status: "PENDING", queuePosition }
//      (cloned voices use POST /api/v1/voice-clones/generate with voiceCloneId)
//   2. GET  /api/v1/tts/status/:jobId       -> PENDING|PROCESSING|FINALIZING|COMPLETED|FAILED|CANCELLED|CENSORED
//   3. GET  /api/v1/tts/download/:jobId      -> the mp3 bytes (follows redirect; 410 if expired)
//
// Auth header: `Authorization: Bearer vk_...`. Errors are JSON { error, code }. Rate-limited
// requests return 429 with Retry-After, which we honour. This exposes
// synthesize({ text, voiceId, model, ..., outPath }) writing one mp3 per segment.

const fs = require('fs');
const config = require('../config');

const cfg = config.sixtyninelabs;
const BASE = () => (cfg.baseUrl || 'https://69labs.vip').replace(/\/$/, '');

const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 25 * 60 * 1000;
const MAX_429_WAITS = 6;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function authHeaders(extra) {
  if (!cfg.apiKey) throw new Error('69labs not configured: set SIXTYNINELABS_API_KEY (starts with vk_)');
  return Object.assign({ authorization: 'Bearer ' + cfg.apiKey }, extra || {});
}

async function api(pathname, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const url = BASE() + pathname;
  let waits = 0;
  for (;;) {
    const res = await fetch(url, {
      method,
      headers: authHeaders(opts.body ? { 'content-type': 'application/json' } : null),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      redirect: 'follow',
    });
    if (res.status === 429 && waits < MAX_429_WAITS) {
      const retryAfter = parseFloat(res.headers.get('retry-after') || '2');
      waits += 1;
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }
    if (opts.raw) {
      if (!res.ok) throw new Error(await describeError(res));
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(formatError(res.status, data));
    return data;
  }
}

function formatError(status, data) {
  if (data && (data.error || data.code)) {
    return ('69labs ' + status + ' ' + (data.code || '') + ': ' + (data.error || '')).trim();
  }
  return '69labs ' + status;
}

async function describeError(res) {
  const txt = await res.text().catch(() => '');
  return '69labs ' + res.status + ': ' + txt.slice(0, 300);
}

async function createJob(p) {
  if (p.voiceCloneId) {
    const body = { voiceCloneId: p.voiceCloneId, text: p.text };
    if (p.model) body.model = p.model;
    if (p.voiceSettings) Object.assign(body, p.voiceSettings);
    return api('/api/v1/voice-clones/generate', { method: 'POST', body });
  }
  const body = { text: p.text, voiceId: p.voiceId || cfg.defaultVoiceId };
  if (!body.voiceId) {
    throw new Error('69labs: no voiceId (set channel voiceover.voice_id or SIXTYNINELABS_DEFAULT_VOICE_ID)');
  }
  if (p.voiceProvider) body.voiceProvider = p.voiceProvider;
  const modelId = p.model || cfg.defaultModel;
  if (modelId) body.modelId = modelId;
  if (p.voiceSettings) body.voiceSettings = p.voiceSettings;
  if (p.minimaxSettings) body.minimaxSettings = p.minimaxSettings;
  return api('/api/v1/tts/generate', { method: 'POST', body });
}

async function pollUntilComplete(jobId) {
  const started = Date.now();
  for (;;) {
    const s = await api('/api/v1/tts/status/' + jobId);
    switch (s.status) {
      case 'COMPLETED':
        return s;
      case 'FAILED':
        throw new Error('69labs job ' + jobId + ' FAILED (credits refunded)');
      case 'CANCELLED':
        throw new Error('69labs job ' + jobId + ' was CANCELLED');
      case 'CENSORED': {
        const blocked = (s.blockedChunks || []).map((c) => '#' + c.index).join(', ');
        throw new Error(
          '69labs job ' + jobId + ' CENSORED — blocked chunk(s): ' + (blocked || 'unknown') +
          '. Rewrite the flagged text and re-run (retry-censored available until ' + (s.retryExpiresAt || 'soon') + ').'
        );
      }
      default:
        if (Date.now() - started > POLL_TIMEOUT_MS) {
          throw new Error('69labs job ' + jobId + ' timed out (last status ' + s.status + ')');
        }
        await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function downloadAudio(jobId, outPath) {
  const res = await api('/api/v1/tts/download/' + jobId, { raw: true });
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('69labs download for ' + jobId + ' returned empty body');
  fs.writeFileSync(outPath, buf);
}

async function synthesize(p) {
  const job = await createJob(p);
  const jobId = job.id;
  if (!jobId) throw new Error('69labs generate returned no job id: ' + JSON.stringify(job).slice(0, 200));
  await pollUntilComplete(jobId);
  await downloadAudio(jobId, p.outPath);
}

module.exports = { synthesize, name: 'sixtyninelabs', _internal: { createJob, pollUntilComplete, downloadAudio, api } };

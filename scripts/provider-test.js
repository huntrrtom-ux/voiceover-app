'use strict';
// Verifies the 69labs async flow (generate -> poll status -> download) and the request shapes,
// using a stubbed global.fetch. No real API key, no credits, no network.

process.env.SIXTYNINELABS_BASE_URL = 'https://69labs.vip';
process.env.SIXTYNINELABS_API_KEY = 'vk_testkey';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const provider = require('../src/tts/sixtynineLabsProvider');

function makeRes({ status = 200, json, buf, headers = {} }) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => json,
    text: async () => (json ? JSON.stringify(json) : ''),
    arrayBuffer: async () => (buf ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : new ArrayBuffer(0)),
  };
}

const calls = [];

async function scenario(name, fetchImpl, run) {
  calls.length = 0;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    return fetchImpl(url, opts);
  };
  await run();
  console.log(`PASS: ${name}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ttstest-'));

  // --- A: happy path (catalog voice) ---
  await scenario('catalog voice generate -> status COMPLETED -> download', (url, opts) => {
    if (url.endsWith('/api/v1/tts/generate') && opts.method === 'POST') {
      return makeRes({ json: { id: 'job_test', status: 'PENDING', queuePosition: 1 } });
    }
    if (url.endsWith('/api/v1/tts/status/job_test')) {
      return makeRes({ json: { id: 'job_test', status: 'COMPLETED' } });
    }
    if (url.endsWith('/api/v1/tts/download/job_test')) {
      return makeRes({ buf: Buffer.from('ID3FAKEMP3DATA'), headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new Error('unexpected url ' + url);
  }, async () => {
    const out = path.join(tmp, 'a.mp3');
    await provider.synthesize({ text: 'hello world', voiceId: '21m00Tcm4TlvDq8ikWAM', model: 'eleven_multilingual_v2', outPath: out });
    // auth header present
    assert.match(calls[0].headers.authorization, /^Bearer vk_testkey$/, 'auth header');
    // generate body shape
    assert.deepStrictEqual(
      { text: calls[0].body.text, voiceId: calls[0].body.voiceId, modelId: calls[0].body.modelId },
      { text: 'hello world', voiceId: '21m00Tcm4TlvDq8ikWAM', modelId: 'eleven_multilingual_v2' }
    );
    // file written with bytes
    assert.ok(fs.existsSync(out) && fs.statSync(out).size > 0, 'audio file written');
  });

  // --- B: cloned voice uses the voice-clones endpoint ---
  await scenario('cloned voice -> /voice-clones/generate', (url) => {
    if (url.endsWith('/api/v1/voice-clones/generate')) return makeRes({ json: { id: 'job_clone', status: 'PENDING' } });
    if (url.endsWith('/api/v1/tts/status/job_clone')) return makeRes({ json: { status: 'COMPLETED' } });
    if (url.endsWith('/api/v1/tts/download/job_clone')) return makeRes({ buf: Buffer.from('CLONEAUDIO') });
    throw new Error('unexpected url ' + url);
  }, async () => {
    const out = path.join(tmp, 'b.mp3');
    await provider.synthesize({ text: 'cloned', voiceCloneId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', outPath: out });
    assert.ok(calls[0].url.endsWith('/api/v1/voice-clones/generate'), 'used voice-clones endpoint');
    assert.strictEqual(calls[0].body.voiceCloneId, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
    assert.ok(fs.existsSync(out), 'clone audio written');
  });

  // --- C: CENSORED surfaces a clear, actionable error (no auto-rewrite) ---
  await scenario('CENSORED -> throws with blocked chunk info', (url) => {
    if (url.endsWith('/api/v1/tts/generate')) return makeRes({ json: { id: 'job_cz', status: 'PENDING' } });
    if (url.endsWith('/api/v1/tts/status/job_cz')) {
      return makeRes({ json: { status: 'CENSORED', blockedChunks: [{ index: 2, text: 'flagged' }], retryExpiresAt: '2026-06-04T00:00:00Z' } });
    }
    throw new Error('unexpected url ' + url);
  }, async () => {
    const out = path.join(tmp, 'c.mp3');
    let threw = null;
    try { await provider.synthesize({ text: 'x', voiceId: 'v', outPath: out }); } catch (e) { threw = e; }
    assert.ok(threw && /CENSORED/.test(threw.message) && /#2/.test(threw.message), 'censored error is descriptive');
    assert.ok(!fs.existsSync(out), 'no file written on censor');
  });

  // --- D: 429 is honoured via Retry-After, then succeeds ---
  await scenario('429 Retry-After is honoured', (() => {
    let firstStatus = true;
    return (url) => {
      if (url.endsWith('/api/v1/tts/generate')) return makeRes({ json: { id: 'job_rl', status: 'PENDING' } });
      if (url.endsWith('/api/v1/tts/status/job_rl')) {
        if (firstStatus) { firstStatus = false; return makeRes({ status: 429, json: { error: 'slow down', code: 'TOO_MANY_REQUESTS' }, headers: { 'retry-after': '1' } }); }
        return makeRes({ json: { status: 'COMPLETED' } });
      }
      if (url.endsWith('/api/v1/tts/download/job_rl')) return makeRes({ buf: Buffer.from('OK') });
      throw new Error('unexpected url ' + url);
    };
  })(), async () => {
    const out = path.join(tmp, 'd.mp3');
    const t0 = Date.now();
    await provider.synthesize({ text: 'x', voiceId: 'v', outPath: out });
    assert.ok(Date.now() - t0 >= 1000, 'waited ~1s for Retry-After');
    assert.ok(fs.existsSync(out), 'recovered after 429');
  });

  console.log('\nALL PROVIDER TESTS PASSED');
  process.exit(0);
})().catch((e) => { console.error('TEST FAIL:', e.message); process.exit(1); });

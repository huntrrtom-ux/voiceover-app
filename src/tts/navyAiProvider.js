'use strict';
// NavyAI TTS provider — https://api.navy/v1/audio/speech (synchronous, unlike 69labs' job flow).
// POST { model, voice, input } with `Authorization: Bearer sk-navy-...` -> raw audio bytes
// (audio/mpeg for ElevenLabs). Exposes synthesize({ text, voiceId, voiceCloneId, voiceSettings,
// outPath }) writing one mp3 to outPath, matching the shared provider interface.
//
// ElevenLabs on NavyAI caps `input` at 4096 characters, so a long chapter is split at sentence
// boundaries into <= maxInputChars chunks, each synthesized, then stitched back into one file with
// only a natural sentence gap. The chunking is internal, so the rest of the app treats NavyAI like
// any other provider. The channel's existing ElevenLabs voice_id is used unchanged.

const fs = require('fs');
const config = require('../config');
const { stitch } = require('../audio/stitch');

const cfg = config.navyai;
const BASE = () => (cfg.baseUrl || 'https://api.navy').replace(/\/$/, '');
const MAX_429_WAITS = 6;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Split text into <= maxChars chunks at sentence boundaries (hard-splitting only an oversized single
// sentence at a space). Returns [text] when it already fits. Preserves order and content.
function chunkByChars(text, maxChars) {
  const src = String(text).trim();
  if (src.length <= maxChars) return [src];
  const sentences = src.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [src];
  const chunks = [];
  let cur = '';
  for (let s of sentences) {
    // Break a single sentence that is itself longer than the cap.
    while (s.length > maxChars) {
      const slice = s.slice(0, maxChars);
      const cut = slice.lastIndexOf(' ');
      const head = cut > maxChars * 0.5 ? slice.slice(0, cut) : slice;
      if (cur.trim()) { chunks.push(cur); cur = ''; }
      chunks.push(head);
      s = s.slice(head.length);
    }
    if ((cur + s).length > maxChars) {
      if (cur.trim()) chunks.push(cur);
      cur = s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

function authHeaders() {
  if (!cfg.apiKey) throw new Error('NavyAI not configured: set NAVYAI_API_KEY (starts with sk-navy-)');
  return { authorization: 'Bearer ' + cfg.apiKey, 'content-type': 'application/json' };
}

// One /audio/speech call -> Buffer of audio bytes. Honors 429 Retry-After.
async function speak(voice, model, input, voiceSettings) {
  const body = { model, voice, input };
  if (voiceSettings) {
    if (typeof voiceSettings.stability === 'number') body.stability = voiceSettings.stability;
    if (typeof voiceSettings.similarity_boost === 'number') body.similarity_boost = voiceSettings.similarity_boost;
  }
  let waits = 0;
  for (;;) {
    const res = await fetch(BASE() + '/v1/audio/speech', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (res.status === 429 && waits < MAX_429_WAITS) {
      const ra = parseFloat(res.headers.get('retry-after') || '2');
      waits += 1;
      await sleep(Math.max(1, ra) * 1000);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error('NavyAI ' + res.status + ': ' + txt.slice(0, 300));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('NavyAI returned empty audio');
    return buf;
  }
}

// synthesize({ text, voiceId, voiceCloneId, voiceSettings, outPath }) -> writes one mp3 to outPath.
async function synthesize(p) {
  const voice = p.voiceId || p.voiceCloneId;
  if (!voice) throw new Error('NavyAI: no voice (set the channel voiceover.voice_id)');
  const model = cfg.defaultModel;
  const chunks = chunkByChars(p.text, cfg.maxInputChars);

  if (chunks.length === 1) {
    const buf = await speak(voice, model, chunks[0], p.voiceSettings);
    fs.writeFileSync(p.outPath, buf);
    return;
  }

  // Long chapter: synthesize each chunk, then stitch seamlessly into the one chapter file.
  const parts = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const buf = await speak(voice, model, chunks[i], p.voiceSettings);
      const pf = p.outPath + '.nav' + i + '.mp3';
      fs.writeFileSync(pf, buf);
      parts.push({ file: pf, kind: 'chapter', pause_before: i === 0 ? undefined : 0.1 });
    }
    await stitch({ segments: parts, pauses: {}, outPath: p.outPath });
  } finally {
    for (const pt of parts) { try { fs.rmSync(pt.file, { force: true }); } catch (e) { /* best-effort */ } }
  }
}

module.exports = { synthesize, chunkByChars };

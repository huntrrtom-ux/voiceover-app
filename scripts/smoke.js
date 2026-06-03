'use strict';
// End-to-end smoke test with the mock provider: create a job, run it through the queue,
// verify a stitched mp3 is produced with roughly the expected duration (segments + pauses).

const { execFileSync } = require('child_process');
const fs = require('fs');
const store = require('../src/jobs/store');
const queue = require('../src/jobs/queue');

function ffprobeDuration(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]).toString().trim();
  return parseFloat(out);
}

(async () => {
  const payload = {
    channel_id: 'british-documentaries',
    display_name: 'British Documentaries',
    slug: 'smoke-test-2026-06',
    working_title: 'Smoke Test: The Heiress Paris Forgot',
    voice_id: 'mock-voice',
    model: 'mock',
    trello_card_id: null,
    output_name: 'British Documentaries — Smoke Test',
    pauses: { after_hook: 0.8, between_chapters: 0.6 },
    segments: [
      { kind: 'hook', index: 0, text: 'word '.repeat(20) },     // ~8s
      { kind: 'chapter', index: 1, text: 'word '.repeat(25) },  // ~10s
      { kind: 'chapter', index: 2, text: 'word '.repeat(15) },  // ~6s
    ],
  };

  const job = store.create(payload);
  console.log('created', job.job_id);
  await queue.process(job.job_id); // run synchronously

  const done = store.get(job.job_id);
  console.log('status:', done.status, '| audio_file:', done.audio_file);
  if (done.status !== 'done') {
    console.error('FAIL: job did not complete');
    console.error(done.log.map((l) => l.message).join('\n'));
    process.exit(1);
  }

  const audioPath = require('path').join(require('../src/config').paths.AUDIO_DIR,
    `${job.job_id}__${done.audio_file}`);
  if (!fs.existsSync(audioPath)) { console.error('FAIL: stitched file missing', audioPath); process.exit(1); }

  const dur = ffprobeDuration(audioPath);
  // expected ≈ 8 + 0.8 + 10 + 0.6 + 6 = 25.4s (mock clamps each seg to >=1.5s)
  console.log('stitched duration:', dur.toFixed(2), 's');
  if (dur < 18 || dur > 35) { console.error('FAIL: duration out of expected range'); process.exit(1); }

  console.log('SMOKE PASS');
  process.exit(0);
})();

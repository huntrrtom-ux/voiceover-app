'use strict';
// Verifies the Trello flow (resolve label -> find/create card -> set description -> attach)
// with a stubbed global.fetch. No real Trello calls.

process.env.TRELLO_KEY = 'k';
process.env.TRELLO_TOKEN = 't';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const trello = require('../src/trello/client');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trellotest-'));
const audio = path.join(tmp, 'out.mp3');
fs.writeFileSync(audio, Buffer.from('FAKEAUDIO'));

const calls = [];
function res(json, ok = true, status = 200) {
  return { ok, status, json: async () => json, text: async () => JSON.stringify(json) };
}

async function scenario(name, handler, run) {
  calls.length = 0;
  global.fetch = async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET' }); return handler(url, opts); };
  await run();
  console.log('PASS:', name);
}

(async () => {
  // A) card does not exist -> create it
  await scenario('creates card when none matches label+title', (url, opts) => {
    if (url.includes('/labels') && (opts.method || 'GET') === 'GET') return res([{ id: 'lbl1', name: 'British Documentaries' }]);
    if (url.includes('/cards?fields=')) return res([]); // no existing cards
    if (url.match(/\/cards\?/) && opts.method === 'POST') return res({ id: 'cardNEW' });
    if (url.match(/\/cards\/cardNEW\?/) && opts.method === 'PUT') return res({ id: 'cardNEW' });
    if (url.includes('/cards/cardNEW/attachments')) return res({ id: 'att1' });
    throw new Error('unexpected ' + opts.method + ' ' + url);
  }, async () => {
    const id = await trello.placeOnCard({ boardId: 'b1', listId: 'list1', label: 'British Documentaries',
      title: 'My Video', description: 'desc here', filePath: audio, fileName: 'My Video.mp3' });
    assert.strictEqual(id, 'cardNEW');
    assert.ok(calls.some(c => c.method === 'POST' && /\/cards\?/.test(c.url)), 'created a card');
    assert.ok(calls.some(c => c.method === 'PUT' && /\/cards\/cardNEW/.test(c.url)), 'set description');
    assert.ok(calls.some(c => /attachments/.test(c.url)), 'attached audio');
  });

  // B) card already exists with label+title -> reuse it (no create)
  await scenario('reuses existing labelled card by title', (url, opts) => {
    if (url.includes('/labels') && (opts.method || 'GET') === 'GET') return res([{ id: 'lbl1', name: 'British Documentaries' }]);
    if (url.includes('/cards?fields=')) return res([{ id: 'cardOLD', name: 'My Video', idLabels: ['lbl1'] }]);
    if (url.match(/\/cards\/cardOLD\?/) && opts.method === 'PUT') return res({ id: 'cardOLD' });
    if (url.includes('/cards/cardOLD/attachments')) return res({ id: 'att2' });
    throw new Error('unexpected ' + opts.method + ' ' + url);
  }, async () => {
    const id = await trello.placeOnCard({ boardId: 'b1', listId: 'list1', label: 'British Documentaries',
      title: 'My Video', description: 'desc', filePath: audio, fileName: 'My Video.mp3' });
    assert.strictEqual(id, 'cardOLD');
    assert.ok(!calls.some(c => c.method === 'POST' && /\/cards\?/.test(c.url)), 'did NOT create a duplicate');
    assert.ok(calls.some(c => /attachments/.test(c.url)), 'attached audio');
  });

  console.log('\nALL TRELLO TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('TEST FAIL:', e.message); process.exit(1); });

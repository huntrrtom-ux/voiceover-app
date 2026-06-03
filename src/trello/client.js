'use strict';
// Trello REST client. The app's only required Trello job is to ATTACH the stitched audio to a
// card the skill already created (the skill owns the card + description + label). Helpers for
// description and label lookup are included in case you later want the app to own more of Trello.

const fs = require('fs');
const config = require('../config');

const API = 'https://api.trello.com/1';

function auth() {
  const { key, token } = config.trello;
  if (!key || !token) throw new Error('Trello not configured: set TRELLO_KEY and TRELLO_TOKEN');
  return `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

async function attachToCard({ cardId, filePath, fileName }) {
  if (!cardId) throw new Error('attachToCard: missing cardId');
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), fileName);
  fd.append('name', fileName);

  const res = await fetch(`${API}/cards/${cardId}/attachments?${auth()}`, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Trello attach ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

// --- Optional helpers (not used by the default flow) ---

async function setCardDescription({ cardId, desc }) {
  const res = await fetch(`${API}/cards/${cardId}?${auth()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ desc }),
  });
  if (!res.ok) throw new Error(`Trello desc ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Find a card on a board carrying a given label name (and optional title match). Useful if you
// ever want the app to resolve the card itself from board_id + label instead of a card_id.
async function findCardByLabel({ boardId, labelName, titleContains }) {
  const res = await fetch(`${API}/boards/${boardId}/cards?${auth()}`);
  if (!res.ok) throw new Error(`Trello cards ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const cards = await res.json();
  return cards.find((c) => {
    const hasLabel = (c.labels || []).some((l) => (l.name || '').toLowerCase() === labelName.toLowerCase());
    const titleOk = !titleContains || (c.name || '').toLowerCase().includes(titleContains.toLowerCase());
    return hasLabel && titleOk;
  }) || null;
}

module.exports = { attachToCard, setCardDescription, findCardByLabel };

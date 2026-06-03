'use strict';
// Trello REST client. The web app owns the whole Trello step (no skill-side connector exists).
// Per job it: finds the video's card by label + working title (creates it, named with the YouTube
// title, in the target list if absent), sets the YouTube description, attaches the stitched audio,
// and — if a thumbnail prompt was provided — adds it as a comment titled "Thumbnail Prompt:".
// Credentials come from env: TRELLO_KEY / TRELLO_TOKEN.

const fs = require('fs');
const config = require('../config');

const API = 'https://api.trello.com/1';

function auth() {
  const { key, token } = config.trello;
  if (!key || !token) throw new Error('Trello not configured: set TRELLO_KEY and TRELLO_TOKEN');
  return `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
}

async function tjson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Trello ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

async function resolveLabelId(boardId, labelName) {
  const labels = await tjson(`${API}/boards/${boardId}/labels?${auth()}`);
  const hit = labels.find((l) => (l.name || '').toLowerCase() === String(labelName).toLowerCase());
  if (hit) return hit.id;
  const created = await tjson(
    `${API}/boards/${boardId}/labels?name=${encodeURIComponent(labelName)}&color=null&${auth()}`,
    { method: 'POST' }
  );
  return created.id;
}

async function resolveListId(boardId, listName) {
  const lists = await tjson(`${API}/boards/${boardId}/lists?${auth()}`);
  const hit = lists.find((l) => (l.name || '').toLowerCase() === String(listName).toLowerCase());
  if (!hit) throw new Error(`Trello: list "${listName}" not found on board ${boardId}`);
  return hit.id;
}

// Find the open card on a board matching the title (and the label if one is given).
async function findCard(boardId, labelId, title) {
  const cards = await tjson(`${API}/boards/${boardId}/cards?fields=name,idLabels&${auth()}`);
  const want = String(title).trim().toLowerCase();
  return cards.find((c) => {
    const titleOk = (c.name || '').trim().toLowerCase() === want;
    const labelOk = !labelId || (c.idLabels || []).includes(labelId);
    return titleOk && labelOk;
  }) || null;
}

async function createCard(listId, title, labelId) {
  if (!listId) throw new Error('Trello: no list to create the card in (set trello.list_name or list_id)');
  const params = new URLSearchParams({ idList: listId, name: title });
  if (labelId) params.set('idLabels', labelId);
  return tjson(`${API}/cards?${params.toString()}&${auth()}`, { method: 'POST' });
}

async function ensureLabelOnCard(cardId, labelId) {
  // Idempotently guarantee the channel's label is on the card (add it if missing).
  if (!labelId) return;
  const card = await tjson(`${API}/cards/${cardId}?fields=idLabels&${auth()}`);
  if ((card.idLabels || []).includes(labelId)) return;
  await tjson(`${API}/cards/${cardId}/idLabels?value=${encodeURIComponent(labelId)}&${auth()}`, { method: 'POST' });
}

// Trello renders the card description as Markdown, so a line starting with "#" (e.g. a hashtag
// line) becomes a heading, "- " becomes a bullet, ">" a quote, etc. We want the YouTube
// description to display as plain text. Escape only the line-LEADING block triggers with a
// backslash (Trello consumes it on render), leaving the visible text — and the hashtags —
// exactly as written. Line spacing is preserved.
function plainTextForTrello(text) {
  return String(text)
    .split('\n')
    .map((line) =>
      line
        .replace(/^(\s*)(#)/, '$1\\$2')            // headings (and #hashtag at line start)
        .replace(/^(\s*)(>)/, '$1\\$2')            // blockquotes
        .replace(/^(\s*)([-+*])(\s)/, '$1\\$2$3')  // bullet lists
        .replace(/^(\s*)(\d+)([.)])(\s)/, '$1$2\\$3$4') // ordered lists
    )
    .join('\n');
}

async function setCardDescription(cardId, desc) {
  // Sets the card description as plain text (no heading) — the skill supplies the raw YouTube
  // description; we neutralize Markdown block formatting so Trello shows it as written, hashtags
  // and line spacing preserved.
  return tjson(`${API}/cards/${cardId}?${auth()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ desc: plainTextForTrello(desc || '') }),
  });
}

async function listCommentTexts(cardId) {
  const actions = await tjson(`${API}/cards/${cardId}/actions?filter=commentCard&limit=50&${auth()}`);
  return actions.map((a) => (a.data && a.data.text) || '');
}

async function addComment(cardId, text) {
  const params = new URLSearchParams({ text });
  return tjson(`${API}/cards/${cardId}/actions/comments?${params.toString()}&${auth()}`, { method: 'POST' });
}

async function attachToCard({ cardId, filePath, fileName }) {
  if (!cardId) throw new Error('attachToCard: missing cardId');
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/mpeg' }), fileName);
  fd.append('name', fileName);
  const res = await fetch(`${API}/cards/${cardId}/attachments?${auth()}`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Trello attach ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  return res.json();
}

const THUMB_PREFIX = 'Thumbnail Prompt:';

// High-level: place the finished audio + description (+ optional thumbnail-prompt comment) on the
// right card. Returns the card id. Accepts listId or listName (resolved on demand for creation).
async function placeOnCard({ boardId, listId, listName, label, title, description, thumbnailPrompt, filePath, fileName }) {
  const labelId = label ? await resolveLabelId(boardId, label) : null;
  let card = await findCard(boardId, labelId, title);
  if (!card) {
    const targetList = listId || (listName ? await resolveListId(boardId, listName) : null);
    card = await createCard(targetList, title, labelId);
  }
  await ensureLabelOnCard(card.id, labelId);
  if (description != null && description !== '') await setCardDescription(card.id, description);
  await attachToCard({ cardId: card.id, filePath, fileName });

  // Thumbnail prompt -> a comment titled "Thumbnail Prompt:". Skip if one already exists (re-runs).
  if (thumbnailPrompt && String(thumbnailPrompt).trim()) {
    const existing = await listCommentTexts(card.id).catch(() => []);
    const already = existing.some((t) => t.trim().startsWith(THUMB_PREFIX));
    if (!already) await addComment(card.id, `${THUMB_PREFIX}\n${String(thumbnailPrompt).trim()}`);
  }
  return card.id;
}

module.exports = {
  placeOnCard, attachToCard, setCardDescription, addComment, listCommentTexts,
  resolveLabelId, resolveListId, findCard, createCard, ensureLabelOnCard,
};

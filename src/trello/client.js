'use strict';
// Trello REST client. The web app owns the whole Trello step (no skill-side connector exists).
// Per job it: resolves the project label, finds the video's card by label + working title
// (creates it in the target list if absent), sets the YouTube description, and attaches the
// stitched audio. Credentials come from env: TRELLO_KEY / TRELLO_TOKEN.

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

// Resolve a label by name on a board; create it if missing. Returns the label id.
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

// Resolve a list (column) by name on a board. Returns the list id, or throws if not found.
async function resolveListId(boardId, listName) {
  const lists = await tjson(`${API}/boards/${boardId}/lists?${auth()}`);
  const hit = lists.find((l) => (l.name || '').toLowerCase() === String(listName).toLowerCase());
  if (!hit) throw new Error(`Trello: list "${listName}" not found on board ${boardId}`);
  return hit.id;
}

// Find the open card on a board carrying labelId and matching the title (case-insensitive).
async function findCard(boardId, labelId, title) {
  const cards = await tjson(`${API}/boards/${boardId}/cards?fields=name,idLabels&${auth()}`);
  const want = String(title).trim().toLowerCase();
  return cards.find(
    (c) => (c.idLabels || []).includes(labelId) && (c.name || '').trim().toLowerCase() === want
  ) || null;
}

async function createCard(listId, title, labelId) {
  if (!listId) throw new Error('Trello: no list to create the card in (set trello.list_name or list_id)');
  const params = new URLSearchParams({ idList: listId, name: title, idLabels: labelId });
  return tjson(`${API}/cards?${params.toString()}&${auth()}`, { method: 'POST' });
}

async function setCardDescription(cardId, desc) {
  return tjson(`${API}/cards/${cardId}?${auth()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ desc: desc || '' }),
  });
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

// High-level: place the finished audio + description on the right card. Returns the card id.
// Accepts either listId or listName (listName is resolved to an id on demand for card creation).
async function placeOnCard({ boardId, listId, listName, label, title, description, filePath, fileName }) {
  const labelId = await resolveLabelId(boardId, label);
  let card = await findCard(boardId, labelId, title);
  if (!card) {
    const targetList = listId || (listName ? await resolveListId(boardId, listName) : null);
    card = await createCard(targetList, title, labelId);
  }
  if (description != null && description !== '') await setCardDescription(card.id, description);
  await attachToCard({ cardId: card.id, filePath, fileName });
  return card.id;
}

module.exports = { placeOnCard, attachToCard, setCardDescription, resolveLabelId, resolveListId, findCard, createCard };

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

// A card's list position is set from its due date (epoch milliseconds) so the list always reads
// top-to-bottom in chronological order: an earlier deadline gets a smaller pos and sits higher.
// Returns null when there's no usable due date (Trello then keeps its default positioning).
function posFromDue(due) {
  if (!due) return null;
  const ms = Date.parse(due);
  return Number.isFinite(ms) ? ms : null;
}

async function createCard(listId, title, labelId, opts = {}) {
  if (!listId) throw new Error('Trello: no list to create the card in (set trello.list_name or list_id)');
  const params = new URLSearchParams({ idList: listId, name: title });
  if (labelId) params.set('idLabels', labelId);
  if (opts.due) params.set('due', opts.due);             // ISO 8601 due date+time (UTC)
  const pos = posFromDue(opts.due);
  if (pos != null) params.set('pos', String(pos));        // chronological placement in the list
  return tjson(`${API}/cards?${params.toString()}&${auth()}`, { method: 'POST' });
}

// Idempotently set a card's due date (and re-position it chronologically). Safe on re-runs.
async function ensureDueOnCard(cardId, due) {
  if (!due) return;
  const body = { due };
  const pos = posFromDue(due);
  if (pos != null) body.pos = pos;
  await tjson(`${API}/cards/${cardId}?${auth()}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

async function listAttachmentNames(cardId) {
  const a = await tjson(`${API}/cards/${cardId}/attachments?fields=name&${auth()}`).catch(() => []);
  return (Array.isArray(a) ? a : []).map((x) => (x.name || ''));
}

async function attachToCard({ cardId, filePath, fileName }) {
  if (!cardId) throw new Error('attachToCard: missing cardId');
  // Idempotency: if an attachment with this exact filename is already on the card, skip. This stops a
  // re-run of the same video (same output_name) from stacking a duplicate audio file on the card.
  const existing = await listAttachmentNames(cardId);
  if (existing.includes(fileName)) return { skipped: true, reason: 'attachment already present' };
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
async function placeOnCard({ boardId, listId, listName, label, title, description, thumbnailPrompt, ebookComment, ebookUrl, due, filePath, fileName }) {
  const labelId = label ? await resolveLabelId(boardId, label) : null;
  let card = await findCard(boardId, labelId, title);
  if (!card) {
    const targetList = listId || (listName ? await resolveListId(boardId, listName) : null);
    card = await createCard(targetList, title, labelId, { due });
  }
  await ensureLabelOnCard(card.id, labelId);
  // Set/refresh the deadline and chronological position (also covers cards reused on a re-run).
  if (due) await ensureDueOnCard(card.id, due);
  if (description != null && description !== '') await setCardDescription(card.id, description);

  // Thumbnail prompt -> a comment titled "Thumbnail Prompt:". Done BEFORE the audio attach so a large
  // file (or any attach error) can never cost us the comment. Skipped if one already exists (re-runs).
  if (thumbnailPrompt && String(thumbnailPrompt).trim()) {
    const existing = await listCommentTexts(card.id).catch(() => []);
    const already = existing.some((t) => t.trim().startsWith(THUMB_PREFIX));
    if (!already) await addComment(card.id, `${THUMB_PREFIX}\n${String(thumbnailPrompt).trim()}`);
  }

  // E-book CTA -> a one-line comment in the channel's voice, ending in the store URL. Posted AFTER the
  // thumbnail comment so it is the NEWEST comment and therefore sits at the TOP of the comments section
  // (Trello orders comments newest-first). Deduped by the store URL so re-runs never repost it.
  if (ebookComment && String(ebookComment).trim()) {
    const existing = await listCommentTexts(card.id).catch(() => []);
    const marker = (ebookUrl && String(ebookUrl).trim()) || String(ebookComment).trim();
    const already = existing.some((t) => t.includes(marker));
    if (!already) await addComment(card.id, String(ebookComment).trim());
  }

  // Attach the stitched audio last — this is the step most likely to fail on size, and by now the
  // label, description, and comments are already safely on the card.
  await attachToCard({ cardId: card.id, filePath, fileName });
  return card.id;
}

// Update only the description on an already-created card (used by timestamped-description
// channels, whose description is generated after the audio renders). Finds the card by
// label + title; throws if it doesn't exist yet (the voiceover job creates it first).
async function setDescriptionByCard({ boardId, label, title, description, due }) {
  const labelId = label ? await resolveLabelId(boardId, label) : null;
  const card = await findCard(boardId, labelId, title);
  if (!card) throw new Error(`Trello: no card titled "${title}" found to update (label ${label})`);
  if (due) await ensureDueOnCard(card.id, due);
  await setCardDescription(card.id, description || '');
  return card.id;
}

module.exports = {
  placeOnCard, attachToCard, setCardDescription, setDescriptionByCard, addComment, listCommentTexts,
  resolveLabelId, resolveListId, findCard, createCard, ensureLabelOnCard, ensureDueOnCard, posFromDue,
};

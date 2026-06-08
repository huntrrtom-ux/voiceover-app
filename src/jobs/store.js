'use strict';
// Tiny JSON-file job store. Single-process, one-person scale. No database to manage.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../config');

const JOBS_FILE = path.join(paths.DATA_DIR, 'jobs.json');
const CONTROL_FILE = path.join(paths.DATA_DIR, 'control.json');
const REMAKES_FILE = path.join(paths.DATA_DIR, 'remakes.json');

function countChars(payload) {
  const segs = (payload && payload.segments) || [];
  return segs.reduce((n, s) => n + (s && typeof s.text === 'string' ? s.text.length : 0), 0);
}

function ensureDirs() {
  fs.mkdirSync(paths.DATA_DIR, { recursive: true });
  fs.mkdirSync(paths.AUDIO_DIR, { recursive: true });
}

function loadAll() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAll(jobs) {
  ensureDirs();
  const tmp = JOBS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, JOBS_FILE); // atomic-ish write
}

function newId() {
  return 'job_' + crypto.randomBytes(6).toString('hex');
}

function create(payload) {
  const jobs = loadAll();
  const id = newId();
  const now = new Date().toISOString();
  jobs[id] = {
    job_id: id,
    status: 'queued',            // queued | running | done | error
    created_at: now,
    updated_at: now,
    error: null,
    audio_file: null,
    audio_url: null,
    trello_attached: false,
    segment_count: ((payload && payload.segments) || []).length,
    char_count: countChars(payload),
    log: [],
    payload,                      // the original handoff payload
  };
  saveAll(jobs);
  return jobs[id];
}

function get(id) {
  return loadAll()[id] || null;
}

function list() {
  const jobs = loadAll();
  return Object.values(jobs).sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

function update(id, patch) {
  const jobs = loadAll();
  if (!jobs[id]) return null;
  jobs[id] = { ...jobs[id], ...patch, updated_at: new Date().toISOString() };
  saveAll(jobs);
  return jobs[id];
}

function log(id, message) {
  const jobs = loadAll();
  if (!jobs[id]) return;
  jobs[id].log.push({ t: new Date().toISOString(), message });
  jobs[id].updated_at = new Date().toISOString();
  saveAll(jobs);
}

function remove(id) {
  const jobs = loadAll();
  if (!jobs[id]) return false;
  const job = jobs[id];
  try {
    if (job.audio_file) {
      const final = path.join(paths.AUDIO_DIR, id + '__' + job.audio_file);
      if (fs.existsSync(final)) fs.rmSync(final, { force: true });
    }
    const workDir = path.join(paths.AUDIO_DIR, id);
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    for (const f of fs.readdirSync(paths.AUDIO_DIR)) {
      if (f.startsWith(id + '__')) fs.rmSync(path.join(paths.AUDIO_DIR, f), { force: true });
    }
  } catch (e) { /* still remove the record even if a file is already gone */ }
  delete jobs[id];
  saveAll(jobs);
  return true;
}

// Clear all FINISHED jobs (done + error) and their audio files. Never removes queued/running ones.
function clearFinished() {
  const jobs = loadAll();
  let removed = 0;
  for (const id of Object.keys(jobs)) {
    const s = jobs[id].status;
    if (s === 'done' || s === 'error') { if (remove(id)) removed++; }
  }
  return removed;
}

// ---- Global production control (pause flag), persisted so a restart remembers it ----
function getControl() {
  ensureDirs();
  try { return JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8')); }
  catch { return { paused: false }; }
}
function setPaused(paused) {
  ensureDirs();
  const c = { paused: !!paused, updated_at: new Date().toISOString() };
  const tmp = CONTROL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
  fs.renameSync(tmp, CONTROL_FILE);
  return c;
}

// ---- Remake requests: a deleted job whose idea should be re-added to its local ideas-queue.
// The cloud app can't write the local file, so it records the request here and the watcher
// (which has local file access) drains it and appends the title back into the queue. ----
function loadRemakes() {
  ensureDirs();
  try { return JSON.parse(fs.readFileSync(REMAKES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveRemakes(r) {
  ensureDirs();
  const tmp = REMAKES_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
  fs.renameSync(tmp, REMAKES_FILE);
}
function addRemake({ channel_id, working_title, slug }) {
  const r = loadRemakes();
  const id = 'rmk_' + crypto.randomBytes(5).toString('hex');
  r[id] = { id, channel_id: channel_id || null, working_title: working_title || null,
            slug: slug || null, created_at: new Date().toISOString(), acked: false };
  saveRemakes(r);
  return r[id];
}
function listRemakes({ includeAcked = false } = {}) {
  return Object.values(loadRemakes())
    .filter((x) => includeAcked || !x.acked)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}
function ackRemake(id) {
  const r = loadRemakes();
  if (!r[id]) return false;
  r[id].acked = true;
  saveRemakes(r);
  return true;
}

module.exports = {
  create, get, list, update, log, remove, clearFinished, JOBS_FILE, countChars,
  getControl, setPaused, addRemake, listRemakes, ackRemake,
};

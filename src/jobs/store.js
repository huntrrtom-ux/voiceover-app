'use strict';
// Tiny JSON-file job store. Single-process, one-person scale. No database to manage.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { paths } = require('../config');

const JOBS_FILE = path.join(paths.DATA_DIR, 'jobs.json');

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

module.exports = { create, get, list, update, log, JOBS_FILE };

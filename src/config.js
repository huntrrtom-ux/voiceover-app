'use strict';
require('dotenv').config();

const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  apiKey: process.env.API_KEY || '',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  ttsProvider: (process.env.TTS_PROVIDER || 'mock').toLowerCase(),

  sixtyninelabs: {
    baseUrl: process.env.SIXTYNINELABS_BASE_URL || '',
    apiKey: process.env.SIXTYNINELABS_API_KEY || '',
    defaultVoiceId: process.env.SIXTYNINELABS_DEFAULT_VOICE_ID || '',
    defaultModel: process.env.SIXTYNINELABS_DEFAULT_MODEL || '',
  },

  // NavyAI TTS (unlimited ElevenLabs). Synchronous POST /v1/audio/speech. Select it with
  // TTS_PROVIDER=navyai. Uses each channel's existing ElevenLabs voice_id unchanged. ElevenLabs
  // caps input at 4096 chars, so the provider chunks longer chapters to maxInputChars internally.
  navyai: {
    baseUrl: process.env.NAVYAI_BASE_URL || 'https://api.navy',
    apiKey: process.env.NAVYAI_API_KEY || '',
    defaultModel: process.env.NAVYAI_DEFAULT_MODEL || 'eleven_multilingual_v2',
    maxInputChars: parseInt(process.env.NAVYAI_MAX_INPUT_CHARS, 10) || 3800,
  },

  trello: {
    key: process.env.TRELLO_KEY || '',
    token: process.env.TRELLO_TOKEN || '',
    enabled: Boolean(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN),
  },

  paths: { DATA_DIR, AUDIO_DIR },

  // How many times each stage (tts per segment, stitch, trello) is retried before flagging.
  maxRetries: 3,

  // Audio QC: catch a sustained quiet stretch inside a chapter (a TTS "volume drop-off" artifact),
  // first by regenerating that chapter split into smaller pieces (no level change). If a drop still
  // survives the regen budget, LIFT just that quiet stretch up to the file's OWN typical loudness so
  // the video is internally consistent — measured per file, so each voice keeps its natural level.
  // Balanced defaults: flag a >=20s run sitting >=9 dB below typical; regenerate up to 2 rounds; then
  // level the remainder. No Trello note (the editor can't act on the audio at that point).
  loudnessCheck: {
    enabled: (process.env.LOUDNESS_CHECK || 'on').toLowerCase() !== 'off',
    dropDb: parseFloat(process.env.LOUDNESS_DROP_DB) || 9,          // dB below typical = "serious"
    minDropSeconds: parseInt(process.env.LOUDNESS_MIN_SECONDS, 10) || 20,
    maxRegenRounds: parseInt(process.env.LOUDNESS_MAX_ROUNDS, 10) || 2,
    maxLiftDb: parseFloat(process.env.LOUDNESS_MAX_LIFT_DB) || 24,  // safety cap on the volume lift
    rampSeconds: 0.6,        // fade the lift in/out at the window edges so there's no audible step
    warmupSeconds: 3,        // short-term loudness needs 3s to become valid; ignore each seg's start
    silenceFloor: -70,       // exclude digital silence from the "typical level" median
  },
};

module.exports = config;

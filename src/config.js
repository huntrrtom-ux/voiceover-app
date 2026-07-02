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
    defaultModel: process.env.NAVYAI_DEFAULT_MODEL || 'eleven_v3',
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

  // Audio QC: catch a sustained quiet stretch inside a chapter (a TTS "volume drop-off" artifact)
  // and regenerate just that chapter. Detection only — levels are never altered. Balanced defaults:
  // flag a >=20s run sitting >=9 dB below the track's typical loudness; regenerate up to 2 rounds;
  // if a drop still survives, ship anyway with a warning (note on the card + job log + timestamp).
  loudnessCheck: {
    enabled: (process.env.LOUDNESS_CHECK || 'on').toLowerCase() !== 'off',
    dropDb: parseFloat(process.env.LOUDNESS_DROP_DB) || 9,          // dB below typical = "serious"
    minDropSeconds: parseInt(process.env.LOUDNESS_MIN_SECONDS, 10) || 20,
    maxRegenRounds: parseInt(process.env.LOUDNESS_MAX_ROUNDS, 10) || 2,
    warmupSeconds: 3,        // short-term loudness needs 3s to become valid; ignore each seg's start
    silenceFloor: -70,       // exclude digital silence from the "typical level" median
  },
};

module.exports = config;

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

  trello: {
    key: process.env.TRELLO_KEY || '',
    token: process.env.TRELLO_TOKEN || '',
    enabled: Boolean(process.env.TRELLO_KEY && process.env.TRELLO_TOKEN),
  },

  paths: { DATA_DIR, AUDIO_DIR },

  // How many times each stage (tts per segment, stitch, trello) is retried before flagging.
  maxRetries: 3,
};

module.exports = config;

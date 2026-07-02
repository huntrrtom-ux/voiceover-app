'use strict';
// Provider selector. The rest of the app only knows the interface:
//   provider.synthesize({ text, voiceId, model, outPath }) -> Promise<void>  (writes an mp3 to outPath)

const config = require('../config');
const mock = require('./mockProvider');
const sixtyninelabs = require('./sixtynineLabsProvider');
const navyai = require('./navyAiProvider');

function getProvider() {
  switch (config.ttsProvider) {
    case 'sixtyninelabs':
      return sixtyninelabs;
    case 'navyai':
      return navyai;
    case 'mock':
    default:
      return mock;
  }
}

module.exports = { getProvider };

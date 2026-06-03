'use strict';
// Resolve an ffmpeg binary that exists regardless of host/builder. ffmpeg-static ships a static
// binary via npm, so we don't depend on the platform having ffmpeg. Falls back to a system
// 'ffmpeg' on PATH if the package isn't available (e.g. local dev with ffmpeg already installed).
let p = null;
try { p = require('ffmpeg-static'); } catch (e) { p = null; }
module.exports = p || 'ffmpeg';

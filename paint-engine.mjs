// ES-module entry for Paint Engine.
//   import { mount, paintStroke } from './paint-engine.mjs';
//   import PaintEngine from './paint-engine.mjs';
// paint-engine.js is a classic script (so a page can use it from file:// with a plain <script> tag);
// importing it for its side effect defines the PaintEngine global, which this module re-exports.
import './paint-engine.js';

const PaintEngine = globalThis.PaintEngine;

export default PaintEngine;
export const {
  version,
  createPaintEngine,
  mount,
  paintStroke,
  paintPage,
  makeRNG,
  resampleByArcLength,
  makePathResampler,
  computeFrames,
  splatDabSpecs,
  strokeMarks,
  splashMarks,
  dashMarks,
  castShadow,
} = PaintEngine;

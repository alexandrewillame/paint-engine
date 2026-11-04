/*!
 * Paint Engine v1.0.2 — procedural acrylic paint for the web
 * (c) 2026 Alexandre Willame · MIT License
 * https://github.com/alexandrewillame/paint-engine
 */
/*
 * paint-engine.js
 * -----------------------------------------------------------------------
 * Procedural acrylic-paint engine: touch drags become brush strokes, taps
 * become splatters. Every mark is built by stamping many small, independently
 * jittered, irregular "dabs" (from a tiny procedural sprite pool generated
 * once at startup) with ordinary alpha compositing — texture, color
 * variance, and overlap-darkening all fall out of that stacking, rather
 * than from a single smooth shape plus a post-hoc lighting pass.
 *
 * Classic script (not an ES module) so the page works when opened directly
 * via file:// with no server. Attaches everything to `window.PaintEngine`, and
 * to module.exports under CommonJS (paint-engine.mjs is the ES-module entry).
 *
 * Public API:
 *   const paint = PaintEngine.createPaintEngine({ canvas, palette, seed, dpr, budget, paper, scale });
 *   paint.beginStroke(xCss, yCss, tMs, { color, seed })
 *   paint.extendStroke(xCss, yCss, tMs)
 *   paint.endStroke(tMs)
 *   paint.splat(xCss, yCss, { size, color, seed })
 *   paint.undo()
 *   paint.flush()
 *   paint.adoptPixels(image, dxCss, dyCss)
 *   paint.resize(wCss, hCss)
 *   paint.clear()
 *   paint.setBudget({ maxMarks, maxInkArea })
 *   paint.markCount / paint.drawing
 *
 * Helpers (section 8), built only on the API above:
 *   PaintEngine.mount(element, options)               an element you can paint on
 *   PaintEngine.paintStroke(engine, points, options)  a stroke along a path, instant or animated
 *   PaintEngine.paintPage(options)                    visitors paint on the whole page
 * -----------------------------------------------------------------------
 */
(function () {
'use strict';

// ============================================================================
// 1. PRIMITIVES — seeded randomness, noise, color
// ============================================================================

/** Deterministic PRNG (mulberry32). Returns a function yielding floats in [0,1). */
function makeRNG(seed) {
  let a = (typeof seed === 'number' ? seed : hashString(String(seed))) >>> 0;
  if (a === 0) a = 0x9e3779b9;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

/** Standard-normal sample via Box-Muller, using a supplied rng(). */
function randNorm(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Sample in [min,max], biased toward `min` for power>1 (few large, many small). */
function powerSmall(rng, min, max, power) {
  if (power === undefined) power = 3;
  return min + (max - min) * Math.pow(rng(), power);
}

function pick(rng, arr) {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
function smoothstep(lo, hi, x) {
  const t = clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

/** A fixed random-Fourier-series "noise" function of one variable, in ~[-1,1]. Pure & seed-stable. */
function makeFbm1(seed, octaves) {
  if (octaves === undefined) octaves = 4;
  const rng = makeRNG(seed);
  const terms = [];
  let amp = 1;
  const freqBase = 0.8 + rng() * 0.4;
  for (let i = 0; i < octaves; i++) {
    terms.push({ freq: freqBase * Math.pow(2.05, i) + rng() * 0.3, phase: rng() * Math.PI * 2, amp });
    amp *= 0.55;
  }
  const norm = terms.reduce((s, t) => s + t.amp, 0);
  return function fbm(x) {
    let v = 0;
    for (const t of terms) v += t.amp * Math.sin(x * t.freq + t.phase);
    return v / norm;
  };
}

/** Cheap deterministic pseudo-random in [0,1) from an integer index — no state, safe to call in any order. */
function hash1(i) {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** amt in [-1,1]: negative darkens+saturates a touch, positive lightens. Used for per-dab tone jitter. */
function shadeColor(rgb, amt) {
  const r = rgb.r, g = rgb.g, b = rgb.b;
  if (amt >= 0) {
    return { r: r + (255 - r) * amt * 0.55, g: g + (255 - g) * amt * 0.55, b: b + (255 - b) * amt * 0.55 };
  }
  const k = 1 + amt * 0.55;
  const avg = (r + g + b) / 3;
  return { r: avg + (r - avg) * 1.15 * k, g: avg + (g - avg) * 1.15 * k, b: avg + (b - avg) * 1.15 * k };
}

/** A small tileable grayscale grain texture for the paper background. */
function makeGrainTile(size, rng) {
  const data = new Uint8ClampedArray(size * size);
  for (let i = 0; i < data.length; i++) data[i] = 150 + Math.floor(rng() * 105);
  const out = new Uint8ClampedArray(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = (x + dx + size) % size, yy = (y + dy + size) % size;
          sum += data[yy * size + xx]; n++;
        }
      }
      out[y * size + x] = sum / n;
    }
  }
  return { size, data: out };
}

// ============================================================================
// 2. PATH PROCESSING — smoothing, spline fit, arc-length resample, frames
// ============================================================================

function oneEuroAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** One-Euro filter over a raw {x,y,t} point list. Kills jitter without lag. Pure, stable prefix. */
function oneEuroSmooth(points, opts) {
  opts = opts || {};
  const minCutoff = opts.minCutoff !== undefined ? opts.minCutoff : 1.4;
  const beta = opts.beta !== undefined ? opts.beta : 0.02;
  const dCutoff = opts.dCutoff !== undefined ? opts.dCutoff : 1.0;
  if (points.length === 0) return [];
  const out = new Array(points.length);
  out[0] = { x: points[0].x, y: points[0].y, t: points[0].t };
  let xPrev = points[0].x, yPrev = points[0].y, dxPrev = 0, dyPrev = 0, tPrev = points[0].t;
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    let dt = (p.t - tPrev) / 1000;
    if (!(dt > 0)) dt = 1 / 120;
    tPrev = p.t;
    const dx = (p.x - xPrev) / dt, dy = (p.y - yPrev) / dt;
    const aD = oneEuroAlpha(dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * dxPrev;
    const dyHat = aD * dy + (1 - aD) * dyPrev;
    const cutoff = minCutoff + beta * Math.hypot(dxHat, dyHat);
    const a = oneEuroAlpha(cutoff, dt);
    const xHat = a * p.x + (1 - a) * xPrev;
    const yHat = a * p.y + (1 - a) * yPrev;
    out[i] = { x: xHat, y: yHat, t: p.t };
    xPrev = xHat; yPrev = yHat; dxPrev = dxHat; dyPrev = dyHat;
  }
  return out;
}

function catmullRomAxis(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function buildDenseSpline(points, stepsPerSeg) {
  const n = points.length;
  if (n < 2) return points.slice();
  if (n === 2) {
    const a = points[0], b = points[1], out = [];
    for (let i = 0; i <= stepsPerSeg; i++) {
      const t = i / stepsPerSeg;
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), t: lerp(a.t, b.t, t) });
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)], p1 = points[i], p2 = points[i + 1], p3 = points[Math.min(n - 1, i + 2)];
    for (let s = 0; s < stepsPerSeg; s++) {
      const t = s / stepsPerSeg;
      out.push({
        x: catmullRomAxis(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRomAxis(p0.y, p1.y, p2.y, p3.y, t),
        t: lerp(p1.t, p2.t, t),
      });
    }
  }
  out.push(points[n - 1]);
  return out;
}

/**
 * Shared arc-length walk: consumes dense points `rest` in order, pushing every point that lands on a
 * `spacing` boundary onto `dest`. Returns the end state ({acc, a}) so makePathResampler can resume a
 * walk from a checkpoint and stay bit-identical to a fresh one-shot walk.
 */
function walkArcLength(dest, acc0, a, rest, spacing) {
  let acc = acc0;
  for (let i = 0; i < rest.length; i++) {
    const b = rest[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen !== 0) {
      let segPos = 0;
      while (acc + (segLen - segPos) >= spacing) {
        const need = spacing - acc;
        const t = (segPos + need) / segLen;
        dest.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), t: lerp(a.t, b.t, t) });
        segPos += need;
        acc = 0;
      }
      acc += segLen - segPos;
    }
    a = b;
  }
  return { acc, a };
}

/** Arc-length-resamples an already-densified point list (see resampleByArcLength). Pure. */
function resampleFromDense(dense, spacing) {
  if (dense.length === 0) return [];
  const out = [{ x: dense[0].x, y: dense[0].y, t: dense[0].t }];
  walkArcLength(out, 0, dense[0], dense.slice(1), spacing);
  return out;
}

/** Smooth a raw point list into evenly-spaced centerline points (fixed `spacing`, device px). Pure. */
function resampleByArcLength(points, spacing) {
  const smoothed = oneEuroSmooth(points);
  const dense = buildDenseSpline(smoothed, 8);
  return resampleFromDense(dense, spacing);
}

/**
 * Incremental counterpart to resampleByArcLength for a stroke's append-only raw points. push(x,y,t)
 * once per arriving point (extendStroke); settle() once per tick returns the current resampled
 * array. Bit-identical to re-running resampleByArcLength over the whole path each tick, without the
 * whole-path cost, because every stage is prefix-stable:
 *  - oneEuroSmooth is strictly causal: `smoothed[i]` never changes once pushed.
 *  - A Catmull-Rom segment i reads smoothed[i-1..i+2] with the ends clamped to the point count at
 *    call time, so segment i is permanently final once smoothed.length > i+2 (advanceFinalized);
 *    only the most recent segment is still tentative and is recomputed each settle().
 *  - walkArcLength is a forward scan with two scalars of state, so it resumes from a checkpoint.
 */
function makePathResampler(spacing) {
  const STEPS = 8; // matches resampleByArcLength's buildDenseSpline(smoothed, 8) call
  const MIN_CUTOFF = 1.4, BETA = 0.02, D_CUTOFF = 1.0; // oneEuroSmooth's defaults (see there)

  const smoothed = []; // one-euro output -- append-only, entry i is final forever once pushed
  let xPrev = 0, yPrev = 0, dxPrev = 0, dyPrev = 0, tPrev = 0;

  const denseStable = []; // dense points from permanently-finalized segments only -- append-only
  let finalizedSegCount = 0; // number of Catmull-Rom segments folded into denseStable so far

  // Arc-length walk state, advanced only over denseStable -- exactly as final as denseStable is.
  const outStable = []; // resampled {x,y,t} points from the finalized dense prefix
  let accStable = 0;
  let walkAStable = null; // last denseStable point consumed as the walk's running "a" cursor

  function push(x, y, t) {
    if (smoothed.length === 0) {
      smoothed.push({ x, y, t });
      xPrev = x; yPrev = y; dxPrev = 0; dyPrev = 0; tPrev = t;
      return;
    }
    let dt = (t - tPrev) / 1000;
    if (!(dt > 0)) dt = 1 / 120;
    tPrev = t;
    const dx = (x - xPrev) / dt, dy = (y - yPrev) / dt;
    const aD = oneEuroAlpha(D_CUTOFF, dt);
    const dxHat = aD * dx + (1 - aD) * dxPrev;
    const dyHat = aD * dy + (1 - aD) * dyPrev;
    const cutoff = MIN_CUTOFF + BETA * Math.hypot(dxHat, dyHat);
    const a = oneEuroAlpha(cutoff, dt);
    const xHat = a * x + (1 - a) * xPrev;
    const yHat = a * y + (1 - a) * yPrev;
    smoothed.push({ x: xHat, y: yHat, t });
    xPrev = xHat; yPrev = yHat; dxPrev = dxHat; dyPrev = dyHat;
  }

  // Catmull-Rom segment's STEPS dense points, given its 4 (already-final) control points --
  // identical arithmetic to buildDenseSpline's inner loop.
  function segmentPoints(p0, p1, p2, p3) {
    const pts = [];
    for (let s = 0; s < STEPS; s++) {
      const t = s / STEPS;
      pts.push({
        x: catmullRomAxis(p0.x, p1.x, p2.x, p3.x, t),
        y: catmullRomAxis(p0.y, p1.y, p2.y, p3.y, t),
        t: lerp(p1.t, p2.t, t),
      });
    }
    return pts;
  }

  // Advances denseStable/outStable to reflect every Catmull-Rom segment that is now permanently
  // final (see the block comment above). Only ever appends -- never revisits earlier output.
  function advanceFinalized() {
    const m = smoothed.length;
    const targetFinal = m - 2; // segments i = 0 .. m-3 (count m-2) are final once smoothed has m pts
    if (targetFinal <= finalizedSegCount) return;
    const newPts = [];
    for (let i = finalizedSegCount; i < targetFinal; i++) {
      const p0 = smoothed[Math.max(0, i - 1)], p1 = smoothed[i], p2 = smoothed[i + 1], p3 = smoothed[i + 2];
      for (const pt of segmentPoints(p0, p1, p2, p3)) newPts.push(pt);
    }
    finalizedSegCount = targetFinal;
    for (const pt of newPts) denseStable.push(pt);
    if (walkAStable === null) {
      // denseStable[0] is always exactly smoothed[0] (Catmull-Rom at t=0 is always p1) -- seed the
      // walk and its first output point exactly as resampleByArcLength's `out = [dense[0]]` does.
      walkAStable = denseStable[0];
      outStable.push({ x: walkAStable.x, y: walkAStable.y, t: walkAStable.t });
      const r = walkArcLength(outStable, accStable, walkAStable, newPts.slice(1), spacing);
      accStable = r.acc; walkAStable = r.a;
    } else {
      const r = walkArcLength(outStable, accStable, walkAStable, newPts, spacing);
      accStable = r.acc; walkAStable = r.a;
    }
  }

  // Returns the current resampled array (device px, {x,y,t}) -- outStable (final) plus a fresh,
  // non-mutating continuation over whatever's still tentative: the one not-yet-finalized
  // Catmull-Rom segment, plus the exact trailing point buildDenseSpline always appends.
  function settle() {
    const m = smoothed.length;
    if (m === 0) return [];
    if (m < 3) {
      // <=2 points: delegate to the one-shot path (buildDenseSpline's own special cases)
      return resampleFromDense(buildDenseSpline(smoothed, STEPS), spacing);
    }
    advanceFinalized();
    const i = m - 2;
    const p0 = smoothed[Math.max(0, i - 1)], p1 = smoothed[i], p2 = smoothed[i + 1], p3 = smoothed[Math.min(m - 1, i + 2)];
    const tailDense = segmentPoints(p0, p1, p2, p3);
    tailDense.push(smoothed[m - 1]);
    const out = outStable.slice();
    walkArcLength(out, accStable, walkAStable, tailDense, spacing);
    return out;
  }

  return { push, settle };
}

/** Attach tangent/normal/arcLen/speed/emaSpeed to each resampled point. Pure. */
function computeFrames(resampled, spacing) {
  const n = resampled.length;
  const frames = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = resampled[Math.max(0, i - 1)];
    const next = resampled[Math.min(n - 1, i + 1)];
    let tx = next.x - prev.x, ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const p = resampled[i];
    let speed = 0;
    if (i > 0) {
      const dt = Math.max((p.t - resampled[i - 1].t) / 1000, 1 / 240);
      speed = spacing / dt;
    }
    frames[i] = { x: p.x, y: p.y, t: p.t, tx, ty, nx: -ty, ny: tx, arcLen: i * spacing, speed };
  }
  if (frames.length) frames[0].speed = frames.length > 1 ? frames[1].speed : 0;
  let ema = frames.length ? frames[0].speed : 0;
  for (let i = 0; i < n; i++) {
    ema = lerp(ema, frames[i].speed, 0.25);
    frames[i].emaSpeed = ema;
  }
  return frames;
}

// ============================================================================
// 3. DAB PRIMITIVE — the one shape/paint primitive everything else is built from
// ============================================================================

const SPRITE_SIZE = 96;
// Mip pyramid sizes each sprite is pre-filtered to (largest to smallest), so stamping a 3px speckle
// doesn't force the browser to minify-filter a 96x96 source every single time -- see buildSpritePool
// / pickMip. Below FAST_DAB_MAX_PX, stampDab skips the sprite entirely (see there).
const SPRITE_MIP_SIZES = [96, 48, 24, 12];
const FAST_DAB_MAX_PX = 3; // device px diameter

/** Per-vertex-jittered radius around an ellipse — deliberately ragged, not smooth fbm. Pure. */
function makeIrregularPath(rng, rx, ry, jag, verts) {
  const pts = [];
  for (let i = 0; i < verts; i++) {
    const a = (i / verts) * Math.PI * 2;
    const rr = 1 + (rng() - 0.5) * 2 * jag;
    pts.push({ x: Math.cos(a) * rx * rr, y: Math.sin(a) * ry * rr });
  }
  return pts;
}

/** Fills a closed point loop, smoothed via quadratic curves through midpoints (no sharp vertices). */
function fillSmoothPath(ctx, pts) {
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
    if (i === 0) ctx.moveTo(mx, my); else ctx.quadraticCurveTo(p0.x, p0.y, mx, my);
  }
  ctx.closePath();
  ctx.fill();
}

/** One dab template: an irregular white alpha mask on transparent, with a soft or crisp edge falloff. */
function makeDabSprite(rng, soft) {
  const size = SPRITE_SIZE;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const cx = c.getContext('2d');
  // Content fills nearly the whole sprite (esp. crisp) -- a big transparent margin here would make
  // a stamped dab's *visible* size come out far smaller than its requested rx/ry, silently breaking
  // every overlap/spacing calculation done at stamp time.
  const rx = size * (soft ? 0.38 : 0.45), ry = rx;
  const jag = soft ? 0.22 + rng() * 0.1 : 0.08 + rng() * 0.1;
  const verts = soft ? 8 + Math.floor(rng() * 5) : 12 + Math.floor(rng() * 4);
  const pts = makeIrregularPath(rng, rx, ry, jag, verts);
  cx.save();
  cx.translate(size / 2, size / 2);
  cx.fillStyle = '#fff';
  fillSmoothPath(cx, pts);
  cx.restore();
  cx.save();
  cx.globalCompositeOperation = 'destination-in';
  const grad = cx.createRadialGradient(size / 2, size / 2, size * (soft ? 0.15 : 0.47), size / 2, size / 2, size * (soft ? 0.47 : 0.5));
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, size, size);
  cx.restore();
  return c;
}

/**
 * One dab template's full mip pyramid (largest to smallest, see SPRITE_MIP_SIZES) plus its measured
 * mean alpha coverage (used by stampDab's sub-pixel fast path in place of stamping the real mask).
 */
function makeDabSpriteMips(rng, soft) {
  const full = makeDabSprite(rng, soft);
  const mips = [full];
  for (let i = 1; i < SPRITE_MIP_SIZES.length; i++) {
    const s = SPRITE_MIP_SIZES[i];
    const prev = mips[i - 1];
    const c = document.createElement('canvas');
    c.width = c.height = s;
    c.getContext('2d').drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, s, s);
    mips.push(c);
  }
  const smallest = mips[mips.length - 1];
  const sSize = smallest.width;
  const data = smallest.getContext('2d').getImageData(0, 0, sSize, sSize).data;
  let sum = 0;
  for (let i = 3; i < data.length; i += 4) sum += data[i];
  const coverage = sum / (data.length / 4) / 255;
  return { mips, coverage };
}

/** Builds the small procedural sprite pool once at engine init. Canvas-only — no external images. */
function buildSpritePool(seed) {
  const rng = makeRNG(seed);
  const pool = { soft: [], crisp: [] };
  for (let i = 0; i < 14; i++) pool.soft.push(makeDabSpriteMips(rng, true));
  for (let i = 0; i < 14; i++) pool.crisp.push(makeDabSpriteMips(rng, false));
  return pool;
}

// Picks the smallest mip whose native size still covers the dab's on-screen diameter, so a tiny dab
// never pays to minify-filter the full 96px sprite, and a huge one never upscales a tiny mip.
function pickMip(sprite, rx, ry) {
  const need = Math.max(rx, ry) * 2;
  const mips = sprite.mips;
  for (let i = mips.length - 1; i >= 0; i--) {
    if (mips[i].width >= need) return mips[i];
  }
  return mips[0];
}

// Reusable scratch canvases bucketed by power-of-two size, for compositing one tinted dab before
// blitting it. Bucketed rather than one ever-growing canvas so a 3px speckle after a big dab
// doesn't pay source-in/fillRect over the largest size seen.
const scratchPool = new Map();
const SCRATCH_SIZES = [8, 16, 32, 64, 128, 256, 512, 1024, 2048];
function getScratch(minSize) {
  let size = SCRATCH_SIZES[SCRATCH_SIZES.length - 1];
  for (let i = 0; i < SCRATCH_SIZES.length; i++) {
    if (SCRATCH_SIZES[i] >= minSize) { size = SCRATCH_SIZES[i]; break; }
  }
  let entry = scratchPool.get(size);
  if (!entry) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    entry = { canvas: c, ctx: c.getContext('2d') };
    scratchPool.set(size, entry);
  }
  return entry;
}

/**
 * Stamps one dab onto ctx: masks a sprite, tints it (per-dab jittered off `baseRgb`), optionally
 * adds a small clipped "wet sheen" highlight fleck, then blits the result at `alpha`. Every random
 * choice is derived from `dabSeed` alone, so replay from a stored spec is pixel-reproducible.
 *
 * The two `rng()` draws from the original mulberry32-backed closure (tint jitter, then -- only if
 * `sheen` -- the sheen fleck's alpha) are inlined by hand below rather than via makeRNG, to avoid
 * allocating a closure per dab; the arithmetic is copied verbatim from makeRNG so this produces the
 * exact same sequence of values for the same dabSeed.
 */
function stampDab(ctx, sprite, x, y, rx, ry, rotation, baseRgb, alpha, dabSeed, sheen) {
  let a = (dabSeed >>> 0) || 0x9e3779b9;
  a |= 0;
  a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const r1 = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  const tint = shadeColor(baseRgb, (r1 - 0.5) * 0.7);
  const tintStyle = 'rgb(' + (tint.r | 0) + ',' + (tint.g | 0) + ',' + (tint.b | 0) + ')';

  if (!sheen && Math.max(rx, ry) * 2 <= FAST_DAB_MAX_PX) {
    // Sub-pixel fast path: at this size the sprite's irregular silhouette isn't resolvable on
    // screen anyway, so skip the sprite mask / scratch canvas / compositing pipeline and paint a
    // flat rect at alpha scaled by the sprite's measured mean coverage (see makeDabSpriteMips).
    ctx.save();
    ctx.globalAlpha = alpha * sprite.coverage;
    ctx.fillStyle = tintStyle;
    ctx.fillRect(x - rx, y - ry, rx * 2, ry * 2);
    ctx.restore();
    return;
  }

  const img = pickMip(sprite, rx, ry);
  const S = Math.ceil(Math.max(rx, ry) * 2.6) + 4;
  const entry = getScratch(S);
  const sctx = entry.ctx;
  sctx.clearRect(0, 0, S, S);
  sctx.globalAlpha = 1;
  sctx.globalCompositeOperation = 'source-over';
  sctx.save();
  sctx.translate(S / 2, S / 2);
  sctx.rotate(rotation);
  sctx.drawImage(img, -rx, -ry, rx * 2, ry * 2);
  sctx.restore();
  // tint the mask: source-in clips to it, so an exact S×S fill is enough
  sctx.globalCompositeOperation = 'source-in';
  sctx.fillStyle = tintStyle;
  sctx.fillRect(0, 0, S, S);
  if (sheen) {
    a = (a + 0x6d2b79f5) | 0;
    t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r2 = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    // wet-sheen fleck; ellipse centre computed in canvas space to skip a second save/restore
    const cosR = Math.cos(rotation), sinR = Math.sin(rotation);
    const lx = -rx * 0.25, ly = -ry * 0.3;
    sctx.globalCompositeOperation = 'source-atop';
    sctx.globalAlpha = 0.12 + r2 * 0.1;
    sctx.fillStyle = '#fff';
    sctx.beginPath();
    sctx.ellipse(S / 2 + cosR * lx - sinR * ly, S / 2 + sinR * lx + cosR * ly, rx * 0.35, ry * 0.22, rotation - 0.4, 0, Math.PI * 2);
    sctx.fill();
    sctx.globalAlpha = 1;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(entry.canvas, 0, 0, S, S, x - S / 2, y - S / 2, S, S);
  ctx.restore();
}

// ============================================================================
// 4. SPLATTER — radial dab clusters (core, tendrils, satellites, speckle)
// ============================================================================

/**
 * Pure splatter dab-spec generator: seed + size (device px) -> dab specs, centered at origin.
 *
 * Each spec carries a `part` tag ('core' | 'tendril' | 'satellite' | 'speckle') naming which of the
 * four passes below produced it. Rasterization ignores it entirely -- it exists so a caller that
 * wants only *part* of a splash can weight the structural blob differently from the thrown halo
 * (see splashMarks, which fades the core by size/alpha but culls the halo by count).
 */
function splatDabSpecs(seed, size) {
  const rng = makeRNG(seed);
  const fbmA = makeFbm1(seed * 2 + 1, 4);
  const specs = [];
  let dabCounter = 0;
  const nextDabSeed = () => ((seed * 97 + (dabCounter++) * 7919 + 13) >>> 0);

  // --- core: a cluster of overlapping soft dabs, not one smooth polygon ---
  // Radius/scatter fractions are ~20% larger than the tendril/satellite/speckle fractions below
  // (which are untouched) so the main splash blob reads a bit chunkier without widening the halo.
  const coreCount = 8 + Math.floor(rng() * 7);
  for (let i = 0; i < coreCount; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * size * 0.44 * (0.6 + 0.5 * fbmA(a * 2.1));
    const r = size * (0.42 + rng() * 0.24);
    specs.push({
      x: Math.cos(a) * d, y: Math.sin(a) * d,
      rx: r, ry: r * (0.82 + rng() * 0.32),
      rotation: rng() * Math.PI * 2,
      alpha: 0.55 + rng() * 0.3,
      type: 'dab', flavor: 'soft', tipIndex: Math.floor(rng() * 1000),
      dabSeed: nextDabSeed(), sheen: rng() < 0.35, part: 'core',
    });
  }

  // --- tendrils: chains of tapering dabs walking an outward, wobbling curve ---
  const tendrilCount = 5 + Math.floor(rng() * 8);
  for (let i = 0; i < tendrilCount; i++) {
    const a0 = rng() * Math.PI * 2;
    // Root pushed out to match the enlarged core above, so tendrils still start at its edge
    // instead of inside it.
    const baseR = size * (0.52 + 0.28 * fbmA(a0 * 2.15));
    const len = size * (0.35 + rng() * 1.5);
    const wobble = (rng() - 0.5) * 0.8;
    const steps = 5 + Math.floor(rng() * 5);
    let tipX = 0, tipY = 0, tipW = 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const rr = baseR + len * t;
      const aa = a0 + wobble * t * t * 0.6;
      const w = Math.max(size * 0.015, size * 0.075 * (1 - t * 0.85) * (0.5 + rng() * 0.6));
      const x = Math.cos(aa) * rr, y = Math.sin(aa) * rr;
      specs.push({
        x, y, rx: w, ry: w, rotation: rng() * Math.PI * 2,
        alpha: lerp(0.55, 0.16, t),
        type: 'dab', flavor: 'soft', tipIndex: Math.floor(rng() * 1000),
        dabSeed: nextDabSeed(), sheen: false, part: 'tendril',
      });
      tipX = x; tipY = y; tipW = w;
    }
    if (rng() < 0.6) {
      specs.push({
        x: tipX, y: tipY, rx: tipW * (1.3 + rng() * 1.2), ry: tipW * (1.1 + rng()),
        rotation: rng() * Math.PI * 2, alpha: 0.55 + rng() * 0.25,
        type: 'dab', flavor: 'soft', tipIndex: Math.floor(rng() * 1000),
        dabSeed: nextDabSeed(), sheen: rng() < 0.3, part: 'tendril',
      });
    }
  }

  // --- satellite droplets: power-law size, some elongated (flick direction) ---
  const satCount = 25 + Math.floor(rng() * 45);
  for (let i = 0; i < satCount; i++) {
    const a = rng() * Math.PI * 2;
    const dist = size * (0.95 + Math.abs(randNorm(rng)) * 1.5);
    const r = powerSmall(rng, size * 0.012, size * 0.1, 2.6);
    const stretch = rng() < 0.3 ? 1.6 + rng() * 1.8 : 1;
    specs.push({
      x: Math.cos(a) * dist, y: Math.sin(a) * dist,
      rx: r * stretch, ry: r, rotation: a,
      alpha: 0.75 + rng() * 0.2,
      type: 'dab', flavor: 'soft', tipIndex: Math.floor(rng() * 1000),
      dabSeed: nextDabSeed(), sheen: rng() < 0.4, part: 'satellite',
    });
  }

  // --- micro speckle ---
  const speckCount = 60 + Math.floor(rng() * 90);
  for (let i = 0; i < speckCount; i++) {
    const a = rng() * Math.PI * 2;
    const dist = size * (0.25 + rng() * 2.3);
    const r = size * (0.008 + rng() * 0.018);
    specs.push({
      x: Math.cos(a) * dist, y: Math.sin(a) * dist,
      rx: r, ry: r, rotation: rng() * Math.PI * 2,
      alpha: 0.35 + rng() * 0.3,
      type: 'dab', flavor: 'soft', tipIndex: Math.floor(rng() * 1000),
      dabSeed: nextDabSeed(), sheen: false, part: 'speckle',
    });
  }

  return specs;
}

// ============================================================================
// 5. STROKE — dab-based ribbon: body + streaks + entry fray + cap, plus a
//    small analytic sheen pass (two offset vector lines) for a coherent glossy edge.
// ============================================================================

// "How big marks read on screen". Applied via SP_SCALED to on-screen size fields (widths, entry
// length, splat sizes), NOT to sampling density or finger-speed fields (see SP_DPR_ONLY).
const MARK_SCALE = 2.75;

// Length/speed fields are CSS px (px/s); createPaintEngine scales them to device px (and size fields
// by MARK_SCALE) at init. Alphas, counts and unitless fractions are left as-is.
const STROKE_DEFAULTS = {
  spacing: 5,               // CSS px between resampled centerline points
  streakCountMin: 18, streakCountMax: 30,
  widthMax: 20, widthMin: 12,           // CSS px, at slow / fast speed
  speedForMinWidth: 900,                // CSS px/s at which width hits widthMin
  entryLen: 60,                         // CSS px over which the stroke "loads in"
  dryLoSpeed: 250, dryHiSpeed: 1500,    // CSS px/s range mapping to dryness gain
  bodyFillAlpha: 0.5,        // the continuous base-fill line that guarantees a smooth silhouette
  bodySpacingLoaded: 0.22, bodySpacingDry: 0.5, // body-dab spacing, × body diameter
  bodyAlphaMin: 0.18, bodyAlphaMax: 0.32, // body dabs are a texture overlay on the fill, not the coverage
  streakLenMin: 18, streakLenMax: 30,
  streakWidthMin: 1.2, streakWidthMax: 4,
  streakAlphaMin: 0.12, streakAlphaMax: 0.35,
  speckleBaseChance: 0.045, speckleDryBonus: 0.11,   // per-frame trigger probability, fine speckle
  dropletBaseChance: 0.010, dropletDryBonus: 0.035,  // per-frame trigger probability, thrown droplets
  dropletSizeMinFrac: 0.18, dropletSizeMaxFrac: 0.38, // × baseWidth
  dabCapPerCall: 140,
  splatterMul: 1, // × speckle/droplet count per trigger (dashMarks overrides)
  capScale: 1,    // × the release cap's dab radius / throw distance (dashMarks shrinks for short drags)

  // Opening splatter: every dragged mark's first ~openSplatterLen throws paint hard, decaying
  // smoothly to the ordinary rate (strokeFrameCommands). A short drag never travels far enough to
  // decay, so it's all splatter (what a "dash" is); a long one opens with a burst and settles.
  // The ramp is a pure function of arc length, identical live and baked, so nothing jumps.
  openSplatterMul: 9,        // × fine-speckle count at arcLen 0, → 1×
  openDropletMul: 3,         // × droplet count at arcLen 0, → 1× (smaller than speckle's: a 9× of
                             // fat drops would read as unrelated blobs, not thrown paint)
  openDropletSizeMul: 1.15,  // × droplet size at arcLen 0, → 1× (fatter drops early)
  openSplatterLen: 120,      // CSS px of travel over which the three above decay (a travel distance,
                             // so SP_DPR_ONLY; longer than dashMaxSpan so a growing drag doesn't
                             // change character as it crosses)
  dashMaxSpan: 32,           // CSS px bbox span below which a finished drag still gets dashMarks' two end bursts

  // The splash: a drag shorter than ~a brush width lays down a real splatDabSpecs cluster (the tap
  // generator) stretched along travel, weighted splashFrac = 1 - smoothstep(0, splashLen, arcLen) —
  // the complement of the body's entry ramp, so splash out / body in over the same distance. A tap
  // is a splash; a real stroke has none left. See splashMarks.
  splashLen: 60,         // CSS px over which the splash fades (matches entryLen)
  splashSizeFrac: 0.34,  // × widthMax → splash size (≈ the tap splat, so a barely-cleared drag ≈ a tap)
  splashStretch: 0.9,    // elongation along travel at full dashMaxSpan travel (smeared, not dropped)
  burstBoostMax: 1.8,    // × the two end bursts' dab counts at splashFrac 1, → 1×
  burstDistMin: 0.55,    // × the end bursts' throw distance at zero travel, → 1× (their radius keys
                         // off full brush width, which flings a short mark's spatter onto empty page)

  // The flick: above flickLoGain the point cap hands over to a tail. It is NOT a separate shape laid
  // over the end of the stroke: strokeTailFrames carries the stroke's own centerline on past the
  // release point as more frames at the same spacing (leaving at the stroke's turn rate, so the
  // curvature doesn't jump), and the same body generator (strokeFrameCommands) draws them with a
  // per-frame `lift` that scales every width to zero and thins the coverage. So the tail is the body
  // continuing — its fill alpha, segment stacking, streak phases, sheen and edge are unchanged
  // across the release point, and the taper starts THERE, from the body's own width. A real brush
  // leaving the paper narrows from the width it had; nothing about it gets fuller, flatter or
  // crisper first — which is exactly what a tail stamped over the body as a second fill did, and
  // what made its start show. Past flickBreakFrac the ribbon has faded out and the rest is thrown
  // flecks (strokeFlickExtraCommands).
  // Ramped in by smoothstep(flickLoGain, flickHiGain, releaseGain), no threshold: the tail's LENGTH
  // grows from zero with the gain (flickLenRamp) and the droplet scatter it replaces is thinned by
  // the same gain (flickScatterKeep), so the regimes overlap. Every length below is a FRACTION of
  // baseWidth, so none needs an SP_SCALED entry.
  flickLoGain: 0.55, flickHiGain: 0.9, // releaseGain range over which the tail ramps in
  flickTailLenFrac: 3.6,   // × baseWidth: tail length at full gain (past ~3× it stops reading as a release)
  flickLenRamp: 0.3,       // gain over which that length ramps up from zero (then × lerp(0.6, 1, gain))
  flickTailShoulder: 1.4,  // width along the tail is (1 - t^shoulder)^taper: shoulder > 1 gives zero
  flickTaper: 1.5,         //   slope at the release point (no kink) before the taper bites
  flickFadeStart: 0.25,    // fraction of the tail where the fill/sheen coverage starts thinning; it is
                           //   gone just past the break (the ribbon ends by fading, not by stopping)
  flickStreakHold: 0.4,    // streaks hold full strength this far, then fade to the tip: the bristle
                           //   lines outlast the solid ribbon, the way a lifting brush goes streaky
  flickBreakFrac: 0.72,    // fraction of the tail still a ribbon; past this it's flecks
  flickWobble: 0.3,        // × half-width: lateral tremor of the tail's centerline, growing toward the tip
  flickCurlFrames: 6,      // frames of lookback for the stroke's turn rate at release
  flickCurlMul: 1.2,       // × that turn rate, integrated over the tail (a slight hook toward the tip)
  flickCurlMaxTurn: 1.15,  // rad, cap on total tail turn: past it the curl DECAYS along the tail (the
                           //   whip straightens) rather than being cut at the join, so a sharp corner
                           //   can't curl it back over the stroke and the join still stays smooth
  flickFleckCount: 14,     // airborne flecks past the tail tip at full gain
  flickFleckReach: 1.1,    // × tail length: how far past the tip they carry
  flickFleckSpread: 0.55,  // rad of angular scatter on them
  flickHairCount: 5,       // bristle hairs along the tail
  flickScatterKeep: 0.3,   // × the point cap's droplet count at full gain
};

// Per-tick dab budget: sheen (cheap vector strokes) is never capped; priority-0 tiers (body/cap)
// carry stroke continuity and always survive; priority>0 tiers are shed in ascending order when a
// tick runs out. droplet sits with streak so thrown splatter outlasts the finer decorative tiers.
const TIER_PRIORITY = { body: 0, cap: 0, streak: 1, droplet: 1, entryFray: 2, speckle: 3 };
const BUDGETED_TIERS = Object.keys(TIER_PRIORITY)
  .filter((t) => TIER_PRIORITY[t] > 0)
  .sort((a, b) => TIER_PRIORITY[a] - TIER_PRIORITY[b]);

/** Build the fixed per-streak definitions for a stroke. Pure function of seed. */
function buildStreakDefs(seed, p) {
  const rng = makeRNG(seed);
  const count = Math.round(lerp(p.streakCountMin, p.streakCountMax, rng()));
  const streaks = [];
  for (let k = 0; k < count; k++) {
    const frac = count === 1 ? 0 : (k / (count - 1)) * 2 - 1;
    streaks.push({
      offsetFrac: clamp(frac + (rng() - 0.5) * 0.18, -1.15, 1.15),
      toneMul: rng(),
      len: p.streakLenMin + rng() * (p.streakLenMax - p.streakLenMin),
      width: p.streakWidthMin + rng() * (p.streakWidthMax - p.streakWidthMin),
      fbm: makeFbm1(seed * 7919 + k * 104729 + 17, 3),
      phase: rng() * 1000,
    });
  }
  return streaks;
}

/**
 * Dabs one splatter trigger emits, given the frame's expected count (`want`) and the trigger chance
 * (`eff` = min(1, want)). Averages want/eff, so the frame's expected output is `want` however the
 * budget split between chance and count. The fractional part is a coin flip off `roll` (frame-index
 * hash, deterministic) rather than Math.ceil, which would silently over-emit. At want <= 1 (every
 * unboosted frame) this returns 1 unchanged.
 */
function dabsPerTrigger(want, eff, roll) {
  if (eff <= 0) return 0;
  const perTrigger = want / eff;
  const whole = Math.floor(perTrigger);
  return whole + (roll < perTrigger - whole ? 1 : 0);
}

/**
 * Generate dab/sheen commands for stroke frames in [from, to). Pure given
 * (frames, streakDefs, params) — every random choice derives from the frame
 * index (or a fixed per-streak seed), never from a shared mutating rng, so
 * calling this repeatedly / incrementally always agrees on the shared prefix.
 *
 * A frame may carry a `lift` (only the synthetic ones strokeTailFrames appends past a flick's
 * release point do): {w, a, s, arc} — w scales every width, a the fill/body/sheen alpha, s the
 * streak alpha, and arc pins the entry ramp at the release point. That is how the flick tail is
 * drawn: by this generator, as the body continuing, not by a second pass over the end.
 */
function strokeFrameCommands(frames, from, to, streakDefs, p, seed) {
  const cmds = [];
  // Per-frame randomness is hash1(frame index) alone, so two marks of the same length would get
  // identical speckle/droplets at identical positions. A per-mark offset folded into the
  // speckle/droplet keys breaks that; body/streak/sheen are left alone (repetition is invisible in
  // a continuous ribbon). seed 0 reproduces the plain keys.
  const splatterKey = seed ? ((seed >>> 0) % 4093) * 13 : 0;
  // Body/streak placement is a deterministic arc-length accumulator (bounds the worst-case gap),
  // recomputed from i=1 every call so a live incremental call and a one-shot strokeMarks replay
  // agree bit-for-bit on the shared prefix.
  let bodyPhase = 0;
  const streakPhase = new Float64Array(streakDefs.length);
  for (let i = 1; i < to; i++) {
    const emit = i >= from;
    const A = frames[i - 1], B = frames[i];
    const speed = B.emaSpeed;
    const baseWidth = clamp(p.widthMax - (p.widthMax - p.widthMin) * (speed / p.speedForMinWidth), p.widthMin, p.widthMax);
    // Lift (see the doc comment): real frames have none and multiply by 1, which is exact, so their
    // commands are bit-identical with or without a tail behind them — the live preview and the bake
    // still agree. The entry ramp is pinned at the release point on tail frames because a brush that
    // lifts off a short drag narrows from the width it had; it doesn't keep loading in.
    const lift = B.lift;
    const wMul = lift ? lift.w : 1, aMul = lift ? lift.a : 1, sMul = lift ? lift.s : 1;
    const entryRamp = smoothstep(0, p.entryLen, lift ? lift.arc : B.arcLen);
    const dryGain = smoothstep(p.dryLoSpeed, p.dryHiSpeed, speed);
    const tangentAngle = Math.atan2(B.ty, B.tx);

    // --- body fill: one continuous vector line per frame segment, always emitted, that alone
    // defines the smooth silhouette (a chain of discrete dabs has a scalloped union boundary until
    // overlap is near-total, which costs more dabs than the budget allows). Round joins are safe
    // because every segment paints nearly the same opaque tone. The body dabs below just add
    // texture on top.
    const bodyDiam = baseWidth * (0.3 + 0.7 * entryRamp) * wMul;
    if (emit && aMul > 0) {
      cmds.push({
        type: 'bodyFillLine', tier: 'body',
        x1: A.x, y1: A.y, x2: B.x, y2: B.y,
        width: Math.max(1, bodyDiam * (0.94 + hash1(i * 13 + 8) * 0.12)),
        alpha: p.bodyFillAlpha * entryRamp * lerp(1, 0.85, dryGain) * aMul,
        dabSeed: (i * 4001 + 8191) >>> 0,
      });
    }

    // --- body tier: tangent-aligned smear dabs over the fill, dense when loaded, thin when dry ---
    const bodySpacing = bodyDiam * lerp(p.bodySpacingLoaded, p.bodySpacingDry, dryGain);
    bodyPhase += p.spacing;
    if (bodyPhase >= bodySpacing) {
      bodyPhase %= bodySpacing;
      if (emit && aMul > 0) {
        cmds.push({
          type: 'dab', tier: 'body', flavor: 'crisp',
          x: B.x, y: B.y,
          rx: bodyDiam / 2 * (1.35 + 0.9 * dryGain) * (0.85 + hash1(i * 13 + 2) * 0.3),
          // kept inside the fill line's half-width so these never poke past its silhouette
          ry: bodyDiam / 2 * (0.5 + hash1(i * 13 + 3) * 0.25),
          rotation: tangentAngle + (hash1(i * 13 + 4) - 0.5) * 0.3,
          alpha: lerp(p.bodyAlphaMin, p.bodyAlphaMax, hash1(i * 13 + 5)) * entryRamp * lerp(1, 0.72, dryGain) * aMul,
          tipIndex: Math.floor(hash1(i * 13 + 6) * 1000), dabSeed: (i * 4001 + 17) >>> 0, sheen: false,
        });
      }
    }

    const halfSpread = baseWidth * 0.5 * (0.4 + 0.6 * entryRamp) * (1 + (1 - entryRamp) * 0.7) * wMul;

    // --- streak tier: tangent-following elongated dabs on a deterministic accumulator, so the
    // lengthwise striation reads as banding ---
    for (let k = 0; k < streakDefs.length; k++) {
      const S = streakDefs[k];
      const threshold = S.len * 0.5;
      streakPhase[k] += p.spacing;
      const hkey = i * 131 + k * 977;
      if (streakPhase[k] >= threshold) {
        streakPhase[k] %= threshold;
        if (emit) {
          const nB = S.fbm(B.arcLen * 0.045 + S.phase);
          const rawCover = 0.5 + 0.5 * nB;
          const alphaMul = clamp(1 - (0.18 + 0.82 * dryGain) * (1 - rawCover) * 1.7, 0, 1);
          const alpha = lerp(p.streakAlphaMin, p.streakAlphaMax, S.toneMul) * entryRamp * alphaMul * sMul;
          if (alpha > 0.01) {
            const off = S.offsetFrac * halfSpread;
            cmds.push({
              type: 'dab', tier: 'streak', flavor: 'crisp',
              x: B.x + B.nx * off, y: B.y + B.ny * off,
              // on a tail the bristle lines thin and shorten with the lift (never to nothing: the
              // last of them are what's left past the ribbon)
              rx: S.len / 2 * (lift ? lerp(0.4, 1, wMul) : 1),
              ry: S.width / 2 * (0.4 + 0.6 * entryRamp) * (lift ? 0.35 + 0.65 * wMul : 1),
              rotation: tangentAngle,
              alpha, tipIndex: Math.floor(hash1(hkey + 9) * 1000),
              dabSeed: (hkey + 31) >>> 0, sheen: false,
            });
          }
        }
      }
    }

    // --- sheen: two thin offset vector lines, coherent by construction (biased by the frame normal) ---
    if (emit && entryRamp > 0.05 && aMul > 0) {
      const darkOff = -halfSpread * 0.55, lightOff = halfSpread * 0.55;
      cmds.push({
        type: 'sheenLine', tier: 'sheen', dark: true,
        x1: A.x + A.nx * darkOff, y1: A.y + A.ny * darkOff,
        x2: B.x + B.nx * darkOff, y2: B.y + B.ny * darkOff,
        width: Math.max(0.6, baseWidth * 0.18 * entryRamp * wMul), alpha: 0.11 * entryRamp * aMul,
      });
      cmds.push({
        type: 'sheenLine', tier: 'sheen', dark: false,
        x1: A.x + A.nx * lightOff, y1: A.y + A.ny * lightOff,
        x2: B.x + B.nx * lightOff, y2: B.y + B.ny * lightOff,
        width: Math.max(0.6, baseWidth * 0.13 * entryRamp * wMul), alpha: 0.17 * entryRamp * aMul,
      });
    }

    // --- edge splatter: fine speckle + thrown droplets off the flanks, independent per-frame
    // Bernoulli triggers. splatterMul spends its budget on the trigger CHANCE first, then the count
    // per trigger (each dab keyed off its own sub-index j for deterministic replay); at mul=1 the
    // keys reduce to the plain i*977 / i*613 formula. Chance-first matters for short marks: a 9× of
    // count alone would still be a 4.5%-per-frame coin flip, so a 6-frame drag would splatter or not
    // at random. openBoost is 1 at the far end of the ramp, openSplatterMul at arcLen 0, driven by
    // B.arcLen (= i*spacing) so it's threshold-free and identical live vs. baked.
    if (emit) {
      const openFade = smoothstep(0, p.openSplatterLen, B.arcLen);
      const openBoost = lerp(p.openSplatterMul !== undefined ? p.openSplatterMul : 1, 1, openFade);
      const openDropBoost = lerp(p.openDropletMul !== undefined ? p.openDropletMul : 1, 1, openFade);
      const baseMul = p.splatterMul !== undefined ? p.splatterMul : 1;
      const mul = baseMul * openBoost;
      const dropMul = baseMul * openDropBoost;
      const speckleWant = (p.speckleBaseChance + p.speckleDryBonus * dryGain) * mul;
      const speckleEff = Math.min(1, speckleWant);
      if (hash1(i * 977 + 13 + splatterKey) < speckleEff) {
        const speckleN = dabsPerTrigger(speckleWant, speckleEff, hash1(i * 977 + 5 + splatterKey));
        for (let j = 0; j < speckleN; j++) {
          const hkey = i * 977 + j * 211 + splatterKey;
          const side = hash1(hkey + 17) < 0.5 ? -1 : 1;
          const d = halfSpread * (1.1 + hash1(hkey + 19) * 1.6) * side;
          cmds.push({
            type: 'dab', tier: 'speckle', flavor: 'soft',
            x: B.x + B.nx * d, y: B.y + B.ny * d,
            rx: 0.6 + hash1(hkey + 29) * 1.8, ry: 0.6 + hash1(hkey + 31) * 1.8,
            rotation: hash1(hkey + 37) * Math.PI * 2,
            alpha: 0.25 + hash1(hkey + 41) * 0.35,
            tipIndex: Math.floor(hash1(hkey + 43) * 1000), dabSeed: (hkey + 47) >>> 0, sheen: false,
          });
        }
      }
      const dropletWant = (p.dropletBaseChance + p.dropletDryBonus * dryGain) * dropMul;
      const dropletEff = Math.min(1, dropletWant);
      if (hash1(i * 613 + 53 + splatterKey) < dropletEff) {
        const dropletN = dabsPerTrigger(dropletWant, dropletEff, hash1(i * 613 + 7 + splatterKey));
        for (let j = 0; j < dropletN; j++) {
          const hkey = i * 613 + j * 307 + splatterKey;
          const side = hash1(hkey + 59) < 0.5 ? -1 : 1;
          const dist = halfSpread * (1.6 + hash1(hkey + 61) * 1.6);
          const forward = baseWidth * (0.3 + hash1(hkey + 67) * 1.4);
          // Drops thrown early are the fat ones, on the same ramp as the emission count above.
          const dropBoost = lerp(p.openDropletSizeMul !== undefined ? p.openDropletSizeMul : 1, 1, openFade);
          const r = baseWidth * dropBoost * (p.dropletSizeMinFrac + hash1(hkey + 71) * (p.dropletSizeMaxFrac - p.dropletSizeMinFrac));
          const stretch = 1 + hash1(hkey + 73) * 0.8;
          cmds.push({
            type: 'dab', tier: 'droplet', flavor: 'soft',
            x: B.x + B.nx * dist * side + B.tx * forward,
            y: B.y + B.ny * dist * side + B.ty * forward,
            rx: r * stretch, ry: r, rotation: Math.atan2(B.ty, B.tx) + (hash1(hkey + 79) - 0.5) * 0.6,
            alpha: 0.55 + hash1(hkey + 83) * 0.3,
            tipIndex: Math.floor(hash1(hkey + 89) * 1000), dabSeed: (hkey + 97) >>> 0,
            sheen: hash1(hkey + 101) < 0.3,
          });
        }
      }
    }
  }

  return cmds;
}

/** Frayed, dry-brush touchdown: a handful of thin hair-like dabs fanning out from the stroke start. */
function strokeEntryFrayCommands(frames, p, seed) {
  const rng = makeRNG(seed ^ 0xe7a19);
  const entrySteps = Math.max(1, Math.min(frames.length - 1, Math.floor(p.entryLen / p.spacing)));
  const count = 10 + Math.floor(rng() * 9);
  const cmds = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.min(frames.length - 1, Math.floor(rng() * entrySteps));
    const F = frames[idx];
    const ang = Math.atan2(F.ty, F.tx) + (rng() - 0.5) * 0.5;
    const len = 8 + rng() * 12;
    const off = (rng() - 0.5) * p.widthMax * 0.6;
    cmds.push({
      type: 'dab', tier: 'entryFray', flavor: 'soft',
      x: F.x + F.nx * off, y: F.y + F.ny * off,
      rx: len / 2, ry: 0.8 + rng() * 1.2, rotation: ang,
      alpha: 0.15 + rng() * 0.3,
      tipIndex: Math.floor(rng() * 1000), dabSeed: Math.floor(rng() * 1e9), sheen: false,
    });
  }
  return cmds;
}

/**
 * What the brush was doing at release: how fast (releaseGain), how wide (baseWidth), how far along
 * the entry ramp (loadScale, so a short drag's end stays proportional to its body), and how much of
 * the release is a flick rather than a lift (flickGain, zero below flickLoGain). Pure. Shared by the
 * cap and the tail so the two agree on every number.
 */
function strokeRelease(frames, p) {
  const last = frames[frames.length - 1];
  const speed = last.emaSpeed;
  const releaseGain = smoothstep(p.dryLoSpeed, p.dryHiSpeed, speed);
  const baseWidth = clamp(p.widthMax - (p.widthMax - p.widthMin) * (speed / p.speedForMinWidth), p.widthMin, p.widthMax);
  // capScale: dashMarks-only shrink so the cap doesn't dominate a short drag (1 for a real stroke).
  // loadScale: the cap's size derives from baseWidth (fully-loaded width), so on a drag that hasn't
  // travelled a full entryLen it would arrive full-size over an invisible body — reuse the body's
  // own ramp (endRamp) to keep it proportional; endRamp = 1 leaves long strokes pixel-identical.
  const capScale = p.capScale !== undefined ? p.capScale : 1;
  const endRamp = smoothstep(0, p.entryLen, last.arcLen);
  const loadScale = capScale * (0.3 + 0.7 * endRamp);
  const flickGain = p.flickLoGain === undefined ? 0 : smoothstep(p.flickLoGain, p.flickHiGain, releaseGain);
  return { last, releaseGain, baseWidth, endRamp, loadScale, flickGain };
}

/**
 * The flick tail's centerline: the stroke's frames carried on past the release point, as more
 * frames at the same spacing, each with a `lift` (see strokeFrameCommands) that takes the body
 * generator's widths and coverage down to nothing. Pure given (frames, p, seed). Returns null when
 * the release isn't a flick; otherwise the extended frame list (the caller's frames untouched: the
 * last real one is replaced by a copy whose tangent is now a central difference) plus where the
 * ribbon gives way to flecks.
 *
 * Direction: the walk leaves at the stroke's own turn rate over its last flickCurlFrames (rad/px), so
 * the curvature is continuous through the release point — a tail that left straight and curled
 * later showed exactly where it had been stuck on. Along the tail the curvature follows
 * (1 + hook·t²)·(1 − t)^q: a mild hook toward the tip (flickCurlMul), and q > 0 only when the total
 * turn would exceed flickCurlMaxTurn, in which case the curl decays along the tail (the whip
 * straightens out) rather than being scaled down at the join.
 */
function strokeTailFrames(frames, p, seed) {
  const n = frames.length;
  if (n < 2) return null;
  const rel = strokeRelease(frames, p);
  const gain = rel.flickGain;
  if (gain <= 0.02) return null;
  const last = rel.last, sp = p.spacing;
  // The length grows from zero with the gain, so the tail ramps in continuously out of the body's
  // round-capped end instead of appearing at the threshold.
  const lenGain = smoothstep(0, p.flickLenRamp, gain) * lerp(0.6, 1, gain);
  const len = rel.baseWidth * p.flickTailLenFrac * rel.loadScale * lenGain;
  const count = Math.round(len / sp);
  if (count < 1) return null;
  const breakAt = clamp(p.flickBreakFrac, 0.15, 0.95);
  const wob = makeFbm1(seed * 7919 + 911, 3);
  // the body's half-width at release: what the taper starts from (and the wobble's scale)
  const half0 = rel.baseWidth * 0.5 * (0.3 + 0.7 * rel.endRamp);

  const back = Math.max(1, Math.min(n - 1, Math.round(p.flickCurlFrames)));
  const prev = frames[n - 1 - back];
  const a0 = Math.atan2(last.ty, last.tx);
  let dA = a0 - Math.atan2(prev.ty, prev.tx);
  while (dA > Math.PI) dA -= Math.PI * 2;
  while (dA < -Math.PI) dA += Math.PI * 2;
  const kappa0 = dA / Math.max(1e-3, last.arcLen - prev.arcLen);
  const hook = 3 * Math.max(0, p.flickCurlMul - 1); // ∫(1 + hook·t²)dt over the tail = flickCurlMul
  const curvature = (t, q) => kappa0 * (1 + hook * t * t) * Math.pow(1 - t, q);
  const totalTurn = (q) => {
    let s = 0;
    for (let k = 1; k <= count; k++) s += curvature((k - 0.5) / count, q);
    return s * sp;
  };
  let q = 0;
  if (Math.abs(totalTurn(0)) > p.flickCurlMaxTurn) {
    // monotone in q: bisect for the decay that lands exactly on the cap
    let lo = 0, hi = 16;
    for (let it = 0; it < 24; it++) {
      const mid = (lo + hi) / 2;
      if (Math.abs(totalTurn(mid)) > p.flickCurlMaxTurn) lo = mid; else hi = mid;
    }
    q = hi;
  }

  const ext = frames.slice();
  let x = last.x, y = last.y, ang = a0;
  for (let k = 1; k <= count; k++) {
    ang += curvature((k - 0.5) / count, q) * sp;
    x += Math.cos(ang) * sp;
    y += Math.sin(ang) * sp;
    const t = k / count;
    // Width: zero slope at the release point, then the taper. Coverage: the fill holds full for the
    // first stretch, thins, and is gone just past the break; the streaks outlast it to the tip.
    const w = Math.max(0.02, Math.pow(1 - Math.pow(t, p.flickTailShoulder), p.flickTaper));
    // Lateral tremor on the emitted point, not accumulated into the walk, so it shakes the edge
    // without letting the tail drift off its own axis; it grows from nothing at the join.
    const lat = wob(t * 2.6) * half0 * p.flickWobble * t * gain;
    ext.push({
      x: x - Math.sin(ang) * lat, y: y + Math.cos(ang) * lat, t: last.t,
      tx: Math.cos(ang), ty: Math.sin(ang), nx: -Math.sin(ang), ny: Math.cos(ang),
      arcLen: last.arcLen + k * sp, speed: last.speed, emaSpeed: last.emaSpeed,
      lift: {
        t, w,
        a: 1 - smoothstep(p.flickFadeStart, breakAt + 0.06, t),
        s: 1 - smoothstep(p.flickStreakHold, 1, t),
        arc: last.arcLen,
        half: half0 * w,
      },
    });
  }
  // Tangents/normals from the walked positions the way computeFrames does them (central
  // differences), the last real frame included: it only ever had a backward difference, and it is
  // never in the live preview (LOOKBEHIND), so smoothing it changes nothing already on screen.
  for (let i = n - 1; i < ext.length; i++) {
    const P = ext[Math.max(0, i - 1)], N = ext[Math.min(ext.length - 1, i + 1)];
    let tx = N.x - P.x, ty = N.y - P.y;
    const tl = Math.hypot(tx, ty) || 1;
    tx /= tl; ty /= tl;
    const f = i === n - 1 ? (ext[i] = Object.assign({}, ext[i])) : ext[i];
    f.tx = tx; f.ty = ty; f.nx = -ty; f.ny = tx;
  }
  let ribbonEnd = n;
  while (ribbonEnd < ext.length && ext[ribbonEnd].lift.t <= breakAt) ribbonEnd++;
  return { frames: ext, start: n, ribbonEnd, count, len, gain, breakAt, half0, baseWidth: rel.baseWidth, loadScale: rel.loadScale };
}

/**
 * The paint a flick throws that isn't the ribbon: soft elongated flecks along the tail's axis past
 * the break (where the ribbon has faded out: the paint no longer holds together), a cone of fine
 * stuff thrown on past the tip, and bristle hairs along the whole tail. Pure given (tail, p, seed),
 * so a replay reproduces it dab-for-dab.
 */
function strokeFlickExtraCommands(tail, p, seed) {
  const rng = makeRNG((seed ^ 0xf11c7a) >>> 0);
  const ext = tail.frames, gain = tail.gain, baseWidth = tail.baseWidth, loadScale = tail.loadScale;
  const baseHalf = tail.half0, breakAt = tail.breakAt, len = tail.len;
  const cmds = [];

  // --- past the break: the same axis, but the paint no longer holds together. Soft flecks, thinning
  // out toward the tip, elongated along travel (a drop in flight is a streak, not a dot).
  for (let i = tail.ribbonEnd; i < ext.length; i++) {
    const P = ext[i], L = P.lift;
    const u = (L.t - breakAt) / (1 - breakAt);
    if (rng() < u * 0.7) continue;
    const r = Math.max(0.6, L.half * (0.8 + rng() * 0.7));
    const stretch = 1.3 + rng() * 1.7;
    const lat = (rng() - 0.5) * baseHalf * 0.8 * u;
    const ang = Math.atan2(P.ty, P.tx);
    cmds.push({
      type: 'dab', tier: 'droplet', flavor: 'soft',
      x: P.x + P.nx * lat, y: P.y + P.ny * lat,
      rx: r * stretch, ry: r, rotation: ang + (rng() - 0.5) * 0.35,
      alpha: (0.4 + rng() * 0.3) * gain * (1 - u * 0.45),
      tipIndex: Math.floor(rng() * 1000), dabSeed: Math.floor(rng() * 1e9), sheen: rng() < 0.3,
    });
  }

  // --- and the paint that outran the tail entirely: a cone of fine stuff thrown on past the tip,
  // biased outward so it doesn't just thicken the tail's end.
  const tip = ext[ext.length - 1];
  const tipAng = Math.atan2(tip.ty, tip.tx);
  const fleckCount = Math.round(p.flickFleckCount * gain * (0.6 + rng() * 0.8));
  for (let i = 0; i < fleckCount; i++) {
    const u = Math.pow(rng(), 0.6);
    const dist = len * (0.12 + u * p.flickFleckReach);
    const a = tipAng + (rng() - 0.5) * p.flickFleckSpread * (0.4 + u);
    const r = powerSmall(rng, baseWidth * 0.012, baseWidth * 0.07, 2.4) * loadScale;
    const streak = rng() < 0.35 ? 1.5 + rng() * 1.8 : 1;
    cmds.push({
      type: 'dab', tier: r > baseWidth * 0.03 ? 'droplet' : 'speckle', flavor: 'soft',
      x: tip.x + Math.cos(a) * dist, y: tip.y + Math.sin(a) * dist,
      rx: r * streak, ry: r, rotation: a,
      alpha: (0.35 + rng() * 0.35) * gain,
      tipIndex: Math.floor(rng() * 1000), dabSeed: Math.floor(rng() * 1e9), sheen: rng() < 0.25,
    });
  }

  // --- bristle hairs: the exit counterpart to the touchdown fray. Along the whole tail, biased
  // toward the tip, running on past where the ribbon has faded so the two blend rather than meeting
  // at a boundary. Each lies along the local tail direction with a little splay.
  const hairs = Math.round(p.flickHairCount * gain);
  for (let i = 0; i < hairs; i++) {
    const t0 = Math.pow(rng(), 0.55); // biased toward the tip
    const P = ext[tail.start - 1 + Math.min(tail.count, Math.round(t0 * tail.count))];
    const half = P.lift ? P.lift.half : baseHalf;
    const hairLen = len * (0.16 + rng() * 0.3) * lerp(1, 0.55, t0);
    const a = Math.atan2(P.ty, P.tx) + (rng() - 0.5) * 0.3 * (0.5 + t0);
    const off = (rng() - 0.5) * (half * 1.7 + baseHalf * 0.12);
    cmds.push({
      type: 'dab', tier: 'entryFray', flavor: 'soft',
      x: P.x + P.nx * off + Math.cos(a) * hairLen * 0.5,
      y: P.y + P.ny * off + Math.sin(a) * hairLen * 0.5,
      rx: hairLen / 2, ry: 0.6 + rng() * 1.3, rotation: a,
      alpha: (0.10 + rng() * 0.20) * gain * lerp(1, 0.5, t0),
      tipIndex: Math.floor(rng() * 1000), dabSeed: Math.floor(rng() * 1e9), sheen: false,
    });
  }

  return cmds;
}

/**
 * Finishing treatment applied once a stroke ends, by how fast the brush was moving at release
 * (releaseGain): a rounded crisp end for a slow lift, a forward scatter of thrown droplets for a
 * moderate one. Above flickLoGain the tail takes over (strokeTailFrames, drawn by the body generator
 * in strokeMarks): it ramps in over flickLoGain..flickHiGain while the scatter it replaces is thinned
 * by the same gain, so nothing pops at either boundary.
 */
function strokeCapCommands(frames, p, seed) {
  const rng = makeRNG(seed ^ 0xc0ffee);
  if (frames.length < 2) return [];
  const rel = strokeRelease(frames, p);
  const last = rel.last, releaseGain = rel.releaseGain, baseWidth = rel.baseWidth;
  const loadScale = rel.loadScale, flickGain = rel.flickGain;
  const cmds = [];

  if (releaseGain < 0.4) {
    const count = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < count; i++) {
      const r = baseWidth * (0.4 + rng() * 0.35) * loadScale;
      const off = (rng() - 0.5) * baseWidth * 0.3;
      cmds.push({
        type: 'dab', tier: 'cap', flavor: 'crisp',
        x: last.x + last.nx * off, y: last.y + last.ny * off,
        rx: r, ry: r * (0.85 + rng() * 0.3), rotation: rng() * Math.PI * 2,
        alpha: 0.4 + rng() * 0.2, tipIndex: Math.floor(rng() * 1000),
        dabSeed: Math.floor(rng() * 1e9), sheen: false,
      });
    }
  } else {
    // thinned as the tail takes over (flickScatterKeep), so the two don't run at full strength together
    const scatterKeep = lerp(1, p.flickScatterKeep !== undefined ? p.flickScatterKeep : 1, flickGain);
    const count = Math.max(1, Math.round((2 + Math.floor(rng() * 5)) * scatterKeep));
    for (let i = 0; i < count; i++) {
      const dist = baseWidth * (0.8 + rng() * 3.2) * (0.4 + releaseGain) * loadScale;
      const spread = (rng() - 0.5) * baseWidth * 1.4 * loadScale;
      const x = last.x + last.tx * dist - last.ny * spread;
      const y = last.y + last.ty * dist + last.nx * spread;
      const r = (0.8 + powerSmall(rng, 0, baseWidth * 0.22, 2.2)) * loadScale;
      cmds.push({
        type: 'dab', tier: 'cap', flavor: 'soft', x, y,
        rx: r, ry: r, rotation: rng() * Math.PI * 2,
        alpha: 0.35 + rng() * 0.3, tipIndex: Math.floor(rng() * 1000),
        dabSeed: Math.floor(rng() * 1e9), sheen: false,
      });
    }
  }
  return cmds;
}

/** Pure, full-stroke variant (used for offline replay / rebuild): returns every command at once. */
function strokeMarks(frames, params, seed) {
  const p = Object.assign({}, STROKE_DEFAULTS, params);
  const streakDefs = buildStreakDefs(seed, p);
  const entry = strokeEntryFrayCommands(frames, p, seed);
  const cap = strokeCapCommands(frames, p, seed);
  const tail = strokeTailFrames(frames, p, seed);
  if (!tail) {
    const body = strokeFrameCommands(frames, 1, frames.length, streakDefs, p, seed);
    return body.concat(entry, cap);
  }
  // One pass over the real frames and the tail's together: the ribbon is the body continuing (same
  // streak phases, same fill, same stacking), so there is no join to hide. The release scatter goes
  // under it, so the tail's paint lands over the droplets it grew out of rather than under them (it
  // is all thrown forward of the release point, so nothing of the body is ever under it), and the
  // airborne flecks and hairs go on top.
  const body = strokeFrameCommands(tail.frames, 1, tail.frames.length, streakDefs, p, seed);
  return cap.concat(body, entry, strokeFlickExtraCommands(tail, p, seed));
}

// ============================================================================
// 5b. DASH — what a drag between a tap and a full stroke leaves: the section-5 stroke machinery at
//     the same geometry, with the speckle/droplet tiers boosted (openSplatterMul), drops enlarged,
//     and a splatter burst at each end. It's the real stroke generator over the real centerline, so
//     a curved drag curves and gets a live preview for free. See dashMarks / DASH_MAX_SPAN.
// ============================================================================

/**
 * Splatter thrown from one anchor in a directional cone: satellite droplets + fine speckle along
 * (dirX, dirY). Pure. Gives a dash's touchdown and release points an impact burst.
 */
function strokeSplatterBurst(seed, cx, cy, dirX, dirY, size, opts) {
  opts = opts || {};
  const spread = opts.spread !== undefined ? opts.spread : Math.PI * 1.1;
  const satCountBase = opts.satCountBase !== undefined ? opts.satCountBase : 10;
  const satCountRand = opts.satCountRand !== undefined ? opts.satCountRand : 16;
  const speckCountBase = opts.speckCountBase !== undefined ? opts.speckCountBase : 20;
  const speckCountRand = opts.speckCountRand !== undefined ? opts.speckCountRand : 45;
  const distMul = opts.distMul !== undefined ? opts.distMul : 1;
  const rng = makeRNG(seed);
  const dirAngle = Math.atan2(dirY, dirX);
  const specs = [];
  let dabCounter = 0;
  const nextDabSeed = () => ((seed * 97 + (dabCounter++) * 7919 + 13) >>> 0);

  const satCount = satCountBase + Math.floor(rng() * satCountRand);
  for (let i = 0; i < satCount; i++) {
    const a = dirAngle + (rng() - 0.5) * spread;
    const dist = size * (0.95 + Math.abs(randNorm(rng)) * 1.5) * distMul;
    const r = powerSmall(rng, size * 0.012, size * 0.1, 2.6);
    const stretch = rng() < 0.3 ? 1.6 + rng() * 1.8 : 1;
    specs.push({
      type: 'dab', tier: 'droplet', flavor: 'soft',
      x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist,
      rx: r * stretch, ry: r, rotation: a,
      alpha: 0.75 + rng() * 0.2,
      tipIndex: Math.floor(rng() * 1000), dabSeed: nextDabSeed(), sheen: rng() < 0.4,
    });
  }

  const speckCount = speckCountBase + Math.floor(rng() * speckCountRand);
  for (let i = 0; i < speckCount; i++) {
    const a = dirAngle + (rng() - 0.5) * (spread * 1.3);
    const dist = size * (0.25 + rng() * 2.3) * distMul;
    const r = size * (0.008 + rng() * 0.018);
    specs.push({
      type: 'dab', tier: 'speckle', flavor: 'soft',
      x: cx + Math.cos(a) * dist, y: cy + Math.sin(a) * dist,
      rx: r, ry: r, rotation: rng() * Math.PI * 2,
      alpha: 0.35 + rng() * 0.3,
      tipIndex: Math.floor(rng() * 1000), dabSeed: nextDabSeed(), sheen: false,
    });
  }
  return specs;
}

/**
 * The splash a dragged mark leaves where it ends: a full splatDabSpecs cluster, on the path,
 * elongated along travel, weighted by splashFrac (1 for a barely-moved drag, 0 once past splashLen).
 * The structural core fades by shrinking/going translucent (culling would hole it); the thrown halo
 * fades by count, deterministically keyed by dab index. Skipped below splashFrac 0.02. Anchored
 * ~halfway along while strong and sliding FORWARD toward the release frame as it fades (that's where
 * a drag's paint is thrown from), always on an actual frame so it lands on a curved path.
 */
function splashMarks(frames, p, seed, splashFrac, growFrac) {
  if (splashFrac < 0.02 || frames.length < 2) return [];
  const anchor = frames[Math.round((frames.length - 1) * (1 - 0.5 * splashFrac))];
  const size = p.widthMax * (p.splashSizeFrac !== undefined ? p.splashSizeFrac : 0.34)
             * lerp(0.9, 1.2, growFrac);
  const specs = splatDabSpecs(seed ^ 0x5b1a54, size);
  // elongate along travel — what makes a smeared splash read as thrown, not dropped
  const stretch = 1 + (p.splashStretch !== undefined ? p.splashStretch : 0.9) * growFrac;
  const bodyScale = lerp(0.55, 1, splashFrac);
  const out = [];
  for (let i = 0; i < specs.length; i++) {
    const c = specs[i];
    const halo = c.part === 'satellite' || c.part === 'speckle';
    if (halo && hash1(i * 31 + 7) >= splashFrac) continue;
    const lx = c.x * stretch, ly = c.y;
    const scale = halo ? 1 : bodyScale;
    out.push({
      type: 'dab', tier: halo ? (c.part === 'satellite' ? 'droplet' : 'speckle') : 'cap',
      flavor: c.flavor,
      x: anchor.x + anchor.tx * lx + anchor.nx * ly,
      y: anchor.y + anchor.ty * lx + anchor.ny * ly,
      rx: c.rx * scale, ry: c.ry * scale,
      rotation: c.rotation + Math.atan2(anchor.ty, anchor.tx),
      alpha: c.alpha * (halo ? 1 : lerp(0.45, 1, splashFrac)),
      tipIndex: c.tipIndex, dabSeed: c.dabSeed, sheen: c.sheen,
    });
  }
  return out;
}

/**
 * strokeMarks plus the two directional splatter bursts every drag ends up with: one at touchdown
 * (biased backward) and one at release (biased forward, thrown farther). Both anchor to the real
 * first/last frame. The bursts scale with growFrac, saturating at dashMaxSpan — so a growing drag
 * sees them grow then hold, nothing vanishes at a threshold. Added here at bake time (a burst can
 * only be known at release) and purely additive, so the bake never removes anything on screen.
 * `dashMarks` stays as the name because it's part of the public surface.
 */
function dashMarks(frames, p, seed) {
  const dp = Object.assign({}, p);
  // Ramp the release cap and both bursts in over the first dashMaxSpan of travel, then hold — so a
  // 10px drag doesn't get the same ~50px bursts as a 32px one, and they ramp with the body (which
  // now carries the stroke's full entryLen). growFrac keys off arc length, not bbox span, so it's
  // replay-deterministic.
  let growFrac = 1, arc = 0;
  if (frames.length >= 2) {
    arc = frames[frames.length - 1].arcLen;
    growFrac = clamp(arc / p.dashMaxSpan, 0, 1);
  }
  // how much of the mark is splash vs. stroke — the complement of the body's entry ramp, so the
  // two hand off over the same distance. splashLen is MARK_SCALE'd (it's a fraction of brush width).
  const splashLen = p.splashLen !== undefined ? p.splashLen : p.entryLen;
  const splashFrac = frames.length >= 2 ? 1 - smoothstep(0, splashLen, arc) : 1;
  dp.capScale = lerp(0.45, 1, growFrac);
  const marks = strokeMarks(frames, dp, seed);
  if (frames.length < 2) return marks;
  const first = frames[0], last = frames[frames.length - 1];
  const splash = splashMarks(frames, dp, seed, splashFrac, growFrac);
  const size = dp.widthMax * 0.9 * lerp(0.5, 1, growFrac);
  // burst counts up and throw distance in as the mark gets splashier: a short drag's whole
  // character is thrown paint, and full-throw distance off widthMax would scatter a 30px mark's
  // flecks onto empty page.
  const boost = lerp(p.burstBoostMax !== undefined ? p.burstBoostMax : 1.8, 1, 1 - splashFrac);
  const near = lerp(p.burstDistMin !== undefined ? p.burstDistMin : 0.55, 1, growFrac);
  const impact = strokeSplatterBurst(seed ^ 0xb0a5, first.x, first.y, -first.tx, -first.ty, size, {
    spread: Math.PI * 1.5, satCountBase: Math.round(8 * boost), satCountRand: Math.round(12 * boost),
    speckCountBase: Math.round(25 * boost), speckCountRand: Math.round(50 * boost), distMul: near,
  });
  const release = strokeSplatterBurst(seed ^ 0xdead, last.x, last.y, last.tx, last.ty, size, {
    spread: Math.PI * 0.9, satCountBase: Math.round(10 * boost), satCountRand: Math.round(16 * boost),
    speckCountBase: Math.round(20 * boost), speckCountRand: Math.round(45 * boost), distMul: 1.3 * near,
  });
  // splash first (dropped, then pushed through), then the body, then the end bursts
  return splash.concat(marks, impact, release);
}

// ============================================================================
// 6. RASTERIZATION — dab specs -> pixels
// ============================================================================

function drawDabCommand(ctx, spritePool, baseRgb, c) {
  const pool = spritePool[c.flavor];
  const sprite = pool[c.tipIndex % pool.length];
  stampDab(ctx, sprite, c.x, c.y, c.rx, c.ry, c.rotation, baseRgb, c.alpha, c.dabSeed, c.sheen);
}

function drawStrokeCommands(ctx, cmds, baseRgb, spritePool) {
  for (const c of cmds) {
    if (c.type === 'dab') {
      drawDabCommand(ctx, spritePool, baseRgb, c);
    } else if (c.type === 'bodyFillLine') {
      // Opaque-ish, so round joins are safe (no beading). Single mulberry32 draw inlined to skip a
      // per-segment closure; arithmetic copied from makeRNG.
      let rngA = (c.dabSeed >>> 0) || 0x9e3779b9;
      rngA |= 0;
      rngA = (rngA + 0x6d2b79f5) | 0;
      let rngT = Math.imul(rngA ^ (rngA >>> 15), 1 | rngA);
      rngT = (rngT + Math.imul(rngT ^ (rngT >>> 7), 61 | rngT)) ^ rngT;
      const rngV = ((rngT ^ (rngT >>> 14)) >>> 0) / 4294967296;
      const tint = shadeColor(baseRgb, (rngV - 0.5) * 0.35);
      ctx.save();
      ctx.strokeStyle = 'rgb(' + (tint.r | 0) + ',' + (tint.g | 0) + ',' + (tint.b | 0) + ')';
      ctx.globalAlpha = c.alpha;
      ctx.lineWidth = c.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(c.x1, c.y1);
      ctx.lineTo(c.x2, c.y2);
      ctx.stroke();
      ctx.restore();
    } else if (c.type === 'sheenLine') {
      // Each frame contributes its own short segment, sharing an exact endpoint with its
      // neighbour. A round cap adds a half-disk at every endpoint, so the previous segment's end
      // cap and this segment's start cap both paint the same small circle at the joint -- two
      // translucent layers stacked, which is what reads as a bead at every frame boundary. Butt
      // caps make adjacent segments abut cleanly instead, so the line reads as one continuous
      // strip rather than dots.
      ctx.save();
      ctx.strokeStyle = c.dark ? '#000' : '#fff';
      ctx.globalAlpha = c.alpha;
      ctx.lineWidth = Math.max(0.5, c.width);
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(c.x1, c.y1);
      ctx.lineTo(c.x2, c.y2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawSplatCommands(ctx, specs, ox, oy, baseRgb, spritePool) {
  ctx.save();
  ctx.translate(ox, oy);
  for (const c of specs) drawDabCommand(ctx, spritePool, baseRgb, c);
  ctx.restore();
}

function commandBounds(cmds, ox, oy, pad) {
  ox = ox || 0; oy = oy || 0; pad = pad === undefined ? 6 : pad;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of cmds) {
    if (c.type === 'dab') {
      const m = Math.max(c.rx, c.ry) * 1.3;
      if (c.x - m < minX) minX = c.x - m; if (c.x + m > maxX) maxX = c.x + m;
      if (c.y - m < minY) minY = c.y - m; if (c.y + m > maxY) maxY = c.y + m;
    } else if (c.type === 'sheenLine' || c.type === 'bodyFillLine') {
      const m = c.width;
      if (c.x1 - m < minX) minX = c.x1 - m; if (c.x1 + m > maxX) maxX = c.x1 + m;
      if (c.y1 - m < minY) minY = c.y1 - m; if (c.y1 + m > maxY) maxY = c.y1 + m;
      if (c.x2 - m < minX) minX = c.x2 - m; if (c.x2 + m > maxX) maxX = c.x2 + m;
      if (c.y2 - m < minY) minY = c.y2 - m; if (c.y2 + m > maxY) maxY = c.y2 + m;
    }
  }
  if (minX === Infinity) return null;
  return { minX: minX + ox - pad, minY: minY + oy - pad, maxX: maxX + ox + pad, maxY: maxY + oy + pad };
}

// Above this device-px size, castShadow blurs a downscaled proxy instead of the full rect —
// `filter: blur()` cost scales with pixel count, and a stroke's bbox can be most of the screen.
const SHADOW_PROXY_MAX = 400;

/**
 * Draws a soft cast shadow under a mark from its own alpha silhouette (blur + zero colour, offset
 * down-right). Call ONCE per mark over its full bounds — sub-rect calls stack alpha at overlaps.
 */
// Pooled downscale proxy for the large-mark path; grows only, cleared on reuse (source-over would
// otherwise show a larger previous mark's edge pixels through a smaller one).
let shadowProxy = null, shadowProxyCtx = null;
function getShadowProxy(w, h) {
  if (!shadowProxy || shadowProxy.width < w || shadowProxy.height < h) {
    const nw = Math.max(w, shadowProxy ? shadowProxy.width : 0);
    const nh = Math.max(h, shadowProxy ? shadowProxy.height : 0);
    shadowProxy = document.createElement('canvas');
    shadowProxy.width = nw; shadowProxy.height = nh;
    shadowProxyCtx = shadowProxy.getContext('2d');
  } else {
    shadowProxyCtx.clearRect(0, 0, w, h);
  }
  return shadowProxyCtx;
}

function castShadow(sourceCanvas, rect, targetCtx) {
  const minX = rect.minX, minY = rect.minY;
  const w = rect.maxX - minX, h = rect.maxY - minY;
  if (w <= 0 || h <= 0) return;
  const s = Math.min(1, SHADOW_PROXY_MAX / Math.max(w, h));
  targetCtx.save();
  if (s >= 1) {
    targetCtx.filter = 'blur(3px) brightness(0)';
    targetCtx.globalAlpha = 0.22;
    targetCtx.drawImage(sourceCanvas, minX, minY, w, h, minX + 2, minY + 3, w, h);
  } else {
    const pw = Math.max(1, Math.round(w * s)), ph = Math.max(1, Math.round(h * s));
    const pctx = getShadowProxy(pw, ph);
    pctx.drawImage(sourceCanvas, minX, minY, w, h, 0, 0, pw, ph);
    targetCtx.filter = 'blur(' + Math.max(0.75, 3 * s) + 'px) brightness(0)';
    targetCtx.globalAlpha = 0.22;
    targetCtx.drawImage(pctx.canvas, 0, 0, pw, ph, minX + 2, minY + 3, w, h);
  }
  targetCtx.restore();
}

// ============================================================================
// 7. ENGINE — canvases, stroke/splat lifecycle, bounded history
// ============================================================================

const DEFAULT_PALETTE = ['#17A6B5', '#29ABE2', '#3B5BA5', '#3B12E8', '#F7941E', '#F04E23'];

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  return c;
}

// Pooled scratch canvas for one mark's pixels (drawn, shadow-cast, blitted, discarded). Marks are
// drawn one at a time synchronously, so one shared canvas is safe; grows only. A MARGIN past (w,h)
// is cleared on reuse because castShadow's blur samples a few px past the mark's rect.
let markCanvas = null, markCanvasCtx = null;
const MARK_CANVAS_MARGIN = 12;
function getMarkCanvas(w, h) {
  const needW = w + MARK_CANVAS_MARGIN, needH = h + MARK_CANVAS_MARGIN;
  if (!markCanvas || markCanvas.width < needW || markCanvas.height < needH) {
    const nw = Math.max(needW, markCanvas ? markCanvas.width : 0);
    const nh = Math.max(needH, markCanvas ? markCanvas.height : 0);
    markCanvas = document.createElement('canvas');
    markCanvas.width = nw; markCanvas.height = nh;
    markCanvasCtx = markCanvas.getContext('2d');
  } else {
    markCanvasCtx.clearRect(0, 0, needW, needH);
  }
  return markCanvasCtx;
}

// Commands drawn between elapsed-time checks in stepMarkBakeJob (performance.now() per command would
// itself cost; per few hundred would overshoot a frame).
const MARK_BAKE_CHUNK = 40;
// Max stroke/dash marks with pixels still in flight (pendingBakes); endStroke drains the oldest
// synchronously past this.
const PENDING_BAKE_MAX = 3;

function createPaintEngine(opts) {
  const canvas = opts.canvas;
  const palette = opts.palette || DEFAULT_PALETTE;
  const seed = opts.seed !== undefined ? opts.seed : Date.now();
  const budget = opts.budget || {};
  const dpr = Math.min(opts.dpr || window.devicePixelRatio || 1, 2);
  // paper:false leaves untouched pixels transparent, so the engine can lie over a page as a stain.
  const opaquePaper = opts.paper !== false;
  // scale multiplies how big marks read (MARK_SCALE) and nothing else: 0.5 is a brush half as wide,
  // with the same speeds, spacing and tap threshold. 1 (the default) is bit-identical to no option.
  const markScale = MARK_SCALE * (opts.scale > 0 ? opts.scale : 1);
  const rngGlobal = makeRNG(seed);
  const grain = makeGrainTile(96, makeRNG(seed ^ 0x9e3779b9));
  const spritePool = buildSpritePool(seed ^ 0x51ce7a5);
  // STROKE_DEFAULTS is CSS px; scale to device px here so behaviour is DPR-independent. Two lists:
  // SP_DPR_ONLY are sampling-density / finger-speed fields (unchanged by on-screen size);
  // SP_SCALED are on-screen mark sizes, so they also take MARK_SCALE. dashMaxSpan is DPR-only (it's
  // compared against raw finger travel); splashLen is SCALED (it's a fraction of brush width).
  const SP_DPR_ONLY = ['spacing', 'speedForMinWidth', 'dryLoSpeed', 'dryHiSpeed', 'dashMaxSpan'];
  const SP_SCALED = [
    'widthMax', 'widthMin', 'entryLen', 'splashLen', 'streakLenMin', 'streakLenMax', 'streakWidthMin', 'streakWidthMax',
  ];
  const SP = Object.assign({}, STROKE_DEFAULTS);
  for (const k of SP_DPR_ONLY) SP[k] *= dpr;
  for (const k of SP_SCALED) SP[k] *= dpr * markScale;

  let W = 0, H = 0; // device px
  const ctx = canvas.getContext('2d');
  const baked = makeCanvas(1, 1);
  const bakedCtx = baked.getContext('2d');
  const activeDisplay = makeCanvas(1, 1);
  const activeDisplayCtx = activeDisplay.getContext('2d');
  const paper = makeCanvas(1, 1);
  const paperCtx = paper.getContext('2d');

  let recipes = [];
  let totalArea = 0;
  const BUDGET = Object.assign({ maxMarks: 150, maxInkArea: null }, budget);

  let fade = null; // {to: canvas, progress}
  let rafScheduled = false;
  let stroke = null;
  // FIFO of stroke/dash marks whose recipe is pushed (budget accounting done) but whose pixels are
  // still being drawn across frames — see endStroke / stepPendingBakes / makeMarkBakeJob. Each job
  // carries its `standIn`: the live preview it ended with, shown until the job lands in bakedCtx.
  let pendingBakes = [];

  function pickColor() {
    const base = hexToRgb(pick(rngGlobal, palette));
    const jitter = (v) => clamp(v + (rngGlobal() - 0.5) * 22, 0, 255);
    const toHex = (v) => Math.round(v).toString(16).padStart(2, '0');
    return '#' + toHex(jitter(base.r)) + toHex(jitter(base.g)) + toHex(jitter(base.b));
  }

  let grainCanvasCache = null;
  function grainCanvasFrom(g) {
    if (grainCanvasCache) return grainCanvasCache;
    const c = makeCanvas(g.size, g.size);
    const cx = c.getContext('2d');
    const img = cx.createImageData(g.size, g.size);
    for (let i = 0; i < g.data.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = g.data[i];
      img.data[i * 4 + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
    grainCanvasCache = c;
    return c;
  }

  function drawPaper() {
    if (!opaquePaper) { paperCtx.clearRect(0, 0, W, H); return; }
    paperCtx.fillStyle = '#f4efe6';
    paperCtx.fillRect(0, 0, W, H);
    const pattern = paperCtx.createPattern(grainCanvasFrom(grain), 'repeat');
    paperCtx.save();
    paperCtx.globalAlpha = 0.05;
    paperCtx.globalCompositeOperation = 'multiply';
    paperCtx.fillStyle = pattern;
    paperCtx.fillRect(0, 0, W, H);
    paperCtx.restore();
  }

  function resize(wCss, hCss) {
    W = Math.max(1, Math.round(wCss * dpr));
    H = Math.max(1, Math.round(hCss * dpr));
    [canvas, baked, activeDisplay, paper].forEach((c) => { c.width = W; c.height = H; });
    canvas.style.width = wCss + 'px';
    canvas.style.height = hCss + 'px';
    // sized so the mark-count budget governs culling before the area budget does
    if (!BUDGET.maxInkArea) BUDGET.maxInkArea = 60 * W * H;
    drawPaper();
    // cancel in-flight async work — sized against the old W/H; rebuildBaked(true) below redraws all
    pendingBakes = []; rebuildQueue = null; fade = null;
    rebuildBaked(true);
    requestRender();
  }

  // ---- stroke lifecycle ----

  function toDevice(xCss, yCss) { return { x: xCss * dpr, y: yCss * dpr }; }

  // Bbox span of a raw point list — classifies a finished drag (endStroke) as tap / dash / stroke.
  function computeBounds(raw) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of raw) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY, span: Math.max(maxX - minX, maxY - minY) };
  }

  function beginStroke(xCss, yCss, t, o) {
    o = o || {};
    const p = toDevice(xCss, yCss);
    stroke = {
      seed: o.seed !== undefined ? o.seed : Math.floor(rngGlobal() * 1e9),
      color: o.color || pickColor(),
      raw: [{ x: p.x, y: p.y, t }],
      resampler: makePathResampler(SP.spacing),   // fed one raw point at a time (extendStroke)
      frames: [],
      drawnCount: 1,
      streakDefs: null,
      entryDrawn: false,
    };
    stroke.resampler.push(p.x, p.y, t);
    activeDisplayCtx.clearRect(0, 0, W, H);
    requestRender();
  }

  function extendStroke(xCss, yCss, t) {
    if (!stroke) return;
    const p = toDevice(xCss, yCss);
    stroke.raw.push({ x: p.x, y: p.y, t });
    stroke.resampler.push(p.x, p.y, t);
    scheduleTick();
  }

  const LOOKBEHIND = 2;

  // Resample + frame the raw path so far, no drawing. Shared by the live per-tick draw and by
  // endStroke (which only needs the frames). Uses the incremental resampler.
  function settleStrokeFrames() {
    const resampled = stroke.resampler.settle();
    if (resampled.length < 2) return null;
    const frames = computeFrames(resampled, SP.spacing);
    stroke.frames = frames;
    return frames;
  }

  // Returns true if activeDisplay's pixels changed this tick, so tick() can skip recompositing when
  // a held-still stroke drew nothing.
  function processStroke() {
    let dirty = false;
    const params = SP;

    const frames = settleStrokeFrames();
    if (!frames) return dirty;
    const streakDefs = stroke.streakDefs || (stroke.streakDefs = buildStreakDefs(stroke.seed, params));
    const upTo = Math.max(stroke.drawnCount, frames.length - LOOKBEHIND);
    if (upTo <= stroke.drawnCount) return dirty;

    // stroke.seed here must match what strokeMarks passes at bake time (strokeFrameCommands'
    // splatterKey), or splatter would jump when the baked mark replaces the preview.
    let cmds = strokeFrameCommands(frames, stroke.drawnCount, upTo, streakDefs, params, stroke.seed);
    if (cmds.length > params.dabCapPerCall) {
      // Per-tick dab budget: sheen and body/cap always pass; the decorative tiers are shed in
      // priority order under pressure, keeping each tier's arc-length draw order.
      const buckets = { body: [], cap: [], streak: [], droplet: [], entryFray: [], speckle: [] };
      const sheenCmds = [];
      for (const c of cmds) {
        if (c.type === 'sheenLine') sheenCmds.push(c);
        else buckets[c.tier].push(c);
      }
      const kept = buckets.body.concat(buckets.cap);
      let budget = params.dabCapPerCall - kept.length;
      for (const tier of BUDGETED_TIERS) {
        if (budget <= 0) break;
        const take = buckets[tier].slice(0, budget);
        kept.push(...take);
        budget -= take.length;
      }
      cmds = sheenCmds.concat(kept);
    }
    stroke.drawnCount = upTo;

    if (!stroke.entryDrawn && frames[upTo - 1] && frames[upTo - 1].arcLen >= params.entryLen) {
      cmds = strokeEntryFrayCommands(frames, params, stroke.seed).concat(cmds);
      stroke.entryDrawn = true;
    }

    if (cmds.length) {
      const rgb = hexToRgb(stroke.color);
      drawStrokeCommands(activeDisplayCtx, cmds, rgb, spritePool);
      dirty = true;
    }
    return dirty;
  }

  const TAP_MAX_SPAN = 9 * dpr; // device px — touch jitters a few px even on a "tap"
  const TAP_SPLAT_CSS = 16; // CSS px splat size for a tap
  const DASH_MAX_SPAN = SP.dashMaxSpan;

  function endStroke(t) {
    if (!stroke) return;
    const raw = stroke.raw;
    const bounds = computeBounds(raw);
    const span = bounds.span;
    if (span < TAP_MAX_SPAN) {
      // never really dragged → a tap
      const s = stroke;
      stroke = null;
      activeDisplayCtx.clearRect(0, 0, W, H);
      splatDevice((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, { size: TAP_SPLAT_CSS * dpr * markScale, color: s.color, seed: s.seed });
      requestRender();
      return;
    }
    // A drag — one kind only; a short one is just the same stroke with a heavier opening splatter
    // (dashMarks). 'dash' survives as a recipe kind older stored recipes may carry.
    const kind = 'stroke';
    const s = stroke;
    const frames = settleStrokeFrames();
    stroke = null;
    if (!frames) {
      // resampled to under 2 points (can happen right at TAP_MAX_SPAN) → splat rather than drop it
      activeDisplayCtx.clearRect(0, 0, W, H);
      if (span < DASH_MAX_SPAN) splatDevice((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, { size: TAP_SPLAT_CSS * dpr * markScale, color: s.color, seed: s.seed });
      requestRender();
      return;
    }
    const centerline = new Float32Array(frames.length * 3);
    for (let i = 0; i < frames.length; i++) {
      centerline[i * 3] = frames[i].x;
      centerline[i * 3 + 1] = frames[i].y;
      centerline[i * 3 + 2] = frames[i].emaSpeed;
    }
    const recipe = { kind, seed: s.seed, color: s.color, centerline };
    // Command generation is cheap; the DRAWING of those commands (thousands of stamps on a long
    // stroke) is not, and doing it synchronously here would block the next pointerdown. So push the
    // recipe now (budget accounting) and hand the drawing to pendingBakes, stepped from tick().
    const built = buildMarkCommands(recipe);
    recipe.area = built ? built.cw * built.ch : 0;
    pushRecipe(recipe, recipe.area);
    if (built) {
      if (pendingBakes.length >= PENDING_BAKE_MAX) {
        // backpressure: finish the oldest synchronously rather than grow the queue unbounded
        const oldest = pendingBakes.shift();
        stepMarkBakeJob(oldest, Infinity);
        finishPendingJob(oldest);
      }
      const job = makeMarkBakeJob(built, hexToRgb(s.color));
      job.recipe = recipe;
      // The live preview stands in for the mark until the job lands in bakedCtx. It moves to a
      // canvas of its own, cropped to the mark, so the next stroke starts on a clean activeDisplay
      // without wiping it: a stroke begun before the last one finished baking would otherwise make
      // that one blink back to its half-baked pixels.
      job.standIn = makeCanvas(job.cw, job.ch);
      job.standIn.getContext('2d').drawImage(activeDisplay, job.rect.minX, job.rect.minY, job.cw, job.ch, 0, 0, job.cw, job.ch);
      activeDisplayCtx.clearRect(0, 0, W, H);
      pendingBakes.push(job);
    } else {
      activeDisplayCtx.clearRect(0, 0, W, H);
    }
    requestRender();
  }

  // ---- splat ----

  function splatDevice(x, y, o) {
    o = o || {};
    const size = o.size !== undefined ? o.size : (18 + rngGlobal() * 34) * dpr * markScale;
    const color = o.color || pickColor();
    const seedV = o.seed !== undefined ? o.seed : Math.floor(rngGlobal() * 1e9);
    const specs = splatDabSpecs(seedV, size);
    const b = commandBounds(specs, x, y, 10);
    if (!b) return;
    const cw = Math.ceil(b.maxX - b.minX), ch = Math.ceil(b.maxY - b.minY);
    const tctx = getMarkCanvas(cw, ch);
    drawSplatCommands(tctx, specs, x - b.minX, y - b.minY, hexToRgb(color), spritePool);
    const rect = { minX: 0, minY: 0, maxX: cw, maxY: ch };
    castShadow(tctx.canvas, rect, translatedTarget(bakedCtx, b.minX, b.minY));
    bakedCtx.drawImage(tctx.canvas, 0, 0, cw, ch, b.minX, b.minY, cw, ch);
    const area = cw * ch;
    pushRecipe({ kind: 'splat', seed: seedV, color, size, x, y, area }, area);
    requestRender();
  }

  function splat(xCss, yCss, o) {
    o = o || {};
    const p = toDevice(xCss, yCss);
    const opts = Object.assign({}, o);
    if (opts.size != null) opts.size = opts.size * dpr;
    splatDevice(p.x, p.y, opts);
  }

  // ---- bounded history / performance governance ----

  function pushRecipe(recipe, area) {
    recipes.push(recipe);
    totalArea += area;
    if (recipes.length > BUDGET.maxMarks || totalArea > BUDGET.maxInkArea) {
      const targetMarks = Math.floor(BUDGET.maxMarks * 0.85);
      const targetArea = BUDGET.maxInkArea * 0.85;
      while (recipes.length > targetMarks || totalArea > targetArea) {
        const dropped = recipes.shift();
        totalArea -= dropped.area;
      }
      rebuildBaked(false);
    }
  }

  let rebuildQueue = null;
  function rebuildBaked(immediate) {
    const target = makeCanvas(W, H);
    const tctx = target.getContext('2d');
    if (immediate) {
      for (const r of recipes) renderMarkToCanvas(r, tctx);
      baked.width = W; baked.height = H;
      bakedCtx.clearRect(0, 0, W, H);
      bakedCtx.drawImage(target, 0, 0);
      return;
    }
    rebuildQueue = { items: recipes.slice(), i: 0, job: null, target, tctx };
    scheduleTick();
  }

  // Time-sliced across ticks, bounded at the command level (q.job) not just the recipe level, so a
  // single huge recipe can't blow through deadlineMs.
  function stepRebuild(deadlineMs) {
    if (!rebuildQueue) return;
    const q = rebuildQueue;
    const start = performance.now();
    while (performance.now() - start < deadlineMs) {
      if (!q.job) {
        if (q.i >= q.items.length) break;
        const r = q.items[q.i];
        if (r.kind === 'splat') {
          renderMarkToCanvas(r, q.tctx); // small/bounded -- fine synchronously
          q.i++;
          continue;
        }
        const built = buildMarkCommands(r);
        if (!built) { q.i++; continue; }
        q.job = makeMarkBakeJob(built, hexToRgb(r.color));
      }
      const remaining = deadlineMs - (performance.now() - start);
      if (stepMarkBakeJob(q.job, remaining)) {
        finishMarkBakeJob(q.job, q.tctx);
        q.job = null;
        q.i++;
      } else {
        break; // ran out of time this frame -- resume the same job next tick
      }
    }
    if (q.i >= q.items.length && !q.job) {
      fade = { to: q.target, progress: 0 };
      rebuildQueue = null;
    }
  }

  function setBudget(b) { Object.assign(BUDGET, b); }

  // Blits already-rendered pixels into the baked layer at (dx, dy) CSS px. The pixels have no recipe
  // behind them, so anything that replays `recipes` (a cull, or resize()) wipes them — safe only for
  // a caller that has the mark budget off and drives resize() itself.
  function adoptPixels(img, dxCss, dyCss) {
    bakedCtx.drawImage(img, Math.round(dxCss * dpr), Math.round(dyCss * dpr));
    requestRender();
  }
  function clear() {
    recipes = []; totalArea = 0;
    // cancel in-flight async work, or it could repopulate the just-cleared canvas
    pendingBakes = []; rebuildQueue = null; fade = null;
    bakedCtx.clearRect(0, 0, W, H);
    activeDisplayCtx.clearRect(0, 0, W, H);
    requestRender();
  }

  // Takes back the most recent finished mark (stroke or splat): drops its recipe and replays the
  // rest, with the same synchronous rebuild resize() does. Returns false when there's nothing to take
  // back. Like any replay it can't bring back what has no recipe: marks the budget already culled,
  // or pixels handed over with adoptPixels. A stroke still in progress is left alone.
  function undo() {
    if (!recipes.length) return false;
    const dropped = recipes.pop();
    totalArea -= dropped.area;
    // cancel in-flight async work first, as resize() does: a pending bake for a mark that stays
    // would otherwise land a second time on top of the rebuild below
    pendingBakes = []; rebuildQueue = null; fade = null;
    rebuildBaked(true);
    requestRender();
    return true;
  }

  // Does now everything the engine would otherwise spread over the next frames -- marks still
  // baking, a rebuild after a budget cull -- and composites, so the canvas is final (before a
  // canvas.toBlob(), say). The same draws in the same order as the time-sliced path, so the same
  // pixels. A stroke still in progress stays in progress.
  function flush() {
    while (pendingBakes.length) {
      const job = pendingBakes.shift();
      stepMarkBakeJob(job, Infinity);
      finishPendingJob(job);
    }
    if (rebuildQueue) stepRebuild(Infinity);
    if (fade) {
      bakedCtx.clearRect(0, 0, W, H);
      bakedCtx.drawImage(fade.to, 0, 0);
      fade = null;
    }
    renderComposite();
  }

  // ---- shared replay path (recipe -> pixels), used by bake, rebuild, and resize ----

  // Returns the drawn rect's area (device px²), or 0 if the recipe drew nothing.
  function renderMarkToCanvas(recipe, targetCtx) {
    if (recipe.kind === 'splat') {
      const specs = splatDabSpecs(recipe.seed, recipe.size);
      const b = commandBounds(specs, recipe.x, recipe.y, 10);
      if (!b) return 0;
      const cw = Math.ceil(b.maxX - b.minX), ch = Math.ceil(b.maxY - b.minY);
      const tctx = getMarkCanvas(cw, ch);
      drawSplatCommands(tctx, specs, recipe.x - b.minX, recipe.y - b.minY, hexToRgb(recipe.color), spritePool);
      castShadow(tctx.canvas, { minX: 0, minY: 0, maxX: cw, maxY: ch }, translatedTarget(targetCtx, b.minX, b.minY));
      targetCtx.drawImage(tctx.canvas, 0, 0, cw, ch, b.minX, b.minY, cw, ch);
      return cw * ch;
    } else if (recipe.kind === 'stroke' || recipe.kind === 'dash') {
      // Full bake in one call, for callers that need the result immediately (resize()). Pixel-
      // identical to the time-sliced path (endStroke / stepRebuild).
      const built = buildMarkCommands(recipe);
      if (!built) return 0;
      const job = makeMarkBakeJob(built, hexToRgb(recipe.color));
      stepMarkBakeJob(job, Infinity); // never breaks early
      finishMarkBakeJob(job, targetCtx);
      return job.cw * job.ch;
    }
    return 0;
  }

  // Command generation for a 'stroke'|'dash' recipe: rebuilds frames from the stored centerline
  // (tangent/normal/arcLen depend only on position, so this is pixel-identical to live frames) and
  // returns the uncapped command list plus clipped bounds. Pure/cheap — no canvas calls.
  function buildMarkCommands(recipe) {
    const n = recipe.centerline.length / 3;
    if (n < 2) return null;
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: recipe.centerline[i * 3], y: recipe.centerline[i * 3 + 1], t: 0 });
    const frames = computeFrames(pts, SP.spacing);
    for (let i = 0; i < n; i++) frames[i].emaSpeed = recipe.centerline[i * 3 + 2];
    // Replay with the dpr-scaled SP, not bare STROKE_DEFAULTS: `frames` are device px, so CSS-px
    // params would mismatch units and reintroduce gappy strokes on every rebuild. Every drag goes
    // through dashMarks (body + the two end bursts).
    const cmds = dashMarks(frames, SP, recipe.seed);
    const b = commandBounds(cmds, 0, 0, 8);
    if (!b) return null;
    const clipped = clipRect(b, W, H) || b;
    const cw = Math.ceil(clipped.maxX - clipped.minX), ch = Math.ceil(clipped.maxY - clipped.minY);
    if (cw <= 0 || ch <= 0) return null;
    return { cmds, rect: clipped, cw, ch };
  }

  // A job's own temp canvas (not the pooled getMarkCanvas) — it must survive across frames without
  // being clobbered by other pooled use. Same MARGIN, for castShadow's blur reach.
  function makeMarkBakeJob(built, rgb) {
    const { cmds, rect, cw, ch } = built;
    const tmp = makeCanvas(cw + MARK_CANVAS_MARGIN, ch + MARK_CANVAS_MARGIN);
    const tctx = tmp.getContext('2d');
    tctx.translate(-rect.minX, -rect.minY);
    return { cmds, i: 0, tctx, tmp, rgb, rect, cw, ch };
  }

  // Draws job.cmds in MARK_BAKE_CHUNK batches, checking the deadline between batches. Returns
  // whether the job is fully drawn; deadlineMs=Infinity finishes it in one call.
  function stepMarkBakeJob(job, deadlineMs) {
    const start = performance.now();
    while (job.i < job.cmds.length) {
      const end = Math.min(job.cmds.length, job.i + MARK_BAKE_CHUNK);
      drawStrokeCommands(job.tctx, job.cmds.slice(job.i, end), job.rgb, spritePool);
      job.i = end;
      if (job.i < job.cmds.length && performance.now() - start >= deadlineMs) return false;
    }
    return true;
  }

  // Casts the shadow once over the job's full bounds (see castShadow's invariant), then blits into
  // targetCtx. Call only once the job is fully drawn.
  function finishMarkBakeJob(job, targetCtx) {
    job.tctx.setTransform(1, 0, 0, 1, 0, 0);
    castShadow(job.tmp, { minX: 0, minY: 0, maxX: job.cw, maxY: job.ch }, translatedTarget(targetCtx, job.rect.minX, job.rect.minY));
    targetCtx.drawImage(job.tmp, 0, 0, job.cw, job.ch, job.rect.minX, job.rect.minY, job.cw, job.ch);
  }

  function translatedTarget(targetCtx, dx, dy) {
    return {
      save: () => targetCtx.save(),
      restore: () => targetCtx.restore(),
      set filter(v) { targetCtx.filter = v; },
      set globalAlpha(v) { targetCtx.globalAlpha = v; },
      drawImage: function () {
        const args = arguments;
        if (args.length === 9) {
          targetCtx.drawImage(args[0], args[1], args[2], args[3], args[4], args[5] + dx, args[6] + dy, args[7], args[8]);
        } else {
          targetCtx.drawImage(args[0], args[1] + dx, args[2] + dy);
        }
      },
    };
  }

  function clipRect(b, w, h) {
    const minX = Math.max(0, Math.floor(b.minX)), minY = Math.max(0, Math.floor(b.minY));
    const maxX = Math.min(w, Math.ceil(b.maxX)), maxY = Math.min(h, Math.ceil(b.maxY));
    if (maxX <= minX || maxY <= minY) return null;
    return { minX, minY, maxX, maxY };
  }

  // ---- render loop ----

  let needsRender = true;
  function requestRender() { needsRender = true; scheduleTick(); }
  function scheduleTick() { if (!rafScheduled) { rafScheduled = true; requestAnimationFrame(tick); } }

  // Steps the front of pendingBakes until empty or out of time; resumes it next tick otherwise.
  function stepPendingBakes(deadlineMs) {
    const start = performance.now();
    while (pendingBakes.length) {
      const remaining = deadlineMs - (performance.now() - start);
      if (remaining <= 0) break;
      const job = pendingBakes[0];
      if (stepMarkBakeJob(job, remaining)) {
        finishPendingJob(job);
        pendingBakes.shift();
      } else {
        break;
      }
    }
  }

  // The job's recipe was pushed in endStroke; by the time its drawing finishes a budget cull could
  // have removed it, so skip the blit if it's gone from `recipes`. If still present, blitting into
  // bakedCtx is safe even alongside a concurrent rebuild/fade (fade replaces bakedCtx wholesale).
  function finishPendingJob(job) {
    // both branches below change the screen, and tick() checks pendingBakes.length AFTER stepping
    // (0 on the tick the last job lands), so force a render or the final mark stays invisible until
    // the next unrelated event
    needsRender = true;
    // This job's pixels are landing in bakedCtx now (or were culled) either way, so its preview no
    // longer needs to stand in for it -- dropped before the early-return below so a culled job
    // doesn't leave a stand-in showing a mark that's actually gone.
    job.standIn = null;
    if (job.recipe && recipes.indexOf(job.recipe) === -1) return;
    finishMarkBakeJob(job, bakedCtx);
  }

  function tick() {
    rafScheduled = false;
    let strokeDirty = false;
    if (stroke) strokeDirty = processStroke();

    // Background-bake budget, shared between pendingBakes (first — a just-finished stroke waits on
    // it) and rebuildQueue. Smaller while a stroke is drawing so the drag stays responsive.
    const bakeStart = performance.now();
    const bakeBudgetMs = stroke ? 3 : 8;
    stepPendingBakes(bakeBudgetMs);
    if (rebuildQueue) stepRebuild(Math.max(1, bakeBudgetMs - (performance.now() - bakeStart)));

    if (fade) {
      fade.progress += 0.06;
      if (fade.progress >= 1) {
        bakedCtx.clearRect(0, 0, W, H);
        bakedCtx.drawImage(fade.to, 0, 0);
        fade = null;
      }
      needsRender = true;
    }
    // recomposite only when something actually changed (strokeDirty, not merely "a stroke is active")
    if (needsRender || strokeDirty || fade || rebuildQueue || pendingBakes.length) {
      renderComposite();
      needsRender = false;
    }
    if (stroke || fade || rebuildQueue || pendingBakes.length) scheduleTick();
  }

  function renderComposite() {
    // opaque paper is a full-canvas fill, so no clearRect needed; under paper:false the clear is
    // what stops the previous frame accumulating.
    if (opaquePaper) ctx.drawImage(paper, 0, 0);
    else ctx.clearRect(0, 0, W, H);
    ctx.drawImage(baked, 0, 0);
    if (fade) {
      ctx.save();
      ctx.globalAlpha = fade.progress;
      ctx.drawImage(fade.to, 0, 0);
      ctx.restore();
    }
    // ended marks still baking in the background, shown so they don't vanish for a few frames: what
    // is baked so far, then the live preview each ended with, as a stand-in until its job lands
    for (const job of pendingBakes) {
      ctx.drawImage(job.tmp, 0, 0, job.cw, job.ch, job.rect.minX, job.rect.minY, job.cw, job.ch);
    }
    for (const job of pendingBakes) {
      if (job.standIn) ctx.drawImage(job.standIn, job.rect.minX, job.rect.minY);
    }
    // the live preview
    if (stroke) ctx.drawImage(activeDisplay, 0, 0);
  }

  return {
    beginStroke, extendStroke, endStroke, splat, resize, clear, undo, flush, setBudget, adoptPixels,
    get markCount() { return recipes.length; },
    // true between beginStroke and endStroke: the engine draws one stroke at a time
    get drawing() { return stroke !== null; },
  };
}

// ============================================================================
// 8. HELPERS — mount, paintStroke, paintPage. Built only on the engine's public
//    API above; nothing in sections 1-7 depends on them.
// ============================================================================

// The engine draws one stroke at a time. Per engine: the animated paintStroke still running (so the
// next stroke, the user's or code's, can finish it first) and whether a user's stroke is open in
// mount()/paintPage() (so a paintStroke waits for the finger to lift instead of cutting it short).
const strokeSlots = new WeakMap();
function slotOf(engine) {
  let s = strokeSlots.get(engine);
  if (!s) { s = { anim: null, user: false, waiters: [] }; strokeSlots.set(engine, s); }
  return s;
}
function settleAnimation(engine) {
  const s = strokeSlots.get(engine);
  if (s && s.anim) s.anim.finish();
}
function userStrokeBegan(engine) {
  settleAnimation(engine);
  slotOf(engine).user = true;
}
function userStrokeEnded(engine) {
  const s = slotOf(engine);
  s.user = false;
  const waiting = s.waiters;
  s.waiters = [];
  for (const go of waiting) go();
}

/**
 * The path as a pointer would report it: one sample per 1/120 s, walked at `speed` (easing in from
 * 55% of it, the way a hand starts), then changing to `endSpeed` through the last stretch. A flick
 * speeds up to well past the flick threshold (a release above ~1255 CSS px/s is a full flick; see
 * flickHiGain).
 */
function strokeSamples(path, o) {
  const speed = o.speed > 0 ? +o.speed : 500;
  const endSpeed = o.flick ? Math.max(1500, speed * 2) : o.endSpeed > 0 ? +o.endSpeed : speed;
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const len = cum[cum.length - 1];
  const out = [{ x: path[0].x, y: path[0].y, t: 0 }];
  if (!(len > 0)) return out; // one point: the engine reads it as a tap
  const dt = 1000 / 120;
  let d = 0, seg = 1;
  while (d < len) {
    const u = d / len;
    const v = speed * lerp(0.55, 1, smoothstep(0, 0.2, u)) + (endSpeed - speed) * smoothstep(0.55, 1, u);
    d = Math.min(len, d + v * dt / 1000);
    while (seg < path.length - 1 && cum[seg] < d) seg++;
    const a = path[seg - 1], b = path[seg], span = cum[seg] - cum[seg - 1];
    const k = span > 0 ? (d - cum[seg - 1]) / span : 1;
    out.push({ x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), t: out.length * dt });
  }
  return out;
}

/**
 * Paints one stroke along a path, the way a brush dragged along it would. `points` are [x, y]
 * pairs or {x, y} objects in the engine's CSS px. Speed shapes the mark exactly as a hand's does:
 * slow is wide and wet, fast is narrow and dry, and a fast release throws a tail.
 *
 * options:
 *   speed    CSS px/s along the path (default 500)
 *   endSpeed CSS px/s at the release, reached over the last stretch (default: speed). Below
 *            ~790 the end is a rounded lift, up to ~920 it throws droplets, past that it flicks
 *            a tail (full length by ~1250)
 *   flick    true: shorthand for an endSpeed fast enough for a full tail
 *   color    paint color (default: from the engine's palette)
 *   seed     the stroke's texture (default: random); same points + color + seed = same pixels
 *   animate  true: paint in real time, or a number to play faster (2 = twice as fast; the stroke
 *            itself is unchanged); false (default): all at once
 *
 * Returns a Promise, resolved once the stroke is handed to the engine (its finished pixels land
 * over the next few frames). One stroke at a time per engine: starting one finishes an animated
 * stroke still running, and on an engine from mount() or paintPage() it waits for a finger or
 * mouse that's mid-stroke to lift. On an engine you feed yourself, don't call it with your own
 * stroke open: it would be closed first.
 */
function paintStroke(engine, points, options) {
  const o = options || {};
  const path = [];
  for (const p of points || []) {
    const x = Array.isArray(p) ? p[0] : p && p.x, y = Array.isArray(p) ? p[1] : p && p.y;
    if (isFinite(x) && isFinite(y)) path.push({ x: +x, y: +y });
  }
  if (!path.length) return Promise.resolve();
  const slot = slotOf(engine);
  if (slot.user) {
    return new Promise((resolve) => slot.waiters.push(() => resolve(paintStroke(engine, points, options))));
  }
  settleAnimation(engine);
  if (engine.drawing) engine.endStroke(performance.now());

  const samples = strokeSamples(path, o);
  const last = samples.length - 1;
  const t0 = performance.now();
  engine.beginStroke(samples[0].x, samples[0].y, t0, { color: o.color, seed: o.seed });
  let i = 1;
  const feedUntil = (tEnd) => {
    for (; i <= last && samples[i].t <= tEnd; i++) engine.extendStroke(samples[i].x, samples[i].y, t0 + samples[i].t);
  };
  if (!o.animate) {
    feedUntil(Infinity);
    engine.endStroke(t0 + samples[last].t);
    return Promise.resolve();
  }
  // the playback rate only changes how fast samples are handed over, never their timestamps
  const rate = o.animate === true ? 1 : +o.animate > 0 ? +o.animate : 1;
  return new Promise((resolve) => {
    const anim = {
      finish() {
        if (slot.anim !== anim) return;
        slot.anim = null;
        feedUntil(Infinity);
        engine.endStroke(t0 + samples[last].t);
        resolve();
      },
    };
    slot.anim = anim;
    const frame = () => {
      if (slot.anim !== anim) return;
      feedUntil((performance.now() - t0) * rate);
      if (i > last) anim.finish(); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

/**
 * Makes an element paintable: a canvas filling it, kept at its size, wired to mouse, touch and
 * pen (one stroke at a time). `element` is an element or a selector; a statically positioned one
 * is made position:relative so the canvas can fill it. The canvas goes in as its first child, so
 * positioned content after it stays on top.
 *
 * options: createPaintEngine's (palette, seed, paper, scale, dpr, budget), plus
 *   color   a color, or a function returning one, for each new stroke (default: the palette).
 *           Also a live property on the returned engine: paint.color = '#e5484d'
 *   input   false: no pointer input, for an element painted only from code
 *
 * Returns the engine, with `canvas`, `color` and `destroy()` added.
 */
function mount(element, options) {
  const el = typeof element === 'string' ? document.querySelector(element) : element;
  if (!el || typeof el.appendChild !== 'function') throw new Error('PaintEngine.mount: no element ' + element);
  const o = Object.assign({}, options);
  const input = o.input !== false;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;display:block;' + (input
    ? 'touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;'
    : 'pointer-events:none;');
  el.insertBefore(canvas, el.firstChild);
  const engine = createPaintEngine(Object.assign({}, o, { canvas }));
  engine.canvas = canvas;
  engine.color = o.color || null;

  // clientWidth/Height is the padding box, which is what an absolute canvas at 0,0 fills
  let w = 0, h = 0;
  const fit = () => {
    const nw = el.clientWidth, nh = el.clientHeight;
    if (!(nw > 0 && nh > 0) || (nw === w && nh === h)) return;
    w = nw; h = nh;
    engine.resize(w, h);
  };
  fit();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(el); else window.addEventListener('resize', fit);
  requestAnimationFrame(() => {
    if (!w) console.warn('PaintEngine.mount: the element has no size; give it a width and height');
  });

  let active = null; // pointerId of the stroke in progress
  const styleNow = () => {
    const c = typeof engine.color === 'function' ? engine.color() : engine.color;
    return c ? { color: c } : undefined;
  };
  const down = (e) => {
    if (active !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    active = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* capture is a nicety */ }
    userStrokeBegan(engine);
    const r = canvas.getBoundingClientRect();
    engine.beginStroke(e.clientX - r.left, e.clientY - r.top, e.timeStamp, styleNow());
    e.preventDefault();
  };
  const move = (e) => {
    if (e.pointerId !== active) return;
    const r = canvas.getBoundingClientRect();
    const list = typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e];
    for (const ev of list) engine.extendStroke(ev.clientX - r.left, ev.clientY - r.top, ev.timeStamp);
    e.preventDefault();
  };
  const up = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    engine.endStroke(e.timeStamp);
    userStrokeEnded(engine);
  };
  const menu = (e) => e.preventDefault();
  if (input) {
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('contextmenu', menu);
  }

  engine.destroy = () => {
    if (active !== null) { active = null; engine.endStroke(performance.now()); userStrokeEnded(engine); }
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', up);
    canvas.removeEventListener('contextmenu', menu);
    if (ro) ro.disconnect(); else window.removeEventListener('resize', fit);
    engine.clear();
    canvas.remove();
  };
  return engine;
}

/**
 * Lets visitors paint on the whole page: every drag leaves a stroke, every tap a splatter, and the
 * paint stays where it landed on the document as the page scrolls. This is the adapter the
 * Creative Besties Club MTL site runs, without that site's own parts (its nav bar and photos).
 *
 * options: createPaintEngine's palette / seed / scale, plus
 *   area        an element (or selector) to paint instead of the whole page, e.g. just the hero:
 *               gestures start a mark only inside it, the paint is clipped to it, and the rest
 *               of the page stays clean. It becomes position:relative (if static) and
 *               isolation:isolate, so an 'under' layer lies on its own background, under its content
 *   layer       'under' (default): beneath the page's content, so text stays on top and the paint
 *               reads as a stain on the page. It only shows where the page's own background
 *               does: a block that paints a solid background of its own covers it (README, "Paint
 *               under your content"). 'over': above everything, blended, so it works on any page
 *               with no CSS changes.
 *   opacity     of the paint layer (default 0.4 under, 0.6 over)
 *   blend       its mix-blend-mode (default: none under, 'multiply' over)
 *   zIndex      its z-index (default -1 under, 2147483000 over)
 *   ignore      selector of elements a gesture can't start a mark on
 *               (default: form fields, [contenteditable] and [data-paint-engine-ignore])
 *   mouse/touch false turns that input off (both on by default)
 *   selectText  true lets a mouse drag select text as well as paint (default false)
 *   dpr         raster resolution (default: from the device, lower on weak hardware)
 *
 * Returns { engine, layer, splat(pageX, pageY, opts), stroke(points, opts), clear(), destroy() }.
 * splat() and stroke() paint from code, in page coordinates (CSS px from the document's top-left);
 * stroke() takes paintStroke's options and returns its Promise.
 *
 * How it works, for anyone adapting it:
 * - Touch events, not pointer events, so a finger can paint and scroll at once: a browser cancels
 *   the pointer the moment a drag turns into a scroll, but keeps firing touchmove through it.
 *   Points are in page space, so a scroll-drag (the page moving under a still finger) resolves to
 *   a tap, while a drag that doesn't scroll the page spreads into a full stroke.
 * - The canvas is a tile -- the viewport plus a screen of slack each way -- not a document-sized
 *   sheet: at dpr 2 a long page times the engine's internal canvases is hundreds of MB, past iOS
 *   Safari's canvas limits. It re-anchors when a gesture starts outside it or the reader scrolls
 *   past it; pixels leaving it are kept in an archive of fixed-height bands and come back when the
 *   reader scrolls back.
 */
function paintPage(options) {
  if (!document.body) throw new Error('PaintEngine.paintPage: call it once <body> exists (from a script at the end of the page, or on DOMContentLoaded)');
  const o = Object.assign({}, options);
  const over = o.layer === 'over';
  const IGNORE = o.ignore || 'input, textarea, select, [contenteditable], [data-paint-engine-ignore]';
  // One element instead of the whole page. The layer goes inside it, so the paint is clipped to it,
  // and the element becomes a stacking context of its own (isolation), which puts an 'under' layer
  // above the element's own background but below its content, and keeps an 'over' layer's z-index
  // from reaching anything outside it.
  const area = o.area == null ? null : typeof o.area === 'string' ? document.querySelector(o.area) : o.area;
  if (o.area != null && !(area && typeof area.appendChild === 'function')) throw new Error('PaintEngine.paintPage: no element ' + o.area);
  let restoreArea = null;
  if (area) {
    const before = { position: area.style.position, isolation: area.style.isolation };
    if (getComputedStyle(area).position === 'static') area.style.position = 'relative';
    area.style.isolation = 'isolate';
    restoreArea = () => { area.style.position = before.position; area.style.isolation = before.isolation; };
  }

  // One capability read at setup, scored (no single signal is trustworthy): deviceMemory is skipped
  // where absent (Safari) rather than penalised; hardwareConcurrency under-reports on iOS, so the
  // score starts mid and moves both ways; backing-store area (screen px x dpr^2) is the real cost of
  // a canvas this size mid-scroll. The bottom tier drops the raster dpr to 1. The mark budget isn't
  // tiered; it's off (see createPaintEngine below).
  const QUALITY = (() => {
    const cores = navigator.hardwareConcurrency || 2;
    const mem = navigator.deviceMemory;
    const dpr = window.devicePixelRatio || 1;
    const area = (screen.width * screen.height * dpr * dpr) / 1e6;
    let score = 2;
    if (cores >= 8) score += 2; else if (cores >= 6) score += 1; else if (cores <= 2) score -= 2;
    if (mem !== undefined) { if (mem >= 8) score += 2; else if (mem >= 4) score += 1; else score -= 2; }
    if (area > 4) score -= 1;
    if (area > 7) score -= 1;
    const tier = score >= 5 ? 2 : score >= 2 ? 1 : 0;
    return { tier, dpr: o.dpr > 0 ? o.dpr : tier === 0 ? 1 : dpr };
  })();

  // The layer spans the document (its height is set at every anchor, see measure()), or fills the
  // area; the canvas sits inside it at a document-space offset, so drawn paint rides native
  // scrolling with nothing read per frame. overflow:hidden keeps a tile from ever growing the page.
  const layer = document.createElement('div');
  layer.className = 'paint-engine-layer';
  layer.setAttribute('aria-hidden', 'true');
  const ls = layer.style;
  ls.position = 'absolute'; ls.left = '0'; ls.top = '0'; ls.width = '100%'; ls.height = area ? '100%' : '0';
  ls.overflow = 'hidden'; ls.pointerEvents = 'none';
  ls.zIndex = String(o.zIndex != null ? o.zIndex : over ? 2147483000 : -1);
  ls.opacity = String(o.opacity != null ? o.opacity : over ? 0.6 : 0.4);
  const blend = o.blend || (over ? 'multiply' : '');
  if (blend) ls.mixBlendMode = blend;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;';
  layer.appendChild(canvas);
  (area || document.body).appendChild(layer);

  // An 'under' layer on the whole page lies on the page's canvas background, which is <body>'s,
  // passed up to the root. Give <html> a background of its own, as dark-mode extensions (Dark
  // Reader and the like) do, and <body>'s becomes an ordinary block painted over the layer,
  // hiding every mark. Isolating <body> then puts the layer back between that background and the
  // content. Such styles often arrive after this setup, even after the first paint (Dark Reader waits
  // on its background worker), so it's re-checked whenever the page's styles change, at every
  // gesture and at every anchor.
  let restoreBody = null;
  const paintsBackground = (el) => {
    const cs = getComputedStyle(el);
    return cs.backgroundImage !== 'none' || !/^transparent$|,\s*0\)$|\/\s*0\)$/.test(cs.backgroundColor);
  };
  const keepUnderVisible = () => {
    if (area || over || restoreBody) return;
    if (!paintsBackground(document.documentElement) || !paintsBackground(document.body)) return;
    const before = document.body.style.isolation;
    document.body.style.isolation = 'isolate';
    restoreBody = () => { document.body.style.isolation = before; };
  };
  keepUnderVisible();
  // "the page's styles change": <style>/<link> elements arriving in <head> or <html> (an extension's),
  // or a class or style on <html> or <body> (a site's own theme switch). Watched until it isolates.
  let styleWatch = null;
  if (!area && !over && !restoreBody && typeof MutationObserver === 'function') {
    styleWatch = new MutationObserver(() => {
      keepUnderVisible();
      if (restoreBody && styleWatch) { styleWatch.disconnect(); styleWatch = null; }
    });
    const attrs = { attributes: true, attributeFilter: ['class', 'style'] };
    styleWatch.observe(document.documentElement, Object.assign({ childList: true }, attrs));
    if (document.head) styleWatch.observe(document.head, { childList: true });
    styleWatch.observe(document.body, attrs);
  }

  // paper:false keeps untouched pixels transparent, so the page shows through. Budget off, so paint
  // stays put rather than fading as more is laid down -- affordable because finished marks live in
  // a fixed-size tile and the engine's recipe list is cleared on every re-anchor.
  const engine = createPaintEngine({
    canvas, palette: o.palette, seed: o.seed, scale: o.scale, paper: false, dpr: QUALITY.dpr,
    budget: { maxMarks: Infinity, maxInkArea: Infinity },
  });

  // ── the tile ──
  const SLACK_SCREENS = 1;
  let tileTop = 0, tileH = 0, tileW = 0;
  let layerX = 0, layerY = 0; // the layer's origin, in page space
  // Two separate facts: `anchored` = the cached geometry above is current (a viewport change clears
  // it, so the next gesture re-measures); `painted` = the canvas has a backing store worth
  // archiving before a move (only clear() invalidates it). Keeping them apart is what stops paint
  // vanishing on a resize that didn't actually move the tile.
  let anchored = false, painted = false;

  // ── the archive ──
  // A sparse grid of fixed BAND_CSS-tall canvases, one per band and only for bands paint has
  // reached (`inked`). A move flushes the tile into the bands it overlaps and reads the new tile's
  // bands back in. Pixels, not a replayable mark list: a mark straddling the carry boundary would
  // otherwise be drawn twice, and acrylic doubles visibly. Capped at ARCHIVE_PX device px,
  // LRU-evicted (trimBands), tiered like the raster resolution.
  const BAND_CSS = 600;
  const ARCHIVE_PX = QUALITY.tier === 0 ? 4e6 : QUALITY.tier === 1 ? 9e6 : 14e6;
  const bands = new Map(); // band index -> { c, ctx, seq }
  const inked = new Set(); // band indices some mark has landed in
  let bandSeq = 0;
  const bandOf = (yCss) => Math.floor(yCss / BAND_CSS);
  // Generous: a mark's splatter/droplets/shadow reach well past its path, and an un-flushed band
  // loses that overspill for good.
  const INK_PAD = 220 * Math.max(1, o.scale > 0 ? o.scale : 1);
  const inkBands = (pyLo, pyHi) => {
    const lo = bandOf(Math.max(0, pyLo - layerY - INK_PAD));
    const hi = bandOf(Math.max(0, pyHi - layerY + INK_PAD));
    for (let i = lo; i <= hi; i++) inked.add(i);
  };

  // A band's HEIGHT (BAND_CSS x raster ratio) never changes, so bands stack cleanly. Its WIDTH
  // follows the tile's; a band caught on the wrong side of a reflow is re-cut, pixels kept.
  const touchBand = (i, create) => {
    let b = bands.get(i);
    if (b && create && b.c.width !== canvas.width) {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = b.c.height;
      const cx = c.getContext('2d');
      cx.drawImage(b.c, 0, 0);
      b = { c, ctx: cx, seq: b.seq };
      bands.set(i, b);
    }
    if (!b && create) {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = Math.max(1, Math.round(BAND_CSS * (canvas.width / tileW)));
      b = { c, ctx: c.getContext('2d') };
      bands.set(i, b);
    }
    if (b) b.seq = ++bandSeq;
    return b || null;
  };

  // LRU eviction, never a band the tile is currently over
  const trimBands = () => {
    const keep = new Set();
    for (let i = bandOf(tileTop); i <= bandOf(tileTop + tileH); i++) keep.add(i);
    let used = 0;
    for (const [i, b] of [...bands.entries()].sort((a, b2) => b2[1].seq - a[1].seq)) {
      used += b.c.width * b.c.height;
      if (used > ARCHIVE_PX && !keep.has(i)) bands.delete(i);
    }
  };

  // Tile -> archive. clearRect before each drawImage so a band holds exactly what the tile holds
  // for that strip.
  const flushTile = () => {
    if (!painted || !tileH || !canvas.width) return;
    const dp = canvas.width / tileW;
    for (let i = bandOf(tileTop); i <= bandOf(tileTop + tileH - 1); i++) {
      if (!bands.has(i) && !inked.has(i)) continue;
      const yTop = Math.max(tileTop, i * BAND_CSS);
      const yBot = Math.min(tileTop + tileH, (i + 1) * BAND_CSS);
      if (yBot <= yTop) continue;
      const band = touchBand(i, true);
      const sy = Math.round((yTop - tileTop) * dp);
      const dy = Math.round((yTop - i * BAND_CSS) * dp);
      const hh = Math.min(Math.round((yBot - yTop) * dp), band.c.height - dy, canvas.height - sy);
      if (hh <= 0) continue;
      band.ctx.clearRect(0, dy, band.c.width, hh);
      band.ctx.drawImage(canvas, 0, sy, canvas.width, hh, 0, dy, canvas.width, hh);
    }
  };

  // Archive -> tile, as one blit through adoptPixels (no recipe, so no reinterpretation).
  const restoreTile = () => {
    if (!bands.size) return null;
    const dp = canvas.width / tileW;
    let carry = null, cctx = null;
    for (let i = bandOf(tileTop); i <= bandOf(tileTop + tileH - 1); i++) {
      const band = bands.get(i);
      if (!band) continue;
      const yTop = Math.max(tileTop, i * BAND_CSS);
      const yBot = Math.min(tileTop + tileH, (i + 1) * BAND_CSS);
      if (yBot <= yTop) continue;
      if (!carry) {
        carry = document.createElement('canvas');
        carry.width = canvas.width; carry.height = canvas.height;
        cctx = carry.getContext('2d');
      }
      touchBand(i);
      const sy = Math.round((yTop - i * BAND_CSS) * dp);
      const dy = Math.round((yTop - tileTop) * dp);
      const hh = Math.min(Math.round((yBot - yTop) * dp), band.c.height - sy, carry.height - dy);
      if (hh <= 0) continue;
      cctx.drawImage(band.c, 0, sy, band.c.width, hh, 0, dy, band.c.width, hh);
    }
    if (carry) engine.adoptPixels(carry, 0, 0);
    return carry;
  };

  // The document's height in the layer's own coordinates, measured with the layer collapsed (it is
  // sized to match, so it mustn't count itself), and the layer sized to it; an area's layer just
  // fills the area. A forced layout, so only on an anchor.
  let layerHeight = 0;
  const measure = () => {
    if (!area) ls.height = '0';
    const r = layer.getBoundingClientRect();
    layerX = r.left + window.scrollX;
    layerY = r.top + window.scrollY;
    if (area) return (layerHeight = Math.max(1, Math.round(r.height)));
    const de = document.documentElement;
    layerHeight = Math.max(1, Math.round(Math.max(de.scrollHeight, document.body.scrollHeight) - layerY));
    ls.height = layerHeight + 'px';
    return layerHeight;
  };

  const anchorTile = () => {
    keepUnderVisible();
    const layerH = measure();
    const vw = layer.clientWidth || window.innerWidth;
    const vh = window.innerHeight;
    const h = Math.min(layerH, Math.round(vh * (1 + SLACK_SCREENS * 2)));
    // centred on the viewport, then clamped so the tile never hangs off either end of the document
    const top = Math.max(0, Math.min(layerH - h, Math.round(window.scrollY - layerY - (h - vh) / 2)));

    // a re-measure that found nothing moved: re-validate, leave the canvas and mark list alone
    if (painted && vw === tileW && h === tileH && top === tileTop) { anchored = true; return; }

    flushTile(); // before anything moves or is cleared

    const resized = vw !== tileW || h !== tileH;
    tileTop = top; tileH = h; tileW = vw;
    canvas.style.top = top + 'px';
    // clear (not resize()): resize() replays the held marks into the new backing store, at page
    // positions they were never painted at; the pixels come back via restoreTile instead.
    engine.clear();
    if (resized) engine.resize(vw, h);
    const carry = restoreTile();
    trimBands();

    // Bring the visible canvas up to date now: the style `top` change lands next frame but the
    // engine composites the frame after, so without this every mark jumps for one frame.
    const shown = canvas.getContext('2d');
    shown.clearRect(0, 0, canvas.width, canvas.height);
    if (carry) shown.drawImage(carry, 0, 0);

    anchored = true; painted = true;
  };

  const tileCovers = () => {
    if (!anchored) return false;
    if (tileTop === 0 && tileH >= layerHeight) return true; // a page shorter than the tile
    const top = layerY + tileTop;
    return window.scrollY >= top && window.scrollY + window.innerHeight <= top + tileH;
  };

  // page space -> tile space (all the engine sees), from the geometry cached at the last anchor
  const tileX = (px) => px - layerX;
  const tileY = (py) => py - layerY - tileTop;

  // ── the one live stroke ── (a user's), and strokes painted from code still animating. Neither
  // may have the coordinate space moved out from under it, so both hold re-anchoring off.
  let live = null; // { id, px, py, y0, y1 }
  let codeStrokes = 0;
  const busy = () => live !== null || codeStrokes > 0;

  const onResize = () => { anchored = false; };

  // Re-anchor on scroll so paint flushed out of the tile comes back when the reader scrolls to it
  // (a mouse wheel dispatches no touch, so nothing else would). Throttled -- the tile carries a
  // screen of slack -- with a trailing call once scrolling stops. Never mid-stroke.
  const REANCHOR_MS = 220;
  let reanchorPending = false, reanchorAt = 0, reanchorTimer = 0;
  const reanchorNow = () => {
    reanchorPending = false;
    if (busy() || tileCovers()) return;
    reanchorAt = performance.now();
    anchorTile();
  };
  const scheduleReanchor = () => {
    if (!painted || reanchorPending) return;
    reanchorPending = true;
    setTimeout(() => requestAnimationFrame(reanchorNow), Math.max(0, REANCHOR_MS - (performance.now() - reanchorAt)));
  };
  const onScroll = () => {
    if (!painted) return;
    clearTimeout(reanchorTimer);
    reanchorTimer = setTimeout(scheduleReanchor, 90);
    if (!tileCovers()) scheduleReanchor();
  };

  const startStroke = (id, clientX, clientY, t) => {
    keepUnderVisible();
    userStrokeBegan(engine); // first: finishes a stroke from code still animating in the old tile
    if (!tileCovers()) anchorTile(); // at most once per gesture
    const px = clientX + window.scrollX, py = clientY + window.scrollY;
    live = { id, px, py, y0: py, y1: py };
    engine.beginStroke(tileX(px), tileY(py), t);
  };
  const moveStroke = (clientX, clientY, t) => {
    const px = clientX + window.scrollX, py = clientY + window.scrollY;
    live.px = px; live.py = py;
    if (py < live.y0) live.y0 = py;
    if (py > live.y1) live.y1 = py;
    engine.extendStroke(tileX(px), tileY(py), t);
  };
  const endStroke = (t) => {
    engine.endStroke(t);
    inkBands(live.y0, live.y1);
    live = null;
    userStrokeEnded(engine);
  };
  // a gesture starts a mark only on the page (or inside the area) and never on an ignored element
  const ignored = (target) => (area && !(target && area.contains(target)))
    || !!(target && target.closest && target.closest(IGNORE));

  // A tap on a touch screen is followed by emulated mouse events; without this, every tap would
  // leave a second splat.
  let lastTouch = -Infinity;
  const touchOf = (e) => {
    if (!live) return null;
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === live.id) return e.changedTouches[i];
    }
    return null;
  };
  const touchStart = (e) => {
    lastTouch = performance.now();
    // first finger down: a missing touchend can't wedge the stroke open
    if (e.touches.length === e.changedTouches.length && live) endStroke(e.timeStamp);
    if (live) return; // one brush, one stroke
    const t = e.changedTouches[0];
    if (ignored(t.target)) return;
    startStroke(t.identifier, t.clientX, t.clientY, e.timeStamp);
  };
  const touchMove = (e) => {
    lastTouch = performance.now();
    const t = touchOf(e);
    if (t) moveStroke(t.clientX, t.clientY, e.timeStamp);
  };
  const touchEnd = (e) => {
    lastTouch = performance.now();
    if (touchOf(e)) endStroke(e.timeStamp);
  };

  const MOUSE_ID = 'mouse';
  const mouseDown = (e) => {
    if (live || e.button !== 0 || performance.now() - lastTouch < 1000 || ignored(e.target)) return;
    // stops text selection and native drag-and-drop, which would freeze mousemove mid-stroke
    if (!o.selectText) e.preventDefault();
    startStroke(MOUSE_ID, e.clientX, e.clientY, e.timeStamp);
  };
  const mouseMove = (e) => { if (live && live.id === MOUSE_ID) moveStroke(e.clientX, e.clientY, e.timeStamp); };
  const mouseUp = (e) => { if (live && live.id === MOUSE_ID) endStroke(e.timeStamp); };
  const blur = () => { if (live && live.id === MOUSE_ID) endStroke(performance.now()); };

  const passive = { passive: true };
  window.addEventListener('resize', onResize, passive);
  window.addEventListener('scroll', onScroll, passive);
  if (o.touch !== false) {
    document.addEventListener('touchstart', touchStart, passive);
    document.addEventListener('touchmove', touchMove, passive);
    document.addEventListener('touchend', touchEnd, passive);
    document.addEventListener('touchcancel', touchEnd, passive);
  }
  if (o.mouse !== false) {
    document.addEventListener('mousedown', mouseDown);
    document.addEventListener('mousemove', mouseMove);
    document.addEventListener('mouseup', mouseUp);
    window.addEventListener('blur', blur);
  }

  // From code, in page coordinates. The tile is anchored on the reader first (unless a stroke is
  // open on it); a mark outside the tile has nowhere to go and is skipped.
  const ready = () => {
    keepUnderVisible();
    if (!busy() && !tileCovers()) anchorTile();
    return painted;
  };
  const splat = (pageX, pageY, opts) => {
    if (!ready()) return;
    const y = tileY(pageY);
    if (y < -INK_PAD || y > tileH + INK_PAD) return;
    engine.splat(tileX(pageX), y, opts);
    inkBands(pageY, pageY);
  };
  const stroke = (points, opts) => {
    if (!ready()) return Promise.resolve();
    const local = [];
    let y0 = Infinity, y1 = -Infinity;
    for (const p of points || []) {
      const x = Array.isArray(p) ? p[0] : p && p.x, y = Array.isArray(p) ? p[1] : p && p.y;
      if (!isFinite(x) || !isFinite(y)) continue;
      local.push([tileX(x), tileY(y)]);
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    if (!local.length) return Promise.resolve();
    inkBands(y0, y1);
    codeStrokes++;
    const done = () => { codeStrokes--; };
    return paintStroke(engine, local, opts).then(done, (err) => { done(); throw err; });
  };

  return {
    engine,
    layer,
    splat,
    stroke,
    clear() {
      engine.clear();
      bands.clear();
      inked.clear();
    },
    destroy() {
      if (live) endStroke(performance.now());
      window.removeEventListener('resize', onResize, passive);
      window.removeEventListener('scroll', onScroll, passive);
      document.removeEventListener('touchstart', touchStart, passive);
      document.removeEventListener('touchmove', touchMove, passive);
      document.removeEventListener('touchend', touchEnd, passive);
      document.removeEventListener('touchcancel', touchEnd, passive);
      document.removeEventListener('mousedown', mouseDown);
      document.removeEventListener('mousemove', mouseMove);
      document.removeEventListener('mouseup', mouseUp);
      window.removeEventListener('blur', blur);
      clearTimeout(reanchorTimer);
      engine.clear();
      layer.remove();
      if (restoreArea) restoreArea();
      if (styleWatch) styleWatch.disconnect();
      if (restoreBody) restoreBody();
    },
  };
}

// ============================================================================
// PUBLIC SURFACE
// ============================================================================

const PaintEngine = {
  version: '1.0.2',
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
};

// A global for <script> tags (and for paint-engine.mjs, which re-exports it); module.exports for
// CommonJS and bundlers. Nothing above touches the DOM until an engine is created, so loading this
// during a server render is safe.
const root = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
root.PaintEngine = PaintEngine;
if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = PaintEngine;

})();
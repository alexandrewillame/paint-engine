/* Landing page: the page itself is wet (paintPage), the hero paints itself once on arrival, and
   the gesture swatches paint their gesture when they scroll into view. */
(function () {
  'use strict';
  if (!window.PaintEngine) return;

  // Points along a cubic Bezier, for strokes painted from code.
  function bezier(p0, p1, p2, p3, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      pts.push([
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
      ]);
    }
    return pts;
  }

  // ── the whole page is wet ──
  // 'under': paint goes beneath the text, so it reads as a stain on the page.
  const page = PaintEngine.paintPage({ layer: 'under', opacity: 0.55 });

  const hint = document.getElementById('hint');
  const firstTouch = () => {
    if (hint) hint.classList.add('done');
    document.removeEventListener('mousedown', firstTouch);
    document.removeEventListener('touchstart', firstTouch);
  };
  document.addEventListener('mousedown', firstTouch);
  document.addEventListener('touchstart', firstTouch, { passive: true });

  // ── the hero paints itself once, so a visitor sees paint before touching anything ──
  const title = document.getElementById('heroTitle');
  async function intro() {
    // the words' own box: the heading itself is as wide as its column
    const range = document.createRange();
    range.selectNodeContents(title);
    const r = range.getBoundingClientRect();
    const x = r.left + window.scrollX, y = r.top + window.scrollY, w = r.width, h = r.height;
    const vw = document.documentElement.clientWidth;
    const narrow = vw < 700;
    // a swash under the title, left to right, flicked off at the end
    await page.stroke(
      bezier([x - 14, y + h * 0.7], [x + w * 0.3, y + h * 0.95], [x + w * 0.65, y + h * 0.4], [x + w * 1.02, y + h * 0.52], 40),
      { speed: narrow ? 520 : 640, flick: true, color: '#F04E23', seed: 21, animate: true },
    );
    if (!narrow) {
      // a teal sweep down the empty right-hand side, clear of the swash's tail
      const rx = Math.min(vw - 140, x + w + 230);
      await page.stroke(
        bezier([rx + 40, y - 30], [rx - 60, y + h * 0.6], [rx + 110, y + h * 1.4], [rx - 10, y + h * 2.3], 40),
        { speed: 560, endSpeed: 380, color: '#17A6B5', seed: 7, animate: true },
      );
      page.splat(rx - 150, y + h * 2.15, { color: '#3B5BA5', seed: 4, size: 26 });
    } else {
      page.splat(x + w * 0.85, y - 18, { color: '#17A6B5', seed: 4, size: 18 });
    }
    page.splat(x + w * 0.1, y - 26, { color: '#F7941E', seed: 12, size: narrow ? 14 : 18 });
  }
  // Once the title is on screen, not on load: a page can load hidden or before its window has a
  // size (a tab opened in the background, a browser pane still opening), with no layout to place
  // the strokes by and nothing to paint them into, or scrolled away from the hero (a reload),
  // where they'd land outside the paint tile and be dropped.
  function start() {
    if (!('IntersectionObserver' in window)) { setTimeout(intro, 350); return; }
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((en) => en.intersectionRatio >= 0.5)) return;
      io.disconnect();
      setTimeout(intro, 350);
    }, { threshold: 0.5 });
    io.observe(title);
  }
  if (title) {
    if (document.readyState === 'complete') start(); else window.addEventListener('load', start);
  }

  // ── gesture swatches ──
  // Each is its own little engine on its own paper, painting one gesture from code. Built when it
  // scrolls into view (an engine builds its brush sprites at creation, so none are made up front).
  const GESTURES = {
    slow: (e, w, h) => PaintEngine.paintStroke(e,
      bezier([w * 0.12, h * 0.66], [w * 0.38, h * 0.1], [w * 0.6, h * 0.95], [w * 0.88, h * 0.36], 40),
      { speed: 240, color: '#3B5BA5', animate: true }),
    fast: (e, w, h) => PaintEngine.paintStroke(e,
      bezier([w * 0.08, h * 0.72], [w * 0.4, h * 0.6], [w * 0.62, h * 0.3], [w * 0.92, h * 0.28], 40),
      { speed: 1250, endSpeed: 520, color: '#F7941E', animate: true }),
    flick: (e, w, h) => PaintEngine.paintStroke(e,
      bezier([w * 0.08, h * 0.78], [w * 0.22, h * 0.4], [w * 0.4, h * 0.42], [w * 0.52, h * 0.36], 30),
      { speed: 520, flick: true, color: '#F04E23', animate: true }),
    tap: async (e, w, h) => {
      await PaintEngine.paintStroke(e, [[w * 0.36, h * 0.5]], { color: '#17A6B5' });
      await wait(260);
      await PaintEngine.paintStroke(e, [[w * 0.66, h * 0.42]], { color: '#3B12E8' });
    },
    layers: async (e, w, h) => {
      await PaintEngine.paintStroke(e, bezier([w * 0.06, h * 0.32], [w * 0.4, h * 0.2], [w * 0.6, h * 0.45], [w * 0.94, h * 0.34], 30),
        { speed: 380, color: '#29ABE2', animate: true });
      await PaintEngine.paintStroke(e, bezier([w * 0.2, h * 0.9], [w * 0.35, h * 0.5], [w * 0.5, h * 0.3], [w * 0.62, h * 0.08], 30),
        { speed: 420, color: '#F7941E', animate: true });
      await PaintEngine.paintStroke(e, bezier([w * 0.5, h * 0.88], [w * 0.62, h * 0.55], [w * 0.75, h * 0.35], [w * 0.86, h * 0.1], 30),
        { speed: 420, color: '#F04E23', animate: true });
    },
    // about 80-90 px, fast and released while moving: a stroke that's barely there before it flicks
    // off, still inside a stroke's heavy opening splatter
    dash: async (e, w, h) => {
      await PaintEngine.paintStroke(e, bezier([w * 0.12, h * 0.8], [w * 0.17, h * 0.7], [w * 0.24, h * 0.62], [w * 0.32, h * 0.54], 10),
        { speed: 900, flick: true, color: '#3B12E8', animate: true });
      await wait(200);
      await PaintEngine.paintStroke(e, bezier([w * 0.5, h * 0.76], [w * 0.56, h * 0.7], [w * 0.62, h * 0.58], [w * 0.71, h * 0.46], 10),
        { speed: 1100, flick: true, color: '#17A6B5', animate: true });
    },
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const swatches = [...document.querySelectorAll('.swatch[data-gesture]')];
  const engines = new Map();
  function paintSwatch(sw) {
    const art = sw.querySelector('.swatch__art');
    let e = engines.get(sw);
    if (!e) {
      e = PaintEngine.mount(art, { input: false, paper: true });
      engines.set(sw, e);
    } else {
      e.clear();
    }
    GESTURES[sw.dataset.gesture](e, art.clientWidth, art.clientHeight);
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        io.unobserve(en.target);
        // a little stagger, so a row doesn't paint in lockstep
        setTimeout(() => paintSwatch(en.target), 140 * (swatches.indexOf(en.target) % 3));
      }
    }, { threshold: 0.45 });
    swatches.forEach((s) => io.observe(s));
  } else {
    swatches.forEach(paintSwatch);
  }
  const again = document.getElementById('replaySwatches');
  if (again) again.addEventListener('click', () => swatches.forEach(paintSwatch));
})();

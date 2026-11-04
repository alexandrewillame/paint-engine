# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- `paintPage()` with `layer: 'under'` on the whole page showed no paint at all when `<html>` had a
  background of its own, which dark-mode extensions such as Dark Reader add: `<body>`'s background
  covered the layer. `paintPage()` now sets `isolation: isolate` on `<body>` in that case (and only
  then), so the paint lies between that background and the content.
- A stroke started while the previous one was still being rendered in the background made that
  previous stroke blink back to a partly drawn state for a few frames. Strokes painted back to back
  from code hit this every time. Finished strokes now keep their preview until they are fully
  rendered; the final pixels are unchanged.

## [1.0.0] - 2026-11-03

First public release. The engine is the one running on
[creativebestiesclubmtl.com](https://creativebestiesclubmtl.com/), unchanged where it draws: with the
same options it paints exactly the same pixels.

### Added

- One file, `paint-engine.js`: a `PaintEngine` global for `<script>` tags and `module.exports` for
  CommonJS and bundlers; `paint-engine.mjs` as the ES-module entry; TypeScript types in `paint-engine.d.ts`.
- `createPaintEngine({ scale })`: brush size multiplier (1 is the original size).
- `engine.undo()`: takes back the last mark by replaying the rest from their recipes.
- `engine.flush()`: finishes all background baking at once, so the canvas is final (for exports).
- `engine.drawing`: true while a stroke is in progress.
- `PaintEngine.mount(element, options)`: an element you can paint on, sized and wired for mouse,
  touch and pen in one call.
- `PaintEngine.paintStroke(engine, points, options)`: strokes from code along any path, with the brush
  speed (and so the look) under control, painted at once or animated.
- `PaintEngine.paintPage(options)`: the club site's "every drag stains the page" adapter as a drop-in
  for any page, with paint under the content or blended over it, on the whole page or only inside
  one element (`area`, e.g. the hero).

[Unreleased]: https://github.com/alexandrewillame/paint-engine/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/alexandrewillame/paint-engine/releases/tag/v1.0.0

// Type definitions for Paint Engine 1.0
// Coordinates are CSS pixels relative to the engine's canvas; times are milliseconds (any clock,
// only differences matter: they are what tells a slow stroke from a fast one).

export as namespace PaintEngine;

export interface EngineOptions {
  /** The canvas to paint on. The engine sets its size (resize()) and style width/height. */
  canvas: HTMLCanvasElement;
  /** Colours a stroke or splat picks from when none is given. Default: teal, sky, indigo, ultramarine, orange, red. */
  palette?: string[];
  /** Seeds the brush sprites, paper grain and every random choice. Same seed + same input = same pixels. */
  seed?: number | string;
  /** Device pixel ratio for the backing store (capped at 2). Default: window.devicePixelRatio. */
  dpr?: number;
  /** false: untouched pixels stay transparent (for painting over a page). Default true: cream paper. */
  paper?: boolean;
  /** Brush size multiplier: 0.5 paints marks half as big. Speeds and thresholds are unchanged. Default 1. */
  scale?: number;
  /** History bounds; past them the oldest marks are dropped. Default { maxMarks: 150 }. */
  budget?: Budget;
}

export interface Budget {
  maxMarks?: number;
  /** Total bounding-box area of all marks, in device px². Default 60 × canvas area. */
  maxInkArea?: number | null;
}

export interface MarkStyle {
  /** Any CSS hex colour, e.g. '#17A6B5'. Default: from the palette, slightly jittered. */
  color?: string;
  /** The mark's texture. Default: random from the engine's seed. */
  seed?: number;
}

export interface SplatOptions extends MarkStyle {
  /** Splat size in CSS px (roughly the core's radius). Default: random. */
  size?: number;
}

export interface Engine {
  /** Starts a stroke. A begin + end with almost no movement in between is a tap: a splat. */
  beginStroke(x: number, y: number, t: number, style?: MarkStyle): void;
  extendStroke(x: number, y: number, t: number): void;
  endStroke(t: number): void;
  splat(x: number, y: number, options?: SplatOptions): void;
  /** Removes the most recent finished mark. Returns false when there is nothing to undo. */
  undo(): boolean;
  /** Finishes all background baking now, so the canvas is final (e.g. before toBlob()). */
  flush(): void;
  /** Sets the canvas size in CSS px and repaints every mark in its history. */
  resize(width: number, height: number): void;
  clear(): void;
  setBudget(budget: Budget): void;
  /** Draws already-rendered pixels into the painting (they have no history: resize/undo drop them). */
  adoptPixels(image: CanvasImageSource, x: number, y: number): void;
  /** Marks in the history. */
  readonly markCount: number;
  /** True while a stroke is in progress (between beginStroke and endStroke). */
  readonly drawing: boolean;
}

export interface MountOptions extends Omit<EngineOptions, 'canvas'> {
  /** Colour for each new stroke: a colour, a function returning one, or null for the palette. */
  color?: string | (() => string) | null;
  /** false: no mouse/touch/pen input (paint from code only). Default true. */
  input?: boolean;
}

export interface MountedEngine extends Engine {
  readonly canvas: HTMLCanvasElement;
  /** Live: set it to change the colour of the next strokes. */
  color: string | (() => string) | null;
  /** Removes the canvas and the listeners. */
  destroy(): void;
}

export type Point = [number, number] | { x: number; y: number };

export interface StrokeOptions extends MarkStyle {
  /** Brush speed along the path, CSS px/s. Default 500. Slow is wide and wet, fast is narrow and dry. */
  speed?: number;
  /** Speed at the release, reached over the last stretch. Below ~790 a rounded end, above ~920 a flicked tail. */
  endSpeed?: number;
  /** Shorthand for an endSpeed fast enough to flick a full tail. */
  flick?: boolean;
  /** true: paint in real time; a number: play that many times faster. Default false (all at once). */
  animate?: boolean | number;
}

export interface PageOptions {
  palette?: string[];
  seed?: number | string;
  scale?: number;
  /** Paint only this element (e.g. the hero) instead of the whole page: marks start only inside it and are clipped to it. It becomes position: relative (if static) and isolation: isolate. */
  area?: Element | string;
  /** 'under' (default): beneath your content. 'over': above everything, blended. */
  layer?: 'under' | 'over';
  /** Default 0.4 under, 0.6 over. */
  opacity?: number;
  /** CSS mix-blend-mode of the paint layer. Default none under, 'multiply' over. */
  blend?: string;
  /** Default -1 under, 2147483000 over. */
  zIndex?: number;
  /** Elements a gesture can't start a mark on. Default: form fields, [contenteditable], [data-paint-engine-ignore]. */
  ignore?: string;
  /** Default true. */
  mouse?: boolean;
  /** Default true. */
  touch?: boolean;
  /** Let a mouse drag select text as well as paint. Default false. */
  selectText?: boolean;
  /** Raster resolution. Default: from the device, lower on weak hardware. */
  dpr?: number;
}

export interface PaintedPage {
  readonly engine: Engine;
  /** The layer element holding the canvas (style it, fade it...). */
  readonly layer: HTMLDivElement;
  /** Paint from code, in page coordinates (CSS px from the document's top-left). */
  splat(pageX: number, pageY: number, options?: SplatOptions): void;
  stroke(points: Point[], options?: StrokeOptions): Promise<void>;
  clear(): void;
  destroy(): void;
}

export const version: string;
export function createPaintEngine(options: EngineOptions): Engine;
export function mount(element: Element | string, options?: MountOptions): MountedEngine;
export function paintStroke(engine: Engine, points: Point[], options?: StrokeOptions): Promise<void>;
export function paintPage(options?: PageOptions): PaintedPage;
/** The engine's seeded PRNG (mulberry32): makeRNG('hello')() is the same number everywhere. */
export function makeRNG(seed: number | string): () => number;

// Lower-level building blocks (pure functions over device-px geometry), exported for tools and
// experiments. Their shapes follow the source; see the comments there.
export function resampleByArcLength(points: { x: number; y: number; t: number }[], spacing: number): { x: number; y: number; t: number }[];
export function makePathResampler(spacing: number): { push(x: number, y: number, t: number): void; settle(): { x: number; y: number; t: number }[] };
export function computeFrames(resampled: { x: number; y: number; t: number }[], spacing: number): object[];
export function splatDabSpecs(seed: number, size: number): object[];
export function strokeMarks(frames: object[], params: object, seed: number): object[];
export function splashMarks(frames: object[], params: object, seed: number, splashFrac: number, growFrac: number): object[];
export function dashMarks(frames: object[], params: object, seed: number): object[];
export function castShadow(source: HTMLCanvasElement, rect: { minX: number; minY: number; maxX: number; maxY: number }, target: CanvasRenderingContext2D): void;

declare const PaintEngine: {
  version: string;
  createPaintEngine: typeof createPaintEngine;
  mount: typeof mount;
  paintStroke: typeof paintStroke;
  paintPage: typeof paintPage;
  makeRNG: typeof makeRNG;
  resampleByArcLength: typeof resampleByArcLength;
  makePathResampler: typeof makePathResampler;
  computeFrames: typeof computeFrames;
  splatDabSpecs: typeof splatDabSpecs;
  strokeMarks: typeof strokeMarks;
  splashMarks: typeof splashMarks;
  dashMarks: typeof dashMarks;
  castShadow: typeof castShadow;
};
export default PaintEngine;

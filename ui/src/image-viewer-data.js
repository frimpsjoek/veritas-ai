// @ts-check
// ui/src/image-viewer-data.js. Spec 029 R12: the pure part of the full-screen picture viewer: where the picture sits
// and how big, as one { scale, x, y } (x, y: the picture's centre offset from the stage's centre, in screen pixels).
// Zooming keeps the point under the pointer still; panning stops the picture from leaving the stage.

/** @typedef {{ scale: number, x: number, y: number }} View */
/** @typedef {{ width: number, height: number }} Size */

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 16;
/** One + or − press, or one wheel notch's worth. */
export const STEP = 1.25;

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));

/** The share of the stage a fitted picture fills, leaving a margin round it (and room for the bar). */
export const FIT_SHARE = 0.9;

/** The scale that fits the whole picture in the stage with a margin; a small picture (a TOC graphic is often a few
 *  hundred pixels) is scaled up to fill it, as a full-screen view should. 1:1 shows its own size.
 *  @param {Size} image @param {Size} stage */
export function fitScale(image, stage) {
  if (!(image.width > 0 && image.height > 0 && stage.width > 0 && stage.height > 0)) return 1;
  return Math.min(MAX_SCALE, (FIT_SHARE * stage.width) / image.width, (FIT_SHARE * stage.height) / image.height);
}

/** The picture fitted and centred. @param {Size} image @param {Size} stage @returns {View} */
export const fitView = (image, stage) => ({ scale: fitScale(image, stage), x: 0, y: 0 });

/** Keeps the picture from leaving the stage: a picture smaller than the stage stays centred on that axis, a bigger one
 *  can move until its edge meets the stage's. @param {View} view @param {Size} image @param {Size} stage @returns {View} */
export function clampView(view, image, stage) {
  const scale = clamp(view.scale, MIN_SCALE, MAX_SCALE);
  const spareX = Math.max(0, (image.width * scale - stage.width) / 2);
  const spareY = Math.max(0, (image.height * scale - stage.height) / 2);
  return { scale, x: clamp(view.x, -spareX, spareX), y: clamp(view.y, -spareY, spareY) };
}

/** Zooms by `factor` keeping the stage point `at` (pixels from the stage's centre) still; `at` absent is the centre.
 *  @param {View} view @param {number} factor @param {{ x: number, y: number } | null} at @param {Size} image @param {Size} stage @returns {View} */
export function zoomAt(view, factor, at, image, stage) {
  const scale = clamp(view.scale * factor, MIN_SCALE, MAX_SCALE);
  const k = scale / view.scale;
  const p = at ?? { x: 0, y: 0 };
  // the point under `at` is p - offset in picture pixels times scale; keeping it still: p - x' = (p - x) * k
  return clampView({ scale, x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k }, image, stage);
}

/** Moves the picture by (dx, dy) screen pixels. @param {View} view @param {number} dx @param {number} dy @param {Size} image @param {Size} stage */
export const panBy = (view, dx, dy, image, stage) => clampView({ ...view, x: view.x + dx, y: view.y + dy }, image, stage);

/** A wheel's delta as a zoom factor: one notch (100 px, or 1 line) is one STEP; a trackpad's small deltas zoom smoothly.
 *  @param {number} deltaY @param {number} deltaMode 0 pixels, 1 lines, 2 pages */
export function wheelFactor(deltaY, deltaMode) {
  const px = deltaMode === 1 ? deltaY * 33 : deltaMode === 2 ? deltaY * 800 : deltaY;
  return Math.pow(STEP, -clamp(px, -300, 300) / 100);
}

/** "125%". @param {number} scale */
export const percent = (scale) => `${Math.round(scale * 100)}%`;

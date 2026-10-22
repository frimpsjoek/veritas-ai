// @ts-check
// ui-src/src/web/pdf-geometry.js. Where a highlight sits on a PDF page, in the units Zotero stores it (spec 014 G3):
// rects [x1, y1, x2, y2] in PDF points with the origin at the page's bottom left, one per line, and a sort index
// "PPPPP|OOOOOO|TTTTT" (page, character offset, distance from the top), so a highlight made in the web reader lands on
// the same text in Zotero's reader and sorts among Zotero's own. Pure: the viewer passes in PDF.js's viewport transform.

/** @typedef {[number, number, number, number]} PdfRect x1, y1, x2, y2 in PDF points; origin bottom left */
/** @typedef {[number, number, number, number, number, number]} Transform a PDF.js viewport.transform: PDF points to page px */
/** @typedef {{ left: number, top: number, right: number, bottom: number }} Box CSS px, relative to the page's top left */
/** @typedef {{ pageIndex: number, rects: PdfRect[] }} PdfPosition */
/**
 * What POST /zotero/annotate takes and Zotero.Annotations.saveFromJSON reads.
 * @typedef {{ type: 'highlight', text: string, comment: string, color: string, pageLabel: string, sortIndex: string, position: PdfPosition }} HighlightJSON
 */

/** Zotero's eight annotation colours, in the order its reader lists them. */
export const ZOTERO_COLORS = /** @type {const} */ ([
  { name: 'Yellow', hex: '#ffd400' },
  { name: 'Red', hex: '#ff6666' },
  { name: 'Green', hex: '#5fb236' },
  { name: 'Blue', hex: '#2ea8e5' },
  { name: 'Purple', hex: '#a28ae5' },
  { name: 'Magenta', hex: '#e56eee' },
  { name: 'Orange', hex: '#f19837' },
  { name: 'Gray', hex: '#aaaaaa' },
]);

/** @param {Transform} m @param {number} x @param {number} y @returns {[number, number]} */
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** @param {Transform} m @returns {Transform} */
function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

const round = (/** @type {number} */ n) => Math.round(n * 1000) / 1000;

/**
 * One box per line of a selection. A browser reports a box per text span (often several per line, overlapping) and
 * sometimes one for a whole block the selection crosses; those are dropped by height.
 * @param {Box[]} boxes @returns {Box[]}
 */
export function lineBoxes(boxes) {
  const real = boxes.filter((b) => b.right - b.left > 0.5 && b.bottom - b.top > 0.5);
  if (!real.length) return [];
  const heights = real.map((b) => b.bottom - b.top).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  /** @type {Box[]} */ const lines = [];
  for (const box of real.filter((b) => b.bottom - b.top <= median * 2.5).sort((a, b) => a.top - b.top || a.left - b.left)) {
    const line = lines.find((l) => Math.min(l.bottom, box.bottom) - Math.max(l.top, box.top) >= 0.5 * Math.min(l.bottom - l.top, box.bottom - box.top));
    if (line) {
      line.left = Math.min(line.left, box.left);
      line.right = Math.max(line.right, box.right);
      line.top = Math.min(line.top, box.top);
      line.bottom = Math.max(line.bottom, box.bottom);
    } else lines.push({ ...box });
  }
  return lines;
}

/** Selection boxes (page px) to Zotero's rects (PDF points), one per line. @param {Box[]} boxes @param {Transform} transform @returns {PdfRect[]} */
export function toPdfRects(boxes, transform) {
  const back = invert(transform);
  return lineBoxes(boxes).map((b) => {
    const [x1, y1] = apply(back, b.left, b.bottom);
    const [x2, y2] = apply(back, b.right, b.top);
    return /** @type {PdfRect} */ ([round(Math.min(x1, x2)), round(Math.min(y1, y2)), round(Math.max(x1, x2)), round(Math.max(y1, y2))]);
  });
}

/** A stored rect (PDF points) to a box on the page as drawn (page px). @param {PdfRect} rect @param {Transform} transform @returns {Box} */
export function toPageBox(rect, transform) {
  const [ax, ay] = apply(transform, rect[0], rect[1]);
  const [bx, by] = apply(transform, rect[2], rect[3]);
  return { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
}

/**
 * Zotero's sort index: the page, the selection's first character in the page's text, and how far below the top of the
 * page (in points, from the page's view box) the highlight's top edge sits.
 * @param {number} pageIndex @param {number} offset @param {PdfRect[]} rects @param {number[]} viewBox [x1, y1, x2, y2]
 */
export function sortIndex(pageIndex, offset, rects, viewBox) {
  const top = Math.max(0, Math.floor((viewBox[3] - viewBox[1]) - Math.max(...rects.map((r) => r[3]))));
  const pad = (/** @type {number} */ n, /** @type {number} */ width) => String(Math.max(0, Math.trunc(n))).slice(0, width).padStart(width, '0');
  return `${pad(pageIndex, 5)}|${pad(offset, 6)}|${pad(top, 5)}`;
}

/**
 * The highlight to send, or null when the selection covered no text.
 * @param {{ pageIndex: number, pageLabel?: string, text: string, comment?: string, color: string, boxes: Box[], transform: Transform, viewBox: number[], offset: number }} o
 * @returns {HighlightJSON | null}
 */
export function buildHighlight(o) {
  const text = o.text.replace(/\s+/g, ' ').trim();
  const rects = toPdfRects(o.boxes, o.transform);
  if (!text || !rects.length) return null;
  return {
    type: 'highlight', text, comment: (o.comment ?? '').trim(), color: o.color,
    pageLabel: o.pageLabel || String(o.pageIndex + 1),
    sortIndex: sortIndex(o.pageIndex, o.offset, rects, o.viewBox),
    position: { pageIndex: o.pageIndex, rects },
  };
}

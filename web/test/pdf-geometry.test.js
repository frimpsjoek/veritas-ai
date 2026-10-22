import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZOTERO_COLORS, buildHighlight, lineBoxes, sortIndex, toPageBox, toPdfRects } from '../src/pdf-geometry.js';

// PDF.js's viewport.transform for a US Letter page (612 x 792 pt) at 150 %, unrotated: x * 1.5, y flipped from the bottom.
/** @type {[number, number, number, number, number, number]} */
const LETTER = [1.5, 0, 0, -1.5, 0, 1188];
const VIEWBOX = [0, 0, 612, 792];

test('selection boxes in page px become Zotero rects in PDF points with the origin at the bottom left', () => {
  assert.deepEqual(toPdfRects([{ left: 108, top: 150, right: 450, bottom: 174 }], LETTER), [[72, 676, 300, 692]]);
});

test('rects are rounded to three decimals, as Zotero stores them', () => {
  assert.deepEqual(toPdfRects([{ left: 100, top: 100, right: 200, bottom: 110 }], LETTER), [[66.667, 718.667, 133.333, 725.333]]);
});

test('a view box that does not start at 0, 0 shifts the points as PDF.js draws it', () => {
  // PDF.js: transform e = -x0 * scale, f = y1 * scale
  /** @type {[number, number, number, number, number, number]} */
  const cropped = [1, 0, 0, -1, -20, 812];
  assert.deepEqual(toPdfRects([{ left: 0, top: 0, right: 10, bottom: 10 }], cropped), [[20, 802, 30, 812]]);
});

test('a page rotated 90 degrees swaps the axes', () => {
  // PDF.js for /Rotate 90 at scale 1 over [0 0 612 792]: [0, 1, 1, 0, 0, 0]
  /** @type {[number, number, number, number, number, number]} */
  const rotated = [0, 1, 1, 0, 0, 0];
  assert.deepEqual(toPdfRects([{ left: 690, top: 72, right: 712, bottom: 300 }], rotated), [[72, 690, 300, 712]]);
});

test('a stored rect is drawn back on the same page px', () => {
  assert.deepEqual(toPageBox([72, 676, 300, 692], LETTER), { left: 108, top: 150, right: 450, bottom: 174 });
});

test('span boxes on one line merge into one rect per line; empty and block-sized boxes are dropped', () => {
  const boxes = [
    { left: 10, top: 100, right: 60, bottom: 112 },
    { left: 58, top: 101, right: 120, bottom: 113 }, // the next span on the same line, a pixel lower
    { left: 10, top: 120, right: 90, bottom: 132 },
    { left: 50, top: 50, right: 50, bottom: 62 }, // collapsed
    { left: 0, top: 0, right: 600, bottom: 800 }, // the text layer itself, when a selection crosses it
  ];
  assert.deepEqual(lineBoxes(boxes), [{ left: 10, top: 100, right: 120, bottom: 113 }, { left: 10, top: 120, right: 90, bottom: 132 }]);
});

test('the sort index pads page, offset and top as Zotero does', () => {
  assert.equal(sortIndex(2, 123, [[72, 676, 300, 692], [72, 660, 200, 674]], VIEWBOX), '00002|000123|00100');
  assert.equal(sortIndex(0, 0, [[0, 790, 10, 800]], VIEWBOX), '00000|000000|00000'); // above the top clamps to 0
});

test('buildHighlight gives the JSON the server queues', () => {
  const json = buildHighlight({
    pageIndex: 2, text: ' Voles cache\n seeds. ', comment: ' check ', color: '#5fb236', offset: 40,
    boxes: [{ left: 108, top: 150, right: 450, bottom: 174 }], transform: LETTER, viewBox: VIEWBOX,
  });
  assert.deepEqual(json, {
    type: 'highlight', text: 'Voles cache seeds.', comment: 'check', color: '#5fb236', pageLabel: '3',
    sortIndex: '00002|000040|00100', position: { pageIndex: 2, rects: [[72, 676, 300, 692]] },
  });
  assert.equal(buildHighlight({ pageIndex: 0, text: '  ', color: '#ffd400', offset: 0, boxes: [{ left: 1, top: 1, right: 9, bottom: 9 }], transform: LETTER, viewBox: VIEWBOX }), null);
});

test("Zotero's eight colours", () => {
  assert.deepEqual(ZOTERO_COLORS.map((c) => c.hex), ['#ffd400', '#ff6666', '#5fb236', '#2ea8e5', '#a28ae5', '#e56eee', '#f19837', '#aaaaaa']);
});

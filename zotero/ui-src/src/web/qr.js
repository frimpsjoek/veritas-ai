// @ts-check
// ui-src/src/web/qr.js. A QR code as an SVG, drawn by the vendored qrcode-generator (no network, no CDN).
import qrcode from './vendor/qrcode.cjs';

const SVG = 'http://www.w3.org/2000/svg';

/** One dark module is one unit square; the quiet zone is 4 modules, as the QR standard asks.
 *  @param {Document} doc @param {string} text @returns {SVGSVGElement} */
export function qrSvg(doc, text) {
  const code = qrcode(0, 'M'); // type 0 picks the smallest version that fits
  code.addData(text, 'Byte');
  code.make();
  const count = code.getModuleCount();
  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) if (code.isDark(row, col)) path += `M${col + 4} ${row + 4}h1v1h-1z`;
  }
  const svg = /** @type {SVGSVGElement} */ (doc.createElementNS(SVG, 'svg'));
  svg.setAttribute('viewBox', `0 0 ${count + 8} ${count + 8}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR code to sign in on your phone');
  const back = doc.createElementNS(SVG, 'rect');
  back.setAttribute('width', String(count + 8));
  back.setAttribute('height', String(count + 8));
  back.setAttribute('fill', '#fff'); // always white on black: scanners need the contrast, even in dark mode
  const dark = doc.createElementNS(SVG, 'path');
  dark.setAttribute('d', path);
  dark.setAttribute('fill', '#000');
  svg.append(back, dark);
  return svg;
}

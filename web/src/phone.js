// @ts-check
// ui-src/src/web/phone.js. Settings > "Use on your phone": the sign-in link as a QR code, only for requests that
// come from the Mac itself (GET /web/phone-link answers 403 to the phone side, so the token never travels there).
import { h } from '../../ui/src/dom.js';
import { qrSvg } from './qr.js';

/** @param {HTMLElement} into @param {{ host: any, doc: Document }} ctx */
export async function paintPhone(into, { host, doc }) {
  let link;
  try {
    link = await host.json('/web/phone-link');
  } catch (error) {
    // 403 on the phone itself: it is already signed in, so there is nothing to scan
    const status = /** @type {any} */ (error)?.status;
    into.append(h(doc, 'p', 'sbw-hint', status === 403 ? 'The code is shown on your Mac. This device is already signed in.' : "Couldn't read the Tailscale link."));
    return;
  }
  if (!link.url) {
    into.append(h(doc, 'p', 'sbw-hint', link.problem));
    if (link.command) {
      const code = h(doc, 'code', 'sbw-command', link.command);
      code.tabIndex = 0;
      into.append(code);
    }
    return;
  }
  const qr = h(doc, 'div', 'sbw-qr');
  qr.append(qrSvg(doc, link.url));
  const url = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-phone-url'));
  url.readOnly = true;
  url.value = link.url;
  url.setAttribute('aria-label', 'Sign-in link');
  url.addEventListener('focus', () => url.select());
  into.append(
    h(doc, 'p', 'sbw-hint', 'Point your phone camera at the code to open Second Brain and sign in. Keep this link private: it signs in whoever opens it.'),
    qr, url,
    ...(link.secure ? [] : [h(doc, 'p', 'sbw-hint', 'This link uses plain http inside your tailnet, which Tailscale already encrypts.')]),
  );
}

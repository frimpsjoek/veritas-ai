// @ts-check
// ui-src/src/web/progress-view.js (server spec 019 G2). How far building the index is: a bar for the
// current stage and the list of stages (Settings > Search index and Folders), and a thin bar under the header
// everywhere else while a build runs. One bar per stage, not one for the whole build: the stages differ in speed by
// orders of magnitude (notes take seconds, meaning vectors can take an hour), so an overall percentage would mislead.
import { h } from '../dom.js';

export const RUNNING_MS = 2000;
export const IDLE_MS = 30000;
const MARK = /** @type {Record<string, string>} */ ({ done: '✓', running: '…', waiting: '', skipped: '–', stopped: '■', failed: '!' });

/** "about 50 min left" @param {number | null | undefined} seconds */
export function etaText(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''} left`;
}

/** The one-line summary of /status.indexing. @param {any} indexing @param {(n: number) => string} [num] */
export function progressLine(indexing, num = (n) => n.toLocaleString('en-US')) {
  if (!indexing) return '';
  if (!indexing.running) {
    if (indexing.error) return `Last build failed: ${indexing.error}`;
    if (indexing.label === 'Stopped') return 'Stopped. What was done so far is kept.';
    const at = indexing.finished_at ? new Date(indexing.finished_at * 1000) : null;
    return at ? `Up to date · last built ${at.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Up to date';
  }
  const parts = [indexing.label];
  if (indexing.total) parts.push(`${num(indexing.done ?? 0)} of ${num(indexing.total)}`);
  const eta = etaText(indexing.eta_seconds);
  if (eta) parts.push(eta);
  return parts.join(' · ');
}

/** Share of the current stage done, 0..1. @param {any} indexing */
export const stageFraction = (indexing) => (indexing?.running && indexing.total ? Math.min(1, (indexing.done ?? 0) / indexing.total) : 0);

/** @param {Document} doc @param {number} fraction */
function bar(doc, fraction) {
  const track = h(doc, 'div', 'sbw-progress-track');
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  const fill = /** @type {HTMLElement} */ (h(doc, 'div', 'sbw-progress-fill'));
  fill.style.width = `${(fraction * 100).toFixed(1)}%`;
  track.append(fill);
  return track;
}

/** Polls /status while `root` stays in the page: every 2 s while a build runs, every 30 s otherwise.
 *  @param {any} host @param {HTMLElement} root @param {(indexing: any) => void} paint */
function follow(host, root, paint) {
  let started = false;
  const tick = async () => {
    if (started && !root.isConnected) return;  // the page moved on
    let indexing = null;
    try { indexing = (await host.json('/status'))?.indexing ?? null; } catch { /* the server is away; try again later */ }
    started = true;
    paint(indexing);
    setTimeout(tick, indexing?.running ? RUNNING_MS : IDLE_MS);
  };
  void tick();
}

/** The full panel: bar, line, stage list, Stop. @param {Document} doc @param {any} host */
export function progressPanel(doc, host) {
  const root = h(doc, 'div', 'sbw-progress');
  const line = h(doc, 'p', 'sbw-progress-line');
  const track = h(doc, 'div', 'sbw-progress-bar');
  const stages = h(doc, 'ol', 'sbw-progress-stages');
  const stop = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', 'Stop'));
  stop.type = 'button';
  stop.addEventListener('click', async () => {
    stop.disabled = true;
    try { await host.json('/index/stop', 'POST', {}); } catch (error) { line.textContent = String(/** @type {any} */ (error)?.message ?? error); }
  });
  root.append(track, line, stages, stop);
  follow(host, root, (indexing) => {
    root.classList.toggle('is-running', Boolean(indexing?.running));
    track.replaceChildren(...(indexing?.running ? [bar(doc, stageFraction(indexing))] : []));
    line.textContent = indexing ? progressLine(indexing) : "Couldn't read the index status.";
    stages.replaceChildren(...(indexing?.running && Array.isArray(indexing.stages) ? indexing.stages.map((/** @type {any} */ s) => {
      const item = h(doc, 'li', `sbw-progress-stage is-${s.state}`);
      item.append(h(doc, 'span', 'sbw-progress-mark', MARK[s.state] ?? ''), h(doc, 'span', '', s.label));
      return item;
    }) : []));
    stop.hidden = !indexing?.running;
    stop.disabled = false;
  });
  return root;
}

/** The thin bar under the header while a build runs; it links to Settings > Search index.
 *  @param {Document} doc @param {any} host @param {string} href */
export function headerProgress(doc, host, href) {
  const root = /** @type {HTMLAnchorElement} */ (h(doc, 'a', 'sbw-header-progress'));
  root.href = href;
  root.hidden = true;
  root.setAttribute('aria-label', 'Building the search index');
  follow(host, root, (indexing) => {
    root.hidden = !indexing?.running;
    if (!indexing?.running) return;
    root.title = progressLine(indexing);
    root.replaceChildren(bar(doc, stageFraction(indexing)));
  });
  return root;
}

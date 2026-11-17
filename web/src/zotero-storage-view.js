// @ts-check
// Personal Zotero file sync through native WebDAV. Metadata remains on zotero.org;
// browser sessions are used only for this management UI, never as DAV credentials.
import { h } from '../../ui/src/dom.js';

/** @param {number} bytes */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = /** @type {[number, string][]} */ ([[1024 ** 3, 'GiB'], [1024 ** 2, 'MiB'], [1024, 'KiB']]);
  for (const [scale, suffix] of units) {
    if (value >= scale) return `${(value / scale).toFixed(1)} ${suffix}`;
  }
  return `${Math.round(value)} B`;
}

/** @param {Document} doc @param {string} label @param {() => Promise<void>} action */
function actionButton(doc, label, action) {
  const button = /** @type {HTMLButtonElement} */ (h(doc, 'button', 'sb-button', label));
  button.type = 'button';
  button.addEventListener('click', () => void action());
  return button;
}

/** @param {Document} doc @param {any} host */
export function zoteroStorageWidget(doc, host) {
  const root = h(doc, 'div', 'sbw-folders');
  root.id = 'sbw-zotero-storage';
  let state = null;
  let secret = null;
  let busy = false;

  const message = (error) => String(error?.message ?? error);

  async function refresh() {
    secret = null;
    render();
    try {
      state = await host.json('/zotero-storage');
    } catch (error) {
      state = { error: message(error) };
    }
    render();
  }

  async function issue() {
    if (busy) return;
    if (state?.issued && !doc.defaultView?.confirm(
      'Replace the current WebDAV credentials? Existing Zotero clients will need the new username and password.')) return;
    busy = true;
    try {
      secret = await host.json('/zotero-storage/credentials', 'POST', {});
      state = { ...state, enabled: true, issued: true, error: null };
    } catch (error) {
      secret = null;
      state = { ...state, error: message(error) };
    } finally {
      busy = false;
    }
    render();
  }

  async function revoke() {
    if (busy) return;
    if (!doc.defaultView?.confirm(
      'Revoke WebDAV credentials? Zotero file synchronization will stop. Stored attachments are not deleted.')) return;
    busy = true;
    secret = null;
    try {
      await host.json('/zotero-storage/credentials', 'DELETE', {});
      await refresh();
    } catch (error) {
      state = { ...state, error: message(error) };
      render();
    } finally {
      busy = false;
    }
  }

  function render() {
    const summary = h(doc, 'p', 'sbw-row-detail');
    const instructions = h(doc, 'p', 'sbw-hint',
      'For your personal Zotero library attachments only. Metadata continues to sync through zotero.org.');
    const error = state?.error ? h(doc, 'p', 'sbw-hint', state.error) : null;
    const buttons = h(doc, 'div', 'sbw-row');
    if (!state || !state.enabled) {
      summary.textContent = state?.error ? 'Zotero file sync status is unavailable.' :
        'Zotero file sync is not configured. The Veritas operator must configure a canonical HTTPS endpoint.';
    } else {
      summary.textContent = `${formatBytes(state.user_used)} of ${formatBytes(state.user_quota)} used · ` +
        `Pool capacity: ${formatBytes(state.pool_quota)} · ` +
        (state.issued ? 'WebDAV credentials issued' : 'No WebDAV credentials issued');
      buttons.append(actionButton(doc, state.issued ? 'Rotate WebDAV credentials' : 'Create WebDAV credentials', issue));
      if (state.issued) buttons.append(actionButton(doc, 'Revoke WebDAV credentials', revoke));
    }
    const pieces = [summary, instructions, buttons];
    if (secret) {
      const once = h(doc, 'p', 'sbw-row-detail',
        'Copy these credentials now. The password will not be shown again.');
      const credentials = h(doc, 'pre', 'sbw-card-text');
      credentials.textContent = [
        'In desktop Zotero, choose WebDAV file sync and enter:',
        `Server parent address: ${secret.endpoint}`,
        `Username: ${secret.username}`,
        `Password: ${secret.password}`,
        'Zotero appends zotero/ to this server parent address; do not add it yourself.',
        'Use only for personal library attachments, not group-library files.',
      ].join('\n');
      pieces.push(once, credentials, actionButton(doc, 'Hide credentials and refresh', refresh));
    }
    if (error) pieces.push(error);
    root.replaceChildren(...pieces);
  }

  render();
  void refresh();
  return root;
}

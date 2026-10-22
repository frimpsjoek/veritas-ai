// @ts-check
// ui-src/src/web/dialogs.js. In-page dialogs and the toast. window.alert/confirm/prompt block the page, which
// freezes automation and the streaming thread behind it, so the web host never uses them.
import { h } from '../../ui/src/dom.js';

/** @param {Document} doc */
export function createDialogs(doc) {
  /** A modal sheet. `build(box, finish)` fills it; `finish(value)` closes it. Escape and a click outside cancel (value `cancel`).
   *  @template T @param {string} title @param {(box: HTMLElement, finish: (value: T) => void) => void} build @param {T} cancel @returns {Promise<T>} */
  function modal(title, build, cancel) {
    return new Promise((resolve) => {
      const previous = /** @type {HTMLElement | null} */ (doc.activeElement);
      const overlay = h(doc, 'div', 'sbw-overlay');
      const box = h(doc, 'div', 'sbw-dialog');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-label', title);
      const finish = (/** @type {T} */ value) => {
        doc.removeEventListener('keydown', onKey, true);
        overlay.remove();
        previous?.focus?.();
        resolve(value);
      };
      const onKey = (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Escape') { event.stopPropagation(); finish(cancel); }
      };
      doc.addEventListener('keydown', onKey, true);
      overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) finish(cancel); });
      box.append(h(doc, 'div', 'sbw-dialog-title', title));
      build(box, finish);
      overlay.append(box);
      doc.body.append(overlay);
      /** @type {HTMLElement | null} */ (box.querySelector('input, textarea, .sb-button.is-primary'))?.focus();
    });
  }

  /** @param {HTMLElement} box @param {string} cancel @param {string} ok @param {() => void} onCancel @param {() => void} onOk */
  function buttons(box, cancel, ok, onCancel, onOk) {
    const row = h(doc, 'div', 'sbw-dialog-buttons');
    const no = h(doc, 'button', 'sb-button', cancel);
    const yes = h(doc, 'button', 'sb-button is-primary', ok);
    no.setAttribute('type', 'button');
    yes.setAttribute('type', 'button');
    no.addEventListener('click', onCancel);
    yes.addEventListener('click', onOk);
    row.append(no, yes);
    box.append(row);
    return { no, yes };
  }

  return {
    /** @param {string} message @param {{ title?: string }} [opts] */
    confirm(message, opts) {
      return modal(opts?.title ?? 'Second Brain', (box, finish) => {
        box.append(h(doc, 'p', 'sbw-dialog-text', message));
        buttons(box, 'Cancel', 'OK', () => finish(false), () => finish(true));
      }, false);
    },

    /** @param {string} message @param {string} initial @param {{ title?: string }} [opts] */
    promptText(message, initial, opts) {
      return modal(opts?.title ?? 'Second Brain', (box, finish) => {
        box.append(h(doc, 'p', 'sbw-dialog-text', message));
        const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-dialog-input'));
        input.type = 'text';
        input.value = initial;
        input.setAttribute('aria-label', message);
        input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); finish(input.value); } });
        box.append(input);
        buttons(box, 'Cancel', 'OK', () => finish(null), () => finish(input.value));
      }, /** @type {string | null} */ (null));
    },

    /** Search-as-you-type paper picker. `search(query)` returns rows; resolves to the ticked ones ([] on cancel).
     *  @template {{ id: string, title: string, detail?: string }} R @param {(query: string) => Promise<R[]>} search @param {{ title?: string }} [opts] @returns {Promise<R[]>} */
    pickRows(search, opts) {
      return modal(opts?.title ?? 'Add papers', (box, finish) => {
        const input = /** @type {HTMLInputElement} */ (h(doc, 'input', 'sbw-dialog-input'));
        input.type = 'search';
        input.placeholder = 'Search your library…';
        input.setAttribute('aria-label', 'Search your library');
        const list = h(doc, 'div', 'sbw-dialog-list');
        /** @type {Map<string, R>} */ const chosen = new Map();
        const { yes } = buttons(box, 'Cancel', 'Add', () => finish([]), () => finish([...chosen.values()]));
        const count = () => { yes.textContent = chosen.size ? `Add ${chosen.size}` : 'Add'; yes.toggleAttribute('disabled', !chosen.size); };
        count();
        let timer = 0;
        let latest = 0;
        input.addEventListener('input', () => {
          clearTimeout(timer);
          timer = /** @type {any} */ (setTimeout(async () => {
            const mine = ++latest;
            const query = input.value.trim();
            if (!query) { list.replaceChildren(); return; }
            let rows = [];
            try { rows = await search(query); } catch { rows = []; }
            if (mine !== latest) return;
            list.replaceChildren(...(rows.length ? rows.map((row) => {
              const label = h(doc, 'label', 'sbw-dialog-row');
              const box = /** @type {HTMLInputElement} */ (h(doc, 'input'));
              box.type = 'checkbox';
              box.checked = chosen.has(row.id);
              box.addEventListener('change', () => { if (box.checked) chosen.set(row.id, row); else chosen.delete(row.id); count(); });
              const text = h(doc, 'span', 'sbw-dialog-row-text');
              text.append(h(doc, 'span', 'sbw-dialog-row-title', row.title), h(doc, 'span', 'sbw-dialog-row-detail', row.detail ?? ''));
              label.append(box, text);
              return label;
            }) : [h(doc, 'div', 'sbw-dialog-empty', 'Nothing found.')]));
          }, 200));
        });
        box.insertBefore(input, box.querySelector('.sbw-dialog-buttons'));
        box.insertBefore(list, box.querySelector('.sbw-dialog-buttons'));
      }, /** @type {R[]} */ ([]));
    },

    /** A line that fades after a few seconds; several stack. @param {string} text */
    notice(text) {
      let region = doc.querySelector('.sbw-toasts');
      if (!region) {
        region = h(doc, 'div', 'sbw-toasts');
        region.setAttribute('role', 'status');
        region.setAttribute('aria-live', 'polite');
        doc.body.append(region);
      }
      const toast = h(doc, 'div', 'sbw-toast', text);
      region.append(toast);
      setTimeout(() => toast.remove(), 4500);
    },
  };
}

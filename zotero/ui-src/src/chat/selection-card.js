// @ts-nocheck -- UI glue, like the other files in this folder; host.d.ts and domain.d.ts stay the checked interfaces.
// ui-src/src/chat/selection-card.js. Spec 011 U5 (New from selection): the quiet card in an empty chat that names the
// papers selected in the library and offers the ways to start from them. Everything funnels into
// ChatView.startFromSelection(kind, items); this file only decides what is offered and builds the card.
import { el } from './dom-helpers.js';

/** The selected library papers among `items` (ContextItem or { attachment, label }), once each, in order. */
export function selectedPapers(items) {
  const seen = new Set();
  const out = [];
  for (const item of items ?? []) {
    if (item?.attachment?.kind !== 'zoteroItem') continue;
    const key = item.attachment.citekey;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** "3 papers selected" / "1 paper selected". @param {number} n */
export function selectionTitle(n) {
  return `${n} ${n === 1 ? 'paper' : 'papers'} selected`;
}

/** The name a session started from these papers gets, so two such sessions can be told apart in the history:
 * "Hou 2024", "Hou 2024 and 2 more" (two full titles side by side run too long for a header). */
export function selectionLabel(items) {
  return items.length === 1 ? items[0].label : `${items[0].label} and ${items.length - 1} more`;
}

/** The buttons, in order. The report is offered only where the engine can write one. @param {{ report?: boolean }} can */
export function selectionChoices(can) {
  return [
    { kind: 'papers', label: 'Chat with these' },
    { kind: 'extract', label: 'Extract data' },
    ...(can?.report ? [{ kind: 'report', label: 'Write a report' }] : []),
  ];
}

/**
 * @param {Document} doc
 * @param {{ attachment: any; label: string }[]} items the selected papers (at least one)
 * @param {{ report?: boolean }} can
 * @param {(kind: 'papers' | 'extract' | 'report') => void} onPick
 * @returns {HTMLElement}
 */
export function selectionCard(doc, items, can, onPick) {
  const card = el(doc, 'div', 'sb-ai-selcard');
  const title = el(doc, 'div', 'sb-ai-selcard-title', selectionTitle(items.length));
  title.title = items.map((i) => i.label).join('\n');
  const row = el(doc, 'div', 'sb-ai-selcard-row');
  for (const choice of selectionChoices(can)) {
    const btn = el(doc, 'button', 'sb-ai-selbtn', choice.label);
    btn.setAttribute('type', 'button');
    btn.addEventListener('click', () => {
      for (const b of row.children) b.disabled = true; // one start per card
      onPick(choice.kind);
    });
    row.append(btn);
  }
  card.append(title, row);
  return card;
}

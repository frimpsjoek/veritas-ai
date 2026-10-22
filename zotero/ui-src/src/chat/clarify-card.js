// @ts-nocheck -- UI glue, like the other files in this folder (spec 005 C1); host.d.ts and domain.d.ts stay the checked interfaces.
// ui-src/src/chat/clarify-card.js. Spec 007 §2.2: the clarify question card of a Research report. A quiet
// "Question" header, the question, numbered choices as rows (a click or the number key answers), an editable
// "Other…" line, and one quiet "You decide". Every question shows at once; the review goes on when each has an
// answer. `onSubmit(answers)` gets one { id, choice, other } per question, null + null meaning "You decide".
import { el } from './dom-helpers.js';

/** The one-line fold of an answered card: "Scope · Formal systematic review". @param {{ id: string; choice: number | null; other: string | null }[]} answers @param {{ id: string; choices: string[] }[]} questions */
export function foldedAnswers(questions, answers) {
  return answers.map((a) => {
    const q = questions.find((x) => x.id === a.id);
    return a.other ?? (a.choice != null ? q?.choices[a.choice] : null);
  }).filter(Boolean).join(' · ') || 'You decide';
}

/**
 * @param {Document} doc
 * @param {{ id: string; question: string; choices: string[]; other: boolean }[]} questions
 * @param {(answers: { id: string; choice: number | null; other: string | null }[]) => void} onSubmit
 * @returns {HTMLElement}
 */
export function clarifyCard(doc, questions, onSubmit) {
  const card = el(doc, 'div', 'sb-rp-clarify');
  card.tabIndex = 0;
  /** @type {Map<string, { choice: number | null; other: string | null }>} */
  const answers = new Map();
  let sent = false;
  const blocks = [];

  const send = () => {
    if (sent) return;
    sent = true;
    card.classList.add('is-sent');
    onSubmit(questions.map((q) => ({ id: q.id, choice: answers.get(q.id)?.choice ?? null, other: answers.get(q.id)?.other ?? null })));
  };
  const settle = () => { if (questions.every((q) => answers.has(q.id))) send(); };
  const answer = (q, value) => {
    if (sent) return;
    answers.set(q.id, value);
    paint();
    settle();
  };
  const paint = () => {
    blocks.forEach(({ q, rows, other }) => {
      const got = answers.get(q.id);
      rows.forEach((row, i) => row.classList.toggle('is-picked', got?.choice === i));
      if (other && got?.other == null && doc.activeElement !== other) other.classList.remove('is-picked');
    });
    card.classList.toggle('is-answered-some', answers.size > 0);
  };

  card.append(el(doc, 'div', 'sb-rp-clarify-head', 'Question'));
  for (const q of questions) {
    const block = el(doc, 'div', 'sb-rp-clarify-q');
    block.dataset.question = q.id;
    block.append(el(doc, 'div', 'sb-rp-clarify-text', q.question));
    const rows = q.choices.map((choice, i) => {
      const row = el(doc, 'button', 'sb-rp-clarify-choice');
      row.append(el(doc, 'span', 'sb-rp-clarify-n', String(i + 1)), el(doc, 'span', 'sb-rp-clarify-label', choice));
      row.addEventListener('click', () => answer(q, { choice: i, other: null }));
      block.append(row);
      return row;
    });
    let other = null;
    if (q.other) {
      other = el(doc, 'div', 'sb-rp-clarify-other');
      other.setAttribute('contenteditable', 'plaintext-only');
      other.dataset.placeholder = 'Other…';
      other.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const text = other.textContent.trim();
          if (text) answer(q, { choice: null, other: text });
        }
      });
      block.append(other);
    }
    blocks.push({ q, rows, other });
    card.append(block);
  }

  const decide = el(doc, 'button', 'sb-rp-clarify-decide', 'You decide');
  decide.addEventListener('click', () => {
    for (const q of questions) if (!answers.has(q.id)) answers.set(q.id, { choice: null, other: null });
    paint();
    send();
  });
  card.append(decide);

  // A number key answers the first question still open, so a keyboard-only researcher never needs the mouse.
  card.addEventListener('keydown', (event) => {
    if (sent || event.metaKey || event.ctrlKey || event.altKey) return;
    const n = Number(event.key);
    if (!Number.isInteger(n) || n < 1) return;
    const q = questions.find((x) => !answers.has(x.id));
    if (q && n <= q.choices.length) { event.preventDefault(); answer(q, { choice: n - 1, other: null }); }
  });
  return card;
}

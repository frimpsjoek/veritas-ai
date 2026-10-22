// @ts-nocheck -- harness glue (loose window globals), like the other pages in this folder.
// ui-src/dev/harness/artifacts.js. Builds the artifact scenario for artifacts.html and hands dev/artifacts-checks.mjs
// what it needs on `window.__sbA`: the chat, its fake host and session store, and helpers for the streaming and
// Find papers scenarios. Invented content only (test/fixtures/artifacts.js).
import { createFakeHost, createSessionStore } from './fake-host.js';
import { sessionResults } from '../../test/fixtures/artifacts.js';

const params = new URLSearchParams(location.search);
const obsidian = params.get('tokens') === 'obsidian';
document.getElementById('tokens').setAttribute('href', obsidian ? '../../styles/tokens-obsidian.css' : '../../styles/tokens-zotero.css');
if (params.get('theme') === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
if (obsidian) {
  const standins = document.getElementById('standins');
  standins.textContent = standins.textContent.replace(':root[data-theme="dark"] {', ':root[data-theme="dark"] body {').replace(/:root \{/, 'body {');
}
if (params.get('bare')) document.body.classList.add('bare');

const frame = document.getElementById('frame');
const width = params.get('w');
frame.style.cssText = `${width ? `width:${width}px;` : ''} height:${params.get('bare') ? '100vh' : '720px'}; border:${params.get('bare') ? '0' : '1px solid var(--sb-ui-line)'};`;

const summaryOf = (versions, id) => {
  const v = versions[versions.length - 1];
  return { ref: { id, version: versions.length }, kind: v.kind, title: v.title, versions: versions.length, rows: v.rows.length, columns: v.columns.map((c) => c.name), updated: v.created };
};
const summaryAt = (results, id, version) => summaryOf(results[id].slice(0, version), id);

/** The session as the engine would store it: R1 (papers, V1 then V2), R2 (a chat-made table, V1 then V2). */
function records(results) {
  const at = (t) => `2026-09-28T${t}:00.000Z`;
  const assistant = (text, extra) => ({ type: 'assistant', answer: { text, citations: [], structured: null, usage: {} }, model: { provider: 'x', model: 'y' }, activities: [], at: at('11:00'), ...extra });
  return [
    { type: 'meta', id: 'conv1', mode: 'chat', title: 'Vole foraging', created: at('09:00') },
    { type: 'result', summary: summaryAt(results, 'R1', 1), at: at('09:00') },
    { type: 'result', summary: summaryAt(results, 'R1', 2), at: at('10:30') },
    { type: 'user', text: 'Which models describe how voles forage?', attachments: [], web: 'off', at: at('10:50') },
    { type: 'result', summary: summaryAt(results, 'R2', 1), at: at('10:55') },
    { type: 'step_end', id: 'S2', status: 'done', writes: [{ id: 'R2', version: 1 }], at: at('10:55') },
    assistant('Two models describe it: a patch-leaving model and a central-place model. I put them side by side in a table.', { step: 'S2' }),
    { type: 'result', summary: summaryAt(results, 'R2', 2), at: at('11:00') },
    { type: 'user', text: 'Make a table of every hoarding paper.', attachments: [], web: 'off', at: at('11:05') },
    assistant('Here is a list instead.', { notice: "Couldn't turn this into a table" }),
  ];
}

const kind = obsidian ? 'obsidian' : 'zotero';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plainReply = () => (async function* () { yield { type: 'done', answer: { text: 'ok', citations: [], structured: null, usage: {} } }; })();
/** A scripted answer about a paper set (spec 007 E5): streams two deltas, cites one paper of the set and one outside it
 *  (the engine marks that one `unknown`), then `done`. The table ask answers with a table result, as the chat would. */
function answerOn(input) {
  const cited = 'Voles leave a patch when the return falls below the average [@bramblewood2021; @stranger2020].';
  return (async function* () {
    yield { type: 'text', delta: 'Voles leave a patch ' };
    await pause(40);
    yield { type: 'text', delta: 'when the return falls below the average [@bramblewood2021; @stranger2020].' };
    await pause(40);
    yield { type: 'done', answer: { text: cited, structured: null, usage: {}, citations: [
      { ref: { kind: 'paper', citekey: 'bramblewood2021' }, status: 'resolved', title: 'Foraging Strategies of the Lesser Spangled Vole' },
      { ref: { kind: 'paper', citekey: 'stranger2020' }, status: 'unknown' },
    ] } };
  })();
}

/** @param {object} [opts] extra createFakeHost options */
function build(opts = {}) {
  const results = sessionResults();
  const store = createSessionStore(results);
  store.records = records(results);
  const calls = [];
  const host = createFakeHost({ kind, placement: 'tab', calls, sessionStore: store, reply: (input) => (input.on ? answerOn(input) : plainReply()), ...opts });
  window.__opened = [];
  host.openRef = (ref) => window.__opened.push(ref);
  host.openLink = (url) => window.__opened.push({ kind: 'url', url });
  host.citeLabel = (citekey) => ({ label: { bramblewood2021: 'Bramblewood et al. 2021', hoarding2018: 'Acorn & Burrow 2018' }[citekey] ?? citekey });
  return { results, store, calls, host };
}

const ctx = build(params.get('nosave') ? { saveFile: false } : {});
if (params.get('nosave')) delete ctx.host.exportRows;
const chat = new SecondBrainUI.ChatView(ctx.host, document);
frame.append(chat.root);
/** A stream the check drives by hand: `push(event)` while the chat is reading, `end()` to finish. */
function controlled() {
  const queue = [];
  let wake = null;
  let ended = false;
  return {
    push(event) { queue.push(event); wake?.(); },
    end() { ended = true; wake?.(); },
    iter: { async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) { yield queue.shift(); continue; }
        if (ended) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    } },
  };
}
window.__sbA = { ...ctx, chat, build, frame, controlled };

await chat.openConversation('conv1');
// a session with results shows its cards under the answer; nothing more is needed to look at them
window.__sbA.ready = true;

// spec 005 C4 drift guard for the new components: the thread with its cards, and a loaded panel.
const classTree = (node) => {
  if (node.nodeType !== 1) return null;
  return { tag: node.tagName.toLowerCase(), cls: [...node.classList].sort(), kids: [...node.childNodes].map(classTree).filter(Boolean) };
};
const parity = build();
const parityChat = new SecondBrainUI.ChatView(parity.host, document);
await parityChat.openConversation('conv1');
const panel = new SecondBrainUI.ArtifactPanel({ host: parity.host, doc: document }, { onClose() {}, onExpand() {}, onChanged() {}, chat: parityChat });
await panel.open('conv1', { id: 'R1' }, 2);
window.__sbArtifactTrees = { 'artifact-thread': classTree(parityChat.thread), 'artifact-panel': classTree(panel.root), 'papers-chat': classTree(panel.pc.root) };
window.__sbHarnessReady = true;

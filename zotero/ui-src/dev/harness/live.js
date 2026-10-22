// @ts-nocheck -- harness glue (loose window globals), like the other pages in this folder.
// ui-src/dev/harness/live.js. Builds a ChatView on a fake host whose replies are event streams the checks push into by
// hand, for dev/live-checks.mjs (the live activity feed and the composer layout). Invented content only.
import { createFakeHost } from './fake-host.js';

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
frame.style.cssText = `${width ? `width:${width}px;` : ''} height:640px; border:${params.get('bare') ? '0' : '1px solid var(--sb-ui-line)'}; box-sizing:border-box; display:flex;`;

function channel() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(...events) { queue.push(...events); wake?.(); },
    end() { closed = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (closed) return;
        await new Promise((resolve) => { wake = resolve; });
        wake = null;
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const replies = [];
const finishes = [];
let view = null;

/** A ChatView in the frame, on a host whose every reply is a stream the checks feed by hand. */
async function make() {
  replies.length = 0; finishes.length = 0;
  const host = createFakeHost({ kind: obsidian ? 'obsidian' : 'zotero', placement: 'tab', calls: [],
    reply: () => { const ch = channel(); replies.push(ch); return ch; } });
  view = new SecondBrainUI.ChatView(host, document);
  view.setHistoryCollapsed(true);
  frame.replaceChildren(view.root);
  await sleep(60);
  return true;
}

/** Sends a message; the reply stream becomes stream `n` (0-based). */
async function start(question) {
  const before = replies.length;
  view.input.value = question;
  view.input.dispatchEvent(new Event('input'));
  finishes.push(view.submit());
  for (let i = 0; i < 200 && replies.length === before; i++) await sleep(5);
  return replies.length - 1;
}
const push = (n, events) => { replies[n].push(...events); return sleep(30); };
const end = async (n) => { replies[n].end(); await finishes[n]; await sleep(30); };

/** Paints stored lines as a reopened chat does. */
function reopen(record) {
  view.thread.replaceChildren();
  view.paintRecordedAnswer(view.thread, record);
  return true;
}

/** Find papers' summary turn: the same live list, on a FindView. Its reply is stream `n`. */
async function findSummary() {
  const fv = new SecondBrainUI.FindView(view, { saved: {
    id: 'find-live', query: 'vole hoarding', at: new Date(0).toISOString(), scope: { kind: 'library' }, sources: { papers: true, scholarly: true }, failed: [],
    rows: [{ title: 'A Paper', authors: ['A. Author'], year: 2024, venue: 'A Venue', doi: null, abstract: 'An abstract.', key: 'K1', citekey: 'author2024', sources: ['Your library'] }],
    summary: null } });
  frame.replaceChildren(fv.root);
  const before = replies.length;
  finishes.push(fv.summarize(fv.rows));
  for (let i = 0; i < 200 && replies.length === before; i++) await sleep(5);
  return replies.length - 1;
}

window.__sbL = { findSummary, make, start, push, end, reopen, sleep, get view() { return view; } };
window.__sbHarnessReady = true;

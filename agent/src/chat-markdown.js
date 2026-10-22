// @ts-check
// agent/src/chat-markdown.js. One readable Markdown file per chat (design goal 10), rebuilt from the chat's JSONL
// records. The JSONL under data/agent/chats stays the app's working store; this file is a mirror for the notes
// folder, so it is always rebuilt whole from the records and never read back.

/** Characters no file system or Obsidian link accepts in a name, plus control characters. */
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|#^[\]]/g;
const MAX_TITLE = 80;

/**
 * The short id in a mirror's name. A ULID's first 10 characters are its time (the first 8 change only once a
 * second), so two chats started in the same second would share a prefix; the last 8 are random.
 * @param {string} id
 */
export function shortId(id) {
  return id.slice(-8);
}

/** @param {string} title */
function safeTitle(title) {
  const clean = title.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, MAX_TITLE).trim();
  return clean || 'Untitled';
}

/** The suffix every mirror name of chat `id` ends with, whatever its title. @param {string} id */
export function mirrorSuffix(id) {
  return ` (${shortId(id)}).md`;
}

/**
 * @param {any[]} records a chat's JSONL records, in order (domain.d.ts SessionRecord)
 * @returns {{ name: string, text: string } | null} null when there is no `meta` record yet
 */
export function chatMarkdown(records) {
  const meta = records.find((r) => r.type === 'meta');
  if (!meta) return null;
  const rename = [...records].reverse().find((r) => r.type === 'rename');
  const title = rename?.title ?? meta.title ?? '(untitled)';
  // Opening a chat (`seen`) is not activity, the same rule as the history list (store.js summarize).
  const last = [...records].reverse().find((r) => r.type !== 'seen' && r.type !== 'meta' && r.at);
  const updated = last?.at ?? meta.created;

  const sections = [];
  for (const r of records) {
    if (r.type === 'user') sections.push(`## You\n\n${(r.text ?? '').trim()}`);
    else if (r.type === 'assistant') sections.push(`## Veritas\n\n${(r.answer?.text ?? '').trim()}`);
    else if (r.type === 'failed') sections.push(`## Veritas\n\n> The turn failed: ${r.error?.message ?? 'unknown error'}`);
  }

  const front = ['---', `id: ${meta.id}`, `created: ${meta.created}`, `updated: ${updated}`, 'type: chat', '---'].join('\n');
  const text = [front, `# ${title}`, ...sections].join('\n\n') + '\n';
  const name = `${String(meta.created).slice(0, 10)} ${safeTitle(title)}${mirrorSuffix(meta.id)}`;
  return { name, text };
}

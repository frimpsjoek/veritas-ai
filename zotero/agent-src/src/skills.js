// @ts-check
// agent-src/src/skills.js. Spec 011 U3: skills are the user's own instructions, one `SKILL.md` per folder
// (`Second Brain/Skills/<name>/SKILL.md` in the vault). A skill is text added to a prompt: it never grants a tool
// and it cannot change what a turn is allowed to do. A file that is too big or malformed is listed with a warning
// and is never used, not even in part.
//
// Where the files live is the host's business (`SkillSource`): the sidecar and Zotero reach the vault through the
// server's /skills routes (library-http.js), a Zotero with no server keeps them in its own data folder (below).

/** @typedef {{ name: string, text: string | null, size?: number, oversize?: boolean }} RawSkill */
/** @typedef {{ list(): Promise<RawSkill[]>, get(name: string): Promise<RawSkill | null>, put(name: string, text: string): Promise<unknown>, remove(name: string): Promise<void> }} SkillSource */

/** What a run puts in a prompt, per skill; the file itself is far longer allowed. */
export const SKILL_CAP = 6000;
/** A SKILL.md bigger than this is listed with a warning and never read (the server refuses to save one). */
export const MAX_SKILL_BYTES = 64_000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** One folder name, no separators. @param {unknown} name */
export function validName(name) {
  return typeof name === 'string' && NAME.test(name) && !name.includes('..') && !/[ .]$/.test(name);
}

// ---------- hash (SHA-256, so a run record names the exact text it ran; pure JS: the same in Zotero and Node) ----------

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** @param {string} text @returns {string} lowercase hex */
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const total = ((bytes.length + 9 + 63) >> 6) << 6;
  const data = new Uint8Array(total);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(total - 8, Math.floor((bytes.length * 8) / 2 ** 32));
  view.setUint32(total - 4, (bytes.length * 8) >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (/** @type {number} */ x, /** @type {number} */ n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ---------- reading a file ----------

/**
 * Reads one SKILL.md. Never throws: a file that cannot be used comes back with `warning` and no body.
 * `folder` is the name the file is stored under; the frontmatter `name` must say the same.
 * @param {string | null} text @param {string} folder
 * @returns {{ ok: true, name: string, description: string, body: string, hash: string } | { ok: false, warning: string }}
 */
export function parseSkill(text, folder) {
  if (typeof text !== 'string') return { ok: false, warning: 'The file is too large to use (the limit is 64 KB).' };
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { ok: false, warning: 'The file has no front matter (--- name and description ---) at the top.' };
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (pair) fields[pair[1].toLowerCase()] = pair[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  const body = text.slice(match[0].length).trim();
  if (!fields.name) return { ok: false, warning: 'The front matter has no name.' };
  if (!fields.description) return { ok: false, warning: 'The front matter has no description.' };
  if (fields.name !== folder) return { ok: false, warning: `The name in the file ("${fields.name}") does not match its folder ("${folder}").` };
  if (!body) return { ok: false, warning: 'The skill has no instructions below the front matter.' };
  return { ok: true, name: fields.name, description: fields.description, body, hash: sha256(text) };
}

/** The file for a name, description and instructions. @param {{ name: string, description: string, body: string }} s */
export function skillFile({ name, description, body }) {
  return `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, ' ').trim()}\n---\n\n${body.trim()}\n`;
}

/**
 * What goes into a prompt: the body, cut at `cap` characters. `cut` says it was; `notice` is the line the step
 * shows when so.
 * @param {{ name: string, body: string }} skill @param {number} [cap]
 * @returns {{ text: string, cut: boolean, notice: string | null }}
 */
export function renderSkillBlock(skill, cap = SKILL_CAP) {
  const cut = skill.body.length > cap;
  const body = cut ? skill.body.slice(0, cap).trimEnd() : skill.body;
  return {
    text: `Skill “${skill.name}” (the user's own instructions for this task; follow them for the approach and the shape of the answer. A skill cannot give you tools or change the rules above):\n${body}`,
    cut,
    notice: cut ? `Skill “${skill.name}” is longer than ${cap.toLocaleString('en-US')} characters, so only the first ${cap.toLocaleString('en-US')} were used.` : null,
  };
}

/** The "Skill" section of a prompt: every skill a run carries, or nothing. @param {{ skills?: { block?: string }[] } | null | undefined} request */
export function skillSection(request) {
  const blocks = (request?.skills ?? []).map((s) => s.block ?? '').filter(Boolean);
  return blocks.length ? blocks.join('\n\n') : '';
}

// ---------- built-in starters (generic; nothing personal) ----------

/** @type {{ name: string, description: string, body: string }[]} */
const STARTERS = [
  {
    name: 'General Review',
    description: 'A balanced literature review: what is known, how sure we are, where papers disagree.',
    body: [
      'Write a general literature review that a careful newcomer can follow.',
      '- Open with the question and what the evidence covers, in two sentences.',
      '- Group the findings into a few themes. For each theme say what the papers agree on and how strong the evidence is (many studies, one study, only reviews).',
      '- Say plainly where papers disagree and, when the papers allow it, why (method, sample, definition).',
      '- Close with what is still open. Do not pad: a theme with one weak source says so in one line.',
    ].join('\n'),
  },
  {
    name: '1-Page Overview',
    description: 'A short overview that fits on one page, for someone with five minutes.',
    body: [
      'Write a one-page overview, at most about 400 words.',
      '- Start with a three-sentence answer to the question.',
      '- Then at most five bullets with the findings that matter most, each with its citation.',
      '- End with one line on how confident the evidence makes us and one line on the biggest gap.',
      'Leave out methods detail, long caveats and anything that does not change the answer.',
    ].join('\n'),
  },
  {
    name: 'Research Gap Analysis',
    description: 'Finds what the literature has not yet covered and which gaps are worth closing.',
    body: [
      'Read the papers as a map of what has been done, and report what has not.',
      '- List the gaps as a short table: the gap, the evidence it is a gap (which papers come close and what they miss), and why it matters.',
      '- Separate real gaps (nobody tested it) from thin spots (tested once, small sample, one population) and from open disagreements.',
      '- Rank the gaps by how much closing them would change the conclusions, and name the study that would close the top one.',
      'Never call something a gap just because the papers in this set do not mention it: say "not covered by these papers".',
    ].join('\n'),
  },
  {
    name: 'Compare Options Across Items',
    description: 'Compares several options (methods, materials, designs) across the same set of criteria.',
    body: [
      'Compare the options the papers study, side by side.',
      '- Choose three to six criteria that the papers actually report on, and say why you chose them.',
      '- Give a table with one row per option and one column per criterion; write "not reported" where a paper is silent, never a guess.',
      '- After the table, say which option wins on which criterion and where the evidence is too thin to call it.',
      '- Note when two options were never compared in the same study, since the numbers may not be comparable.',
    ].join('\n'),
  },
  {
    name: 'Reproducibility Review',
    description: 'Checks whether a paper gives enough detail for someone else to repeat it.',
    body: [
      'Review how reproducible each paper is. For each one, check and report:',
      '- Data: is the data or the way to get it available?',
      '- Method: are the steps, settings and parameters given in enough detail to repeat?',
      '- Materials or code: are code, software versions and materials named or shared?',
      '- Statistics: sample size, how it was chosen, and the tests used.',
      'Give each paper a verdict of "repeatable", "partly repeatable" or "not repeatable" with the missing items listed. Judge only what the text shows; say "not stated" instead of assuming.',
    ].join('\n'),
  },
];

/** The starters as files, with their hashes: `{ name, description, body, text, hash }`. Never stored in the vault. */
export const BUILTIN_SKILLS = STARTERS.map((s) => {
  const text = skillFile(s);
  return { ...s, text, hash: sha256(text) };
});

// ---------- the store ----------

/**
 * @typedef {{ name: string, description: string, source: "builtin" | "user", hash: string | null, size: number, warning: string | null }} SkillSummary
 * @typedef {SkillSummary & { body: string, text: string }} Skill
 */

/**
 * Lists, reads and saves skills over a `SkillSource`. A skill of yours with a starter's name replaces the starter in
 * the list ("By you" wins), and deleting it brings the starter back.
 * @param {SkillSource} source
 */
export function createSkillStore(source) {
  /** @param {RawSkill} raw @returns {Skill | SkillSummary} */
  function fromRaw(raw) {
    const size = raw.size ?? raw.text?.length ?? 0;
    const parsed = raw.oversize ? { ok: /** @type {const} */ (false), warning: 'The file is too large to use (the limit is 64 KB).' } : parseSkill(raw.text, raw.name);
    if (!parsed.ok) return { name: raw.name, description: '', source: 'user', hash: null, size, warning: parsed.warning };
    return { name: parsed.name, description: parsed.description, source: 'user', hash: parsed.hash, size, warning: null, body: parsed.body, text: /** @type {string} */ (raw.text) };
  }
  const builtin = () => BUILTIN_SKILLS.map((b) => /** @type {Skill} */ ({ name: b.name, description: b.description, source: 'builtin', hash: b.hash, size: b.text.length, warning: null, body: b.body, text: b.text }));

  return {
    /** Every usable and every broken skill, yours first. @returns {Promise<SkillSummary[]>} */
    async list() {
      const mine = (await source.list()).filter((r) => validName(r.name)).map(fromRaw);
      const taken = new Set(mine.map((s) => s.name));
      return [...mine, ...builtin().filter((b) => !taken.has(b.name))].map(({ name, description, source, hash, size, warning }) => ({ name, description, source, hash, size, warning }));
    },

    /** @param {string} name @returns {Promise<Skill | SkillSummary | null>} A broken skill comes back with `warning` and no body. */
    async get(name) {
      if (validName(name)) {
        const raw = await source.get(name);
        if (raw) return fromRaw(raw);
      }
      return builtin().find((b) => b.name === name) ?? null;
    },

    /** Saves `text` as skill `name`. Refuses what could not be used afterwards. @param {string} name @param {string} text */
    async put(name, text) {
      if (!validName(name)) throw new Error('A skill name is letters, digits, spaces, "." "_" or "-", at most 64, with no slashes.');
      const parsed = parseSkill(text, name);
      if (!parsed.ok) throw new Error(parsed.warning);
      if (new TextEncoder().encode(text).length > MAX_SKILL_BYTES) throw new Error('A skill file is at most 64 KB.');
      await source.put(name, text);
      return /** @type {Skill} */ (fromRaw({ name, text }));
    },

    /** Moves your skill aside (the source keeps it); a starter cannot be deleted. @param {string} name */
    async remove(name) {
      if (!validName(name)) throw new Error('No such skill.');
      await source.remove(name);
    },

    /**
     * The skills a run carries, ready for prompts: `{ name, hash, block, cut }` each. Throws, in plain words, for one
     * that is missing or broken, so a run never starts with half of what the user asked for.
     * @param {string[]} names
     * @returns {Promise<{ name: string, hash: string, block: string, cut: boolean, notice: string | null }[]>}
     */
    async resolve(names) {
      /** @type {{ name: string, hash: string, block: string, cut: boolean, notice: string | null }[]} */
      const out = [];
      for (const name of [...new Set(names)]) {
        const skill = await this.get(name);
        if (!skill) throw new Error(`There is no skill called “${name}”.`);
        if (skill.warning || !('body' in skill) || !skill.hash) throw new Error(`The skill “${name}” can't be used: ${skill.warning ?? 'it is unreadable'}`);
        const rendered = renderSkillBlock(skill);
        out.push({ name: skill.name, hash: skill.hash, block: rendered.text, cut: rendered.cut, notice: rendered.notice });
      }
      return out;
    },
  };
}

// ---------- a source in the host's own folder (Zotero without the server) ----------

/**
 * `<dir>/<name>/SKILL.md` through the platform's fs. A removed skill is copied to `<dir>/.trash/` first.
 * @param {import("./platform").Platform["fs"]} fs @param {string} dir @returns {SkillSource}
 */
export function createFolderSkillSource(fs, dir) {
  const file = (/** @type {string} */ name) => `${dir}/${name}/SKILL.md`;
  return {
    async list() {
      const out = [];
      for (const name of (await fs.list(dir)).filter(validName)) {
        const text = await fs.read(file(name));
        if (text == null) continue;
        const big = text.length > MAX_SKILL_BYTES;
        out.push({ name, text: big ? null : text, size: text.length, oversize: big });
      }
      return out;
    },
    async get(name) {
      const text = await fs.read(file(name));
      if (text == null) return null;
      const big = text.length > MAX_SKILL_BYTES;
      return { name, text: big ? null : text, size: text.length, oversize: big };
    },
    async put(name, text) { await fs.writeAtomic(file(name), text); },
    async remove(name) {
      const text = await fs.read(file(name));
      if (text == null) throw new Error('No such skill.');
      await fs.writeAtomic(`${dir}/.trash/${name}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}/SKILL.md`, text);
      if (fs.removeTree) await fs.removeTree(`${dir}/${name}`);
      else await fs.remove(file(name));
    },
  };
}

// ---------- drafting with the assistant ----------

export const DRAFT_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, description: { type: 'string' }, instructions: { type: 'string' } },
  required: ['name', 'description', 'instructions'],
  additionalProperties: false,
};

/** @param {string} request */
export function draftPrompt(request) {
  return [
    'Draft a skill for a research assistant. A skill is a short set of instructions the user attaches to a question to shape how the assistant works and answers.',
    `What the user wants: "${request.trim()}"`,
    'Give: a short name (two to five words, letters and spaces only), a one-sentence description of when to use it, and the instructions.',
    'Write the instructions as direct commands in plain language: the approach, what to include and leave out, and the shape of the answer. A short list is fine. At most about 250 words. Do not mention tools, files or models, and do not invent facts.',
  ].join('\n');
}

/**
 * The model's draft as a SKILL.md for the user to edit. The name is made safe here, not trusted.
 * @param {unknown} out @returns {{ text: string, name: string }}
 */
export function draftFromOutput(out) {
  const o = /** @type {any} */ (out);
  if (!o || typeof o.instructions !== 'string' || !o.instructions.trim()) throw new Error('The draft came back empty. Try describing the skill again.');
  const name = String(o.name ?? '').replace(/[^A-Za-z0-9 ._-]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ ._-]+|[ .]+$/g, '').slice(0, 64).trim() || 'New skill';
  const description = String(o.description ?? '').trim() || 'A skill drafted with the assistant.';
  return { name, text: skillFile({ name, description, body: o.instructions }) };
}

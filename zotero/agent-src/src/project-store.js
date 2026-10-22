// @ts-check
// agent-src/src/project-store.js. Spec 011 U5: a project is a label (Zotero collection semantics), one JSON file at
// `<dataDir>/projects/<id>.json` holding only `{ id, name, created, updated }`. Which chats and reports belong to it
// is stored in the members themselves (a `project` record in the chat, a field in the report's request.json), so
// deleting a project deletes this file and nothing else. A file that does not parse is skipped, never fatal.

/** @typedef {import("./domain").Project} Project */
/** @typedef {Pick<import("./platform").Platform['fs'], 'read' | 'writeAtomic' | 'list' | 'remove'>} ProjectFs */

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const MAX_NAME = 80;
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : -Infinity; };

/** A record that can safely be written: a path-safe id and a non-empty name. @param {any} r */
function usable(r) {
  return Boolean(r) && typeof r === 'object' && typeof r.id === 'string' && SAFE_ID.test(r.id) && typeof r.name === 'string' && r.name.trim() !== '';
}

/** The name as it will be stored, or a plain-language refusal. @param {unknown} name */
export function cleanName(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Give the project a name.');
  if (text.length > MAX_NAME) throw new Error(`A project name can be at most ${MAX_NAME} characters.`);
  return text;
}

/**
 * The record that results from two copies of one project: the later-updated one.
 * @param {Project} a @param {Project} b @returns {Project}
 */
export function mergeProjects(a, b) { return ms(b.updated) > ms(a.updated) ? b : a; }

/**
 * @param {ProjectFs} fs @param {string} dataDir the agent data directory (projects live under `<dataDir>/projects`)
 */
export function createProjectStore(fs, dataDir) {
  const dir = `${dataDir}/projects`;
  /** @param {string} id */
  const file = (id) => {
    if (!SAFE_ID.test(String(id))) throw new Error('There is no project with that id.');
    return `${dir}/${id}.json`;
  };

  /** @param {string} id @returns {Promise<Project | null>} */
  async function read(id) {
    const text = await fs.read(file(id));
    if (text == null) return null;
    try {
      const r = JSON.parse(text);
      return usable(r) ? r : null;
    } catch { return null; }
  }

  /** @param {Project} project */
  async function write(project) {
    await fs.writeAtomic(file(project.id), JSON.stringify(project, null, 2));
    return project;
  }

  return {
    read,
    /** Every readable project, by name. @returns {Promise<Project[]>} */
    async list() {
      const out = [];
      for (const name of await fs.list(dir)) {
        if (!name.endsWith('.json') || !SAFE_ID.test(name.slice(0, -5))) continue;
        const p = await read(name.slice(0, -5));
        if (p) out.push(p);
      }
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));
    },
    /** @param {string} id @param {string} name @param {string} now ISO time @returns {Promise<Project>} */
    async create(id, name, now) {
      return write({ id, name: cleanName(name), created: now, updated: now });
    },
    /** @param {string} id @param {string} name @param {string} now ISO time @returns {Promise<Project>} */
    async rename(id, name, now) {
      const have = await read(id);
      if (!have) throw new Error('There is no project with that id.');
      return write({ ...have, name: cleanName(name), updated: now });
    },
    /** Deletes the project's file only; its chats and reports are left alone. @param {string} id */
    async remove(id) { await fs.remove(file(id)); },
    /**
     * Brings projects made elsewhere (Zotero's own data folder) into this store. Idempotent by id: one we already
     * hold keeps the later `updated`, so adopting twice changes nothing. Returns the ids taken in.
     * @param {Project[]} records @returns {Promise<string[]>}
     */
    async adopt(records) {
      const ids = [];
      for (const incoming of records ?? []) {
        if (!usable(incoming)) continue;
        const have = await read(incoming.id);
        const next = have ? mergeProjects(have, incoming) : incoming;
        if (!have || JSON.stringify(next) !== JSON.stringify(have)) await write(next);
        ids.push(incoming.id);
      }
      return ids;
    },
  };
}

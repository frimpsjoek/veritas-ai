// The real content/ui-host-zotero.js prefs, run over a fake Zotero.Prefs that is as strict as Zotero's: set() throws on
// null/undefined and stores any object as its string form (so an object that was not JSON-encoded reads back as
// "[object Object]"). Returns the host's `prefs` and the raw store.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../../content/ui-host-zotero.js', import.meta.url), 'utf8');

export function zoteroHostPrefs() {
  /** @type {Map<string, any>} */
  const raw = new Map();
  const Prefs = {
    get: (key) => raw.get(key),
    set(key, value) {
      if (value === null || value === undefined) throw new Error(`Zotero.Prefs.set(${key}): invalid value`);
      raw.set(key, typeof value === 'object' ? String(value) : value);
    },
    clear: (key) => { raw.delete(key); },
  };
  const SecondBrain = {};
  vm.runInNewContext(SOURCE, { JSON, SecondBrain, SecondBrainUI: {}, Zotero: { Prefs, DataDirectory: { dir: '/z' }, logError() {} }, PathUtils: { join: (...p) => p.join('/'), parent: (p) => p }, IOUtils: {}, Services: {}, ChromeUtils: {} });
  const host = SecondBrain.createZoteroHost({}, {}, {});
  return { prefs: host.prefs, raw };
}

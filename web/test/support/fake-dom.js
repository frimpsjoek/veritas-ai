// @ts-check
// A small fake DOM for the web app's view tests: elements that keep their children, attributes, classes and click
// listeners, and a window whose events can be dispatched and counted. Shared by read-later.test.js and the reader's.

export function fakeWin() {
  /** @type {Map<string, Set<(e: any) => void>>} */ const on = new Map();
  return {
    CustomEvent: class { constructor(/** @type {string} */ type, /** @type {any} */ init) { this.type = type; this.detail = init?.detail; } },
    addEventListener(/** @type {string} */ type, /** @type {any} */ fn) { if (!on.has(type)) on.set(type, new Set()); on.get(type)?.add(fn); },
    removeEventListener(/** @type {string} */ type, /** @type {any} */ fn) { on.get(type)?.delete(fn); },
    dispatchEvent(/** @type {any} */ event) { for (const fn of [...(on.get(event.type) ?? [])]) fn(event); return true; },
    /** how many listeners `type` has */
    count: (/** @type {string} */ type) => on.get(type)?.size ?? 0,
    location: { protocol: 'http:' },
  };
}

export function fakeDoc() {
  const win = fakeWin();
  /** @type {any} */ let doc = null;
  const element = (/** @type {string} */ _ns, /** @type {string} */ tag) => {
    /** @type {Record<string, ((event?: any) => any)[]>} */ const on = {};
    const classes = new Set();
    const el = {
      tag, attrs: /** @type {Record<string, string>} */ ({}), dataset: /** @type {Record<string, string>} */ ({}), title: '', href: '', hidden: false, disabled: false, isConnected: true,
      kids: /** @type {any[]} */ ([]), _text: '',
      get ownerDocument() { return doc; },
      get className() { return [...classes].join(' '); },
      set className(/** @type {string} */ v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
      classList: { toggle: (/** @type {string} */ c, /** @type {boolean} */ add) => { if (add) classes.add(c); else classes.delete(c); }, add: (/** @type {string} */ c) => classes.add(c), contains: (/** @type {string} */ c) => classes.has(c) },
      setAttribute(/** @type {string} */ k, /** @type {string} */ v) { el.attrs[k] = String(v); },
      getAttribute(/** @type {string} */ k) { return el.attrs[k] ?? null; },
      append(/** @type {any[]} */ ...nodes) { el.kids.push(...nodes); },
      replaceChildren(/** @type {any[]} */ ...nodes) { el.kids = nodes; el._text = ''; },
      addEventListener(/** @type {string} */ type, /** @type {(event?: any) => any} */ fn) { (on[type] ??= []).push(fn); },
      /** runs the listeners for `type`, as a fired event would */
      dispatch: (/** @type {string} */ type) => Promise.all((on[type] ?? []).map((fn) => fn({ stopPropagation() {}, preventDefault() {} }))),
      click: () => Promise.all((on.click ?? []).map((fn) => fn({ stopPropagation() {}, preventDefault() {}, metaKey: false, ctrlKey: false, shiftKey: false }))),
      set textContent(/** @type {string} */ v) { el._text = String(v); el.kids = []; },
      get textContent() { return el._text + el.kids.map((/** @type {any} */ k) => (typeof k === 'string' ? k : k.textContent ?? '')).join(''); },
      /** every element below, depth first */
      all() { return el.kids.flatMap((/** @type {any} */ k) => (typeof k === 'object' && k.all ? [k, ...k.all()] : [])); },
    };
    return el;
  };
  /** @type {Record<string, ((event?: any) => any)[]>} */ const on = {};
  return doc = {
    defaultView: win, createElementNS: element, createDocumentFragment: () => element('', '#fragment'), createTextNode: (/** @type {string} */ t) => ({ textContent: t }), activeElement: null,
    addEventListener(/** @type {string} */ type, /** @type {(event?: any) => any} */ fn) { (on[type] ??= []).push(fn); },
  };
}

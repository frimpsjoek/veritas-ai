// @ts-check
// ui-src/src/chat/collection-tree.js. Spec 008 Z4: the "Where to look" picker's collection checkboxes, over the
// flat CollectionNode[] a host lists (host.d.ts's collections()). Its own file so chat.js's edits for it stay
// limited to the scope picker (another change in flight there touches streaming and the composer). Ticking a
// parent ticks every descendant; a parent with some but not all descendants ticked shows indeterminate. The
// filter box narrows by name, keeping a match's ancestors visible so its position in the tree stays legible.
// getKeys() returns only the topmost ticked key per branch: a parent's key already covers its descendants
// server-side (spec 008 Z2), so a checked child under a checked parent would just be a redundant key.
import { el, installStyle } from './dom-helpers.js';

/** @typedef {import("../host").CollectionNode} CollectionNode */

/** @param {CollectionNode[]} nodes @returns {Map<string|null, CollectionNode[]>} parent key (root: null) -> children, name-sorted */
function byParent(nodes) {
  const map = new Map();
  for (const node of nodes) {
    const list = map.get(node.parent) ?? [];
    list.push(node);
    map.set(node.parent, list);
  }
  for (const list of map.values()) list.sort((/** @type {CollectionNode} */ a, /** @type {CollectionNode} */ b) => a.name.localeCompare(b.name));
  return map;
}

export class CollectionTree {
  /**
   * @param {Document} doc @param {CollectionNode[]} nodes @param {string[]} [initialKeys]
   * @param {() => void} [onChange] called after every tick change (this.checked is already updated)
   */
  constructor(doc, nodes, initialKeys = [], onChange) {
    this.doc = doc;
    this.nodes = nodes;
    this.byKey = new Map(nodes.map((n) => [n.key, n]));
    this.children = byParent(nodes);
    this.onChange = onChange;
    /** Every node whose checkbox is ticked, including descendants a parent tick implies. Not the same as
     *  getKeys(): this set is for state tracking, getKeys() is what gets sent as the scope. */
    this.checked = new Set();
    /** @type {Map<string, HTMLElement>} */
    this.rows = new Map();
    /** @type {Map<string, HTMLInputElement>} */
    this.boxes = new Map();

    this.root = el(doc, 'div', 'sb-ai-scope-tree');
    this.filterInput = /** @type {HTMLInputElement} */ (el(doc, 'input', 'sb-ai-scope-filter'));
    this.filterInput.type = 'search';
    this.filterInput.placeholder = 'Filter collections…';
    this.filterInput.addEventListener('input', () => this.applyFilter());
    this.list = el(doc, 'div', 'sb-ai-scope-list');
    this.root.append(this.filterInput, this.list);

    this.setKeys(initialKeys);
    this.render();
  }

  /** Ticks exactly these keys (and every descendant of each), unticking everything else — for seeding the tree
   *  from a scope already chosen (reopening the picker, a saved Find papers search). Silent: no onChange, no
   *  DOM update (render()/refreshTriState() do that once the tree is built).
   * @param {string[]} keys */
  setKeys(keys) {
    this.checked = new Set();
    for (const key of keys) this.markSubtree(key, true);
  }

  /** @param {string} key @returns {string[]} */
  descendantsOf(key) {
    /** @type {string[]} */
    const out = [];
    const walk = (/** @type {string} */ k) => { for (const child of this.children.get(k) ?? []) { out.push(child.key); walk(child.key); } };
    walk(key);
    return out;
  }

  /** @param {string} key @returns {string[]} */
  ancestorsOf(key) {
    /** @type {string[]} */
    const out = [];
    let node = this.byKey.get(key);
    while (node && node.parent) { out.push(node.parent); node = this.byKey.get(node.parent); }
    return out;
  }

  /** @param {string} key @param {boolean} checked */
  markSubtree(key, checked) {
    for (const k of [key, ...this.descendantsOf(key)]) { if (checked) this.checked.add(k); else this.checked.delete(k); }
  }

  /** @param {string} key @returns {"checked"|"unchecked"|"indeterminate"} */
  stateOf(key) {
    if (this.checked.has(key)) return 'checked';
    return this.descendantsOf(key).some((k) => this.checked.has(k)) ? 'indeterminate' : 'unchecked';
  }

  refreshTriState() {
    for (const [key, box] of this.boxes) {
      const state = this.stateOf(key);
      box.checked = state === 'checked';
      box.indeterminate = state === 'indeterminate';
    }
  }

  /** @param {string} key */
  toggle(key) {
    this.markSubtree(key, !this.checked.has(key));
    // A parent whose every child just became ticked is itself now "everything under here": tick it too, and
    // keep walking up. Unticking any child means an ancestor is no longer that, however many siblings remain.
    for (const ancestor of this.ancestorsOf(key)) {
      const allChecked = (this.children.get(ancestor) ?? []).every((c) => this.checked.has(c.key));
      if (allChecked) this.checked.add(ancestor); else this.checked.delete(ancestor);
    }
    this.refreshTriState();
    this.onChange?.();
  }

  /** The keys to search: only the topmost ticked key in each branch (a checked child under a checked parent is
   *  redundant, Z2). */
  getKeys() {
    return [...this.checked].filter((key) => {
      const parent = this.byKey.get(key)?.parent ?? null;
      return parent === null || !this.checked.has(parent);
    });
  }

  applyFilter() {
    const query = this.filterInput.value.trim().toLowerCase();
    const matchKeys = query ? this.nodes.filter((n) => n.name.toLowerCase().includes(query)).map((n) => n.key) : null;
    const visible = matchKeys ? new Set(matchKeys.flatMap((key) => [key, ...this.ancestorsOf(key)])) : null;
    for (const [key, row] of this.rows) row.hidden = !!visible && !visible.has(key);
  }

  render() {
    this.list.replaceChildren();
    this.rows = new Map();
    this.boxes = new Map();
    const build = (/** @type {string|null} */ parentKey, /** @type {number} */ depth) => {
      for (const node of this.children.get(parentKey) ?? []) {
        const row = el(this.doc, 'label', 'sb-ai-scope-row');
        row.style.paddingInlineStart = `${4 + depth * 16}px`;
        const box = /** @type {HTMLInputElement} */ (el(this.doc, 'input'));
        box.type = 'checkbox';
        const state = this.stateOf(node.key);
        box.checked = state === 'checked';
        box.indeterminate = state === 'indeterminate';
        box.addEventListener('change', () => this.toggle(node.key));
        row.append(box, el(this.doc, 'span', 'sb-ai-scope-name', node.name), el(this.doc, 'span', 'sb-ai-scope-count', String(node.count)));
        this.list.append(row);
        this.rows.set(node.key, row);
        this.boxes.set(node.key, box);
        build(node.key, depth + 1);
      }
    };
    build(null, 0);
    this.applyFilter();
  }

  /** @param {Document} doc */
  static style(doc) {
    installStyle(doc, 'second-brain-scope-tree-style', TREE_CSS);
  }
}

const TREE_CSS = `
.sb-ai-scope-tree { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.sb-ai-scope-filter { font: inherit; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--sb-ui-line);
	background: var(--sb-ui-bg); color: var(--sb-ui-text); }
.sb-ai-scope-list { display: flex; flex-direction: column; max-height: 220px; overflow-y: auto; gap: 1px; }
.sb-ai-scope-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px;
	border-radius: 6px; cursor: pointer; }
.sb-ai-scope-row:hover { background: var(--sb-ui-hover); }
.sb-ai-scope-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--sb-ui-text); }
.sb-ai-scope-count { font-size: 11px; color: var(--sb-ui-muted); }
`;

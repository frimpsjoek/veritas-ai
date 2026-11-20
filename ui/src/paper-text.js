// @ts-check
// ui-src/src/paper-text.js. A paper's title or abstract as a reader writes it. arXiv gives both in the TeX they were
// submitted in: "Re$_{6}$Se$_{8}$Cl$_{2}$", "M{\o}ller-Plesset", "a time step $\tau$", "Jordan--Wigner",
// "\ce{C2H4O}", "\textit{J. Chem. Phys.} \textbf{160}". The pure part is here (what each piece of the text is);
// paperNodes draws it, plainText makes one string of it for the places that hold only text (a bar, a tab).
import { plainName } from '../../agent/src/paper-names.js';
import { mathNode } from './chat/markdown.js';

/** @typedef {{ text: string, italic?: true, bold?: true } | { sub: string } | { sup: string } | { tex: string, display?: true }} PaperPart */

// $...$ with no space inside either dollar. A dollar glued to a word ("Re$_{6}$", "TD$GW$-MD") is math only when it
// opens with _ or ^, or follows a letter and opens with a letter or a command; a closing dollar before a digit is not
// one, so "$5 and $10", "$5–$10" and "US$5" stay money.
const MATH = /\$(?=[^\s$])([^$\n]{0,119}?[^\s$\\])\$(?!\d)/g;
// In an answer the server marked as math (arXiv's own pages): \(…\), \[…\], $$…$$ and $…$, the last also glued to a
// word; the money rules stay (no space inside the dollars, no digit after the closing one).
export const ANY_MATH = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$\$(.+?)\$\$|(?<![\\$])\$(?=[^\s$])((?:[^$\n]|\\\$)*?[^\s$\\])\$(?![\d$])/g;
// A lone subscript or superscript of letters, digits and signs: drawn as <sub>/<sup>, in the text's own letters.
const SCRIPT = /^([_^])\s*(?:\{\s*([A-Za-z0-9+\-−.,*]+|\\prime)\s*\}|([A-Za-z0-9+\-−*])|(\\prime))$/;
// The commands that hold words: a formula (mhchem), italic, bold. Their braces may nest (\ce{Fe^{2+}}).
const COMMAND = /\\(ce|textit|emph|textbf)\s*\{/g;
// What \ce{…} reads: formulas, charges, bonds and arrows. Anything else (a command, an arrow's condition) is shown
// as its inner text.
const CHEM = /^[A-Za-z0-9()[\]+\-=#^_{}.,·*\s<>]*$/;

/** Words with their TeX as text: accents as letters, -- and --- as dashes, quotes, and the braces and commands that
 *  only set the type. Math is not for here. @param {unknown} value */
export function plainProse(value) {
  let text = String(value ?? '');
  if (!/[\\{}~`]|--|''/.test(text)) return text;
  text = text
    .replace(/\\(?:textit|textbf|textrm|textsc|textsf|texttt|emph|mathrm|mbox|text)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\([%&#_$])/g, '$1')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/---/g, '—').replace(/--/g, '–')
    .replace(/``/g, '“').replace(/''/g, '”')
    .replace(/~/g, ' ');
  // plainName turns accents into letters and drops the braces round them; it leaves text without a backslash alone
  // (and trims, so the spaces at either end are put back)
  text = `${/^\s*/.exec(text)?.[0] ?? ''}${plainName(text)}${/\s*$/.exec(text.trim() ? text : '')?.[0] ?? ''}`;
  return text.replace(/\{([^{}]*)\}/g, '$1');
}

/** The script's own text: \prime as a prime, a hyphen as a minus sign. @param {string} s */
const scriptText = (s) => (s === '\\prime' ? '′' : s.replace(/-/g, '−'));

/** Where the brace opened at `open` closes, or -1. @param {string} text @param {number} open */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

/** \ce{…} as parts (R1): digits after an atom or a closing bracket are subscripts, - between atoms is a bond (–),
 *  ^{2+} and ^- are superscripts, -> is →; = and # stay. @param {string} inner @returns {PaperPart[]} */
function chemParts(inner) {
  if (!CHEM.test(inner)) return [{ text: plainProse(inner).replace(/\\([A-Za-z]+)/g, '$1').replace(/[\\{}]/g, '') }];
  /** @type {PaperPart[]} */ const parts = [];
  const text = (/** @type {string} */ s) => parts.push({ text: s });
  let atom = false; // the last thing was an atom or a closing bracket
  for (let i = 0; i < inner.length;) {
    const rest = inner.slice(i);
    /** @type {RegExpExecArray | null} */ let m;
    if ((m = /^(?:<=>|<->|->|<-)/.exec(rest))) { text({ '<=>': '⇌', '<->': '↔', '->': '→', '<-': '←' }[m[0]] ?? m[0]); atom = false; }
    else if ((m = /^\^(?:\{([^{}]*)\}|(\d*[+\-]|\d+|[A-Za-z]))/.exec(rest))) { parts.push({ sup: scriptText(m[1] ?? m[2]) }); atom = false; }
    else if ((m = /^_(?:\{([^{}]*)\}|([A-Za-z0-9]+))/.exec(rest))) { parts.push({ sub: scriptText(m[1] ?? m[2]) }); atom = false; }
    else if (atom && (m = /^\d+/.exec(rest))) { parts.push({ sub: m[0] }); atom = false; }
    else if (atom && (m = /^-(?=[A-Za-z([])/.exec(rest))) { text('–'); atom = false; }
    else { m = /^[\s\S]/.exec(rest); const ch = /** @type {string} */ (m?.[0]); if (ch !== '{' && ch !== '}') text(ch); atom = /[A-Za-z)\]]/.test(ch); }
    i += /** @type {RegExpExecArray} */ (m)[0].length;
  }
  return parts;
}

/** A run with no word command: its math found, its words as text. @param {string} text @param {boolean} loose an
 *  answer known to hold math (ANY_MATH) @param {PaperPart[]} parts */
function mathRun(text, loose, parts) {
  const words = (/** @type {string} */ s) => { const t = plainProse(s); if (t) parts.push({ text: t }); };
  let at = 0;
  for (const m of text.matchAll(loose ? ANY_MATH : MATH)) {
    const display = loose && (m[2] != null || m[3] != null);
    const inner = loose ? (m[1] ?? m[2] ?? m[3] ?? m[4]).trim() : m[1];
    const before = text[m.index - 1] ?? '';
    if (!loose && /[\w$\\]/.test(before) && !/^[_^]/.test(inner) && !(/[A-Za-z]/.test(before) && /^[A-Za-z\\]/.test(inner))) continue;
    words(text.slice(at, m.index));
    const script = display ? null : SCRIPT.exec(inner);
    if (script) parts.push(script[1] === '_' ? { sub: scriptText(script[2] ?? script[3] ?? script[4]) } : { sup: scriptText(script[2] ?? script[3] ?? script[4]) });
    else parts.push(display ? { tex: inner, display: true } : { tex: inner });
    at = m.index + m[0].length;
  }
  words(text.slice(at));
}

/** `text` as pieces: words (italic or bold where TeX says so), subscripts, superscripts and formulas to draw.
 *  `math`: the server marked the answer as holding math, so \(…\) and $$…$$ count too.
 *  @param {unknown} value @param {{ math?: boolean }} [o] @returns {PaperPart[]} */
export function paperParts(value, { math = false } = {}) {
  const text = String(value ?? '');
  /** @type {PaperPart[]} */
  const parts = [];
  let at = 0;
  const re = new RegExp(COMMAND.source, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1, end = closing(text, open);
    if (end < 0) continue;
    mathRun(text.slice(at, m.index), math, parts);
    const inner = text.slice(open + 1, end);
    if (m[1] === 'ce') parts.push(...chemParts(inner));
    else {
      const style = m[1] === 'textbf' ? { bold: /** @type {true} */ (true) } : { italic: /** @type {true} */ (true) };
      for (const p of paperParts(inner, { math })) parts.push('text' in p ? { ...p, ...style } : p);
    }
    at = end + 1;
    re.lastIndex = at;
  }
  mathRun(text.slice(at), math, parts);
  // words next to words in the same type are one piece
  /** @type {PaperPart[]} */ const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && 'text' in last && 'text' in p && last.italic === p.italic && last.bold === p.bold) out[out.length - 1] = { ...last, text: last.text + p.text };
    else out.push(p);
  }
  return out;
}

/**
 * TeX for a display equation: lines broken with \\ outside any environment get one, as KaTeX draws them only inside one.
 * @param {string} tex
 */
export function displayTex(tex) {
  const outside = tex.replace(/\\begin\{([a-z*]+)\}[\s\S]*?\\end\{\1\}/g, '');
  return outside.includes('\\\\') ? `\\begin{gathered}${tex}\\end{gathered}` : tex;
}

/** A title or abstract drawn: formulas as math, subscripts and superscripts set, italic and bold, the rest as text.
 *  What is sorted, searched, copied or sent on keeps the raw string.
 *  @param {Document} doc @param {unknown} text @param {{ math?: boolean }} [o] @returns {DocumentFragment} */
export function paperNodes(doc, text, o) {
  const make = (/** @type {string} */ tag) => doc.createElementNS('http://www.w3.org/1999/xhtml', tag);
  /** Plain words as strings, everything drawn (italic, bold, scripts, math) as nodes. @type {(string | Node)[]} */
  const pieces = [];
  for (const part of paperParts(text, o)) {
    if ('text' in part) {
      if (!part.italic && !part.bold) { pieces.push(part.text); continue; }
      /** @type {Node} */ let node = doc.createTextNode(part.text);
      for (const [on, tag] of /** @type {const} */ ([[part.italic, 'i'], [part.bold, 'b']])) {
        if (!on) continue;
        const el = make(tag);
        el.append(node);
        node = el;
      }
      pieces.push(node);
    } else if ('tex' in part) pieces.push(mathNode(doc, part.display ? displayTex(part.tex) : part.tex, Boolean(part.display)));
    else {
      const el = make('sub' in part ? 'sub' : 'sup');
      el.textContent = 'sub' in part ? part.sub : part.sup;
      pieces.push(el);
    }
  }
  return glueWords(doc, pieces);
}

/** How a piece of drawn text sits in a line: a math holder is one box, so a line may break at either edge of it,
 *  splitting "TD$GW$-MD" into "TDGW" and "-MD"; a display equation is a block of its own; italic, bold and scripts
 *  break only where their text has a space, like plain words. @param {string | Node} piece */
const pieceKind = (piece) => {
  if (typeof piece === 'string') return 'text';
  const classes = /** @type {any} */ (piece).classList;
  if (classes?.contains('sb-math-block')) return 'block';
  if (classes?.contains('sb-math')) return 'atom';
  // an italic or bold phrase of several words must keep its own places to break, even beside a formula
  return /\s/.test(/** @type {any} */ (piece).textContent ?? '') ? 'spaced' : 'inline';
};

/**
 * The pieces in words: a word that holds an inline formula and anything glued to it is a group to keep on one line;
 * everything else is passed on as it is. Pure, for tests: `kind` says what each piece is (pieceKind).
 * @template P @param {(string | P)[]} pieces @param {(piece: string | P) => 'text' | 'atom' | 'inline' | 'spaced' | 'block'} kind
 * @returns {(string | P | { glue: (string | P)[] })[]}
 */
export function wordGroups(pieces, kind) {
  /** @type {(string | P | { glue: (string | P)[] })[]} */ const out = [];
  /** @type {(string | P)[]} */ let word = [];
  let atom = false;
  const flush = () => {
    if (atom && word.length > 1) out.push({ glue: word }); else out.push(...word);
    word = [];
    atom = false;
  };
  for (const piece of pieces) {
    const k = kind(piece);
    // a block, or a drawn phrase with spaces in it, is never part of a glued word
    if (k === 'block' || k === 'spaced') { flush(); out.push(piece); continue; }
    if (k !== 'text') { word.push(piece); if (k === 'atom') atom = true; continue; }
    // a space ends the word being built; the text after the last space starts the next one
    const runs = String(piece).split(/(\s+)/);
    runs.forEach((run, i) => {
      if (!run) return;
      if (/^\s+$/.test(run)) { flush(); out.push(run); return; }
      word.push(run);
      if (i < runs.length - 1) flush();
    });
  }
  flush();
  return out;
}

/** The pieces drawn, a word glued to an inline formula in a span that does not wrap (wordGroups).
 *  @param {Document} doc @param {(string | Node)[]} pieces @returns {DocumentFragment} */
function glueWords(doc, pieces) {
  const out = doc.createDocumentFragment();
  for (const group of wordGroups(pieces, pieceKind)) {
    if (typeof group === 'object' && 'glue' in group) {
      const span = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      span.style.whiteSpace = 'nowrap';
      span.append(...group.glue);
      out.append(span);
    } else out.append(group);
  }
  return out;
}

/** Puts a title or abstract into `el`: as plain text when it holds no formula and no italic or bold, else drawn
 *  (paperNodes). @template {HTMLElement} E @param {E} el @param {unknown} text @returns {E} */
export function setPaperText(el, text) {
  const parts = paperParts(text);
  if (parts.every((p) => 'text' in p && !p.italic && !p.bold)) el.textContent = parts.map((p) => /** @type {{ text: string }} */ (p).text).join('');
  else el.append(paperNodes(el.ownerDocument, text));
  return el;
}

const SUBS = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };
const SUPS = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', '′': '′', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ' };
/** A script in Unicode when every letter has one, else as it is. @param {string} s @param {Record<string, string>} map */
const scripted = (s, map) => ([...s].every((c) => c in map) ? [...s].map((c) => map[c]).join('') : s);
// The commands a title's math uses most, as their letters.
const SYMBOLS = {
  rightarrow: '→', to: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', rightleftharpoons: '⇌', pm: '±', mp: '∓', times: '×',
  cdot: '·', sim: '∼', approx: '≈', simeq: '≃', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', infty: '∞', prime: '′',
  partial: '∂', nabla: '∇', hbar: 'ℏ', AA: 'Å', circ: '°', degree: '°', langle: '⟨', rangle: '⟩', ell: 'ℓ',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', kappa: 'κ', lambda: 'λ',
  mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

/** A formula's TeX as letters: symbols as their characters, scripts in Unicode where they have one, the rest of the
 *  commands and braces dropped. @param {string} tex */
function texText(tex) {
  let text = tex
    .replace(/\\(?:mathrm|mathbf|mathit|mathcal|mathsf|text|textrm|textit|textbf|mbox|operatorname)\s*\{([^{}]*)\}/g, '$1')
    .replace(/\\([A-Za-z]+)\s*/g, (all, name) => /** @type {Record<string, string>} */ (SYMBOLS)[name] ?? name)
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([{}%&#_$])/g, '$1');
  text = text.replace(/([_^])\s*(?:\{([^{}]*)\}|(.))/g, (all, mark, braced, one) => scripted(braced ?? one, mark === '_' ? SUBS : SUPS));
  return text.replace(/[{}]/g, '');
}

/** A title as one string for the places that hold only text (the reader's bar, a tab, a window title, a toast):
 *  formulas with Unicode scripts, math as letters, italic and bold as plain words (R2).
 *  @param {unknown} value @param {{ math?: boolean }} [o] */
export function plainText(value, o) {
  return paperParts(value, o).map((p) => ('text' in p ? p.text : 'sub' in p ? scripted(p.sub, SUBS) : 'sup' in p ? scripted(p.sup, SUPS) : texText(p.tex))).join('');
}

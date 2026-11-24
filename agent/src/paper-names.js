// @ts-check
// agent-src/src/paper-names.js. Author names as a reader writes them. arXiv's daily listing gives all of a paper's
// authors as one comma-separated string, in the TeX they were submitted in: "S\'{e}l\`{e}ne Forget, Malte R\"osner".

const ACCENTS = /** @type {Record<string, string>} */ ({ "'": '́', '`': '̀', '"': '̈', '^': '̂', '~': '̃', '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆', H: '̋', k: '̨', r: '̊' });
const LETTERS = /** @type {Record<string, string>} */ ({ ss: 'ß', aa: 'å', AA: 'Å', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł' });

/** One name with its TeX accents as letters. A name without a backslash comes back as it is. @param {unknown} value */
export function plainName(value) {
  const name = String(value ?? '').trim();
  if (!name.includes('\\')) return name;
  return name
    .replace(/\\(['`"^~=.])\s*\{?\s*\\?([A-Za-z])\}?/g, (_, mark, letter) => letter + ACCENTS[mark])
    .replace(/\\([cvuHkr])(?:\s+|\s*\{\s*)\\?([A-Za-z])\}?/g, (_, mark, letter) => letter + ACCENTS[mark])
    .replace(/\\(ss|aa|AA|ae|AE|oe|OE|o|O|l|L)(?![A-Za-z])\s*/g, (_, letter) => LETTERS[letter])
    .replace(/\\&/g, '&')
    .replace(/[{}]/g, '')
    .normalize('NFC');
}

/** The authors of an arXiv listing, one name each. @param {unknown} authors */
export function arxivAuthors(authors) {
  return (Array.isArray(authors) ? authors : []).flatMap((a) => String(a ?? '').split(/,\s+|\s+and\s+/)).map(plainName).filter(Boolean);
}

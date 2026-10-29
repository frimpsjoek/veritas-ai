import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileNameOf, addressOf, blockedReason, createHistory, firstPrefer, pageQuery, sourceOf } from '../src/browser-state.js';
import { isPdfUrl, isWebUrl, linkMode, planOpen } from '../../ui/src/links.js';

test('back steps through the pages the panel showed, and stops at the first', () => {
  const h = createHistory();
  assert.equal(h.back(), null);
  h.push({ url: 'https://a.org/' });
  assert.equal(h.canGoBack, false);
  h.push({ url: 'https://b.org/' });
  assert.equal(h.canGoBack, true);
  h.replace({ url: 'https://b.org/', prefer: 'reader' });
  assert.deepEqual(h.back(), { url: 'https://a.org/' });
  assert.equal(h.canGoBack, false);
  assert.equal(h.back(), null);
  h.clear();
  assert.equal(h.current, null);
});

test('an http page inside an https app skips the frame the browser would block', () => {
  assert.equal(firstPrefer('http://old.example/x', 'https:'), 'reader');
  assert.equal(firstPrefer('https://new.example/x', 'https:'), undefined);
  assert.equal(firstPrefer('http://old.example/x', 'http:'), undefined);
});

test('the page query carries the address, and the reader preference only when asked', () => {
  assert.equal(pageQuery({ url: 'https://a.org/p?q=1&r=2' }).toString(), 'url=https%3A%2F%2Fa.org%2Fp%3Fq%3D1%26r%3D2');
  assert.equal(pageQuery({ url: 'https://a.org/', prefer: 'reader' }).get('prefer'), 'reader');
});

test('the address line is short and readable', () => {
  assert.equal(addressOf('https://www.arxiv.org/abs/2401.00001'), 'arxiv.org/abs/2401.00001');
  assert.equal(addressOf('https://example.org/'), 'example.org');
  assert.ok(addressOf(`https://example.org/${'a'.repeat(200)}`).length <= 60);
  assert.equal(addressOf('not a url'), 'not a url');
});

test('a card says why: the server reason, a refusal, or a plain default', () => {
  assert.equal(blockedReason({ mode: 'blocked', reason: 'The site needs you to sign in.' }, null), 'The site needs you to sign in.');
  assert.equal(blockedReason(null, Object.assign(new Error('That address is not on the public web'), { status: 400 })), 'That address is not on the public web');
  assert.match(blockedReason(null, Object.assign(new Error('x'), { status: 401 })), /Sign in/);
  assert.match(blockedReason(null, new Error('network')), /couldn't reach/);
});

test('PDF links are recognised by their address (D4)', () => {
  for (const url of ['https://x.org/files/paper.pdf', 'https://x.org/a.PDF?download=1', 'https://arxiv.org/pdf/2401.00001', 'https://export.arxiv.org/pdf/2401.00001v2']) assert.equal(isPdfUrl(url), true, url);
  for (const url of ['https://arxiv.org/abs/2401.00001', 'https://x.org/pdf-guide', 'nonsense']) assert.equal(isPdfUrl(url), false, url);
  assert.equal(isWebUrl('zotero://select/x'), false);
  assert.equal(isWebUrl('HTTPS://x.org'), true);
});

test('the openLinks setting reads inside unless it says outside', () => {
  const prefs = (v) => ({ get: () => v });
  assert.equal(linkMode(prefs(undefined)), 'inside');
  assert.equal(linkMode(prefs('inside')), 'inside');
  assert.equal(linkMode(prefs('outside')), 'outside');
  assert.equal(linkMode(prefs('junk')), 'inside');
});

test('a PDF link names its file', () => {
  assert.equal(fileNameOf('https://x.org/a/My%20Paper.pdf?x=1'), 'My Paper.pdf');
  assert.equal(fileNameOf('https://arxiv.org/pdf/'), 'PDF');
  assert.equal(fileNameOf('https://x.org/%E0%A4%A.pdf'), 'PDF');
});

test('where a link goes: inside by default, outside when marked or set so, the system for other schemes', () => {
  const on = { mode: 'inside', hasBrowser: true };
  assert.equal(planOpen('https://x.org/', undefined, on), 'inside');
  assert.equal(planOpen('https://x.org/', { outside: false }, on), 'inside');
  assert.equal(planOpen('https://x.org/', { outside: true }, on), 'outside');
  assert.equal(planOpen('https://x.org/', undefined, { mode: 'outside', hasBrowser: true }), 'outside');
  assert.equal(planOpen('https://x.org/', { outside: false }, { mode: 'outside', hasBrowser: true }), 'outside');
  assert.equal(planOpen('https://x.org/', undefined, { mode: 'inside', hasBrowser: false }), 'outside');
  assert.equal(planOpen('zotero://select/library/items/K1', undefined, on), 'scheme');
  assert.equal(planOpen('obsidian://open?vault=v', { outside: true }, on), 'scheme');
});

test('the bar says where a paper copy came from (spec 022)', () => {
  assert.equal(sourceOf({ mode: 'pdf', source: 'library' }), 'Your library');
  assert.equal(sourceOf({ mode: 'pdf', source: 'open access', version: 'submitted', where: 'arXiv (Cornell University)' }), 'Preprint (arXiv)');
  assert.equal(sourceOf({ mode: 'pdf', source: 'open access', version: 'published', where: 'PubMed Central' }), 'Open access (PubMed Central)');
  assert.equal(sourceOf({ mode: 'reader', source: 'openalex' }), 'Abstract only');
  assert.equal(sourceOf({ mode: 'frame' }), '');
  assert.equal(sourceOf(null), '');
});

test('the reader view is one font family, with the abstract under a small label and no quote', async () => {
  const { readerPlan } = await import('../src/browser-state.js');
  const plan = readerPlan({ mode: 'reader', url: 'https://x.org/a', title: 'Voles', byline: 'Ann Chen', html: '<p>Text.</p>' });
  assert.match(plan.articleClass, /\bsbw-prose\b/, 'the header sits inside the prose font, not the UI font');
  assert.equal(plan.title, 'Voles');
  assert.equal(plan.abstract, '');
  const paper = readerPlan({ mode: 'reader', url: 'https://doi.org/10.1/x', title: 'T', html: '', abstract: 'We show it.', source: 'openalex' });
  assert.equal(paper.abstract, 'We show it.');
  assert.equal(paper.abstractLabel, 'Abstract');
});

test('math is drawn only for answers the server marked (arXiv, LaTeXML, MathML), so "$5 and $10" stays money', async () => {
  const { readerPlan } = await import('../src/browser-state.js');
  assert.equal(readerPlan({ mode: 'reader', title: 'Shop', html: '<p>$5 and $10</p>' }).math, false);
  assert.equal(readerPlan({ mode: 'reader', title: 'PtSe$_2$', html: '', source: 'arxiv', math: true }).math, true);
  assert.equal(readerPlan({ mode: 'reader', title: 'x', html: '', math: 'yes' }).math, false);
});

test('an arXiv answer shows its subjects, dates and the PDF / full-text buttons in the header', async () => {
  const { readerPlan } = await import('../src/browser-state.js');
  const plan = readerPlan({
    mode: 'reader', url: 'https://arxiv.org/abs/2607.25690', title: 'First-Principles Wannier Representation of Proximity Effects',
    byline: 'Yaroslav Zhumagulov, Johan Félisaz', abstract: 'Graphene/PtSe$_2$ develops a coupling.', html: '', source: 'arxiv', math: true,
    paper: { arxiv: '2607.25690', version: 'v2', submitted: '28 Jul 2026', revised: '25 Oct 2026', doi: '10.48550/arXiv.2607.25690',
      subjects: [{ code: 'cond-mat.mes-hall', name: 'Mesoscale and Nanoscale Physics', primary: true }, { code: 'physics.comp-ph', name: '', primary: false }] },
    links: [{ label: 'PDF', url: 'https://arxiv.org/pdf/2607.25690', kind: 'pdf' }, { label: 'Full text', url: 'https://arxiv.org/html/2607.25690v2', kind: 'reader' },
      { label: 'Bad', url: 'javascript:alert(1)', kind: 'page' }],
  });
  assert.deepEqual(plan.subjects, [{ label: 'Mesoscale and Nanoscale Physics', code: 'cond-mat.mes-hall', primary: true }, { label: 'physics.comp-ph', code: 'physics.comp-ph', primary: false }]);
  assert.equal(plan.meta, 'arXiv:2607.25690v2 · Submitted 28 Jul 2026 · revised 25 Oct 2026');
  assert.deepEqual(plan.links.map((l) => l.label), ['PDF', 'Full text'], 'only web links become buttons');
  assert.equal(plan.paper, true, '"Original page" goes to the system browser (the panel would show this paper again)');
  assert.equal(plan.math, true);
  const page = readerPlan({ mode: 'reader', title: 'A blog', html: '<p>x</p>' });
  assert.deepEqual([page.subjects, page.meta, page.links, page.paper], [[], '', [], false]);
});

test('TeX in a math answer is found even glued to a word (PtSe$_2$), and money still is not', async () => {
  const { mathParts } = await import('../src/browser-state.js');
  assert.deepEqual(mathParts('Graphene/PtSe$_2$ develops'), [{ text: 'Graphene/PtSe' }, { tex: '_2' }, { text: ' develops' }]);
  assert.deepEqual(mathParts('the operator \\(\\Delta(\\omega)\\) here'), [{ text: 'the operator ' }, { tex: '\\Delta(\\omega)' }, { text: ' here' }]);
  assert.deepEqual(mathParts('Tickets cost $5 and $10.'), [{ text: 'Tickets cost $5 and $10.' }]);
  assert.deepEqual(mathParts('no math'), [{ text: 'no math' }]);
});

test('← shows the page before, and on the first page closes the panel (back to where the link was clicked)', async () => {
  const { stepBack } = await import('../src/browser-state.js');
  const h = createHistory();
  h.push({ url: 'https://a.org/' });
  h.push({ url: 'https://b.org/' });
  assert.deepEqual(stepBack(h), { show: { url: 'https://a.org/' } });
  assert.deepEqual(stepBack(h), { close: true });
  assert.deepEqual(stepBack(createHistory()), { close: true });
});

test('a DOI answered with its abstract only is a landing page: journal and date, html abstract, DOI, citation, publisher outside', async () => {
  const { readerPlan } = await import('../src/browser-state.js');
  const plan = readerPlan({
    mode: 'reader', url: 'https://doi.org/10.1021/acs.jctc.6c01423', title: 'Multipolar Polarizabilities in Materials', byline: 'Diem Thi-Xuan Dang, Dai-Nam Le',
    abstract: 'We develop CO2.', abstract_html: '<p>We develop CO<sub>2</sub>.</p>', html: '', source: 'openalex',
    paper: { doi: '10.1021/acs.jctc.6c01423', journal: 'Journal of Chemical Theory and Computation', published: '28 Oct 2026', citation: 'Dang, Le. Multipolar. 2026.' },
    links: [{ label: "Publisher's page", url: 'https://doi.org/10.1021/acs.jctc.6c01423', kind: 'outside' }, { label: 'PDF', url: 'https://repo.example/p.pdf', kind: 'pdf' }],
  });
  assert.equal(plan.landing, true);
  assert.equal(plan.meta, 'Journal of Chemical Theory and Computation · 28 Oct 2026');
  assert.equal(plan.abstractHtml, '<p>We develop CO<sub>2</sub>.</p>');
  assert.deepEqual([plan.doi, plan.doiUrl, plan.citation], ['10.1021/acs.jctc.6c01423', 'https://doi.org/10.1021/acs.jctc.6c01423', 'Dang, Le. Multipolar. 2026.']);
  assert.deepEqual(plan.links.map((l) => [l.label, l.outside]), [["Publisher's page", true], ['PDF', false]], 'only the publisher goes outside; a PDF opens in the panel');
  const numbered = readerPlan({ source: 'openalex', paper: { journal: 'ACS Nano', published: '5 Mar 2026', volume: '12', issue: '3', pages: '101-118' } });
  assert.equal(numbered.meta, 'ACS Nano · 5 Mar 2026 · 12 (3), 101-118');
  const arxiv = readerPlan({ source: 'arxiv', abstract_html: '<p>x</p>', paper: { doi: '10.48550/arXiv.1', arxiv: '1' } });
  assert.deepEqual([arxiv.landing, arxiv.abstractHtml, arxiv.doi, arxiv.citation], [false, '', '', ''], 'an arXiv answer keeps its own look');
});

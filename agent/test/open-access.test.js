// Spec 031 R2: finding a legal free copy. Fake connectors only (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arxivIdOf, bareDoi, publisherPage, findOpenAccess, findOpenAccessAll } from '../src/open-access.js';

/** A fetch that answers by host; records every URL asked. @param {Record<string, (url: URL) => any>} byHost */
function fakeFetch(byHost) {
  const calls = [];
  const fn = async (input) => {
    const url = new URL(String(input));
    calls.push(url.href);
    const answer = byHost[url.host];
    if (!answer) return new Response('', { status: 404 });
    const body = answer(url);
    return body === null ? new Response('', { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

test('arxivIdOf: from an arXiv DOI, an abs or pdf URL, or the field; versions dropped; null otherwise', () => {
  assert.equal(arxivIdOf({ doi: '10.48550/arXiv.2401.01234v2' }), '2401.01234');
  assert.equal(arxivIdOf({ url: 'https://arxiv.org/abs/2401.01234v3' }), '2401.01234');
  assert.equal(arxivIdOf({ pdfUrl: 'https://arxiv.org/pdf/cond-mat/0101001.pdf' }), 'cond-mat/0101001');
  assert.equal(arxivIdOf({ arxiv: 'arXiv:2312.9' }), '2312.9');
  assert.equal(arxivIdOf({ doi: '10.1107/s1', url: 'https://doi.org/10.1107/s1' }), null);
});

test('bareDoi and publisherPage: DOI links in any spelling; arXiv pages are not a publisher', () => {
  assert.equal(bareDoi('https://dx.doi.org/10.1107/S1'), '10.1107/s1');
  assert.equal(publisherPage({ doi: 'doi:10.1/X' }), 'https://doi.org/10.1/x');
  assert.equal(publisherPage({ url: 'https://journal.example/paper' }), 'https://journal.example/paper');
  assert.equal(publisherPage({ url: 'https://arxiv.org/abs/1' }), null);
  assert.equal(publisherPage({}), null);
});

test('findOpenAccess: arXiv first, without asking anyone', async () => {
  const fetchFn = fakeFetch({});
  assert.deepEqual(await findOpenAccess(fetchFn, { doi: '10.48550/arXiv.2401.01234' }), { access: 'open', pdfUrl: 'https://arxiv.org/pdf/2401.01234', via: 'arXiv' });
  assert.equal(fetchFn.calls.length, 0);
});

test('findOpenAccess: Unpaywall only with an email, and its PDF wins', async () => {
  const fetchFn = fakeFetch({
    'api.unpaywall.org': (u) => (u.searchParams.get('email') === 'me@uni.edu' ? { best_oa_location: { url_for_pdf: 'https://repo.example/a.pdf' } } : null),
    'api.openalex.org': () => ({ best_oa_location: { is_oa: true, pdf_url: 'https://oa.example/b.pdf' } }),
  });
  // every source is asked: OpenAlex's copy is kept as an alternate, tried if the first refuses a program
  assert.deepEqual(await findOpenAccess(fetchFn, { doi: '10.1/x' }, { email: 'me@uni.edu' }), { access: 'open', pdfUrl: 'https://repo.example/a.pdf', via: 'Unpaywall', alternates: ['https://oa.example/b.pdf'] });
  // no email: Unpaywall is never asked, OpenAlex answers
  const noEmail = fakeFetch({ 'api.openalex.org': () => ({ best_oa_location: { is_oa: true, pdf_url: 'https://oa.example/b.pdf' } }) });
  assert.deepEqual(await findOpenAccess(noEmail, { doi: '10.1/x' }), { access: 'open', pdfUrl: 'https://oa.example/b.pdf', via: 'OpenAlex' });
  assert.ok(!noEmail.calls.some((c) => c.includes('unpaywall')));
});

test('findOpenAccess: a failing or empty source is skipped; Semantic Scholar, then Europe PMC (open-access PMC only)', async () => {
  const s2 = fakeFetch({ 'api.openalex.org': () => { throw new Error('down'); }, 'api.semanticscholar.org': () => ({ openAccessPdf: { url: 'https://s2.example/c.pdf' } }) });
  assert.equal((await findOpenAccess(s2, { doi: '10.1/x' })).via, 'Semantic Scholar');
  const pmc = fakeFetch({ 'www.ebi.ac.uk': () => ({ resultList: { result: [{ pmcid: 'PMC123', isOpenAccess: 'Y' }] } }) });
  assert.deepEqual(await findOpenAccess(pmc, { doi: '10.1/x' }), { access: 'open', pdfUrl: 'https://europepmc.org/articles/PMC123?pdf=render', via: 'Europe PMC' });
  const closed = fakeFetch({ 'www.ebi.ac.uk': () => ({ resultList: { result: [{ pmcid: 'PMC123', isOpenAccess: 'N' }] } }) });
  assert.deepEqual(await findOpenAccess(closed, { doi: '10.1/x' }), { access: 'publisher', page: 'https://doi.org/10.1/x' });
});

test('findOpenAccess: no free copy -> the publisher page; no DOI or URL -> none; a known PDF needs no lookup', async () => {
  assert.deepEqual(await findOpenAccess(fakeFetch({}), { doi: '10.1/x' }), { access: 'publisher', page: 'https://doi.org/10.1/x' });
  assert.deepEqual(await findOpenAccess(fakeFetch({}), { doi: null, url: null }), { access: 'none' });
  assert.equal((await findOpenAccess(fakeFetch({}), { pdfUrl: 'https://x.example/p.pdf' })).via, 'the search');
  // a non-http address is not a PDF link
  assert.equal((await findOpenAccess(fakeFetch({ 'api.semanticscholar.org': () => ({ openAccessPdf: { url: 'javascript:alert(1)' } }) }), { doi: '10.1/x' })).access, 'publisher');
});

test('findOpenAccessAll: parallel to its input, one answer per paper', async () => {
  const fetchFn = fakeFetch({ 'api.openalex.org': (u) => (u.pathname.includes('10.1%2Fopen') || u.pathname.includes('10.1/open') ? { best_oa_location: { pdf_url: 'https://oa.example/o.pdf' } } : null) });
  const out = await findOpenAccessAll(fetchFn, [{ doi: '10.1/open' }, { doi: '10.1/closed' }, { arxiv: '2401.1' }, {}]);
  assert.deepEqual(out.map((a) => a.access), ['open', 'publisher', 'open', 'none']);
});

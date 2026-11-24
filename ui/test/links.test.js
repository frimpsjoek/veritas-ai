import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPaperUrl, planOpen } from '../src/links.js';

test('a paper link is a DOI, an arXiv paper, a ChemRxiv paper or a publisher page with a DOI', () => {
  for (const url of [
    'https://doi.org/10.1021/x',
    'https://dx.doi.org/10.1103/PhysRevB.1.2',
    'https://pubs.acs.org/doi/10.1021/x',
    'https://pubs.acs.org/doi/pdf/10.1021/x',
    'https://onlinelibrary.wiley.com/doi/full/10.1002/anie.202400001',
    'https://arxiv.org/abs/2608.23130',
    'https://arxiv.org/pdf/2608.23130v2',
    'https://chemrxiv.org/engage/chemrxiv/article-details/66c9d14420ac769e5fb4ddd1',
    'https://www.nature.com/articles/s41586-024-07000-1',
    'https://pubs.acs.org/ancac3/article/20/43/28994/5454152/Low-Energy',
  ]) assert.equal(isPaperUrl(url), true, url);
  for (const url of ['https://example.org/blog', 'https://arxiv.org/list/cond-mat/new', 'https://pubs.acs.org/', 'not a url', 'zotero://select/items/K']) {
    assert.equal(isPaperUrl(url), false, url);
  }
});

test('in the desktop app a paper link opens in Browse, unless the reader or the outside is asked for', () => {
  const paper = 'https://doi.org/10.1021/x';
  const where = { mode: /** @type {'inside'} */ ('inside'), hasBrowser: true, hasBrowse: true };
  assert.equal(planOpen(paper, undefined, where), 'browse');
  assert.equal(planOpen(paper, { reader: true }, where), 'inside');
  assert.equal(planOpen(paper, { outside: true }, where), 'outside');
  assert.equal(planOpen(paper, { outside: true, reader: true }, where), 'outside');
  assert.equal(planOpen('https://example.org/blog', undefined, where), 'inside');
  assert.equal(planOpen(paper, undefined, { ...where, hasBrowse: false }), 'inside');
  assert.equal(planOpen(paper, undefined, { mode: 'outside', hasBrowser: true, hasBrowse: true }), 'outside', 'the setting wins');
  assert.equal(planOpen('zotero://select/items/K', undefined, where), 'scheme');
});

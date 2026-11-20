import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paperLink, shareText, menuItems, shareOutcome } from '../src/paper-share.js';

test('a paper\'s link: its DOI first, then its arXiv page, then its own address', () => {
  assert.equal(paperLink({ doi: '10.1021/jacs.5b01234', url: 'https://pubs.acs.org/x' }), 'https://doi.org/10.1021/jacs.5b01234');
  assert.equal(paperLink({ doi: 'https://doi.org/10.1021/ABC' }), 'https://doi.org/10.1021/ABC', 'a DOI written as a link');
  assert.equal(paperLink({ doi: 'doi:10.1021/x' }), 'https://doi.org/10.1021/x');
  assert.equal(paperLink({ arxiv: '2401.01234v2' }), 'https://arxiv.org/abs/2401.01234v2');
  assert.equal(paperLink({ arxiv_id: '2401.01234' }), 'https://arxiv.org/abs/2401.01234');
  assert.equal(paperLink({ url: 'https://chemrxiv.org/engage/chemrxiv/article-details/0123456789abcdef01234567' }),
    'https://chemrxiv.org/engage/chemrxiv/article-details/0123456789abcdef01234567');
  assert.equal(paperLink({ url: 'https://pubs.acs.org/doi/10.1021/acsnano.0c00001' }), 'https://doi.org/10.1021/acsnano.0c00001', 'a publisher page with a DOI in it');
  assert.equal(paperLink({ url: 'https://pubs.acs.org/doi/pdf/10.1021/acsnano.0c00001?ref=x' }), 'https://doi.org/10.1021/acsnano.0c00001', 'its PDF too');
  assert.equal(paperLink({ url: 'zotero://select/items/ABC' }), null, 'a local link is not something to share');
  assert.equal(paperLink({ title: 'No link' }), null);
  assert.equal(paperLink(null), null);
});

test('the shared text is the title and the link, on two lines', () => {
  assert.equal(shareText({ title: '  A  paper\non XAS ', doi: '10.1021/x' }), 'A paper on XAS\nhttps://doi.org/10.1021/x');
  assert.equal(shareText({ doi: '10.1021/x' }), 'https://doi.org/10.1021/x', 'no title: just the link');
  assert.equal(shareText({ title: 'T' }), null, 'no link: nothing to share');
});

test('the menu: open, copy link, copy title and link, share; nothing for a paper without a link', () => {
  const paper = { title: 'T', doi: '10.1021/x' };
  assert.deepEqual(menuItems(paper, { canOpen: true }).map((i) => i.id), ['open', 'open-outside', 'copy-link', 'copy-text', 'share']);
  assert.deepEqual(menuItems(paper, { canOpen: false }).map((i) => i.id), ['copy-link', 'copy-text', 'share']);
  assert.deepEqual(menuItems({ title: 'T' }, { canOpen: true }), []);
  assert.equal(menuItems(paper, {}).find((i) => i.id === 'share')?.label, 'Share…');
});

test('what Share says: shared quietly, copied where there is no share menu, nothing when cancelled', () => {
  assert.equal(shareOutcome('shared'), null);
  assert.equal(shareOutcome('cancelled'), null);
  assert.equal(shareOutcome('copied'), 'Link copied');
  assert.equal(shareOutcome('failed'), "Couldn't copy the link");
});

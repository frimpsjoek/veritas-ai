import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, fetchFeed } from '../src/feeds.js';

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Journal</title>
<item><title><![CDATA[Spindles &amp; sleep: a study]]></title><link>https://journal.example/articles/1</link><guid isPermaLink="false">doi:10.9999/inv.1</guid>
<pubDate>Tue, 06 Oct 2026 09:00:00 GMT</pubDate><dc:creator>Doe, J.</dc:creator><dc:creator>Roe, R.</dc:creator>
<description>&lt;p&gt;Spindles &lt;b&gt;rose&lt;/b&gt; &amp;amp; fell.&lt;/p&gt;</description></item>
<item><title>Second</title><link>https://arxiv.org/abs/2610.01234v2</link><author>editor@x.org (Ann Author)</author><description><![CDATA[<p>Body with <a href="https://doi.org/10.9999/inv.2.">link</a></p>]]></description></item>
</channel></rss>`;

test('RSS 2.0: title, CDATA, entities, authors, date, DOI from guid, arXiv id from link', () => {
  const [a, b] = parseFeed(RSS);
  assert.equal(a.title, 'Spindles & sleep: a study');
  assert.equal(a.doi, '10.9999/inv.1');
  assert.equal(a.date, '2026-10-06');
  assert.deepEqual(a.authors, ['Doe, J.', 'Roe, R.']);
  assert.equal(a.summary, 'Spindles rose & fell.');
  assert.equal(b.arxiv, '2610.01234');
  assert.deepEqual(b.authors, ['Ann Author']);
  assert.equal(b.doi, '10.9999/inv.2', 'a DOI in the body, without the sentence dot');
  assert.equal(b.summary, 'Body with link');
});

test('Atom: alternate link, published date, nested author names, arXiv id from the entry id', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>cs</title><entry><id>http://arxiv.org/abs/2610.05555v1</id><title>An Atom
   title</title><link rel="related" href="https://x.example/pdf"/><link rel="alternate" href="https://arxiv.org/abs/2610.05555v1"/>
   <published>2026-10-05T12:00:00Z</published><updated>2026-10-07T00:00:00Z</updated><author><name>A. B.</name></author><author><name>C. D.</name></author>
   <summary type="html">&lt;p&gt;We show things.&lt;/p&gt;</summary></entry></feed>`;
  const [e] = parseFeed(xml);
  assert.equal(e.title, 'An Atom title');
  assert.equal(e.link, 'https://arxiv.org/abs/2610.05555v1');
  assert.equal(e.arxiv, '2610.05555');
  assert.equal(e.date, '2026-10-05');
  assert.deepEqual(e.authors, ['A. B.', 'C. D.']);
  assert.equal(e.summary, 'We show things.');
});

test('RSS 1.0 / RDF: items sit beside the channel, dc:date and dc:identifier are read', () => {
  const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/1.2/basic/">
   <channel rdf:about="x"><title>Channel</title></channel>
   <item rdf:about="https://j.example/3"><title>RDF paper</title><link>https://j.example/3</link><dc:date>2026-09-30</dc:date><dc:identifier>doi:10.9999/inv.3</dc:identifier><dc:creator>Zed, Z.</dc:creator><description>Plain.</description></item></rdf:RDF>`;
  const items = parseFeed(xml);
  assert.equal(items.length, 1, 'the channel is not an item');
  assert.equal(items[0].doi, '10.9999/inv.3');
  assert.equal(items[0].date, '2026-09-30');
  assert.deepEqual(items[0].authors, ['Zed, Z.']);
});

test('numeric entities decode and an item without a title is skipped', () => {
  const items = parseFeed('<rss><channel><item><title>Caf&#233; &#x41;</title></item><item><link>x</link></item></channel></rss>');
  assert.deepEqual(items.map((i) => i.title), ['Café A']);
});

const feedRes = (status, body = '', headers = {}) => ({ ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test('fetchFeed sends the validators it has and keeps new ones', async () => {
  const seen = [];
  const fetchFn = async (url, init) => { seen.push(init.headers); return feedRes(200, RSS, { etag: '"v2"', 'last-modified': 'Tue, 06 Oct 2026 10:00:00 GMT' }); };
  const got = await fetchFeed(fetchFn, 'https://j.example/feed', { etag: '"v1"', modified: 'Mon, 05 Oct 2026 10:00:00 GMT' });
  assert.equal(seen[0]['If-None-Match'], '"v1"');
  assert.equal(seen[0]['If-Modified-Since'], 'Mon, 05 Oct 2026 10:00:00 GMT');
  assert.equal(got.items.length, 2);
  assert.deepEqual(got.cache, { etag: '"v2"', modified: 'Tue, 06 Oct 2026 10:00:00 GMT' });
  assert.equal(got.error, null);
});

test('304 means no items and the cache is unchanged', async () => {
  const cache = { etag: '"v1"', modified: null };
  const got = await fetchFeed(async () => feedRes(304), 'https://j.example/feed', cache);
  assert.deepEqual(got.items, []);
  assert.deepEqual(got.cache, cache);
  assert.equal(got.error, null);
});

test('a failing feed reports an error and never throws', async () => {
  assert.equal((await fetchFeed(async () => feedRes(404), 'https://j.example/feed', null)).error, 'HTTP 404');
  assert.match((await fetchFeed(async () => { throw new Error('getaddrinfo ENOTFOUND'); }, 'https://nope.invalid/feed', null)).error, /ENOTFOUND/);
  assert.equal((await fetchFeed(async () => feedRes(200, '<html>hi</html>'), 'https://j.example/feed', null)).error, 'not a feed');
});

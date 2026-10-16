import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as W from '../js/wiki.js';
import * as L from '../js/lib.js';

test('wikiTarget', () => {
  assert.deepEqual(W.wikiTarget('https://en.wikipedia.org/wiki/Mount_Fuji'), { host: 'en.wikipedia.org', title: 'Mount Fuji' });
  assert.deepEqual(W.wikiTarget('https://en.m.wikipedia.org/wiki/Fuji,_Shizuoka#History'), { host: 'en.wikipedia.org', title: 'Fuji, Shizuoka' });
  assert.deepEqual(W.wikiTarget('https://de.wikipedia.org/wiki/K%C3%B6ln'), { host: 'de.wikipedia.org', title: 'Köln' });
  assert.deepEqual(W.wikiTarget('https://fr.wikipedia.org/w/index.php?title=Paris'), { host: 'fr.wikipedia.org', title: 'Paris' });
  assert.deepEqual(W.wikiTarget('https://en.wikipedia.org/wiki/AC/DC'), { host: 'en.wikipedia.org', title: 'AC/DC' });
  for (const u of ['https://en.wikipedia.org/', 'https://example.com/wiki/Fuji', 'http://en.wikipedia.org/wiki/Fuji', 'https://en.wikipedia.org/wiki/Special:Random', 'https://evil.wikipedia.org.example.com/wiki/X', 'nonsense']) {
    assert.equal(W.wikiTarget(u), null, u);
  }
});

test('API URLs', () => {
  const u = new URL(W.leadUrl('en.wikipedia.org', 'Mount Fuji'));
  assert.equal(u.origin, 'https://en.wikipedia.org');
  assert.equal(u.searchParams.get('section'), '0');
  assert.equal(u.searchParams.get('page'), 'Mount Fuji');
  assert.equal(u.searchParams.get('origin'), '*');
  assert.equal(new URL(W.sectionUrl('en.wikipedia.org', 'X', 4)).searchParams.get('section'), '4');
  assert.equal(new URL(W.tocUrl('en.wikipedia.org', 'X')).searchParams.get('prop'), 'tocdata');
  assert.equal(new URL(W.fullUrl('en.wikipedia.org', 'X')).searchParams.has('section'), false);
  assert.equal(W.canonicalUrl('en.wikipedia.org', 'AC/DC (band)'), 'https://en.wikipedia.org/wiki/AC/DC_(band)');
});

test('parseToc keeps top-level sections, drops reference sections, counts subsections', () => {
  const toc = W.parseToc({
    parse: {
      tocdata: {
        sections: [
          { tocLevel: 1, index: '1', line: 'History', anchor: 'History' },
          { tocLevel: 2, index: '2', line: 'Early', anchor: 'Early' },
          { tocLevel: 2, index: '3', line: 'Late', anchor: 'Late' },
          { tocLevel: 1, index: '4', line: 'Geography &amp; <i>climate</i>', anchor: 'g' },
          { tocLevel: 1, index: '5', line: 'References', anchor: 'r' },
          { tocLevel: 1, index: '6', line: 'External links', anchor: 'e' },
        ],
      },
    },
  });
  assert.deepEqual(toc, [
    { index: 1, line: 'History', anchor: 'History', subs: 2 },
    { index: 4, line: 'Geography & climate', anchor: 'g', subs: 0 },
  ]);
  assert.deepEqual(W.parseToc({}), []);
  assert.equal(W.apiError({ error: { code: 'missingtitle', info: 'The page does not exist' } }), 'The page does not exist');
  assert.equal(W.apiError({ parse: {} }), '');
});

const HTML = `<div class="mw-content-ltr mw-parser-output">
<style>.x{color:red}</style>
<div role="note" class="hatnote">For other uses, see Foo.</div>
<table class="infobox"><tbody><tr><th colspan="2">Foo</th></tr><tr><th>Height</th><td>3,776 m<br />12,388 ft</td></tr><tr><th>Region</th><td><ul><li><a href="/wiki/Kanto">Kanto</a></li><li>Chubu</li></ul></td></tr></tbody></table>
<p><b>Foo</b> is a <a href="/wiki/Place" title="Place">place</a> &amp; <i>town</i><sup class="reference"><a href="#cite_note-1">[1]</a></sup> of 10<sup>3</sup> people.</p>
<figure><img src="x.jpg"><figcaption>A photo</figcaption></figure>
<div class="mw-heading mw-heading2"><h2 id="History">History</h2><span class="mw-editsection">[edit]</span></div>
<p>It began in <a href="/wiki/File:Skip.jpg">a file</a> 1900 (see <a href="https://example.org/a_(b)">source</a>).</p>
<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>
<ol><li>First</li><li>Second</li></ol>
<table class="wikitable"><caption>Results</caption><tbody><tr><th>Team</th><th>Pts</th></tr><tr><td>A | B</td><td>10</td></tr><tr><td>C</td></tr></tbody></table>
<table class="navbox"><tr><td>Navigation</td></tr></table>
<div class="reflist"><ol class="references"><li>ref</li></ol></div>
<p>Last &lt;script&gt; paragraph.</p>
<!-- comment -->
</div>`;

test('htmlToMarkdown: keeps text, links, lists, tables; drops furniture', () => {
  const md = W.htmlToMarkdown(HTML, 'en.wikipedia.org');
  assert.ok(!md.includes('For other uses'), 'hatnote');
  assert.ok(!md.includes('color:red'), 'style');
  assert.ok(!md.includes('[1]'), 'citation marker');
  assert.ok(!md.includes('[edit]'), 'edit link');
  assert.ok(!md.includes('A photo'), 'figure');
  assert.ok(!md.includes('Navigation'), 'navbox');
  assert.ok(!md.includes('ref\n'), 'references');
  assert.ok(md.includes('**Foo** is a [place](https://en.wikipedia.org/wiki/Place) & *town*'), md);
  assert.ok(md.includes('10^3 people'), md);
  assert.ok(md.includes('\n# History\n'), md);
  assert.ok(md.includes('a file 1900'), 'file link text kept, link dropped');
  assert.ok(!md.includes('Skip.jpg'));
  assert.ok(md.includes('[source](https://example.org/a_%28b%29)'), md);
  assert.ok(md.includes('- One\n  - Nested\n- Two'), md);
  assert.ok(md.includes('1. First\n2. Second'), md);
  assert.ok(md.includes('| Height | 3,776 m 12,388 ft |'), md);
  assert.ok(md.includes('| Region | [Kanto](https://en.wikipedia.org/wiki/Kanto), Chubu |'), md);
  assert.ok(md.includes('**Results**'), md);
  assert.ok(md.includes('| Team | Pts |\n| --- | --- |\n| A / B | 10 |\n| C |  |'), md);
  assert.ok(md.includes('Last <script> paragraph.'), md);
});

test('htmlToMarkdown output is read by the app Markdown reader', () => {
  const md = W.htmlToMarkdown(HTML, 'en.wikipedia.org');
  const blocks = L.parseMarkdown(md, 'https://en.wikipedia.org/wiki/Foo');
  const types = blocks.map((b) => b.type);
  assert.ok(types.includes('table'));
  assert.ok(types.includes('list'));
  const h2 = blocks.find((b) => b.type === 'h');
  assert.equal(h2.level, 1);
  const table = blocks.filter((b) => b.type === 'table').pop();
  assert.equal(L.inlineText(table.rows[0][0]), 'Team');
  assert.equal(L.inlineText(table.rows[1][0]), 'A / B');
  const list = blocks.find((b) => b.type === 'list');
  assert.deepEqual(list.items.map((i) => i.depth), [0, 1, 0]);
});

test('htmlToMarkdown copes with junk', () => {
  assert.equal(W.htmlToMarkdown(''), '');
  assert.ok(W.htmlToMarkdown('<p>unclosed <b>bold').includes('bold'));
  assert.ok(W.htmlToMarkdown('<p>a</p></div></span><p>b</p>').includes('b'));
  assert.ok(!W.htmlToMarkdown('<p onclick="x()">hi <script>alert(1)</script></p>').includes('alert'));
});

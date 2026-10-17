import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../js/lib.js';

const base = 'https://n.example/';
const blocks = (md) => L.parseMarkdown(md, base);
const para = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i + 1} is here and says something plain.`).join(' ');

test('sentenceStarts skips abbreviations, initials, acronyms and decimals', () => {
  const t = 'Dr. Smith met J. Doe in the U.S. on Jan. 5. It cost 3.50 dollars. Then they left! Why? Nobody knows.';
  const parts = L.sentenceStarts(t).map((at, i, a) => t.slice(i ? a[i - 1] : 0, at).trim());
  assert.deepEqual(parts, ['Dr. Smith met J. Doe in the U.S. on Jan. 5.', 'It cost 3.50 dollars.', 'Then they left!', 'Why?']);
});

test('sliceInline keeps wrappers and offsets line up', () => {
  const c = L.parseInline('Hello **bold [link](https://a.example/) text** end.', base);
  const text = L.inlineText(c);
  const cut = text.indexOf('text');
  const a = L.sliceInline(c, 0, cut);
  const b = L.sliceInline(c, cut, text.length);
  assert.equal(L.inlineText(a) + L.inlineText(b), text);
  assert.equal(b[0].t, 'b');
  assert.ok(a[1].c.some((n) => n.t === 'link' && L.inlineText(n.c) === 'link'));
});

test('splitParagraph splits long paragraphs at sentence ends and loses no text', () => {
  const [p] = blocks(para(20));
  const out = L.splitParagraph(p);
  assert.ok(out.length >= 3);
  assert.ok(out.every((b) => b.type === 'p'));
  assert.ok(out.every((b) => /[.]\s*$/.test(L.inlineText(b.c))));
  assert.equal(out.map((b) => L.inlineText(b.c)).join(''), L.inlineText(p.c));
  assert.ok(out.every((b) => L.inlineText(b.c).length >= 150));
});

test('splitParagraph leaves short paragraphs and sentence-less text alone', () => {
  const [short] = blocks(para(5));
  assert.deepEqual(L.splitParagraph(short), [short]);
  const [wall] = blocks('word '.repeat(300));
  assert.deepEqual(L.splitParagraph(wall), [wall]);
});

test('splitParagraph is deterministic', () => {
  const [p] = blocks(para(30));
  assert.deepEqual(L.splitParagraph(p), L.splitParagraph(p));
});

test('foldLinkRuns folds link-only runs and keeps real text', () => {
  const md = [
    '# Story',
    '',
    para(3),
    '',
    '*   [One](https://n.example/1)',
    '*   [Two](https://n.example/2)',
    '*   [Three](https://n.example/3)',
    '',
    'More text here, with [a link](https://n.example/x) inside.',
    '',
    'Another paragraph of ordinary words.',
    '',
    '[Share](https://n.example/s)',
  ].join('\n');
  const out = L.foldLinkRuns(blocks(md));
  assert.deepEqual(
    out.map((b) => b.type),
    ['h', 'p', 'links', 'p', 'p', 'p'],
  );
  assert.equal(out[2].count, 3);
  assert.equal(out[5].type, 'p'); // one lonely link is not worth folding
});

test('foldLinkRuns leaves a page that is mostly links alone', () => {
  const md = ['# Index', '', '*   [One](https://n.example/1)', '*   [Two](https://n.example/2)', '*   [Three](https://n.example/3)'].join('\n');
  const b = blocks(md);
  assert.deepEqual(L.foldLinkRuns(b), b);
});

test('linkLabel shortens bare addresses only', () => {
  assert.equal(L.linkLabel('https://www.a.example/x/y/?z=1#top'), 'a.example/x/y');
  assert.equal(L.linkLabel('https://a.example/' + 'long/'.repeat(20)).length, 40);
  assert.equal(L.linkLabel('Read the docs'), 'Read the docs');
  assert.equal(L.linkLabel('see https://a.example'), 'see https://a.example');
});

test('collectLinks lists each link once, skipping folded lists', () => {
  const md = [
    para(2),
    '',
    'See [the docs](https://n.example/d) and [the docs again](https://n.example/d) and https://n.example/raw or [https://n.example/long/path/here](https://n.example/long/path/here).',
    '',
    '*   [A](https://n.example/a)',
    '*   [B](https://n.example/b)',
    '*   [C](https://n.example/c)',
    '',
    'Closing words for the page.',
    '',
    'Another closing paragraph.',
  ].join('\n');
  const out = L.collectLinks(L.foldLinkRuns(blocks(md)));
  assert.deepEqual(out, [
    { href: 'https://n.example/d', label: 'the docs' },
    { href: 'https://n.example/long/path/here', label: 'n.example/long/path/here' },
  ]);
});

test('tidyBlocks shortens address labels inside folds too, and changes no text otherwise', () => {
  const md = [
    para(2),
    '',
    'x',
    '',
    '*   [https://www.n.example/one/](https://n.example/1)',
    '*   [Two](https://n.example/2)',
    '*   [Three](https://n.example/3)',
    '',
    'Closing words for the page.',
  ].join('\n');
  const out = L.tidyBlocks(blocks(md));
  const fold = out.find((b) => b.type === 'links');
  assert.equal(L.inlineText(fold.blocks[0].items[0].c), 'n.example/one');
  assert.equal(fold.blocks[0].items[0].c[0].href, 'https://n.example/1');
});

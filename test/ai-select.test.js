import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as SEL from '../js/ai-select.js';
import * as A from '../js/ai-lib.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`../bench/fixtures/${n}.json`, import.meta.url), 'utf8'));
const longPage = fx('news-long');
/** Saved-page records the way store.js keeps them: [key, record with url]. */
const savedPages = () => Object.entries(fx('saved-pages')).map(([u, p]) => [u, { url: u, ...p }]);

test('sections drop menus, repeated lines and link lists, and keep headings', () => {
  const md = '# Title\n\nSkip to content\n\nA real paragraph with enough words to be kept in the summary.\n\n[Home](/) [News](/n) [Sport](/s) [Weather](/w)\n\n## Part two\n\nA real paragraph with enough words to be kept in the summary.\n\nAnother distinct paragraph that is long enough to keep around.\n\nSubscribe to our newsletter';
  const s = SEL.sections(md);
  const flat = s.flatMap((x) => x.blocks);
  assert.deepEqual(s.map((x) => x.heading), ['Title', 'Part two']);
  assert.ok(!flat.some((b) => /Skip to content|Subscribe|Home/.test(b)));
  assert.equal(flat.filter((b) => b.startsWith('A real paragraph')).length, 1, 'the repeated paragraph is kept once');
});

test('evidence comes from the whole page, including the end', () => {
  const sel = SEL.selectEvidence(longPage.md, 900);
  assert.ok(sel.chars <= 900);
  assert.ok(sel.spread.start && sel.spread.middle && sel.spread.end, JSON.stringify(sel.spread));
  assert.ok(sel.sectionsUsed >= 4, `${sel.sectionsUsed} sections`);
  assert.match(sel.text, /9 September 2025|opens/, 'the opening date, in the last section, is kept');
  const head = SEL.headEvidence(longPage.md, 900);
  assert.ok(!/9 September 2025/.test(head.text), 'the old approach cut it off');
  const covered = (t) => longPage.facts.filter((f) => t.includes(f)).length;
  assert.ok(covered(sel.text) >= covered(head.text), `new ${covered(sel.text)} vs old ${covered(head.text)} key facts`);
  const small = SEL.selectEvidence(longPage.md, 400);
  assert.ok(covered(small.text) > covered(SEL.headEvidence(longPage.md, 400).text), 'with little room, picking from the whole page keeps more key facts than the first 400 characters');
});

test('evidence is deterministic, in page order, without near-duplicates', () => {
  const a = SEL.selectEvidence(longPage.md, 700);
  const b = SEL.selectEvidence(longPage.md, 700);
  assert.equal(a.text, b.text);
  const dup = '# T\n\nThe committee approved the plan on Tuesday after a long debate.\n\nThe committee approved the plan on Tuesday after a long debate about it.\n\nCosts were estimated at 4 million dollars for the first phase.';
  const sel = SEL.selectEvidence(dup, 2000);
  assert.equal((sel.text.match(/committee approved/g) ?? []).length, 1);
  assert.equal(SEL.selectEvidence('', 500).text, '');
});

test('the summary plan picks one call when it can and a bounded number when it must', () => {
  const small = SEL.planSummary('A short page with just enough text to be a page, said plainly and without any fuss at all.', { perCallChars: 500 });
  assert.equal(small.strategy, 'single');
  assert.equal(small.calls, 1);
  const normal = SEL.planSummary(fx('news-short').md, { perCallChars: 420, maxParts: 3 });
  assert.equal(normal.strategy, 'extract');
  assert.equal(normal.calls, 1);
  assert.ok(normal.text.length <= 420 && normal.note.includes('key sentences'));
  const long = SEL.planSummary(longPage.md, { perCallChars: 400, maxParts: 3 });
  assert.equal(long.strategy, 'hierarchical');
  assert.ok(long.calls <= 4 && long.calls >= 3, `${long.calls} calls`);
  assert.ok(long.parts.every((p) => p.length <= 400));
  assert.ok(long.coverage > 0.2);
  const capped = SEL.planSummary(longPage.md, { perCallChars: 400, maxParts: 2 });
  assert.ok(capped.calls <= 3);
  const noParts = SEL.planSummary(longPage.md, { perCallChars: 400, maxParts: 1 });
  assert.equal(noParts.calls, 1, 'with no parts allowed it stays at one call');
});

test('a summary is only reused for the same model, strategy and page text', () => {
  const base = { pkg: 'lfm350', revision: 'd11593fd9eb408e322667926656598896c2d5ff9', url: 'https://x.example/a', text: 'page text one' };
  const k = SEL.summaryKey(base);
  assert.equal(k, SEL.summaryKey({ ...base }));
  assert.notEqual(k, SEL.summaryKey({ ...base, text: 'page text two' }), 'page changed');
  assert.notEqual(k, SEL.summaryKey({ ...base, revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d' }), 'model revision changed');
  assert.notEqual(k, SEL.summaryKey({ ...base, pkg: 'lfm12' }));
  assert.ok(k.startsWith(SEL.summaryPrefix('lfm350', base.url)));
  assert.ok(k.includes(`|s${SEL.STRATEGY_VERSION}|`), 'the strategy version is in the key');
});

const passage = (id, url, text, extra = {}) => ({ id, url, title: `T ${url}`, text, kind: 'page', ...extra });

test('pickContext enforces the budget even for the first passage', () => {
  const huge = 'It is a very large animal indeed, seen in many seas. '.repeat(40) + 'Its heart weighs as much as a small car. ';
  const all = [passage('a', 'u1', huge)];
  const picked = SEL.pickContext(A.fuse({ words: [0] }), all, 400, 4, { question: 'how heavy is its heart' });
  assert.equal(picked.length, 1);
  assert.ok(picked[0].text.length + SEL.labelCost(all[0]) <= 400, `${picked[0].text.length} chars`);
  assert.equal(picked[0].excerpted, true);
  assert.match(picked[0].text, /heart/, 'the excerpt is the part that matches the question');
});

test('pickContext respects the total budget, per-page cap, near-duplicates and count', () => {
  const mk = (i, url, text) => passage(`p${i}`, url, text);
  const all = [
    mk(0, 'u1', 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron.'),
    mk(1, 'u1', 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi.'), // near-duplicate
    mk(2, 'u1', 'Completely different words about rivers and mountains and lakes and valleys.'),
    mk(3, 'u1', 'Another distinct passage concerning oceans, tides, currents and sailing boats.'),
    mk(4, 'u1', 'Yet another separate passage about deserts, dunes, camels and oases in summer.'),
    mk(5, 'u2', 'Notes from a second page on forests, moss, ferns and the damp shade of trees.'),
  ];
  const ranked = A.fuse({ words: [0, 1, 2, 3, 4, 5] });
  const picked = SEL.pickContext(ranked, all, 5000, 6);
  assert.ok(!(picked.some((p) => p.id === 'p0') && picked.some((p) => p.id === 'p1')), 'near-duplicates are not both picked');
  assert.ok(picked.filter((p) => p.url === 'u1').length <= 3, 'at most 3 from one page');
  const total = picked.reduce((n, p) => n + p.text.length + SEL.labelCost(p), 0);
  assert.ok(total <= 5000);
  assert.ok(SEL.pickContext(ranked, all, 5000, 2).length === 2);
  for (const budget of [150, 300, 600]) {
    const t = SEL.pickContext(ranked, all, budget, 6);
    assert.ok(t.reduce((n, p) => n + p.text.length + SEL.labelCost(p), 0) <= budget, `budget ${budget}`);
  }
  assert.equal(SEL.pickContext(ranked, all, 20, 6).length, 0, 'a budget too small for any useful evidence picks nothing');
});

test('excerpt keeps whole sentences around the best match', () => {
  const text = 'One is first. Two talks about cats and dogs at length. Three is about the weather today. Four mentions the whale heart size in detail. Five ends.';
  const ex = SEL.excerpt(text, 'whale heart', 70);
  assert.ok(ex.text.length <= 70 && ex.cut);
  assert.match(ex.text, /whale heart/);
  assert.equal(SEL.excerpt('short text here', 'x', 100).cut, false);
});

test('collectPassages indexes whole pages (not just the first 40 chunks), with headings', () => {
  const body = Array.from({ length: 120 }, (_, i) => `Paragraph ${i} describes entry number ${i} of the long record in enough words to count. ${'It goes on with further plain detail about the record. '.repeat(8)}`).join('\n\n');
  const md = `# Long record\n\n${body}\n\n## Appendix\n\nThe secret code at the very end of the page is ZEBRA-9.`;
  const ps = SEL.collectPassages([], [['k', { url: 'https://l.example', title: 'Long', markdown: md, at: 1, saved: true }]]);
  assert.ok(ps.length > 40, `${ps.length} passages`);
  const last = ps.at(-1);
  assert.match(last.text, /ZEBRA-9/);
  assert.equal(last.heading, 'Appendix');
  const index = SEL.createIndexer();
  index.sync(ps);
  assert.equal(ps[index.search('zebra secret code', 3)[0].i].heading, 'Appendix', 'text at the end of a long page is findable');
});

test('collectPassages: saved pages replace snippets, duplicates collapse, empty content is skipped', () => {
  const pages = savedPages();
  const results = fx('saved-results');
  const ps = SEL.collectPassages(
    results.map((r) => [`mwmbl|1|${r.q}`, r]),
    pages,
  );
  assert.ok(!ps.some((p) => p.kind === 'result' && p.url === 'https://example.org/sourdough'), 'the shallow snippet of a saved page is dropped');
  assert.ok(ps.some((p) => p.kind === 'result' && p.url === 'https://other.example/easy'));
  assert.ok(ps.some((p) => p.kind === 'instant'));
  const texts = ps.map((p) => p.text);
  assert.equal(new Set(texts).size, texts.length, 'the same paragraph is not indexed twice (the two sourdough pages repeat one)');
  assert.deepEqual(SEL.collectPassages([['w', { now: { temp: 3 } }]], [['e', { url: 'https://e.example', title: 'E', markdown: '' }]]), []);
});

test('the incremental index matches a full rebuild and reuses unchanged passages', () => {
  const all = SEL.collectPassages([], savedPages());
  const index = SEL.createIndexer();
  const first = index.sync(all);
  assert.equal(first.added, all.length);
  const q = 'what temperature to bake sourdough bread';
  const incremental = index.search(q, 5).map((x) => all[x.i].id);
  const full = A.bm25Search(A.bm25Index(all.map((p) => `${p.title} ${p.heading ?? ''} ${p.text}`)), q, 5).map((x) => all[x.i].id);
  assert.deepEqual(incremental, full);
  const second = index.sync(all);
  assert.deepEqual([second.added, second.removed, second.reused], [0, 0, all.length], 'nothing is rebuilt when nothing changed');
  const changed = all.map((p, i) => (i === 0 ? { ...p, text: `${p.text} plus new words about quince` } : p)).slice(0, -1);
  const third = index.sync(changed);
  assert.deepEqual([third.added, third.removed], [1, 1]);
  assert.equal(changed[index.search('quince', 1)[0].i].id, all[0].id);
});

test('embedCandidates: best keyword hits first, then recent pages, never ones that already have a vector, within the cap', () => {
  const all = [0, 1, 2, 3, 4, 5].map((i) => passage(`p${i}`, `u${i}`, `text ${i}`, { at: i }));
  const have = (p) => p.id === 'p3';
  const out = SEL.embedCandidates(all, [{ i: 3 }, { i: 1 }], have, 4);
  assert.deepEqual(out, [1, 5, 4, 2]);
});

test('validVector rejects wrong lengths, non-finite numbers and un-normalised vectors', () => {
  const unit = (n = 384) => Float32Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
  assert.equal(SEL.validVector(unit()), true);
  assert.equal(SEL.validVector(unit(100)), false);
  assert.equal(SEL.validVector(Float32Array.from({ length: 384 }, () => NaN)), false);
  assert.equal(SEL.validVector(Float32Array.from({ length: 384 }, () => 5)), false);
  assert.equal(SEL.validVector(null), false);
  assert.equal(SEL.validVector({ length: 384 }), false);
});

test('ranked sources give a readable list when no model can write an answer', () => {
  const picked = SEL.pickContext(A.fuse({ words: [0] }), [passage('a', 'https://x.example/a', 'A passage about quokkas that is long enough to show.', { heading: 'Animals', at: 5 })], 1000, 3);
  const list = SEL.rankedSources(picked);
  assert.deepEqual([list[0].n, list[0].heading, list[0].url], [1, 'Animals', 'https://x.example/a']);
});

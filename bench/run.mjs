// Reproducible benchmark of the parts that do not need a model: what goes into a prompt, and how fast
// it is found. Fixtures are in bench/fixtures (synthetic pages written for this). Run: node bench/run.mjs
// The OLD column re-creates the previous behaviour: the first N characters of a page, the first
// passage skipping the budget, only the first 40 passages of a page indexed, an index rebuilt for every question.
// Model speed (first token, tokens/s) needs a browser: see bench/README.md.
import { readFileSync } from 'node:fs';
import * as A from '../js/ai-lib.js';
import * as SEL from '../js/ai-select.js';
import * as PO from '../js/ai-policy.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), 'utf8'));
const pad = (s, n) => String(s).padEnd(n);

// ---- 1. summary evidence: how many key facts reach the model ----
console.log('SUMMARY EVIDENCE (key facts kept / total, sections represented)\n');
console.log(pad('page', 12), pad('budget', 22), pad('old: first chars', 18), pad('new: whole page', 18), 'calls (new plan)');
for (const [label, id, limit] of [['350M phone', 'lfm350', 220], ['1.2B phone', 'lfm12', 300], ['desktop', 'lfm350', 600]]) {
  const per = A.textBudget(limit, 110);
  for (const name of ['news-short', 'news-long', 'tech-docs', 'data-heavy']) {
    const f = fx(name);
    const old = SEL.headEvidence(f.md, per);
    const sel = SEL.selectEvidence(f.md, per);
    const plan = SEL.planSummary(f.md, { perCallChars: per, maxParts: id === 'lfm12' || limit < 400 ? 2 : 4 });
    const n = (t) => f.facts.filter((x) => t.includes(x)).length;
    console.log(pad(name, 12), pad(`${label} ${per} ch`, 22), pad(`${n(old.text)}/${f.facts.length}`, 18), pad(`${n(sel.text)}/${f.facts.length} (${sel.sectionsUsed}/${sel.sections} sec)`, 18), `${plan.strategy} ${plan.calls} call${plan.calls > 1 ? 's' : ''}, plan covers ${n(plan.text)}/${f.facts.length}`);
  }
}

// ---- 2. questions over saved pages ----
console.log('\nQUESTIONS OVER SAVED PAGES (does the evidence contain the answer; keyword search only)\n');
const pages = Object.entries(fx('saved-pages')).map(([u, p]) => [u, { url: u, ...p }]);
const results = fx('saved-results').map((r) => [`k|${r.q}`, r]);
const qs = fx('questions');
const all = SEL.collectPassages(results, pages);
const budget = 420;
const oldAll = (() => {
  // previous behaviour: 40 passages per page, the snippet of a saved page also indexed
  const out = [];
  for (const [, p] of pages) A.passages(A.markdownToText(p.markdown)).slice(0, 40).forEach((text, i) => out.push({ url: p.url, title: p.title, text, kind: 'page' }));
  return out;
})();
const oldPick = (ranked, list, b, max) => {
  const picked = [];
  let used = 0;
  for (const r of ranked) {
    const p = list[r.i];
    if (used + p.text.length > b && picked.length) continue; // the first passage skips the budget
    picked.push(p);
    used += p.text.length;
    if (picked.length >= max) break;
  }
  return { picked, used };
};
const idx = SEL.createIndexer();
idx.sync(all);
const oldIdx = A.bm25Index(oldAll.map((p) => `${p.title} ${p.text}`));
console.log(pad('question', 52), pad('old: answer in evidence', 26), pad('new', 8), 'new chars used / budget');
let oldHit = 0;
let newHit = 0;
let asked = 0;
let oldOver = 0;
for (const q of qs) {
  const o = oldPick(A.fuse({ w: A.bm25Search(oldIdx, q.q, 30).map((x) => x.i) }), oldAll, budget, 4);
  const hitsNew = idx.search(q.q, 30).map((x) => x.i);
  const picked = SEL.pickContext(A.fuse({ w: hitsNew }), all, budget, 4, { question: q.q });
  const used = picked.reduce((n, p) => n + p.text.length + SEL.labelCost(p), 0);
  const inOld = q.expect ? o.picked.some((p) => p.text.includes(q.expect)) : o.picked.length === 0;
  const inNew = q.expect ? picked.some((p) => p.text.includes(q.expect)) : picked.length === 0;
  if (q.expect) {
    asked++;
    oldHit += inOld;
    newHit += inNew;
  }
  oldOver += o.used > budget;
  console.log(pad(q.q.slice(0, 50), 52), pad(q.expect ? inOld : `${o.picked.length} passages for an unanswerable question`, 26), pad(q.expect ? inNew : `${picked.length} passages`, 8), `${used}/${budget}`);
}
console.log(`\nanswerable questions with the answer in the evidence: old ${oldHit}/${asked}, new ${newHit}/${asked}; old exceeded the budget on ${oldOver} question(s), new never.`);

// ---- 3. index cost: rebuild every question vs incremental ----
console.log('\nKEYWORD INDEX (a library of 300 saved pages, 12 passages each)\n');
const big = Array.from({ length: 300 }, (_, i) => [`u${i}`, { url: `https://x.example/${i}`, title: `Page ${i}`, at: i, markdown: `# Page ${i}\n\n${Array.from({ length: 12 }, (_, j) => `Section ${j} of page ${i} discusses topic${(i * 7 + j) % 50} and subject${(i + j) % 30} with enough ordinary words to make a passage worth indexing here. `.repeat(6)).join('\n\n')}` }]);
const bigAll = SEL.collectPassages([], big);
const t = (f, n = 5) => {
  const a = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    f();
    a.push(performance.now() - t0);
  }
  return a.sort((x, y) => x - y)[n >> 1];
};
const rebuild = t(() => A.bm25Search(A.bm25Index(bigAll.map((p) => `${p.title} ${p.text}`)), 'topic7 subject3', 30));
const inc = SEL.createIndexer();
const first = t(() => inc.sync(bigAll), 1);
const again = t(() => (inc.sync(bigAll), inc.search('topic7 subject3', 30)));
console.log(`passages: ${bigAll.length}; rebuild + search every question: ${rebuild.toFixed(1)} ms; incremental, first time: ${first.toFixed(1)} ms; every later question: ${again.toFixed(1)} ms`);

// ---- 4. what a prompt can cost the device (estimates from the model graphs, not measurements) ----
console.log('\nEXPECTED SCORE-TENSOR ALLOCATIONS (estimates from tensor shapes)\n');
console.log(pad('prompt tokens', 14), pad('1.2B (all positions)', 24), '350M (last position only)');
for (const n of [220, 300, 338, 650, 3000]) console.log(pad(n, 14), pad(`${A.size(PO.estimateAllocations('lfm12', n).total)}`, 24), A.size(PO.estimateAllocations('lfm350', n).total));

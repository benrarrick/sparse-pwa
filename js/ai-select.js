// What goes into a prompt, chosen deterministically (no model involved):
//   - summaries: sentences picked from the WHOLE page (headings, lead, numbers, names, the middle
//     and the end), not just its beginning, planned as one call or a bounded number of parts
//   - questions: passage excerpts that fit a hard budget, an incremental keyword index, and
//     near-duplicate removal
// Pure: no DOM, no storage. Tested in test/ and measured by bench/.
import { tokenize, hash, markdownToText } from './ai-lib.js';

/** Bump when the way evidence is chosen changes: it is part of the summary cache key. */
export const STRATEGY_VERSION = 3;

// ---------- cleaning and structure ----------

const BOILERPLATE =
  /^(?:skip to (?:main )?content|menu|search|sign (?:in|up)|log ?in|subscribe|newsletter|advertisement|sponsored|share(?: this)?|follow us|related (?:articles|stories|posts)|read more|more from|you (?:might|may) also like|recommended|cookies?|accept (?:all )?cookies|privacy (?:policy|settings)|terms (?:of use|and conditions)|copyright|all rights reserved|©|back to top|comments?|leave a (?:reply|comment)|trending|most read|sign up for|click here|loading)\b/i;

/** A line that is mostly links or very short navigation. */
function isNavLine(raw) {
  const t = raw.trim();
  if (!t) return false;
  if (BOILERPLATE.test(t) && t.length < 140) return true;
  const links = [...t.matchAll(/\[[^\]]*\]\([^)]*\)/g)].reduce((n, m) => n + m[0].length, 0);
  if (links > t.length * 0.6 && t.length > 20) return true;
  return false;
}

/**
 * Splits markdown into sections by heading: [{ heading, level, blocks: [paragraph text] }].
 * Text before the first heading is a section with no heading (the lead).
 */
export function sections(markdown) {
  const out = [{ heading: '', level: 0, blocks: [] }];
  const seen = new Set();
  let para = [];
  const flush = () => {
    if (!para.length) return;
    const text = markdownToText(para.join(' ')).replace(/\s+/g, ' ').trim();
    para = [];
    if (text.length < 25) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return; // exact repeats (menus, repeated captions)
    seen.add(key);
    out.at(-1).blocks.push(text);
  };
  for (const raw of String(markdown ?? '').split(/\r?\n/)) {
    const m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (m) {
      flush();
      const heading = markdownToText(m[2]).trim();
      if (heading && !BOILERPLATE.test(heading)) out.push({ heading, level: m[1].length, blocks: [] });
      else out.push({ heading: '', level: 0, blocks: [], skip: true });
      continue;
    }
    if (!raw.trim()) {
      flush();
      continue;
    }
    if (isNavLine(raw)) {
      flush();
      continue;
    }
    para.push(raw.trim());
  }
  flush();
  return out.filter((s) => !s.skip && s.blocks.length);
}

const SPLIT = /(?<=[.!?])["')\]]?\s+(?=[A-Z0-9"'(•-])/;
/** Sentences of a paragraph, kept whole (long ones are cut at a comma or space). */
export function sentences(text, max = 320) {
  const out = [];
  for (const s of text.split(SPLIT)) {
    let t = s.trim();
    while (t.length > max) {
      const cut = Math.max(t.lastIndexOf(', ', max), t.lastIndexOf('; ', max), t.lastIndexOf(' ', max));
      out.push(t.slice(0, cut > max * 0.5 ? cut : max).trim());
      t = t.slice(cut > max * 0.5 ? cut + 1 : max).trim();
    }
    if (t) out.push(t);
  }
  return out.filter((s) => s.length >= 25);
}

// ---------- scoring ----------

const DATE = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s+\d{1,2}\b/i;
const QUANT = /\b\d[\d,.]*\s?(?:%|percent|million|billion|thousand|km|kg|mb|gb|mph|°|c\b|f\b|dollars?|usd|\$|£|€)|[$£€]\s?\d/i;

/**
 * Scores each sentence 0..~10 from: position (a section's first sentence, the page's lead),
 * numbers and dates, named things (capitalised words inside the sentence), how central its words
 * are to the whole page (words that recur across the page weigh more; ones in every sentence less),
 * and overlap with the headings. Deterministic.
 */
export function scoreSentences(secs) {
  const all = [];
  const df = new Map();
  for (const [si, s] of secs.entries())
    for (const [bi, b] of s.blocks.entries())
      for (const [ti, text] of sentences(b).entries()) {
        const terms = new Set(tokenize(text));
        for (const t of terms) df.set(t, (df.get(t) ?? 0) + 1);
        all.push({ si, bi, ti, text, terms, len: text.length });
      }
  const n = Math.max(1, all.length);
  const headTerms = new Set(secs.flatMap((s) => tokenize(s.heading)));
  const termWeight = (t) => {
    const f = df.get(t) ?? 1;
    // appears in a few sentences = topical; in nearly all = filler; in one only = maybe noise
    return f === 1 ? 0.6 : Math.log(1 + n / f) * Math.min(1, 0.4 + f / 5);
  };
  for (const x of all) {
    let central = 0;
    for (const t of x.terms) central += termWeight(t);
    central /= Math.sqrt(x.terms.size + 3);
    const names = (x.text.slice(1).match(/(?<![.!?]\s)\b[A-Z][a-z]{2,}/g) ?? []).length;
    const head = [...x.terms].filter((t) => headTerms.has(t)).length;
    const first = x.bi === 0 && x.ti === 0;
    x.score =
      central * 1.4 +
      (first ? 1.6 : 0) +
      (x.si === 0 && x.bi === 0 ? 1.1 : 0) +
      (DATE.test(x.text) ? 0.9 : 0) +
      (QUANT.test(x.text) ? 1.1 : 0) +
      Math.min(1.2, names * 0.3) +
      Math.min(1, head * 0.35) -
      (x.len < 45 ? 0.8 : 0) -
      (x.len > 280 ? 0.5 : 0) -
      (/^["“]/.test(x.text) && x.len < 80 ? 0.6 : 0);
  }
  return all;
}

const jaccard = (a, b) => {
  let i = 0;
  for (const t of a) if (b.has(t)) i++;
  return i / Math.max(1, a.size + b.size - i);
};

/**
 * Chooses sentences up to `chars` from across the page, in page order.
 * Every section gets its best sentence before any section gets a second, ordered by how much the
 * section is worth, so the middle and end of a long page are represented. Near-duplicates are skipped.
 * Section headings label the text only when there is room (in a small prompt every character is for facts).
 */
export function selectEvidence(markdown, chars, { withHeadings = chars >= 700 } = {}) {
  const secs = sections(markdown);
  const total = secs.reduce((n, s) => n + s.blocks.reduce((m, b) => m + b.length, 0), 0);
  if (!total) return { text: '', picked: 0, sections: 0, sectionsUsed: 0, chars: 0, of: 0, coverage: 0, spread: { start: false, middle: false, end: false } };
  const scored = scoreSentences(secs);
  // value per character: a short sentence full of facts beats a long one with the same score
  const dens = (x) => x.score / Math.sqrt(x.len + 80);
  const bySection = secs.map((_, i) => scored.filter((x) => x.si === i).sort((a, b) => dens(b) - dens(a)));
  const order = bySection.map((list, i) => ({ i, worth: list.slice(0, 3).reduce((n, x) => n + x.score, 0) })).sort((a, b) => b.worth - a.worth);
  const chosen = [];
  const used = new Set();
  let size = 0;
  const headCost = (si) => (withHeadings && secs[si].heading && !used.has(si) ? secs[si].heading.length + 3 : 0);
  const take = (x) => {
    const cost = x.len + 1 + headCost(x.si);
    if (size + cost > chars) return false;
    if (chosen.some((c) => jaccard(c.terms, x.terms) > 0.7)) return false;
    chosen.push(x);
    size += cost;
    used.add(x.si);
    return true;
  };
  for (let round = 0; round < 4 && size < chars; round++)
    for (const { i } of order) {
      const x = bySection[i][round];
      if (x && x.score > (round === 0 ? -1 : 1.6)) take(x);
    }
  chosen.sort((a, b) => a.si - b.si || a.bi - b.bi || a.ti - b.ti);
  let text = '';
  let lastSec = -1;
  for (const x of chosen) {
    if (x.si !== lastSec) {
      if (withHeadings && secs[x.si].heading) text += `${text ? '\n' : ''}${secs[x.si].heading}:\n`;
      lastSec = x.si;
    }
    text += `${x.text} `;
  }
  text = text.trim();
  const positions = chosen.map((x) => x.si / Math.max(1, secs.length - 1 || 1));
  return {
    text,
    picked: chosen.length,
    sections: secs.length,
    sectionsUsed: used.size,
    chars: text.length,
    of: total,
    coverage: Math.min(1, chosen.reduce((n, x) => n + x.len, 0) / total),
    spread: {
      start: positions.some((p) => p < 0.34),
      middle: positions.some((p) => p >= 0.34 && p < 0.67) || secs.length < 3,
      end: positions.some((p) => p >= 0.67) || secs.length < 2,
    },
  };
}

/** The old behaviour, for comparison in bench/: the first `chars` characters. */
export function headEvidence(markdown, chars) {
  const text = markdownToText(markdown);
  const cut = text.length <= chars ? text : text.slice(0, chars);
  return { text: cut, chars: cut.length, of: text.length, coverage: Math.min(1, cut.length / Math.max(1, text.length)) };
}

// ---------- the plan ----------

/**
 * Plans a summary for a prompt that holds `perCallChars` of text.
 *   single        the page fits: one call
 *   extract       one call over sentences picked from the whole page
 *   hierarchical  notes on up to `maxParts` parts (each picked from its stretch of the page), then
 *                 a combining call. Used only when one call would cover too little of a long page.
 * `maxCalls` bounds the work: parts + 1.
 */
export function planSummary(markdown, { perCallChars, maxParts = 3, minSingleCoverage = 0.3 }) {
  const full = markdownToText(markdown);
  if (full.length <= perCallChars) return { strategy: 'single', parts: [full], text: full, coverage: 1, calls: 1, of: full.length, sections: 1, sectionsUsed: 1, spread: { start: true, middle: true, end: true }, note: '' };
  const one = selectEvidence(markdown, perCallChars);
  const secs = sections(markdown);
  const enough = one.coverage >= minSingleCoverage || secs.length <= 2 || maxParts < 2;
  if (enough) return { strategy: 'extract', parts: [one.text], text: one.text, coverage: one.coverage, calls: 1, of: one.of, sections: one.sections, sectionsUsed: one.sectionsUsed, spread: one.spread, note: noteFor(one) };
  // hierarchical: split the sections into up to maxParts consecutive stretches of similar size
  const sizes = secs.map((s) => s.blocks.reduce((n, b) => n + b.length, 0));
  const total = sizes.reduce((a, b) => a + b, 0);
  const k = Math.min(maxParts, Math.max(2, Math.ceil(total / (perCallChars * 3))));
  const stretches = [];
  let cur = [];
  let acc = 0;
  for (const [i, s] of secs.entries()) {
    cur.push(s);
    acc += sizes[i];
    if (acc >= total / k && stretches.length < k - 1) {
      stretches.push(cur);
      cur = [];
      acc = 0;
    }
  }
  if (cur.length) stretches.push(cur);
  const parts = stretches.map((st) => {
    const md = st.map((s) => `${s.heading ? `## ${s.heading}\n\n` : ''}${s.blocks.join('\n\n')}`).join('\n\n');
    return selectEvidence(md, perCallChars);
  });
  const picked = parts.reduce((n, p) => n + p.chars, 0);
  const sectionsUsed = parts.reduce((n, p) => n + p.sectionsUsed, 0);
  return {
    strategy: 'hierarchical',
    parts: parts.map((p) => p.text),
    text: parts.map((p) => p.text).join('\n'),
    coverage: Math.min(1, parts.reduce((n, p) => n + p.coverage * p.of, 0) / total),
    calls: parts.length + 1,
    of: total,
    sections: secs.length,
    sectionsUsed,
    spread: { start: true, middle: parts.length > 2 || secs.length < 3, end: true },
    note: `${picked.toLocaleString()} characters chosen from across the page, read in ${parts.length} parts`,
  };
}

function noteFor(sel) {
  return `${sel.picked} key sentences from ${sel.sectionsUsed} of ${sel.sections} section${sel.sections === 1 ? '' : 's'}${sel.spread.end ? ', through to the end' : ''}`;
}

/** The identity of a summary: change the model, the way evidence is chosen, or the page, and it is stale. */
export const summaryKey = ({ pkg, revision, url, text }) => `sum|${pkg}|${url}|${(revision ?? '').slice(0, 8)}|s${STRATEGY_VERSION}|${hash(text)}`;
export const summaryPrefix = (pkg, url) => `sum|${pkg}|${url}|`;

// ---------- questions ----------

/** Splits markdown into passages that remember their section heading: [{ heading, text }]. */
export function headedPassages(markdown, size = 700) {
  const out = [];
  for (const s of sections(markdown)) {
    const text = s.blocks.join('\n\n');
    for (const p of splitPassages(text, size)) out.push({ heading: s.heading, text: p });
  }
  return out;
}

function splitPassages(text, size) {
  const units = [];
  for (const para of text.split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) units.push(p);
    else for (const s of sentences(p, size)) units.push(s);
  }
  const out = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > size) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${u}` : u;
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.length > 40);
}

/** The part of a passage that best matches the question, at most `max` characters. */
export function excerpt(text, question, max) {
  if (text.length <= max) return { text, cut: false };
  const q = new Set(tokenize(question));
  const ss = sentences(text, max);
  if (!ss.length) return { text: text.slice(0, max).trim(), cut: true };
  const score = (s) => tokenize(s).filter((t) => q.has(t)).length;
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < ss.length; i++) {
    const sc = score(ss[i]) * 2 + (i === 0 ? 0.5 : 0);
    if (sc > bestScore) {
      bestScore = sc;
      best = i;
    }
  }
  // grow around the best sentence while it fits
  let lo = best;
  let hi = best;
  let len = ss[best].length;
  for (;;) {
    const next = [hi + 1 < ss.length ? hi + 1 : null, lo - 1 >= 0 ? lo - 1 : null].filter((x) => x != null).sort((a, b) => score(ss[b]) - score(ss[a]));
    const pick = next.find((i) => len + ss[i].length + 1 <= max);
    if (pick == null) break;
    if (pick > hi) hi = pick;
    else lo = pick;
    len += ss[pick].length + 1;
  }
  const body = ss.slice(lo, hi + 1).join(' ');
  return { text: body.length > max ? body.slice(0, max).trim() : body, cut: true };
}

/** What a source costs in the prompt besides its text: the "[3] Title (…)\n" label. */
export const labelCost = (p) => 8 + String(p.title ?? '').length + (p.heading ? p.heading.length + 3 : 0) + (p.kind === 'result' ? 24 + String(p.q ?? '').length : 0);

/**
 * Picks passages for a prompt with a HARD character budget (labels included). The best passage is
 * shortened to a relevant excerpt if it alone is too long, so the first pick never skips the
 * budget. At most `maxPerUrl` from one page, no near-duplicates, at most `max` in all.
 */
export function pickContext(ranked, all, budget, max = 6, { question = '', maxPerUrl = 3, minChars = 80 } = {}) {
  const picked = [];
  const perUrl = new Map();
  const seen = [];
  let used = 0;
  for (const r of ranked) {
    const p = all[r.i];
    if (!p || (perUrl.get(p.url) ?? 0) >= maxPerUrl) continue;
    const terms = new Set(tokenize(p.text));
    if (seen.some((s) => jaccard(s, terms) > 0.75)) continue;
    const room = budget - used - labelCost(p);
    if (room < minChars) continue;
    const ex = p.text.length <= room ? { text: p.text, cut: false } : excerpt(p.text, question, room);
    if (!ex.text) continue;
    picked.push({ ...p, text: ex.text, excerpted: ex.cut, from: r.from });
    seen.push(terms);
    perUrl.set(p.url, (perUrl.get(p.url) ?? 0) + 1);
    used += ex.text.length + labelCost(p);
    if (picked.length >= max) break;
  }
  return picked;
}

// ---------- an incremental keyword index ----------

/**
 * A BM25 index that is updated, not rebuilt: passages that are unchanged since the last call (same
 * id and text hash) keep their term counts. `sync(passages)` returns how many were added, removed
 * and reused. Terms come from ai-lib's tokenize so results match the one-shot bm25Search.
 */
export function createIndexer() {
  const docs = new Map(); // id -> { h, tf, len }
  const df = new Map();
  let total = 0;
  let order = [];
  const addDoc = (id, h, text) => {
    const tf = new Map();
    const words = tokenize(text);
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    docs.set(id, { h, tf, len: words.length });
    for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    total += words.length;
  };
  const dropDoc = (id) => {
    const d = docs.get(id);
    if (!d) return;
    for (const w of d.tf.keys()) {
      const n = df.get(w) - 1;
      if (n <= 0) df.delete(w);
      else df.set(w, n);
    }
    total -= d.len;
    docs.delete(id);
  };
  return {
    sync(passages) {
      const stats = { added: 0, removed: 0, reused: 0, ms: 0 };
      const t0 = performance.now();
      const live = new Set(passages.map((p) => p.id));
      for (const id of [...docs.keys()])
        if (!live.has(id)) {
          dropDoc(id);
          stats.removed++;
        }
      for (const p of passages) {
        const h = hash(`${p.title} ${p.heading ?? ''} ${p.text}`);
        const d = docs.get(p.id);
        if (d?.h === h) stats.reused++;
        else {
          if (d) dropDoc(p.id);
          addDoc(p.id, h, `${p.title} ${p.heading ?? ''} ${p.text}`);
          stats.added++;
        }
      }
      order = passages.map((p) => p.id);
      stats.ms = performance.now() - t0;
      return stats;
    },
    /** Indices (into the last synced list) of the best matches: [{ i, score }]. */
    search(query, limit = 30, k1 = 1.2, b = 0.75) {
      const terms = [...new Set(tokenize(query))];
      const n = docs.size;
      const avg = total / Math.max(1, n);
      const scored = [];
      for (const [i, id] of order.entries()) {
        const d = docs.get(id);
        let s = 0;
        for (const t of terms) {
          const f = d.tf.get(t);
          if (!f) continue;
          const dfv = df.get(t);
          s += (Math.log(1 + (n - dfv + 0.5) / (dfv + 0.5)) * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (avg || 1)));
        }
        if (s > 0) scored.push({ i, score: s });
      }
      return scored.sort((x, y) => y.score - x.score).slice(0, limit);
    },
    size: () => docs.size,
  };
}

/**
 * Passages worth embedding for a question without embedding everything: the best keyword matches,
 * then recent saved pages, up to `cap`, skipping ones that already have a vector.
 */
export function embedCandidates(all, keywordHits, have, cap) {
  const out = [];
  const add = (i) => {
    if (out.length < cap && !have(all[i]) && !out.includes(i)) out.push(i);
  };
  for (const h of keywordHits) add(h.i ?? h);
  const recent = all.map((p, i) => ({ i, at: p.at ?? 0, page: p.kind === 'page' })).filter((x) => x.page).sort((a, b) => b.at - a.at);
  for (const x of recent) add(x.i);
  return out;
}

/** A readable ranked list, for when no model can write an answer. */
export function rankedSources(picked) {
  return picked.map((p, i) => ({ n: i + 1, title: p.title, heading: p.heading ?? '', url: p.url, text: p.text, kind: p.kind, q: p.q, at: p.at, via: p.from ?? [] }));
}

// ---------- what can be searched ----------

const snippetText = (snippet) => (Array.isArray(snippet) ? snippet.map((s) => s.text).join('') : String(snippet ?? ''));

/**
 * Everything on the device that questions can be answered from, as passages: pages read in the
 * reader (every part of them: how much is INDEXED is separate from how much fits a prompt), and
 * search results (title + snippet) and instant answers. A saved page replaces the shallow snippet
 * of the same address. `results` and `pages` are [key, record] pairs from store.js.
 */
export function collectPassages(results, pages, { perPage = 400 } = {}) {
  const out = [];
  const savedUrls = new Set();
  const seenText = new Set();
  for (const [, p] of pages) {
    if (!p?.url || !p.markdown) continue;
    savedUrls.add(p.url);
    const title = p.title || p.url;
    for (const [i, c] of headedPassages(p.markdown).slice(0, perPage).entries()) {
      const key = hash(c.text);
      if (seenText.has(key)) continue; // the same paragraph on two pages
      seenText.add(key);
      out.push({ id: `p|${p.url}|${i}`, kind: 'page', url: p.url, title, heading: c.heading, text: c.text, at: p.at, saved: !!p.saved });
    }
  }
  const seen = new Set();
  const recs = results.map(([, r]) => r).filter((r) => Array.isArray(r?.results) && r.q).sort((a, b) => b.at - a.at);
  for (const r of recs) {
    if (r.instant?.text && !seen.has(`i|${r.q.toLowerCase()}`)) {
      seen.add(`i|${r.q.toLowerCase()}`);
      out.push({ id: `i|${r.q.toLowerCase()}`, kind: 'instant', url: r.instant.url ?? null, title: r.instant.heading || r.q, text: r.instant.text, q: r.q, at: r.at });
    }
    for (const x of r.results) {
      if (!x?.url || seen.has(x.url) || savedUrls.has(x.url)) continue;
      seen.add(x.url);
      const text = `${x.title}. ${snippetText(x.snippet)}`.trim();
      if (text.length > 20 && !seenText.has(hash(text))) {
        seenText.add(hash(text));
        out.push({ id: `r|${x.url}`, kind: 'result', url: x.url, title: x.title || x.url, text, q: r.q, at: r.at });
      }
    }
  }
  return out;
}

/** A stored vector is usable only if it is the right length, finite and (nearly) unit length. */
export function validVector(v, dim = 384) {
  if (!v || typeof v.length !== 'number' || v.length !== dim) return false;
  let n = 0;
  for (let i = 0; i < dim; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) return false;
    n += x * x;
  }
  return Math.abs(Math.sqrt(n) - 1) < 0.05;
}

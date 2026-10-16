// Sparse: a small search PWA with no server of its own. Routes live in the URL hash:
//   #/            home: search box, queue, recent searches, saved pages, data use
//   #/s?q=&p=&e=  results (q = query, p = page, e = engine)
//   #/r?u=        reader view of a page, through Jina Reader (Wikipedia: its own API, section by section)
//   #/net         network details: every request, totals per service, how the app loaded
//   #/settings
//   #/ai          on-device AI: downloads, device checks, diagnostics (all opt-in)
//   #/ask?q=      ask the on-device AI, from saved pages and searches or on its own
// Every screen narrates what it is doing in an activity log, and every request is measured (net.js).
// Shown on the home page so you can tell which build a phone is really running (the offline cache can lag a visit or two behind).
// BUMP THIS WITH EVERY CHANGE: 2.0 -> 2.1 for a small change, 3.0 for a big one. See CLAUDE.md.
const APP_VERSION = '4.1';
import * as L from './lib.js';
import * as N from './net.js';
import * as S from './store.js';
import * as AI from './ai.js';
import * as AL from './ai-lib.js';
import * as SEL from './ai-select.js';
import * as SP from './speed.js';
import * as C from './convert.js';
import * as P from './places.js';
import * as W from './wiki.js';

const DEFAULTS = {
  engine: 'mwmbl',
  mojeekKey: '',
  marginaliaKey: 'public',
  fallback: true,
  region: '',
  safe: false,
  ddg: 'lite',
  units: 'auto',
  instant: true,
  openIn: 'reader',
  cacheHours: 6,
  jinaKey: '',
  showActivity: false,
  weatherDetail: 'basic',
  wikipedia: true,
  aiModel: 'lfm350',
  aiAutoSummary: false,
};
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const { formatBytes: B, formatMs: T } = L;

let settings = { ...DEFAULTS };
let renderId = 0;
const main = document.getElementById('main');
const scrollPos = new Map();

// ---------- DOM helpers (no innerHTML anywhere: page and API text is untrusted) ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** replaceChildren that skips null/false and flattens arrays. */
const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
const render = (...nodes) => fill(main, ...nodes);
const hashFor = (path, params) => `#${path}?${new URLSearchParams(params)}`;
const external = (href, text, cls) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: cls }, text);
const settle = () => window.scrollTo(0, scrollPos.get(location.hash) ?? 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const jsonSize = (v) => new Blob([JSON.stringify(v)]).size;

function twoTap(label, action) {
  const b = h('button', { type: 'button', class: 'link' }, label);
  let armed = false;
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Tap again to confirm';
      setTimeout(() => {
        armed = false;
        b.textContent = label;
      }, 4000);
      return;
    }
    await action();
    route();
  });
  return b;
}

/** A titled card, the unit of layout. `action` (optional) sits at the right of the title. */
function group(title, action, ...body) {
  return h('section', { class: 'group' }, title ? h('div', { class: 'group-head' }, h('h2', null, title), action) : null, ...body);
}

/** A collapsible group (settings, logs): closed unless `open`. */
function fold(title, open, ...body) {
  return h('details', { class: 'group', open }, h('summary', null, title), ...body);
}

/** A notice with an optional dismiss (×) button. kind: 'info' | 'warn' | 'bad'. */
function banner(kind, content, { actions = [], onDismiss } = {}) {
  const el = h(
    'div',
    { class: `banner ${kind === 'info' ? '' : kind}`.trim(), role: kind === 'bad' ? 'alert' : 'status' },
    h('div', { class: 'banner-text' }, h('p', null, content), actions.length ? h('div', { class: 'banner-actions' }, actions) : null),
    onDismiss
      ? h('button', {
          type: 'button',
          class: 'dismiss',
          'aria-label': 'Dismiss',
          onclick: async () => {
            await onDismiss();
            el.remove();
          },
        }, '×')
      : null,
  );
  return el;
}

function describe(e) {
  if (e instanceof N.HttpError) {
    if (e.status === 503 || e.status === 429) return `HTTP ${e.status}: busy or rate-limited`;
    if (e.status === 401 || e.status === 403) return `HTTP ${e.status}: access refused (check the key in Settings)`;
    return `HTTP ${e.status}`;
  }
  return e?.message || String(e);
}

/** "7.5 KB received, ≈2.4 KB on the wire" for a set of requests. */
function amount(t) {
  if (!t || !t.requests) return 'nothing downloaded';
  return `${B(t.received)} received, ${t.estimated ? '≈' : ''}${B(t.wire)} on the wire, ${plural(t.requests, 'request')}`;
}

// ---------- bottom bar: what is happening now, and this session's totals ----------

const bar = { now: document.getElementById('now'), tot: document.getElementById('tot') };

// ---------- back / forward / home (a home-screen app has no browser buttons) ----------
// Each history entry gets an index in history.state, so the buttons know when there is
// somewhere to go back or forward to.

const navBtn = { back: document.getElementById('nav-back'), fwd: document.getElementById('nav-fwd'), home: document.getElementById('nav-home') };
let navIndex = 0;
let navMax = 0;

function trackHistory() {
  const i = history.state?.i;
  if (typeof i === 'number') navIndex = i;
  else {
    navIndex = navIndex + 1; // a new entry: anything that was ahead of it is gone
    navMax = navIndex;
    history.replaceState({ i: navIndex }, '', location.href);
  }
  navMax = Math.max(navMax, navIndex);
  try {
    sessionStorage.setItem('navMax', String(navMax));
  } catch {
    // private mode: the buttons still work for this page load
  }
  navBtn.back.disabled = navIndex <= 0;
  navBtn.fwd.disabled = navIndex >= navMax;
}

function initNav() {
  try {
    navMax = Number(sessionStorage.getItem('navMax')) || 0;
  } catch {
    navMax = 0;
  }
  if (typeof history.state?.i !== 'number') {
    history.replaceState({ i: 0 }, '', location.href);
    navMax = 0;
  }
  trackHistory();
  navBtn.back.addEventListener('click', () => history.back());
  navBtn.fwd.addEventListener('click', () => history.forward());
  navBtn.home.addEventListener('click', () => {
    if (currentPath() === '/') window.scrollTo(0, 0);
    else location.hash = '#/';
  });
}
// The menu holds the pages that aren't Home, so the bar stays one row.
const menuBtn = document.getElementById('menu-btn');
const menuPanel = document.getElementById('menu');

function closeMenu() {
  menuPanel.hidden = true;
  menuBtn.setAttribute('aria-expanded', 'false');
}

function openMenu() {
  const here = currentPath();
  const item = (path, label, note) =>
    h('a', { href: `#${path}`, 'aria-current': here === path ? 'page' : null }, label, note ? h('small', null, note) : null);
  const canAsk = AL.MODEL_IDS.some((x) => AI.isReady(x) && x !== 'engine');
  fill(
    menuPanel,
    item('/', 'Home'),
    canAsk ? item('/ask', 'Ask', 'on-device AI') : null,
    item('/net', 'Network', 'data used'),
    item('/ai', 'On-device AI'),
    item('/settings', 'Settings'),
  );
  menuPanel.hidden = false;
  menuBtn.setAttribute('aria-expanded', 'true');
}

function initMenu() {
  menuBtn.addEventListener('click', () => (menuPanel.hidden ? openMenu() : closeMenu()));
  menuPanel.addEventListener('click', (e) => e.target.closest('a') && closeMenu());
  document.addEventListener('click', (e) => !menuPanel.hidden && !e.target.closest('.appbar') && closeMenu());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
}

let idleTimer;
const active = new Map();

function idleText() {
  if (!navigator.onLine) return 'Offline';
  return 'Idle';
}

function setNow(text) {
  clearTimeout(idleTimer);
  if (text) bar.now.textContent = text;
  if (!active.size) idleTimer = setTimeout(() => (bar.now.textContent = idleText()), text ? 4000 : 0);
}

function updateTotals() {
  const s = N.session;
  bar.tot.textContent = `↓ ${B(s.received)} · ≈${B(s.wire)} wire · ${s.requests} req`;
}

// ---------- persistent network log and totals ----------

let netLog = [];
let netTotals = null;
let saveTimer;

function emptyTotals() {
  return { since: Date.now(), requests: 0, received: 0, wire: 0, ms: 0, errors: 0, by: {} };
}

function recordEntry(e) {
  netLog = [{ ...e }, ...netLog].slice(0, 150);
  const add = (t) => {
    t.requests++;
    t.received += e.received;
    t.wire += e.wire ?? e.received;
    t.ms += e.ms ?? 0;
    if (e.error) t.errors++;
  };
  add(netTotals);
  add((netTotals.by[e.service] ??= { requests: 0, received: 0, wire: 0, ms: 0, errors: 0 }));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    S.kvSet('netlog', netLog).catch(() => {});
    S.kvSet('nettotals', netTotals).catch(() => {});
  }, 800);
}

let netPageTimer;
N.onNet((type, e) => {
  if (type === 'start') active.set(e.id, e);
  if (type === 'progress' || type === 'start')
    setNow(e.phase === 'connecting' ? `${e.service}: connecting…` : `${e.service}: ↓ ${B(e.received)} in ${T(e.ms)} (≈${L.formatSpeed(e.received, e.ms)})`);
  if (type === 'done') {
    active.delete(e.id);
    recordEntry(e);
    updateTotals();
    setNow(`${e.service}: ${e.error ? `failed (${e.error})` : `${B(e.received)} in ${T(e.ms)}`}`);
    if (currentPath() === '/net') {
      clearTimeout(netPageTimer);
      netPageTimer = setTimeout(route, 500);
    }
  }
});

// ---------- activity log shown on each screen ----------

/**
 * A collapsible, timestamped log of what a screen is doing. `fetch()` makes a measured request
 * and keeps one line updated with its progress, then its sizes and speed.
 */
function activity(title) {
  const list = h('ol', { class: 'log' });
  const head = h('span', null, title);
  const el = h('details', { class: 'activity', open: settings.showActivity }, h('summary', null, head), list);
  const t0 = performance.now();
  const tot = { requests: 0, received: 0, wire: 0, estimated: false };
  const add = (kind, text) => {
    const body = h('span', null, text);
    list.append(h('li', { class: kind }, h('span', { class: 't' }, `+${((performance.now() - t0) / 1000).toFixed(2)}s`), body));
    setNow(text);
    return {
      set(t, k) {
        body.textContent = t;
        if (k) body.parentElement.className = k;
      },
    };
  };
  const count = (e) => {
    tot.requests++;
    tot.received += e.received;
    tot.wire += e.wire ?? e.received;
    if (e.wireKind !== 'exact') tot.estimated = true;
  };
  return {
    el,
    tot,
    step: (t) => add('step', t),
    ok: (t) => add('ok', t),
    warn: (t) => add('warn', t),
    skip: (t) => add('skip', t),
    async fetch(url, opts = {}) {
      const name = L.serviceOf(url);
      const line = add('net', `↓ ${name}: connecting…`);
      try {
        const r = await N.request(url, {
          ...opts,
          onProgress: (e) =>
            line.set(
              e.phase === 'connecting'
                ? `↓ ${name}: connecting…`
                : `↓ ${name}: HTTP ${e.status}, receiving ${B(e.received)} · ${T(e.ms)} · ≈${L.formatSpeed(e.received, e.ms)}…`,
            ),
        });
        line.set(`↓ ${name}: ${L.describeTransfer(r.entry)}`);
        count(r.entry);
        return r;
      } catch (e) {
        if (e.entry) {
          line.set(`✗ ${name}: ${L.describeTransfer(e.entry)}`, 'bad');
          count(e.entry);
        }
        throw e;
      }
    },
    finish(label) {
      head.textContent = `${label} · ${amount(tot)} · ${T(performance.now() - t0)}`;
      setNow(`${label} · ${amount(tot)}`);
    },
  };
}

// ---------- search, queue and pages (shared by the views and the offline queue) ----------

const failedAt = new Map();
const resultsKey = (q, page, engine) => `${engine}|${page}|${q.trim().toLowerCase()}`;

async function runSearch(q, page, chosen, act, knownInstant) {
  for (const s of L.skippedEngines(settings, chosen)) act.skip(`Skipped ${L.ENGINES[s.id].name}: ${s.reason}`);
  // Engines that failed in the last few minutes go last, so a slow one doesn't cost a timeout every search.
  const failing = (id) => Date.now() - (failedAt.get(id) ?? 0) < 5 * MIN;
  const all = L.engineOrder(settings, chosen);
  const order = [...all.filter((id) => !failing(id)), ...all.filter(failing)];
  for (const id of all.filter(failing)) act.skip(`${L.ENGINES[id].name} failed ${L.relTime(failedAt.get(id))}, so it goes last`);
  if (!order.length) throw new Error('No search engine is available. Check Settings.');
  act.step(`Plan: ${order.map((id) => L.ENGINES[id].name).join(', then ')}`);

  let instant = Promise.resolve(null);
  if (page > 1) act.skip('Instant answer: only on the first page');
  else if (knownInstant !== undefined) {
    act.skip(`Instant answer: reusing the ${knownInstant ? 'one' : 'result'} from the free search, nothing downloaded`);
    instant = Promise.resolve(knownInstant);
  } else if (!settings.instant) act.skip('Instant answer: turned off in Settings');
  else {
    act.step('Asking DuckDuckGo for an instant answer, alongside the search…');
    instant = act
      .fetch(L.instantUrl(q), { timeout: 8000 })
      .then((r) => {
        const a = L.parseInstant(r.json(), q);
        if (a) act.ok(`Instant answer found${a.source ? ` (from ${a.source})` : ''}`);
        else act.skip('No instant answer for this search');
        return a;
      })
      .catch((e) => {
        act.warn(`Instant answer failed: ${describe(e)}`);
        return null;
      });
  }

  const notes = [];
  let allNetwork = true;
  for (const [i, id] of order.entries()) {
    const engine = L.ENGINES[id];
    const next = order[i + 1] ? L.ENGINES[order[i + 1]].name : null;
    act.step(`Trying ${engine.name}${i ? ' (fallback)' : ''}${page > 1 ? `, page ${page}` : ''}…`);
    try {
      const r = await act.fetch(engine.url({ ...settings, q, page }), { timeout: 8000 });
      const { results, more } = engine.parse(r.json(), page);
      if (!results.length && next) {
        act.warn(`${engine.name} found nothing; trying ${next}`);
        notes.push(`${engine.name} found nothing`);
        allNetwork = false;
        continue;
      }
      act.ok(`${engine.name} returned ${plural(results.length, 'result')}${more ? '; more pages available' : ''}`);
      const answer = await instant;
      const rec = { q, page, engine: id, results, more, notes, instant: answer, at: Date.now(), net: { ...act.tot } };
      await S.put('results', resultsKey(q, page, chosen), rec);
      act.ok(`Saved these results on this device (${B(jsonSize(rec))})`);
      return rec;
    } catch (e) {
      allNetwork &&= !!e.network;
      failedAt.set(id, Date.now());
      notes.push(`${engine.name}: ${describe(e)}`);
      act.warn(`${engine.name} failed: ${describe(e)}${next ? `; trying ${next}` : ''}`);
    }
  }
  const err = new Error(notes.join(' · '));
  err.network = allNetwork;
  throw err;
}

async function loadPage(url, act) {
  const wiki = settings.wikipedia ? W.wikiTarget(url) : null;
  if (wiki) {
    try {
      return await loadWiki(url, wiki, act);
    } catch (e) {
      act.warn(`Wikipedia's own API failed (${describe(e)}); trying Jina Reader instead`);
    }
  }
  const host = L.hostOf(url);
  act.step(`Asking Jina Reader to fetch ${host} and turn it into text (${settings.jinaKey ? 'with your API key' : 'anonymous, 20 pages a minute'})…`);
  let r;
  try {
    r = await act.fetch(L.readerUrl(url), { timeout: 30000, headers: settings.jinaKey ? { Authorization: `Bearer ${settings.jinaKey}` } : {} });
  } catch (e) {
    if (!(e instanceof N.HttpError)) throw e;
    const why = L.jinaError(e.body);
    if (e.status === 429)
      throw new Error(
        `Jina Reader is rate-limiting you${why ? ` (${why})` : ''}; wait a minute${settings.jinaKey ? '' : ', or add a free Jina key in Settings'}`,
      );
    if (e.status === 401 || e.status === 402 || e.status === 403) {
      const hint = settings.jinaKey ? 'check the Jina key in Settings' : 'add a free Jina API key in Settings';
      throw new Error(`Jina Reader refused the request (${e.status}${why ? `: ${why}` : ''}); ${hint}`);
    }
    throw new Error(`Jina Reader could not fetch this page (${e.status}${why ? `: ${why}` : ''})`);
  }
  const parsed = L.parseJina(r.text);
  act.ok(`Got “${parsed.title || host}”: ${B(new Blob([parsed.markdown]).size)} of text`);
  const old = await S.get('pages', url);
  const e = r.entry;
  const rec = {
    url,
    ...parsed,
    title: parsed.title || host,
    at: Date.now(),
    saved: old?.saved ?? false,
    net: { received: e.received, wire: e.wire, wireKind: e.wireKind, ms: e.ms, ttfb: e.ttfb },
  };
  await S.put('pages', url, rec);
  act.ok(`Stored on this device${rec.saved ? ', still marked as saved' : ''} (${B(jsonSize(rec))})`);
  return rec;
}

/** The page record's text: the opening section, then whichever sections have been loaded, in article order. */
const wikiText = (rec) =>
  Object.entries(rec.wiki.parts)
    .sort((a, b) => a[0] - b[0])
    .map(([, md]) => md)
    .join('\n\n');

/** Wikipedia's own API: the opening section and the list of sections now, each other section only when asked. */
async function loadWiki(url, target, act) {
  act.step(`Asking ${target.host} for “${target.title}” directly (the opening section, and the list of sections)…`);
  const [lead, toc] = await Promise.allSettled([act.fetch(W.leadUrl(target.host, target.title), { timeout: 20000 }), act.fetch(W.tocUrl(target.host, target.title), { timeout: 20000 })]);
  if (lead.status === 'rejected') throw lead.reason;
  const json = lead.value.json();
  if (W.apiError(json)) throw new Error(W.apiError(json));
  const { html, title } = W.parseBody(json);
  if (!html) throw new Error('no text in the reply');
  let sections = [];
  if (toc.status === 'fulfilled') sections = W.parseToc(toc.value.json());
  else act.warn(`The list of sections failed (${describe(toc.reason)}); only the opening section is shown`);
  const entries = [lead.value.entry, ...(toc.status === 'fulfilled' ? [toc.value.entry] : [])];
  const old = await S.get('pages', url);
  const rec = {
    url,
    title: title || target.title,
    source: W.canonicalUrl(target.host, target.title),
    published: '',
    at: Date.now(),
    saved: old?.saved ?? false,
    wiki: { host: target.host, title: target.title, sections, parts: { 0: W.htmlToMarkdown(html, target.host) }, full: false },
    net: {
      received: entries.reduce((n, e) => n + e.received, 0),
      wire: entries.reduce((n, e) => n + (e.wire ?? e.received), 0),
      wireKind: entries.every((e) => e.wireKind === 'exact') ? 'exact' : 'estimated',
      ms: Math.max(...entries.map((e) => e.ms)),
      ttfb: Math.min(...entries.map((e) => e.ttfb ?? Infinity)),
    },
  };
  rec.markdown = wikiText(rec);
  act.ok(`Got “${rec.title}”: ${B(new Blob([rec.markdown]).size)} of text now, ${plural(sections.length, 'more section')} to load on demand`);
  await S.put('pages', url, rec);
  act.ok(`Stored on this device${rec.saved ? ', still marked as saved' : ''} (${B(jsonSize(rec))})`);
  return rec;
}

async function addHistory(q) {
  const list = (await S.kvGet('history', [])).filter((x) => x.q.toLowerCase() !== q.toLowerCase());
  await S.kvSet('history', [{ q, at: Date.now() }, ...list].slice(0, 30));
}

async function enqueue(item) {
  const queue = await S.kvGet('queue', []);
  if (!queue.some((x) => x.key === item.key)) queue.push({ ...item, at: Date.now() });
  await S.kvSet('queue', queue);
}

async function clearReady(key) {
  const ready = await S.kvGet('ready', []);
  if (ready.some((x) => x.key === key))
    await S.kvSet(
      'ready',
      ready.filter((x) => x.key !== key),
    );
}

let draining = false;

/** Runs searches and page loads that were asked for while offline. Narrated in the bottom bar. */
async function drainQueue() {
  if (draining || !navigator.onLine) return;
  draining = true;
  try {
    const queue = await S.kvGet('queue', []);
    if (!queue.length) return;
    const act = activity('Queue');
    act.step(`Online: running ${plural(queue.length, 'queued item')}`);
    const done = [];
    for (const item of queue) {
      try {
        act.step(`Queued ${item.kind === 'search' ? `search “${item.q}”` : `page ${L.hostOf(item.url)}`}…`);
        if (item.kind === 'search') await runSearch(item.q, 1, item.engine, act);
        else await loadPage(item.url, act);
        done.push({ ...item, doneAt: Date.now() });
      } catch (e) {
        if (e.network) {
          act.warn('Still no connection; keeping the rest of the queue for later');
          break;
        }
        done.push({ ...item, doneAt: Date.now(), error: describe(e) });
      }
    }
    const doneKeys = new Set(done.map((d) => d.key));
    await S.kvSet(
      'queue',
      (await S.kvGet('queue', [])).filter((x) => !doneKeys.has(x.key)),
    );
    await S.kvSet('ready', [...(await S.kvGet('ready', [])), ...done].slice(-20));
    act.finish(`Queue: ${done.length} done`);
    if (done.length && currentPath() === '/') route();
  } finally {
    draining = false;
  }
}

// ---------- shared pieces ----------

function submitQuery(raw) {
  const q = raw.trim();
  if (!q) return;
  const url = L.asUrl(q);
  if (url) {
    location.hash = hashFor('/r', { u: url });
    return;
  }
  if (L.hasBang(q)) {
    addHistory(q);
    setNow(`Opening DuckDuckGo for “${q}” (it handles !bangs itself)`);
    window.open(L.ddgUrl(q, settings), '_blank', 'noopener,noreferrer');
    return;
  }
  location.hash = hashFor('/s', { q });
}

function searchForm(q = '') {
  const input = h('input', {
    type: 'search',
    name: 'q',
    value: q,
    placeholder: 'Search or paste a link',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    'aria-label': 'Search',
  });
  return h(
    'form',
    {
      class: 'search',
      role: 'search',
      onsubmit: (e) => {
        e.preventDefault();
        input.blur();
        submitQuery(input.value);
      },
    },
    input,
    h('button', { type: 'submit' }, 'Search'),
  );
}

const topbar = (q) => searchForm(q);

/** The page title, with optional links at its right. */
const pageHead = (title, ...extra) => h('div', { class: 'group-head page-head' }, h('h1', null, title), extra);

function snippetNodes(snippet) {
  return snippet.map((s) => (s.bold ? h('b', null, s.text) : s.text));
}

function inlineNodes(nodes, pageUrl, mapHref = (x) => x) {
  const same = (a) => a.split('#')[0] === pageUrl.split('#')[0];
  return nodes.map((n) => {
    if (n.t === 'text') return n.s;
    if (n.t === 'code') return h('code', null, n.s);
    if (n.t === 'b') return h('strong', null, inlineNodes(n.c, pageUrl, mapHref));
    if (n.t === 'i') return h('em', null, inlineNodes(n.c, pageUrl, mapHref));
    if (same(n.href)) return h('span', null, inlineNodes(n.c, pageUrl, mapHref));
    return h('a', { href: hashFor('/r', { u: mapHref(n.href) }) }, inlineNodes(n.c, pageUrl, mapHref));
  });
}

function blockNodes(blocks, pageUrl, mapHref) {
  const inl = (c) => inlineNodes(c, pageUrl, mapHref);
  return blocks.map((b) => {
    switch (b.type) {
      case 'h':
        return h(`h${Math.min(6, b.level + 1)}`, null, inl(b.c));
      case 'p':
        return h('p', null, inl(b.c));
      case 'list':
        return h(
          b.ordered ? 'ol' : 'ul',
          null,
          b.items.map((it) => h('li', { class: it.depth ? `d${it.depth}` : null }, inl(it.c))),
        );
      case 'quote':
        return h('blockquote', null, inl(b.c));
      case 'pre':
        return h('pre', null, b.text);
      case 'table':
        return h(
          'div',
          { class: 'table' },
          h(
            'table',
            null,
            b.rows.map((r) =>
              h(
                'tr',
                null,
                r.map((c) => h('td', null, inl(c))),
              ),
            ),
          ),
        );
      case 'hr':
        return h('hr');
      default:
        return null;
    }
  });
}

function appLoadText() {
  const a = N.appLoad();
  if (!a.files) return 'App load details are not available yet.';
  const how = a.fromCache
    ? `opened from the offline cache: 0 B downloaded (${plural(a.files, 'file')})`
    : `${B(a.wire)} downloaded (${plural(a.files, 'file')})`;
  return `App ${how}${a.ms ? `, ready in ${T(a.ms)}` : ''}.`;
}

// ---------- views ----------

/** A weather button for the home page. Nothing is downloaded until it is tapped. */
function homeWeather(id) {
  const unit = L.resolveUnit(settings.units, navigator.language);
  const box = h('div', { class: 'home-weather' });
  const btn = h('button', { type: 'button', class: 'button secondary small' }, 'Weather here');
  const note = h('span', { class: 'muted small' }, 'uses your location · about 0.5 KB');
  S.get('results', `wx2||${unit}`).then((rec) => {
    if (rec && Date.now() - rec.at <= WEATHER_FRESH) note.textContent = `saved ${L.relTime(rec.at)}, 0 B`;
  });
  const prompt = h('p', { class: 'wx-actions' }, btn, ' ', note);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const act = activity('Weather');
    box.prepend(act.el);
    prompt.remove();
    await showWeather(box, '', id, act);
    act.finish('Weather');
  });
  box.append(prompt);
  return box;
}

/** A list that shows the first few rows, with a toggle for the rest. */
function rowList(items, limit, row) {
  const ul = h('ul', { class: 'rows' });
  const more = h('button', { type: 'button', class: 'link small' });
  let all = false;
  const draw = () => {
    fill(ul, (all ? items : items.slice(0, limit)).map(row));
    more.hidden = items.length <= limit;
    more.textContent = all ? 'Show fewer' : `Show all ${items.length}`;
  };
  more.addEventListener('click', () => {
    all = !all;
    draw();
  });
  draw();
  return h('div', null, ul, more);
}

const compactUse = (t) => (t.requests ? `${t.estimated ? '≈' : ''}${B(t.wire)} · ${plural(t.requests, 'request')}` : 'nothing yet');

async function showHome(id) {
  document.title = 'Sparse';
  const [history, queue, ready, pages, models] = await Promise.all([
    S.kvGet('history', []),
    S.kvGet('queue', []),
    S.kvGet('ready', []),
    S.entries('pages'),
    AI.states().catch(() => ({})),
  ]);
  if (id !== renderId) return;
  const saved = pages
    .map(([, p]) => p)
    .filter((p) => p.saved)
    .sort((a, b) => b.at - a.at);
  const engine = L.engineOrder(settings)[0];
  const itemLink = (x) =>
    x.kind === 'search'
      ? h('a', { href: hashFor('/s', { q: x.q, ...(x.engine !== settings.engine && { e: x.engine }) }) }, x.q)
      : h('a', { href: hashFor('/r', { u: x.url }) }, L.hostOf(x.url) || x.url);
  const s = N.session;

  // Notices that can be dismissed from here: the AI's last interruption, and errors kept on model records.
  const interruption = AI.lastInterruption();
  const modelErrors = Object.values(models).filter((m) => m.lastError || m.crashes);
  const notices = [
    interruption
      ? banner('warn', interruption.message, {
          actions: [h('a', { href: '#/ai' }, 'Details')],
          onDismiss: () => AI.ackInterruption(),
        })
      : null,
    modelErrors.length
      ? banner('bad', `${modelErrors.map((m) => AL.PACKAGES[m.id]?.short ?? m.id).join(', ')}: ${modelErrors[0].lastError ? `last error was “${modelErrors[0].lastError.message}”` : 'the app was ended unexpectedly while using it'}`, {
          actions: [h('a', { href: '#/ai' }, 'Details')],
          onDismiss: () => AI.clearErrors(),
        })
      : null,
  ];

  const failedReady = ready.filter((x) => x.error);
  render(
    notices,
    searchForm(),
    h(
      'p',
      { class: 'tip' },
      engine ? `${L.ENGINES[engine].name}` : 'No engine set',
      ' · add ',
      h('code', null, '!bang'),
      ' to search on DuckDuckGo',
    ),
    group(
      'Around you',
      null,
      homeWeather(id),
      h('p', { class: 'muted small' }, 'Places near you'),
      h('div', { class: 'chips quick' }, P.QUICK_SEARCHES.map(([label, q]) => h('a', { class: 'chip', href: hashFor('/s', { q }) }, label))),
    ),
    queue.length > 0 &&
      group(
        'Waiting for a connection',
        null,
        h('ul', { class: 'rows' }, queue.map((x) => h('li', null, x.kind === 'search' ? x.q : x.url, h('span', { class: 'muted small' }, `queued ${L.relTime(x.at)}`)))),
      ),
    ready.length > 0 &&
      group(
        'Ready',
        failedReady.length ? twoTap('Clear failed', () => S.kvSet('ready', ready.filter((x) => !x.error))) : null,
        rowList(ready, 5, (x) => {
          const li = h(
            'li',
            null,
            itemLink(x),
            h('span', { class: `small ${x.error ? 'bad' : 'muted'}` }, x.error ? x.error : `fetched ${L.relTime(x.doneAt)}`),
            h('button', {
              type: 'button',
              class: 'row-x',
              'aria-label': 'Remove from this list',
              onclick: async () => {
                await clearReady(x.key);
                li.remove();
              },
            }, '×'),
          );
          return li;
        }),
      ),
    history.length > 0 &&
      group(
        'Recent searches',
        twoTap('Clear', () => S.kvSet('history', [])),
        rowList(history, 5, (x) => h('li', null, h('a', { href: hashFor('/s', { q: x.q }) }, x.q), h('span', { class: 'muted small' }, L.relTime(x.at)))),
      ),
    saved.length > 0 &&
      group(
        'Saved pages',
        null,
        rowList(saved, 5, (p) =>
          h('li', null, h('a', { href: hashFor('/r', { u: p.url }) }, p.title), h('span', { class: 'muted small' }, `${L.hostOf(p.url)} · ${B(new Blob([p.markdown]).size)}`)),
        ),
      ),
    group(
      'Data used',
      h('a', { class: 'small', href: '#/net' }, 'Details'),
      h(
        'div',
        { class: 'stats' },
        h('span', null, 'This session ', h('b', null, compactUse({ ...s, estimated: true })), s.errors ? ` · ${plural(s.errors, 'failure')}` : ''),
        netTotals.requests ? h('span', null, `Since ${new Date(netTotals.since).toLocaleDateString()} `, h('b', null, compactUse({ ...netTotals, estimated: true }))) : null,
      ),
      h('p', { class: 'muted small', id: 'appload' }, appLoadText()),
    ),
    h('p', { class: 'version', id: 'version' }, `Sparse v${APP_VERSION}`),
  );
  settle();
}

async function showSearch(id, q, page, engineParam, force = false) {
  q = q.trim();
  if (!q) return location.replace('#/');
  const chosen = L.ENGINES[engineParam] ? engineParam : settings.engine;
  document.title = `${q} · Sparse`;
  const act = activity(`Searching “${q}”…`);
  const status = h('div', { class: 'status' });
  const cards = h('div');
  const list = h('ol', { class: 'results' });
  const foot = h('nav', { class: 'more' });
  render(topbar(q), act.el, status, cards, list, foot);
  if (page === 1) await addHistory(q);
  const key = resultsKey(q, page, chosen);
  clearReady(key);

  // Answer cards above the results. The first kind that matches wins: weather, then currency, units, nearby places.
  const weather = page === 1 ? L.weatherIntent(q) : null;
  const money = page === 1 && !weather ? C.currencyIntent(q) : null;
  const units = page === 1 && !weather && !money ? C.unitIntent(q) : null;
  const nearby = page === 1 && !weather && !money && !units ? P.placesIntent(q) : null;
  const weatherDone = weather
    ? showWeather(cards, weather.place, id, act)
    : money
      ? showCurrency(cards, money, id, act)
      : units
        ? showUnits(cards, units, act)
        : nearby
          ? showPlaces(cards, nearby, id, act)
          : null;

  /** Mojeek is paid, so it only runs from this button, never automatically. */
  const tryMojeek = () =>
    h(
      'p',
      { class: 'try-paid' },
      h('a', { href: hashFor('/s', { q, e: 'mojeek' }), class: 'button secondary' }, 'Try Mojeek'),
      h('span', { class: 'muted small' }, ' paid: about £0.001 per search, uses your key'),
    );

  const show = (rec, { fromDevice = false, note = '' } = {}) => {
    if (id !== renderId) return;
    const name = L.ENGINES[rec.engine].name;
    fill(
      status,
      h('p', null, `${name} · ${rec.results.length ? plural(rec.results.length, 'result') : 'no results'}${page > 1 ? `, page ${page}` : ''}`),
      h(
        'p',
        { class: 'small' },
        fromDevice
          ? `From this device (saved ${L.relTime(rec.at)}): 0 B downloaded now. When fetched it took ${amount(rec.net)}.`
          : `Downloaded: ${amount(rec.net)}.`,
        note ? ` ${note}` : '',
        ' ',
        h('button', { type: 'button', class: 'link', onclick: () => showSearch(++renderId, q, page, engineParam, true) }, 'Refresh'),
      ),
    );
    if (rec.instant) {
      const i = rec.instant;
      cards.append(
        h(
          'section',
          { class: 'card' },
          h('h2', null, i.heading),
          h('p', null, i.text.length > 600 ? `${i.text.slice(0, 600)}…` : i.text),
          i.url ? h('a', { href: hashFor('/r', { u: i.url }) }, `Read more${i.source ? ` on ${i.source}` : ''}`) : null,
          h('p', { class: 'muted small' }, 'Instant answer from DuckDuckGo'),
        ),
      );
    }
    list.start = (page - 1) * 10 + 1;
    fill(
      list,
      ...rec.results.map((r) =>
        h(
          'li',
          null,
          h(
            'a',
            settings.openIn === 'reader'
              ? { href: hashFor('/r', { u: r.url }), class: 'hit' }
              : { href: r.url, class: 'hit', target: '_blank', rel: 'noopener noreferrer' },
            h('span', { class: 'title' }, r.title),
            h('span', { class: 'url' }, L.displayUrl(r.url)),
          ),
          h(
            'p',
            { class: 'meta small', 'data-url': r.url, hidden: !r.date },
            r.date ? `${r.date.kind === 'published' ? 'Published' : 'Updated'} ${formatDate(r.date.at)} (from ${name})` : null,
          ),
          r.snippet.length ? h('p', null, snippetNodes(r.snippet)) : null,
          settings.openIn === 'reader' ? external(r.url, 'Open site ↗', 'ext small') : null,
        ),
      ),
    );
    addSavedDates(list, id);
    const others = L.FREE_ENGINE_IDS.filter((e) => e !== rec.engine);
    if (rec.engine !== 'mojeek' && L.canTryMojeek(settings)) status.append(tryMojeek());
    fill(
      foot,
      rec.more ? h('a', { href: hashFor('/s', { q, p: page + 1, e: rec.engine }), class: 'button' }, 'More results') : null,
      rec.engine !== 'mojeek' && L.canTryMojeek(settings) ? tryMojeek() : null,
      h(
        'p',
        { class: 'small' },
        'Try ',
        others.flatMap((e) => [h('a', { href: hashFor('/s', { q, e }) }, L.ENGINES[e].name), ' · ']),
        external(L.ddgUrl(q, settings), `DuckDuckGo ${settings.ddg === 'html' ? 'HTML' : 'Lite'} ↗`),
      ),
    );
    settle();
  };

  const showProblem = (message) => {
    if (id !== renderId) return;
    fill(status, h('p', null, message));
    fill(
      foot,
      chosen !== 'mojeek' && L.canTryMojeek(settings) && navigator.onLine ? tryMojeek() : null,
      L.ENGINES[chosen].paid ? h('p', null, h('a', { href: hashFor('/s', { q }) }, 'Back to the free results')) : null,
      h('p', { class: 'small' }, external(L.ddgUrl(q, settings), `Search DuckDuckGo ${settings.ddg === 'html' ? 'HTML' : 'Lite'} instead ↗`)),
    );
  };

  const finish = async (label) => {
    await weatherDone;
    if (id === renderId) act.finish(label);
  };

  act.step(`Looking on this device for saved results (${L.ENGINES[chosen].name}${page > 1 ? `, page ${page}` : ''})…`);
  const cached = await S.get('results', key);
  if (id !== renderId) return;
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached) {
    const where = `saved ${L.relTime(cached.at)} (${B(jsonSize(cached))} on device)`;
    if (force) act.step(`Found results ${where}, but you asked to refresh`);
    else if (age < settings.cacheHours * HOUR) {
      act.ok(`Found results ${where}, within your ${settings.cacheHours} h reuse limit: showing them, nothing downloaded`);
      show(cached, { fromDevice: true });
      return finish('Search loaded from this device');
    } else if (!navigator.onLine) {
      act.ok(`Offline: showing results ${where}`);
      show(cached, { fromDevice: true, note: 'You are offline.' });
      return finish('Offline, loaded from this device');
    } else act.step(`Found results ${where}, older than your ${settings.cacheHours} h reuse limit: fetching fresh ones`);
  } else act.step('Nothing saved for this search yet');

  if (!navigator.onLine) {
    await enqueue({ kind: 'search', key, q, engine: chosen });
    act.warn('Offline: queued this search; it will run when the connection comes back');
    showProblem("You're offline. This search is queued and will run when you're back online.");
    return finish('Offline, search queued');
  }
  try {
    // Re-searching with another engine (e.g. "Try Mojeek"): reuse the instant answer already fetched.
    const earlier = page === 1 && chosen !== settings.engine ? await S.get('results', resultsKey(q, 1, settings.engine)) : null;
    show(await runSearch(q, page, chosen, act, earlier ? (earlier.instant ?? null) : undefined));
    await finish('Search done');
  } catch (e) {
    if (cached) {
      act.warn('Every engine failed; showing the older saved results instead');
      show(cached, { fromDevice: true, note: 'Refreshing failed.' });
      return finish('Search failed, showing saved results');
    }
    if (e.network) {
      await enqueue({ kind: 'search', key, q, engine: chosen });
      act.warn('No engine could be reached: queued this search for when the connection is back');
      showProblem(`Couldn't reach the search engines (${e.message}). This search is queued and will run when the connection is back.`);
      return finish('Search failed, queued');
    }
    showProblem(`Search failed: ${e.message}`);
    await finish('Search failed');
  }
}

function here(hint = 'try “weather <town>”') {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error(`location is not available; ${hint}`));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'Your location' }),
      () => reject(new Error(`location is not available; ${hint}`)),
      { maximumAge: 10 * MIN, timeout: 15000 },
    );
  });
}

/** Sums the requests behind one card, so it can say what it cost. */
function netCounter(act) {
  const net = { requests: 0, received: 0, wire: 0, estimated: false };
  const get = async (url, opts) => {
    const r = await act.fetch(url, opts);
    net.requests++;
    net.received += r.entry.received;
    net.wire += r.entry.wire ?? r.entry.received;
    if (r.entry.wireKind !== 'exact') net.estimated = true;
    return r.json();
  };
  return { net, get };
}

// ---------- conversion and nearby-place cards ----------

const RATES_FRESH = 6 * HOUR;
const PLACES_FRESH = HOUR;
const num = (n) => C.formatNumber(n, navigator.language);

/** Unit conversion is arithmetic: nothing is downloaded. */
function showUnits(container, intent, act) {
  const out = C.convertUnit(intent);
  act.ok(`Units: worked out on this device, nothing downloaded (${intent.from.label} → ${intent.to.label})`);
  container.prepend(
    h(
      'section',
      { class: 'card conv' },
      h('p', { class: 'big' }, `${num(intent.amount)} ${intent.from.label} = ${num(out)} ${intent.to.label}`),
      h(
        'p',
        { class: 'muted small' },
        intent.from.dim === 'temp' ? '' : `1 ${intent.from.label} = ${num(C.convertUnit({ ...intent, amount: 1 }))} ${intent.to.label} · `,
        'worked out on this device, 0 B downloaded',
      ),
    ),
  );
}

/** One download of ECB rates (about 1 KB) serves every currency pair for 6 hours, and offline from the saved copy. */
async function showCurrency(container, intent, id, act) {
  const card = h('section', { class: 'card conv' }, h('p', { class: 'muted' }, 'Exchange rate…'));
  container.prepend(card);
  const key = 'fx|EUR';
  act.step(`Currency: looking on this device for exchange rates (${intent.from} → ${intent.to})…`);
  let rec = await S.get('results', key);
  try {
    if (rec && Date.now() - rec.at <= RATES_FRESH) act.ok(`Currency: using the rates saved ${L.relTime(rec.at)}, nothing downloaded`);
    else if (rec && !navigator.onLine) act.ok(`Currency: offline, using the rates saved ${L.relTime(rec.at)}`);
    else if (!navigator.onLine) throw new Error('rates need a connection once; then they work offline');
    else {
      if (rec) act.step(`Currency: the saved rates are ${L.relTime(rec.at)} old (over 6 h): refreshing`);
      const { net, get } = netCounter(act);
      let parsed;
      try {
        act.step('Currency: fetching European Central Bank rates from Frankfurter…');
        parsed = C.parseRates(await get(C.ratesUrl(), { timeout: 10000 }));
      } catch (e) {
        act.warn(`Currency: ${describe(e)}; trying Frankfurter's older address`);
        parsed = C.parseRates(await get(C.ratesFallbackUrl(), { timeout: 10000 }));
      }
      if (!parsed) throw new Error('no rates available');
      rec = { at: Date.now(), ...parsed, net };
      await S.put('results', key, rec);
      act.ok(`Currency: ${plural(Object.keys(parsed.rates).length, 'rate')} saved on this device (${amount(net)})`);
    }
  } catch (e) {
    act.warn(`Currency failed: ${describe(e)}${rec ? '; showing the older saved rates' : ''}`);
    if (!rec) {
      if (id === renderId) fill(card, h('p', { class: 'muted small' }, `Exchange rate: ${describe(e)}`));
      return;
    }
  }
  if (id !== renderId) return;
  const r = C.convertCurrency(intent.amount, intent.from, intent.to, rec.rates);
  if (!r) {
    const missing = [intent.from, intent.to].filter((c) => !rec.rates[c]).join(', ');
    act.warn(`Currency: no rate for ${missing}`);
    return fill(card, h('p', { class: 'muted small' }, `No rate for ${missing} in the European Central Bank list.`));
  }
  const back = C.convertCurrency(1, intent.to, intent.from, rec.rates);
  fill(
    card,
    h('p', { class: 'big' }, `${num(intent.amount)} ${intent.from} = ${num(r.value)} ${intent.to}`),
    h('p', { class: 'small' }, `1 ${intent.from} = ${num(r.unit)} ${intent.to} · 1 ${intent.to} = ${num(back.unit)} ${intent.from}`),
    h('p', { class: 'muted small' }, `European Central Bank reference rates${rec.date ? ` for ${rec.date}` : ''}, via Frankfurter · saved ${L.relTime(rec.at)} · ${amount(rec.net)}`),
  );
}

const placeFailedAt = new Map();

/** Asks Overpass (two servers), then Nominatim, for places around a point. Throws if every source fails. */
async function findPlaces(loc, radius, intent, get, act) {
  const sources = [
    ...P.OVERPASS_HOSTS.map((host) => ({ id: host, name: `Overpass (${L.hostOf(host)})`, url: () => P.overpassUrl(host, P.overpassQuery(loc.lat, loc.lon, radius, intent)), parse: P.parseOverpass })),
    { id: 'nominatim', name: 'Nominatim (OpenStreetMap)', url: () => P.nominatimUrl(loc.lat, loc.lon, radius, intent), parse: P.parseNominatim },
  ];
  const failing = (s) => Date.now() - (placeFailedAt.get(s.id) ?? 0) < 5 * MIN;
  const order = sources.some((s) => !failing(s)) ? [...sources.filter((s) => !failing(s)), ...sources.filter(failing)] : sources;
  const notes = [];
  for (const [i, s] of order.entries()) {
    act.step(`Places: asking ${s.name} within ${P.formatDistance(radius)}${i ? ' (fallback)' : ''}…`);
    try {
      const json = await get(s.url(), { timeout: s.id === 'nominatim' ? 12000 : 6000 });
      if (json?.remark && /runtime error|timed out/i.test(json.remark) && !json.elements?.length) throw new Error('the server ran out of time');
      const places = s.parse(json, loc, { max: 10, keepUnnamed: !!intent.type && ['Toilets', 'Cash machines', 'Bus stops', 'Parking', 'Drinking water'].includes(intent.label), label: intent.label });
      act.ok(`Places: ${s.name} returned ${plural(places.length, 'place')}`);
      return { places, source: s.name };
    } catch (e) {
      placeFailedAt.set(s.id, Date.now());
      notes.push(`${s.name}: ${describe(e)}`);
      act.warn(`Places: ${s.name} failed: ${describe(e)}${order[i + 1] ? `; trying ${order[i + 1].name}` : ''}`);
    }
  }
  throw new Error(notes.join(' · '));
}

/** "coffee near me", "pharmacy near Leeds", "Tesco near me": the nearest ten places, with hours where OpenStreetMap has them. */
async function showPlaces(container, intent, id, act) {
  const imperial = L.resolveUnit(settings.units, navigator.language) === 'f';
  const where = intent.place ? `near ${intent.place}` : 'near you';
  const card = h('section', { class: 'card places' }, h('h2', null, `${intent.label} ${where}`), h('p', { class: 'muted' }, 'Looking for places…'));
  container.prepend(card);
  const problem = (msg) => id === renderId && fill(card, h('h2', null, `${intent.label} ${where}`), h('p', { class: 'muted small' }, msg));
  let loc;
  try {
    if (intent.place) {
      const known = (await S.get('results', `geo|${intent.place.toLowerCase()}`)) ?? null;
      if (known) loc = known.loc;
      else {
        if (!navigator.onLine) throw new Error('looking up a place needs a connection');
        act.step(`Places: looking up “${intent.place}” with Open-Meteo…`);
        const { net, get } = netCounter(act);
        loc = L.parseGeocode(await get(L.geocodeUrl(intent.place)));
        if (!loc) throw new Error(`couldn't find “${intent.place}”`);
        await S.put('results', `geo|${intent.place.toLowerCase()}`, { at: Date.now(), loc, net });
        act.ok(`Places: ${loc.label} (${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)})`);
      }
    } else {
      act.step('Places: asking this device for your location…');
      loc = await here(`try “${intent.term} near <town>”`);
      act.ok('Places: got your location');
    }
  } catch (e) {
    act.warn(`Places failed: ${describe(e)}`);
    return problem(describe(e));
  }

  const key = `near|${intent.type ? intent.type[3] : intent.term}|${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;
  act.step('Places: looking on this device for saved places…');
  let rec = await S.get('results', key);
  try {
    if (rec && Date.now() - rec.at <= PLACES_FRESH) act.ok(`Places: using the list saved ${L.relTime(rec.at)}, nothing downloaded`);
    else if (rec && !navigator.onLine) act.ok(`Places: offline, using the list saved ${L.relTime(rec.at)}`);
    else if (!navigator.onLine) throw new Error('places need a connection; this search is not queued');
    else {
      const { net, get } = netCounter(act);
      let found = await findPlaces(loc, 800, intent, get, act);
      let radius = 800;
      if (found.places.length < 3) {
        act.step('Places: fewer than 3 close by; widening the search');
        radius = intent.type ? 3000 : 5000;
        found = await findPlaces(loc, radius, intent, get, act);
      }
      rec = { at: Date.now(), loc: { lat: loc.lat, lon: loc.lon }, places: found.places, source: found.source, radius, net };
      await S.put('results', key, rec);
      act.ok(`Places: saved on this device (${amount(net)})`);
    }
  } catch (e) {
    act.warn(`Places failed: ${describe(e)}${rec ? '; showing the older saved list' : ''}`);
    if (!rec) return problem(`Couldn't get places (${describe(e)}).`);
  }
  if (id !== renderId) return;
  if (!rec.places.length) return problem(`Nothing found within ${P.formatDistance(rec.radius, imperial)} in OpenStreetMap.`);
  const items = rec.places.map((p) => {
    const status = !intent.place && p.hours ? P.openStatus(p.hours) : null;
    return h(
      'li',
      null,
      h('strong', null, p.name),
      h('span', { class: 'muted small' }, ` · ${[p.kind && p.kind !== p.name.toLowerCase() ? p.kind : '', `${P.formatDistance(p.dist, imperial)} ${p.dir}`].filter(Boolean).join(' · ')}`),
      status ? h('div', { class: `small ${status.open ? 'open' : 'closed'}` }, status.text) : null,
      p.hours && !status ? h('div', { class: 'small muted' }, `Hours: ${p.hours.slice(0, 120)}`) : null,
      p.address ? h('div', { class: 'small muted' }, p.address) : null,
      h(
        'div',
        { class: 'small' },
        external(`https://maps.apple.com/?${new URLSearchParams({ ll: `${p.lat},${p.lon}`, q: p.name })}`, 'Map ↗'),
        p.phone && /^[+\d][\d\s().-]{4,}$/.test(p.phone) ? [' · ', h('a', { href: `tel:${p.phone.replace(/[^\d+]/g, '')}` }, 'Call')] : null,
        p.web ? [' · ', external(p.web, 'Website ↗')] : null,
      ),
    );
  });
  fill(
    card,
    h('h2', null, `${intent.label} ${where}`),
    h('ul', { class: 'plain' }, items),
    h(
      'p',
      { class: 'muted small' },
      `Map data © OpenStreetMap contributors, via ${rec.source} · within ${P.formatDistance(rec.radius, imperial)}${intent.place ? ` of ${loc.label}` : ''} · saved ${L.relTime(rec.at)} · ${amount(rec.net)}. Opening hours are what OpenStreetMap volunteers recorded and may be out of date.`,
    ),
  );
}

const WEATHER_FRESH = 30 * MIN;

async function showWeather(container, place, id, act) {
  const unit = L.resolveUnit(settings.units, navigator.language);
  const card = h('section', { class: 'card weather' }, h('p', { class: 'muted' }, 'Weather…'));
  container.prepend(card);
  const where = place ? `“${place}”` : 'your location';
  const key = `wx2|${place.toLowerCase()}|${unit}`;
  act.step(`Weather: looking on this device for a forecast for ${where}…`);
  let rec = await S.get('results', key);
  try {
    if (rec && Date.now() - rec.at <= WEATHER_FRESH) act.ok(`Weather: using the forecast saved ${L.relTime(rec.at)}, nothing downloaded`);
    else if (rec && !navigator.onLine) act.ok(`Weather: offline, using the forecast saved ${L.relTime(rec.at)}`);
    else {
      if (rec) act.step(`Weather: the saved forecast is ${L.relTime(rec.at)} old (over 30 min): refreshing`);
      const { net, get } = netCounter(act);
      let loc;
      if (place) {
        act.step(`Weather: looking up ${where} with Open-Meteo…`);
        loc = L.parseGeocode(await get(L.geocodeUrl(place)));
        if (!loc) throw new Error(`couldn't find “${place}”`);
        act.ok(`Weather: ${where} is ${loc.label} (${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)})`);
      } else {
        act.step('Weather: asking this device for your location…');
        loc = await here();
        act.ok('Weather: got your location');
      }
      act.step('Weather: fetching the basic forecast (now, the next hour, 3 days)…');
      const forecast = L.parseForecast(await get(L.forecastUrl(loc.lat, loc.lon, unit)), loc.label, unit);
      if (!forecast) throw new Error('no forecast available');
      rec = { at: Date.now(), forecast, loc: { lat: loc.lat, lon: loc.lon }, net };
      await S.put('results', key, rec);
      act.ok('Weather: forecast saved on this device');
    }
  } catch (e) {
    act.warn(`Weather failed: ${describe(e)}${rec ? '; showing the older saved forecast' : ''}`);
    if (!rec) {
      if (id === renderId) fill(card, h('p', { class: 'muted small' }, `Weather: ${describe(e)}`));
      return;
    }
  }
  if (id !== renderId) return;
  const f = rec.forecast;
  const more = h('div', { class: 'wx-more', hidden: true });
  const moreBtn = h('button', { type: 'button', class: 'button secondary small' }, 'More weather');
  const moreNote = h('span', { class: 'muted small' });
  fill(
    card,
    h('h2', null, f.label),
    h(
      'p',
      { class: 'big' },
      `${f.now.temp}${f.unit} `,
      h('span', null, f.now.desc, f.now.feels != null && f.now.feels !== f.now.temp ? ` · feels like ${f.now.feels}°` : ''),
    ),
    f.rain ? h('p', { class: 'rain' }, f.rain) : null,
    h(
      'table',
      { class: 'days' },
      f.days.map((d, i) =>
        h(
          'tr',
          null,
          h('td', null, dayName(d.date, i)),
          h('td', null, d.desc),
          h('td', null, `${d.hi}° / ${d.lo}°`),
          h('td', { class: 'muted' }, d.rain != null ? `${d.rain}% rain` : ''),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, `Wind ${f.now.wind} ${f.wind} · Open-Meteo, updated ${L.relTime(rec.at)} · ${amount(rec.net)}`),
    more,
    h('p', { class: 'wx-actions' }, moreBtn, ' ', moreNote),
  );
  if (!rec.loc) {
    // Saved by an older version, without coordinates: "More" would need the place looked up again.
    moreBtn.hidden = true;
    return;
  }

  const moreKey = `wxmore|${rec.loc.lat.toFixed(2)},${rec.loc.lon.toFixed(2)}|${unit}`;
  let detail = await S.get('results', moreKey);
  if (id !== renderId) return;
  const fresh = () => detail && Date.now() - detail.at <= WEATHER_FRESH;
  const lastSize = await S.kvGet('wxMoreSize', null);
  moreNote.textContent = fresh()
    ? `saved ${L.relTime(detail.at)}, 0 B`
    : !navigator.onLine && detail
      ? `offline: saved copy from ${L.relTime(detail.at)}`
      : `hourly, 7 days, air quality · ${lastSize ? `≈${B(lastSize)}` : 'about 1–2 KB'}`;

  let open = false;
  const toggle = async () => {
    if (open) {
      open = false;
      more.hidden = true;
      moreBtn.textContent = 'More weather';
      return;
    }
    moreBtn.disabled = true;
    try {
      if (fresh()) act.ok(`More weather: using the details saved ${L.relTime(detail.at)}, nothing downloaded`);
      else if (detail && !navigator.onLine) act.ok(`More weather: offline, using the details saved ${L.relTime(detail.at)}`);
      else {
        moreNote.textContent = 'downloading…';
        act.step('More weather: fetching 24 hours, 7 days and conditions now, plus air quality, at the same time…');
        const { net, get } = netCounter(act);
        const [main, air] = await Promise.allSettled([get(L.detailUrl(rec.loc.lat, rec.loc.lon, unit)), get(L.airUrl(rec.loc.lat, rec.loc.lon))]);
        if (main.status === 'rejected') throw main.reason;
        const d = L.parseDetail(main.value, unit);
        if (!d) throw new Error('no detailed forecast available');
        const a = air.status === 'fulfilled' ? L.parseAir(air.value, unit) : null;
        if (air.status === 'rejected') act.warn(`More weather: air quality failed (${describe(air.reason)}); showing the rest`);
        detail = { at: Date.now(), detail: d, air: a, net };
        await S.put('results', moreKey, detail);
        await S.kvSet('wxMoreSize', net.wire);
        act.ok(`More weather: saved on this device (${amount(net)})`);
      }
      if (id !== renderId) return;
      fill(more, weatherDetail(detail, f));
      more.hidden = false;
      open = true;
      moreBtn.textContent = 'Less weather';
      moreNote.textContent = `updated ${L.relTime(detail.at)} · ${amount(detail.net)}`;
    } catch (e) {
      act.warn(`More weather failed: ${describe(e)}`);
      moreNote.textContent = `failed: ${describe(e)}`;
    } finally {
      moreBtn.disabled = false;
    }
  };
  moreBtn.addEventListener('click', toggle);
  if (settings.weatherDetail === 'full') {
    act.step('More weather: Settings say to always show the full weather');
    await toggle();
  }
}

const dayName = (date, i) => (i === 0 ? 'Today' : new Date(`${date}T12:00`).toLocaleDateString(undefined, { weekday: 'short' }));

function weatherDetail(rec, f) {
  const d = rec.detail;
  const a = rec.air;
  const today = d.days[0] ?? {};
  const row = (label, value) => (value == null || value === '' ? null : h('tr', null, h('th', null, label), h('td', null, value)));
  const hours = h(
    'table',
    { class: 'hours' },
    d.hours.map((x, i) =>
      h(
        'tr',
        { class: i % 3 ? 'extra' : null },
        h('td', null, i === 0 ? 'Now' : x.time),
        h('td', null, `${x.temp}°`),
        h('td', null, x.desc),
        h('td', { class: 'muted' }, x.rain != null ? `${x.rain}%` : ''),
      ),
    ),
  );
  const allHours = h('button', { type: 'button', class: 'link small' }, 'Show every hour');
  allHours.addEventListener('click', () => {
    const on = hours.classList.toggle('all');
    allHours.textContent = on ? 'Every 3 hours' : 'Show every hour';
  });
  return [
    h('h3', null, 'Now'),
    h(
      'table',
      { class: 'kv' },
      row('Wind', `${f.now.wind} ${f.wind}${d.now.windDir ? ` from the ${d.now.windDir}` : ''}${d.now.gusts != null ? `, gusts ${d.now.gusts}` : ''}`),
      row('Humidity', d.now.humidity != null ? `${d.now.humidity}%` : null),
      row('Cloud cover', d.now.cloud != null ? `${d.now.cloud}%` : null),
      row('Visibility', d.now.visibility),
      row('Pressure', d.now.pressure != null ? `${d.now.pressure} hPa` : null),
      row('UV index now', a?.uv != null ? L.uvText(a.uv) : null),
      row('Sunrise, sunset', today.sunrise ? `${today.sunrise}, ${today.sunset}` : null),
    ),
    a
      ? [
          h('h3', null, 'Air quality'),
          h(
            'table',
            { class: 'kv' },
            row(a.scale, a.index != null ? `${a.index} (${a.label})` : null),
            row('PM2.5', a.pm25 != null ? `${a.pm25} µg/m³` : null),
            row('PM10', a.pm10 != null ? `${a.pm10} µg/m³` : null),
            row('Ozone', a.ozone != null ? `${a.ozone} µg/m³` : null),
            row('Nitrogen dioxide', a.no2 != null ? `${a.no2} µg/m³` : null),
          ),
        ]
      : null,
    h('h3', null, 'Next 24 hours ', h('span', { class: 'muted small' }, '(chance of rain)')),
    hours,
    allHours,
    h('h3', null, '7 days'),
    h(
      'table',
      { class: 'days week' },
      d.days.map((x, i) =>
        h(
          'tr',
          null,
          h('td', null, dayName(x.date, i)),
          h(
            'td',
            null,
            x.desc,
            h(
              'span',
              { class: 'muted block small' },
              [x.wind != null ? `wind to ${x.wind} ${f.wind}` : null, x.uv != null ? `UV ${x.uv}` : null].filter(Boolean).join(' · '),
            ),
          ),
          h('td', null, `${x.hi}° / ${x.lo}°`),
          h(
            'td',
            { class: 'muted' },
            x.rain != null ? `${x.rain}%` : '',
            x.amount ? h('span', { class: 'block' }, `${x.amount.toFixed(d.precipUnit === 'in' ? 2 : 1)} ${d.precipUnit}`) : null,
          ),
        ),
      ),
    ),
  ];
}

/**
 * Free engines send no dates, but pages already opened in the reader have one from Jina, stored
 * on this device. Fills those in without downloading anything.
 */
async function addSavedDates(list, id) {
  for (const el of list.querySelectorAll('p.meta[hidden]')) {
    const page = await S.get('pages', el.dataset.url);
    if (id !== renderId) return;
    if (!page?.published || Number.isNaN(new Date(page.published).getTime())) continue;
    el.textContent = `Published ${formatDate(page.published)} (from your saved copy)`;
    el.hidden = false;
  }
}

function formatDate(raw) {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Asks the Internet Archive for its latest copy of `url` (about 0.2 KB) and offers it. Jina reads
 * archive.org only with an API key; without one the copy can only be opened in Safari.
 */
async function archiveOffer(box, url, act, id) {
  fill(box, h('p', { class: 'muted small' }, 'Looking for an archived copy…'));
  act.step('Asking the Internet Archive whether it has a copy of this page…');
  try {
    const r = await act.fetch(L.waybackLookupUrl(url), { timeout: 20000 });
    const snap = L.parseWayback(r.json(), url);
    if (id !== renderId) return;
    if (!snap) {
      act.skip('The Internet Archive’s lookup found no copy of this page');
      return fill(
        box,
        h(
          'p',
          { class: 'muted small' },
          'The Internet Archive’s quick lookup found no copy. It sometimes misses copies when it is busy, so the archive itself may still have one.',
        ),
        h('p', { class: 'small' }, external(L.waybackViewUrl('2', url), 'Look in the archive in Safari ↗')),
      );
    }
    act.ok(`The Internet Archive has a copy from ${formatDate(snap.at)}`);
    if (!settings.jinaKey) act.skip('Reading it here needs a Jina key (Jina refuses anonymous requests for archive.org)');
    fill(
      box,
      h('p', null, `Archived copy from ${formatDate(snap.at)}, at the Internet Archive.`),
      h(
        'p',
        null,
        settings.jinaKey ? [h('a', { href: hashFor('/r', { u: snap.raw }), class: 'button secondary small' }, 'Read it here'), ' '] : null,
        external(snap.view, 'Open in the archive ↗'),
      ),
      settings.jinaKey
        ? null
        : h(
            'p',
            { class: 'muted small' },
            'Jina Reader refuses anonymous requests for archive.org pages, so without a Jina key the copy opens in Safari at full size. A free key in Settings lets you read it here as text.',
          ),
    );
  } catch (e) {
    // The archive's "too many requests" reply carries no CORS header, so it looks like a failed connection.
    const why = e.network && navigator.onLine ? 'it refused or didn’t answer; it limits how often it can be asked, so try again in a minute' : describe(e);
    act.warn(`Couldn't check the Internet Archive: ${why}`);
    if (id !== renderId) return;
    const retry = h('button', { type: 'button', class: 'link' }, 'Try again');
    retry.addEventListener('click', () => archiveOffer(box, url, act, id));
    fill(
      box,
      h('p', { class: 'muted small' }, `Couldn't check the Internet Archive: ${why}.`),
      h('p', { class: 'small' }, retry, ' · ', external(L.waybackViewUrl('2', url), 'Open its latest copy in Safari ↗')),
    );
  }
}

// ---------- on-device AI: shared output ----------

/** Model text as paragraphs and lists; [n] becomes a link to source n when sources are given. */
function answerNodes(text, sources) {
  const inline = (t) =>
    sources
      ? AL.citations(t).map((part) => {
          if (part.text != null) return part.text;
          const src = sources[part.cite - 1];
          return src?.url ? h('a', { href: hashFor('/r', { u: src.url }), class: 'cite' }, `[${part.cite}]`) : `[${part.cite}]`;
        })
      : t;
  return AL.splitAnswer(text).map((b) => (b.type === 'list' ? h('ul', null, b.items.map((it) => h('li', null, inline(it)))) : h('p', null, inline(b.text))));
}

const loadNote = (p) => (p.total ? `${Math.round((100 * p.loaded) / p.total)}% of ${AL.size(p.total)}` : AL.size(p.loaded));

/**
 * Runs a chat model and streams its reply into `out`, narrating in `status` and the activity log.
 * Resolves with { text, stats }, or null if it failed (the reason is shown and logged). Text that
 * arrived before a failure or a stop stays on screen, labelled as incomplete.
 *
 * While the model writes, the reply is drawn as plain text, at most every 100 ms; it is formatted
 * (lists, citations) once, when it is finished. The time spent drawing is measured and logged.
 */
async function runModel(pkg, messages, { out, status, act, id, maxTokens, label, sources, fit = false, alive = () => true, meta = {} }) {
  const short = AL.PACKAGES[pkg].short;
  const live = () => id === renderId && alive();
  const stopBtn = h('button', { type: 'button', class: 'link', onclick: () => AI.stop('user', String(id)) }, 'Stop');
  let text = '';
  let drawn = false;
  let timer = null;
  const node = document.createTextNode('');
  const ui = { flushes: 0, ms: 0, final: 0 };
  const flush = () => {
    timer = null;
    if (!live()) return;
    const t0 = performance.now();
    if (!drawn) {
      fill(out, h('p', { class: 'live' }, node));
      drawn = true;
    }
    node.data = text;
    ui.ms += performance.now() - t0;
    ui.flushes++;
  };
  const finalise = (note) => {
    clearTimeout(timer);
    timer = null;
    if (!live() || !text) return;
    const t0 = performance.now();
    fill(out, answerNodes(text, sources), note ? h('p', { class: 'small warn' }, note) : null);
    ui.final = performance.now() - t0;
    AI.event('ai.ui.render', {
      msg: `Reply drawn: ${ui.flushes} live updates took ${Math.round(ui.ms)} ms, final formatting ${Math.round(ui.final)} ms`,
      m: { flushes: ui.flushes, liveMs: Math.round(ui.ms * 10) / 10, finalMs: Math.round(ui.final * 10) / 10, chars: text.length, label },
    });
  };
  try {
    if (AI.busy()) {
      act.step('Waiting for another AI task to finish first');
      fill(status, 'Waiting for another AI task to finish… ', stopBtn);
    } else fill(status, AI.loadedModels().has(pkg) ? `${short} is reading the prompt… ` : `Loading ${short} into memory… `, stopBtn);
    const stats = await AI.generate(pkg, messages, {
      maxTokens,
      label,
      fit,
      owner: String(id),
      meta,
      onProgress: (p) => live() && fill(status, `Loading ${short} into memory: ${loadNote(p)} `, stopBtn),
      onToken: (t) => {
        if (!text && live()) fill(status, `${short} is writing… `, stopBtn);
        text += t;
        if (!timer && live()) timer = setTimeout(flush, 100);
      },
    });
    if (!text.trim()) act.warn(`${short} returned no text`);
    finalise(stats.stopped ? 'Stopped before it finished, so this is incomplete.' : null);
    act.ok(`${short}: ${AL.describeRun(stats)}`);
    if (live()) fill(status, `${short} on this device · 0 B downloaded · ${AL.describeRun(stats)}`);
    return { text, stats };
  } catch (e) {
    const cancelled = e.code === 'CANCELLED';
    finalise(text ? (cancelled ? 'Stopped before it finished, so this is incomplete.' : 'The AI failed before it finished, so this is incomplete.') : null);
    if (cancelled) {
      act.skip('Stopped');
      if (live()) fill(status, 'Stopped.');
    } else {
      act.warn(`AI failed: ${AI.explain(e)}`);
      if (live()) fill(status, h('span', { class: 'bad' }, `The AI failed: ${AI.explain(e)} `), h('a', { href: '#/ai' }, 'Details in AI diagnostics'));
    }
    return null;
  }
}

const coverageText = (plan) =>
  plan.strategy === 'single'
    ? 'the whole page'
    : `${plan.note}. This is not the whole page: about ${Math.max(1, Math.round(plan.coverage * 100))}% of its text was read`;

/** The reader's summary card. `cachedOnly` shows a summary made earlier without making a new one. */
async function summarise(rec, url, box, act, id, { auto = false, redo = false, cachedOnly = false } = {}) {
  const pkg = AI.chatModel(settings.aiModel);
  if (!pkg) return;
  const spec = AL.PACKAGES[pkg];
  const status = h('p', { class: 'small muted' });
  const out = h('div', { class: 'answer' });
  const head = h('h2', null, 'Summary');
  const old = redo ? null : await AI.getSummary(url, pkg, rec.markdown);
  if (id !== renderId) return;
  if (old) {
    box.hidden = false;
    fill(box, head, out, status);
    fill(out, answerNodes(old.text));
    fill(
      status,
      `Made ${L.relTime(old.at)} by ${spec.short} on this device${old.note ? `, from ${old.strategy === 'single' ? 'the whole page' : old.note}` : ''} · `,
      h('button', { type: 'button', class: 'link', onclick: () => summarise(rec, url, box, act, id, { redo: true }) }, 'Redo'),
    );
    return act.skip(`Summary: made earlier by ${spec.short}, kept on this device`);
  }
  if (cachedOnly) return;
  box.hidden = false;
  fill(box, head, out, status);
  if (AL.markdownToText(rec.markdown).length < 200) {
    fill(status, 'There is too little text on this page to summarise.');
    return act.skip('Summary: too little text on the page');
  }
  // What fits one prompt comes from the model's own limit; the text is chosen from the WHOLE page
  const lim = AI.limitsFor(pkg);
  const title = rec.title.slice(0, 80);
  const plan = SEL.planSummary(rec.markdown, { perCallChars: AL.textBudget(lim.maxInput, 110), maxParts: AI.lowMemory() ? 2 : 4 });
  act.step(
    `${auto ? 'Summarising automatically (Settings)' : 'Summarising'} with ${spec.short} on this device: ${plan.strategy === 'single' ? 'the whole page' : plan.note} · ${plan.calls === 1 ? '1 pass' : `${plan.calls} passes`}. Nothing is sent anywhere.`,
  );
  const summaryTokens = lim.maxNew;
  const base = { out, status, act, id, fit: true, meta: { strategy: plan.strategy, coverage: Math.round(plan.coverage * 100) / 100, calls: plan.calls, sections: plan.sections, sectionsUsed: plan.sectionsUsed, pageChars: plan.of } };
  let messages = AL.summaryMessages(title, plan.text, { excerpted: plan.strategy !== 'single' });
  if (plan.strategy === 'hierarchical') {
    act.step(`The page is long, so it is read in ${plan.parts.length} parts picked from across it: notes on each, then a summary of the notes`);
    const notes = [];
    for (const [i, part] of plan.parts.entries()) {
      if (id !== renderId) return;
      const pStatus = h('span');
      fill(out, h('p', { class: 'muted' }, `Reading part ${i + 1} of ${plan.parts.length}… `, pStatus));
      const n = await runModel(pkg, AL.partMessages(title, part, i + 1, plan.parts.length), { ...base, out: h('div'), status: pStatus, maxTokens: Math.min(lim.maxNew, 50), label: `summary part ${i + 1}/${plan.parts.length}` });
      if (!n) return fill(status, pStatus.childNodes.length ? [...pStatus.childNodes] : 'The AI failed.');
      if (n.stats.stopped) return fill(status, 'Stopped.');
      notes.push(n.text);
    }
    messages = AL.combineMessages(title, notes);
    fill(out);
  }
  const r = await runModel(pkg, messages, { ...base, maxTokens: summaryTokens, label: 'summary' });
  if (r && id === renderId) status.append(` · from ${coverageText(plan)}`);
  if (r?.text.trim() && !r.stats.stopped) {
    await AI.saveSummary(url, pkg, rec.markdown, { text: r.text, at: Date.now(), stats: r.stats, strategy: plan.strategy, coverage: plan.coverage, note: plan.note, calls: plan.calls });
    act.ok('Summary kept on this device with the page');
  }
}

/** A Wikipedia article: the opening section, then a button for each other section that loads it when tapped. */
function wikiView(rec, url, act, rerender) {
  const w = rec.wiki;
  const base = rec.source || url;
  const blocksOf = (md) => blockNodes(L.parseMarkdown(md, base), url);
  const persist = () => {
    rec.markdown = wikiText(rec);
    return S.put('pages', url, rec);
  };
  const fetchHtml = async (apiUrl, what) => {
    act.step(`Wikipedia: fetching ${what}…`);
    const r = await act.fetch(apiUrl, { timeout: 25000 });
    const json = r.json();
    if (W.apiError(json)) throw new Error(W.apiError(json));
    return { html: W.parseBody(json).html, entry: r.entry };
  };
  const pending = w.full ? [] : w.sections.filter((s) => w.parts[s.index] == null);
  const loadedSections = w.full ? [] : w.sections.filter((s) => w.parts[s.index] != null);
  const status = h('span', { class: 'muted small' });
  const slots = new Map();
  const nodes = [blocksOf(w.parts[0] ?? '')];

  const openSection = async (sec, btn) => {
    btn.disabled = true;
    status.textContent = `loading “${sec.line}”…`;
    try {
      const { html, entry } = await fetchHtml(W.sectionUrl(w.host, w.title, sec.index), `the “${sec.line}” section`);
      let md = W.htmlToMarkdown(html, w.host);
      if (!/^#\s/.test(md)) md = `# ${sec.line}\n\n${md || '*Nothing in this section can be shown as text.*'}`;
      w.parts[sec.index] = md;
      await persist();
      act.ok(`Wikipedia: “${sec.line}” is ${B(new Blob([md]).size)} of text, ${B(entry.wire ?? entry.received)} downloaded; saved on this device`);
      status.textContent = '';
      fill(slots.get(sec.index), blocksOf(md));
    } catch (e) {
      act.warn(`Wikipedia: “${sec.line}” failed: ${describe(e)}`);
      status.textContent = `couldn't load “${sec.line}”: ${describe(e)}`;
      btn.disabled = false;
    }
  };

  for (const sec of w.full ? [] : w.sections) {
    const slot = h('div', { class: 'wiki-slot' });
    slots.set(sec.index, slot);
    if (w.parts[sec.index] != null) fill(slot, blocksOf(w.parts[sec.index]));
    else {
      const btn = h('button', { type: 'button', class: 'button secondary wiki-open' }, `▸ ${sec.line}`);
      btn.addEventListener('click', () => openSection(sec, btn));
      fill(slot, btn, sec.subs ? h('span', { class: 'muted small' }, ` ${plural(sec.subs, 'subsection')} included`) : null);
    }
    nodes.push(slot);
  }
  if (pending.length) {
    const all = h('button', { type: 'button', class: 'link' }, 'Load the whole article');
    all.addEventListener('click', async () => {
      all.disabled = true;
      status.textContent = 'loading the whole article…';
      try {
        const { html, entry } = await fetchHtml(W.fullUrl(w.host, w.title), 'the whole article');
        const md = W.htmlToMarkdown(html, w.host);
        w.parts = { 0: md };
        w.full = true;
        await persist();
        act.ok(`Wikipedia: whole article is ${B(new Blob([md]).size)} of text, ${B(entry.wire ?? entry.received)} downloaded; saved on this device`);
        rerender();
      } catch (e) {
        act.warn(`Wikipedia: the whole article failed: ${describe(e)}`);
        status.textContent = `couldn't load the whole article: ${describe(e)}`;
        all.disabled = false;
      }
    });
    nodes.push(
      h(
        'p',
        { class: 'wiki-hint small' },
        pending.length === w.sections.length
          ? `Opening section only, loaded from Wikipedia directly. Tap a section to load it (usually 2–10 KB). `
          : `${plural(loadedSections.length, 'section')} loaded, ${pending.length} to go. `,
        all,
        ' ',
        status,
      ),
    );
  }
  return nodes;
}

async function showRead(id, raw, reload = false) {
  const url = L.safeHttpUrl(raw);
  const arch = url ? L.parseWaybackUrl(url) : null;
  const host = arch ? `${L.hostOf(arch.original)} (archived ${formatDate(arch.at)})` : url ? L.hostOf(url) : '';
  const act = activity(`Opening ${host || 'page'}…`);
  const status = h('div', { class: 'status' });
  const article = h('article', { class: 'reader group' });
  render(topbar(''), act.el, status, article);
  if (!url) {
    act.warn('That is not a web address this app can open');
    return fill(status, h('p', null, 'That is not a web address this app can open.'));
  }
  clearReady(url);

  const showPage = (rec, { fromDevice = false, note = '' } = {}) => {
    if (id !== renderId) return;
    document.title = `${rec.title} · Sparse`;
    const n = rec.net;
    const original = n
      ? `${B(n.received)} received, ${n.wireKind === 'exact' ? '' : '≈'}${B(n.wire)} on the wire, first byte ${T(n.ttfb)}, total ${T(n.ms)} (≈${L.formatSpeed(n.wire ?? n.received, n.ms)})`
      : 'size not recorded';
    fill(
      status,
      h('p', null, `${host} · ${B(new Blob([rec.markdown]).size)} of text · fetched ${L.relTime(rec.at)}`),
      h(
        'p',
        { class: 'small' },
        fromDevice ? `From this device: 0 B downloaded now. Original download: ${original}.` : `Downloaded: ${original}.`,
        note ? ` ${note}` : '',
        ' ',
        h('button', { type: 'button', class: 'link', onclick: () => showRead(++renderId, url, true) }, 'Reload'),
      ),
    );
    const save = h('button', { type: 'button', class: 'button secondary small' }, rec.saved ? 'Saved ✓' : 'Save for offline');
    save.addEventListener('click', async () => {
      rec.saved = !rec.saved;
      await S.put('pages', url, rec);
      save.textContent = rec.saved ? 'Saved ✓' : 'Save for offline';
      setNow(rec.saved ? 'Page kept on this device until you unsave it' : 'Page may now be cleared after 30 days');
    });
    act.step('Turning the text into a page…');
    const blocks = L.trimNav(L.parseMarkdown(rec.markdown, rec.source || url));
    const box = h('div', { class: 'archive card', hidden: true });
    const summary = h('div', { class: 'ai-out card', hidden: true });
    const sumBtn = AI.anyChat(settings.aiModel) ? h('button', { type: 'button', class: 'button secondary small', onclick: () => summarise(rec, url, summary, act, id, { redo: !summary.hidden }) }, 'Summarise') : null;
    const archived = h('button', { type: 'button', class: 'button secondary small' }, 'Archived copy');
    archived.addEventListener('click', () => {
      archived.disabled = true;
      box.hidden = false;
      archiveOffer(box, url, act, id);
    });
    fill(
      article,
      h('h1', null, rec.title),
      arch ? h('p', { class: 'small muted' }, `Archived copy from ${formatDate(arch.at)}, read from the Internet Archive.`) : null,
      h(
        'p',
        { class: 'actions' },
        arch
          ? [external(arch.original, 'Open live page ↗', 'button secondary small'), external(L.waybackViewUrl(arch.ts, arch.original), 'Open in the archive ↗', 'button secondary small')]
          : [external(url, 'Open original ↗', 'button secondary small'), archived],
        save,
        sumBtn,
        rec.published ? h('span', { class: 'muted small' }, formatDate(rec.published)) : null,
      ),
      box,
      summary,
      rec.wiki
        ? wikiView(rec, url, act, () => showPage(rec, { fromDevice: true, note: 'The whole article is loaded.' }))
        : blocks.length
          ? blockNodes(blocks, url, arch ? (href) => L.unarchiveLink(href, arch.original) : undefined)
          : h('p', { class: 'muted' }, 'The reader found no text on this page. Try opening the original.'),
    );
    act.ok(`Showing ${plural(blocks.length, 'block')} of text (menus at the top removed)`);
    settle();
    if (sumBtn) summarise(rec, url, summary, act, id, { auto: settings.aiAutoSummary && !fromDevice && AI.autoAllowed(), cachedOnly: !(settings.aiAutoSummary && !fromDevice && AI.autoAllowed()) });
  };

  const showProblem = (message, { archive = false } = {}) => {
    if (id !== renderId) return;
    fill(status, h('p', null, message));
    const box = h('div', { class: 'archive card' });
    fill(
      article,
      h('p', null, arch ? external(L.waybackViewUrl(arch.ts, arch.original), 'Open the archived copy in Safari ↗') : external(url, 'Open the original page ↗')),
      archive && !arch ? box : null,
    );
    if (archive && !arch) return archiveOffer(box, url, act, id);
  };

  act.step('Looking for this page on this device…');
  let rec = await S.get('pages', url);
  if (id !== renderId) return;
  if (rec && !reload) {
    act.ok(`Found it (fetched ${L.relTime(rec.at)}, ${B(jsonSize(rec))} on device): nothing downloaded`);
    showPage(rec, { fromDevice: true });
    return act.finish('Page opened from this device');
  }
  act.step(rec ? 'Found a saved copy, but you asked to reload' : 'Not on this device yet');
  if (arch && !settings.jinaKey) {
    act.skip('Jina Reader refuses anonymous requests for archive.org pages, and there is no Jina key in Settings');
    showProblem(
      'Reading archived pages here needs a free Jina API key (Settings): Jina refuses anonymous requests for archive.org. You can still open the copy in Safari, at full size.',
    );
    return act.finish('Archived page needs a Jina key');
  }
  if (!navigator.onLine) {
    if (rec) {
      act.ok('Offline: showing the saved copy');
      showPage(rec, { fromDevice: true, note: 'You are offline.' });
      return act.finish('Offline, opened from this device');
    }
    await enqueue({ kind: 'page', key: url, url });
    act.warn('Offline: queued this page; it will be fetched when the connection comes back');
    showProblem("You're offline. This page is queued and will be fetched when you're back online.");
    return act.finish('Offline, page queued');
  }
  try {
    showPage(await loadPage(url, act));
    act.finish('Page loaded');
  } catch (e) {
    act.warn(`Couldn't load: ${describe(e)}`);
    if (rec) {
      showPage(rec, { fromDevice: true, note: `Reload failed: ${describe(e)}.` });
      return act.finish('Reload failed, showing the saved copy');
    }
    if (e.network) {
      await enqueue({ kind: 'page', key: url, url });
      act.warn('Queued this page for when the connection is back');
      showProblem(`Couldn't reach the reader (${e.message}). This page is queued and will load when the connection is back.`);
      return act.finish('Page failed, queued');
    }
    act.finish('Page failed');
    await showProblem(`Couldn't load this page: ${describe(e)}.`, { archive: true });
  }
}

/** Measures env(safe-area-inset-*) and the vh units with a hidden probe element. */
function probe(style, read) {
  const el = h('div');
  el.style.cssText = `position:fixed;visibility:hidden;pointer-events:none;${style}`; // CSSOM, which the CSP allows (style attributes it doesn't)
  document.body.append(el);
  const out = read(getComputedStyle(el), el);
  el.remove();
  return out;
}
const safeAreaInsets = () =>
  probe('padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)', (cs) =>
    [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((v) => Math.round(parseFloat(v))).join(', '),
  );
const viewportUnits = () =>
  [probe('height:100vh', (_, el) => el.offsetHeight), CSS.supports('height', '100dvh') ? probe('height:100dvh', (_, el) => el.offsetHeight) : '?'].join(' / ');

// The Network page redraws itself after each request, so a running speed test keeps its state here.
let speedRun = { running: false, text: '' };
let speedUi = null;

/** The speed test card on the Network page. Nothing is downloaded until the button is tapped. */
function speedGroup(saved) {
  const body = h('div');
  const status = h('p', { class: 'muted small' });
  const btn = h('button', { type: 'button', class: 'button secondary small' }, 'Test speed');
  const draw = (rec) => {
    fill(
      body,
      rec
        ? [
            h('table', { class: 'kv' }, rec.results.map((r) => h('tr', null, h('th', null, r.name), h('td', { class: r.error ? 'bad' : null }, L.speedLine(r))))),
            h('p', { class: 'muted small' }, `Tested ${L.relTime(rec.at)}. Latency is the time to the first byte, so it includes setting up the connection.`),
          ]
        : h('p', { class: 'muted small' }, 'Not tested yet.'),
    );
  };
  draw(saved);
  btn.disabled = speedRun.running;
  status.textContent = speedRun.text || 'Uses about 0.5 MB, or up to 2.5 MB on a fast connection. It tests Cloudflare and this app’s own host.';
  speedUi = { btn, status, draw };
  btn.addEventListener('click', async () => {
    if (!navigator.onLine) return (status.textContent = 'You are offline.');
    speedRun = { running: true, text: 'Starting…' };
    btn.disabled = true;
    const results = await SP.runAll((t) => {
      speedRun.text = t;
      speedUi.status.textContent = t;
    });
    const rec = { at: Date.now(), results };
    await S.kvSet('speed', rec);
    speedRun = { running: false, text: `Used ${B(results.reduce((n, r) => n + r.bytes, 0))}.` };
    speedUi.draw(rec);
    speedUi.status.textContent = speedRun.text;
    speedUi.btn.disabled = false;
  });
  return group('Speed test', btn, body, status);
}

async function showNet(id) {
  document.title = 'Network · Sparse';
  const [est, results, pages, speed] = await Promise.all([navigator.storage?.estimate?.().catch(() => null) ?? null, S.entries('results'), S.entries('pages'), S.kvGet('speed', null)]);
  if (id !== renderId) return;
  const s = N.session;
  const c = navigator.connection;
  const appFiles = [
    performance.getEntriesByType('navigation')[0],
    ...performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin)),
  ].filter(Boolean);
  const row = (label, value) => h('tr', null, h('th', null, label), h('td', null, value));
  const services = Object.entries(netTotals.by).sort((a, b) => b[1].received - a[1].received);
  render(
    pageHead('Network'),
    group('Connection', null,
      h(
        'table',
        { class: 'kv' },
        row('Status', navigator.onLine ? `Online${active.size ? `, ${plural(active.size, 'request')} in progress` : ''}` : 'Offline'),
        c
          ? [
              row('Type', c.effectiveType ?? '?'),
              row('Estimated speed', c.downlink != null ? `${c.downlink} Mbit/s` : '?'),
              row('Estimated latency', c.rtt != null ? `${c.rtt} ms` : '?'),
              row('Data saver', c.saveData ? 'on' : 'off'),
            ]
          : row('Type and speed', 'Not shared by this browser (Safari keeps them private). Speeds below are measured from real requests.'),
      ),
    ),
    speedGroup(speed),
    group('This session', null,
      h(
        'table',
        { class: 'kv' },
        row('Requests', `${s.requests}${s.errors ? ` (${s.errors} failed)` : ''}`),
        row('Received', B(s.received)),
        row('On the wire', `≈${B(s.wire)}`),
        row('Time waiting on the network', T(s.ms)),
        row('Average speed', s.ms ? `≈${L.formatSpeed(s.wire, s.ms)}` : '?'),
      ),
    ),
    group(`By service, since ${new Date(netTotals.since).toLocaleDateString()}`, null,
      services.length
        ? h(
            'div',
            { class: 'table' },
            h(
              'table',
              { class: 'grid' },
              h(
                'tr',
                null,
                ['Service', 'Req', 'Recv', 'Wire', 'Speed', 'Fail'].map((t) => h('th', null, t)),
              ),
              services.map(([name, t]) =>
                h(
                  'tr',
                  null,
                  h('td', null, name),
                  h('td', null, t.requests),
                  h('td', null, B(t.received)),
                  h('td', null, `≈${B(t.wire)}`),
                  h('td', null, t.ms ? L.formatSpeed(t.wire, t.ms) : '?'),
                  h('td', null, t.errors),
                ),
              ),
              h(
                'tr',
                { class: 'total' },
                h('td', null, 'Total'),
                h('td', null, netTotals.requests),
                h('td', null, B(netTotals.received)),
                h('td', null, `≈${B(netTotals.wire)}`),
                h('td', null, netTotals.ms ? L.formatSpeed(netTotals.wire, netTotals.ms) : '?'),
                h('td', null, netTotals.errors),
              ),
            ),
          )
        : h('p', { class: 'muted small' }, 'No requests yet.'),
      twoTap('Reset these totals and the request log', async () => {
        netTotals = emptyTotals();
        netLog = [];
        await S.kvSet('nettotals', netTotals);
        await S.kvSet('netlog', netLog);
      }),
    ),
    group('Screen', null,
      h(
        'table',
        { class: 'kv' },
        row('Running as', navigator.standalone || matchMedia('(display-mode: standalone)').matches ? 'Home-screen app' : 'Browser tab'),
        row('Window (layout)', `${innerWidth} × ${innerHeight}`),
        row('Visible area', visualViewport ? `${Math.round(visualViewport.width)} × ${Math.round(visualViewport.height)}` : '?'),
        row('Screen', `${screen.width} × ${screen.height}`),
        row('Safe-area insets (top, right, bottom, left)', safeAreaInsets()),
        row('Page height (100vh / 100dvh)', viewportUnits()),
      ),
      h('p', { class: 'muted small' }, 'If parts of the screen are cut off, these numbers show what iOS reports to the page.'),
    ),
    group('App files on this launch', null,
      h('p', { class: 'small' }, appLoadText()),
      h(
        'ul',
        { class: 'plain small' },
        appFiles.map((f) =>
          h(
            'li',
            null,
            new URL(f.name).pathname.replace(/.*\//, '') || 'index.html',
            h(
              'span',
              { class: 'muted' },
              ` · ${f.transferSize ? `${B(f.transferSize)} downloaded` : 'from cache, 0 B'} · ${B(f.decodedBodySize || 0)} · ${T(f.duration)}`,
            ),
          ),
        ),
      ),
    ),
    group('Stored on this device', null,
      h(
        'table',
        { class: 'kv' },
        row('Saved searches and forecasts', `${results.length} (${B(results.reduce((n, [, v]) => n + jsonSize(v), 0))})`),
        row('Pages', `${pages.length}, ${pages.filter(([, p]) => p.saved).length} kept (${B(pages.reduce((n, [, v]) => n + jsonSize(v), 0))})`),
        row('Total storage used', est ? B(est.usage) : 'not available'),
      ),
    ),
    group(`Recent requests (${netLog.length})`, null,
      netLog.length
        ? h(
            'ol',
            { class: 'requests' },
            netLog.map((e) =>
              h(
                'li',
                { class: e.error ? 'bad' : null },
                h(
                  'details',
                  null,
                  h(
                    'summary',
                    null,
                    h('b', null, e.service),
                    ` · ${new Date(e.at).toLocaleTimeString()} · ${e.error && e.status == null ? e.error : `${e.status} · ${B(e.received)} · ${T(e.ms)}`}`,
                  ),
                  h('p', null, L.describeTransfer(e)),
                  h('p', { class: 'muted url' }, e.url),
                ),
              ),
            ),
          )
        : h('p', { class: 'muted small' }, 'None yet.'),
    ),
    group('How this is measured', null,
      h(
        'ul',
        { class: 'small' },
        h('li', null, 'Received: the exact number of bytes that arrived, after the browser decompressed them.'),
        h(
          'li',
          null,
          'On the wire: exact when the service sends a Content-Length header (Open-Meteo places, Mojeek). Otherwise it is estimated (≈) by gzip-compressing what arrived, because browsers hide other sites’ real transfer sizes from web pages.',
        ),
        h(
          'li',
          null,
          'First byte: time until the response headers arrived. Total: until the last byte. Speed: on-the-wire size divided by total time, so latency is included.',
        ),
        h('li', null, 'App files are this site’s own files, so the browser reports their exact transfer sizes. 0 B means they came from the offline cache.'),
      ),
    ),
  );
  settle();
}

// ---------- ask: questions for the on-device AI ----------

const sourceLabel = (s) => (s.kind === 'page' ? `${L.hostOf(s.url)} · saved page` : s.kind === 'instant' ? `instant answer for “${s.q}”` : `search result for “${s.q}”`);

function sourceList(sources, chars = 160) {
  return h(
    'ol',
    { class: 'sources small' },
    sources.map((s) =>
      h(
        'li',
        null,
        s.url ? h('a', { href: hashFor('/r', { u: s.url }) }, s.title) : s.title,
        s.heading ? h('span', { class: 'muted' }, ` › ${s.heading}`) : null,
        h('span', { class: 'muted' }, ` · ${sourceLabel(s)}${s.from ? ` · matched by ${s.from.join(' and ')}` : ''}`),
        s.text ? h('span', { class: 'block muted' }, `${s.text.slice(0, chars)}${s.text.length > chars ? '…' : ''}`) : null,
      ),
    ),
  );
}

let askSeq = 0;

async function showAsk(id, q0) {
  document.title = 'Ask · Sparse';
  const asks = await AI.recentAsks();
  if (id !== renderId) return;
  const pkg = AI.chatModel(settings.aiModel);
  const blockers = AI.chatBlockers();
  const bge = AI.isReady('bge') && AI.mayRun('bge').ok;
  const act = activity('Ask');
  const input = h('textarea', { name: 'q', rows: 3, placeholder: pkg ? 'Ask a question' : 'Words to find in saved pages', 'aria-label': 'Question', enterkeyhint: 'send' }, q0);
  const mode = h(
    'select',
    { 'aria-label': 'Answer from' },
    h('option', { value: 'saved', selected: true }, 'My saved pages and searches'),
    h('option', { value: 'general', disabled: !pkg }, 'The model’s own knowledge (no sources)'),
  );
  const chats = AL.CHAT_IDS.filter((x) => AI.isReady(x) && AI.mayRun(x).ok);
  const model =
    chats.length > 1
      ? h(
          'select',
          { 'aria-label': 'Model', onchange: () => saveSetting('aiModel', model.value) },
          chats.map((x) => h('option', { value: x, selected: x === pkg }, AL.PACKAGES[x].short)),
        )
      : null;
  const out = h('div');
  const ask = async () => {
    const question = input.value.trim();
    if (!question) return;
    // a newer question replaces one still working: stop it and drop its waiting tasks
    const mine = ++askSeq;
    const alive = () => id === renderId && mine === askSeq;
    AI.stop('new question', String(id));
    input.blur();
    const use = model?.value ?? pkg;
    const status = h('p', { class: 'small muted' });
    const answer = h('div', { class: 'answer' });
    const srcBox = h('div');
    const srcHead = h('h3', null, 'Sources on this device');
    fill(out, h('div', { class: 'ai-out card' }, h('h2', null, question), answer, status, srcBox));
    let sources = null;
    let messages;
    if (mode.value === 'saved') {
      fill(status, 'Searching what is saved on this device…');
      let found;
      try {
        // the evidence budget is hard (labels included) and comes from the model's own limit
        const lim = use ? AI.limitsFor(use) : null;
        const budget = lim ? AL.textBudget(lim.maxInput, 100 + Math.ceil(question.length / 2.5)) : 1500;
        found = await AI.retrieve(question, { budget, max: use ? 4 : 6, say: (k, t) => act[k](t), owner: String(id) });
      } catch (e) {
        act.warn(`Search of saved pages failed: ${AI.explain(e)}`);
        return fill(status, h('span', { class: 'bad' }, `Searching saved pages failed: ${AI.explain(e)} `), h('a', { href: '#/ai' }, 'AI diagnostics'));
      }
      if (!alive()) return;
      sources = found.picked;
      const mt = found.metrics;
      act.ok(`Search took ${mt.totalMs} ms: ${mt.passages ?? 0} passages${mt.semantic === 'on' ? `, ${mt.newVectors ?? 0} newly indexed` : ''}, ${sources.length} chosen`);
      AI.noteDetail({ question, sources: sources.map((x) => x.title) });
      if (!sources.length) {
        act.skip('Nothing saved matches the question');
        fill(status, found.count ? 'Nothing saved on this device matches the question.' : 'Nothing is saved on this device yet: search, or open pages in the reader, and they become answerable here.');
        if (use) {
          const alt = h('button', { type: 'button', class: 'button secondary small', onclick: () => ((mode.value = 'general'), ask()) }, 'Ask the model’s own knowledge instead');
          srcBox.append(h('p', null, alt));
        }
        return act.finish('Ask: nothing matched');
      }
      fill(srcBox, srcHead, sourceList(sources, use ? 160 : 700));
      act.ok(`Using ${plural(sources.length, 'passage')} (${sources.reduce((n, x) => n + x.text.length, 0).toLocaleString()} characters)`);
      if (!use) {
        fill(
          status,
          blockers.length
            ? `Written answers are off (${blockers.map((b) => `${AL.PACKAGES[b.id].short}: ${b.why}`).join('; ')}), so these are the closest passages instead. `
            : 'These are the closest passages. Download a chat model on the AI page to get a written answer. ',
          h('a', { href: '#/ai' }, 'AI settings'),
        );
        return act.finish('Ask: passages found (no chat model)');
      }
      messages = AL.answerMessages(question, sources);
    } else {
      act.step('Answering from the model’s own knowledge: no sources, so check anything important');
      messages = AL.generalMessages(question);
    }
    const r = await runModel(use, messages, { out: answer, status, act, id, maxTokens: AI.limitsFor(use).maxNew, label: mode.value === 'saved' ? 'answer from saved' : 'general answer', sources, fit: mode.value === 'saved', alive, meta: { sources: sources?.length ?? 0 } });
    if (!alive()) return;
    if (!r) {
      if (sources?.length) srcHead.textContent = 'Closest passages on this device (the AI could not write an answer)';
      return act.finish('Ask failed');
    }
    if (mode.value === 'general') status.append(' · from the model’s memory (trained to mid-2024); it can be wrong');
    await AI.saveAsk({ q: question, mode: mode.value, pkg: use, text: r.text, stats: r.stats, at: Date.now(), sources: sources?.map(({ title, url, kind, q }) => ({ title, url, kind, q })) });
    act.finish(`Answered on this device · ${AL.describeRun(r.stats)}`);
  };
  render(
    pageHead('Ask', h('a', { href: '#/ai' }, 'AI settings')),
    !pkg
      ? h(
          'div',
          { class: 'card' },
          blockers.length
            ? h('p', null, 'Written answers are switched off: ', blockers.map((b) => `${AL.PACKAGES[b.id].short} (${b.why})`).join('; '), '. ', h('a', { href: '#/ai' }, 'See AI settings'), '.')
            : h('p', null, 'Written answers need a model on this device. Nothing is downloaded until you choose one: ', h('a', { href: '#/ai' }, 'set up on-device AI'), '.'),
          h('p', { class: 'small muted' }, 'Until then, this finds the closest passages in your saved pages and searches, by keyword. Nothing else is affected.'),
        )
      : null,
    h(
      'form',
      {
        class: 'ask',
        onsubmit: (e) => {
          e.preventDefault();
          ask();
        },
      },
      input,
      h('div', { class: 'ask-row' }, mode, model, h('button', { type: 'submit', class: 'button' }, pkg ? 'Ask' : 'Find')),
      h(
        'p',
        { class: 'small muted' },
        pkg ? `${AL.PACKAGES[pkg].short} answers on this device, offline, within a safe size limit. ` : '',
        bge ? 'Saved passages are matched by meaning (BGE) and by keyword.' : 'Saved passages are matched by keyword; BGE on the AI page adds matching by meaning.',
      ),
    ),
    act.el,
    out,
    asks.length > 0 &&
      group('Earlier questions', null,
        asks.map((a) =>
          h(
            'details',
            { class: 'earlier' },
            h('summary', null, a.q, h('span', { class: 'muted small' }, ` · ${L.relTime(a.at)}`)),
            h('div', { class: 'answer' }, answerNodes(a.text, a.sources)),
            h('p', { class: 'small muted' }, `${AL.PACKAGES[a.pkg]?.short ?? a.pkg} · ${a.mode === 'saved' ? 'from saved pages' : 'own knowledge'} · ${AL.describeRun(a.stats)}`),
            a.sources?.length ? sourceList(a.sources) : null,
          ),
        ),
        twoTap('Clear earlier questions', () => AI.clearAsks()),
      ),
  );
  if (q0) ask();
  else settle();
}

// ---------- on-device AI: downloads, device checks, diagnostics ----------

let aiUnsub = null;

function pkgCard(id, rec, dev) {
  const spec = AL.PACKAGES[id];
  const variant = rec.dtype ? rec : AL.pickVariant(spec, AI.usableGpu(dev));
  const total = AL.totalSize(AL.filesFor(spec, variant.dtype));
  const unsupported = !variant.dtype;
  const where = unsupported ? '' : `${variant.dtype} on ${variant.device === 'webgpu' ? 'WebGPU' : 'the CPU'}`;
  const prog = h('progress', { max: total, value: rec.have ?? 0, hidden: !['downloading', 'paused', 'queued'].includes(rec.status) });
  const line = h('p', { class: 'small', id: `ai-status-${id}` });
  const statusText = {
    none: unsupported ? 'Not available on this device' : `Not on this device · ${AL.size(total)}`,
    queued: 'Waiting to download…',
    downloading: `Downloading · ${AL.size(rec.have ?? 0)} of ${AL.size(total)}`,
    paused: `Paused at ${AL.size(rec.have ?? 0)} of ${AL.size(total)}${rec.reason ? `: ${rec.reason}` : ''}`,
    failed: `Download failed: ${rec.error}`,
    ready: `On this device · ${AL.size(total)}${where ? ` · ${where}` : ''}`,
  }[rec.status];
  fill(line, rec.status === 'failed' ? h('span', { class: 'bad' }, statusText) : statusText);
  const button = (label, fn, cls = 'button small') => h('button', { type: 'button', class: cls, onclick: fn }, label);
  const testOut = h('div', { class: 'small' });
  const buttons = [];
  const notes = [];
  if ((rec.status === 'none' || rec.status === 'failed') && !unsupported) buttons.push(button(`Download ${AL.size(total - (rec.have ?? 0))}`, () => AI.download(id)));
  if (rec.status === 'paused') buttons.push(button('Resume', () => AI.download(id)));
  if (rec.status === 'queued' || rec.status === 'downloading') buttons.push(button('Pause', () => AI.pause(id), 'button secondary small'));
  if (rec.status === 'ready' && AI.mayRun(id).ok) buttons.push(button('Test', () => testModel(id, testOut), 'button secondary small'));
  else if (rec.status === 'ready') notes.push(h('p', { class: 'small warn' }, `Not running: ${AI.mayRun(id).why}`));
  if (rec.status !== 'none') buttons.push(twoTap(rec.status === 'ready' ? `Remove (frees ${AL.size(total)})` : 'Cancel and delete', () => AI.remove(id)));
  if (unsupported && rec.status === 'none')
    notes.push(h('p', { class: 'small bad' }, spec.runtime === 'webllm' ? 'Needs WebGPU with 16-bit floats, which this browser’s GPU doesn’t offer.' : `Needs WebGPU, which this browser doesn't offer${dev.gpu.fallback ? ' (only a software version)' : ''}.`));
  const limitsRow = spec.kind === 'chat' ? limitFields(id) : null;
  if (rec.crashes) notes.push(h('p', { class: 'small warn' }, `The app was ended unexpectedly ${plural(rec.crashes, 'time')} while using this${rec.lastCrash ? `, last ${L.relTime(rec.lastCrash.found)} (at “${rec.lastCrash.stage ?? '?'}”)` : ''}. iOS does not say why; the log below shows what was recorded.`));
  if (rec.lastError)
    notes.push(
      h('p', { class: 'small bad' }, `Last error (${rec.lastError.phase}, ${L.relTime(rec.lastError.at)}): ${rec.lastError.message} `, h('button', { type: 'button', class: 'link small', onclick: async () => (await AI.clearErrors(), route()) }, 'Dismiss')),
    );
  return h(
    'div',
    { class: 'card pkg' },
    h('h3', null, spec.name),
    h('p', { class: 'small muted' }, spec.role),
    line,
    prog,
    buttons.length ? h('p', { class: 'pkg-actions' }, buttons.flatMap((b, i) => (i ? [' ', b] : [b]))) : null,
    limitsRow,
    notes,
    testOut,
  );
}

/** The prompt and answer limits for one model: two number fields that save as they are changed. */
function limitFields(id) {
  const b = AI.limitBounds(id);
  const now = AI.limitsFor(id);
  const num = (value, min) => h('input', { type: 'number', inputmode: 'numeric', class: 'num', min, max: b.ceiling, step: 10, value });
  const inPrompt = num(now.maxInput, b.minInput);
  const inAnswer = num(now.maxNew, b.minNew);
  const hint = h('span', { class: 'small muted' });
  const reset = h('button', { type: 'button', class: 'link', hidden: !AI.limitsChanged(id), onclick: () => (AI.resetLimits(id), route()) }, 'Reset');
  const show = (note = '') => {
    const l = AI.limitsFor(id);
    inPrompt.value = l.maxInput;
    inAnswer.value = l.maxNew;
    reset.hidden = !AI.limitsChanged(id);
    hint.textContent = `${note}${AL.PACKAGES[id].limitNote ? `${AL.PACKAGES[id].limitNote} ` : ''}About ${AL.textBudget(l.maxInput).toLocaleString()} characters of page text fit the prompt. Prompt and answer together can be up to ${b.ceiling.toLocaleString()} tokens for this model. Longer ones use more memory: if the app is ended while the AI works, lower them.`;
  };
  const save = () => {
    const asked = { maxInput: Number(inPrompt.value), maxNew: Number(inAnswer.value) };
    const applied = AI.setLimits(id, asked);
    show(applied && (applied.maxInput !== asked.maxInput || applied.maxNew !== asked.maxNew) ? 'Adjusted to fit the limits. ' : 'Saved. ');
  };
  inPrompt.addEventListener('change', save);
  inAnswer.addEventListener('change', save);
  show();
  return h(
    'div',
    { class: 'limits' },
    h('p', { class: 'small' }, h('label', null, 'Longest prompt ', inPrompt, ' tokens'), ' ', h('label', null, 'Longest answer ', inAnswer, ' tokens'), ' ', reset),
    h('p', null, hint),
  );
}

async function testModel(id, box) {
  const spec = AL.PACKAGES[id];
  const say = (...n) => fill(box, ...n);
  try {
    say(`Loading ${spec.short}…`);
    await AI.ensureLoaded(id, { onProgress: (p) => say(`Loading ${spec.short}: ${loadNote(p)}`) });
    if (spec.kind === 'embed') {
      const t0 = performance.now();
      const [a, b, c] = await AI.embed(['The cat sat on the mat.', 'A kitten was resting on the rug.', 'Interest rates rose by half a percent.']);
      return say(
        `Works: similar sentences scored ${AL.dot(a, b).toFixed(2)}, unrelated ${AL.dot(a, c).toFixed(2)} (higher means closer), in ${T(performance.now() - t0)}. Loaded in ${T(AI.loadedModels().get(id)?.ms)}.`,
      );
    }
    let text = '';
    const stats = await AI.generate(id, AL.generalMessages('In one sentence, what does a web browser do?'), {
      maxTokens: 48,
      label: 'test',
      owner: 'ai-page',
      onToken: (t) => {
        text += t;
        say(`“${text}”`);
      },
    });
    say(h('span', null, `“${text.trim()}”`), h('span', { class: 'block muted' }, `Works: ${AL.describeRun(stats)}. Loaded in ${T(AI.loadedModels().get(id)?.ms)}.`));
  } catch (e) {
    say(h('span', { class: 'bad' }, `Test failed: ${AI.explain(e)}`), h('span', { class: 'block muted' }, 'The diagnostics log below has the details.'));
  }
}

function logItem(e) {
  const meta = [e.ev && !e.ev.endsWith('.note') ? e.ev : null, e.op ? `op ${e.op}` : null, e.stage ? `stage ${e.stage}` : null, e.code ? e.code : null].filter(Boolean).join(' · ');
  return h(
    'li',
    { class: { error: 'bad', warn: 'warn', ok: 'ok' }[e.level] ?? '' },
    h('span', { class: 't' }, new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    h('span', null, `[${e.area}] ${e.msg}`, meta ? h('span', { class: 'block muted' }, meta) : null, e.detail ? h('span', { class: 'block muted' }, String(e.detail).split('\n').slice(0, 3).join(' · ')) : null),
  );
}


async function showAI(id) {
  document.title = 'On-device AI · Sparse';
  const [st, d] = await Promise.all([AI.states(), AI.diagnostics()]);
  if (id !== renderId) return;
  const dev = d.device;
  const entries = d.events;
  const interruption = AI.lastInterruption();
  const dl = AI.downloading();
  const shown = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.status]));
  const logList = h('ol', { class: 'log ai-log' }, entries.map(logItem));
  const copyNote = h('span', { class: 'small muted' });
  let errorsOnly = false;
  const filterBtn = h('button', { type: 'button', class: 'link' }, 'Errors and warnings only');
  filterBtn.addEventListener('click', async () => {
    errorsOnly = !errorsOnly;
    filterBtn.textContent = errorsOnly ? 'Show everything' : 'Errors and warnings only';
    fill(logList, (await AI.readLog(300)).filter((e) => !errorsOnly || e.level === 'error' || e.level === 'warn').map(logItem));
  });
  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      copyNote.textContent = ` Copied the ${what} (${AL.size(text.length)}).`;
    } catch {
      copyNote.textContent = ' Could not copy; shown below instead.';
      logList.before(h('pre', { class: 'report' }, text));
    }
  };
  const usable = AL.CHAT_IDS.filter((x) => AI.isReady(x) && AI.mayRun(x).ok);
  const gpuText = dev.gpu.gpu ? `WebGPU${dev.gpu.f16 ? ' with 16-bit floats' : ' without 16-bit floats'}${dev.gpu.fallback ? ' (software only)' : ''}` : 'no WebGPU';

  // one line of live status, redrawn when an operation starts, moves on or ends
  const live = h('p', { class: 'small' });
  const drawStatus = () => {
    const s = AI.status();
    const a = s.op.active;
    fill(
      live,
      a ? `Working: ${a.type}${a.label !== a.type ? ` (${a.label})` : ''}, ${a.stage}` : 'Idle',
      ' · in memory: ',
      s.loaded.length ? s.loaded.map((m) => AL.PACKAGES[m.id].short).join(', ') : 'nothing',
      s.loaded.length ? [' ', h('button', { type: 'button', class: 'link', onclick: async () => (await Promise.all(s.loaded.map((m) => AI.unload(m.id))), route()) }, 'Unload')] : null,
      s.gpuLost ? h('span', { class: 'bad' }, ' · The GPU was lost: use Reset AI engine below') : null,
      s.versionMismatch ? h('span', { class: 'bad' }, ' · The app is only partly updated: close it completely and open it again (twice)') : null,
    );
  };
  drawStatus();

  render(
    pageHead('On-device AI', usable.length ? h('a', { href: '#/ask' }, 'Ask') : null),
    h('p', { class: 'muted small' }, 'Optional AI that runs on this device, with no connection once downloaded. Nothing downloads until you tap Download. Use Wi-Fi and keep the app open.'),
    interruption
      ? (() => {
          const b = banner('warn', [h('strong', null, 'Last time: '), interruption.message], { onDismiss: () => AI.ackInterruption() });
          b.querySelector('.banner-text').append(h('details', null, h('summary', { class: 'small' }, 'Why this diagnosis'), h('ul', { class: 'small' }, interruption.reasons.map((r) => h('li', null, r)))));
          return b;
        })()
      : null,
    group(
      'Models',
      null,
      ['lfm350', 'lfm230', 'llama32', 'bge'].map((x) => pkgCard(x, dl?.id === x ? { ...st[x], status: 'downloading' } : st[x], dev)),
      h('p', { class: 'small muted' }, 'Each model also downloads a small engine to run it. Only one model is in memory at a time.'),
    ),
    group('Use', null,
      usable.length > 1
        ? h(
            'label',
            { class: 'field' },
            h('span', null, 'Model for summaries and answers'),
            (() => {
              const sel = h(
                'select',
                { onchange: () => (saveSetting('aiModel', sel.value), route()) },
                usable.map((x) => h('option', { value: x, selected: AI.chatModel(settings.aiModel) === x }, AL.PACKAGES[x].short)),
              );
              return sel;
            })(),
          )
        : null,
      h(
        'label',
        { class: 'field check' },
        (() => {
          const c = h('input', { type: 'checkbox', checked: settings.aiAutoSummary && AI.autoAllowed(), disabled: !AI.autoAllowed(), onchange: () => saveSetting('aiAutoSummary', c.checked) });
          return c;
        })(),
        h('span', null, 'Summarise pages automatically when they load'),
        h('small', { class: 'muted' }, 'Otherwise, tap Summarise on a page. Summaries are kept with the page.'),
      ),
      usable.length ? h('p', { class: 'small' }, h('a', { href: '#/ask' }, 'Ask a question'), ': from your saved pages and searches, or the model’s own knowledge.') : null,
    ),
    group('Status', null,
      live,
      h('p', { class: 'small muted' }, `${gpuText}${dev.storage ? ` · ${AL.size(dev.storage.usage)} of about ${AL.size(dev.storage.quota)} storage used by this app` : ''}`),
    ),
    fold('Log', false,
      h(
        'p',
        { class: 'small' },
        h('button', { type: 'button', class: 'link', onclick: async () => copy(await AI.report(), 'report') }, 'Copy report'),
        ' · ',
        h('button', { type: 'button', class: 'link', onclick: async () => copy(await AI.reportJson(), 'report as JSON') }, 'Copy as JSON'),
        ' · ',
        filterBtn,
        ' · ',
        twoTap('Clear log', () => AI.clearLog()),
        copyNote,
      ),
      entries.length ? logList : h('p', { class: 'small muted' }, 'Nothing logged yet.'),
      h('p', { class: 'small' }, h('button', { type: 'button', class: 'link', onclick: async () => (await AI.resetEngine(), route()) }, 'Reset AI engine'), ' (stops anything running and restarts it; downloaded models are kept)'),
    ),
    fold('Remove', false,
      h('p', { class: 'small' }, twoTap('Remove all AI data from this device', () => AI.removeAll())),
      h('p', { class: 'small muted' }, 'Deletes every model, the engines, the meaning index, summaries, questions and this log.'),
    ),
    h('p', { class: 'small muted' }, h('a', { href: '#/ai-lab' }, 'AI lab'), ' (experimental model tests)'),
  );
  aiUnsub = AI.on((type, data) => {
    if (currentPath() !== '/ai') return;
    if (type === 'log') logList.prepend(logItem(data));
    if (type === 'op' || type === 'loaded') setTimeout(drawStatus, 60); // the event fires just before the engine clears its active task
    if (type === 'safety') {
      clearTimeout(netPageTimer);
      netPageTimer = setTimeout(route, 300);
    }
    if (type === 'download' && !data.done) {
      const el = document.getElementById(`ai-status-${data.id}`);
      if (el)
        el.textContent = `Downloading ${Math.round((100 * data.have) / data.total)}% · ${AL.size(data.have)} of ${AL.size(data.total)}${data.rate ? ` · ${AL.size(data.rate)}/s` : ''}${data.eta ? ` · ${AL.eta(data.eta)} left` : ''}`;
      const prog = el?.nextElementSibling;
      if (prog?.tagName === 'PROGRESS') {
        prog.hidden = false;
        prog.value = data.have;
      }
    }
    if ((type === 'pkg' && (!data || shown[data.id] !== data.status)) || (type === 'download' && data.done)) {
      clearTimeout(netPageTimer);
      netPageTimer = setTimeout(route, 300);
    }
  });
  settle();
}

async function saveSetting(key, value) {
  settings = { ...settings, [key]: value };
  await S.kvSet('settings', settings);
  setNow(`Saved setting: ${key}`);
}

async function showSettings(id) {
  document.title = 'Settings · Sparse';
  const select = (key, options) => {
    const s = h(
      'select',
      { onchange: () => saveSetting(key, s.value) },
      Object.entries(options).map(([v, t]) => h('option', { value: v, selected: String(settings[key]) === v }, t)),
    );
    return s;
  };
  const check = (key) => {
    const c = h('input', { type: 'checkbox', checked: !!settings[key], onchange: () => saveSetting(key, c.checked) });
    return c;
  };
  const text = (key, placeholder) => {
    const t = h('input', {
      type: 'text',
      value: settings[key],
      placeholder,
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      onchange: () => saveSetting(key, t.value.trim()),
    });
    return t;
  };
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'muted' }, hint) : null);
  const checkField = (label, control, hint) =>
    h('label', { class: 'field check' }, control, h('span', null, label), hint ? h('small', { class: 'muted' }, hint) : null);
  const est = (await navigator.storage?.estimate?.().catch(() => null)) ?? null;
  if (id !== renderId) return;
  render(
    pageHead('Settings'),
    fold(
      'Search',
      true,
      field(
        'Search engine',
        select('engine', { mwmbl: 'Mwmbl (free)', marginalia: 'Marginalia (free, often busy)' }),
        'Searches always start with a free engine. Mojeek is never used automatically.',
      ),
      checkField('Try other engines when one fails or finds nothing', check('fallback')),
      checkField('Safe search', check('safe')),
      checkField('Instant answers (DuckDuckGo)', check('instant')),
      field('Region', select('region', L.REGIONS), 'Used by Mojeek and the DuckDuckGo button.'),
      field('Tapping a result opens', select('openIn', { reader: 'Reader view (light)', site: 'The website' })),
      field('DuckDuckGo button opens', select('ddg', { lite: 'DuckDuckGo Lite', html: 'DuckDuckGo HTML' })),
    ),
    fold(
      'Reading',
      false,
      checkField(
        'Read Wikipedia directly',
        check('wikipedia'),
        'Opens Wikipedia articles through Wikipedia’s own API: the opening section first (a few KB), and any other section only when you tap it, with tables intact. Turn off to use Jina Reader for everything.',
      ),
      field('Weather units', select('units', { auto: 'Automatic', c: '°C', f: '°F' })),
      field(
        'Weather card shows',
        select('weatherDetail', { basic: 'The basics (about 0.5 KB)', full: 'Everything (about 2 KB more)' }),
        'The basics are now, the next hour and 3 days. “More weather” on the card fetches hourly, 7-day and air quality when you want them.',
      ),
      field(
        'Reuse saved results for',
        (() => {
          const s = h(
            'select',
            { onchange: () => saveSetting('cacheHours', Number(s.value)) },
            [1, 6, 24, 168].map((n) =>
              h('option', { value: String(n), selected: settings.cacheHours === n }, n < 24 ? `${n} h` : n === 24 ? '1 day' : '1 week'),
            ),
          );
          return s;
        })(),
        'Repeat searches within this time load from the device with no data used.',
      ),
      checkField(
        'Show the activity log expanded',
        check('showActivity'),
        'Each screen lists every step and request as it happens. When this is off, the log starts collapsed and you can tap it to open it.',
      ),
    ),
    fold(
      'API keys',
      false,
      field(
        'Mojeek API key',
        text('mojeekKey', 'paste your key'),
        'From mojeek.com/services/search/web-search-api. Mojeek is paid, so it never runs automatically: with a key set, a “Try Mojeek” button appears with your results. The key stays on this device and is sent only to Mojeek.',
      ),
      field(
        'Marginalia API key',
        text('marginaliaKey', 'public'),
        '“public” is shared by everyone and is often busy. You can email Marginalia for your own key.',
      ),
      field(
        'Jina Reader API key',
        text('jinaKey', 'optional'),
        'Reader view works without a key, but Jina may refuse anonymous requests from some networks (401). A free key from jina.ai fixes that and raises the limit to 200 pages a minute. Stays on this device and is sent only to Jina.',
      ),
    ),
    group(
      'On-device AI',
      h('a', { class: 'small', href: '#/ai' }, 'Open'),
      h(
        'p',
        { class: 'small' },
        AL.MODEL_IDS.some((x) => AI.isReady(x))
          ? `On this device: ${AL.MODEL_IDS.filter((x) => AI.isReady(x))
              .map((x) => AL.PACKAGES[x].short)
              .join(', ')}.`
          : 'Off: nothing is downloaded until you choose a model.',
      ),
      h('p', { class: 'muted small' }, 'Summaries, answers from saved pages, downloads and diagnostics.'),
    ),
    fold(
      'Storage',
      false,
      h('p', { class: 'small' }, est ? `About ${B(est.usage)} used on this device.` : 'Storage use is not available.'),
      h(
        'p',
        null,
        twoTap('Clear cached results and pages (keeps saved pages)', async () => {
          await S.clear('results');
          for (const [k, v] of await S.entries('pages')) if (!v.saved) await S.del('pages', k);
        }),
      ),
      h(
        'p',
        null,
        twoTap('Clear recent searches and the queue', async () => {
          await S.kvSet('history', []);
          await S.kvSet('queue', []);
          await S.kvSet('ready', []);
        }),
      ),
    ),
    fold(
      'Who sees what',
      false,
      h(
        'ul',
        { class: 'small' },
        h('li', null, 'Searches go to the engine you chose (Marginalia, Mwmbl or Mojeek), and to DuckDuckGo when instant answers are on.'),
        h('li', null, 'Pages you open in reader view are fetched by Jina Reader (r.jina.ai), which sees their addresses. It allows 20 pages a minute.'),
        h('li', null, 'Weather comes from Open-Meteo, which sees the place, or your coordinates for plain “weather”.'),
        h('li', null, 'Wikipedia articles are fetched from Wikipedia itself (not Jina), which sees the article titles you open.'),
        h('li', null, 'Searches like “coffee near me” send your coordinates (or the place you named) to OpenStreetMap’s Overpass servers, and to Nominatim if they fail. Exchange rates come from Frankfurter and carry no personal data; unit conversions never leave the device.'),
        h('li', null, 'On-device AI, if you turn it on: models download once from Hugging Face, and the engine from jsDelivr. After that, summaries and answers are worked out on this device and nothing you read or ask is sent anywhere.'),
        h('li', null, 'The speed test on the Network page downloads from Cloudflare (which sees your IP address) and from this app’s own host. Only when you tap it.'),
        h('li', null, 'History, saved results and pages stay on this device.'),
      ),
    ),
    h('p', { class: 'version' }, `Sparse v${APP_VERSION} · `, h('a', { href: '#/net' }, 'Network details')),
  );
  settle();
}

// ---------- routing and startup ----------

function currentPath() {
  return location.hash.replace(/^#/, '').split('?')[0] || '/';
}

function route() {
  const id = ++renderId;
  closeMenu();
  aiUnsub?.();
  aiUnsub = null;
  AI.stop('left the screen', String(id - 1)); // a reply for a screen that's gone: stop it and drop its waiting tasks
  const p = new URLSearchParams(location.hash.split('?')[1] ?? '');
  switch (currentPath()) {
    case '/s':
      return showSearch(id, p.get('q') ?? '', Math.max(1, Number(p.get('p')) || 1), p.get('e') ?? '');
    case '/r':
      return showRead(id, p.get('u') ?? '');
    case '/net':
      return showNet(id);
    case '/settings':
      return showSettings(id);
    case '/ai':
      return showAI(id);
    case '/ask':
      return showAsk(id, p.get('q') ?? '');
    case '/ai-lab': // experimental model tests; separate from the app's AI
      return import('./ai-lab.js').then((m) => id === renderId && m.showLab(main, APP_VERSION));
    default:
      return showHome(id);
  }
}

function updateOnline() {
  document.getElementById('offline').hidden = navigator.onLine;
  setNow(navigator.onLine ? 'Back online' : 'Offline: showing what is saved on this device');
}

async function start() {
  history.scrollRestoration = 'manual';
  [settings, netLog, netTotals] = await Promise.all([
    S.kvGet('settings', {}).then((s) => {
      const merged = { ...DEFAULTS, ...s };
      if (!L.FREE_ENGINE_IDS.includes(merged.engine)) merged.engine = DEFAULTS.engine; // the paid engine is never the default
      return merged;
    }),
    S.kvGet('netlog', []),
    S.kvGet('nettotals', null).then((t) => t ?? emptyTotals()),
  ]);
  initNav();
  initMenu();
  addEventListener('hashchange', (e) => {
    scrollPos.set(new URL(e.oldURL).hash, window.scrollY);
    trackHistory();
    route();
  });
  addEventListener('online', () => {
    updateOnline();
    drainQueue();
  });
  addEventListener('offline', updateOnline);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && drainQueue());
  document.getElementById('offline').hidden = navigator.onLine;
  updateTotals();
  setNow(navigator.onLine ? 'Ready' : 'Offline: showing what is saved on this device');
  await AI.init().catch((e) => console.warn('AI init failed', e));
  AI.on((type, d) => {
    if (type !== 'download') return;
    const name = AL.PACKAGES[d.id]?.short ?? d.id;
    if (d.done) setNow(d.status === 'ready' ? `AI download: ${name} is on this device` : `AI download: ${name} ${d.status}${d.why ? `: ${d.why}` : ''}`);
    else setNow(`AI download: ${name} ${Math.round((100 * d.have) / d.total)}% · ${AL.size(d.rate)}/s`);
  });
  route();
  navigator.storage?.persist?.().catch(() => {});
  setTimeout(() => {
    S.evict().catch(() => {});
    drainQueue();
    document.getElementById('appload')?.replaceChildren(appLoadText()); // complete only after the load event
  }, 1500);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();

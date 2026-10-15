// Sparse: a small search PWA with no server of its own. Routes live in the URL hash:
//   #/            home: search box, queue, recent searches, saved pages, data use
//   #/s?q=&p=&e=  results (q = query, p = page, e = engine)
//   #/r?u=        reader view of a page, through Jina Reader
//   #/net         network details: every request, totals per service, how the app loaded
//   #/settings
//   #/ai          on-device AI: downloads, device checks, diagnostics (all opt-in)
//   #/ask?q=      ask the on-device AI, from saved pages and searches or on its own
// Every screen narrates what it is doing in an activity log, and every request is measured (net.js).
import * as L from './lib.js';
import * as N from './net.js';
import * as S from './store.js';
import * as AI from './ai.js';
import * as AL from './ai-lib.js';
import * as SEL from './ai-select.js';

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
  showActivity: true,
  weatherDetail: 'basic',
  aiModel: 'lfm350',
  aiAutoSummary: false,
  aiPromptLimit: null, // null = the model's own limit; a number can only lower it (ai-policy.js), or raise it in developer mode
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
    placeholder: 'Search',
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

const topbar = (q) => h('header', { class: 'bar' }, h('a', { href: '#/', class: 'brand' }, 'Sparse'), searchForm(q));

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

async function showHome(id) {
  document.title = 'Sparse';
  const [history, queue, ready, pages] = await Promise.all([S.kvGet('history', []), S.kvGet('queue', []), S.kvGet('ready', []), S.entries('pages')]);
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
  render(
    h(
      'header',
      { class: 'bar' },
      h('span', { class: 'brand' }, 'Sparse'),
      h(
        'nav',
        { class: 'links' },
        AL.MODEL_IDS.some((x) => AI.isReady(x) && x !== 'engine') ? h('a', { href: '#/ask' }, 'Ask') : null,
        h('a', { href: '#/net' }, 'Network'),
        h('a', { href: '#/settings' }, 'Settings'),
      ),
    ),
    searchForm(),
    AI.lastInterruption() ? h('p', { class: `small ${AI.lastInterruption().quarantine ? 'bad' : 'warn'}` }, AI.lastInterruption().message, ' ', h('a', { href: '#/ai' }, 'AI diagnostics')) : null,
    h(
      'p',
      { class: 'muted small' },
      engine
        ? `${L.ENGINES[engine].name}${settings.fallback ? ', with free fallback' : ''}${L.canTryMojeek(settings) ? ', Mojeek on request' : ''} · `
        : 'No engine set · ',
      'add ',
      h('code', null, '!bang'),
      ' to search on DuckDuckGo',
    ),
    h(
      'section',
      { class: 'data' },
      h('p', { class: 'small', id: 'appload' }, appLoadText()),
      h('p', { class: 'small' }, `This session: ${amount({ ...s, estimated: true })}${s.errors ? `, ${plural(s.errors, 'failure')}` : ''}.`),
      netTotals.requests
        ? h(
            'p',
            { class: 'small' },
            `Since ${new Date(netTotals.since).toLocaleDateString()}: ${amount({ ...netTotals, estimated: true })}. `,
            h('a', { href: '#/net' }, 'Details'),
          )
        : null,
    ),
    queue.length > 0 &&
      h(
        'section',
        null,
        h('h2', null, 'Waiting for a connection'),
        h(
          'ul',
          { class: 'plain' },
          queue.map((x) => h('li', null, x.kind === 'search' ? x.q : x.url, h('span', { class: 'muted small' }, ` · queued ${L.relTime(x.at)}`))),
        ),
      ),
    ready.length > 0 &&
      h(
        'section',
        null,
        h('h2', null, 'Ready'),
        h(
          'ul',
          { class: 'plain' },
          ready.map((x) => h('li', null, itemLink(x), h('span', { class: 'muted small' }, x.error ? ` · ${x.error}` : ` · fetched ${L.relTime(x.doneAt)}`))),
        ),
      ),
    history.length > 0 &&
      h(
        'section',
        null,
        h('h2', null, 'Recent'),
        h(
          'ul',
          { class: 'plain' },
          history.map((x) => h('li', null, h('a', { href: hashFor('/s', { q: x.q }) }, x.q), h('span', { class: 'muted small' }, ` · ${L.relTime(x.at)}`))),
        ),
        twoTap('Clear recent searches', () => S.kvSet('history', [])),
      ),
    saved.length > 0 &&
      h(
        'section',
        null,
        h('h2', null, 'Saved pages'),
        h(
          'ul',
          { class: 'plain' },
          saved.map((p) =>
            h(
              'li',
              null,
              h('a', { href: hashFor('/r', { u: p.url }) }, p.title),
              h('span', { class: 'muted small' }, ` · ${L.hostOf(p.url)} · ${B(new Blob([p.markdown]).size)} on device`),
            ),
          ),
        ),
      ),
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

  const weather = page === 1 ? L.weatherIntent(q) : null;
  const weatherDone = weather ? showWeather(cards, weather.place, id, act) : null;

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

function here() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('location is not available; try “weather <town>”'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'Your location' }),
      () => reject(new Error('location is not available; try “weather <town>”')),
      { maximumAge: 10 * MIN, timeout: 15000 },
    );
  });
}

/** Sums the requests behind one card, so it can say what it cost. */
function netCounter(act) {
  const net = { requests: 0, received: 0, wire: 0, estimated: false };
  const get = async (url) => {
    const r = await act.fetch(url);
    net.requests++;
    net.received += r.entry.received;
    net.wire += r.entry.wire ?? r.entry.received;
    if (r.entry.wireKind !== 'exact') net.estimated = true;
    return r.json();
  };
  return { net, get };
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
      maxPrompt: settings.aiPromptLimit,
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
  const lim = AI.limitsFor(pkg, settings.aiPromptLimit);
  const title = rec.title.slice(0, 80);
  const plan = SEL.planSummary(rec.markdown, { perCallChars: AL.textBudget(lim.maxInput, 110), maxParts: AI.lowMemory() ? 2 : 4 });
  act.step(
    `${auto ? 'Summarising automatically (Settings)' : 'Summarising'} with ${spec.short} on this device: ${plan.strategy === 'single' ? 'the whole page' : plan.note} · ${plan.calls === 1 ? '1 pass' : `${plan.calls} passes`}. Nothing is sent anywhere.`,
  );
  const summaryTokens = Math.min(lim.maxNew, 160);
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

async function showRead(id, raw, reload = false) {
  const url = L.safeHttpUrl(raw);
  const arch = url ? L.parseWaybackUrl(url) : null;
  const host = arch ? `${L.hostOf(arch.original)} (archived ${formatDate(arch.at)})` : url ? L.hostOf(url) : '';
  const act = activity(`Opening ${host || 'page'}…`);
  const status = h('div', { class: 'status' });
  const article = h('article', { class: 'reader' });
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
    const save = h('button', { type: 'button', class: 'link' }, rec.saved ? 'Saved ✓' : 'Save for offline');
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
    const sumBtn = AI.anyChat(settings.aiModel) ? h('button', { type: 'button', class: 'link', onclick: () => summarise(rec, url, summary, act, id, { redo: !summary.hidden }) }, 'Summarise') : null;
    const archived = h('button', { type: 'button', class: 'link' }, 'Archived copy');
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
        { class: 'actions small' },
        arch
          ? [external(arch.original, 'Open live page ↗'), ' · ', external(L.waybackViewUrl(arch.ts, arch.original), 'Open in the archive ↗')]
          : [external(url, 'Open original ↗'), ' · ', archived],
        ' · ',
        save,
        sumBtn ? [' · ', sumBtn] : null,
        rec.published ? h('span', { class: 'muted' }, ` · ${formatDate(rec.published)}`) : null,
      ),
      box,
      summary,
      blocks.length
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

async function showNet(id) {
  document.title = 'Network · Sparse';
  const [est, results, pages] = await Promise.all([navigator.storage?.estimate?.().catch(() => null) ?? null, S.entries('results'), S.entries('pages')]);
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
    h('header', { class: 'bar' }, h('a', { href: '#/', class: 'brand' }, 'Sparse'), h('span', { class: 'muted' }, 'Network')),
    h(
      'section',
      null,
      h('h2', null, 'Connection'),
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
    h(
      'section',
      null,
      h('h2', null, 'This session'),
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
    h(
      'section',
      null,
      h('h2', null, `By service, since ${new Date(netTotals.since).toLocaleDateString()}`),
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
    h(
      'section',
      null,
      h('h2', null, 'Screen'),
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
    h(
      'section',
      null,
      h('h2', null, 'App files on this launch'),
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
    h(
      'section',
      null,
      h('h2', null, 'Stored on this device'),
      h(
        'table',
        { class: 'kv' },
        row('Saved searches and forecasts', `${results.length} (${B(results.reduce((n, [, v]) => n + jsonSize(v), 0))})`),
        row('Pages', `${pages.length}, ${pages.filter(([, p]) => p.saved).length} kept (${B(pages.reduce((n, [, v]) => n + jsonSize(v), 0))})`),
        row('Total storage used', est ? B(est.usage) : 'not available'),
      ),
    ),
    h(
      'section',
      null,
      h('h2', null, `Recent requests (${netLog.length})`),
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
    h(
      'section',
      null,
      h('h2', null, 'How this is measured'),
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
        const lim = use ? AI.limitsFor(use, settings.aiPromptLimit) : null;
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
        fill(status, found.all.length ? 'Nothing saved on this device matches the question.' : 'Nothing is saved on this device yet: search, or open pages in the reader, and they become answerable here.');
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
    const r = await runModel(use, messages, { out: answer, status, act, id, maxTokens: 128, label: mode.value === 'saved' ? 'answer from saved' : 'general answer', sources, fit: mode.value === 'saved', alive, meta: { sources: sources?.length ?? 0 } });
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
    h('header', { class: 'bar' }, h('a', { href: '#/', class: 'brand' }, 'Sparse'), h('span', { class: 'muted' }, 'Ask'), h('a', { href: '#/ai' }, 'AI settings')),
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
      h(
        'section',
        null,
        h('h2', null, 'Earlier questions'),
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
  const variant = rec.dtype || spec.kind === 'engine' ? rec : AL.pickVariant(spec, AI.usableGpu(dev));
  const total = AL.totalSize(AL.filesFor(spec, variant.dtype));
  const prof = spec.kind === 'engine' ? null : AI.profile(id);
  const noVariant = spec.kind !== 'engine' && !variant.dtype;
  // a model the safety profile does not allow on this kind of device is not offered for download
  const blockedHere = !!prof && (prof.status === 'unsupported' || (!!variant.device && !prof.backends?.includes(variant.device)));
  const unsupported = noVariant || blockedHere;
  const where = spec.kind === 'engine' || unsupported ? '' : `${variant.dtype} on ${variant.device === 'webgpu' ? 'WebGPU' : 'the CPU'}`;
  const prog = h('progress', { max: total, value: rec.have ?? 0, hidden: !['downloading', 'paused', 'queued'].includes(rec.status) });
  const line = h('p', { class: 'small', id: `ai-status-${id}` });
  const statusText = {
    none: unsupported ? 'Not available on this device' : `Not on this device · ${AL.size(total)}${where ? ` (${where})` : ''}`,
    queued: 'Waiting to download…',
    downloading: `Downloading · ${AL.size(rec.have ?? 0)} of ${AL.size(total)}`,
    paused: `Paused at ${AL.size(rec.have ?? 0)} of ${AL.size(total)}${rec.reason ? `: ${rec.reason}` : ''}`,
    failed: `Download failed: ${rec.error}`,
    ready: `On this device · ${AL.size(total)}${where ? ` · ${where}` : ''}${rec.readyAt ? ` · downloaded ${L.relTime(rec.readyAt)}` : ''}`,
  }[rec.status];
  fill(line, rec.status === 'failed' ? h('span', { class: 'bad' }, statusText) : statusText);
  const button = (label, fn, cls = 'button small') => h('button', { type: 'button', class: cls, onclick: fn }, label);
  const testOut = h('div', { class: 'small' });
  const buttons = [];
  const notes = [];
  if (spec.kind !== 'engine') {
    if ((rec.status === 'none' || rec.status === 'failed') && !unsupported) buttons.push(button(`Download ${AL.size(total - (rec.have ?? 0))}`, () => AI.download(id)));
    if (rec.status === 'paused') buttons.push(button('Resume', () => AI.download(id)));
    if (rec.status === 'queued' || rec.status === 'downloading') buttons.push(button('Pause', () => AI.pause(id), 'button secondary small'));
    if (rec.status === 'ready' && AI.mayRun(id).ok) buttons.push(button('Test', () => testModel(id, testOut), 'button secondary small'));
    else if (rec.status === 'ready') notes.push(h('p', { class: 'small warn' }, `Not running: ${AI.mayRun(id).why}`));
    if (rec.status !== 'none') buttons.push(twoTap(rec.status === 'ready' ? `Remove (frees ${AL.size(total)})` : 'Cancel and delete', () => AI.remove(id)));
  }
  if (rec.crashes) notes.push(h('p', { class: 'small bad' }, `The app was interrupted unexpectedly ${plural(rec.crashes, 'time')} while using this model${rec.lastCrash ? `, last ${L.relTime(rec.lastCrash.found)} (at "${rec.lastCrash.stage ?? '?'}")` : ''}. iOS does not say why; the diagnostics below show what was recorded.`));
  if (rec.lastLoad) notes.push(h('p', { class: 'small muted' }, `Last loaded in ${T(rec.lastLoad.ms)} (${rec.lastLoad.where}, ${rec.lastLoad.mode === 'page' ? 'on the page' : 'in a worker'}), ${L.relTime(rec.lastLoad.at)}`));
  if (rec.lastRun) notes.push(h('p', { class: 'small muted' }, `Last run (${rec.lastRun.label}): ${AL.describeRun(rec.lastRun)}, ${L.relTime(rec.lastRun.at)}`));
  if (rec.lastError) notes.push(h('p', { class: 'small bad' }, `Last error (${rec.lastError.phase}, ${L.relTime(rec.lastError.at)}): ${rec.lastError.message}`));
  if (blockedHere) notes.push(h('p', { class: 'small bad' }, prof.why ?? `Not qualified to run on ${variant.device === 'webgpu' ? 'WebGPU' : 'the CPU'} on this kind of device (${AI.deviceClassName()}), so it is not offered for download. Saved pages can still be searched.`));
  else if (noVariant) notes.push(h('p', { class: 'small bad' }, `Needs WebGPU, which this browser doesn't offer${dev.gpu.fallback ? ' (only a software version)' : ''}, so it can't run here.`));
  else if (spec.kind === 'chat' && rec.device !== 'webgpu' && !AI.usableGpu(dev))
    notes.push(h('p', { class: 'small warn' }, `No usable WebGPU here${dev.gpu.fallback ? ' (only a software version)' : ''}, so it runs on the CPU with larger 8-bit weights: expect it to be slow.`));
  if (prof && spec.kind === 'chat' && !blockedHere) {
    notes.push(
      h(
        'p',
        { class: 'small muted' },
        `${prof.status === 'experimental' ? 'Experimental' : 'Conservative limits, not yet proven on a real device'} on this device (${AI.deviceClassName()}): prompt up to ${prof.maxInput} tokens, answer up to ${prof.maxNew}, together up to ${prof.maxTotal}, at most ${Math.round(prof.maxMs / 1000)} s. `,
        spec.graph.lastTokenLogits ? 'Scores only the last prompt position (read from the model file).' : 'Scores every prompt position, so long prompts cost extra memory (read from the model file).',
      ),
    );
    if (prof.status === 'experimental') {
      const c = h('input', {
        type: 'checkbox',
        checked: AI.optedIn(id),
        onchange: () => {
          AI.setOptIn(id, c.checked);
          route();
        },
      });
      notes.push(h('label', { class: 'field check' }, c, h('span', null, 'Allow this experimental model to run on this device'), h('small', { class: 'muted' }, 'It uses more memory. If iOS ends the app while it runs, it is switched off again.')));
    }
  }
  for (const q of AI.quarantined().filter((x) => x.key.startsWith(`${id}@`)))
    notes.push(
      h(
        'p',
        { class: 'small bad' },
        `Switched off ${L.relTime(q.at)}: the app was interrupted unexpectedly while it ran (${q.category.toLowerCase().replaceAll('_', ' ')}, ${q.confidence} confidence). `,
        AI.getDev()
          ? h('button', { type: 'button', class: 'link', onclick: () => (AI.retest(q.key), route()) }, 'Allow a retest')
          : 'Turn on developer testing mode below to retest it.',
      ),
    );
  return h(
    'div',
    { class: `card pkg${spec.kind === 'engine' ? ' engine' : ''}` },
    h('h3', null, spec.name),
    h('p', { class: 'small muted' }, spec.role, spec.license ? ` License: ${spec.license}.` : ''),
    line,
    prog,
    buttons.length ? h('p', { class: 'pkg-actions' }, buttons.flatMap((b, i) => (i ? [' ', b] : [b]))) : null,
    notes,
    testOut,
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

const kvRows = (rows) => rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v == null ? '–' : v)));
const secs = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

async function showAI(id) {
  document.title = 'On-device AI · Sparse';
  const [st, d] = await Promise.all([AI.states(), AI.diagnostics()]);
  if (id !== renderId) return;
  const dev = d.device;
  const entries = d.events;
  const interruption = AI.lastInterruption();
  const loaded = AI.loadedModels();
  const dl = AI.downloading();
  const shown = Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.status]));
  const logList = h('ol', { class: 'log ai-log' }, entries.map(logItem));
  let errorsOnly = false;
  const filterBtn = h('button', { type: 'button', class: 'link' }, 'Errors and warnings only');
  filterBtn.addEventListener('click', async () => {
    errorsOnly = !errorsOnly;
    filterBtn.textContent = errorsOnly ? 'Show everything' : 'Errors and warnings only';
    fill(logList, (await AI.readLog(300)).filter((e) => !errorsOnly || e.level === 'error' || e.level === 'warn').map(logItem));
  });
  const copyNote = h('span', { class: 'small muted' });
  const g = dev.gpu;
  const yes = (v) => (v ? 'yes' : 'no');
  const rows = [
    ['Kind of device', `${AI.deviceClassName()}${AI.lowMemory() ? ' (low-memory limits apply)' : ''}`],
    ['WebGPU on the page', g.gpu ? `yes · ${g.adapter}${g.fallback ? ' (software fallback)' : ''}` : `no${g.why ? ` (${g.why})` : ''}`],
    ['16-bit floats (shader-f16)', g.gpu ? yes(g.f16) : '–'],
    ['Largest GPU buffer', g.limits ? `${AL.size(g.limits.maxBufferSize)} (binding ${AL.size(g.limits.maxStorageBufferBindingSize)})` : '–'],
    ['WebGPU in a worker', dev.worker ? (dev.worker.gpu ? 'yes' : `no${dev.worker.why ? ` (${dev.worker.why})` : ''}`) : 'checked when a model first loads'],
    ['Engine running', AI.engineMode() ? (AI.engineMode() === 'worker' ? 'in a worker' : 'on the page') : 'not started'],
    ['Storage', dev.storage ? `${AL.size(dev.storage.usage)} used of about ${AL.size(dev.storage.quota)} this app may use` : 'not reported'],
    ['Storage permanent', dev.persisted == null ? 'not reported' : yes(dev.persisted)],
    ['Installed to the home screen', yes(dev.standalone)],
    ['CPU cores', dev.cores ?? 'not reported'],
    ['Memory', dev.memory ? `about ${dev.memory} GB (the browser’s rough figure)` : 'not reported (Safari never says)'],
    ['App build', AL.AI_BUILD],
    ['Browser', dev.ua],
  ];

  // current status: redrawn whenever an operation starts, moves on or ends
  const statusBox = h('table', { class: 'kv' });
  const drawStatus = () => {
    const s = AI.status();
    const a = s.op.active;
    fill(
      statusBox,
      kvRows([
        ['State', `${s.op.state}${s.op.failed ? ` (${s.op.failed.code})` : ''}`],
        ['Doing now', a ? `${a.type}${a.label !== a.type ? ` (${a.label})` : ''}, stage “${a.stage}”` : 'nothing'],
        ['Waiting', s.op.queue.length ? `${s.op.queue.length}: ${s.op.queue.map((q) => q.type).join(', ')}` : 'nothing'],
        ['Engine', `${s.worker.mode ?? 'not started'} · ${s.worker.state} (started ${s.worker.starts}×, restarted ${s.worker.resets}×)`],
        ['In memory', s.loaded.length ? s.loaded.map((m) => `${AL.PACKAGES[m.id].short}: ${m.dtype} on ${m.device === 'webgpu' ? 'WebGPU' : 'the CPU'}`).join(', ') : 'nothing'],
        ['Health', s.gpuLost ? 'The GPU was lost: reset the engine below' : s.versionMismatch ? 'The app is only partly updated: close it completely and open it again (twice)' : 'OK'],
        ['Switched off for safety', s.quarantine.length ? `${s.quarantine.length}: ${s.quarantine.map((q) => AL.PACKAGES[q.key.split('@')[0]]?.short ?? q.key).join(', ')}` : 'none'],
      ]),
    );
  };
  drawStatus();

  const li = d.lastInference;
  const lastBox = li
    ? h('table', { class: 'kv' }, kvRows([
        ['Result', `${li.status}${li.m?.stopReason ? ` (${li.m.stopReason})` : ''} · ${AL.PACKAGES[li.pkg]?.short ?? li.pkg} ${li.dtype ?? ''}/${li.backend ?? ''}, ${li.m?.label ?? ''}, ${L.relTime(li.t)}`],
        ['Prompt → answer', `${li.m?.promptTokens ?? li.m?.inputTokens ?? '?'} → ${li.m?.tokens ?? '?'} tokens (asked for up to ${li.m?.requestedNew ?? '?'}, allowed ${li.m?.maxNew ?? '?'})`],
        ['First token', secs(li.m?.ttft)],
        ['Writing speed', li.m?.tps ? `${li.m.tps} tokens/s` : '–'],
        ['Total', secs(li.m?.ms)],
        ['Waited in queue', secs(li.m?.queueMs)],
        ['Scores computed for', li.m?.lastTokenLogits == null ? '–' : li.m.lastTokenLogits ? 'the last prompt position only' : 'every prompt position'],
      ]))
    : h('p', { class: 'small muted' }, 'Nothing has run since the app opened.');

  const p = d.performance;
  const perfBox = h('table', { class: 'kv' }, kvRows([
    ['Runs this session', p.runs],
    ['Median time to first token', secs(p.medianTtftMs)],
    ['Median writing speed', p.medianTokensPerSec ? `${p.medianTokensPerSec.toFixed(1)} tokens/s` : '–'],
    ['Median run', secs(p.medianRunMs)],
    ['Model loads · median', `${p.loads} · ${secs(p.medianLoadMs)}`],
    ['Searches of saved pages · median', `${p.retrievals} · ${secs(p.medianRetrievalMs)}`],
    ['Failures', p.failures ? `${p.failures} (${Object.entries(p.failuresByCode).map(([k, v]) => `${k} ${v}`).join(', ')})` : 'none'],
  ]));

  const failures = entries.filter((e) => e.level === 'error' && (e.code || e.ev?.includes('failed'))).slice(0, 8);
  const recovery = entries.filter((e) => ['ai.worker.reset', 'ai.quarantine.added', 'ai.quarantine.released', 'ai.worker.unresponsive', 'ai.memory.idle_unload', 'ai.recovery.interrupted'].includes(e.ev)).slice(0, 6);
  const detailBox = h('input', { type: 'checkbox' });
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

  render(
    h('header', { class: 'bar' }, h('a', { href: '#/', class: 'brand' }, 'Sparse'), h('span', { class: 'muted' }, 'On-device AI'), AL.MODEL_IDS.some((x) => AI.isReady(x)) ? h('a', { href: '#/ask' }, 'Ask') : null),
    h(
      'section',
      null,
      h('p', null, 'Optional AI that runs on this device: it summarises pages and answers questions from your saved pages and searches, or on its own, with no connection. Nothing downloads until you tap Download, and the browser works fully without it.'),
      h(
        'ul',
        { class: 'small' },
        h('li', null, 'Models come from Hugging Face and the engine from jsDelivr, once. After that, nothing you read or ask leaves the device.'),
        h('li', null, 'Use Wi-Fi and keep the app open: the screen stays on while it downloads. If the download is interrupted, it carries on from where it stopped.'),
        h('li', null, 'Phones limit how much memory a web app may use, and iOS can end the app without saying why. So each model has hard size limits here, one task runs at a time, and a model that was interrupted unexpectedly is switched off until you retest it.'),
      ),
    ),
    interruption
      ? h(
          'div',
          { class: 'card warn-card' },
          h('p', null, h('strong', null, 'Last time: '), interruption.message),
          h('p', { class: 'small muted' }, `Diagnosis: ${interruption.category.toLowerCase().replaceAll('_', ' ')} (${interruption.confidence} confidence). ${interruption.quarantine ? 'That model was switched off; saved pages and summaries are untouched. ' : ''}`, h('button', { type: 'button', class: 'link', onclick: () => (AI.ackInterruption(), route()) }, 'Dismiss')),
          h('details', null, h('summary', { class: 'small' }, 'Why this diagnosis'), h('ul', { class: 'small' }, interruption.reasons.map((r) => h('li', null, r)))),
        )
      : null,
    h('h2', null, 'Status now'),
    statusBox,
    h('h2', null, 'Models'),
    ['lfm350', 'lfm230', 'bge', 'lfm12', 'lfm26', 'engine'].map((x) => pkgCard(x, dl?.id === x ? { ...st[x], status: 'downloading' } : st[x], dev)),
    h(
      'section',
      null,
      h('h2', null, 'Use'),
      usable.length > 1
        ? h(
            'label',
            { class: 'field' },
            h('span', null, 'Model for summaries and answers'),
            (() => {
              const s = h(
                'select',
                { onchange: () => (saveSetting('aiModel', s.value), route()) },
                usable.map((x) => h('option', { value: x, selected: AI.chatModel(settings.aiModel) === x }, AL.PACKAGES[x].short)),
              );
              return s;
            })(),
          )
        : null,
      (() => {
        const use = AI.chatModel(settings.aiModel) ?? usable[0];
        if (!use) return h('p', { class: 'small muted' }, 'Download a model above to choose how long prompts may be.');
        const cap = AI.limitsFor(use, null).maxInput;
        const current = settings.aiPromptLimit ? Math.min(settings.aiPromptLimit, AI.getDev() ? 2000 : cap) : cap;
        const s = h(
          'select',
          { onchange: () => (saveSetting('aiPromptChosen', true), saveSetting('aiPromptLimit', Number(s.value))) },
          AI.limitChoices(use).map((n) => h('option', { value: String(n), selected: current === n }, `${n} tokens (about ${AL.textBudget(n).toLocaleString()} characters of text)${n === cap ? ' · this model’s limit' : ''}`)),
        );
        return h(
          'label',
          { class: 'field' },
          h('span', null, 'Longest prompt'),
          s,
          h('small', { class: 'muted' }, `Longer prompts need more memory. You can lower this, but not raise it above ${cap} tokens, the limit for ${AL.PACKAGES[use].short} on this device. Pages are summarised from sentences picked across the whole page; answers use this much saved text.`),
        );
      })(),
      h(
        'label',
        { class: 'field check' },
        (() => {
          const c = h('input', { type: 'checkbox', checked: settings.aiAutoSummary && AI.autoAllowed(), disabled: !AI.autoAllowed(), onchange: () => saveSetting('aiAutoSummary', c.checked) });
          return c;
        })(),
        h('span', null, 'Summarise pages automatically when they load'),
        h('small', { class: 'muted' }, AI.autoAllowed() ? 'Otherwise, tap Summarise on a page. Either way, summaries are kept with the page.' : 'Off while a model is switched off for safety, or the engine needs attention.'),
      ),
      h('p', { class: 'small' }, h('a', { href: '#/ask' }, 'Ask a question'), ': from your saved pages and searches, or the model’s own knowledge.'),
    ),
    h('section', null, h('h2', null, 'Last inference'), lastBox),
    h('section', null, h('h2', null, 'Performance'), perfBox),
    h(
      'section',
      null,
      h('h2', null, 'Recent failures'),
      failures.length
        ? h(
            'ul',
            { class: 'plain small' },
            failures.map((e) => h('li', { class: 'bad' }, `${new Date(e.t).toLocaleString()} · ${AL.PACKAGES[e.pkg]?.short ?? e.pkg ?? '–'} · stage ${e.stage ?? '–'} · ${e.code ?? 'error'}`, h('span', { class: 'block muted' }, e.msg))),
          )
        : h('p', { class: 'small muted' }, 'None recorded.'),
      recovery.length ? h('details', null, h('summary', { class: 'small' }, 'Recovery actions taken'), h('ul', { class: 'plain small' }, recovery.map((e) => h('li', null, `${new Date(e.t).toLocaleString()} · ${e.msg}`)))) : null,
    ),
    h(
      'section',
      null,
      h('h2', null, 'In memory now'),
      loaded.size
        ? h(
            'ul',
            { class: 'plain small' },
            [...loaded].map(([k, info]) =>
              h('li', null, `${AL.PACKAGES[k].short}: ${info.dtype} on ${info.device === 'webgpu' ? 'WebGPU' : 'the CPU'}, loaded in ${T(info.ms)} `, h('button', { type: 'button', class: 'link', onclick: async () => (await AI.unload(k), route()) }, 'Unload')),
            ),
          )
        : h('p', { class: 'small muted' }, 'Nothing. One model is in memory at a time, loaded when first used and released after a short while unused (2 minutes on a phone).'),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Safety'),
      h('table', { class: 'kv' }, AI.profileTable().map((r) => h('tr', null, h('th', null, AL.PACKAGES[r.id].short), h('td', null, r.status === 'unsupported' ? `Not supported here: ${r.why}` : `${r.status}${r.maxInput ? ` · prompt ≤ ${r.maxInput}, answer ≤ ${r.maxNew}, total ≤ ${r.maxTotal} tokens` : ` · batches of ${r.maxBatch}, ≤ ${r.maxPerRun} passages per question`}${r.blockedBy ? ` · blocked: ${r.blockedBy}` : ''}`)))),
      h('p', { class: 'small muted' }, 'Expected memory use (estimates from the tensor shapes in the model files; Safari does not report real memory):'),
      h('ul', { class: 'plain small' }, d.estimates.map((x) => h('li', null, x))),
      (() => {
        const c = h('input', {
          type: 'checkbox',
          checked: AI.getDev(),
          onchange: () => {
            AI.setDev(c.checked);
            route();
          },
        });
        return h('label', { class: 'field check' }, c, h('span', null, 'Developer testing mode'), h('small', { class: 'muted' }, 'For testing only: allows longer prompts and retesting a switched-off model. Larger prompts can make iOS end the app. Ordinary use never needs it.'));
      })(),
      AI.getDev() ? h('p', { class: 'small' }, twoTap('Clear run history', () => AI.clearHistory())) : null,
    ),
    h('section', null, h('h2', null, 'This device'), h('table', { class: 'kv' }, rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, String(v)))))),
    h(
      'section',
      null,
      h('h2', null, 'Diagnostics'),
      h('p', { class: 'small muted' }, 'Every download, load and run, step by step, with how long it took and where and why anything failed. Kept on this device, bounded, and never sent anywhere. By default it holds no page text, questions or answers.'),
      h(
        'p',
        { class: 'small' },
        h('button', { type: 'button', class: 'link', onclick: async () => copy(await AI.report({ detail: detailBox.checked }), 'report') }, 'Copy report'),
        ' · ',
        h('button', { type: 'button', class: 'link', onclick: async () => copy(await AI.reportJson({ detail: detailBox.checked }), 'report as JSON') }, 'Copy as JSON'),
        copyNote,
      ),
      h('label', { class: 'field check' }, detailBox, h('span', null, 'Include my last question and the titles of its sources'), h('small', { class: 'muted' }, 'Private: this puts text you wrote into the report. Leave it off unless you are sending the report to someone you trust.')),
      h(
        'p',
        { class: 'small' },
        h('button', { type: 'button', class: 'link', onclick: async () => (await AI.resetEngine(), route()) }, 'Reset AI engine'),
        ' (stops anything running and restarts the engine; downloaded models are kept) · ',
        filterBtn,
        ' · ',
        twoTap('Clear log', () => AI.clearLog()),
      ),
      entries.length ? logList : h('p', { class: 'small muted' }, 'Nothing logged yet.'),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Remove'),
      h('p', { class: 'small' }, twoTap('Remove all AI data from this device', () => AI.removeAll())),
      h('p', { class: 'small muted' }, 'Deletes every model, the engine, the meaning index, summaries, questions, this log and the safety history.'),
    ),
  );
  aiUnsub = AI.on((type, data) => {
    if (currentPath() !== '/ai') return;
    if (type === 'log') logList.prepend(logItem(data));
    if (type === 'op' || type === 'loaded') drawStatus();
    if (type === 'safety') {
      clearTimeout(netPageTimer);
      netPageTimer = setTimeout(route, 300);
    }
    if (type === 'download' && !data.done) {
      const el = document.getElementById(`ai-status-${data.id}`);
      if (el)
        el.textContent = `Downloading ${Math.round((100 * data.have) / data.total)}% · ${AL.size(data.have)} of ${AL.size(data.total)} · ${AL.size(data.rate)}/s${data.eta ? ` · ${AL.eta(data.eta)} left` : ''}`;
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
    h('header', { class: 'bar' }, h('a', { href: '#/', class: 'brand' }, 'Sparse'), h('span', { class: 'muted' }, 'Settings')),
    h(
      'section',
      null,
      h('h2', null, 'Search'),
      field(
        'Search engine',
        select('engine', { mwmbl: 'Mwmbl (free)', marginalia: 'Marginalia (free, often busy)' }),
        'Searches always start with a free engine. Mojeek is never used automatically.',
      ),
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
      checkField('Try other engines when one fails or finds nothing', check('fallback')),
      field(
        'Jina Reader API key',
        text('jinaKey', 'optional'),
        'Reader view works without a key, but Jina may refuse anonymous requests from some networks (401). A free key from jina.ai fixes that and raises the limit to 200 pages a minute. Stays on this device and is sent only to Jina.',
      ),
      field('Region', select('region', L.REGIONS), 'Used by Mojeek and the DuckDuckGo button.'),
      checkField('Safe search', check('safe')),
      checkField('Instant answers (DuckDuckGo)', check('instant')),
      field('Tapping a result opens', select('openIn', { reader: 'Reader view (light)', site: 'The website' })),
      field('DuckDuckGo button opens', select('ddg', { lite: 'DuckDuckGo Lite', html: 'DuckDuckGo HTML' })),
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
    ),
    h(
      'section',
      null,
      h('h2', null, 'On-device AI'),
      h(
        'p',
        { class: 'small' },
        AL.MODEL_IDS.some((x) => AI.isReady(x))
          ? `On this device: ${AL.MODEL_IDS.filter((x) => AI.isReady(x))
              .map((x) => AL.PACKAGES[x].short)
              .join(', ')}. `
          : 'Off: nothing is downloaded until you choose a model. ',
        h('a', { href: '#/ai' }, 'On-device AI'),
        ': summaries, answers from saved pages, downloads and diagnostics.',
      ),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Activity and network'),
      checkField(
        'Show the activity log expanded',
        check('showActivity'),
        'Each screen lists every step and request as it happens. When this is off, the log starts collapsed and you can tap it to open it.',
      ),
      h('p', { class: 'small' }, h('a', { href: '#/net' }, 'Network details'), ': every request, totals per service, and how the app loaded.'),
    ),
    h(
      'section',
      null,
      h('h2', null, 'Storage'),
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
    h(
      'section',
      null,
      h('h2', null, 'Who sees what'),
      h(
        'ul',
        { class: 'small' },
        h('li', null, 'Searches go to the engine you chose (Marginalia, Mwmbl or Mojeek), and to DuckDuckGo when instant answers are on.'),
        h('li', null, 'Pages you open in reader view are fetched by Jina Reader (r.jina.ai), which sees their addresses. It allows 20 pages a minute.'),
        h('li', null, 'Weather comes from Open-Meteo, which sees the place, or your coordinates for plain “weather”.'),
        h('li', null, 'On-device AI, if you turn it on: models download once from Hugging Face, and the engine from jsDelivr. After that, summaries and answers are worked out on this device and nothing you read or ask is sent anywhere.'),
        h('li', null, 'History, saved results and pages stay on this device.'),
      ),
    ),
  );
  settle();
}

// ---------- routing and startup ----------

function currentPath() {
  return location.hash.replace(/^#/, '').split('?')[0] || '/';
}

function route() {
  const id = ++renderId;
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
      if (merged.aiPromptLimit === 300 && !merged.aiPromptChosen) merged.aiPromptLimit = null; // 300 was the old default, not a choice
      if (!L.FREE_ENGINE_IDS.includes(merged.engine)) merged.engine = DEFAULTS.engine; // the paid engine is never the default
      return merged;
    }),
    S.kvGet('netlog', []),
    S.kvGet('nettotals', null).then((t) => t ?? emptyTotals()),
  ]);
  initNav();
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

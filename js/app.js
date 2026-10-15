// Sparse: a small search PWA with no server of its own. Routes live in the URL hash:
//   #/            home: search box, queue, recent searches, saved pages, data use
//   #/s?q=&p=&e=  results (q = query, p = page, e = engine)
//   #/r?u=        reader view of a page, through Jina Reader
//   #/net         network details: every request, totals per service, how the app loaded
//   #/settings
// Every screen narrates what it is doing in an activity log, and every request is measured (net.js).
import * as L from './lib.js';
import * as N from './net.js';
import * as S from './store.js';

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

function inlineNodes(nodes, pageUrl) {
  const same = (a) => a.split('#')[0] === pageUrl.split('#')[0];
  return nodes.map((n) => {
    if (n.t === 'text') return n.s;
    if (n.t === 'code') return h('code', null, n.s);
    if (n.t === 'b') return h('strong', null, inlineNodes(n.c, pageUrl));
    if (n.t === 'i') return h('em', null, inlineNodes(n.c, pageUrl));
    if (same(n.href)) return h('span', null, inlineNodes(n.c, pageUrl));
    return h('a', { href: hashFor('/r', { u: n.href }) }, inlineNodes(n.c, pageUrl));
  });
}

function blockNodes(blocks, pageUrl) {
  const inl = (c) => inlineNodes(c, pageUrl);
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
      h('nav', { class: 'links' }, h('a', { href: '#/net' }, 'Network'), h('a', { href: '#/settings' }, 'Settings')),
    ),
    searchForm(),
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

async function showWeather(container, place, id, act) {
  const unit = L.resolveUnit(settings.units, navigator.language);
  const card = h('section', { class: 'card weather' }, h('p', { class: 'muted' }, 'Weather…'));
  container.prepend(card);
  const where = place ? `“${place}”` : 'your location';
  const key = `wx|${place.toLowerCase()}|${unit}`;
  act.step(`Weather: looking on this device for a forecast for ${where}…`);
  let rec = await S.get('results', key);
  try {
    if (rec && Date.now() - rec.at <= 30 * MIN) act.ok(`Weather: using the forecast saved ${L.relTime(rec.at)}, nothing downloaded`);
    else if (rec && !navigator.onLine) act.ok(`Weather: offline, using the forecast saved ${L.relTime(rec.at)}`);
    else {
      if (rec) act.step(`Weather: the saved forecast is ${L.relTime(rec.at)} old (over 30 min): refreshing`);
      const net = { requests: 0, received: 0, wire: 0, estimated: false };
      const get = async (url) => {
        const r = await act.fetch(url);
        net.requests++;
        net.received += r.entry.received;
        net.wire += r.entry.wire ?? r.entry.received;
        if (r.entry.wireKind !== 'exact') net.estimated = true;
        return r.json();
      };
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
      act.step('Weather: fetching the 3-day forecast…');
      const forecast = L.parseForecast(await get(L.forecastUrl(loc.lat, loc.lon, unit)), loc.label, unit);
      if (!forecast) throw new Error('no forecast available');
      rec = { at: Date.now(), forecast, net };
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
  const day = (d, i) => (i === 0 ? 'Today' : new Date(`${d}T12:00`).toLocaleDateString(undefined, { weekday: 'short' }));
  fill(
    card,
    h('h2', null, f.label),
    h('p', { class: 'big' }, `${f.now.temp}${f.unit} `, h('span', null, f.now.desc)),
    h(
      'table',
      { class: 'days' },
      f.days.map((d, i) =>
        h(
          'tr',
          null,
          h('td', null, day(d.date, i)),
          h('td', null, d.desc),
          h('td', null, `${d.hi}° / ${d.lo}°`),
          h('td', { class: 'muted' }, d.rain != null ? `${d.rain}% rain` : ''),
        ),
      ),
    ),
    h('p', { class: 'muted small' }, `Wind ${f.now.wind} ${f.wind} · Open-Meteo, updated ${L.relTime(rec.at)} · ${amount(rec.net)}`),
  );
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

async function showRead(id, raw, reload = false) {
  const url = L.safeHttpUrl(raw);
  const host = url ? L.hostOf(url) : '';
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
    fill(
      article,
      h('h1', null, rec.title),
      h(
        'p',
        { class: 'actions small' },
        external(url, 'Open original ↗'),
        ' · ',
        save,
        rec.published ? h('span', { class: 'muted' }, ` · ${formatDate(rec.published)}`) : null,
      ),
      blocks.length ? blockNodes(blocks, url) : h('p', { class: 'muted' }, 'The reader found no text on this page. Try opening the original.'),
    );
    act.ok(`Showing ${plural(blocks.length, 'block')} of text (menus at the top removed)`);
    settle();
  };

  const showProblem = (message) => {
    if (id !== renderId) return;
    fill(status, h('p', null, message));
    fill(article, h('p', null, external(url, 'Open the original page ↗')));
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
    showProblem(`Couldn't load this page: ${describe(e)}.`);
    act.finish('Page failed');
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

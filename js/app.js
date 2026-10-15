// Sparse: a small search PWA with no server of its own. Routes live in the URL hash:
//   #/            home: search box, queue, recent searches, saved pages
//   #/s?q=&p=&e=  results (q = query, p = page, e = engine)
//   #/r?u=        reader view of a page, through Jina Reader
//   #/settings
import * as L from './lib.js';
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
};
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

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

// ---------- network ----------

class HttpError extends Error {
  constructor(status, body = '') {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function fetchT(url, ms = 15000, headers = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers });
    if (!res.ok) throw new HttpError(res.status, (await res.text().catch(() => '')).slice(0, 2000));
    return res;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const err = new Error(ac.signal.aborted ? 'timed out' : navigator.onLine ? 'could not connect' : 'offline');
    err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const getJson = async (url, ms) => (await fetchT(url, ms)).json();

function describe(e) {
  if (e instanceof HttpError) {
    if (e.status === 503 || e.status === 429) return 'busy or rate-limited, try again shortly';
    if (e.status === 401 || e.status === 403) return 'access refused (check the key in Settings)';
    return `error ${e.status}`;
  }
  return e?.message || String(e);
}

// ---------- search, queue and pages (no DOM, shared by the views and the offline queue) ----------

const failedAt = new Map();
const resultsKey = (q, page, engine) => `${engine}|${page}|${q.trim().toLowerCase()}`;

async function runSearch(q, page, chosen) {
  // Engines that failed in the last few minutes go last, so a slow one doesn't cost a timeout every search.
  const failing = (id) => Date.now() - (failedAt.get(id) ?? 0) < 5 * MIN;
  const all = L.engineOrder(settings, chosen);
  const order = [...all.filter((id) => !failing(id)), ...all.filter(failing)];
  if (!order.length) throw new Error('No search engine is available. Check Settings.');
  const instant =
    page === 1 && settings.instant
      ? getJson(L.instantUrl(q), 8000)
          .then((j) => L.parseInstant(j, q))
          .catch(() => null)
      : Promise.resolve(null);
  const notes = [];
  let allNetwork = true;
  for (const [i, id] of order.entries()) {
    const engine = L.ENGINES[id];
    try {
      const { results, more } = engine.parse(await getJson(engine.url({ ...settings, q, page }), 8000), page);
      if (!results.length && i < order.length - 1) {
        notes.push(`${engine.name} found nothing`);
        allNetwork = false;
        continue;
      }
      const rec = { q, page, engine: id, results, more, notes, instant: await instant, at: Date.now() };
      await S.put('results', resultsKey(q, page, chosen), rec);
      return rec;
    } catch (e) {
      allNetwork &&= !!e.network;
      failedAt.set(id, Date.now());
      notes.push(`${engine.name}: ${describe(e)}`);
    }
  }
  const err = new Error(notes.join(' · '));
  err.network = allNetwork;
  throw err;
}

async function loadPage(url) {
  let text;
  try {
    const auth = settings.jinaKey ? { Authorization: `Bearer ${settings.jinaKey}` } : {};
    text = await (await fetchT(L.readerUrl(url), 30000, auth)).text();
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
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
  const parsed = L.parseJina(text);
  const old = await S.get('pages', url);
  const rec = { url, ...parsed, title: parsed.title || L.hostOf(url), at: Date.now(), saved: old?.saved ?? false };
  await S.put('pages', url, rec);
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

/** Runs searches and page loads that were asked for while offline. */
async function drainQueue() {
  if (draining || !navigator.onLine) return;
  draining = true;
  try {
    const queue = await S.kvGet('queue', []);
    if (!queue.length) return;
    const done = [];
    for (const item of queue) {
      try {
        if (item.kind === 'search') await runSearch(item.q, 1, item.engine);
        else await loadPage(item.url);
        done.push({ ...item, doneAt: Date.now() });
      } catch (e) {
        if (e.network) break; // still offline; keep the rest for later
        done.push({ ...item, doneAt: Date.now(), error: describe(e) });
      }
    }
    const doneKeys = new Set(done.map((d) => d.key));
    await S.kvSet(
      'queue',
      (await S.kvGet('queue', [])).filter((x) => !doneKeys.has(x.key)),
    );
    await S.kvSet('ready', [...(await S.kvGet('ready', [])), ...done].slice(-20));
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
  const form = h(
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
  return form;
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
  render(
    h('header', { class: 'bar' }, h('span', { class: 'brand' }, 'Sparse'), h('a', { href: '#/settings', class: 'link' }, 'Settings')),
    searchForm(),
    h(
      'p',
      { class: 'muted small' },
      engine ? `${L.ENGINES[engine].name}${settings.fallback ? ', with fallback' : ''} · ` : 'No engine set · ',
      'add ',
      h('code', null, '!bang'),
      ' to search on DuckDuckGo',
    ),
    queue.length > 0 &&
      h(
        'section',
        null,
        h('h2', null, 'Waiting for a connection'),
        h(
          'ul',
          { class: 'plain' },
          queue.map((x) => h('li', null, x.kind === 'search' ? x.q : x.url)),
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
          ready.map((x) => h('li', null, itemLink(x), x.error ? h('span', { class: 'muted small' }, ` · ${x.error}`) : null)),
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
          saved.map((p) => h('li', null, h('a', { href: hashFor('/r', { u: p.url }) }, p.title), h('span', { class: 'muted small' }, ` · ${L.hostOf(p.url)}`))),
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
  const status = h('p', { class: 'status' }, 'Searching…');
  const cards = h('div');
  const list = h('ol', { class: 'results' });
  const foot = h('nav', { class: 'more' });
  render(topbar(q), status, cards, list, foot);
  if (page === 1) await addHistory(q);
  const key = resultsKey(q, page, chosen);
  clearReady(key);

  const weather = page === 1 ? L.weatherIntent(q) : null;
  if (weather) showWeather(cards, weather.place, id);

  const show = (rec, note) => {
    if (id !== renderId) return;
    const bits = [`${L.ENGINES[rec.engine].name}`, `${rec.results.length ? `${rec.results.length} results` : 'no results'}${page > 1 ? `, page ${page}` : ''}`];
    if (note) bits.push(note);
    fill(
      status,
      bits.join(' · '),
      note ? ' ' : null,
      note ? h('button', { type: 'button', class: 'link', onclick: () => showSearch(++renderId, q, page, engineParam, true) }, 'Refresh') : null,
    );
    if (rec.notes?.length) status.append(h('span', { class: 'muted small block' }, rec.notes.join(' · ')));
    if (rec.instant) {
      const i = rec.instant;
      cards.append(
        h(
          'section',
          { class: 'card' },
          h('h2', null, i.heading),
          h('p', null, i.text.length > 600 ? `${i.text.slice(0, 600)}…` : i.text),
          i.url ? h('a', { href: hashFor('/r', { u: i.url }) }, `Read more${i.source ? ` on ${i.source}` : ''}`) : null,
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
          r.snippet.length ? h('p', null, snippetNodes(r.snippet)) : null,
          settings.openIn === 'reader' ? external(r.url, 'Open site ↗', 'ext small') : null,
        ),
      ),
    );
    const others = L.engineOrder({ ...settings, fallback: true }, rec.engine).filter((e) => e !== rec.engine);
    fill(
      foot,
      rec.more ? h('a', { href: hashFor('/s', { q, p: page + 1, e: rec.engine }), class: 'button' }, 'More results') : null,
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
    fill(status, message);
    fill(foot, h('p', { class: 'small' }, external(L.ddgUrl(q, settings), `Search DuckDuckGo ${settings.ddg === 'html' ? 'HTML' : 'Lite'} instead ↗`)));
  };

  const cached = await S.get('results', key);
  if (id !== renderId) return;
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && !force && (age < settings.cacheHours * HOUR || !navigator.onLine)) return show(cached, `saved ${L.relTime(cached.at)}`);
  if (!navigator.onLine) {
    await enqueue({ kind: 'search', key, q, engine: chosen });
    return showProblem("You're offline. This search is queued and will run when you're back online.");
  }
  try {
    show(await runSearch(q, page, chosen));
  } catch (e) {
    if (cached) return show(cached, `saved ${L.relTime(cached.at)}; refresh failed`);
    if (e.network) {
      await enqueue({ kind: 'search', key, q, engine: chosen });
      return showProblem(`Couldn't reach the search engines (${e.message}). This search is queued and will run when the connection is back.`);
    }
    showProblem(`Search failed: ${e.message}`);
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

async function showWeather(container, place, id) {
  const unit = L.resolveUnit(settings.units, navigator.language);
  const card = h('section', { class: 'card weather' }, h('p', { class: 'muted' }, 'Weather…'));
  container.prepend(card);
  const key = `wx|${place.toLowerCase()}|${unit}`;
  let rec = await S.get('results', key);
  try {
    if (!rec || (Date.now() - rec.at > 30 * MIN && navigator.onLine)) {
      const loc = place ? L.parseGeocode(await getJson(L.geocodeUrl(place))) : await here();
      if (!loc) throw new Error(`couldn't find “${place}”`);
      const forecast = L.parseForecast(await getJson(L.forecastUrl(loc.lat, loc.lon, unit)), loc.label, unit);
      if (!forecast) throw new Error('no forecast available');
      rec = { at: Date.now(), forecast };
      await S.put('results', key, rec);
    }
  } catch (e) {
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
    h('p', { class: 'muted small' }, `Wind ${f.now.wind} ${f.wind} · Open-Meteo · ${L.relTime(rec.at)}`),
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
  );
}

function formatDate(raw) {
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function showRead(id, raw, reload = false) {
  const url = L.safeHttpUrl(raw);
  const status = h('p', { class: 'status' }, 'Loading…');
  const article = h('article', { class: 'reader' });
  render(topbar(''), status, article);
  if (!url) return fill(status, 'That is not a web address this app can open.');
  clearReady(url);

  const showPage = (rec, note) => {
    if (id !== renderId) return;
    document.title = `${rec.title} · Sparse`;
    const kb = Math.max(1, Math.round(rec.markdown.length / 1024));
    fill(
      status,
      `${L.hostOf(url)} · ${kb} KB of text · fetched ${L.relTime(rec.at)}`,
      note ? ` · ${note}` : '',
      ' ',
      h('button', { type: 'button', class: 'link', onclick: () => showRead(++renderId, url, true) }, 'Reload'),
    );
    const save = h('button', { type: 'button', class: 'link' }, rec.saved ? 'Saved ✓' : 'Save for offline');
    save.addEventListener('click', async () => {
      rec.saved = !rec.saved;
      await S.put('pages', url, rec);
      save.textContent = rec.saved ? 'Saved ✓' : 'Save for offline';
    });
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
    settle();
  };

  const showProblem = (message) => {
    if (id !== renderId) return;
    fill(status, message);
    fill(article, h('p', null, external(url, 'Open the original page ↗')));
  };

  let rec = await S.get('pages', url);
  if (id !== renderId) return;
  if (rec && !reload) return showPage(rec);
  if (!navigator.onLine) {
    if (rec) return showPage(rec, 'offline');
    await enqueue({ kind: 'page', key: url, url });
    return showProblem("You're offline. This page is queued and will be fetched when you're back online.");
  }
  try {
    showPage(await loadPage(url));
  } catch (e) {
    if (rec) return showPage(rec, `reload failed: ${describe(e)}`);
    if (e.network) {
      await enqueue({ kind: 'page', key: url, url });
      return showProblem(`Couldn't reach the reader (${e.message}). This page is queued and will load when the connection is back.`);
    }
    showProblem(`Couldn't load this page: ${describe(e)}.`);
  }
}

async function saveSetting(key, value) {
  settings = { ...settings, [key]: value };
  await S.kvSet('settings', settings);
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
      field('Search engine', select('engine', { mwmbl: 'Mwmbl (free)', marginalia: 'Marginalia (free, often busy)', mojeek: 'Mojeek (needs a key)' })),
      field(
        'Mojeek API key',
        text('mojeekKey', 'paste your key'),
        'From mojeek.com/services/search/web-search-api. Stays on this device and is sent only to Mojeek. Without it, Mojeek is skipped.',
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
      h('h2', null, 'Storage'),
      h('p', { class: 'small' }, est ? `About ${(est.usage / 1048576).toFixed(1)} MB used on this device.` : 'Storage use is not available.'),
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
    case '/settings':
      return showSettings(id);
    default:
      return showHome(id);
  }
}

function updateOnline() {
  document.getElementById('offline').hidden = navigator.onLine;
}

async function start() {
  history.scrollRestoration = 'manual';
  settings = { ...DEFAULTS, ...(await S.kvGet('settings', {})) };
  addEventListener('hashchange', (e) => {
    scrollPos.set(new URL(e.oldURL).hash, window.scrollY);
    route();
  });
  addEventListener('online', () => {
    updateOnline();
    drainQueue();
  });
  addEventListener('offline', updateOnline);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && drainQueue());
  updateOnline();
  route();
  navigator.storage?.persist?.().catch(() => {});
  setTimeout(() => {
    S.evict().catch(() => {});
    drainQueue();
  }, 1500);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

start();

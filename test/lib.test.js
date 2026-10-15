import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as L from '../js/lib.js';

const text = (nodes) => L.inlineText(nodes);

test('safeHttpUrl keeps http(s) only', () => {
  assert.equal(L.safeHttpUrl('https://a.example/x'), 'https://a.example/x');
  assert.equal(L.safeHttpUrl('/b', 'https://a.example/x'), 'https://a.example/b');
  assert.equal(L.safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(L.safeHttpUrl('data:text/html,hi'), null);
  assert.equal(L.safeHttpUrl('not a url'), null);
});

test('clean and decodeEntities', () => {
  assert.equal(L.clean('Fish &amp; <b>chips</b>&#39;s &#x263A;'), "Fish & chips's ☺");
  assert.equal(L.decodeEntities('&bogus;'), '&bogus;');
});

test('Mojeek: URL and parsing', () => {
  const url = new URL(L.ENGINES.mojeek.url({ q: 'a b', page: 2, mojeekKey: 'K', safe: true, region: 'gb' }));
  assert.equal(url.origin + url.pathname, 'https://www.mojeek.com/search');
  assert.equal(url.searchParams.get('q'), 'a b');
  assert.equal(url.searchParams.get('s'), '11');
  assert.equal(url.searchParams.get('api_key'), 'K');
  assert.equal(url.searchParams.get('fmt'), 'json');
  assert.equal(url.searchParams.get('safe'), '1');
  assert.equal(url.searchParams.get('rb'), 'GB');
  const json = {
    response: {
      status: 'OK',
      head: { start: 1, return: 2, results: 40 },
      results: [
        { url: 'https://a.example/', title: 'A &amp; B', desc: 'about a' },
        { url: 'javascript:bad()', title: 'bad', desc: '' },
        { url: 'https://a.example/', title: 'dupe', desc: '' },
      ],
    },
  };
  const out = L.ENGINES.mojeek.parse(json);
  assert.deepEqual(out.results, [{ url: 'https://a.example/', title: 'A & B', snippet: [{ text: 'about a' }] }]);
  assert.equal(out.more, true);
  assert.throws(() => L.ENGINES.mojeek.parse({ response: { status: 'Access Denied: invalid key/password', results: [] } }), /invalid key/);
});

test('Mojeek dates', () => {
  assert.equal(new URL(L.ENGINES.mojeek.url({ q: 'a', mojeekKey: 'K' })).searchParams.get('date'), '1');
  const json = (fields) => ({ response: { status: 'OK', head: {}, results: [{ url: 'https://a.example/', title: 't', desc: 'd', ...fields }] } });
  assert.deepEqual(L.ENGINES.mojeek.parse(json({ timestamp: 1700000000 })).results[0].date, { at: 1700000000000, kind: 'updated' });
  assert.deepEqual(L.ENGINES.mojeek.parse(json({ timestamp: 1700000000, pdate: 1600000000 })).results[0].date, { at: 1600000000000, kind: 'published' });
  assert.equal(L.ENGINES.mojeek.parse(json({ timestamp: 0 })).results[0].date, undefined);
});

test('parseApiDate', () => {
  const now = Date.UTC(2026, 9, 15);
  assert.equal(L.parseApiDate(1700000000, now), 1700000000000);
  assert.equal(L.parseApiDate('1700000000', now), 1700000000000);
  assert.equal(L.parseApiDate(1700000000000, now), 1700000000000);
  assert.equal(L.parseApiDate('2024-03-03', now), Date.UTC(2024, 2, 3));
  assert.equal(L.parseApiDate('Sun, 03 Mar 2024 10:00:00 GMT', now), Date.UTC(2024, 2, 3, 10));
  assert.equal(L.parseApiDate(0, now), null);
  assert.equal(L.parseApiDate('garbage', now), null);
  assert.equal(L.parseApiDate(Date.UTC(2030, 0, 1) / 1000, now), null);
});

test('Marginalia: URL and parsing', () => {
  assert.equal(L.ENGINES.marginalia.url({ q: 'a/b c', page: 3, marginaliaKey: '' }), 'https://api.marginalia.nu/public/search/a%2Fb%20c?count=10&page=3');
  const out = L.ENGINES.marginalia.parse({
    page: 1,
    pages: 11,
    results: [{ url: 'https://p.example/x', title: 'How to bake bread', description: 'Follow a recipe.' }],
  });
  assert.equal(out.results[0].title, 'How to bake bread');
  assert.equal(out.more, true);
  assert.equal(L.ENGINES.marginalia.parse({ page: 2, pages: 2, results: [] }).more, false);
  assert.throws(() => L.ENGINES.marginalia.parse({}), /unexpected/);
});

test('Mwmbl: bold segments survive', () => {
  const out = L.ENGINES.mwmbl.parse([
    {
      url: 'https://m.example/',
      title: [
        { value: 'How to ', is_bold: false },
        { value: 'bake', is_bold: true },
      ],
      extract: [
        { value: ' Baking ', is_bold: false },
        { value: 'bread', is_bold: true },
      ],
    },
  ]);
  assert.equal(out.results[0].title, 'How to bake');
  assert.deepEqual(out.results[0].snippet, [
    { text: ' Baking ', bold: false },
    { text: 'bread', bold: true },
  ]);
  assert.equal(out.more, false);
});

test('engineOrder skips Mojeek without a key and honours fallback', () => {
  const base = { engine: 'mojeek', mojeekKey: '', fallback: true };
  assert.deepEqual(L.engineOrder(base), ['mwmbl', 'marginalia']);
  // Asked for explicitly (the Try Mojeek button): Mojeek alone, no quiet free re-search.
  assert.deepEqual(L.engineOrder({ ...base, mojeekKey: 'k' }), ['mojeek']);
  assert.deepEqual(L.engineOrder({ ...base, mojeekKey: 'k', fallback: false }), ['mojeek']);
  assert.deepEqual(L.engineOrder({ ...base, engine: 'mwmbl' }, 'marginalia'), ['marginalia', 'mwmbl']);
  // Never as a fallback, even with a key.
  assert.deepEqual(L.engineOrder({ engine: 'mwmbl', mojeekKey: 'k', fallback: true }), ['mwmbl', 'marginalia']);
  assert.deepEqual(L.FREE_ENGINE_IDS, ['mwmbl', 'marginalia']);
});

test('bangs and DuckDuckGo links', () => {
  assert.equal(L.hasBang('!w paris'), true);
  assert.equal(L.hasBang('paris !g'), true);
  assert.equal(L.hasBang('wow!'), false);
  assert.equal(L.ddgUrl('!w paris'), 'https://duckduckgo.com/?q=%21w+paris');
  assert.equal(L.ddgUrl('a b', { region: 'gb', safe: true }), 'https://lite.duckduckgo.com/lite/?q=a+b&kl=uk-en&kp=1');
  assert.equal(L.ddgUrl('a', { ddg: 'html' }), 'https://html.duckduckgo.com/html/?q=a');
});

test('instant answers', () => {
  assert.equal(L.parseInstant({ AbstractText: '', Answer: '' }, 'x'), null);
  const a = L.parseInstant(
    { Heading: 'Paris', AbstractText: 'Capital of France.', AbstractURL: 'https://en.wikipedia.org/wiki/Paris', AbstractSource: 'Wikipedia' },
    'paris',
  );
  assert.deepEqual(a, { heading: 'Paris', text: 'Capital of France.', url: 'https://en.wikipedia.org/wiki/Paris', source: 'Wikipedia' });
  assert.equal(L.parseInstant({ Answer: '4', AnswerType: 'calc' }, '2+2').text, '4');
  assert.equal(L.parseInstant({ Answer: { calc: true } }, 'x'), null);
});

test('weather intent, parsing and units', () => {
  assert.deepEqual(L.weatherIntent('weather'), { place: '' });
  assert.deepEqual(L.weatherIntent('Weather in Leeds'), { place: 'Leeds' });
  assert.deepEqual(L.weatherIntent('forecast berlin'), { place: 'berlin' });
  assert.deepEqual(L.weatherIntent('paris weather'), { place: 'paris' });
  assert.equal(L.weatherIntent('whether to go'), null);
  assert.deepEqual(L.parseGeocode({ results: [{ latitude: 1, longitude: 2, name: 'Leeds', admin1: 'England', country_code: 'GB' }] }), {
    lat: 1,
    lon: 2,
    label: 'Leeds, England, GB',
  });
  assert.equal(L.parseGeocode({}), null);
  const f = L.parseForecast(
    {
      current: { temperature_2m: 11.6, weather_code: 3, wind_speed_10m: 9.2 },
      daily: { time: ['2026-10-15'], weather_code: [61], temperature_2m_max: [13.4], temperature_2m_min: [6.5], precipitation_probability_max: [80] },
    },
    'Leeds',
  );
  assert.deepEqual(f.now, { temp: 12, feels: null, desc: 'Overcast', wind: 9 });
  assert.equal(f.rain, null);
  assert.deepEqual(f.days[0], { date: '2026-10-15', hi: 13, lo: 7, desc: 'Light rain', rain: 80 });
  assert.equal(L.resolveUnit('auto', 'en-US'), 'f');
  assert.equal(L.resolveUnit('auto', 'en-GB'), 'c');
  assert.equal(L.resolveUnit('c', 'en-US'), 'c');
  assert.match(L.forecastUrl(1, 2, 'f'), /temperature_unit=fahrenheit/);
});

test('jinaError reads the message from an error body', () => {
  assert.equal(
    L.jinaError('{"code":401,"name":"AuthenticationFailedError","message":"Invalid API key, please get a new one from https://jina.ai"}'),
    'Invalid API key, please get a new one from https://jina.ai',
  );
  assert.equal(L.jinaError('<html>nope</html>'), '');
  assert.equal(L.jinaError(''), '');
});

test('parseJina splits header and body', () => {
  const r = L.parseJina('Title: Example Domain\n\nURL Source: https://example.com/\n\nPublished Time: Tue, 13 Oct 2026\n\nMarkdown Content:\nHello *there*.\n');
  assert.deepEqual(r, { title: 'Example Domain', source: 'https://example.com/', published: 'Tue, 13 Oct 2026', markdown: 'Hello *there*.' });
  assert.equal(L.parseJina('just text').markdown, 'just text');
});

test('inline Markdown: links, emphasis, code, images dropped', () => {
  const n = L.parseInline(
    'See **bold** and *it* and `x*y` [docs](/d "T") ![img](a.png) [![logo](l.png)](https://e.example/) [bad](javascript:x) snake_case_word',
    'https://base.example/p',
  );
  assert.equal(text(n), 'See bold and it and x*y docs   bad snake_case_word');
  const link = n.find((x) => x.t === 'link');
  assert.equal(link.href, 'https://base.example/d');
  assert.ok(n.some((x) => x.t === 'b'));
  assert.ok(n.some((x) => x.t === 'i'));
  assert.ok(n.some((x) => x.t === 'code' && x.s === 'x*y'));
  assert.equal(n.filter((x) => x.t === 'link').length, 1);
  assert.equal(text(L.parseInline('a \\*literal\\* [b] (c)')), 'a *literal* [b] (c)');
  assert.equal(L.parseInline('<https://x.example/>')[0].href, 'https://x.example/');
});

test('block Markdown: headings, lists, quotes, code, tables', () => {
  const md = [
    'Title here',
    '==========',
    '',
    '## Section',
    'First line',
    'continues.',
    '',
    '*   one',
    '*   two',
    '    *   nested',
    '',
    '1. first',
    '2. second',
    '',
    '> quoted',
    '> more',
    '',
    '```',
    'code <b>',
    '```',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '---',
    'Sub',
    '---',
  ].join('\n');
  const b = L.parseMarkdown(md, 'https://x.example/');
  assert.deepEqual(
    b.map((x) => x.type),
    ['h', 'h', 'p', 'list', 'list', 'quote', 'pre', 'table', 'hr', 'h'],
  );
  assert.equal(b[0].level, 1);
  assert.equal(text(b[2].c), 'First line continues.');
  assert.deepEqual(
    b[3].items.map((i) => [text(i.c), i.depth]),
    [
      ['one', 0],
      ['two', 0],
      ['nested', 2],
    ],
  );
  assert.equal(b[4].ordered, true);
  assert.equal(text(b[5].c), 'quoted more');
  assert.equal(b[6].text, 'code <b>');
  assert.deepEqual(
    b[7].rows.map((r) => r.map(text)),
    [
      ['a', 'b'],
      ['1', '2'],
    ],
  );
  assert.equal(b[9].level, 2);
});

test('trimNav drops leading navigation only', () => {
  const md = [
    '[Skip to content](https://n.example/#main)',
    '',
    '*   [Home](https://n.example/)',
    '*   [News](https://n.example/news)',
    '',
    '# Story',
    '',
    'Body with [a link](https://n.example/x).',
    '',
    '*   [Footer](https://n.example/f)',
  ].join('\n');
  const b = L.trimNav(L.parseMarkdown(md, 'https://n.example/'));
  assert.deepEqual(
    b.map((x) => x.type),
    ['h', 'p', 'list'],
  );
  assert.deepEqual(L.trimNav(L.parseMarkdown('[a](https://x.example/)')).length, 1);
});

test('display helpers', () => {
  assert.equal(L.displayUrl('https://www.example.com/docs/a%20b/c/d'), 'example.com › docs › a b › c');
  assert.equal(L.relTime(0, 30 * 1000), 'just now');
  assert.equal(L.relTime(0, 2 * 3600 * 1000), '2 h ago');
});

test('skippedEngines explains what is left out', () => {
  assert.deepEqual(L.skippedEngines({ engine: 'mwmbl', mojeekKey: '', fallback: true }), [{ id: 'mojeek', reason: 'no API key in Settings' }]);
  assert.deepEqual(
    L.skippedEngines({ engine: 'mwmbl', mojeekKey: 'k', fallback: false }).map((x) => x.id),
    ['mojeek', 'marginalia'],
  );
  assert.match(L.skippedEngines({ engine: 'mwmbl', mojeekKey: 'k', fallback: true })[0].reason, /paid/);
  assert.match(L.skippedEngines({ engine: 'mwmbl', mojeekKey: 'k', fallback: true }, 'mojeek')[0].reason, /asked for Mojeek/);
});

test('network formatting', () => {
  assert.equal(L.formatBytes(512), '512 B');
  assert.equal(L.formatBytes(7680), '7.5 KB');
  assert.equal(L.formatBytes(150 * 1024), '150 KB');
  assert.equal(L.formatBytes(3 * 1048576), '3.0 MB');
  assert.equal(L.formatMs(420), '420 ms');
  assert.equal(L.formatMs(2100), '2.10 s');
  assert.equal(L.formatSpeed(10240, 500), '20 KB/s');
  assert.equal(L.formatSpeed(10, 0), '?');
  const e = { status: 200, received: 7680, wire: 2400, wireKind: 'estimate', ttfb: 310, ms: 420 };
  assert.equal(L.describeTransfer(e), 'HTTP 200 · 7.5 KB received · ≈2.3 KB on the wire · first byte 310 ms · total 420 ms · ≈5.6 KB/s');
  assert.match(L.describeTransfer({ ...e, wireKind: 'exact' }), / 2\.3 KB on the wire/);
  assert.equal(L.describeTransfer({ error: 'timed out', status: null, ms: 8000 }), 'timed out after 8.00 s');
});

test('serviceOf and redactUrl', () => {
  assert.equal(L.serviceOf('https://r.jina.ai/https://x.example/'), 'Jina Reader');
  assert.equal(L.serviceOf('https://www.mojeek.com/search?q=a'), 'Mojeek');
  assert.equal(L.serviceOf('https://other.example/'), 'other.example');
  assert.equal(L.redactUrl('https://www.mojeek.com/search?q=a+b&api_key=SECRET&fmt=json'), 'https://www.mojeek.com/search?q=a+b&api_key=•••&fmt=json');
  assert.equal(L.redactUrl('https://api.marginalia.nu/mykey/search/a?count=10'), 'https://api.marginalia.nu/•••/search/a?count=10');
  assert.equal(L.redactUrl('https://api.marginalia.nu/public/search/a'), 'https://api.marginalia.nu/public/search/a');
});

test('rain in the next hour', () => {
  assert.equal(L.rainSoon([0, 0, 0, 0]), 'No rain expected in the next hour');
  assert.equal(L.rainSoon([0, 0, 0.3, 0.5]), 'Rain starting in about 30 min (0.8 mm in the next hour)');
  assert.equal(L.rainSoon([0.2, 0.2, 0.2, 0.2]), 'Rain for the next hour (0.8 mm)');
  assert.equal(L.rainSoon([0.4, 0, 0, 0]), 'Rain now, easing within the hour (0.4 mm)');
  assert.equal(L.rainSoon([0, 0.01, 0, 0.02], 'f'), 'Rain starting in about 15 min (0.03 in in the next hour)');
  assert.equal(L.rainSoon(undefined), null);
  assert.equal(L.rainSoon([null, null]), null);
});

test('more weather: detail and air quality', () => {
  const d = L.parseDetail({
    current: { relative_humidity_2m: 71, wind_direction_10m: 222, wind_gusts_10m: 43.9, pressure_msl: 1014.5, cloud_cover: 100, visibility: 18480 },
    hourly: { time: ['2026-10-15T14:00'], temperature_2m: [17.6], weather_code: [3], precipitation_probability: [8] },
    daily: {
      time: ['2026-10-15'],
      weather_code: [51],
      temperature_2m_max: [17.6],
      temperature_2m_min: [11.8],
      precipitation_probability_max: [75],
      precipitation_sum: [1.2],
      wind_speed_10m_max: [30.4],
      uv_index_max: [2.35],
      sunrise: ['2026-10-15T07:28'],
      sunset: ['2026-10-15T18:12'],
    },
  });
  assert.deepEqual(d.now, { humidity: 71, windDir: 'SW', gusts: 44, pressure: 1015, cloud: 100, visibility: '18 km' });
  assert.deepEqual(d.hours[0], { time: '14:00', temp: 18, desc: 'Overcast', rain: 8 });
  assert.deepEqual(d.days[0], {
    date: '2026-10-15',
    hi: 18,
    lo: 12,
    desc: 'Light drizzle',
    rain: 75,
    amount: 1.2,
    wind: 30,
    uv: 2,
    sunrise: '07:28',
    sunset: '18:12',
  });
  assert.equal(L.parseDetail({}), null);
  assert.equal(L.compass(0), 'N');
  assert.equal(L.compass(359), 'N');
  assert.equal(L.compass(90), 'E');
  assert.match(L.detailUrl(1, 2, 'f'), /precipitation_unit=inch/);

  const air = { current: { european_aqi: 24, us_aqi: 31, pm2_5: 3.3, pm10: 6, ozone: 68, nitrogen_dioxide: 7.3, uv_index: 0.3 } };
  assert.deepEqual(L.parseAir(air), { index: 24, scale: 'European AQI', label: 'Fair', pm25: 3.3, pm10: 6, ozone: 68, no2: 7, uv: 0.3 });
  assert.equal(L.parseAir(air, 'f').label, 'Good');
  assert.equal(L.parseAir(air, 'f').scale, 'US AQI');
  assert.equal(L.parseAir({}), null);
  assert.equal(L.uvText(6.4), '6 (high)');
  assert.equal(L.uvText(null), null);
});

test('Internet Archive snapshots', () => {
  const s = L.parseWayback(
    {
      archived_snapshots: {
        closest: {
          status: '200',
          available: true,
          url: 'http://web.archive.org/web/20261004161959/https://en.wikipedia.org/wiki/Focaccia',
          timestamp: '20261004161959',
        },
      },
    },
    'https://en.wikipedia.org/wiki/Focaccia',
  );
  assert.equal(s.at, Date.UTC(2026, 9, 4, 16, 19, 59));
  assert.equal(s.view, 'https://web.archive.org/web/20261004161959/https://en.wikipedia.org/wiki/Focaccia');
  assert.equal(s.raw, 'https://web.archive.org/web/20261004161959id_/https://en.wikipedia.org/wiki/Focaccia');
  assert.equal(L.parseWayback({ archived_snapshots: {} }, 'https://x.org/'), null);
  assert.equal(L.parseWayback({ archived_snapshots: { closest: { status: '404', available: true, timestamp: '2020' } } }, 'https://x.org/'), null);
  assert.equal(L.waybackLookupUrl('https://a.org/b?c=1'), 'https://archive.org/wayback/available?url=https%3A%2F%2Fa.org%2Fb%3Fc%3D1');

  assert.deepEqual(L.parseWaybackUrl('https://web.archive.org/web/20261004161959id_/https://en.wikipedia.org/wiki/Focaccia'), {
    ts: '20261004161959',
    at: Date.UTC(2026, 9, 4, 16, 19, 59),
    original: 'https://en.wikipedia.org/wiki/Focaccia',
  });
  assert.equal(L.parseWaybackUrl('https://web.archive.org/web/2020/example.com/a').original, 'http://example.com/a');
  assert.equal(L.parseWaybackUrl('https://example.com/web/2020/x'), null);

  const orig = 'https://en.wikipedia.org/wiki/Focaccia';
  assert.equal(L.unarchiveLink('https://web.archive.org/wiki/Bread#x', orig), 'https://en.wikipedia.org/wiki/Bread#x');
  assert.equal(L.unarchiveLink('https://web.archive.org/web/2020/https://a.org/', orig), 'https://web.archive.org/web/2020/https://a.org/');
  assert.equal(L.unarchiveLink('https://b.org/x', orig), 'https://b.org/x');
  assert.equal(L.serviceOf('https://archive.org/wayback/available?url=x'), 'Internet Archive');
});

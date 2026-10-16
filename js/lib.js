// Pure logic: request URLs, response parsers, Markdown → blocks. No DOM, so `node --test` covers it.
// Every service used here answers cross-origin requests from a web page (they send
// Access-Control-Allow-Origin), which is what lets this app work with no server of its own.

// ---------- small helpers ----------

/** Returns a normalised http(s) URL string, or null for anything else (javascript:, data:, junk). */
export function safeHttpUrl(raw, base) {
  try {
    const u = new URL(String(raw).trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(n);
      } catch {
        return m;
      }
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Plain text from an API field that may contain tags or entities. */
export function clean(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** `example.com › docs › page` for result lines. */
export function displayUrl(u) {
  try {
    const url = new URL(u);
    const parts = url.pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 3)
      .map((p) => decodeURIComponent(p).slice(0, 24));
    return [url.hostname.replace(/^www\./, ''), ...parts].join(' › ');
  } catch {
    return u;
  }
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function relTime(at, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/**
 * A date from an API field: Unix seconds or milliseconds, or a date string. Returns epoch ms, or
 * null for missing, zero or implausible values (before 1991 or more than a day in the future).
 */
export function parseApiDate(v, now = Date.now()) {
  if (v == null || v === '' || v === 0 || v === '0') return null;
  let ms;
  if (typeof v === 'number' || /^\d+$/.test(String(v).trim())) {
    const n = Number(v);
    ms = n < 1e11 ? n * 1000 : n;
  } else ms = Date.parse(String(v));
  if (!Number.isFinite(ms) || ms < Date.UTC(1991, 0, 1) || ms > now + 86400000) return null;
  return ms;
}

// ---------- search engines ----------

export class EngineError extends Error {}

const plain = (s) => {
  const text = clean(s);
  return text ? [{ text }] : [];
};

/** Drops results without a usable http(s) URL and duplicates. */
function tidy(results) {
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const url = safeHttpUrl(r.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ ...r, url, title: r.title || hostOf(url) });
  }
  return out;
}

/**
 * Each engine: `url(opts)` builds the request, `parse(json, page)` returns
 * `{ results: [{url, title, snippet: [{text, bold?}]}], more }` or throws EngineError.
 */
export const ENGINES = {
  mojeek: {
    name: 'Mojeek',
    needsKey: true,
    paid: true, // only used when asked for explicitly (the "Try Mojeek" button), never by default or as a fallback
    url({ q, page = 1, mojeekKey, safe, region }) {
      const p = new URLSearchParams({ q, fmt: 'json', api_key: mojeekKey ?? '', t: '10', s: String((page - 1) * 10 + 1), date: '1' });
      if (safe) p.set('safe', '1');
      if (region) {
        p.set('rb', region.toUpperCase());
        p.set('rbb', '10');
      }
      return `https://www.mojeek.com/search?${p}`;
    },
    parse(json) {
      const r = json?.response;
      if (!r || r.status !== 'OK') throw new EngineError(r?.status || 'unexpected response');
      const results = tidy(
        (r.results ?? []).map((x) => {
          const published = parseApiDate(x.pdate);
          const modified = parseApiDate(x.timestamp) ?? parseApiDate(x.date);
          const date = published ? { at: published, kind: 'published' } : modified ? { at: modified, kind: 'updated' } : null;
          return { url: x.url, title: clean(x.title), snippet: plain(x.desc), ...(date && { date }) };
        }),
      );
      const start = Number(r.head?.start ?? 1);
      const total = Number(r.head?.results ?? 0);
      return { results, more: results.length > 0 && start + results.length - 1 < total };
    },
  },
  mwmbl: {
    name: 'Mwmbl',
    url({ q }) {
      return `https://api.mwmbl.org/api/v1/search/?s=${encodeURIComponent(q)}`;
    },
    parse(json) {
      if (!Array.isArray(json)) throw new EngineError('unexpected response');
      const segs = (v) =>
        (Array.isArray(v) ? v : [{ value: v }]).map((s) => ({ text: decodeEntities(s?.value ?? ''), bold: !!s?.is_bold })).filter((s) => s.text);
      const results = tidy(
        json.map((x) => ({
          url: x.url,
          title: segs(x.title)
            .map((s) => s.text)
            .join('')
            .trim(),
          snippet: segs(x.extract),
        })),
      );
      return { results, more: false };
    },
  },
  marginalia: {
    name: 'Marginalia',
    url({ q, page = 1, marginaliaKey }) {
      return `https://api.marginalia.nu/${encodeURIComponent(marginaliaKey || 'public')}/search/${encodeURIComponent(q)}?count=10&page=${page}`;
    },
    parse(json, page = 1) {
      if (!json || !Array.isArray(json.results)) throw new EngineError('unexpected response');
      const results = tidy(json.results.map((x) => ({ url: x.url, title: clean(x.title), snippet: plain(x.description) })));
      return { results, more: results.length > 0 && Number(json.page ?? page) < Number(json.pages ?? 0) };
    },
  },
};

export const ENGINE_IDS = Object.keys(ENGINES);

/** The engines to try, in order: the chosen one, then the others when fallback is on. */
export function engineOrder(settings, chosen = settings.engine) {
  const usable = (id) => ENGINES[id] && (!ENGINES[id].needsKey || !!settings.mojeekKey);
  const first = usable(chosen) ? [chosen] : [];
  // A paid engine was asked for on purpose: report its failure rather than quietly searching again for free.
  if (first.length && (ENGINES[chosen].paid || !settings.fallback)) return first;
  // Fallbacks are free engines only: a paid engine runs only when it is the one asked for.
  return [...first, ...ENGINE_IDS.filter((id) => id !== chosen && usable(id) && !ENGINES[id].paid)];
}

/** Free engines, for the default-engine setting. */
export const FREE_ENGINE_IDS = ENGINE_IDS.filter((id) => !ENGINES[id].paid);

/** True when the paid engine can be offered as a "Try" button. */
export const canTryMojeek = (settings) => !!settings.mojeekKey;

/** Why each engine that won't be tried is left out, for the activity log. */
export function skippedEngines(settings, chosen = settings.engine) {
  const order = engineOrder(settings, chosen);
  return ENGINE_IDS.filter((id) => !order.includes(id)).map((id) => ({
    id,
    reason:
      ENGINES[id].needsKey && !settings.mojeekKey
        ? 'no API key in Settings'
        : ENGINES[id].paid
          ? 'paid, so only used when you tap “Try Mojeek”'
          : ENGINES[chosen]?.paid
            ? `you asked for ${ENGINES[chosen].name} specifically`
            : 'fallback to other engines is off',
  }));
}

// ---------- network figures ----------

export function formatBytes(n) {
  if (n == null || Number.isNaN(n)) return '?';
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function formatMs(ms) {
  if (ms == null) return '?';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/** Average speed over the whole request (latency included), e.g. "12 KB/s". */
export function formatSpeed(bytes, ms) {
  if (bytes == null || !ms) return '?';
  return `${formatBytes((bytes * 1000) / ms)}/s`;
}

/** Time spent actually transferring a body: total time minus the wait for the first byte (falls back to total for tiny bodies). */
export function transferMs(entry) {
  const t = entry.ms - (entry.ttfb ?? 0);
  return t >= 20 ? t : entry.ms;
}

/** Megabits per second for `bytes` moved in `ms`; null when it can't be worked out. */
export function mbit(bytes, ms) {
  return bytes > 0 && ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : null;
}

export function formatMbit(m) {
  if (m == null) return '?';
  if (m < 1) return `${Math.round(m * 1000)} kbit/s`;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)} Mbit/s`;
}

/** One speed-test result as a line: "1.8 Mbit/s down · 140 ms latency · used 250 KB". */
export function speedLine(r) {
  if (r.error) return `failed: ${r.error}`;
  return `${formatMbit(r.mbit)} down · ${formatMs(r.latency)} latency · used ${formatBytes(r.bytes)}`;
}

/** Wire size text: exact when the service sent Content-Length, "≈" when estimated. */
export function formatWire(entry) {
  if (entry.wire == null) return 'size on the wire unknown';
  return entry.wireKind === 'exact' ? `${formatBytes(entry.wire)} on the wire` : `≈${formatBytes(entry.wire)} on the wire`;
}

/** One line describing a finished request: status, sizes, timings and speed. */
export function describeTransfer(e) {
  if (e.error && e.status == null) return `${e.error} after ${formatMs(e.ms)}`;
  const parts = [`HTTP ${e.status}`, `${formatBytes(e.received)} received`, formatWire(e), `first byte ${formatMs(e.ttfb)}`, `total ${formatMs(e.ms)}`];
  parts.push(`≈${formatSpeed(e.wire ?? e.received, e.ms)}`);
  return parts.join(' · ');
}

const SERVICES = {
  'api.mwmbl.org': 'Mwmbl',
  'api.marginalia.nu': 'Marginalia',
  'www.mojeek.com': 'Mojeek',
  'api.duckduckgo.com': 'DuckDuckGo answers',
  'r.jina.ai': 'Jina Reader',
  'api.open-meteo.com': 'Open-Meteo forecast',
  'geocoding-api.open-meteo.com': 'Open-Meteo places',
  'air-quality-api.open-meteo.com': 'Open-Meteo air quality',
  'archive.org': 'Internet Archive',
  'api.frankfurter.dev': 'Frankfurter (exchange rates)',
  'overpass-api.de': 'OpenStreetMap places (Overpass)',
  'overpass.private.coffee': 'OpenStreetMap places (Overpass)',
  'nominatim.openstreetmap.org': 'OpenStreetMap places (Nominatim)',
  'huggingface.co': 'Hugging Face (AI models)',
  'cdn.jsdelivr.net': 'jsDelivr (AI engine)',
  'speed.cloudflare.com': 'Cloudflare speed test',
};

export function serviceOf(url) {
  const host = hostOf(url);
  if (host.endsWith('.wikipedia.org')) return 'Wikipedia';
  return SERVICES[host] ?? SERVICES[`www.${host}`] ?? host;
}

/** Removes API keys from a URL before it is shown or logged. */
export function redactUrl(raw) {
  try {
    const u = new URL(raw);
    for (const k of ['api_key', 'key', 'token']) if (u.searchParams.has(k)) u.searchParams.set(k, '•••');
    if (u.hostname === 'api.marginalia.nu') {
      const parts = u.pathname.split('/');
      if (parts[1] && parts[1] !== 'public') parts[1] = '•••';
      u.pathname = parts.join('/');
    }
    return decodeURI(u.href);
  } catch {
    return String(raw);
  }
}

// ---------- DuckDuckGo (opened, never read) ----------

/** Regions offered in settings: DuckDuckGo `kl` value per country code. */
export const REGIONS = {
  '': 'Any',
  us: 'United States',
  gb: 'United Kingdom',
  ca: 'Canada',
  au: 'Australia',
  ie: 'Ireland',
  de: 'Germany',
  fr: 'France',
  nl: 'Netherlands',
  es: 'Spain',
  it: 'Italy',
};
const DDG_KL = { us: 'us-en', gb: 'uk-en', ca: 'ca-en', au: 'au-en', ie: 'ie-en', de: 'de-de', fr: 'fr-fr', nl: 'nl-nl', es: 'es-es', it: 'it-it' };

/** True when the query has a DuckDuckGo !bang (e.g. `!w paris`, `maps !g`). */
const COMMON_TLDS = /\.(?:com|org|net|edu|gov|io|co|uk|dev|app|info|wiki|news|me|us|ca|au|de|fr|eu)(?::\d+)?(?:[/?#]|$)/i;

/** A pasted web address → an http(s) URL to open in the reader, or null if it is a search. */
export function asUrl(q) {
  const t = q.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^https?:\/\//i.test(t)) return safeHttpUrl(t);
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/:]+:\d+/.test(t)) return null;
  if (/^(?:www\.|[a-z0-9-]+(?:\.[a-z0-9-]+)*\/)/i.test(t) || COMMON_TLDS.test(t.split('/')[0] + (t.includes('/') ? '/' : ''))) {
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(t)) return null;
    return safeHttpUrl(`https://${t}`);
  }
  return null;
}

export function hasBang(q) {
  return /(^|\s)![a-z0-9]/i.test(q);
}

export function ddgUrl(q, { ddg = 'lite', region = '', safe = false } = {}) {
  const p = new URLSearchParams({ q });
  if (DDG_KL[region]) p.set('kl', DDG_KL[region]);
  if (safe) p.set('kp', '1');
  if (hasBang(q)) return `https://duckduckgo.com/?${p}`;
  return ddg === 'html' ? `https://html.duckduckgo.com/html/?${p}` : `https://lite.duckduckgo.com/lite/?${p}`;
}

// ---------- instant answers ----------

export function instantUrl(q) {
  return `https://api.duckduckgo.com/?${new URLSearchParams({ q, format: 'json', no_html: '1', skip_disambig: '1', t: 'sparse-pwa' })}`;
}

/** The DuckDuckGo Instant Answer API's best single answer, or null. */
export function parseInstant(json, q) {
  if (!json || typeof json !== 'object') return null;
  if (typeof json.Answer === 'string' && json.Answer.trim()) {
    return { heading: clean(json.AnswerType ? q : json.Heading || q), text: clean(json.Answer), url: null, source: 'DuckDuckGo' };
  }
  if (json.AbstractText) {
    return { heading: clean(json.Heading || q), text: clean(json.AbstractText), url: safeHttpUrl(json.AbstractURL), source: clean(json.AbstractSource) };
  }
  if (json.Definition) {
    return { heading: clean(json.Heading || q), text: clean(json.Definition), url: safeHttpUrl(json.DefinitionURL), source: clean(json.DefinitionSource) };
  }
  return null;
}

// ---------- weather (Open-Meteo) ----------

/** `weather`, `weather in Leeds`, `forecast berlin`, `paris weather` → { place } ('' = use location). */
export function weatherIntent(q) {
  const m = /^\s*(?:weather|forecast)(?:\s+(?:in|for|at))?(?:\s+(.*?))?\s*$/i.exec(q) ?? /^\s*(.+?)\s+(?:weather|forecast)\s*$/i.exec(q);
  return m ? { place: (m[1] ?? '').trim() } : null;
}

export function geocodeUrl(place) {
  return `https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: place, count: '1', format: 'json' })}`;
}

export function parseGeocode(json) {
  const r = json?.results?.[0];
  if (!r) return null;
  return { lat: r.latitude, lon: r.longitude, label: [r.name, r.admin1, r.country_code].filter(Boolean).join(', ') };
}

const unitParams = (p, unit) => {
  if (unit !== 'f') return p;
  p.set('temperature_unit', 'fahrenheit');
  p.set('wind_speed_unit', 'mph');
  p.set('precipitation_unit', 'inch');
  return p;
};

/** The basic forecast: now, rain in the next hour (four 15-minute steps) and 3 days. About 0.5 KB gzipped. */
export function forecastUrl(lat, lon, unit = 'c') {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    minutely_15: 'precipitation',
    forecast_minutely_15: '4',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '3',
  });
  return `https://api.open-meteo.com/v1/forecast?${unitParams(p, unit)}`;
}

/** The extra detail behind "More weather": conditions now, 24 hours and 7 days. About 1 KB gzipped. */
export function detailUrl(lat, lon, unit = 'c') {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'relative_humidity_2m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover,visibility',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    forecast_hours: '24',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,uv_index_max,sunrise,sunset',
    timezone: 'auto',
    forecast_days: '7',
  });
  return `https://api.open-meteo.com/v1/forecast?${unitParams(p, unit)}`;
}

/** Air quality now (Open-Meteo's separate air-quality service). About 0.4 KB gzipped. */
export function airUrl(lat, lon) {
  const p = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'european_aqi,us_aqi,pm2_5,pm10,ozone,nitrogen_dioxide,uv_index',
    timezone: 'auto',
  });
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${p}`;
}

const WMO = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
};
export const wmoText = (code) => WMO[code] ?? '—';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v) => (num(v) == null ? null : Math.round(v));

/** "No rain in the next hour", "Rain starting in about 30 min", from four 15-minute amounts. */
export function rainSoon(steps, unit = 'c') {
  const vals = (steps ?? []).map(num);
  if (!vals.length || vals.every((v) => v == null)) return null;
  const wet = (v) => v != null && v >= (unit === 'f' ? 0.004 : 0.1);
  const first = vals.findIndex(wet);
  if (first < 0) return 'No rain expected in the next hour';
  const total = vals.reduce((n, v) => n + (v ?? 0), 0);
  const amt = unit === 'f' ? `${total.toFixed(2)} in` : `${total.toFixed(1)} mm`;
  if (first === 0) return vals.every(wet) ? `Rain for the next hour (${amt})` : `Rain now, easing within the hour (${amt})`;
  return `Rain starting in about ${first * 15} min (${amt} in the next hour)`;
}

export function parseForecast(json, label, unit = 'c') {
  const c = json?.current;
  const d = json?.daily;
  if (!c || !d) return null;
  return {
    label,
    unit: unit === 'f' ? '°F' : '°C',
    wind: unit === 'f' ? 'mph' : 'km/h',
    now: {
      temp: round(c.temperature_2m),
      feels: round(c.apparent_temperature),
      desc: wmoText(c.weather_code),
      wind: round(c.wind_speed_10m),
    },
    rain: rainSoon(json.minutely_15?.precipitation, unit),
    days: (d.time ?? []).map((date, i) => ({
      date,
      hi: round(d.temperature_2m_max[i]),
      lo: round(d.temperature_2m_min[i]),
      desc: wmoText(d.weather_code[i]),
      rain: d.precipitation_probability_max?.[i] ?? null,
    })),
  };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
/** 222 → "SW": the direction the wind comes from. */
export const compass = (deg) => (num(deg) == null ? null : COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]);

/** "2026-10-15T07:28" → "07:28": Open-Meteo's local times for the place, as written. */
const clock = (t) => (typeof t === 'string' && /T\d\d:\d\d/.test(t) ? t.slice(11, 16) : null);

export function parseDetail(json, unit = 'c') {
  const c = json?.current;
  const hr = json?.hourly;
  const d = json?.daily;
  if (!c || !hr || !d) return null;
  const vis = num(c.visibility);
  return {
    now: {
      humidity: round(c.relative_humidity_2m),
      windDir: compass(c.wind_direction_10m),
      gusts: round(c.wind_gusts_10m),
      pressure: round(c.pressure_msl),
      cloud: round(c.cloud_cover),
      visibility: vis == null ? null : unit === 'f' ? `${(vis / 1609.344).toFixed(vis < 16093 ? 1 : 0)} mi` : `${(vis / 1000).toFixed(vis < 10000 ? 1 : 0)} km`,
    },
    hours: (hr.time ?? []).map((t, i) => ({
      time: clock(t),
      temp: round(hr.temperature_2m?.[i]),
      desc: wmoText(hr.weather_code?.[i]),
      rain: hr.precipitation_probability?.[i] ?? null,
    })),
    days: (d.time ?? []).map((date, i) => ({
      date,
      hi: round(d.temperature_2m_max?.[i]),
      lo: round(d.temperature_2m_min?.[i]),
      desc: wmoText(d.weather_code?.[i]),
      rain: d.precipitation_probability_max?.[i] ?? null,
      amount: num(d.precipitation_sum?.[i]),
      wind: round(d.wind_speed_10m_max?.[i]),
      uv: num(d.uv_index_max?.[i]) == null ? null : Math.round(d.uv_index_max[i]),
      sunrise: clock(d.sunrise?.[i]),
      sunset: clock(d.sunset?.[i]),
    })),
    precipUnit: unit === 'f' ? 'in' : 'mm',
  };
}

const EU_AQI = [
  [20, 'Good'],
  [40, 'Fair'],
  [60, 'Moderate'],
  [80, 'Poor'],
  [100, 'Very poor'],
  [Infinity, 'Extremely poor'],
];
const US_AQI = [
  [50, 'Good'],
  [100, 'Moderate'],
  [150, 'Unhealthy for sensitive groups'],
  [200, 'Unhealthy'],
  [300, 'Very unhealthy'],
  [Infinity, 'Hazardous'],
];

/** Air quality on the US scale for US users (°F), the European scale otherwise. */
export function parseAir(json, unit = 'c') {
  const c = json?.current;
  if (!c) return null;
  const us = unit === 'f';
  const index = round(us ? c.us_aqi : c.european_aqi);
  const scale = us ? US_AQI : EU_AQI;
  const uv = num(c.uv_index);
  return {
    index,
    scale: us ? 'US AQI' : 'European AQI',
    label: index == null ? null : scale.find(([max]) => index <= max)[1],
    pm25: num(c.pm2_5),
    pm10: num(c.pm10),
    ozone: round(c.ozone),
    no2: round(c.nitrogen_dioxide),
    uv: uv == null ? null : Math.round(uv * 10) / 10,
  };
}

/** UV index 0–2 low, 3–5 moderate, 6–7 high, 8–10 very high, 11+ extreme. */
export function uvText(uv) {
  if (num(uv) == null) return null;
  const r = Math.round(uv);
  return `${r} (${r <= 2 ? 'low' : r <= 5 ? 'moderate' : r <= 7 ? 'high' : r <= 10 ? 'very high' : 'extreme'})`;
}

/** °F for US locales, °C elsewhere, unless the setting says otherwise. */
export function resolveUnit(setting, locale = 'en-US') {
  if (setting === 'c' || setting === 'f') return setting;
  return /-(US|LR|MM)\b/i.test(locale) ? 'f' : 'c';
}

// ---------- Internet Archive (Wayback Machine) ----------

/** The availability lookup: about 0.2 KB, and it allows browser calls. */
export function waybackLookupUrl(url) {
  return `https://archive.org/wayback/available?${new URLSearchParams({ url })}`;
}

/** "20261004161959" → epoch ms (UTC), or null. */
export function waybackTime(ts) {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)?(\d\d)?(\d\d)?$/.exec(String(ts ?? ''));
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  return Number.isNaN(t) ? null : t;
}

/** The closest snapshot from a lookup, or null when the archive has none. */
export function parseWayback(json, original) {
  const s = json?.archived_snapshots?.closest;
  if (!s?.available || String(s.status) !== '200' || !/^\d{8,14}$/.test(String(s.timestamp))) return null;
  return {
    ts: String(s.timestamp),
    at: waybackTime(s.timestamp),
    original,
    view: waybackViewUrl(s.timestamp, original),
    raw: waybackRawUrl(s.timestamp, original),
  };
}

/** The snapshot as the archive shows it, with its toolbar (for opening in Safari). */
export const waybackViewUrl = (ts, url) => `https://web.archive.org/web/${ts}/${url}`;
/** The snapshot exactly as archived, without the toolbar or rewritten links (for the reader). */
export const waybackRawUrl = (ts, url) => `https://web.archive.org/web/${ts}id_/${url}`;

/** `https://web.archive.org/web/<ts>[id_]/<original>` → { ts, original }, or null. */
export function parseWaybackUrl(u) {
  const m = /^https?:\/\/web\.archive\.org\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(.+)$/i.exec(String(u ?? ''));
  if (!m) return null;
  const original = safeHttpUrl(/^https?:\/\//i.test(m[2]) ? m[2] : `http://${m[2]}`);
  return original ? { ts: m[1], at: waybackTime(m[1]), original } : null;
}

/**
 * Links inside an archived page. The raw snapshot keeps the page's own links, but relative ones
 * resolve against web.archive.org; send those back to the original site.
 */
export function unarchiveLink(href, original) {
  try {
    const u = new URL(href);
    if (u.hostname !== 'web.archive.org' || u.pathname.startsWith('/web/')) return href;
    return new URL(u.pathname + u.search + u.hash, original).href;
  } catch {
    return href;
  }
}

// ---------- reader (Jina Reader) ----------

export function readerUrl(u) {
  return `https://r.jina.ai/${u}`;
}

/** The human-readable reason from a Jina Reader error body (JSON), or ''. */
export function jinaError(body) {
  try {
    const j = JSON.parse(body);
    return clean(j.message || j.readableMessage || j.name || '');
  } catch {
    return '';
  }
}

/** Splits Jina Reader's text output into its header fields and the Markdown body. */
export function parseJina(text) {
  const marker = 'Markdown Content:';
  const idx = text.indexOf(marker);
  const head = idx >= 0 ? text.slice(0, idx) : '';
  const body = idx >= 0 ? text.slice(idx + marker.length) : text;
  const field = (name) => new RegExp(`^${name}:[ \\t]*(.*)$`, 'm').exec(head)?.[1].trim() ?? '';
  return { title: field('Title'), source: field('URL Source'), published: field('Published Time'), markdown: body.trim() };
}

// ---------- Markdown → blocks ----------
// Inline nodes: {t:'text', s} | {t:'b'|'i', c:[...]} | {t:'code', s} | {t:'link', href, c:[...]}
// Blocks: {type:'h', level, c} | {type:'p', c} | {type:'list', ordered, items:[{c, depth}]} |
//         {type:'quote', c} | {type:'pre', text} | {type:'table', rows:[[c]]} | {type:'hr'}
// Images are dropped (this is a low-bandwidth reader); links pointing anywhere but http(s) become text.

function findClose(s, from, open, close) {
  let depth = 0;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}

function linkTarget(raw) {
  const m = /^\s*<?([^\s>]*)>?(?:\s+["'(].*)?\s*$/s.exec(raw);
  return m ? m[1] : '';
}

export function parseInline(s, base) {
  const out = [];
  let buf = '';
  const text = (t) => (buf += t);
  const push = (node) => {
    if (buf) out.push({ t: 'text', s: buf });
    buf = '';
    out.push(node);
  };
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) {
      text(s[i + 1]);
      i += 2;
      continue;
    }
    if ((ch === '!' && s[i + 1] === '[') || ch === '[') {
      const start = ch === '!' ? i + 1 : i;
      const close = findClose(s, start, '[', ']');
      if (close > 0 && s[close + 1] === '(') {
        const end = findClose(s, close + 1, '(', ')');
        if (end > 0) {
          if (ch !== '!') {
            const href = safeHttpUrl(linkTarget(s.slice(close + 2, end)), base);
            const c = parseInline(s.slice(start + 1, close), base);
            if (inlineText(c).trim()) {
              if (href) push({ t: 'link', href, c });
              else for (const n of c) n.t === 'text' ? text(n.s) : push(n);
            }
          }
          i = end + 1;
          continue;
        }
      }
      text(ch);
      i++;
      continue;
    }
    if (ch === '<') {
      const m = /^<(https?:\/\/[^\s>]+)>/.exec(s.slice(i));
      if (m) {
        const href = safeHttpUrl(m[1]);
        if (href) push({ t: 'link', href, c: [{ t: 'text', s: m[1] }] });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) {
        push({ t: 'code', s: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] === ch) {
      const end = s.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        push({ t: 'b', c: parseInline(s.slice(i + 2, end), base) });
        i = end + 2;
        continue;
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] && !/\s/.test(s[i + 1]) && !(ch === '_' && /\w/.test(s[i - 1] ?? ''))) {
      let end = -1;
      for (let j = i + 1; j < s.length; j++) {
        if (s[j] === '\\') j++;
        else if (s[j] !== ch) continue;
        else if (s[j + 1] === ch)
          j++; // part of a ** or __ pair
        else if (!/\s/.test(s[j - 1]) && !(ch === '_' && /\w/.test(s[j + 1] ?? ''))) {
          end = j;
          break;
        }
      }
      if (end > i + 1) {
        push({ t: 'i', c: parseInline(s.slice(i + 1, end), base) });
        i = end + 1;
        continue;
      }
    }
    text(ch);
    i++;
  }
  if (buf) out.push({ t: 'text', s: buf });
  return out;
}

export function inlineText(nodes) {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.s : inlineText(n.c))).join('');
}

/** Characters of text outside links: 0 means the block is navigation. */
function unlinkedText(nodes) {
  return nodes
    .map((n) => (n.t === 'link' ? '' : n.t === 'text' || n.t === 'code' ? n.s : unlinkedText(n.c)))
    .join('')
    .replace(/[\s|·•,–—-]/g, '').length;
}

const LIST_RE = /^(\s*)([*+-]|\d+[.)])\s+(.*)$/;
const HR_RE = /^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;

export function parseMarkdown(md, base) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  const inl = (s) => parseInline(s, base);
  const flush = () => {
    if (para.length) {
      const c = inl(para.join(' '));
      if (inlineText(c).trim()) blocks.push({ type: 'p', c });
    }
    para = [];
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      flush();
      const fence = t.slice(0, 3);
      const buf = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence); i++) buf.push(lines[i]);
      blocks.push({ type: 'pre', text: buf.join('\n') });
      i++;
      continue;
    }
    if (!t) {
      flush();
      i++;
      continue;
    }
    let m;
    if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t))) {
      flush();
      const c = inl(m[2]);
      if (inlineText(c).trim()) blocks.push({ type: 'h', level: m[1].length, c });
      i++;
      continue;
    }
    const next = lines[i + 1]?.trim() ?? '';
    if (!LIST_RE.test(line) && !t.startsWith('>') && !t.startsWith('|') && /^(=+|-+)$/.test(next) && !HR_RE.test(t)) {
      const c = inl([...para, t].join(' '));
      para = [];
      if (inlineText(c).trim()) blocks.push({ type: 'h', level: next[0] === '=' ? 1 : 2, c });
      i += 2;
      continue;
    }
    if (HR_RE.test(t)) {
      flush();
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }
    if ((m = LIST_RE.exec(line))) {
      flush();
      const ordered = /\d/.test(m[2]);
      const items = [];
      while (i < lines.length) {
        const lm = LIST_RE.exec(lines[i]);
        if (lm) {
          if (items.length && !lm[1] && /\d/.test(lm[2]) !== ordered) break; // a new top-level list of the other kind
          items.push({ depth: Math.min(3, Math.floor(lm[1].replace(/\t/g, '    ').length / 2)), raw: [lm[3]] });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].raw.push(lines[i].trim());
          i++;
        } else if (!lines[i].trim() && LIST_RE.test(lines[i + 1] ?? '')) {
          i++;
        } else break;
      }
      const parsed = items.map((it) => ({ depth: it.depth, c: inl(it.raw.join(' ')) })).filter((it) => inlineText(it.c).trim());
      if (parsed.length) blocks.push({ type: 'list', ordered, items: parsed });
      continue;
    }
    if (t.startsWith('>')) {
      flush();
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) buf.push(lines[i++].trim().replace(/^>\s?/, ''));
      const inner = parseMarkdown(buf.join('\n'), base);
      const c = inner.flatMap((b, k) => [...(k ? [{ t: 'text', s: ' ' }] : []), ...(b.c ?? [])]);
      if (inlineText(c).trim()) blocks.push({ type: 'quote', c });
      continue;
    }
    if (t.startsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = lines[i++].trim().replace(/^\|/, '').replace(/\|$/, '');
        if (/^[\s|:-]+$/.test(row)) continue;
        rows.push(row.split(/(?<!\\)\|/).map((cell) => inl(cell.trim())));
      }
      if (rows.length) blocks.push({ type: 'table', rows });
      continue;
    }
    para.push(t);
    i++;
  }
  flush();
  return blocks;
}

function linkOnly(b) {
  if (b.type === 'p' || b.type === 'quote') return unlinkedText(b.c) === 0;
  if (b.type === 'list') return b.items.every((it) => unlinkedText(it.c) === 0);
  if (b.type === 'table') return b.rows.every((r) => r.every((c) => unlinkedText(c) === 0));
  return b.type === 'hr';
}

/** Drops the site navigation at the top of a page: link-only blocks before the first real content. */
export function trimNav(blocks) {
  const first = blocks.findIndex((b) => !linkOnly(b));
  return first < 0 ? blocks : blocks.slice(first);
}

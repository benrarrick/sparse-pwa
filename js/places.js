// Nearby places from OpenStreetMap: "coffee near me", "pharmacy near Leeds", "Tesco near me".
// Overpass answers first; Nominatim is the fallback (Overpass is often at capacity).
// Opening hours come from the OSM `opening_hours` tag; a small reader works out "open now" for the common patterns
// and says nothing when a pattern is beyond it.

// ---------- what to look for ----------

// [words people type, label, Overpass filters, Nominatim phrase]
const TYPES = [
  [['coffee', 'coffee shop', 'coffee shops', 'cafe', 'cafes', 'café', 'cafés', 'coffeeshop'], 'Cafés', ['amenity=cafe'], 'cafe'],
  [['restaurant', 'restaurants', 'food', 'place to eat', 'places to eat', 'dinner', 'lunch', 'takeaway', 'takeaways'], 'Restaurants', ['amenity=restaurant', 'amenity=fast_food'], 'restaurant'],
  [['pizza', 'pizzeria', 'pizzas'], 'Pizza', ['cuisine=pizza'], 'pizza'],
  [['pub', 'pubs', 'bar', 'bars'], 'Pubs and bars', ['amenity=pub', 'amenity=bar'], 'pub'],
  [['pharmacy', 'pharmacies', 'chemist', 'chemists', 'drugstore', 'drugstores'], 'Pharmacies', ['amenity=pharmacy'], 'pharmacy'],
  [['atm', 'atms', 'cash machine', 'cash machines', 'cashpoint', 'cashpoints'], 'Cash machines', ['amenity=atm'], 'atm'],
  [['bank', 'banks'], 'Banks', ['amenity=bank'], 'bank'],
  [['toilet', 'toilets', 'restroom', 'restrooms', 'bathroom', 'bathrooms', 'public toilet', 'public toilets', 'loo', 'wc'], 'Toilets', ['amenity=toilets'], 'toilets'],
  [['supermarket', 'supermarkets', 'grocery', 'groceries', 'grocery store', 'grocery stores', 'shop', 'shops', 'convenience store', 'convenience stores'], 'Supermarkets and shops', ['shop=supermarket', 'shop=convenience'], 'supermarket'],
  [['bakery', 'bakeries'], 'Bakeries', ['shop=bakery'], 'bakery'],
  [['petrol station', 'petrol stations', 'gas station', 'gas stations', 'fuel', 'petrol', 'gas'], 'Fuel', ['amenity=fuel'], 'fuel'],
  [['ev charger', 'ev chargers', 'charging station', 'charging stations', 'ev charging'], 'EV charging', ['amenity=charging_station'], 'charging station'],
  [['hospital', 'hospitals', 'a&e', 'emergency room', 'er'], 'Hospitals', ['amenity=hospital'], 'hospital'],
  [['doctor', 'doctors', 'gp', 'clinic', 'clinics', 'urgent care'], 'Doctors and clinics', ['amenity=doctors', 'amenity=clinic'], 'clinic'],
  [['dentist', 'dentists'], 'Dentists', ['amenity=dentist'], 'dentist'],
  [['hotel', 'hotels', 'hostel', 'hostels', 'place to stay', 'places to stay', 'accommodation'], 'Places to stay', ['tourism=hotel', 'tourism=hostel', 'tourism=guest_house'], 'hotel'],
  [['parking', 'car park', 'car parks', 'parking lot', 'parking lots'], 'Parking', ['amenity=parking'], 'parking'],
  [['bus stop', 'bus stops'], 'Bus stops', ['highway=bus_stop'], 'bus stop'],
  [['train station', 'train stations', 'station', 'stations', 'subway', 'metro', 'tube station'], 'Stations', ['railway=station', 'railway=subway_entrance'], 'station'],
  [['library', 'libraries'], 'Libraries', ['amenity=library'], 'library'],
  [['post office', 'post offices', 'postbox', 'mail'], 'Post offices', ['amenity=post_office'], 'post office'],
  [['museum', 'museums'], 'Museums', ['tourism=museum'], 'museum'],
  [['park', 'parks'], 'Parks', ['leisure=park'], 'park'],
  [['playground', 'playgrounds'], 'Playgrounds', ['leisure=playground'], 'playground'],
  [['gym', 'gyms', 'fitness'], 'Gyms', ['leisure=fitness_centre'], 'gym'],
  [['cinema', 'cinemas', 'movie theater', 'movie theaters', 'movies', 'movie theatre'], 'Cinemas', ['amenity=cinema'], 'cinema'],
  [['laundry', 'laundromat', 'launderette', 'laundrette'], 'Laundries', ['shop=laundry'], 'laundry'],
  [['water', 'drinking water', 'water fountain', 'water fountains'], 'Drinking water', ['amenity=drinking_water'], 'drinking water'],
  [['police', 'police station'], 'Police', ['amenity=police'], 'police'],
  [['school', 'schools'], 'Schools', ['amenity=school'], 'school'],
  [['barber', 'barbers', 'hairdresser', 'hairdressers', 'haircut'], 'Hairdressers', ['shop=hairdresser', 'shop=barber'], 'hairdresser'],
  [['bike shop', 'bike shops', 'bicycle shop', 'bike repair'], 'Bike shops', ['shop=bicycle'], 'bicycle'],
  [['hardware store', 'hardware stores', 'diy'], 'Hardware stores', ['shop=doityourself', 'shop=hardware'], 'hardware'],
];
const BY_WORD = new Map();
for (const t of TYPES) for (const w of t[0]) BY_WORD.set(w, t);

/** Chips on the home page: [label, search]. */
export const QUICK_SEARCHES = [
  ['Coffee', 'coffee near me'],
  ['Food', 'restaurants near me'],
  ['Pharmacy', 'pharmacy near me'],
  ['Cash machine', 'atm near me'],
  ['Toilets', 'toilets near me'],
  ['Supermarket', 'supermarket near me'],
  ['Fuel', 'petrol station near me'],
];

const HERE = '(?:near me|nearby|near here|around me|around here|close to me|close by|closest|nearest|near my location)';
const FILLER = /^(?:the |a |an |some |best |good |cheap |open |nearest |closest |find |find me |show me |where is the |where is |where can i find |where to find |is there a |any )+/;
const NOT_A_PLACE = /\b(how|what|why|when|who|can|should|does|do|is|are|was|were|will|to|vs|versus|review|reviews|history|recipe|recipes|jobs|job|news|price|prices|meaning)\b/;

/**
 * "coffee near me" → { type, label, term, place: '' }; "pharmacy near Leeds" → place 'Leeds'.
 * A word that isn't a known kind of place is searched by name, but only for "near me" ("Tesco near me").
 */
export function placesIntent(q) {
  const s = String(q).trim().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  if (!s || s.length > 80) return null;
  let term;
  let place = '';
  let m = new RegExp(`^(.+?)\\s+${HERE}$`, 'i').exec(s) ?? new RegExp(`^${HERE}\\s+(.+)$`, 'i').exec(s);
  if (m) term = m[1];
  else if ((m = /^(.+?)\s+(?:near|around|close to|by)\s+(.+)$/i.exec(s))) {
    term = m[1];
    place = m[2].trim();
  } else return null;
  term = term.toLowerCase().replace(FILLER, '').replace(/\s+(?:open now|open|available)$/, '').trim();
  if (!term || place.length > 60) return null;
  const known = BY_WORD.get(term) ?? BY_WORD.get(term.replace(/s$/, ''));
  if (known) return { type: known, label: known[1], term, place };
  if (place || NOT_A_PLACE.test(term) || term.split(' ').length > 3 || term.length < 3 || term.length > 40) return null;
  return { type: null, label: `“${term}”`, term, place };
}

// ---------- distance ----------

const rad = (d) => (d * Math.PI) / 180;

/** Metres between two points. */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/** Degrees clockwise from north, from a to b. */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const direction = (deg) => POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** 140 m · 1.2 km · 0.4 mi · 300 ft. */
export function formatDistance(m, imperial = false) {
  if (imperial) {
    const ft = m * 3.28084;
    return ft < 1000 ? `${Math.round(ft / 10) * 10 || 10} ft` : `${(m / 1609.344).toFixed(m < 16093 ? 1 : 0)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 10) * 10 || 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// ---------- requests ----------

export const OVERPASS_HOSTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

const esc = (s) => String(s).replace(/[\\"]/g, '\\$&');
const escRegex = (s) => esc(String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

function filterOf(f) {
  const [k, v] = f.split('=');
  return `["${esc(k)}"="${esc(v)}"]`;
}

/** The Overpass query: places of this type (or with this name) within `radius` metres. */
export function overpassQuery(lat, lon, radius, intent, limit = 60) {
  const around = `(around:${Math.round(radius)},${lat.toFixed(5)},${lon.toFixed(5)})`;
  const parts = intent.type
    ? intent.type[2].map((f) => `nwr${around}${filterOf(f)};`)
    : [`nwr${around}["name"~"${escRegex(intent.term)}",i][~"^(amenity|shop|tourism|leisure|office|craft)$"~"."];`];
  return `[out:json][timeout:10];(${parts.join('')});out tags center ${limit};`;
}

export const overpassUrl = (host, query) => `${host}?${new URLSearchParams({ data: query })}`;

/** Nominatim as a fallback: a box around the point, bounded, so results are close. */
export function nominatimUrl(lat, lon, radius, intent, limit = 25) {
  const dLat = radius / 111320;
  const dLon = radius / (111320 * Math.max(0.2, Math.cos(rad(lat))));
  return `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
    q: intent.type ? intent.type[3] : intent.term,
    viewbox: [lon - dLon, lat + dLat, lon + dLon, lat - dLat].map((n) => n.toFixed(5)).join(','),
    bounded: '1',
    limit: String(limit),
    extratags: '1',
    format: 'jsonv2',
    'accept-language': typeof navigator === 'undefined' ? 'en' : navigator.language || 'en',
  })}`;
}

// ---------- results ----------

const kindLabel = (tags) => {
  const k = tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure ?? tags.railway ?? tags.highway ?? tags.office ?? tags.craft ?? '';
  return String(k).replace(/_/g, ' ');
};

function address(tags) {
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  return [street, tags['addr:city'] ?? tags['addr:suburb']].filter(Boolean).join(', ');
}

const phoneOf = (t) => t.phone ?? t['contact:phone'] ?? '';
const webOf = (t) => t.website ?? t['contact:website'] ?? '';
const safeWeb = (u) => (/^https?:\/\//i.test(u) ? u : '');

function finish(list, origin, max) {
  const seen = new Set();
  return list
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
    .map((p) => ({ ...p, dist: Math.round(distance(origin, p)), dir: direction(bearing(origin, p)) }))
    .sort((a, b) => a.dist - b.dist)
    .filter((p) => {
      const key = `${p.name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

/** Overpass JSON → up to `max` places, nearest first. Unnamed ones are kept only when `keepUnnamed`. */
export function parseOverpass(json, origin, { max = 10, keepUnnamed = false, label = '' } = {}) {
  const list = [];
  for (const e of json?.elements ?? []) {
    const t = e.tags ?? {};
    const name = String(t.name ?? t.brand ?? t.operator ?? '').trim();
    if (!name && !keepUnnamed) continue;
    list.push({
      name: name || label || kindLabel(t) || 'Unnamed',
      kind: kindLabel(t),
      lat: e.lat ?? e.center?.lat,
      lon: e.lon ?? e.center?.lon,
      hours: t.opening_hours ?? '',
      address: address(t),
      phone: phoneOf(t),
      web: safeWeb(webOf(t)),
    });
  }
  return finish(list, origin, max);
}

/** Nominatim JSON → the same shape. */
export function parseNominatim(json, origin, { max = 10, keepUnnamed = false, label = '' } = {}) {
  const list = [];
  for (const r of Array.isArray(json) ? json : []) {
    const x = r.extratags ?? {};
    const name = String(r.name ?? '').trim();
    if (!name && !keepUnnamed) continue;
    const rest = String(r.display_name ?? '')
      .split(', ')
      .slice(name ? 1 : 0, 3)
      .join(', ');
    list.push({
      name: name || label || String(r.type ?? '').replace(/_/g, ' ') || 'Unnamed',
      kind: String(r.type ?? '').replace(/_/g, ' '),
      lat: Number(r.lat),
      lon: Number(r.lon),
      hours: x.opening_hours ?? '',
      address: rest,
      phone: phoneOf(x),
      web: safeWeb(webOf(x)),
    });
  }
  return finish(list, origin, max);
}

// ---------- opening hours ----------

const DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseDays(spec) {
  const set = new Set();
  for (const part of spec.split(',')) {
    const m = /^(mo|tu|we|th|fr|sa|su)(?:-(mo|tu|we|th|fr|sa|su))?$/.exec(part.trim());
    if (!m) return null;
    let i = DAYS.indexOf(m[1]);
    const end = DAYS.indexOf(m[2] ?? m[1]);
    for (let n = 0; n < 8; n++) {
      set.add(i);
      if (i === end) break;
      i = (i + 1) % 7;
    }
  }
  return set;
}

const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v <= 1440 && Number(m[2]) < 60 ? v : null;
};

/**
 * Reads the common shapes of an OSM opening_hours value into rules, or null if it uses something beyond them
 * (months, week numbers, sunrise, "+", comments).
 * "Mo-Fr 08:00-18:00; Sa 09:00-13:00; Su off" · "24/7" · "Mo-Su 10:00-22:00" · "Tu,Th 09:00-12:00,13:00-17:00"
 */
export function parseHours(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^24\/7$/i.test(text)) return [{ days: new Set([0, 1, 2, 3, 4, 5, 6]), spans: [[0, 1440]] }];
  const rules = [];
  for (const piece of text.split(';')) {
    const p = piece.trim().toLowerCase();
    if (!p) continue;
    const m = /^((?:(?:mo|tu|we|th|fr|sa|su)(?:-(?:mo|tu|we|th|fr|sa|su))?,?)+)?\s*(.*)$/.exec(p);
    if (!m) return null;
    const rest = m[2].trim();
    if (/\bph\b/.test(p) && !m[1]) continue; // public holidays: not worked out
    if (/[a-z]/.test(rest.replace(/^(off|closed)$/, ''))) return null; // months, "sunrise", comments…
    const days = m[1] ? parseDays(m[1].replace(/,$/, '')) : new Set([0, 1, 2, 3, 4, 5, 6]);
    if (!days) return null;
    if (/^(off|closed)$/.test(rest)) {
      rules.push({ days, spans: [] });
      continue;
    }
    if (rest.includes('+')) return null;
    const spans = [];
    for (const span of rest.split(',')) {
      const [a, b] = span.trim().split('-').map((x) => minutes(x.trim()));
      if (a == null || b == null) return null;
      spans.push([a, b]);
    }
    if (!spans.length) return null;
    rules.push({ days, spans });
  }
  return rules.length ? rules : null;
}

const hhmm = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** The spans on a weekday: the last matching rule wins. */
function spansFor(rules, day) {
  let spans = [];
  for (const r of rules) if (r.days.has(day)) spans = r.spans;
  return spans;
}

/**
 * { open: true|false, text } for a Date, or null if the hours can't be read.
 * Uses the device's clock, so it only makes sense for places where the device is.
 */
export function openStatus(raw, date = new Date()) {
  const rules = parseHours(raw);
  if (!rules) return null;
  const day = date.getDay();
  const now = date.getHours() * 60 + date.getMinutes();
  // Today's spans (an overnight span ends after midnight), then yesterday's overnight spill into this morning.
  for (const [a, b] of spansFor(rules, day)) {
    if (b > a ? now >= a && now < b : now >= a) return { open: true, text: `Open until ${hhmm(b)}` };
  }
  for (const [a, b] of spansFor(rules, (day + 6) % 7)) {
    if (b < a && now < b) return { open: true, text: `Open until ${hhmm(b)}` };
  }
  for (let d = 0; d < 8; d++) {
    const spans = spansFor(rules, (day + d) % 7)
      .map(([a]) => a)
      .sort((x, y) => x - y)
      .filter((a) => d > 0 || a > now);
    if (spans.length) return { open: false, text: d === 0 ? `Closed now · opens ${hhmm(spans[0])}` : `Closed now · opens ${d === 1 ? 'tomorrow' : DAY_NAMES[(day + d) % 7]} ${hhmm(spans[0])}` };
  }
  return { open: false, text: 'Closed' };
}

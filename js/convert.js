// Currency and unit conversion: "50 eur to usd", "$20 in pounds", "5 miles to km", "72 f in c", "500 mb to gb".
// Units are worked out on the device and need no connection. Currency uses one small download of
// European Central Bank rates (Frankfurter), kept for 6 hours and shared by every pair.

// ---------- numbers ----------

/** "1,250.5" → 1250.5; null when it isn't a plain number. */
export function parseNumber(s) {
  if (s == null || s === '') return null;
  const t = String(s).replace(/,/g, '');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : null;
}

/** A number for a card: 1,234.57 · 0.8461 · 0.000123 · 1.2e9. */
export function formatNumber(n, locale) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  if (a >= 1e12 || a < 1e-6) return n.toExponential(3).replace(/\.?0+e/, 'e');
  const opts = a >= 1 ? { maximumFractionDigits: a >= 1000 ? 2 : 4 } : { maximumSignificantDigits: 4 };
  return new Intl.NumberFormat(locale, opts).format(n);
}

// ---------- currency ----------

/** Codes the app will recognise (the rates download decides which actually have a rate). */
export const CURRENCY_CODES = new Set(
  'AED ARS AUD BDT BGN BRL CAD CHF CLP CNY COP CZK DKK EGP EUR GBP HKD HUF IDR ILS INR ISK JPY KES KRW KWD MXN MYR NGN NOK NZD PEN PHP PKR PLN QAR RON RUB SAR SEK SGD THB TRY TWD UAH USD VND ZAR'.split(' '),
);

const CURRENCY_NAMES = {
  dollar: 'USD', 'us dollar': 'USD', 'u.s. dollar': 'USD', 'american dollar': 'USD', buck: 'USD', usd: 'USD',
  euro: 'EUR', eur: 'EUR',
  pound: 'GBP', 'pound sterling': 'GBP', sterling: 'GBP', quid: 'GBP', 'british pound': 'GBP', gbp: 'GBP', 'uk pound': 'GBP',
  yen: 'JPY', 'japanese yen': 'JPY',
  yuan: 'CNY', renminbi: 'CNY', rmb: 'CNY', 'chinese yuan': 'CNY',
  rupee: 'INR', 'indian rupee': 'INR',
  franc: 'CHF', 'swiss franc': 'CHF',
  'canadian dollar': 'CAD', 'australian dollar': 'AUD', 'aussie dollar': 'AUD', 'new zealand dollar': 'NZD', 'nz dollar': 'NZD', kiwi: 'NZD',
  'singapore dollar': 'SGD', 'hong kong dollar': 'HKD', 'taiwan dollar': 'TWD', 'new taiwan dollar': 'TWD',
  krona: 'SEK', 'swedish krona': 'SEK', krone: 'NOK', 'norwegian krone': 'NOK', 'danish krone': 'DKK',
  won: 'KRW', 'korean won': 'KRW', 'south korean won': 'KRW',
  baht: 'THB', 'thai baht': 'THB', lira: 'TRY', 'turkish lira': 'TRY',
  zloty: 'PLN', zlotys: 'PLN', forint: 'HUF', koruna: 'CZK', leu: 'RON', rand: 'ZAR', 'south african rand': 'ZAR',
  real: 'BRL', reais: 'BRL', 'brazilian real': 'BRL', peso: 'MXN', 'mexican peso': 'MXN', 'philippine peso': 'PHP', 'argentine peso': 'ARS',
  'colombian peso': 'COP', 'chilean peso': 'CLP', 'egyptian pound': 'EGP', shekel: 'ILS', shekels: 'ILS', 'israeli shekel': 'ILS',
  ringgit: 'MYR', rupiah: 'IDR', dirham: 'AED', 'uae dirham': 'AED', riyal: 'SAR', 'saudi riyal': 'SAR', 'qatari riyal': 'QAR', dinar: 'KWD',
  naira: 'NGN', shilling: 'KES', 'kenyan shilling': 'KES', dong: 'VND', hryvnia: 'UAH', ruble: 'RUB', rouble: 'RUB', 'pakistani rupee': 'PKR', taka: 'BDT', sol: 'PEN',
};
const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₺': 'TRY', '₽': 'RUB', '₪': 'ILS', '฿': 'THB', '₫': 'VND', zł: 'PLN' };

/** "usd", "Euros", "pounds", "$" → 'USD' | 'EUR' | 'GBP'… or null. */
export function currencyCode(token) {
  const t = String(token ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!t) return null;
  if (SYMBOLS[t]) return SYMBOLS[t];
  if (/^[a-z]{3}$/.test(t) && CURRENCY_CODES.has(t.toUpperCase())) return t.toUpperCase();
  if (CURRENCY_NAMES[t]) return CURRENCY_NAMES[t];
  const singular = t.replace(/(?:ies)$/, 'y').replace(/s$/, '');
  return CURRENCY_NAMES[singular] ?? CURRENCY_NAMES[t.replace(/es$/, '')] ?? null;
}

const CONNECT = '(?:to|in|into|as|=|->|→|vs\\.?|versus)';
const SYMBOL_CLASS = '[$€£¥₹₩₺₽₪฿₫]';

/**
 * "50 eur to usd" → { amount: 50, from: 'EUR', to: 'USD' }. A bare pair ("usd gbp", "usd to gbp") is one unit.
 * Returns null when either side isn't a currency, so unit conversion gets a turn.
 */
export function currencyIntent(q) {
  let s = String(q).trim().toLowerCase().replace(/[?!.]+$/, '').replace(/\s+/g, ' ');
  s = s.replace(/^(?:convert|how much is|how many|what is|what's|whats)\s+/, '');
  let m = new RegExp(`^(${SYMBOL_CLASS})?\\s*(-?[\\d][\\d,]*(?:\\.\\d+)?|\\.\\d+)?\\s*([a-z$€£¥₹₩₺₽₪฿₫ .]+?)\\s+${CONNECT}\\s+([a-z ]+?)$`).exec(s);
  let amount;
  let from;
  let to;
  if (m) {
    const [, sym, num, fromTok, toTok] = m;
    amount = num == null ? 1 : parseNumber(num);
    from = sym ? SYMBOLS[sym] : currencyCode(fromTok);
    if (sym && fromTok.trim()) return null;
    to = currencyCode(toTok);
  } else if ((m = /^([a-z]{3})\s+([a-z]{3})$/.exec(s))) {
    amount = 1;
    from = currencyCode(m[1]);
    to = currencyCode(m[2]);
  } else if ((m = new RegExp(`^(${SYMBOL_CLASS})\\s*(-?[\\d][\\d,]*(?:\\.\\d+)?)\\s*${CONNECT}\\s+([a-z ]+?)$`).exec(s))) {
    amount = parseNumber(m[2]);
    from = SYMBOLS[m[1]];
    to = currencyCode(m[3]);
  } else if ((m = /^(-?[\d][\d,]*(?:\.\d+)?)\s*([a-z]{3})\s*$/.exec(s))) {
    return null; // "50 usd" alone is not a question
  }
  if (amount == null || !from || !to || from === to) return null;
  return { amount, from, to };
}

/** The tiny rates request: every currency we recognise against the euro, in one download. */
export function ratesUrl() {
  return `https://api.frankfurter.dev/v2/rates?${new URLSearchParams({ base: 'EUR', quotes: [...CURRENCY_CODES].filter((c) => c !== 'EUR').join(',') })}`;
}

/** Older shape, used only if the current one fails. */
export function ratesFallbackUrl() {
  return 'https://api.frankfurter.dev/v1/latest';
}

/** Both Frankfurter shapes → { date, rates: { EUR: 1, USD: 1.12, … } } (per 1 EUR), or null. */
export function parseRates(json) {
  let rates;
  let date = '';
  if (Array.isArray(json)) {
    rates = { EUR: 1 };
    for (const r of json) {
      if (r && typeof r.quote === 'string' && Number(r.rate) > 0) {
        rates[r.quote] = Number(r.rate);
        if (String(r.date) > date) date = String(r.date);
      }
    }
  } else if (json && typeof json.rates === 'object' && json.rates) {
    rates = { EUR: 1 };
    for (const [k, v] of Object.entries(json.rates)) if (Number(v) > 0) rates[k] = Number(v);
    date = String(json.date ?? '');
  }
  return rates && Object.keys(rates).length > 1 ? { date, rates } : null;
}

/** Converts using euro-based rates. null if either currency has no rate. */
export function convertCurrency(amount, from, to, rates) {
  if (!rates?.[from] || !rates?.[to]) return null;
  const unit = rates[to] / rates[from];
  return { value: amount * unit, unit };
}

// ---------- units ----------

// Each dimension: units as [aliases, factor to the base unit, label].
const DIMENSIONS = {
  length: [
    [['m', 'meter', 'meters', 'metre', 'metres'], 1, 'm'],
    [['km', 'kilometer', 'kilometers', 'kilometre', 'kilometres', 'kms'], 1000, 'km'],
    [['cm', 'centimeter', 'centimeters', 'centimetre', 'centimetres'], 0.01, 'cm'],
    [['mm', 'millimeter', 'millimeters', 'millimetre', 'millimetres'], 0.001, 'mm'],
    [['mi', 'mile', 'miles'], 1609.344, 'mi'],
    [['yd', 'yard', 'yards'], 0.9144, 'yd'],
    [['ft', 'foot', 'feet'], 0.3048, 'ft'],
    [['in', 'inch', 'inches'], 0.0254, 'in'],
    [['nmi', 'nautical mile', 'nautical miles'], 1852, 'nmi'],
  ],
  mass: [
    [['g', 'gram', 'grams', 'gramme', 'grammes'], 1, 'g'],
    [['kg', 'kilo', 'kilos', 'kilogram', 'kilograms', 'kilogramme', 'kilogrammes'], 1000, 'kg'],
    [['mg', 'milligram', 'milligrams'], 0.001, 'mg'],
    [['t', 'tonne', 'tonnes', 'metric ton', 'metric tons'], 1e6, 't'],
    [['lb', 'lbs', 'pound', 'pounds'], 453.59237, 'lb'],
    [['oz', 'ounce', 'ounces'], 28.349523125, 'oz'],
    [['st', 'stone', 'stones'], 6350.29318, 'st'],
  ],
  volume: [
    [['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'], 1, 'ml'],
    [['l', 'liter', 'liters', 'litre', 'litres'], 1000, 'l'],
    [['cl', 'centilitre', 'centilitres'], 10, 'cl'],
    [['tsp', 'teaspoon', 'teaspoons'], 4.92892159375, 'tsp'],
    [['tbsp', 'tablespoon', 'tablespoons'], 14.78676478125, 'tbsp'],
    [['fl oz', 'floz', 'fluid ounce', 'fluid ounces'], 29.5735295625, 'fl oz (US)'],
    [['cup', 'cups'], 236.5882365, 'cup (US)'],
    [['pt', 'pint', 'pints'], 473.176473, 'pint (US)'],
    [['qt', 'quart', 'quarts'], 946.352946, 'quart (US)'],
    [['gal', 'gallon', 'gallons', 'us gallon', 'us gallons'], 3785.411784, 'gal (US)'],
    [['imperial gallon', 'imperial gallons', 'uk gallon', 'uk gallons', 'imp gal'], 4546.09, 'gal (UK)'],
    [['uk pint', 'uk pints', 'imperial pint', 'imperial pints'], 568.26125, 'pint (UK)'],
  ],
  speed: [
    [['m/s', 'mps'], 1, 'm/s'],
    [['km/h', 'kmh', 'kph', 'kmph', 'km/hr'], 1 / 3.6, 'km/h'],
    [['mph', 'mi/h', 'miles per hour'], 0.44704, 'mph'],
    [['kn', 'kt', 'kts', 'knot', 'knots'], 1852 / 3600, 'kn'],
    [['ft/s', 'fps'], 0.3048, 'ft/s'],
  ],
  area: [
    [['m2', 'm²', 'sq m', 'square meter', 'square meters', 'square metre', 'square metres'], 1, 'm²'],
    [['km2', 'km²', 'sq km', 'square kilometer', 'square kilometers', 'square kilometre', 'square kilometres'], 1e6, 'km²'],
    [['ha', 'hectare', 'hectares'], 1e4, 'ha'],
    [['acre', 'acres'], 4046.8564224, 'acre'],
    [['ft2', 'ft²', 'sq ft', 'sqft', 'square foot', 'square feet'], 0.09290304, 'ft²'],
    [['mi2', 'mi²', 'sq mi', 'sq mile', 'sq miles', 'square mile', 'square miles'], 2589988.110336, 'mi²'],
  ],
  data: [
    [['b', 'byte', 'bytes'], 1, 'B'],
    [['kb', 'kilobyte', 'kilobytes'], 1e3, 'KB'],
    [['mb', 'megabyte', 'megabytes'], 1e6, 'MB'],
    [['gb', 'gigabyte', 'gigabytes'], 1e9, 'GB'],
    [['tb', 'terabyte', 'terabytes'], 1e12, 'TB'],
    [['kib'], 1024, 'KiB'],
    [['mib'], 1048576, 'MiB'],
    [['gib'], 1073741824, 'GiB'],
  ],
  time: [
    [['s', 'sec', 'secs', 'second', 'seconds'], 1, 's'],
    [['min', 'mins', 'minute', 'minutes'], 60, 'min'],
    [['h', 'hr', 'hrs', 'hour', 'hours'], 3600, 'h'],
    [['d', 'day', 'days'], 86400, 'days'],
    [['wk', 'wks', 'week', 'weeks'], 604800, 'weeks'],
  ],
};

const TEMPS = {
  c: ['C', (v) => v, (v) => v],
  f: ['F', (v) => ((v - 32) * 5) / 9, (c) => (c * 9) / 5 + 32],
  k: ['K', (v) => v - 273.15, (c) => c + 273.15],
};
const TEMP_NAMES = { c: 'c', celsius: 'c', centigrade: 'c', f: 'f', fahrenheit: 'f', k: 'k', kelvin: 'k' };

const UNIT_INDEX = new Map();
for (const [dim, list] of Object.entries(DIMENSIONS)) {
  for (const [aliases, factor, label] of list) for (const a of aliases) UNIT_INDEX.set(a, { dim, factor, label });
}

/** "KM", "Miles", "°F", "square feet" → { dim, factor, label } | { dim: 'temp', key } | null. */
export function findUnit(token) {
  const t = String(token ?? '')
    .trim()
    .toLowerCase()
    .replace(/^°\s*/, '')
    .replace(/^degrees?\s+/, '')
    .replace(/\s+/g, ' ');
  if (TEMP_NAMES[t]) return { dim: 'temp', key: TEMP_NAMES[t], label: `°${TEMPS[TEMP_NAMES[t]][0]}` };
  return UNIT_INDEX.get(t) ?? null;
}

/** "5 miles to km" → { amount, from: unit, to: unit } | null. Dimensions must match. */
export function unitIntent(q) {
  const s = String(q).trim().toLowerCase().replace(/[?!]+$/, '').replace(/\s+/g, ' ').replace(/^(?:convert|how many|how much is|what is|what's|whats)\s+/, '');
  const m = /^(-?\d[\d,]*(?:\.\d+)?|-?\.\d+)\s*(°?\s*[a-z/²2 ]+?)\s+(?:to|in|into|as|=|->|→)\s+(°?\s*(?:degrees? )?[a-z/²2 ]+?)$/.exec(s);
  if (!m) return null;
  const amount = parseNumber(m[1]);
  const from = findUnit(m[2]);
  const to = findUnit(m[3]);
  if (amount == null || !from || !to || from.dim !== to.dim || from === to) return null;
  return { amount, from, to };
}

/** The converted value. */
export function convertUnit({ amount, from, to }) {
  if (from.dim === 'temp') return TEMPS[to.key][2](TEMPS[from.key][1](amount));
  return (amount * from.factor) / to.factor;
}

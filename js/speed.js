// A small speed test. Each source gets a latency probe (a tiny download), then a 250 KB download,
// then a 1 MB download only if the first finished in under 2 seconds, so a slow link is not made to
// pull a megabyte. Every request goes through net.js, so it shows in the totals like any other.
import * as N from './net.js';
import { mbit, transferMs } from './lib.js';

export const SMALL = 250000;
export const LARGE = 1000000;
export const FAST_MS = 2000;

export const SOURCES = [
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    service: 'Cloudflare speed test',
    url: (bytes, nonce) => `https://speed.cloudflare.com/__down?bytes=${bytes}&r=${nonce}`,
  },
  {
    id: 'app',
    name: 'This app’s host',
    service: 'Speed test file (this app’s host)',
    // Random data in static files of these exact sizes; the query string keeps caches out of the way.
    url: (bytes, nonce) => new URL(`speedtest/${bytes === 0 ? 'ping.txt' : bytes === SMALL ? '250k.bin' : '1m.bin'}?r=${nonce}`, location.href).href,
  },
];

/** Runs one source. Resolves to { id, name, latency, mbit, bytes, at } or { id, name, error, at }. */
export async function runSource(src, { say = () => {}, nonce = Date.now() } = {}) {
  const get = (bytes) => N.request(src.url(bytes, nonce), { timeout: 20000, service: src.service });
  let bytes = 0;
  try {
    say(`${src.name}: latency…`);
    const ping = await get(0);
    bytes += ping.entry.received;
    say(`${src.name}: downloading ${SMALL / 1000} KB…`);
    let d = await get(SMALL);
    bytes += d.entry.received;
    if (d.entry.ms < FAST_MS) {
      say(`${src.name}: fast link, downloading ${LARGE / 1000000} MB…`);
      d = await get(LARGE);
      bytes += d.entry.received;
    }
    return { id: src.id, name: src.name, latency: ping.entry.ttfb, mbit: mbit(d.entry.received, transferMs(d.entry)), bytes, at: Date.now() };
  } catch (e) {
    return { id: src.id, name: src.name, error: e.message, bytes, at: Date.now() };
  }
}

/** Runs the sources one after another so they don't compete for the connection. */
export async function runAll(say) {
  const out = [];
  for (const src of SOURCES) out.push(await runSource(src, { say }));
  return out;
}

// Every request the app makes goes through `request()`, which measures it: time to first byte,
// total time, bytes received and the size on the wire. Listeners (the bottom bar, the activity
// log, the Network page) are told when a request starts, makes progress and finishes.
//
// What a page can and can't see: browsers decompress responses before the page sees them, and
// they hide other sites' exact transfer sizes (Resource Timing reports 0 without
// Timing-Allow-Origin, which none of these services send). So `received` is exact (bytes after
// decompression), and `wire` is exact only when the service exposes Content-Length. Otherwise
// it is estimated by gzip-compressing what arrived, and marked as an estimate.
import { redactUrl, serviceOf } from './lib.js';

export class HttpError extends Error {
  constructor(status, body, entry) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.entry = entry;
  }
}

const listeners = new Set();
export const onNet = (fn) => listeners.add(fn);
const emit = (type, entry) => {
  for (const fn of listeners) fn(type, entry);
};

/** Totals since the app was opened. */
export const session = { requests: 0, received: 0, wire: 0, ms: 0, errors: 0 };

let nextId = 1;

async function gzipSize(bytes) {
  if (bytes.byteLength < 256 || typeof CompressionStream === 'undefined') return bytes.byteLength;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return (await new Response(stream).arrayBuffer()).byteLength;
  } catch {
    return null;
  }
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Fetches `url` and reads the whole body while measuring it. Resolves to
 * `{ status, text, json(), entry }`. Rejects with HttpError for non-2xx statuses, or with an
 * Error marked `network: true` when the request never got a response or was cut off.
 * `onProgress(entry)` is called about every 150 ms while the body arrives.
 */
export async function request(url, { timeout = 15000, headers = {}, onProgress } = {}) {
  const entry = {
    id: nextId++,
    service: serviceOf(url),
    url: redactUrl(url),
    at: Date.now(),
    phase: 'connecting',
    status: null,
    ttfb: null,
    ms: null,
    received: 0,
    wire: null,
    wireKind: null,
    error: null,
  };
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const progress = () => {
    entry.ms = performance.now() - t0;
    onProgress?.(entry);
    emit('progress', entry);
  };
  const fail = (message) => {
    clearTimeout(timer);
    entry.phase = 'failed';
    entry.error = message;
    entry.ms = performance.now() - t0;
    session.requests++;
    session.errors++;
    session.received += entry.received;
    session.ms += entry.ms;
    emit('done', entry);
    const err = new Error(message);
    err.network = true;
    err.entry = entry;
    return err;
  };
  emit('start', entry);
  onProgress?.(entry);

  let res;
  try {
    res = await fetch(url, { signal: ac.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers });
  } catch {
    throw fail(ac.signal.aborted ? 'timed out waiting for a response' : navigator.onLine ? 'could not connect' : 'offline');
  }
  entry.status = res.status;
  entry.ttfb = performance.now() - t0;
  entry.phase = 'receiving';
  progress();

  const contentLength = Number(res.headers.get('content-length')) || null;
  const chunks = [];
  try {
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        entry.received += value.byteLength;
        if (performance.now() - last > 150) {
          last = performance.now();
          progress();
        }
      }
    } else {
      const b = new Uint8Array(await res.arrayBuffer());
      chunks.push(b);
      entry.received = b.byteLength;
    }
  } catch {
    throw fail(ac.signal.aborted ? 'timed out while downloading' : 'connection dropped while downloading');
  }
  clearTimeout(timer);
  entry.ms = performance.now() - t0;

  const bytes = concat(chunks, entry.received);
  if (contentLength) {
    entry.wire = contentLength;
    entry.wireKind = 'exact';
  } else {
    entry.wire = await gzipSize(bytes);
    entry.wireKind = 'estimate';
  }
  const text = new TextDecoder().decode(bytes);

  entry.phase = res.ok ? 'done' : 'failed';
  if (!res.ok) entry.error = `HTTP ${res.status}`;
  session.requests++;
  session.received += entry.received;
  session.wire += entry.wire ?? entry.received;
  session.ms += entry.ms;
  if (!res.ok) session.errors++;
  emit('done', entry);

  if (!res.ok) throw new HttpError(res.status, text.slice(0, 2000), entry);
  return { status: res.status, text, entry, json: () => JSON.parse(text) };
}

/**
 * Records a request made outside `request()` (the AI downloads stream hundreds of MB, so they
 * can't be read whole). `e` has service, url, status, ttfb, ms, received, wire, error.
 */
export function record(e) {
  const entry = { id: nextId++, at: Date.now(), wireKind: 'exact', ...e, url: redactUrl(e.url), phase: e.error ? 'failed' : 'done' };
  session.requests++;
  session.received += entry.received;
  session.wire += entry.wire ?? entry.received;
  session.ms += entry.ms ?? 0;
  if (entry.error) session.errors++;
  emit('done', entry);
}

/** How the app's own files were loaded on this launch (same-origin, so the browser reports it). */
export function appLoad() {
  const nav = performance.getEntriesByType('navigation')[0];
  const files = [nav, ...performance.getEntriesByType('resource').filter((r) => r.name.startsWith(location.origin))].filter(Boolean);
  const wire = files.reduce((n, f) => n + (f.transferSize || 0), 0);
  const decoded = files.reduce((n, f) => n + (f.decodedBodySize || 0), 0);
  return {
    files: files.length,
    wire,
    decoded,
    ms: nav ? nav.loadEventEnd || nav.domContentLoadedEventEnd || nav.responseEnd : null,
    fromCache: files.length > 0 && wire === 0,
    controlled: !!navigator.serviceWorker?.controller,
  };
}

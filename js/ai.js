// On-device AI, page side. Nothing here runs until you download a model on the AI page:
//   - device checks (WebGPU, 16-bit floats, storage)
//   - resumable downloads into IndexedDB (ai-store.js), with pause, retry and removal
//   - the engine connection (a Web Worker running ai-engine.js, or the page as a fallback)
//   - crash markers: iOS ends a page that uses too much memory without any error the page can
//     catch, so a marker is written before each load or run and cleared after; one still there
//     on the next launch means the app was ended mid-way, and it is logged as a crash
//   - the diagnostics log, and retrieval over saved pages and searches (keywords + BGE vectors)
import * as AL from './ai-lib.js';
import * as AS from './ai-store.js';
import * as S from './store.js';
import { record } from './net.js';
import { serviceOf } from './lib.js';

const P = AL.PACKAGES;
const BUSY = 'sparse-ai-busy';
const CHUNK = 8 * 1024 * 1024;
const STALL_MS = 45_000;
const IDLE_UNLOAD_MS = 10 * 60 * 1000;
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new Error('aborted'))), { once: true });
  });

const listeners = new Set();
/** Subscribe to 'log', 'pkg', 'download', 'loaded' and 'load-progress' events. Returns an unsubscribe. */
export function on(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(type, data) {
  for (const fn of listeners)
    try {
      fn(type, data);
    } catch {
      // a screen that went away
    }
}

// ---------- diagnostics log ----------

let recent = [];
let persist = false; // the AI database is only created once you opt in

export async function log(level, area, msg, extra = {}) {
  const e = { t: Date.now(), level, area, msg, ...extra };
  recent = [e, ...recent].slice(0, 300);
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(`[AI ${area}] ${msg}`);
  emit('log', e);
  if (persist)
    try {
      await AS.addLog(e);
      if (Math.random() < 0.05) await AS.trimLog(600);
    } catch {
      // storage full or unavailable: the in-memory copy still shows on screen
    }
  return e;
}

export async function readLog(limit = 300) {
  if (!persist) return recent;
  return AS.readLog(limit).catch(() => recent);
}

export async function clearLog() {
  recent = [];
  if (persist) await AS.clearStore('log');
}

// ---------- package records ----------

const ready = new Set();
export const isReady = (id) => ready.has(id);
export const anyChat = () => AL.CHAT_IDS.some((id) => ready.has(id));

/** The chat model to use: the preferred one if it's downloaded, else any downloaded one. */
export function chatModel(preferred) {
  if (ready.has(preferred) && P[preferred]?.kind === 'chat') return preferred;
  return AL.CHAT_IDS.find((id) => ready.has(id)) ?? null;
}

export async function state(id) {
  if (!persist) return { id, status: 'none' };
  return (await AS.get('pkgs', id).catch(() => null)) ?? { id, status: 'none' };
}

export async function states() {
  const out = {};
  for (const id of Object.keys(P)) out[id] = await state(id);
  return out;
}

async function save(rec) {
  persist = true;
  await AS.put('pkgs', rec.id, rec);
  if (rec.status === 'ready') ready.add(rec.id);
  else ready.delete(rec.id);
  emit('pkg', rec);
}

// ---------- device ----------

/** WebGPU worth using: a software fallback (SwiftShader) is slower than the CPU path. */
export const usableGpu = (d) => (d.gpu.gpu && !d.gpu.fallback ? d.gpu : null);

let deviceInfo = null;

export async function device(force = false) {
  if (deviceInfo && !force) return deviceInfo;
  const { probeGpu } = await import('./ai-engine.js');
  const [gpu, est, persisted] = await Promise.all([
    probeGpu(),
    navigator.storage?.estimate?.().catch(() => null) ?? null,
    navigator.storage?.persisted?.().catch(() => null) ?? null,
  ]);
  deviceInfo = {
    gpu,
    worker: deviceInfo?.worker ?? null,
    storage: est ? { usage: est.usage, quota: est.quota } : null,
    persisted,
    cores: navigator.hardwareConcurrency ?? null,
    memory: navigator.deviceMemory ?? null,
    isolated: globalThis.crossOriginIsolated ?? false,
    standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
    ua: navigator.userAgent,
  };
  return deviceInfo;
}

// ---------- engine connection ----------

let conn = null;
let connecting = null;
const pending = new Map();
const loaded = new Map();
let seq = 0;
let current = null; // the running generation's key
let idleTimer = null;

export const loadedModels = () => new Map(loaded);
export const engineMode = () => conn?.mode ?? null;

function settle(key, value) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  p.resolve(value);
}

function failPending(key, err) {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  p.reject(err);
}

function onMessage(m) {
  switch (m.type) {
    case 'log':
      return void log(m.level, 'engine', m.msg);
    case 'progress':
      emit('load-progress', m);
      return pending.get(`load:${m.pkg}`)?.progress?.(m);
    case 'loaded':
      return settle(`load:${m.pkg}`, m);
    case 'unloaded':
      return settle(`unload:${m.pkg}`, m);
    case 'probe':
      return settle('probe', m);
    case 'token':
      return pending.get(m.id)?.token?.(m.text);
    case 'done':
    case 'vectors':
      return settle(m.id, m);
    case 'error': {
      const key = m.id ?? (m.phase === 'load' || m.phase === 'unload' ? `${m.phase}:${m.pkg}` : m.phase);
      const err = Object.assign(new Error(m.message), { name: m.name, phase: m.phase, detail: m.stack });
      return failPending(key, err);
    }
    default:
  }
}

function request(key, msg, handlers = {}) {
  return new Promise((resolve, reject) => {
    pending.set(key, { resolve, reject, ...handlers });
    try {
      conn.send(msg);
    } catch (e) {
      failPending(key, e);
    }
  });
}

function drop(reason) {
  conn = null;
  connecting = null;
  current = null;
  loaded.clear();
  emit('loaded');
  for (const key of [...pending.keys()]) failPending(key, reason);
}

async function pageConnection() {
  const { createEngine } = await import('./ai-engine.js');
  const engine = createEngine((m) => queueMicrotask(() => onMessage(m)));
  return { mode: 'page', send: (m) => void engine.handle(m), terminate() {} };
}

function connect() {
  return (connecting ??= (async () => {
    const dev = await device();
    let w;
    try {
      w = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      await log('warn', 'engine', `Could not start a worker (${e.message}); running the AI on the page`);
      conn = await pageConnection();
      return conn;
    }
    w.addEventListener('message', (e) => onMessage(e.data));
    w.addEventListener('error', (e) => {
      e.preventDefault?.();
      log('error', 'engine', `The AI worker stopped: ${e.message || 'no details given (often a sign it ran out of memory)'}`);
      drop(new Error('The AI worker stopped unexpectedly'));
    });
    w.addEventListener('messageerror', () => log('error', 'engine', 'A message from the AI worker could not be read'));
    conn = { mode: 'worker', send: (m) => w.postMessage(m), terminate: () => w.terminate() };
    const probe = await Promise.race([request('probe', { type: 'probe' }), sleep(20000).then(() => null)]);
    if (!probe) {
      await log('error', 'engine', 'The AI worker did not answer within 20 s; running the AI on the page instead');
      w.terminate();
      pending.delete('probe');
      conn = await pageConnection();
      return conn;
    }
    dev.worker = probe;
    if (!probe.gpu && usableGpu(dev)) {
      await log('warn', 'engine', `WebGPU works on the page but not in a worker here (${probe.why}), so the AI runs on the page; the screen may pause while it works`);
      w.terminate();
      conn = await pageConnection();
    } else await log('info', 'engine', `AI worker started (WebGPU in the worker: ${probe.gpu ? 'yes' : 'no'})`);
    return conn;
  })().catch((e) => {
    connecting = null;
    throw e;
  }));
}

/** Ends the engine (and any model in memory). Used for a hard stop and for "Remove all". */
export function restart(why = 'Restarted') {
  conn?.terminate();
  drop(new Error(why));
}

function markBusy(what, pkg, detail) {
  try {
    localStorage.setItem(BUSY, JSON.stringify({ what, pkg, detail, at: Date.now() }));
  } catch {
    // private mode: crash detection is off
  }
}
function clearBusy() {
  try {
    localStorage.removeItem(BUSY);
  } catch {
    // as above
  }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    for (const id of loaded.keys())
      if (P[id].kind === 'chat' && !current) {
        await unload(id).catch(() => {});
        log('info', 'memory', `Unloaded ${P[id].short} after 10 minutes unused, to free memory`);
      }
  }, IDLE_UNLOAD_MS);
}

export async function ensureLoaded(id, { onProgress } = {}) {
  if (loaded.has(id)) {
    touch();
    return loaded.get(id);
  }
  const rec = await state(id);
  if (rec.status !== 'ready') throw new Error(`${P[id].short} is not downloaded. Download it on the AI page.`);
  if ((await state('engine')).status !== 'ready') throw new Error('The AI engine is not downloaded. Download it on the AI page.');
  if (rec.device === 'wasm' && rec.dtype !== P[id].cpu) {
    const e = new Error(`The downloaded ${rec.dtype} weights can't run on the CPU. Remove ${P[id].short} and download it again.`);
    await noteFailure(id, 'load', e);
    throw e;
  }
  await connect();
  if (P[id].kind === 'chat') for (const other of [...loaded.keys()]) if (P[other].kind === 'chat') await unload(other);
  const where = `${rec.dtype} on ${rec.device === 'webgpu' ? 'WebGPU' : 'the CPU'}`;
  await log('info', 'load', `Loading ${P[id].short} from this device (${AL.size(rec.total)}, ${where}, ${conn.mode})…`, { pkg: id });
  markBusy('load', id, where);
  try {
    const info = await request(`load:${id}`, { type: 'load', pkg: id, dtype: rec.dtype, device: rec.device, chunks: AL.dataChunks(P[id], rec.dtype) }, { progress: onProgress });
    loaded.set(id, info);
    const r = await state(id);
    Object.assign(r, { loads: (r.loads ?? 0) + 1, lastLoad: { ms: info.ms, at: Date.now(), mode: conn?.mode, where } });
    await save(r);
    await log('ok', 'load', `Loaded ${P[id].short} in ${(info.ms / 1000).toFixed(1)} s (${where})`, { pkg: id });
    emit('loaded');
    touch();
    return info;
  } catch (e) {
    await noteFailure(id, 'load', e);
    throw e;
  } finally {
    clearBusy();
  }
}

async function noteFailure(id, phase, e) {
  const r = await state(id);
  if (r.status !== 'none') {
    Object.assign(r, { failures: (r.failures ?? 0) + 1, lastError: { phase, message: e.message, at: Date.now() } });
    await save(r);
  }
  await log('error', phase, `${P[id]?.short ?? id}: ${e.message}`, { pkg: id, detail: e.detail });
}

export async function unload(id) {
  if (!loaded.has(id) || !conn) return;
  await request(`unload:${id}`, { type: 'unload', pkg: id });
  loaded.delete(id);
  emit('loaded');
  await log('info', 'memory', `Unloaded ${P[id].short}`, { pkg: id });
}

/** Writes a reply. Calls onToken with each new piece of text; resolves with the run's figures. */
export async function generate(id, messages, { maxTokens = 400, onToken, label = 'run' } = {}) {
  await ensureLoaded(id);
  const key = `g${++seq}`;
  current = key;
  markBusy('generate', id, label);
  let last = Date.now();
  let warned = false;
  const watch = setInterval(() => {
    if (!warned && Date.now() - last > 90_000) {
      warned = true;
      log('warn', 'run', `${P[id].short} has produced nothing for 90 s; it may be stuck. Stop it and try a shorter text.`, { pkg: id });
    }
  }, 5000);
  try {
    const { stats } = await request(
      key,
      { type: 'generate', id: key, pkg: id, messages, maxTokens },
      {
        token: (t) => {
          last = Date.now();
          onToken?.(t);
        },
      },
    );
    const r = await state(id);
    r.lastRun = { ...stats, at: Date.now(), label };
    await save(r);
    await log('ok', 'run', `${P[id].short} (${label}): ${AL.describeRun(stats)}`, { pkg: id });
    return stats;
  } catch (e) {
    await noteFailure(id, 'run', e);
    throw e;
  } finally {
    clearInterval(watch);
    clearBusy();
    if (current === key) current = null;
    touch();
  }
}

/** Stops the running generation. If the model doesn't stop within 8 s, the engine is restarted. */
export function stop() {
  const key = current;
  if (!key || !conn) return;
  conn.send({ type: 'stop', id: key });
  log('info', 'run', 'Stop requested');
  setTimeout(() => {
    if (current === key) {
      log('warn', 'run', 'The model did not stop within 8 s, so the AI engine was restarted');
      restart('Stopped');
    }
  }, 8000);
}

export const running = () => !!current;

/** BGE vectors for some texts (normalised, 384 numbers each). */
export async function embed(texts, { query = false } = {}) {
  await ensureLoaded('bge');
  const key = `e${++seq}`;
  const { vecs } = await request(key, { type: 'embed', id: key, pkg: 'bge', texts, query });
  touch();
  return vecs;
}

// ---------- downloads ----------

let job = null;
const queue = [];
let wake = null;

async function keepAwake(onOff) {
  try {
    if (onOff && !wake && navigator.wakeLock && document.visibilityState === 'visible') {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => (wake = null));
    } else if (!onOff && wake) {
      await wake.release();
      wake = null;
    }
  } catch (e) {
    log('info', 'download', `Could not keep the screen on: ${e.message}`);
  }
}

export const downloading = () => (job ? { id: job.id, ...job.progress } : null);
export const queued = () => [...queue];

/** Downloads a package (and the engine first, if it isn't on the device yet). */
export async function download(id) {
  persist = true;
  const ids = id === 'engine' ? ['engine'] : ['engine', id];
  for (const x of ids) {
    const r = await state(x);
    if (r.status === 'ready' || queue.includes(x) || job?.id === x) continue;
    queue.push(x);
    Object.assign(r, { status: 'queued', reason: null, error: null });
    await save(r);
  }
  pump();
}

function pump() {
  if (job || !queue.length) return;
  const id = queue.shift();
  job = { id, ctrl: new AbortController(), progress: { have: 0, total: 0, rate: 0 } };
  job.promise = run(job)
    .catch(() => {})
    .finally(() => {
      job = null;
      if (!queue.length) keepAwake(false);
      pump();
    });
}

export async function pause(id, reason = 'Paused') {
  const i = queue.indexOf(id);
  if (i >= 0) {
    queue.splice(i, 1);
    const r = await state(id);
    Object.assign(r, { status: 'paused', reason });
    await save(r);
  }
  if (job?.id === id) {
    job.stopReason = reason;
    job.ctrl.abort(new Error(reason));
    await job.promise;
  }
}

async function run(j) {
  const { id } = j;
  const spec = P[id];
  const rec = await state(id);
  if (spec.kind !== 'engine' && !rec.dtype) {
    const d = await device();
    const v = AL.pickVariant(spec, usableGpu(d));
    if (!v.dtype) {
      Object.assign(rec, { status: 'failed', error: `${spec.short} needs WebGPU, which this browser doesn't offer${d.gpu.why ? ` (${d.gpu.why})` : d.gpu.fallback ? ' (only a software version)' : ''}.` });
      await save(rec);
      await log('error', 'download', rec.error, { pkg: id });
      return;
    }
    Object.assign(rec, v);
    await log('info', 'download', `${spec.short}: chose ${rec.dtype} weights for ${rec.device === 'webgpu' ? `WebGPU${d.gpu.f16 ? ' with 16-bit floats' : ' without 16-bit floats'}` : 'the CPU (no WebGPU here)'}`, { pkg: id });
  }
  const files = AL.filesFor(spec, rec.dtype);
  rec.total = AL.totalSize(files);
  const recs = {};
  for (const f of files)
    recs[f.path] = (await AS.get('files', AS.fileKey(id, f.path)).catch(() => null)) ?? { pkg: id, path: f.path, size: f.size, have: 0, chunks: 0, done: false };
  let saved = Object.values(recs).reduce((n, r) => n + (r.size === files.find((f) => f.path === r.path).size ? r.have : 0), 0);
  const need = rec.total - saved;
  Object.assign(rec, { status: 'downloading', reason: null, error: null, startedAt: rec.startedAt ?? Date.now(), have: saved });
  await save(rec);

  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (est?.quota) {
    const free = est.quota - est.usage;
    await log('info', 'storage', `${spec.short} needs ${AL.size(need)} more; about ${AL.size(free)} is free for this app`, { pkg: id });
    if (free < need * 1.02 + 20e6) {
      Object.assign(rec, { status: 'failed', error: `Not enough storage: ${AL.size(need)} needed, about ${AL.size(free)} free for this app. Free some space on the device, then try again.` });
      await save(rec);
      await log('error', 'storage', rec.error, { pkg: id });
      return;
    }
  }
  const persisted = await navigator.storage?.persist?.().catch(() => false);
  await log(
    persisted ? 'ok' : 'warn',
    'storage',
    persisted ? 'Storage is marked as permanent, so the browser won’t clear it to save space' : 'Storage could not be marked as permanent: the browser may clear it if the device runs very low on space',
  );
  await keepAwake(true);
  await log('info', 'download', `Downloading ${spec.name}: ${AL.size(need)} to go, ${files.filter((f) => !recs[f.path].done).length} files, from ${spec.source ?? 'Hugging Face'}`, { pkg: id });

  const t0 = Date.now();
  const samples = [[Date.now(), saved]];
  let inflight = 0;
  let lastEmit = 0;
  const progress = (file) => {
    const nowT = Date.now();
    const have = saved + inflight;
    samples.push([nowT, have]);
    while (samples.length > 2 && nowT - samples[0][0] > 8000) samples.shift();
    const [t1, b1] = samples[0];
    const rate = nowT > t1 ? ((have - b1) * 1000) / (nowT - t1) : 0;
    j.progress = { have, total: rec.total, rate, file, eta: rate > 0 ? (rec.total - have) / rate : null };
    if (nowT - lastEmit > 300) {
      lastEmit = nowT;
      emit('download', { id, ...j.progress });
    }
  };

  try {
    for (const f of files) {
      let fr = recs[f.path];
      if (fr.done && fr.size === f.size) continue;
      if (fr.size !== f.size || (fr.have && !f.resume)) {
        saved -= fr.size === f.size ? fr.have : 0;
        await AS.resetFile(id, f.path);
        fr = recs[f.path] = { pkg: id, path: f.path, size: f.size, have: 0, chunks: 0, done: false };
      }
      let attempt = 0;
      for (;;) {
        try {
          await fetchFile(j, f, fr, {
            add: (n) => {
              inflight += n;
              progress(f.path);
            },
            flushed: async (n) => {
              inflight -= n;
              saved += n;
              rec.have = saved;
              await save(rec);
            },
            reset: () => (inflight = 0),
          });
          break;
        } catch (e) {
          inflight = 0;
          if (j.ctrl.signal.aborted || e.fatal) throw e;
          attempt++;
          if (!navigator.onLine) throw Object.assign(new Error('Waiting for a connection'), { offline: true });
          if (attempt > 6) throw e;
          const wait = Math.min(30, 2 ** attempt);
          await log('warn', 'download', `${f.path}: ${e.message}. Retrying in ${wait} s (attempt ${attempt} of 6), continuing from ${AL.size(fr.have)}`, { pkg: id });
          await sleep(wait * 1000, j.ctrl.signal);
        }
      }
    }
    for (const f of files.filter((x) => x.sha256)) {
      const blob = await AS.fileBlob(id, f.path);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
      if (digest !== f.sha256) {
        await AS.resetFile(id, f.path);
        throw Object.assign(new Error(`${f.path} failed its checksum (got ${digest.slice(0, 12)}…), so it was deleted. Try again.`), { fatal: true });
      }
    }
    if (files.some((x) => x.sha256)) await log('ok', 'download', 'Engine files match their SHA-256 checksums');
    const secs = (Date.now() - t0) / 1000;
    Object.assign(rec, { status: 'ready', have: rec.total, readyAt: Date.now(), reason: null, error: null });
    await save(rec);
    await log('ok', 'download', `${spec.name} is on this device: ${AL.size(need)} in ${Math.round(secs)} s (${AL.size(need / Math.max(secs, 0.1))}/s)`, { pkg: id });
    emit('download', { id, done: true, status: 'ready' });
  } catch (e) {
    const r = await state(id);
    if (j.stopReason === 'Removed') return;
    if (j.ctrl.signal.aborted) Object.assign(r, { status: 'paused', reason: j.stopReason ?? 'Paused' });
    else if (e.offline) Object.assign(r, { status: 'paused', reason: 'Waiting for a connection: it continues when you are back online', autoResume: true });
    else Object.assign(r, { status: 'failed', error: e.message });
    r.have = saved;
    await save(r);
    await log(r.status === 'failed' ? 'error' : 'info', 'download', `${spec.short}: ${r.status === 'failed' ? `download failed: ${e.message}` : `${r.reason} at ${AL.size(saved)} of ${AL.size(rec.total)}`}`, { pkg: id });
    emit('download', { id, done: true, status: r.status, why: r.reason ?? r.error });
    // A model without its engine can't run: stop the queue behind a failed engine.
    if (id === 'engine' && r.status !== 'ready') for (const x of queue.splice(0)) await save(Object.assign(await state(x), { status: 'paused', reason: 'The engine download did not finish' }));
  }
}

/** Streams one file into 8 MB pieces, resuming with a Range request when part is already saved. */
async function fetchFile(j, f, fr, cb) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(j.ctrl.signal.reason);
  j.ctrl.signal.addEventListener('abort', onAbort, { once: true });
  let lastByte = Date.now();
  const stall = setInterval(() => {
    if (Date.now() - lastByte > STALL_MS) ctrl.abort(new Error(`no data for ${STALL_MS / 1000} s`));
  }, 5000);
  j.nudge = () => {
    if (Date.now() - lastByte > 8000) ctrl.abort(new Error('the connection stalled while the app was in the background'));
  };
  const t0 = performance.now();
  const net = { service: serviceOf(f.url), url: f.url, status: null, ttfb: null, received: 0, wire: null, error: null };
  try {
    const headers = fr.have && f.resume ? { Range: `bytes=${fr.have}-` } : {};
    let res;
    try {
      res = await fetch(f.url, { headers, signal: ctrl.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    } catch (e) {
      throw new Error(ctrl.signal.reason?.message ?? `could not connect (${e.message})`);
    }
    net.status = res.status;
    net.ttfb = performance.now() - t0;
    net.wire = Number(res.headers.get('content-length')) || null;
    if (res.status === 416 && fr.have === f.size) return finish();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: res.status === 404 || res.status === 410 });
    let skip = 0;
    if (fr.have && res.status === 200) {
      skip = fr.have;
      log('warn', 'download', `${f.path}: the server ignored the request to resume, so ${AL.size(skip)} already saved is being skipped over again`);
    }
    const reader = res.body.getReader();
    let parts = [];
    let bytes = 0;
    const flush = async () => {
      if (!bytes) return;
      const blob = new Blob(parts);
      const n = bytes;
      parts = [];
      bytes = 0;
      await AS.appendChunk(fr, blob);
      await cb.flushed(n);
    };
    for (;;) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw new Error(ctrl.signal.reason?.message ?? `connection lost (${e.message})`);
      }
      if (chunk.done) break;
      lastByte = Date.now();
      net.received += chunk.value.length;
      let v = chunk.value;
      if (skip) {
        if (v.length <= skip) {
          skip -= v.length;
          continue;
        }
        v = v.subarray(skip);
        skip = 0;
      }
      if (fr.have + bytes + v.length > f.size) throw Object.assign(new Error(`${f.path} is bigger than expected; the file may have changed`), { fatal: true });
      parts.push(v);
      bytes += v.length;
      cb.add(v.length);
      if (bytes >= CHUNK) await flush();
    }
    await flush();
    if (fr.have !== f.size) throw new Error(`the download ended early (${AL.size(fr.have)} of ${AL.size(f.size)})`);
    return finish();
  } catch (e) {
    net.error = e.message;
    throw e;
  } finally {
    // Partial transfers count too: they used data. Compressed files report their compressed size.
    record({ ...net, ms: performance.now() - t0, wire: net.error || !net.wire ? net.received : net.wire, wireKind: net.wire && !net.error ? 'exact' : 'estimate' });
    clearInterval(stall);
    j.ctrl.signal.removeEventListener('abort', onAbort);
    j.nudge = null;
  }

  async function finish() {
    fr.done = true;
    await AS.put('files', AS.fileKey(fr.pkg, fr.path), fr);
  }
}

/** Removes a package's files. Removing the last model removes the engine too. */
export async function remove(id) {
  if (job?.id === id) {
    job.stopReason = 'Removed';
    job.ctrl.abort(new Error('Removed'));
    await job.promise;
  }
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
  if (loaded.has(id)) await unload(id).catch(() => {});
  const r = await state(id);
  await AS.removePackage(id);
  ready.delete(id);
  if (id === 'bge') await AS.clearStore('vectors');
  if (P[id].kind === 'chat') await AS.delPrefix('notes', `sum|${id}|`);
  await log('ok', 'storage', `Removed ${P[id].name}${r.have ? `: freed about ${AL.size(r.have)}` : ''}`, { pkg: id });
  emit('pkg', { id, status: 'none' });
  if (id !== 'engine' && !(await Promise.all(AL.MODEL_IDS.map(state))).some((x) => x.status !== 'none')) {
    restart('No models left');
    await remove('engine');
  }
}

/** Deletes every AI file, vector, summary and log entry, and the database itself. */
export async function removeAll() {
  queue.splice(0);
  if (job) {
    job.stopReason = 'Removed';
    job.ctrl.abort(new Error('Removed'));
    await job.promise;
  }
  restart('All AI data removed');
  await AS.destroy();
  try {
    await caches.delete('transformers-cache');
  } catch {
    // no Cache Storage
  }
  clearBusy();
  ready.clear();
  persist = false;
  recent = [];
  await log('ok', 'storage', 'Removed all AI data from this device');
  emit('pkg', null);
}

// ---------- startup ----------

let lastCrash = null;
export const crashOnLaunch = () => lastCrash;

/** Run once at app start. Does nothing (and creates nothing) if the AI was never used. */
export async function init() {
  let marker = null;
  try {
    marker = JSON.parse(localStorage.getItem(BUSY) || 'null');
  } catch {
    marker = null;
  }
  let exists = true;
  try {
    const dbs = await indexedDB.databases?.();
    if (dbs) exists = dbs.some((d) => d.name === 'sparse-ai');
  } catch {
    exists = true;
  }
  if (!exists && !marker) return;
  persist = true;
  if (marker) {
    clearBusy();
    lastCrash = marker;
    const r = await state(marker.pkg);
    if (r.status !== 'none') {
      Object.assign(r, { crashes: (r.crashes ?? 0) + 1, lastCrash: { ...marker, found: Date.now() } });
      await AS.put('pkgs', r.id, r);
    }
    await log('error', 'crash', AL.crashText(marker), { pkg: marker.pkg, detail: `started ${new Date(marker.at).toLocaleString()}` });
  }
  for (const id of Object.keys(P)) {
    const r = await AS.get('pkgs', id).catch(() => null);
    if (!r) continue;
    if (r.status === 'ready') ready.add(id);
    if (r.status === 'downloading' || r.status === 'queued') {
      Object.assign(r, { status: 'paused', reason: 'Interrupted: the app was closed during the download. Tap Resume.' });
      await AS.put('pkgs', id, r);
      await log('warn', 'download', `${P[id].short}: the download was interrupted when the app closed (${AL.size(r.have ?? 0)} of ${AL.size(r.total)} kept)`, { pkg: id });
    }
  }
  addEventListener('online', async () => {
    for (const id of Object.keys(P)) {
      const r = await state(id);
      if (r.status === 'paused' && r.autoResume) {
        r.autoResume = false;
        await log('info', 'download', `Back online: resuming ${P[id].short}`);
        download(id);
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !job) return;
    keepAwake(true);
    job.nudge?.();
  });
}

// ---------- retrieval, summaries, questions ----------

/**
 * Finds the passages from saved pages and searches that best match a question: keyword match
 * (always) fused with meaning match (when BGE is downloaded). `say(kind, text)` narrates.
 */
export async function retrieve(question, { budget = 6000, max = 6, say = () => {} } = {}) {
  const [results, pages] = await Promise.all([S.entries('results'), S.entries('pages')]);
  const all = AL.collectPassages(results, pages);
  const pageCount = new Set(all.filter((p) => p.kind === 'page').map((p) => p.url)).size;
  say('step', `Looking through ${pageCount} pages and ${all.length - all.filter((p) => p.kind === 'page').length} search results kept on this device (${all.length} passages)`);
  if (!all.length) return { all, picked: [] };
  const index = AL.bm25Index(all.map((p) => `${p.title} ${p.text}`));
  const words = AL.bm25Search(index, question, 30).map((x) => x.i);
  say(words.length ? 'ok' : 'skip', `Keyword match: ${words.length ? `${words.length} passages share words with the question` : 'no passage shares a word with the question'}`);
  let meaning = [];
  if (ready.has('bge')) {
    const stored = new Map(await AS.all('vectors').catch(() => []));
    const missing = all.filter((p) => stored.get(p.id)?.h !== AL.hash(p.text));
    if (missing.length) {
      say('step', `Meaning match: indexing ${missing.length} new passages with BGE (once; the results are kept on this device)…`);
      markBusy('embed', 'bge', `${missing.length} passages`);
      const t0 = performance.now();
      try {
        for (let i = 0; i < missing.length; i += 8) {
          const batch = missing.slice(i, i + 8);
          const vecs = await embed(batch.map((p) => p.text));
          for (const [k, p] of batch.entries()) {
            const rec = { h: AL.hash(p.text), v: vecs[k] };
            stored.set(p.id, rec);
            await AS.put('vectors', p.id, rec);
          }
          emit('index-progress', { done: Math.min(i + 8, missing.length), total: missing.length });
        }
      } finally {
        clearBusy();
      }
      await log('ok', 'index', `Indexed ${missing.length} passages with BGE in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    }
    const [q] = await embed([question], { query: true });
    const scored = all.map((p, i) => ({ i, s: AL.dot(q, stored.get(p.id).v) })).sort((a, b) => b.s - a.s);
    meaning = scored.filter((x) => x.s > 0.45).slice(0, 30).map((x) => x.i);
    say(meaning.length ? 'ok' : 'skip', `Meaning match: ${meaning.length} close passages (best similarity ${scored[0]?.s.toFixed(2) ?? '–'})`);
    const live = new Set(all.map((p) => p.id));
    for (const id of stored.keys()) if (!live.has(id)) AS.del('vectors', id).catch(() => {});
  } else say('skip', 'Meaning match: BGE is not downloaded, so keyword match only');
  const fused = AL.fuse({ words, meaning });
  const picked = AL.pickContext(fused, all, budget, max);
  return { all, picked };
}

export const getSummary = (url, pkg) => (persist ? AS.get('notes', `sum|${pkg}|${url}`).catch(() => null) : null);
export const saveSummary = (url, pkg, rec) => AS.put('notes', `sum|${pkg}|${url}`, rec).catch(() => {});

export async function recentAsks() {
  if (!persist) return [];
  return (await AS.get('notes', 'asks').catch(() => null)) ?? [];
}
export async function saveAsk(entry) {
  const list = await recentAsks();
  await AS.put('notes', 'asks', [entry, ...list].slice(0, 15)).catch(() => {});
}
export const clearAsks = () => AS.del('notes', 'asks').catch(() => {});

/** Everything useful for a bug report, as text. */
export async function report() {
  const [d, st, entries] = await Promise.all([device(true), states(), readLog(200)]);
  const lines = [`Sparse on-device AI report, ${new Date().toISOString()}`, '', 'Device:', JSON.stringify(d, null, 1), '', 'Packages:'];
  for (const r of Object.values(st)) lines.push(JSON.stringify(r));
  lines.push('', `Engine: ${engineMode() ?? 'not started'}; in memory: ${[...loaded.keys()].join(', ') || 'nothing'}`, '', 'Log (newest first):');
  for (const e of entries) lines.push(`${new Date(e.t).toISOString()} ${e.level.toUpperCase()} [${e.area}] ${e.msg}${e.detail ? `\n    ${String(e.detail).split('\n').slice(0, 4).join('\n    ')}` : ''}`);
  return lines.join('\n');
}

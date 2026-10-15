// On-device AI, page side. Nothing here runs until you download a model on the AI page.
//   - device checks (WebGPU, 16-bit floats, storage)
//   - resumable downloads into IndexedDB (ai-store.js), with pause, retry and removal
//   - the engine connection (a Web Worker running ai-engine.js; the page itself only where that is
//     safe) and its health
//   - ONE operation at a time (ai-ops.js): loading, embedding, generating, unloading and resetting
//     queue here, and are enforced again inside the engine
//   - safety (ai-policy.js): per-model profiles and token budgets, checkpoints written before each
//     risky stage, a diagnosis of the last launch's interruption, and quarantine of configurations
//     that were interrupted unexpectedly
//   - the diagnostics log (ai-diag.js): structured events, kept on the device and bounded
//   - retrieval over saved pages and searches (keywords + BGE vectors), and summaries
import * as AL from './ai-lib.js';
import * as AS from './ai-store.js';
import * as S from './store.js';
import * as PO from './ai-policy.js';
import * as SEL from './ai-select.js';
import { createScheduler, Cancelled } from './ai-ops.js';
import { createLogger, newId, AiError, classifyError, explain, performanceSummary, buildReport } from './ai-diag.js';
import { record } from './net.js';
import { serviceOf } from './lib.js';

const P = AL.PACKAGES;
const K = {
  cp: 'sparse-ai-cp', // the checkpoint of the work in progress
  quarantine: 'sparse-ai-quarantine',
  history: 'sparse-ai-history',
  safety: 'sparse-ai-safety', // developer mode and the models opted in to
  legacy: 'sparse-ai-busy', // the older, single-marker crash detection
  interruption: 'sparse-ai-interruption', // the diagnosis made at the last launch
};
/** Errors that say nothing about the model's health (refused up front, or stopped on purpose). */
const BENIGN = new Set(['CANCELLED', 'BACKGROUNDED', 'TOKEN_BUDGET_EXCEEDED', 'TOKENIZATION_FAILED', 'MODEL_NOT_INSTALLED', 'MODEL_QUARANTINED', 'MODEL_NOT_ENABLED', 'MODEL_INCOMPATIBLE', 'NOT_FOREGROUND', 'VERSION_MISMATCH', 'QUEUE_FULL', 'GPU_UNAVAILABLE']);
const CHUNK = 8 * 1024 * 1024;
const STALL_MS = 45_000;
const LOAD_LIMIT_MS = 240_000;
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new Error('aborted'))), { once: true });
  });

const jget = (k, d) => {
  try {
    return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
  } catch {
    return d;
  }
};
const jset = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    // private mode: safety state lasts only for this session
  }
};
const jdel = (k) => {
  try {
    localStorage.removeItem(k);
  } catch {
    // as above
  }
};

const listeners = new Set();
/** Subscribe to 'log', 'pkg', 'download', 'loaded', 'load-progress', 'op' and 'safety' events. Returns an unsubscribe. */
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

const sid = newId('s');
let persist = false; // the AI database is only created once you opt in

const logger = createLogger({
  base: { sid, build: AL.AI_BUILD },
  write: async (batch) => {
    if (!persist) return;
    await AS.addLogs(batch);
    if (Math.random() < 0.1) await AS.trimLog(600);
  },
  sink: (e) => {
    (e.level === 'error' ? console.error : e.level === 'warn' ? console.warn : console.log)(`[AI ${e.area}] ${e.msg}`);
    emit('log', e);
  },
});

/** Records a structured event (see ai-diag.js). */
export const event = (ev, fields) => logger.event(ev, fields);

/** The older, free-text form: log(level, area, msg, fields). */
export function log(level, area, msg, extra = {}) {
  return logger.event(`ai.${area}.note`, { level, area, msg, ...extra });
}

export async function readLog(limit = 300) {
  if (!persist) return logger.recent();
  await logger.flush();
  return AS.readLog(limit).catch(() => logger.recent());
}

export async function clearLog() {
  logger.clear();
  if (persist) await AS.clearStore('log');
}

// ---------- package records ----------

const ready = new Set();
const recs = new Map(); // id -> record, for synchronous checks (variant, status)
export const isReady = (id) => ready.has(id);

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
  recs.set(rec.id, rec);
  if (rec.status === 'ready') ready.add(rec.id);
  else ready.delete(rec.id);
  emit('pkg', rec);
}

// ---------- device ----------

/** WebGPU worth using: a software fallback (SwiftShader) is slower than the CPU path, so it counts only in developer testing mode. */
export const usableGpu = (d) => (d.gpu.gpu && (!d.gpu.fallback || safety.dev) ? d.gpu : null);

let deviceInfo = null;
const cls = PO.deviceClass(undefined, jget('sparse-ai-class', null));
export const deviceClassName = () => cls;

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
    cls,
  };
  return deviceInfo;
}

// ---------- safety state: developer mode, opt-ins, quarantine, history ----------

const safety = { dev: false, optIn: [], ...jget(K.safety, {}) };
let quarantine = new Map(Object.entries(jget(K.quarantine, {})));
let history = jget(K.history, {});
let gpuLost = false;
let versionMismatch = false;
let lastInference = null;
let interruption = jget(K.interruption, null);

const policyState = () => ({ cls, dev: safety.dev, optIn: new Set(safety.optIn), quarantine, gpuLost });
const saveSafety = () => {
  jset(K.safety, safety);
  emit('safety');
};

export const getDev = () => safety.dev;
export function setDev(on) {
  safety.dev = !!on;
  saveSafety();
  event('ai.safety.developer_mode', { level: 'warn', msg: `Developer testing mode turned ${on ? 'on' : 'off'}` });
}
export const optedIn = (id) => safety.optIn.includes(id);
export function setOptIn(id, on) {
  safety.optIn = [...new Set(on ? [...safety.optIn, id] : safety.optIn.filter((x) => x !== id))];
  saveSafety();
  event('ai.safety.opt_in', { msg: `${P[id]?.short ?? id}: experimental use turned ${on ? 'on' : 'off'}`, pkg: id });
}

/** Whether a downloaded model may run now (profile, opt-in, quarantine, GPU), and why not. */
export function mayRun(id) {
  const r = recs.get(id);
  if (!r?.dtype || r.status !== 'ready') return { ok: false, code: 'MODEL_NOT_INSTALLED', why: `${P[id]?.short ?? id} is not downloaded` };
  // a weights file this browser's engine already failed to load is not tried again until it is replaced
  if (r.incompatible && r.incompatible.dtype === r.dtype && r.incompatible.device === r.device)
    return { ok: false, code: 'MODEL_INCOMPATIBLE', why: `The ${r.dtype} weights could not be loaded on ${r.device === 'webgpu' ? 'WebGPU' : 'the CPU'} here (${r.incompatible.message}). Remove ${P[id].short} and download it again to retry` };
  return PO.mayRun(id, r.device, r.dtype, policyState());
}

/** The chat model to use: the preferred one if it may run, else a provisional one that may. Never an experimental one unless chosen. */
export function chatModel(preferred) {
  const ok = (id) => ready.has(id) && P[id]?.kind === 'chat' && mayRun(id).ok;
  if (preferred && ok(preferred)) return preferred;
  return AL.CHAT_IDS.find((id) => ok(id) && PO.profileFor(id, cls).status === 'provisional') ?? null;
}
export const anyChat = (preferred) => chatModel(preferred) !== null;

/** Downloaded chat models that cannot run right now, with the reason: for the "AI is unavailable" notice. */
export function chatBlockers() {
  return AL.CHAT_IDS.filter((id) => ready.has(id))
    .map((id) => ({ id, ...mayRun(id) }))
    .filter((x) => !x.ok);
}

export const profile = (id) => PO.profileFor(id, cls);
export const lowMemory = () => PO.isLowMemory(cls);
export { explain };
/** Prompt limits a person may pick for a model: lower than the profile's, or higher only in developer mode. */
export const limitChoices = (id) => PO.promptLimitChoices(PO.profileFor(id, cls), safety.dev);
export const limitsFor = (id, promptLimit) => PO.effectiveLimits(PO.profileFor(id, cls), { promptLimit, dev: safety.dev });

export const quarantined = () => [...quarantine.entries()].map(([key, q]) => ({ key, ...q }));

/** Developer mode only: clears a quarantine so the configuration can be tested again. */
export function retest(key) {
  if (!safety.dev) throw new AiError('MODEL_QUARANTINED', 'Turn on developer testing mode to retest a model that was switched off');
  const q = quarantine.get(key);
  quarantine.delete(key);
  jset(K.quarantine, Object.fromEntries(quarantine));
  event('ai.quarantine.released', { level: 'warn', msg: `Retest allowed for ${key}`, key, category: q?.category });
  emit('safety');
}

function setQuarantine(key, q) {
  quarantine.set(key, q);
  jset(K.quarantine, Object.fromEntries(quarantine));
  event('ai.quarantine.added', { level: 'error', msg: `Switched off ${key}: ${q.category}`, key, category: q.category, confidence: q.confidence });
  emit('safety');
}

function noteOutcome(key, outcome, detail) {
  history[key] = PO.noteOutcome(history[key], outcome, detail);
  jset(K.history, history);
}

// ---------- checkpoints: written BEFORE each risky stage ----------

let cp = null;
let cpWrittenAt = 0;
const cpWrite = (force = true) => {
  if (!cp) return;
  if (!force && Date.now() - cpWrittenAt < 1000) return;
  cpWrittenAt = Date.now();
  jset(K.cp, cp);
};
function cpStart(info) {
  cp = PO.newCheckpoint({ sid, vis: document.visibilityState, runtime: AL.AI_BUILD, mode: conn?.mode ?? null, ...info });
  cpWrite();
}
function cpStageNow(stage, extra, force = true) {
  if (!cp) return;
  cp = PO.advance(cp, stage, extra);
  cpWrite(force);
}
/** Ends the checkpoint. Only its own operation may do so (an abandoned one finishing late must not wipe a newer one). */
function cpClear(owner = null) {
  if (!cp || (owner && cp.op !== owner)) return;
  cp = null;
  jdel(K.cp);
}
/** A stage message counts only while its operation (or one of its steps) is the one running. */
function isLive(id) {
  const a = sched.snapshot().active?.id;
  return !!a && !!id && (id === a || String(id).startsWith(`${a}.`) || opParent.get(id) === a);
}
const cpStage = cpStageNow;
function onVisibility() {
  const v = document.visibilityState;
  if (cp) {
    cp = PO.withVisibility(cp, v);
    cpWrite();
    event('ai.app.visibility', { msg: `App ${v === 'hidden' ? 'went to the background' : 'came back'} during ${cp.type}`, op: cp.op, stage: cp.stage, m: { state: v } });
  }
  // iOS suspends or ends background pages: stop work that needs the screen rather than be caught mid-way
  if (v === 'hidden' && current) {
    event('ai.operation.backgrounded', { level: 'warn', msg: 'The app went to the background, so the AI was stopped', op: current, code: 'BACKGROUNDED' });
    stop('backgrounded');
  }
}
function onPageHide(e) {
  if (cp && !e.persisted) {
    cp = { ...cp, closing: true };
    cpWrite();
  }
}

// ---------- scheduler: one operation at a time ----------

const ev0 = (e) => e.ev.split('.').pop();
const opParent = new Map();
const opMeta = new Map(); // op id -> { queueMs }
let current = null; // the running generation's id

const sched = createScheduler({
  onEvent: (e) => {
    if (e.parent) opParent.set(e.op, e.parent);
    if (opParent.size > 200) opParent.delete(opParent.keys().next().value);
    if (e.ev === 'ai.operation.started') {
      opMeta.set(e.op, { queueMs: e.queueMs ?? 0 });
      if (opMeta.size > 200) opMeta.delete(opMeta.keys().next().value);
    }
    if (!e.parent && (ev0(e) === 'completed' || ev0(e) === 'failed' || ev0(e) === 'cancelled'))
      setTimeout(() => {
        if (!sched.busy && cp) {
          event('ai.checkpoint.stale_cleared', { level: 'warn', msg: `A checkpoint for ${cp.type} (stage ${cp.stage}) was left behind after the operation ended, and was cleared`, op: cp.op, stage: cp.stage });
          cp = null;
          jdel(K.cp);
        }
      }, 50);
    const { ev, ...rest } = e;
    const level = ev === 'ai.operation.failed' || ev === 'ai.operation.timeout' ? 'error' : ev === 'ai.operation.cancelled' || ev === 'ai.operation.abandoned' ? 'warn' : 'info';
    // queued/stage chatter is kept to the log only for the top-level operations
    if (ev === 'ai.operation.stage') return emit('op', sched.snapshot());
    event(ev, { level, msg: `${e.type}${e.label && e.label !== e.type ? ` (${e.label})` : ''}: ${ev.split('.').pop()}${e.msg ? ` · ${e.msg}` : ''}`, ...rest, m: { queueMs: e.queueMs, depth: e.depth, requested: e.requested, ms: e.ms } });
    emit('op', sched.snapshot());
  },
  maxQueue: 8,
});

export const opState = () => sched.snapshot();
export const busy = () => sched.busy || sched.depth > 0;

// ---------- engine connection ----------

let conn = null;
let connecting = null;
const pending = new Map();
const loaded = new Map();
let seq = 0;
let idleTimer = null;
let workerState = 'none'; // none · starting · initialised · responsive · busy · unresponsive · terminated · restarted
const workerStats = { starts: 0, terminations: 0, resets: 0, lastMsgAt: null, lastPongMs: null, build: null };

function setWorker(s, msg, level = 'info') {
  workerState = s;
  event(`ai.worker.${s}`, { level, msg: msg ?? `AI engine: ${s}`, m: { mode: conn?.mode, starts: workerStats.starts, terminations: workerStats.terminations } });
}

export const loadedModels = () => new Map(loaded);
export const engineMode = () => conn?.mode ?? null;
export const workerInfo = () => ({ state: workerState, mode: conn?.mode ?? null, ...workerStats, gpuLost, versionMismatch });

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

function stageEvent(m) {
  const live = isLive(m.id);
  const cpStage = (...a) => (live ? cpStageNow(...a) : undefined);
  const mem = m.mem && Object.values(m.mem).some((v) => v != null) ? { jsHeap: m.mem.jsHeap, jsHeapLimit: m.mem.jsHeapLimit } : undefined;
  const f = (id) => ({ op: m.id, parent: opParent.get(m.id) ?? null, stage: m.stage, ...(id ? modelFields(id) : {}) });
  const id = m.pkg ?? cp?.pkg;
  switch (m.stage) {
    case 'load.start':
      return event('ai.model.load.started', { msg: `Loading ${P[id]?.short ?? id} (${m.dtype} on ${m.device})`, ...f(id), m: { memory: mem } });
    case 'load.ready':
      return event('ai.model.load.completed', { level: 'ok', msg: `Loaded in ${(m.ms / 1000).toFixed(1)} s`, ...f(id), m: { ms: m.ms, mode: conn?.mode, memory: mem } });
    case 'tokenize':
      return cpStage('tokenize', undefined);
    case 'prompt.tokenized':
      cpStage('prefill', { inputTokens: m.inputTokens, maxNew: m.maxNew }, true);
      return event('ai.prompt.tokenized', {
        msg: `Prompt is ${m.inputTokens} tokens (limit ${m.limits?.maxInput}); up to ${m.maxNew} may be written (total limit ${m.limits?.maxTotal})`,
        ...f(cp?.pkg),
        m: { inputTokens: m.inputTokens, maxNew: m.maxNew, total: m.total, limits: m.limits, tokenizeMs: m.tokenizeMs, trimmed: m.trimmed, estimated: m.est, memory: mem },
      });
    case 'prefill':
      return event('ai.inference.prefill.started', { msg: 'Prompt processing started (it ends at the first token: the runtime reports nothing in between)', ...f(cp?.pkg), m: { inputTokens: m.inputTokens, memory: mem } });
    case 'first_token':
      cpStage('first_token');
      return event('ai.inference.first_token', { msg: `First token after ${m.ms} ms`, ...f(cp?.pkg), m: { ms: m.ms, inferredFrom: 'prefill started' } });
    case 'decode':
      return cpStage('decode', { tokens: m.tokens }, false);
    case 'generate.done':
      return cpStage('generate.done', { tokens: m.tokens });
    case 'embed.batch':
      return cpStage('embed.batch', { tokens: m.done }, false);
    case 'embed.done':
      return cpStage('embed.done');
    case 'dispose.start':
      cpStage('dispose.start');
      return event('ai.model.dispose.started', { msg: `Releasing ${P[m.pkg]?.short ?? m.pkg} (${m.why ?? 'unload'})`, ...f(m.pkg), m: { memory: mem } });
    case 'dispose.done':
      cpStage('dispose.done');
      return event('ai.model.dispose.completed', { msg: `Released in ${m.ms} ms`, ...f(m.pkg), m: { ms: m.ms, memory: mem } });
    default:
  }
}

function onMessage(m) {
  workerStats.lastMsgAt = Date.now();
  switch (m.type) {
    case 'ready':
      workerStats.build = m.build;
      if (m.build !== AL.AI_BUILD) {
        versionMismatch = true;
        event('ai.worker.version_mismatch', { level: 'error', msg: `The AI worker is build ${m.build} but the page is ${AL.AI_BUILD}: the app is only partly updated`, code: 'VERSION_MISMATCH' });
        emit('safety');
      }
      return;
    case 'log':
      return void logger.event('ai.worker.log', { level: m.level, area: 'engine', msg: m.msg, m: m.data });
    case 'sched': {
      // the engine's own queue: it only matters if the page let two requests overlap
      const e = m.e;
      if (e.ev === 'ai.operation.timeout' || e.ev === 'ai.operation.abandoned') event(e.ev, { level: 'error', msg: `Engine: ${e.type} ${e.ev.split('.').pop()} at ${e.stage}`, op: e.op, stage: e.stage, code: 'INFERENCE_TIMEOUT', m: { ms: e.ms } });
      else if (e.ev === 'ai.operation.queued' && e.requested > 1) event('ai.engine.overlap', { level: 'warn', msg: `The engine received a ${e.type} request while busy (${e.requested} requests); it queued them`, op: e.op, m: { requested: e.requested } });
      return;
    }
    case 'stage':
      return stageEvent(m);
    case 'gpu-lost':
      gpuLost = true;
      if (cp) cpStage(cp.stage, { gpuLost: true });
      sched.markFailed({ code: 'GPU_DEVICE_LOST', at: Date.now() });
      event('ai.worker.gpu_lost', { level: 'error', msg: `The GPU device was lost (${m.reason}): ${m.message}`, code: 'GPU_DEVICE_LOST', op: cp?.op, stage: cp?.stage });
      emit('safety');
      return;
    case 'progress':
      emit('load-progress', m);
      return pending.get(m.id)?.progress?.(m);
    case 'loaded':
    case 'unloaded':
    case 'probe':
    case 'done':
    case 'vectors':
      return settle(m.id, m);
    case 'pong':
      workerStats.lastPongMs = Date.now() - m.t;
      return settle(m.id, m);
    case 'token':
      return pending.get(m.id)?.token?.(m.text);
    case 'error': {
      const err = Object.assign(new AiError(m.code && m.code !== 'UNKNOWN' ? m.code : classifyError({ message: m.message, name: m.name }, { stage: m.stage ?? m.phase }), m.message), { name: m.name, phase: m.phase, detail: m.stack, stage: m.stage });
      return failPending(m.id, err);
    }
    default:
  }
}

function request(msg, handlers = {}) {
  const id = msg.id ?? `r${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, ...handlers });
    try {
      conn.send({ ...msg, id });
    } catch (e) {
      failPending(id, e);
    }
  });
}

/** Forgets the engine (it has stopped, or was stopped): nothing is loaded, every waiting request fails. */
function drop(reason, code = 'WORKER_FAILED') {
  conn = null;
  connecting = null;
  loaded.clear();
  emit('loaded');
  const err = reason instanceof Error ? reason : new AiError(code, reason);
  for (const key of [...pending.keys()]) failPending(key, err);
}

async function pageConnection() {
  const { createEngine } = await import('./ai-engine.js');
  const engine = createEngine((m) => queueMicrotask(() => onMessage(m)));
  queueMicrotask(() => onMessage({ type: 'ready', build: AL.AI_BUILD }));
  return { mode: 'page', send: (m) => void engine.handle(m), terminate() {} };
}

function connect() {
  return (connecting ??= (async () => {
    const dev = await device();
    let w;
    setWorker('starting', 'Starting the AI worker');
    workerStats.starts++;
    try {
      w = new Worker(new URL(`./ai-worker.js?b=${AL.AI_BUILD}`, import.meta.url), { type: 'module' });
    } catch (e) {
      return fallbackToPage(`Could not start a worker (${e.message})`);
    }
    w.addEventListener('message', (e) => onMessage(e.data));
    w.addEventListener('error', (e) => {
      e.preventDefault?.();
      event('ai.worker.error', { level: 'error', msg: `The AI worker stopped: ${e.message || 'no details given (often a sign it ran out of memory)'}`, code: 'WORKER_FAILED', op: cp?.op, stage: cp?.stage });
      setWorker('terminated', 'The AI worker stopped on its own', 'error');
      workerStats.terminations++;
      drop(new AiError('WORKER_FAILED', 'The AI worker stopped unexpectedly'));
    });
    w.addEventListener('messageerror', () => log('error', 'engine', 'A message from the AI worker could not be read'));
    conn = { mode: 'worker', send: (m) => w.postMessage(m), terminate: () => w.terminate() };
    const probe = await Promise.race([request({ type: 'probe' }), sleep(20000).then(() => null)]);
    if (!probe) {
      w.terminate();
      workerStats.terminations++;
      return fallbackToPage('The AI worker did not answer within 20 s');
    }
    dev.worker = probe;
    if (!probe.gpu && usableGpu(dev)) {
      w.terminate();
      return fallbackToPage(`WebGPU works on the page but not in a worker here (${probe.why})`);
    }
    setWorker('initialised', `AI worker started (WebGPU in the worker: ${probe.gpu ? 'yes' : 'no'}, ${cls})`);
    return conn;
  })().catch((e) => {
    connecting = null;
    throw e;
  }));
}

/** Running the engine on the page freezes the screen while it works, and is not qualified on phones. */
async function fallbackToPage(why) {
  if (PO.isLowMemory(cls)) {
    event('ai.worker.blocked', { level: 'error', msg: `${why}. On this kind of device the AI does not run on the page itself, so it is off; saved pages can still be searched.`, code: 'WORKER_FAILED' });
    conn = null;
    setWorker('terminated', why, 'error');
    throw new AiError('WORKER_FAILED', `${why}. The AI is off on this device rather than running on the page itself.`);
  }
  await log('warn', 'engine', `${why}; running the AI on the page, so the screen may pause while it works`);
  conn = await pageConnection();
  setWorker('initialised', 'AI engine running on the page');
  return conn;
}

/** Ends the engine (and any model in memory). Safe at any time: pending work fails with `code`. */
export function restart(why = 'Restarted', code = 'WORKER_FAILED') {
  const had = !!conn;
  try {
    conn?.terminate();
  } catch {
    // already gone
  }
  if (had) {
    workerStats.terminations++;
    setWorker('terminated', why, code === 'CANCELLED' ? 'info' : 'warn');
  }
  drop(new AiError(code, why), code);
}

/** Tells the worker apart from a busy one: an idle worker answers a ping at once. */
async function ensureResponsive() {
  if (!conn || conn.mode !== 'worker') return;
  const t = Date.now();
  const pong = await Promise.race([request({ type: 'ping', t }), sleep(5000).then(() => null)]);
  if (pong) {
    if (workerState !== 'responsive' && workerState !== 'busy') setWorker('responsive', `AI worker answered in ${Date.now() - t} ms`);
    return;
  }
  setWorker('unresponsive', 'The idle AI worker did not answer a ping within 5 s', 'error');
  restart('The AI engine stopped responding', 'WORKER_UNRESPONSIVE');
  workerStats.resets++;
  await connect();
  setWorker('restarted', 'A fresh AI worker was started', 'warn');
}

const modelFields = (id) => {
  const r = recs.get(id);
  return { pkg: id, rev: P[id]?.revision?.slice(0, 8), dtype: r?.dtype, backend: r?.device, mode: conn?.mode ?? null };
};

/** Frees the engine after a failure that may have left it in a bad state, and records it. */
function recycleIfNeeded(code, why) {
  if (['GPU_DEVICE_LOST', 'POSSIBLE_MEMORY_EXHAUSTION', 'MODEL_DISPOSE_FAILED', 'WORKER_FAILED', 'WORKER_UNRESPONSIVE', 'INFERENCE_FAILED', 'INFERENCE_TIMEOUT', 'MODEL_LOAD_FAILED', 'MODEL_INCOMPATIBLE'].includes(code) && conn) {
    workerStats.resets++;
    event('ai.worker.reset', { level: 'warn', msg: `AI engine restarted after ${code}: ${why}`, code });
    restart(`Restarted after ${code}`, code);
  }
}

/** Reset button: abandons whatever is running, drops the queue, restarts the engine clean. */
export function resetEngine() {
  return sched.recover(async () => {
    workerStats.resets++;
    gpuLost = false;
    sched.clearFailed();
    restart('Reset by you', 'CANCELLED');
    cp = null;
    jdel(K.cp);
    current = null;
    event('ai.worker.reset', { level: 'warn', msg: 'AI engine reset on request' });
    emit('safety');
  });
}

// ---------- model memory policy ----------

function touch() {
  clearTimeout(idleTimer);
  if (!loaded.size) return;
  const retain = Math.min(...[...loaded.keys()].map((id) => PO.profileFor(id, cls).retainMs ?? 120_000));
  idleTimer = setTimeout(() => {
    sched
      .run({ type: 'unload', label: 'idle unload' }, async (ctx) => {
        for (const id of [...loaded.keys()]) {
          await unloadStep(ctx, id, 'unused for a while');
          event('ai.memory.idle_unload', { msg: `Unloaded ${P[id].short} after ${Math.round(retain / 1000)} s unused, to free memory`, ...modelFields(id) });
        }
      })
      .catch(() => {});
  }, retain);
}

function preflight(id, kind) {
  const spec = P[id];
  if (!ready.has(id) || recs.get('engine')?.status !== 'ready') throw new AiError('MODEL_NOT_INSTALLED', `${spec.short} is not downloaded. Download it on the AI page.`, { pkg: id });
  const rec = recs.get(id);
  if (rec.device === 'wasm' && rec.dtype !== spec.cpu) throw new AiError('MODEL_INCOMPATIBLE', `The downloaded ${rec.dtype} weights can't run on the CPU. Remove ${spec.short} and download it again.`, { pkg: id });
  const r = mayRun(id);
  if (!r.ok) throw new AiError(r.code, r.why, { pkg: id });
  if (versionMismatch) throw new AiError('VERSION_MISMATCH');
  if (kind !== 'unload' && document.visibilityState === 'hidden') throw new AiError('NOT_FOREGROUND');
  return r;
}

async function loadStep(ctx, id, { onProgress } = {}) {
  if (loaded.has(id)) {
    touch();
    return loaded.get(id);
  }
  preflight(id, 'load');
  await connect();
  await ensureResponsive();
  // one model in memory at a time: the others are released completely before this one loads
  for (const other of [...loaded.keys()]) await ctx.child({ type: 'unload', pkg: other, label: 'make room' }, (c) => unloadStep(c, other, 'making room for another model'));
  const rec = await state(id);
  const where = `${rec.dtype} on ${rec.device === 'webgpu' ? 'WebGPU' : 'the CPU'}`;
  await log('info', 'load', `Loading ${P[id].short} from this device (${AL.size(rec.total)}, ${where}, ${conn.mode})…`, { pkg: id });
  cpStage('load.start', { pkg: id, dtype: rec.dtype, device: rec.device, mode: conn.mode });
  const hard = setTimeout(() => {
    event('ai.worker.unresponsive', { level: 'error', msg: `Loading ${P[id].short} took over ${LOAD_LIMIT_MS / 1000} s; restarting the engine`, code: 'WORKER_UNRESPONSIVE', stage: cp?.stage });
    restart('Loading took too long', 'WORKER_UNRESPONSIVE');
  }, LOAD_LIMIT_MS);
  try {
    const info = await request({ type: 'load', id: ctx.id, pkg: id, dtype: rec.dtype, device: rec.device, chunks: AL.dataChunks(P[id], rec.dtype), cls }, { progress: onProgress });
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
    clearTimeout(hard);
  }
}

async function unloadStep(ctx, id, why) {
  if (!loaded.has(id) || !conn) return;
  cpStage('dispose.start', { pkg: id });
  try {
    await request({ type: 'unload', id: ctx.id, pkg: id, why });
  } catch (e) {
    // a model that cannot be released cleanly is not trusted: the whole engine goes
    event('ai.model.dispose.failed', { level: 'error', msg: `Releasing ${P[id].short} failed: ${e.message}`, code: 'MODEL_DISPOSE_FAILED', ...modelFields(id) });
    restart('Releasing a model failed', 'MODEL_DISPOSE_FAILED');
    return;
  }
  loaded.delete(id);
  emit('loaded');
  await log('info', 'memory', `Unloaded ${P[id].short}`, { pkg: id });
}

async function noteFailure(id, phase, e) {
  const r = await state(id);
  if (r.status !== 'none') {
    Object.assign(r, { failures: (r.failures ?? 0) + 1, lastError: { phase, message: e.message, code: e.code, at: Date.now() } });
    if (phase === 'load' && e.code === 'MODEL_INCOMPATIBLE' && r.dtype) r.incompatible = { dtype: r.dtype, device: r.device, message: String(e.message).slice(0, 160), at: Date.now() };
    await save(r);
  }
  const code = e.code ?? classifyError(e, { stage: cp?.stage ?? phase });
  event('ai.operation.error', { level: 'error', msg: `${P[id]?.short ?? id}: ${e.message}`, code, stage: cp?.stage ?? phase, op: cp?.op, ...modelFields(id), detail: e.detail });
}

const cfgKey = (id) => {
  const r = recs.get(id);
  return PO.configKey(id, r?.device, r?.dtype);
};

/** Opens an operation's checkpoint (before anything risky happens). */
function begin(ctx, type, id, extra = {}) {
  const r = recs.get(id);
  cpStart({ op: ctx.id, type, pkg: id, dtype: r?.dtype, device: r?.device, ...extra });
}

// ---------- the public operations (each is queued; one runs at a time) ----------

/** Loads a model (queued behind anything running). */
export function ensureLoaded(id, { onProgress, owner } = {}) {
  return sched.run({ type: 'load', pkg: id, label: 'load', owner }, async (ctx) => {
    begin(ctx, 'load', id);
    try {
      const info = await loadStep(ctx, id, { onProgress });
      return info;
    } catch (e) {
      recycleIfNeeded(e.code, e.message);
      throw e;
    } finally {
      cpClear(ctx.id);
    }
  });
}

export function unload(id) {
  return sched.run({ type: 'unload', pkg: id, label: 'unload' }, async (ctx) => {
    begin(ctx, 'unload', id);
    try {
      await unloadStep(ctx, id, 'unloaded on request');
    } finally {
      cpClear(ctx.id);
    }
  });
}

/**
 * Writes a reply. Calls onToken with each new piece of text; resolves with the run's figures.
 * `maxPrompt` can only lower the profile's input limit (unless developer mode is on). `fit` lets
 * the engine cut the END of the last message to fit, counting exactly.
 */
export function generate(id, messages, { maxTokens = 128, onToken, onProgress, label = 'run', maxPrompt = null, fit = false, owner = null, meta = {} } = {}) {
  return sched.run({ type: 'generate', pkg: id, label, owner }, async (ctx) => {
    begin(ctx, 'generate', id);
    const key = ctx.id;
    const opStarted = Date.now();
    let last = Date.now();
    let warned = false;
    const watch = setInterval(() => {
      if (!warned && Date.now() - last > 90_000) {
        warned = true;
        log('warn', 'run', `${P[id].short} has produced nothing for 90 s; it may be stuck. Stop it and try a shorter text.`, { pkg: id });
      }
    }, 5000);
    let hard = null;
    try {
      preflight(id, 'generate');
      await ctx.child({ type: 'load', pkg: id, label: 'load' }, (c) => loadStep(c, id, { onProgress }));
      if (ctx.cancelled()) throw new Cancelled('Stopped');
      const limits = limitsFor(id, maxPrompt);
      current = key;
      cpStage('tokenize', { maxNew: Math.min(maxTokens, limits.maxNew) });
      // the engine stops itself at maxMs; if it cannot (stuck in one long call), the page ends it
      hard = setTimeout(() => {
        event('ai.worker.unresponsive', { level: 'error', msg: `${P[id].short} did not finish within ${Math.round((limits.maxMs + 20_000) / 1000)} s; restarting the engine`, code: 'WORKER_UNRESPONSIVE', op: key, stage: cp?.stage });
        restart('The AI took too long', 'WORKER_UNRESPONSIVE');
      }, limits.maxMs + 20_000);
      setWorker('busy', `${P[id].short} is working`);
      const { stats } = await request(
        { type: 'generate', id: key, pkg: id, messages, maxTokens, limits, fit, dev: safety.dev, vis: document.visibilityState },
        {
          token: (t) => {
            last = Date.now();
            onToken?.(t);
          },
        },
      );
      clearTimeout(hard);
      workerState = 'responsive';
      const tps = stats.tokens && stats.ms > (stats.ttft ?? 0) ? (stats.tokens / ((stats.ms - (stats.ttft ?? 0)) / 1000)) : null;
      const completed = !stats.stopped && stats.stopReason !== 'timeout';
      const r = await state(id);
      r.lastRun = { ...stats, at: Date.now(), label };
      await save(r);
      const m = { ...stats, tps: tps && Math.round(tps * 10) / 10, completed, queueMs: opMeta.get(key)?.queueMs ?? 0, label, ...meta, totalMs: Date.now() - opStarted, mem: undefined, est: undefined, estimated: stats.est };
      lastInference = event('ai.inference.completed', {
        level: stats.stopReason === 'timeout' ? 'error' : 'ok',
        msg: `${P[id].short} (${label}): ${AL.describeRun(stats)}${stats.stopReason === 'timeout' ? ' · timed out' : ''}`,
        status: completed ? 'ok' : stats.stopReason,
        op: key,
        stage: 'generate.done',
        ...modelFields(id),
        m,
      });
      noteOutcome(cfgKey(id), completed || stats.stopped ? 'ok' : 'failed', { stage: 'generate.done' });
      if (stats.stopReason === 'timeout') throw new AiError('INFERENCE_TIMEOUT', `Stopped after ${Math.round(limits.maxMs / 1000)} s`, { partial: true });
      // a long prompt leaves memory reserved: give it back right away on phones
      if (PO.isLowMemory(cls) && stats.promptTokens > limits.maxInput * 0.85) {
        current = null;
        await ctx.child({ type: 'unload', pkg: id, label: 'give back memory' }, (c) => unloadStep(c, id, 'after a long prompt'));
        await log('info', 'memory', `Unloaded ${P[id].short} after a ${stats.promptTokens}-token prompt, to give back the memory it used`, { pkg: id });
      }
      return stats;
    } catch (e) {
      clearTimeout(hard);
      const code = e.code && e.code !== 'UNKNOWN' ? e.code : classifyError(e, { stage: cp?.stage, gpuLost });
      e.code = code;
      const stage = cp?.stage ?? e.stage ?? null;
      event('ai.inference.failed', {
        level: code === 'CANCELLED' || code === 'BACKGROUNDED' ? 'warn' : 'error',
        msg: `${P[id]?.short ?? id}: ${e.message}`,
        status: code === 'CANCELLED' ? 'cancelled' : 'error',
        code,
        op: key,
        stage,
        ...modelFields(id),
        m: { inputTokens: cp?.inputTokens, tokens: cp?.tokens, label },
        detail: e.detail,
      });
      if (!BENIGN.has(code)) {
        noteOutcome(cfgKey(id), 'failed', { code, stage });
        await noteFailure(id, 'run', e);
      }
      recycleIfNeeded(code, e.message);
      throw e;
    } finally {
      clearInterval(watch);
      clearTimeout(hard);
      if (workerState === 'busy') workerState = 'responsive';
      cpClear(ctx.id);
      if (current === key) current = null;
      touch();
    }
  });
}

/**
 * Runs `fn` with BGE loaded, in one queued operation, and releases BGE afterwards (before any
 * chat model loads). fn receives { embed(texts, {query}) }.
 */
export function withEmbedder(fn, { owner = null, label = 'embed' } = {}) {
  return sched.run({ type: 'embed', pkg: 'bge', label, owner }, async (ctx) => {
    begin(ctx, 'embed', 'bge');
    let n = 0;
    try {
      preflight('bge', 'embed');
      await ctx.child({ type: 'load', pkg: 'bge', label: 'load' }, (c) => loadStep(c, 'bge'));
      const e = {
        embed: async (texts, { query = false } = {}) => {
          if (document.visibilityState === 'hidden') throw new AiError('BACKGROUNDED');
          if (ctx.cancelled()) throw new AiError('CANCELLED');
          const { vecs, ms, cut } = await request({ type: 'embed', id: `${ctx.id}.${++n}`, pkg: 'bge', texts, query });
          return Object.assign(vecs, { ms, cut });
        },
        cancelled: () => ctx.cancelled(),
      };
      const out = await fn(e);
      noteOutcome(cfgKey('bge'), 'ok', {});
      return out;
    } catch (err) {
      const code = err.code && err.code !== 'UNKNOWN' ? err.code : classifyError(err, { stage: cp?.stage, gpuLost });
      err.code = code;
      event('ai.embed.failed', { level: code === 'CANCELLED' || code === 'BACKGROUNDED' ? 'warn' : 'error', msg: `Embedding failed: ${err.message}`, code, op: ctx.id, stage: cp?.stage, ...modelFields('bge') });
      if (!BENIGN.has(code)) {
        noteOutcome(cfgKey('bge'), 'failed', { code, stage: cp?.stage });
        await noteFailure('bge', 'embed', err);
      }
      recycleIfNeeded(code, err.message);
      throw err;
    } finally {
      if (loaded.has('bge') && conn) {
        try {
          await ctx.child({ type: 'unload', pkg: 'bge', label: 'release BGE' }, (c) => unloadStep(c, 'bge', 'retrieval finished: freeing memory before any chat model loads'));
        } catch {
          // the engine was already gone
        }
      }
      cpClear(ctx.id);
    }
  });
}

/** BGE vectors for some texts (normalised, 384 numbers each). One queued operation. */
export const embed = (texts, { query = false } = {}) => withEmbedder((e) => e.embed(texts, { query }), { label: 'embed' });

/**
 * Stops work. A running generation is told to stop (its text so far is kept by the caller); with an
 * `owner`, that owner's waiting operations are dropped too. If the running operation does not end
 * within 8 s (a model load cannot be interrupted, for one), the engine is restarted.
 */
export function stop(why = 'user', owner = null) {
  if (owner != null) cancelQueued(owner);
  const act = sched.snapshot().active;
  const key = current ?? (act && (owner == null || act.owner === owner) ? act.id : null);
  if (!key) return;
  if (current === key && conn) conn.send({ type: 'stop', id: key });
  sched.cancel(key, 'Stopped');
  event('ai.inference.stop_requested', { level: 'info', msg: `Stop requested (${why})`, op: key, stage: cp?.stage, m: { why } });
  setTimeout(() => {
    if (sched.snapshot().active?.id === key && conn) {
      event('ai.worker.unresponsive', { level: 'error', msg: 'The AI did not stop within 8 s, so the AI engine was restarted', code: 'WORKER_UNRESPONSIVE', op: key, stage: cp?.stage });
      restart('Stopped', 'WORKER_UNRESPONSIVE');
    }
  }, 8000);
}

/** Drops waiting operations started by `owner` (a screen that went away), without touching the running one. */
export const cancelQueued = (owner) => sched.cancel((o) => o.owner === owner && o.startedAt == null, 'Cancelled');

export const running = () => !!current;

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

/** Removes a package's files. Removing the last model removes the engine too. Quarantine is kept. */
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
  recs.delete(id);
  if (id === 'bge') {
    await AS.clearStore('vectors');
    vecCache.clear();
  }
  if (P[id].kind === 'chat') await AS.delPrefix('notes', `sum|${id}|`);
  await log('ok', 'storage', `Removed ${P[id].name}${r.have ? `: freed about ${AL.size(r.have)}` : ''}`, { pkg: id });
  emit('pkg', { id, status: 'none' });
  if (id !== 'engine' && !(await Promise.all(AL.MODEL_IDS.map(state))).some((x) => x.status !== 'none')) {
    restart('No models left', 'CANCELLED');
    await remove('engine');
  }
}

/** Deletes every AI file, vector, summary and log entry, the safety history, and the database itself. */
export async function removeAll() {
  queue.splice(0);
  if (job) {
    job.stopReason = 'Removed';
    job.ctrl.abort(new Error('Removed'));
    await job.promise;
  }
  sched.cancel(() => true, 'All AI data removed');
  restart('All AI data removed', 'CANCELLED');
  await AS.destroy();
  try {
    await caches.delete('transformers-cache');
  } catch {
    // no Cache Storage
  }
  for (const k of Object.values(K)) jdel(k);
  cp = null;
  quarantine = new Map();
  history = {};
  interruptionRec = null;
  safety.dev = false;
  safety.optIn = [];
  gpuLost = false;
  lastInference = null;
  vecCache.clear();
  ready.clear();
  recs.clear();
  persist = false;
  logger.clear();
  await log('ok', 'storage', 'Removed all AI data from this device');
  emit('pkg', null);
}

// ---------- startup ----------

let interruptionRec = interruption;

export const lastInterruption = () => (interruptionRec && !interruptionRec.acknowledged ? interruptionRec : null);
export function ackInterruption() {
  if (!interruptionRec) return;
  interruptionRec = { ...interruptionRec, acknowledged: true };
  jset(K.interruption, interruptionRec);
  emit('safety');
}

/** True when automatic summaries may run: nothing has been switched off for safety. */
export const autoAllowed = () => quarantine.size === 0 && !gpuLost && !versionMismatch;

/**
 * Looks at the checkpoint (or the older busy marker) that the last launch left behind, decides what it
 * most likely means, and acts on it: counts it, switches the configuration off when the evidence
 * calls for it, and keeps a note for the AI page. A leftover checkpoint is not proof of a crash.
 */
async function recoverFromInterruption(old, legacy) {
  jdel(K.cp);
  jdel(K.legacy);
  const stale = old && old.v !== PO.POLICY_VERSION;
  const c = old && !stale ? old : { legacy: true, v: 1, type: legacy?.what ?? old?.type, pkg: legacy?.pkg ?? old?.pkg, stage: 'unknown', started: legacy?.at ?? old?.started ?? Date.now(), progress: legacy?.at ?? old?.progress ?? Date.now(), vis: 'unknown', hiddenMs: 0 };
  const key = c.pkg && c.device && c.dtype ? `${c.pkg}@${(c.rev ?? '').slice(0, 8)}|${c.device}|${c.dtype}` : null;
  const diag = PO.classifyInterruption(c, { history: key ? (history[key] ?? {}) : {} });
  const unexplained = diag.category === 'UNEXPECTED_INTERRUPTION' || diag.category === 'POSSIBLE_MEMORY_EXHAUSTION';
  event('ai.recovery.interrupted', {
    level: unexplained && diag.quarantine ? 'error' : 'warn',
    msg: diag.message,
    code: diag.category,
    op: c.op,
    stage: c.stage,
    pkg: c.pkg,
    dtype: c.dtype,
    backend: c.device,
    m: { confidence: diag.confidence, quarantine: diag.quarantine, reasons: diag.reasons, inputTokens: c.inputTokens, maxNew: c.maxNew, tokens: c.tokens, vis: c.vis, hiddenMs: c.hiddenMs, startedAt: c.started, progressAt: c.progress, previousSession: c.sid },
  });
  if (key && unexplained) noteOutcome(key, 'interrupted', { category: diag.category, stage: c.stage });
  if (key && diag.quarantine) {
    setQuarantine(key, { at: Date.now(), category: diag.category, confidence: diag.confidence, reasons: diag.reasons, stage: c.stage, pkg: c.pkg, dtype: c.dtype, device: c.device, inputTokens: c.inputTokens });
  }
  const r = c.pkg ? await AS.get('pkgs', c.pkg).catch(() => null) : null;
  if (r && r.status !== 'none') {
    Object.assign(r, { crashes: (r.crashes ?? 0) + (unexplained ? 1 : 0), lastCrash: { stage: c.stage, category: diag.category, found: Date.now() } });
    await AS.put('pkgs', r.id, r);
  }
  interruptionRec = { ...diag, checkpoint: c, at: Date.now(), acknowledged: false };
  jset(K.interruption, interruptionRec);
}

/** Run once at app start. Does nothing (and creates nothing) if the AI was never used. */
export async function init() {
  const old = jget(K.cp, null);
  const legacy = jget(K.legacy, null);
  let exists = true;
  try {
    const dbs = await indexedDB.databases?.();
    if (dbs) exists = dbs.some((d) => d.name === 'sparse-ai');
  } catch {
    exists = true;
  }
  if (!exists && !old && !legacy) return;
  persist = true;
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('pagehide', onPageHide);
  event('ai.app.launch', { msg: `AI session started (${cls}, build ${AL.AI_BUILD})`, m: { cls, standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true } });
  if (old || legacy) await recoverFromInterruption(old, legacy);
  for (const id of Object.keys(P)) {
    const r = await AS.get('pkgs', id).catch(() => null);
    if (!r) continue;
    recs.set(id, r);
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
  emit('safety');
}

// ---------- retrieval ----------

const indexer = SEL.createIndexer();
const vecCache = new Map(); // passage id -> { h, v }
let vecLoaded = false;

async function loadVectors() {
  if (vecLoaded) return;
  vecLoaded = true;
  let bad = 0;
  for (const [id, rec] of await AS.all('vectors').catch(() => [])) {
    if (SEL.validVector(rec?.v)) vecCache.set(id, rec);
    else {
      bad++;
      AS.del('vectors', id).catch(() => {});
    }
  }
  if (bad) event('ai.storage.vectors_discarded', { level: 'warn', msg: `${bad} stored vectors were damaged and were discarded; they will be rebuilt when needed`, code: 'STORAGE_ERROR', m: { count: bad } });
}

/**
 * Finds the passages from saved pages and searches that best match a question: keyword match
 * (always, from an index that is updated rather than rebuilt) fused with meaning match (when BGE is
 * downloaded and allowed). `budget` is a hard limit on characters of evidence, labels included.
 * BGE is released before this returns, so a chat model can load next. `say(kind, text)` narrates.
 * Never throws because the AI is unavailable: it falls back to keywords.
 */
export async function retrieve(question, { budget = 1000, max = 4, say = () => {}, owner = null } = {}) {
  const m = {};
  const t0 = performance.now();
  const [results, pages] = await Promise.all([S.entries('results'), S.entries('pages')]);
  const all = SEL.collectPassages(results, pages);
  m.collectMs = Math.round(performance.now() - t0);
  const pageCount = new Set(all.filter((p) => p.kind === 'page').map((p) => p.url)).size;
  say('step', `Looking through ${pageCount} pages and ${all.length - all.filter((p) => p.kind === 'page').length} search results kept on this device (${all.length} passages)`);
  if (!all.length) {
    m.totalMs = Math.round(performance.now() - t0);
    return { all, picked: [], metrics: m, semantic: 'off' };
  }
  const idx = indexer.sync(all);
  Object.assign(m, { bm25BuildMs: Math.round(idx.ms), bm25Added: idx.added, bm25Reused: idx.reused, bm25Removed: idx.removed });
  const tk = performance.now();
  const hits = indexer.search(question, 30);
  m.keywordMs = Math.round(performance.now() - tk);
  const words = hits.map((x) => x.i);
  say(words.length ? 'ok' : 'skip', `Keyword match: ${words.length ? `${words.length} passages share words with the question` : 'no passage shares a word with the question'}`);
  let meaning = [];
  m.semantic = 'off';
  if (ready.has('bge') && mayRun('bge').ok) {
    m.semantic = 'on';
    await loadVectors();
    const hasVec = (p) => vecCache.get(p.id)?.h === AL.hash(p.text);
    m.cachedVectors = all.filter(hasVec).length;
    const cands = SEL.embedCandidates(all, hits, hasVec, PO.profileFor('bge', cls).maxPerRun ?? 64);
    try {
      const tb = performance.now();
      if (cands.length) say('step', `Meaning match: indexing ${cands.length} passages with BGE (kept on this device afterwards)…`);
      const qv = await withEmbedder(
        async (e) => {
          m.bgeReadyMs = Math.round(performance.now() - tb);
          const te = performance.now();
          let fresh = 0;
          for (let i = 0; i < cands.length; i += 16) {
            const batch = cands.slice(i, i + 16);
            const vecs = await e.embed(batch.map((ix) => all[ix].text));
            for (const [k, ix] of batch.entries()) {
              const rec = { h: AL.hash(all[ix].text), v: vecs[k] };
              vecCache.set(all[ix].id, rec);
              await AS.put('vectors', all[ix].id, rec);
              fresh++;
            }
            emit('index-progress', { done: Math.min(i + 16, cands.length), total: cands.length });
          }
          m.embedMs = Math.round(performance.now() - te);
          m.newVectors = fresh;
          const [q] = await e.embed([question], { query: true });
          return q;
        },
        { owner, label: 'retrieval' },
      );
      m.bgeLoadAndEmbedMs = Math.round(performance.now() - tb);
      const ts = performance.now();
      const scored = all
        .map((p, i) => ({ i, v: hasVec(p) ? vecCache.get(p.id).v : null }))
        .filter((x) => x.v)
        .map((x) => ({ i: x.i, s: AL.dot(qv, x.v) }))
        .sort((a, b) => b.s - a.s);
      meaning = scored.filter((x) => x.s > 0.55).slice(0, 30).map((x) => x.i);
      m.semanticMs = Math.round(performance.now() - ts);
      say(meaning.length ? 'ok' : 'skip', `Meaning match: ${meaning.length} close passages (best similarity ${scored[0]?.s.toFixed(2) ?? '–'}; ${scored.length} of ${all.length} passages have vectors)`);
      const live = new Set(all.map((p) => p.id));
      for (const id of [...vecCache.keys()])
        if (!live.has(id)) {
          vecCache.delete(id);
          AS.del('vectors', id).catch(() => {});
        }
    } catch (err) {
      m.semantic = 'failed';
      m.semanticError = err.code ?? err.name;
      say('skip', `Meaning match skipped, using keywords only: ${explain(err)}`);
    }
  } else say('skip', ready.has('bge') ? `Meaning match is off (${mayRun('bge').why}), so keyword match only` : 'Meaning match: BGE is not downloaded, so keyword match only');
  const tf = performance.now();
  const fused = AL.fuse({ words, meaning });
  m.fuseMs = Math.round(performance.now() - tf);
  const tp = performance.now();
  const picked = SEL.pickContext(fused, all, budget, max, { question });
  m.selectMs = Math.round(performance.now() - tp);
  Object.assign(m, { passages: all.length, considered: fused.length, selected: picked.length, excluded: Math.max(0, fused.length - picked.length), excerpted: picked.filter((p) => p.excerpted).length, evidenceChars: picked.reduce((n, p) => n + p.text.length, 0), budget, totalMs: Math.round(performance.now() - t0) });
  event('ai.retrieval.completed', { level: 'ok', msg: `Retrieval: ${picked.length} of ${fused.length} candidate passages chosen in ${m.totalMs} ms (${m.semantic} meaning match)`, m });
  return { all, picked, metrics: m, semantic: m.semantic };
}

// ---------- summaries and questions ----------

/** A summary made earlier for this model, this way of choosing text, and this version of the page. */
export const getSummary = (url, pkg, markdown) => (persist ? AS.get('notes', SEL.summaryKey({ pkg, revision: P[pkg]?.revision, url, text: markdown })).catch(() => null) : null);
export async function saveSummary(url, pkg, markdown, rec) {
  await AS.delPrefix('notes', SEL.summaryPrefix(pkg, url)).catch(() => {});
  await AS.put('notes', SEL.summaryKey({ pkg, revision: P[pkg]?.revision, url, text: markdown }), { ...rec, rev: P[pkg]?.revision, strategy: SEL.STRATEGY_VERSION }).catch(() => {});
}

export async function recentAsks() {
  if (!persist) return [];
  return (await AS.get('notes', 'asks').catch(() => null)) ?? [];
}
export async function saveAsk(entry) {
  const list = await recentAsks();
  await AS.put('notes', 'asks', [entry, ...list].slice(0, 15)).catch(() => {});
}
export const clearAsks = () => AS.del('notes', 'asks').catch(() => {});

// ---------- status and reports ----------

/** What the diagnostics screen shows at the top. */
export const status = () => ({
  op: sched.snapshot(),
  worker: workerInfo(),
  loaded: [...loaded.entries()].map(([id, i]) => ({ id, ...i })),
  cls,
  dev: safety.dev,
  quarantine: quarantined(),
  gpuLost,
  versionMismatch,
  lastInference,
  interruption: lastInterruption(),
  logger: logger.stats(),
});

export const history_ = () => history;

/** One row per model for this device class: status, limits, whether it may run. */
export function profileTable() {
  return Object.keys(P)
    .filter((id) => P[id].kind !== 'engine')
    .map((id) => {
      const p = PO.profileFor(id, cls);
      const r = recs.get(id);
      const may = r?.dtype ? PO.mayRun(id, r.device, r.dtype, policyState()) : null;
      return { id, ...p, optIn: p.status === 'experimental' ? optedIn(id) : undefined, runnable: may ? may.ok : null, blockedBy: may && !may.ok ? may.code : null };
    });
}

let debugCapsule = null;
/** In memory only, never stored: the question and source titles of the last answer, for an opted-in detailed report. */
export const noteDetail = (d) => {
  debugCapsule = d;
};

export async function diagnostics({ detail = false } = {}) {
  const [d, st, entries, jsStore] = await Promise.all([device(true), states(), readLog(300), navigator.storage?.estimate?.().catch(() => null) ?? null]);
  const estimates = AL.CHAT_IDS.map((id) => {
    const lim = PO.profileFor(id, cls);
    if (!lim.maxInput) return `${P[id].short}: no limits on this device (${lim.status})`;
    const est = PO.estimateAllocations(id, lim.maxInput);
    return `${P[id].short}: ${est.positions === 1 ? 'scores for the last position only' : `scores for all ${est.positions} prompt positions`}: ≈${AL.size(est.logits + est.castCopy)} (${AL.size(est.logits)} scores${est.castCopy ? ` + ${AL.size(est.castCopy)} 16→32-bit copy` : ''}), key/value cache ≈${AL.size(est.kv)}, at the ${lim.maxInput}-token limit`;
  });
  const data = {
    now: Date.now(),
    formatVersion: 2,
    build: AL.AI_BUILD,
    runtimeVersions: 'Transformers.js 4.3.0 · ONNX Runtime Web 1.31.0-dev.20260914',
    mode: conn?.mode ?? 'not started',
    deviceClass: cls,
    device: d,
    memory: { jsHeap: globalThis.performance?.memory?.usedJSHeapSize ?? null, jsHeapLimit: globalThis.performance?.memory?.jsHeapSizeLimit ?? null, storageUsage: jsStore?.usage ?? null },
    scheduler: sched.snapshot(),
    worker: workerInfo(),
    loaded: [...loaded.keys()],
    models: Object.values(st).map((r) => ({ id: r.id, status: r.status, dtype: r.dtype, device: r.device, revision: P[r.id]?.revision, have: r.have, failures: r.failures, crashes: r.crashes })),
    profiles: profileTable(),
    quarantine: quarantined().map((q) => ({ key: q.key, category: q.category, confidence: q.confidence, at: q.at })),
    history,
    interruption: interruptionRec,
    lastInference,
    performance: performanceSummary(entries),
    estimates,
    logger: logger.stats(),
    events: entries,
    detail: detail && debugCapsule ? [`question: ${debugCapsule.question}`, ...(debugCapsule.sources ?? []).map((s, i) => `source ${i + 1}: ${s}`)] : detail ? ['no question has been asked in this session'] : null,
  };
  return data;
}

/** Everything useful for a bug report, as text (and JSON). Nothing is sent anywhere. */
export async function report(opts = {}) {
  const r = buildReport(await diagnostics(opts));
  return r.text;
}
export async function reportJson(opts = {}) {
  return JSON.stringify(buildReport(await diagnostics(opts)).json, null, 1);
}

/** Developer mode: clears the stored history of runs (not quarantine). */
export function clearHistory() {
  history = {};
  jset(K.history, history);
  emit('safety');
}

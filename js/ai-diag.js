// Diagnostics for the on-device AI: structured events, an error taxonomy with plain explanations,
// privacy rules, bounded storage and the exportable report. Pure (sinks are passed in): tested in test/.
//
// Everything stays on the device. Nothing here sends anything anywhere. By default no page text,
// question, answer, search term or address is recorded: only counts, lengths, hashes and timings.

// ---------- error taxonomy ----------

/** code -> what to tell a person (no jargon), and whether trying again can work. */
export const ERRORS = {
  MODEL_NOT_INSTALLED: { text: 'The AI model is not on this device. Download it on the AI page.', retry: false },
  MODEL_NOT_ENABLED: { text: 'This model is experimental on this device and is switched off. Turn it on in AI settings to use it.', retry: false },
  MODEL_QUARANTINED: { text: 'This model was switched off because it was interrupted unexpectedly. Your saved pages are untouched. See AI settings.', retry: false },
  MODEL_LOAD_FAILED: { text: 'The model could not be loaded into memory.', retry: true },
  MODEL_INCOMPATIBLE: { text: 'This model cannot run on this device.', retry: false },
  GPU_UNAVAILABLE: { text: 'This needs the GPU (WebGPU), which is not available here.', retry: false },
  GPU_DEVICE_LOST: { text: 'The GPU stopped responding. Reset the AI engine and try again.', retry: true },
  TOKEN_BUDGET_EXCEEDED: { text: 'The text was too long for the safe limit on this device, so the AI was not run.', retry: false },
  TOKENIZATION_FAILED: { text: 'The text could not be measured, so the AI was not run.', retry: false },
  INFERENCE_FAILED: { text: 'The AI failed while writing.', retry: true },
  INFERENCE_TIMEOUT: { text: 'The AI took too long and was stopped.', retry: true },
  WORKER_FAILED: { text: 'The AI engine stopped unexpectedly and was restarted.', retry: true },
  WORKER_UNRESPONSIVE: { text: 'The AI engine stopped responding and was restarted.', retry: true },
  MODEL_DISPOSE_FAILED: { text: 'The model could not be cleanly released from memory, so the engine was restarted.', retry: true },
  STORAGE_ERROR: { text: 'The device storage could not be read or written.', retry: true },
  POSSIBLE_MEMORY_EXHAUSTION: { text: 'The device may have run out of memory.', retry: false },
  UNEXPECTED_INTERRUPTION: { text: 'The app was interrupted unexpectedly while the AI was working.', retry: false },
  NOT_FOREGROUND: { text: 'The AI only runs while the app is on screen.', retry: true },
  BACKGROUNDED: { text: 'The AI stopped because the app went to the background.', retry: true },
  VERSION_MISMATCH: { text: 'Parts of the app are from different versions. Close the app completely and open it again (twice) to finish updating.', retry: true },
  QUEUE_FULL: { text: 'The AI is busy with other tasks. Try again in a moment.', retry: true },
  CANCELLED: { text: 'Stopped.', retry: true },
  UNKNOWN: { text: 'Something went wrong with the AI.', retry: true },
};

export class AiError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? ERRORS[code]?.text ?? code);
    this.name = 'AiError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/** A plain-language message for an error: the taxonomy text first, then the original wording. */
export function explain(e) {
  const code = e?.code && ERRORS[e.code] ? e.code : 'UNKNOWN';
  const base = ERRORS[code].text;
  const own = e?.message && e.message !== base ? e.message : '';
  return own && code !== 'CANCELLED' ? `${base} (${own})` : base;
}

/**
 * Classifies an error, only as far as it can be substantiated by the error itself or the stage.
 * `stage` is the last stage reached ('load.start', 'prefill', …).
 */
export function classifyError(e, { stage = '', gpuLost = false } = {}) {
  if (e?.code && ERRORS[e.code]) return e.code;
  const msg = `${e?.name ?? ''} ${e?.message ?? e ?? ''}`;
  if (e?.name === 'Cancelled') return 'CANCELLED';
  if (gpuLost || /device (was )?lost|GPUDeviceLostInfo|device is lost/i.test(msg)) return 'GPU_DEVICE_LOST';
  if (/out of memory|allocation failed|bad_alloc|array buffer allocation|Aborted\(OOM|cannot allocate|memory access out of bounds|RangeError.*(Invalid|allocation)/i.test(msg)) return 'POSSIBLE_MEMORY_EXHAUSTION';
  if (/QuotaExceeded|IDBDatabase|IndexedDB|transaction (was )?aborted|is damaged on this device/i.test(msg)) return 'STORAGE_ERROR';
  if (/not downloaded|not on this device|is not loaded/i.test(msg)) return /not loaded/.test(msg) ? 'MODEL_LOAD_FAILED' : 'MODEL_NOT_INSTALLED';
  if (/WebGPU|navigator\.gpu|requestAdapter/i.test(msg) && /unavailable|missing|no adapter|not supported/i.test(msg)) return 'GPU_UNAVAILABLE';
  if (/tokeniz|apply_chat_template/i.test(msg)) return 'TOKENIZATION_FAILED';
  if (/worker/i.test(msg) && /stopped|terminated|restarted/i.test(msg)) return 'WORKER_FAILED';
  if (/unsupported|GatherBlockQuantized|no (kernel|implementation)|Could not find an implementation|not implemented/i.test(msg)) return 'MODEL_INCOMPATIBLE';
  if (/^load|^model\./.test(stage)) return 'MODEL_LOAD_FAILED';
  if (/^(tokenize|prefill|first_token|decode)/.test(stage)) return 'INFERENCE_FAILED';
  return 'UNKNOWN';
}

// ---------- ids ----------

let counter = 0;
export function newId(prefix = 'x') {
  counter = (counter + 1) % 1e6;
  const r = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0');
  return `${prefix}${Date.now().toString(36)}${r}${counter.toString(36)}`;
}

// ---------- privacy ----------

/** Field names that may hold what a person wrote or read. Dropped from every event. */
const PRIVATE = new Set(['text', 'question', 'q', 'answer', 'prompt', 'content', 'messages', 'markdown', 'query', 'snippet', 'title', 'url', 'urls', 'token', 'key', 'apiKey', 'authorization']);

function clean(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth > 3) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => clean(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (PRIVATE.has(k)) continue;
      const c = clean(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return undefined;
}

/** Removes secrets and addresses from a free-text message (error messages can contain either). */
export function scrub(s) {
  return String(s ?? '')
    .replace(/https?:\/\/[^\s"')]+/g, (u) => {
      try {
        const x = new URL(u);
        return /huggingface\.co|jsdelivr\.net/.test(x.hostname) ? `${x.hostname}${x.pathname.slice(0, 60)}` : `[address on ${x.hostname}]`;
      } catch {
        return '[address]';
      }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [removed]')
    .replace(/\b(api[_-]?key|token|secret|password)=([^&\s]+)/gi, '$1=[removed]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[long id removed]')
    .slice(0, 400);
}

// ---------- the logger ----------

export const EVENT_AREAS = { ai: 'ai', model: 'load', prompt: 'prompt', inference: 'run', operation: 'op', retrieval: 'retrieval', worker: 'engine', recovery: 'crash', ui: 'ui', memory: 'memory', quarantine: 'safety', download: 'download', storage: 'storage' };
const areaOf = (ev) => EVENT_AREAS[ev.split('.')[1]] ?? 'ai';

/**
 * Creates the logger. `base` has the fields every event carries (sid, runtime, mode…).
 * `write(entries[])` persists a batch (async, may fail: failures are counted, never thrown).
 * Writes are batched and happen off the hot path, so token streaming is never waiting on storage.
 */
export function createLogger({ base = {}, write = null, keep = 300, flushMs = 1000, now = () => Date.now(), sink = null, max = 600 } = {}) {
  let ring = [];
  let pending = [];
  let timer = null;
  const stats = { events: 0, written: 0, writeFailures: 0, dropped: 0 };

  async function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending.length || !write) return;
    const batch = pending;
    pending = [];
    try {
      await write(batch);
      stats.written += batch.length;
    } catch {
      stats.writeFailures++;
      stats.dropped += batch.length; // not retried: diagnostics must not grow without bound
    }
  }

  function event(ev, fields = {}) {
    const { level = 'info', msg = '', m, detail, ...rest } = fields;
    const e = {
      v: 2,
      t: now(),
      level,
      ev,
      area: areaOf(ev),
      msg: scrub(msg || ev),
      ...base,
      ...clean(rest),
    };
    if (m) e.m = clean(m);
    if (detail) e.detail = scrub(detail).slice(0, 400);
    stats.events++;
    ring = [e, ...ring].slice(0, keep);
    try {
      sink?.(e);
    } catch {
      // a screen that went away
    }
    if (write) {
      pending.push(e);
      if (pending.length > max) {
        pending.shift();
        stats.dropped++;
      }
      timer ??= setTimeout(flush, flushMs);
    }
    return e;
  }

  return {
    event,
    flush,
    recent: () => ring,
    clear() {
      ring = [];
      pending = [];
    },
    set base(b) {
      Object.assign(base, b);
    },
    get base() {
      return base;
    },
    stats: () => ({ ...stats }),
  };
}

// ---------- statistics ----------

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Figures for the diagnostics screen, from structured events (newest first or any order). */
export function performanceSummary(entries) {
  const by = (ev) => entries.filter((e) => e.ev === ev);
  const done = by('ai.inference.completed').filter((e) => e.status === 'ok' || e.m?.completed);
  const loads = by('ai.model.load.completed');
  const retr = by('ai.retrieval.completed');
  const failures = entries.filter((e) => e.level === 'error' && e.code);
  const byCode = {};
  for (const f of failures) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return {
    runs: done.length,
    medianTtftMs: median(done.map((e) => e.m?.ttft)),
    medianTokensPerSec: median(done.map((e) => e.m?.tps)),
    medianRunMs: median(done.map((e) => e.m?.ms)),
    recentRunMs: done.slice(0, 8).map((e) => e.m?.ms),
    loads: loads.length,
    medianLoadMs: median(loads.map((e) => e.m?.ms)),
    retrievals: retr.length,
    medianRetrievalMs: median(retr.map((e) => e.m?.totalMs)),
    failures: failures.length,
    failuresByCode: byCode,
  };
}

/** The first and last stage of an operation, from its events: where did it stop? */
export function traceOperation(entries, op) {
  const mine = entries.filter((e) => e.op === op || e.parent === op).sort((a, b) => a.t - b.t);
  const stages = mine.filter((e) => e.stage).map((e) => e.stage);
  const failed = mine.find((e) => e.ev === 'ai.operation.failed' || e.ev === 'ai.operation.cancelled');
  return { events: mine.map((e) => e.ev), lastStage: stages.at(-1) ?? null, failedStage: failed?.stage ?? null, failed: !!failed, code: failed?.code ?? null };
}

// ---------- report ----------

const line = (k, v) => `${k}: ${v === undefined || v === null ? 'unavailable' : typeof v === 'object' ? JSON.stringify(v) : v}`;
const iso = (t) => (t ? new Date(t).toISOString() : 'never');

/**
 * Builds the report. `d` carries everything gathered by the page (see ai.js report()); this only
 * lays it out. Source text is included only if `d.detail` is set (and the person opted in).
 */
export function buildReport(d) {
  const o = [];
  const push = (...a) => o.push(...a);
  push(`Sparse on-device AI report · ${iso(d.now)}`, `Report format ${d.formatVersion ?? 2}. Stays on this device unless you copy it somewhere.`, '');
  push('APP', line('build', d.build), line('engine', d.runtimeVersions), line('page mode', d.mode), '');
  push('DEVICE', line('class', d.deviceClass), line('standalone (home screen)', d.device?.standalone), line('cores', d.device?.cores), line('deviceMemory (browser estimate, GB)', d.device?.memory));
  push(line('WebGPU', d.device?.gpu?.gpu ? `${d.device.gpu.adapter ?? 'yes'}${d.device.gpu.f16 ? ' with 16-bit floats' : ''}${d.device.gpu.fallback ? ' (software fallback)' : ''}` : `no${d.device?.gpu?.why ? ` (${d.device.gpu.why})` : ''}`));
  push(line('WebGPU limits', d.device?.gpu?.limits), line('storage', d.device?.storage), line('storage persistent', d.device?.persisted), line('user agent', d.device?.ua), '');
  push('MEMORY INDICATORS (measured values only; Safari does not expose process or GPU memory)', line('JS heap', d.memory?.jsHeap), line('JS heap limit', d.memory?.jsHeapLimit), line('storage used', d.memory?.storageUsage), '');
  push('CURRENT STATE', line('scheduler', d.scheduler?.state), line('active operation', d.scheduler?.active), line('queue depth', d.scheduler?.queue?.length), line('worker', d.worker), line('loaded', d.loaded?.join(', ') || 'nothing'), '');
  push('INSTALLED MODELS');
  for (const r of d.models ?? []) push(`  ${r.id}: ${r.status}${r.dtype ? ` ${r.dtype}/${r.device}` : ''}${r.revision ? ` rev ${r.revision.slice(0, 8)}` : ''}${r.have ? `, ${r.have} bytes` : ''}${r.failures ? `, ${r.failures} failures` : ''}`);
  push('', 'SAFETY PROFILES (this device class)');
  for (const p of d.profiles ?? []) push(`  ${p.id}: ${p.status}${p.maxInput ? ` · input ≤ ${p.maxInput}, new ≤ ${p.maxNew}, total ≤ ${p.maxTotal}, time ≤ ${Math.round(p.maxMs / 1000)} s` : ''}${p.why ? ` · ${p.why}` : ''}${p.optIn !== undefined ? ` · opted in: ${p.optIn}` : ''}`);
  push('', 'QUARANTINE');
  for (const q of d.quarantine?.length ? d.quarantine : [null]) push(q ? `  ${q.key}: ${q.category} (${q.confidence}), ${iso(q.at)}` : '  none');
  push('', 'CONFIGURATION HISTORY (clean runs / failures / unexplained interruptions)');
  for (const [k, h] of Object.entries(d.history ?? {})) push(`  ${k}: ${h.ok} / ${h.failed} / ${h.interrupted}, last ${h.last?.outcome ?? '?'} ${iso(h.last?.at)}`);
  push('', 'LAST INTERRUPTION AT LAUNCH');
  if (d.interruption) {
    const i = d.interruption;
    push(`  ${i.category} (confidence ${i.confidence}) · quarantined: ${i.quarantine ? 'yes' : 'no'}`, `  ${i.message}`, `  last stage: ${i.checkpoint?.stage} · model ${i.checkpoint?.pkg} ${i.checkpoint?.dtype}/${i.checkpoint?.device} · input ${i.checkpoint?.inputTokens ?? '?'} tokens, output budget ${i.checkpoint?.maxNew ?? '?'}`);
    push(`  started ${iso(i.checkpoint?.started)} · last progress ${iso(i.checkpoint?.progress)} · tokens so far ${i.checkpoint?.tokens} · page was ${i.checkpoint?.vis}, hidden for ${i.checkpoint?.hiddenMs ?? 0} ms`);
    for (const r of i.reasons ?? []) push(`  - ${r}`);
  } else push('  none');
  push('', 'LAST INFERENCE');
  const li = d.lastInference;
  if (li) push(`  ${li.status} · model ${li.pkg} ${li.dtype}/${li.backend} · input ${li.m?.inputTokens} tokens, output ${li.m?.tokens}/${li.m?.requestedNew} · first token ${li.m?.ttft} ms · ${li.m?.tps} tokens/s · total ${li.m?.ms} ms · stop: ${li.m?.stopReason}`);
  else push('  none this session');
  const p = d.performance ?? {};
  push('', 'PERFORMANCE (recent events)', `  runs ${p.runs} · median first token ${p.medianTtftMs ?? '–'} ms · median ${p.medianTokensPerSec?.toFixed?.(1) ?? '–'} tokens/s · median run ${p.medianRunMs ?? '–'} ms`, `  loads ${p.loads} · median load ${p.medianLoadMs ?? '–'} ms · retrievals ${p.retrievals} · median retrieval ${p.medianRetrievalMs ?? '–'} ms`, `  failures ${p.failures} ${JSON.stringify(p.failuresByCode ?? {})}`);
  push('', 'EXPECTED ALLOCATIONS (estimates from tensor shapes in the model files, not measurements)');
  for (const a of d.estimates ?? []) push(`  ${a}`);
  push('', `LOGGER ${JSON.stringify(d.logger ?? {})}`);
  if (d.detail) push('', 'DETAIL (includes text you asked about; you opted in to this)', ...(d.detail ?? []).map((x) => `  ${x}`));
  push('', 'RECENT EVENTS (newest first)');
  for (const e of d.events ?? [])
    push(
      `${iso(e.t)} ${String(e.level).toUpperCase().padEnd(5)} ${e.ev ?? `[${e.area}]`} ${e.op ? `op=${e.op} ` : ''}${e.parent ? `parent=${e.parent} ` : ''}${e.pkg ? `${e.pkg} ` : ''}${e.stage ? `stage=${e.stage} ` : ''}${e.code ? `code=${e.code} ` : ''}${e.msg}${e.m ? ` ${JSON.stringify(e.m)}` : ''}${e.detail ? `\n    ${String(e.detail).split('\n').slice(0, 3).join('\n    ')}` : ''}`,
    );
  const json = { ...d, events: undefined, eventsCount: d.events?.length };
  return { text: o.join('\n'), json: { ...json, events: d.events } };
}

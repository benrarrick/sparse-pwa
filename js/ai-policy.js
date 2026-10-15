// Safety policy for the on-device AI. Pure (no DOM, no storage): tested in test/.
//
// iOS can end a page that uses too much memory without any error the page can catch, so the policy
// is built around not starting work that is known or suspected to be unsafe:
//   - every model/backend/weights combination has a SAFETY PROFILE per device class, with a status
//     (provisional · experimental · unsupported) and hard token budgets
//   - a configuration that was interrupted unexpectedly is QUARANTINED until a person retests it
//   - a stale checkpoint left by the last launch is CLASSIFIED, not assumed to be an out-of-memory
//     crash: backgrounding and closing the app also leave one
import { PACKAGES } from './ai-lib.js';

/** Bump when the shape of stored checkpoints or history changes. */
export const POLICY_VERSION = 2;

// ---------- device class ----------

/**
 * 'ios' (iPhone, iPad, including iPadOS reporting a Mac), 'mobile' (other phones and tablets) or
 * 'desktop'. The first two are low-memory classes: the same web process is shared with Safari's
 * own limits, which are not exposed to pages.
 */
export function deviceClass(nav = globalThis.navigator, forced = null) {
  const ua = String(nav?.userAgent ?? '');
  let found = 'desktop';
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1)) found = 'ios';
  else if (/Android|Mobile|CriOS|FxiOS/.test(ua)) found = 'mobile';
  // A class can be forced to a STRICTER one (for testing, or a tablet you want treated as a phone), never a looser one.
  const strict = { desktop: 0, mobile: 1, ios: 2 };
  return forced in strict && strict[forced] > strict[found] ? forced : found;
}

export const isLowMemory = (cls) => cls === 'ios' || cls === 'mobile';

// ---------- safety profiles ----------

/**
 * Statuses:
 *   provisional  conservative limits; may be chosen automatically. Not yet qualified on a real device.
 *   experimental runs only when a person has opted in to it (per model).
 *   unsupported  never runs on this device class.
 * A configuration with no entry here (an unknown backend or weights file) is unsupported.
 *
 * Budgets are in tokens counted with the model's own tokenizer, system prompt and chat template
 * included. `maxTotal` is a real combined limit, below maxInput + maxNew: the longer the prompt, the
 * less room for the answer. The numbers are starting points chosen from what has been observed (an iPhone ran a
 * 338-token prompt on the 1.2B and was ended by iOS at about 650), not proven limits.
 */
const lim = (maxInput, maxNew, maxTotal, maxMs, extra = {}) => ({ maxInput, maxNew, maxTotal, maxMs, ...extra });

export const SAFETY = {
  lfm350: {
    ios: { status: 'provisional', backends: ['webgpu'], ...lim(220, 80, 280, 90_000, { retainMs: 120_000 }) },
    mobile: { status: 'provisional', backends: ['webgpu'], ...lim(220, 80, 280, 90_000, { retainMs: 120_000 }) },
    desktop: { status: 'provisional', backends: ['webgpu'], ...lim(600, 200, 700, 180_000, { retainMs: 600_000 }) },
  },
  lfm230: {
    ios: { status: 'provisional', backends: ['webgpu'], ...lim(200, 80, 260, 90_000, { retainMs: 120_000 }) },
    mobile: { status: 'provisional', backends: ['webgpu'], ...lim(200, 80, 260, 90_000, { retainMs: 120_000 }) },
    desktop: { status: 'provisional', backends: ['webgpu'], ...lim(500, 200, 700, 180_000, { retainMs: 600_000 }) },
  },
  lfm12: {
    ios: { status: 'experimental', backends: ['webgpu'], ...lim(300, 128, 380, 120_000, { retainMs: 60_000 }) },
    mobile: { status: 'experimental', backends: ['webgpu'], ...lim(300, 128, 380, 120_000, { retainMs: 60_000 }) },
    desktop: { status: 'experimental', backends: ['webgpu', 'wasm'], ...lim(900, 300, 1100, 240_000, { retainMs: 600_000 }) },
  },
  // WebLLM, never tried on a phone: experimental (opt-in) with small limits. The context window WebLLM reserves is
  // 1024 tokens on phones (ai-lib.js), above maxTotal, so a run cannot outgrow it.
  llama32: {
    ios: { status: 'experimental', backends: ['webgpu'], ...lim(400, 128, 500, 150_000, { retainMs: 60_000 }) },
    mobile: { status: 'experimental', backends: ['webgpu'], ...lim(400, 128, 500, 150_000, { retainMs: 60_000 }) },
    desktop: { status: 'experimental', backends: ['webgpu'], ...lim(900, 300, 1100, 240_000, { retainMs: 600_000 }) },
  },
  lfm26: {
    ios: { status: 'unsupported', why: 'iOS ended the app while this model was loading on a test iPhone' },
    mobile: { status: 'unsupported', why: 'too large for a phone' },
    desktop: { status: 'experimental', backends: ['webgpu'], ...lim(600, 200, 700, 240_000, { retainMs: 300_000 }) },
  },
  // BGE embeds passages in batches; the limits are on batch size, characters per passage and
  // passages embedded per question.
  bge: {
    ios: { status: 'provisional', backends: ['wasm'], maxBatch: 4, maxChars: 1200, maxPerRun: 64, maxMs: 120_000 },
    mobile: { status: 'provisional', backends: ['wasm'], maxBatch: 4, maxChars: 1200, maxPerRun: 64, maxMs: 120_000 },
    desktop: { status: 'provisional', backends: ['wasm'], maxBatch: 8, maxChars: 2000, maxPerRun: 160, maxMs: 180_000 },
  },
};

/** Never lower than this: a prompt of the instructions alone is about 60 tokens. */
export const MIN_USEFUL_NEW_TOKENS = 24;

/** The profile for a model on a device class, or an unsupported stub. */
export function profileFor(pkg, cls) {
  const p = SAFETY[pkg]?.[cls] ?? SAFETY[pkg]?.desktop;
  return p ?? { status: 'unsupported', why: 'no safety profile for this model' };
}

/** Ordinary settings may lower the prompt limit but never raise it above the profile's. */
export function effectiveLimits(profile, { promptLimit = null, dev = false } = {}) {
  const out = { maxInput: profile.maxInput, maxNew: profile.maxNew, maxTotal: profile.maxTotal, maxMs: profile.maxMs };
  if (promptLimit) {
    const cap = dev ? 2000 : profile.maxInput;
    out.maxInput = Math.max(100, Math.min(promptLimit, cap));
    // a raised input limit raises the total with it, in developer mode only
    if (dev) out.maxTotal = Math.max(out.maxTotal, out.maxInput + out.maxNew);
  }
  return out;
}

/** The prompt limits a person may choose between (lower is always allowed). */
export function promptLimitChoices(profile, dev = false) {
  const base = [150, 200, 220, 250, 300, 450, 600, 900, 2000];
  const cap = dev ? 2000 : profile.maxInput;
  const set = new Set(base.filter((n) => n <= cap));
  set.add(cap);
  return [...set].sort((a, b) => a - b);
}

/**
 * Exact budget check, before any inference. `inputTokens` comes from the model's tokenizer and
 * must be a positive integer: anything else fails closed. Returns { ok, maxNew } or
 * { ok: false, code, message }.
 */
export function checkBudget({ inputTokens, maxNew, limits }) {
  if (!Number.isInteger(inputTokens) || inputTokens <= 0)
    return { ok: false, code: 'TOKENIZATION_FAILED', message: 'The prompt could not be measured, so it was not run' };
  if (!limits?.maxInput || !limits?.maxTotal) return { ok: false, code: 'TOKEN_BUDGET_EXCEEDED', message: 'No token limits are set for this model, so nothing was run' };
  if (inputTokens > limits.maxInput)
    return { ok: false, code: 'TOKEN_BUDGET_EXCEEDED', message: `The prompt is ${inputTokens} tokens, over the ${limits.maxInput}-token limit, so it was not run` };
  const want = Math.max(1, Math.min(Math.floor(maxNew || limits.maxNew), limits.maxNew));
  const room = limits.maxTotal - inputTokens;
  if (room < MIN_USEFUL_NEW_TOKENS)
    return { ok: false, code: 'TOKEN_BUDGET_EXCEEDED', message: `The prompt (${inputTokens} tokens) leaves no room for an answer within the ${limits.maxTotal}-token total limit` };
  const fitted = Math.min(want, room);
  return { ok: true, maxNew: fitted, clamped: fitted < (maxNew || limits.maxNew), inputTokens, total: inputTokens + fitted };
}

// ---------- configurations ----------

/** The identity of what actually runs: package, pinned revision, backend and weights. */
export const configKey = (pkg, device, dtype) => `${pkg}@${(PACKAGES[pkg]?.revision ?? '').slice(0, 8)}|${device}|${dtype}`;

/**
 * Whether a configuration may run now, and why not. `state` carries what the app knows:
 *   { cls, dev, optIn: Set of pkg ids opted in, quarantine: Map(configKey -> record), hidden, gpuLost }
 */
export function mayRun(pkg, device, dtype, state) {
  const spec = PACKAGES[pkg];
  if (!spec) return { ok: false, code: 'MODEL_INCOMPATIBLE', why: `Unknown model ${pkg}` };
  const p = profileFor(pkg, state.cls);
  if (p.status === 'unsupported') return { ok: false, code: 'MODEL_INCOMPATIBLE', why: p.why ?? `${spec.short} is not supported on this device`, profile: p };
  if (!p.backends.includes(device))
    return { ok: false, code: device === 'webgpu' ? 'GPU_UNAVAILABLE' : 'MODEL_INCOMPATIBLE', why: `${spec.short} is not qualified to run on ${device === 'webgpu' ? 'WebGPU' : 'the CPU'} on this device`, profile: p };
  const q = state.quarantine?.get(configKey(pkg, device, dtype));
  if (q) return { ok: false, code: 'MODEL_QUARANTINED', why: `${spec.short} was switched off after it was interrupted unexpectedly (${q.category ?? 'unexplained'})`, profile: p, quarantine: q };
  if (p.status === 'experimental' && !state.optIn?.has(pkg)) return { ok: false, code: 'MODEL_NOT_ENABLED', why: `${spec.short} is experimental on this device. Turn it on in AI settings to use it`, profile: p };
  if (state.gpuLost && device === 'webgpu') return { ok: false, code: 'GPU_DEVICE_LOST', why: 'The GPU was lost earlier in this session. Reset the AI engine to try again', profile: p };
  return { ok: true, profile: p };
}

/** True for an automatic choice: no opt-in needed, not quarantined. */
export const autoSelectable = (pkg, device, dtype, state) => {
  const r = mayRun(pkg, device, dtype, state);
  return r.ok && r.profile.status === 'provisional';
};

// ---------- estimates (never presented as measurements) ----------

/**
 * Sizes that follow from the exported graphs, in bytes. These are ESTIMATES from tensor shapes read
 * out of the ONNX files: Safari does not report process or GPU memory to pages.
 *   logits: the `logits` output is [batch, positions, vocab]. Exports with a `num_logits_to_keep`
 *   input compute only the positions asked for (1 while generating). The others compute one set of
 *   scores for every prompt token, and some also hold a 16-bit copy that is cast to 32-bit.
 */
export function estimateAllocations(pkg, inputTokens) {
  const g = PACKAGES[pkg]?.graph;
  if (!g) return null;
  const positions = g.lastTokenLogits ? 1 : inputTokens;
  const logits = positions * g.vocab * g.logitsBytes;
  const castCopy = g.logitsCast ? positions * g.vocab * 2 : 0;
  const kv = inputTokens * g.kvBytesPerToken;
  return { logits, castCopy, kv, total: logits + castCopy + kv, positions, estimate: true };
}

// ---------- checkpoints and the next-launch diagnosis ----------

/** Stages recorded in a checkpoint, in the order they happen. Only stages that can be observed. */
export const STAGES = [
  'queued',
  'load.start', // asking the engine to load the weights
  'load.initialising', // the weights are read and the session is created (one engine call: not subdivided)
  'load.ready',
  'tokenize', // counting the prompt with the model's tokenizer
  'prefill', // the engine call has begun: prompt processing runs until the first token (inferred)
  'first_token',
  'decode',
  'generate.done',
  'embed.batch', // BGE: a batch is being embedded
  'embed.done',
  'dispose.start',
  'dispose.done',
  'cleanup.done',
];

/** A checkpoint is written before each risky stage and overwritten as work proceeds. */
export function newCheckpoint({ sid, op, type, pkg, dtype, device, mode, inputTokens = null, maxNew = null, vis = 'visible', runtime = '' }, now = Date.now()) {
  return {
    v: POLICY_VERSION,
    sid,
    op,
    type,
    pkg,
    rev: PACKAGES[pkg]?.revision ?? null,
    dtype,
    device,
    mode,
    inputTokens,
    maxNew,
    stage: 'queued',
    started: now,
    progress: now,
    tokens: 0,
    vis,
    visAt: now,
    hiddenMs: 0,
    gpuLost: false,
    runtime,
  };
}

export function advance(cp, stage, extra = {}, now = Date.now()) {
  return { ...cp, ...extra, stage, progress: now };
}

/** Records a visibility change on a checkpoint (the page was hidden or shown). */
export function withVisibility(cp, state, now = Date.now()) {
  if (!cp) return cp;
  const hiddenMs = cp.vis === 'hidden' ? (cp.hiddenMs ?? 0) + (now - (cp.visAt ?? now)) : (cp.hiddenMs ?? 0);
  return { ...cp, vis: state, visAt: now, hiddenMs };
}

const RISKY = new Set(['load.start', 'load.initialising', 'tokenize', 'prefill', 'first_token', 'decode', 'embed.batch', 'dispose.start']);

/**
 * What a checkpoint left by a previous launch most likely means. Returns
 * { category, confidence, quarantine, reasons[], message }.
 * A leftover checkpoint is evidence of interrupted work, not proof of an out-of-memory crash:
 *   - hidden when last seen → the app was backgrounded; iOS may suspend or end it then, normally
 *   - the engine reported a lost GPU device → GPU_DEVICE_LOST
 *   - foreground, in a memory-heavy stage, no error → UNEXPECTED_INTERRUPTION; it becomes
 *     POSSIBLE_MEMORY_EXHAUSTION only when the same configuration was interrupted that way before
 * `history` is { interrupted: n } for that configuration (earlier unexplained interruptions).
 */
export function classifyInterruption(cp, { history = {}, now = Date.now() } = {}) {
  if (!cp) return null;
  const reasons = [];
  const where = `${PACKAGES[cp.pkg]?.short ?? cp.pkg}${cp.type ? ` (${cp.type})` : ''}, last stage "${cp.stage}"`;
  const quietMs = Math.max(0, (cp.progress ?? cp.started) - cp.started);
  reasons.push(`started ${Math.round(quietMs / 1000)} s before the last recorded progress; page was ${cp.vis} at that point`);
  if (cp.gpuLost)
    return {
      category: 'GPU_DEVICE_LOST',
      confidence: 'medium',
      quarantine: false,
      reasons: [...reasons, 'the engine reported that the GPU device was lost before the app ended'],
      message: `The GPU stopped responding while working with ${where}. The GPU can be reset by the system; try again.`,
    };
  if (cp.legacy)
    return {
      category: 'UNEXPECTED_INTERRUPTION',
      confidence: 'low',
      quarantine: false,
      reasons: ['marker from an older version of the app, with no stage or foreground information'],
      message: `Previous work was interrupted (${where}). iOS did not provide a termination reason.`,
    };
  if (!RISKY.has(cp.stage))
    return {
      category: 'UNEXPECTED_INTERRUPTION',
      confidence: 'low',
      quarantine: false,
      reasons: [...reasons, `the last stage ("${cp.stage}") does not use much memory`],
      message: `The app was closed during ${where}. iOS did not provide a termination reason.`,
    };
  if (cp.closing)
    return {
      category: 'APP_CLOSED',
      confidence: 'medium',
      quarantine: false,
      reasons: [...reasons, 'the page reported that it was being closed while the work ran'],
      message: `The app was closed during ${where}. That is not counted against the model.`,
    };
  if (cp.vis === 'hidden' || (cp.hiddenMs ?? 0) > 0) {
    return {
      category: 'BACKGROUNDED',
      confidence: 'medium',
      quarantine: false,
      reasons: [...reasons, 'the app had been sent to the background (or the screen locked) during the work; iOS routinely suspends or ends apps then'],
      message: `The app was in the background during ${where}, and was ended there. That is normal for iOS and is not counted against the model.`,
    };
  }
  const before = history.interrupted ?? 0;
  const repeated = before >= 1;
  return {
    category: repeated ? 'POSSIBLE_MEMORY_EXHAUSTION' : 'UNEXPECTED_INTERRUPTION',
    confidence: repeated ? 'medium' : 'low',
    quarantine: true,
    reasons: [
      ...reasons,
      'the app was in the foreground and nothing was reported',
      repeated ? `the same configuration was interrupted unexpectedly ${before} time(s) before` : 'first time this configuration was interrupted',
    ],
    message: `Previous inference was interrupted unexpectedly (${where}). iOS did not provide a termination reason.${repeated ? ' This has now happened more than once with this setup, which fits running out of memory.' : ''}`,
  };
}

/** The history record kept for each configuration. */
export const emptyHistory = () => ({ ok: 0, failed: 0, interrupted: 0, last: null });

export function noteOutcome(h, outcome, detail = {}, now = Date.now()) {
  const n = { ...emptyHistory(), ...h };
  if (outcome === 'ok') n.ok++;
  else if (outcome === 'interrupted') n.interrupted++;
  else n.failed++;
  n.last = { outcome, at: now, ...detail };
  return n;
}

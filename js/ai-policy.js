// Limits and diagnosis for the on-device AI. Pure (no DOM, no storage): tested in test/.
//
// iOS can end a page that uses too much memory without any error the page can catch, so:
//   - every model has token budgets, checked with the model's own tokenizer before anything runs
//   - a checkpoint is written before each risky stage; if the app is ended in the middle of one, the next
//     launch CLASSIFIES it (backgrounded, closed, unexplained) and says so. Nothing is switched off because of it.
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

// ---------- limits ----------

/**
 * Token budgets, counted with the model's own tokenizer (system prompt and chat template included).
 * Each model starts with a prompt limit and an answer limit; the person can change both on the AI page (`clampLimits`),
 * and the combined limit is simply their sum. `ceiling` is the most the two may add up to: the model's context
 * window, or what is sensible to ask of a phone. These are the numbers to lower if a model runs out of memory
 * (an iPhone ended the app on a 1.2B model at about 650 tokens in total).
 */
const lim = (maxInput, maxNew, maxMs, ceiling) => ({ status: 'ok', backends: ['webgpu'], maxInput, maxNew, maxMs, ceiling });

export const SAFETY = {
  lfm350: lim(600, 200, 120_000, 4096),
  lfm230: lim(500, 200, 120_000, 4096),
  llama32: lim(450, 200, 180_000, 2048), // 2,048 is the conversation window WebLLM reserves for it (ai-lib.js)
  // BGE embeds passages in batches; the limits are on batch size, characters per passage and passages per question.
  bge: { status: 'ok', backends: ['wasm'], maxBatch: 4, maxChars: 1200, maxPerRun: 64, maxMs: 120_000 },
};

/** Never lower than this: a prompt of the instructions alone is about 60 tokens. */
export const MIN_USEFUL_NEW_TOKENS = 24;
export const MIN_INPUT_TOKENS = 100;

/** The starting limits for a model, or an unsupported stub for one that is not in the catalog. (`cls` is ignored: no device classes.) */
export function profileFor(pkg) {
  const p = SAFETY[pkg];
  return p ? { ...p, maxTotal: p.maxInput && p.maxNew ? p.maxInput + p.maxNew : undefined } : { status: 'unsupported', why: 'unknown model' };
}

/**
 * The limits to use for a model: what was asked for (the person's settings), made sensible. The prompt is at least
 * 100 tokens, the answer at least 24, and together they never pass the model's ceiling. Anything missing or not a
 * number falls back to the starting value. `maxTotal` is prompt + answer; time allowed grows with either, up to 5 minutes.
 */
export function clampLimits(pkg, asked = {}) {
  const p = SAFETY[pkg];
  if (!p?.maxInput) return null;
  const whole = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : fallback);
  const maxInput = Math.min(Math.max(whole(asked?.maxInput, p.maxInput), MIN_INPUT_TOKENS), p.ceiling - MIN_USEFUL_NEW_TOKENS);
  const maxNew = Math.min(Math.max(whole(asked?.maxNew, p.maxNew), MIN_USEFUL_NEW_TOKENS), p.ceiling - maxInput);
  const maxMs = Math.min(300_000, Math.round(p.maxMs * Math.max(1, maxNew / p.maxNew, maxInput / p.maxInput)));
  return { maxInput, maxNew, maxTotal: maxInput + maxNew, maxMs };
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

/** Whether a downloaded model can run now, and why not. `state` is { gpuLost }. */
export function mayRun(pkg, device, dtype, state = {}) {
  const spec = PACKAGES[pkg];
  if (!spec) return { ok: false, code: 'MODEL_INCOMPATIBLE', why: `Unknown model ${pkg}` };
  const p = profileFor(pkg);
  if (!p.backends.includes(device))
    return { ok: false, code: device === 'webgpu' ? 'GPU_UNAVAILABLE' : 'MODEL_INCOMPATIBLE', why: `${spec.short} needs ${p.backends.includes('wasm') ? 'the CPU' : 'WebGPU'}, not ${device === 'webgpu' ? 'WebGPU' : 'the CPU'}`, profile: p };
  if (state.gpuLost && device === 'webgpu') return { ok: false, code: 'GPU_DEVICE_LOST', why: 'The GPU was lost earlier in this session. Reset the AI engine to try again', profile: p };
  return { ok: true, profile: p };
}

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
 * { category, confidence, reasons[], message }.
 * A leftover checkpoint is evidence of interrupted work, not proof of an out-of-memory crash:
 *   - hidden when last seen → the app was backgrounded; iOS may suspend or end it then, normally
 *   - the engine reported a lost GPU device → GPU_DEVICE_LOST
 *   - foreground, in a memory-heavy stage, no error → UNEXPECTED_INTERRUPTION; it becomes
 *     it is only ever an UNEXPECTED_INTERRUPTION: iOS gives no reason, so memory is a suspicion, not a finding
 */
export function classifyInterruption(cp) {
  if (!cp) return null;
  const reasons = [];
  const where = `${PACKAGES[cp.pkg]?.short ?? cp.pkg}${cp.type ? ` (${cp.type})` : ''}, last stage "${cp.stage}"`;
  const quietMs = Math.max(0, (cp.progress ?? cp.started) - cp.started);
  reasons.push(`started ${Math.round(quietMs / 1000)} s before the last recorded progress; page was ${cp.vis} at that point`);
  if (cp.gpuLost)
    return {
      category: 'GPU_DEVICE_LOST',
      confidence: 'medium',
      reasons: [...reasons, 'the engine reported that the GPU device was lost before the app ended'],
      message: `The GPU stopped responding while working with ${where}. The GPU can be reset by the system; try again.`,
    };
  if (cp.legacy)
    return {
      category: 'UNEXPECTED_INTERRUPTION',
      confidence: 'low',
      reasons: ['marker from an older version of the app, with no stage or foreground information'],
      message: `Previous work was interrupted (${where}). iOS did not provide a termination reason.`,
    };
  if (!RISKY.has(cp.stage))
    return {
      category: 'UNEXPECTED_INTERRUPTION',
      confidence: 'low',
      reasons: [...reasons, `the last stage ("${cp.stage}") does not use much memory`],
      message: `The app was closed during ${where}. iOS did not provide a termination reason.`,
    };
  if (cp.closing)
    return {
      category: 'APP_CLOSED',
      confidence: 'medium',
      reasons: [...reasons, 'the page reported that it was being closed while the work ran'],
      message: `The app was closed during ${where}. That is not counted against the model.`,
    };
  if (cp.vis === 'hidden' || (cp.hiddenMs ?? 0) > 0) {
    return {
      category: 'BACKGROUNDED',
      confidence: 'medium',
      reasons: [...reasons, 'the app had been sent to the background (or the screen locked) during the work; iOS routinely suspends or ends apps then'],
      message: `The app was in the background during ${where}, and was ended there. That is normal for iOS and is not counted against the model.`,
    };
  }
  return {
    category: 'UNEXPECTED_INTERRUPTION',
    confidence: 'low',
    reasons: [...reasons, 'the app was in the foreground and nothing was reported'],
    message: `The app was ended while working with ${where}. iOS did not say why; running out of memory is one possible cause.`,
  };
}

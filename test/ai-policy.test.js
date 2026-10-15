import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as PO from '../js/ai-policy.js';

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 0 };
const state = (o = {}) => ({ cls: 'ios', dev: false, optIn: new Set(), quarantine: new Map(), gpuLost: false, ...o });

test('device classes: iPhone, iPadOS posing as a Mac, other phones, desktops', () => {
  assert.equal(PO.deviceClass(IPHONE), 'ios');
  assert.equal(PO.deviceClass(IPAD_AS_MAC), 'ios');
  assert.equal(PO.deviceClass(MAC), 'desktop');
  assert.equal(PO.deviceClass({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile Safari' }), 'mobile');
  assert.equal(PO.deviceClass({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130' }), 'desktop');
  assert.equal(PO.deviceClass(MAC, 'ios'), 'ios', 'a stricter class can be forced');
  assert.equal(PO.deviceClass(IPHONE, 'desktop'), 'ios', 'a looser one cannot');
  assert.equal(PO.deviceClass(MAC, 'nonsense'), 'desktop');
  assert.ok(PO.isLowMemory('ios') && PO.isLowMemory('mobile') && !PO.isLowMemory('desktop'));
});

test('every chat model has conservative, ordered budgets on phones', () => {
  for (const id of ['lfm350', 'lfm230', 'lfm12']) {
    const p = PO.profileFor(id, 'ios');
    assert.ok(p.maxInput > 0 && p.maxNew > 0 && p.maxTotal >= p.maxInput + PO.MIN_USEFUL_NEW_TOKENS, id);
    assert.ok(p.maxTotal <= p.maxInput + p.maxNew, `${id}: total never above input + new`);
    assert.ok(p.maxInput < 338 + 1, `${id}: not above the 338-token prompt seen to work on the 1.2B`);
  }
  assert.equal(PO.profileFor('lfm350', 'ios').status, 'provisional');
  assert.equal(PO.profileFor('lfm12', 'ios').status, 'experimental');
  assert.equal(PO.profileFor('lfm26', 'ios').status, 'unsupported');
  assert.equal(PO.profileFor('nope', 'ios').status, 'unsupported');
  assert.ok(PO.profileFor('lfm350', 'ios').maxTotal < 350, 'lightweight profile stays under a 350-token combined limit');
});

test('ordinary settings can lower the prompt limit but never raise it', () => {
  const p = PO.profileFor('lfm350', 'ios');
  assert.equal(PO.effectiveLimits(p, { promptLimit: 150 }).maxInput, 150);
  assert.equal(PO.effectiveLimits(p, { promptLimit: 2000 }).maxInput, p.maxInput);
  assert.equal(PO.effectiveLimits(p, { promptLimit: 2000, dev: false }).maxTotal, p.maxTotal);
  const dev = PO.effectiveLimits(p, { promptLimit: 900, dev: true });
  assert.equal(dev.maxInput, 900);
  assert.ok(dev.maxTotal >= 900 + p.maxNew);
  assert.ok(Math.max(...PO.promptLimitChoices(p)) === p.maxInput);
  assert.ok(Math.max(...PO.promptLimitChoices(p, true)) === 2000);
});

test('checkBudget fails closed and enforces input + new <= total', () => {
  const limits = { maxInput: 220, maxNew: 80, maxTotal: 300 };
  for (const bad of [null, undefined, 0, -3, 12.5, NaN, '200'])
    assert.equal(PO.checkBudget({ inputTokens: bad, maxNew: 50, limits }).code, 'TOKENIZATION_FAILED', String(bad));
  assert.equal(PO.checkBudget({ inputTokens: 221, maxNew: 50, limits }).code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(PO.checkBudget({ inputTokens: 220, maxNew: 80, limits: {} }).code, 'TOKEN_BUDGET_EXCEEDED');
  const ok = PO.checkBudget({ inputTokens: 200, maxNew: 400, limits });
  assert.equal(ok.ok, true);
  assert.equal(ok.maxNew, 80, 'asking for more than the profile allows is cut to the profile');
  assert.ok(ok.total <= limits.maxTotal);
  assert.equal(PO.checkBudget({ inputTokens: 210, maxNew: 80, limits }).maxNew, 80); // 210 + 80 = 290 <= 300
  const clamp = PO.checkBudget({ inputTokens: 215, maxNew: 80, limits: { ...limits, maxTotal: 250 } });
  assert.equal(clamp.maxNew, 35);
  assert.equal(clamp.clamped, true);
  assert.equal(PO.checkBudget({ inputTokens: 215, maxNew: 80, limits: { ...limits, maxTotal: 230 } }).code, 'TOKEN_BUDGET_EXCEEDED', 'no room for a useful answer');
  for (let input = 1; input <= 220; input += 7) {
    const r = PO.checkBudget({ inputTokens: input, maxNew: 1000, limits });
    if (r.ok) assert.ok(input + r.maxNew <= limits.maxTotal);
  }
});

test('mayRun: profile, backend, opt-in, quarantine and GPU loss', () => {
  assert.equal(PO.mayRun('lfm350', 'webgpu', 'q4f16', state()).ok, true);
  assert.equal(PO.autoSelectable('lfm350', 'webgpu', 'q4f16', state()), true);
  // experimental: only after opting in, and never picked automatically
  assert.equal(PO.mayRun('lfm12', 'webgpu', 'q4f16', state()).code, 'MODEL_NOT_ENABLED');
  assert.equal(PO.mayRun('lfm12', 'webgpu', 'q4f16', state({ optIn: new Set(['lfm12']) })).ok, true);
  assert.equal(PO.autoSelectable('lfm12', 'webgpu', 'q4f16', state({ optIn: new Set(['lfm12']) })), false);
  // unsupported on the device class, and a backend that is not qualified
  assert.equal(PO.mayRun('lfm26', 'webgpu', 'q4f16', state()).code, 'MODEL_INCOMPATIBLE');
  assert.equal(PO.mayRun('lfm26', 'webgpu', 'q4f16', state({ cls: 'desktop', optIn: new Set(['lfm26']) })).ok, true);
  assert.equal(PO.mayRun('lfm350', 'wasm', 'q8', state()).code, 'MODEL_INCOMPATIBLE', 'no silent CPU fallback on a phone');
  assert.equal(PO.mayRun('lfm350', 'wasm', 'q8', state({ cls: 'desktop' })).code, 'MODEL_INCOMPATIBLE', 'its CPU export does not load');
  assert.equal(PO.mayRun('lfm12', 'wasm', 'q8', state({ optIn: new Set(['lfm12']) })).code, 'MODEL_INCOMPATIBLE');
  // quarantine is per configuration (model revision, backend, weights)
  const q = new Map([[PO.configKey('lfm350', 'webgpu', 'q4f16'), { category: 'UNEXPECTED_INTERRUPTION' }]]);
  assert.equal(PO.mayRun('lfm350', 'webgpu', 'q4f16', state({ quarantine: q })).code, 'MODEL_QUARANTINED');
  assert.equal(PO.autoSelectable('lfm350', 'webgpu', 'q4f16', state({ quarantine: q })), false);
  assert.equal(PO.mayRun('lfm350', 'webgpu', 'q4', state({ quarantine: q })).ok, true, 'another weights file is a different configuration');
  assert.equal(PO.mayRun('lfm350', 'webgpu', 'q4f16', state({ gpuLost: true })).code, 'GPU_DEVICE_LOST');
  assert.equal(PO.mayRun('bge', 'wasm', 'q8', state()).ok, true);
  assert.match(PO.configKey('lfm350', 'webgpu', 'q4f16'), /^lfm350@d11593fd\|webgpu\|q4f16$/);
});

test('allocation estimates follow the exported graphs', () => {
  const old = PO.estimateAllocations('lfm12', 338);
  assert.equal(old.positions, 338, '1.2B scores every prompt position');
  assert.equal(old.logits, 338 * 65536 * 4);
  assert.ok(old.castCopy > 0 && old.estimate === true);
  const big = PO.estimateAllocations('lfm12', 3000);
  assert.ok(big.total > 1.1e9, 'a 3,000-token prompt needs over 1 GB for scores alone');
  const small = PO.estimateAllocations('lfm350', 3000);
  assert.equal(small.positions, 1, '350M scores the last position only');
  assert.ok(small.total < 100e6 && small.total * 10 < big.total, 'a long prompt costs the 1.2B over 10 times what it costs the 350M');
  assert.equal(PO.estimateAllocations('bge', 100), null);
});

const cp = (o = {}) => ({ v: 2, sid: 's1', op: 'op3', type: 'generate', pkg: 'lfm350', dtype: 'q4f16', device: 'webgpu', stage: 'prefill', started: 1000, progress: 4000, tokens: 0, vis: 'visible', hiddenMs: 0, ...o });

test('interruptions are classified, not assumed to be out-of-memory crashes', () => {
  const fg = PO.classifyInterruption(cp());
  assert.equal(fg.category, 'UNEXPECTED_INTERRUPTION');
  assert.equal(fg.confidence, 'low');
  assert.equal(fg.quarantine, true);
  assert.match(fg.message, /interrupted unexpectedly/);
  assert.match(fg.message, /did not provide a termination reason/);
  assert.ok(!/out of memory/i.test(fg.message));
  // repeated in the foreground: now the memory explanation fits
  const again = PO.classifyInterruption(cp(), { history: { interrupted: 1 } });
  assert.equal(again.category, 'POSSIBLE_MEMORY_EXHAUSTION');
  assert.equal(again.quarantine, true);
  // backgrounding is normal and is not held against the model
  for (const o of [{ vis: 'hidden' }, { hiddenMs: 3000 }]) {
    const bg = PO.classifyInterruption(cp(o));
    assert.equal(bg.category, 'BACKGROUNDED');
    assert.equal(bg.quarantine, false);
  }
  assert.equal(PO.classifyInterruption(cp({ closing: true })).quarantine, false);
  assert.equal(PO.classifyInterruption(cp({ closing: true })).category, 'APP_CLOSED');
  // a lost GPU is reported as such
  const lost = PO.classifyInterruption(cp({ gpuLost: true }));
  assert.equal(lost.category, 'GPU_DEVICE_LOST');
  assert.equal(lost.quarantine, false);
  // stages that use little memory, and older markers, never quarantine
  assert.equal(PO.classifyInterruption(cp({ stage: 'cleanup.done' })).quarantine, false);
  assert.equal(PO.classifyInterruption(cp({ stage: 'load.ready' })).quarantine, false);
  const legacy = PO.classifyInterruption({ legacy: true, pkg: 'lfm12', type: 'generate', stage: 'unknown', started: 1, progress: 1 });
  assert.equal(legacy.quarantine, false);
  assert.equal(PO.classifyInterruption(null), null);
});

test('checkpoints advance, record visibility and history', () => {
  let c = PO.newCheckpoint({ sid: 's', op: 'o', type: 'generate', pkg: 'lfm350', dtype: 'q4f16', device: 'webgpu', mode: 'worker' }, 100);
  assert.equal(c.v, PO.POLICY_VERSION);
  assert.equal(c.rev.length, 40, 'the pinned revision is recorded');
  assert.equal(c.stage, 'queued');
  c = PO.advance(c, 'prefill', { inputTokens: 180, maxNew: 60 }, 250);
  assert.deepEqual([c.stage, c.inputTokens, c.progress, c.started], ['prefill', 180, 250, 100]);
  c = PO.withVisibility(c, 'hidden', 300);
  c = PO.withVisibility(c, 'visible', 900);
  assert.equal(c.hiddenMs, 600, 'time spent hidden is accumulated');
  for (const s of PO.STAGES) assert.equal(typeof s, 'string');
  let h = PO.noteOutcome(undefined, 'ok', {}, 1);
  h = PO.noteOutcome(h, 'interrupted', { stage: 'prefill' }, 2);
  h = PO.noteOutcome(h, 'failed', {}, 3);
  assert.deepEqual([h.ok, h.interrupted, h.failed, h.last.outcome], [1, 1, 1, 'failed']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as PO from '../js/ai-policy.js';

const IPHONE = { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', maxTouchPoints: 5 };
const IPAD_AS_MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 5 };
const MAC = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15', maxTouchPoints: 0 };


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

test('every chat model has ordered token budgets, the same on every device', () => {
  for (const id of ['lfm350', 'lfm230', 'llama32']) {
    const p = PO.profileFor(id);
    assert.equal(p.status, 'ok', id);
    assert.ok(p.maxInput > 0 && p.maxNew > 0 && p.maxTotal >= p.maxInput + PO.MIN_USEFUL_NEW_TOKENS, id);
    assert.ok(p.maxTotal <= p.maxInput + p.maxNew, `${id}: total never above input + new`);
    assert.deepEqual(PO.profileFor(id, 'ios'), PO.profileFor(id, 'desktop'), 'no device classes');
  }
  assert.equal(PO.profileFor('nope').status, 'unsupported');
  for (const gone of ['lfm12', 'lfm26']) assert.equal(PO.profileFor(gone).status, 'unsupported', `${gone} is no longer offered`);
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

test('mayRun: only the backend and a lost GPU stop a model', () => {
  assert.equal(PO.mayRun('lfm350', 'webgpu', 'q4f16').ok, true);
  assert.equal(PO.mayRun('llama32', 'webgpu', 'q4f16_1', {}).ok, true, 'no opt-in, no developer switch');
  assert.equal(PO.mayRun('lfm350', 'wasm', 'q8').code, 'MODEL_INCOMPATIBLE', 'its CPU export does not load');
  assert.equal(PO.mayRun('lfm350', 'webgpu', 'q4f16', { gpuLost: true }).code, 'GPU_DEVICE_LOST');
  assert.equal(PO.mayRun('bge', 'wasm', 'q8').ok, true);
  assert.equal(PO.mayRun('lfm12', 'webgpu', 'q4f16').code, 'MODEL_INCOMPATIBLE', 'a model that is no longer offered');
  assert.match(PO.configKey('lfm350', 'webgpu', 'q4f16'), /^lfm350@d11593fd\|webgpu\|q4f16$/);
});

test('allocation estimates follow the exported graphs', () => {
  const small = PO.estimateAllocations('lfm350', 3000);
  assert.equal(small.positions, 1, '350M scores the last position only');
  assert.ok(small.total < 100e6);
  const full = PO.estimateAllocations('lfm230', 500);
  assert.equal(full.positions, 500, '230M scores every prompt position');
  assert.equal(full.logits, 500 * 65536 * 4);
  assert.ok(full.estimate === true);
  assert.equal(PO.estimateAllocations('bge', 100), null);
});

const cp = (o = {}) => ({ v: 2, sid: 's1', op: 'op3', type: 'generate', pkg: 'lfm350', dtype: 'q4f16', device: 'webgpu', stage: 'prefill', started: 1000, progress: 4000, tokens: 0, vis: 'visible', hiddenMs: 0, ...o });

test('interruptions are classified, not assumed to be out-of-memory crashes', () => {
  const fg = PO.classifyInterruption(cp());
  assert.equal(fg.category, 'UNEXPECTED_INTERRUPTION');
  assert.equal(fg.confidence, 'low');
  assert.match(fg.message, /iOS did not say why/);
  assert.equal(fg.quarantine, undefined, 'nothing is switched off because of it');
  // repeating it never turns the guess into a finding
  assert.equal(PO.classifyInterruption(cp(), { history: { interrupted: 5 } }).category, 'UNEXPECTED_INTERRUPTION');
  // backgrounding is normal and is not held against the model
  for (const o of [{ vis: 'hidden' }, { hiddenMs: 3000 }]) assert.equal(PO.classifyInterruption(cp(o)).category, 'BACKGROUNDED');
  assert.equal(PO.classifyInterruption(cp({ closing: true })).category, 'APP_CLOSED');
  // a lost GPU is reported as such
  assert.equal(PO.classifyInterruption(cp({ gpuLost: true })).category, 'GPU_DEVICE_LOST');
  // stages that use little memory, and older markers, are low-confidence too
  assert.equal(PO.classifyInterruption(cp({ stage: 'cleanup.done' })).confidence, 'low');
  assert.equal(PO.classifyInterruption({ legacy: true, pkg: 'lfm350', type: 'generate', stage: 'unknown', started: 1, progress: 1 }).category, 'UNEXPECTED_INTERRUPTION');
  assert.equal(PO.classifyInterruption(null), null);
});

test('checkpoints advance and record visibility', () => {
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
});

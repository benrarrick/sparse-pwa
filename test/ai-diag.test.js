import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as D from '../js/ai-diag.js';

test('every error code has a plain explanation', () => {
  for (const code of ['MODEL_NOT_INSTALLED', 'MODEL_LOAD_FAILED', 'MODEL_INCOMPATIBLE', 'GPU_UNAVAILABLE', 'GPU_DEVICE_LOST', 'TOKEN_BUDGET_EXCEEDED', 'TOKENIZATION_FAILED', 'INFERENCE_FAILED', 'INFERENCE_TIMEOUT', 'WORKER_FAILED', 'WORKER_UNRESPONSIVE', 'MODEL_DISPOSE_FAILED', 'STORAGE_ERROR', 'POSSIBLE_MEMORY_EXHAUSTION', 'UNEXPECTED_INTERRUPTION'])
    assert.ok(D.ERRORS[code]?.text.length > 10, code);
});

test('errors are classified only as far as the error itself says', () => {
  const c = (message, o) => D.classifyError(Object.assign(new Error(message), o?.props), o);
  assert.equal(c('Failed to execute: WebGPU device lost'), 'GPU_DEVICE_LOST');
  assert.equal(c('anything', { gpuLost: true }), 'GPU_DEVICE_LOST');
  assert.equal(c('RangeError: Array buffer allocation failed'), 'POSSIBLE_MEMORY_EXHAUSTION');
  assert.equal(c('std::bad_alloc'), 'POSSIBLE_MEMORY_EXHAUSTION');
  assert.equal(c('QuotaExceededError: The quota has been exceeded'), 'STORAGE_ERROR');
  assert.equal(c('Could not find an implementation for GatherBlockQuantized'), 'MODEL_INCOMPATIBLE');
  assert.equal(c('tokenizer exploded'), 'TOKENIZATION_FAILED');
  assert.equal(c('something odd', { stage: 'load.initialising' }), 'MODEL_LOAD_FAILED');
  assert.equal(c('something odd', { stage: 'prefill' }), 'INFERENCE_FAILED');
  assert.equal(c('something odd', { stage: '' }), 'UNKNOWN', 'no stage, no clue: it does not guess');
  assert.equal(D.classifyError(new D.AiError('TOKEN_BUDGET_EXCEEDED')), 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(D.classifyError({ name: 'Cancelled', message: 'x' }), 'CANCELLED');
  assert.ok(!/memory/.test(c('an ordinary failure', { stage: 'decode' })));
});

test('explain gives the plain text first and keeps the original wording', () => {
  assert.equal(D.explain(new D.AiError('GPU_DEVICE_LOST')), D.ERRORS.GPU_DEVICE_LOST.text);
  const e = new D.AiError('TOKEN_BUDGET_EXCEEDED', 'The prompt is 303 tokens, over the 300-token limit');
  assert.match(D.explain(e), /too long for the safe limit/);
  assert.match(D.explain(e), /303 tokens/);
  assert.equal(D.explain(new Error('boom')), `${D.ERRORS.UNKNOWN.text} (boom)`);
});

test('ids are unique', () => {
  const ids = new Set(Array.from({ length: 5000 }, () => D.newId('o')));
  assert.equal(ids.size, 5000);
});

test('scrub removes addresses, tokens and long ids from messages', () => {
  const s = D.scrub('failed fetching https://secret.example/private/page?token=abc123 with Bearer abcdefghijklmnop and api_key=hunter2xyz plus 0123456789abcdef0123456789abcdef0123');
  assert.ok(!s.includes('secret.example/private'));
  assert.ok(!s.includes('abc123') && !s.includes('hunter2xyz') && !s.includes('abcdefghijklmnop') && !s.includes('0123456789abcdef0123456789abcdef'));
  assert.match(D.scrub('GET https://huggingface.co/LiquidAI/x/resolve/abc/config.json'), /huggingface\.co/);
});

test('events carry the schema, drop private fields and truncate', () => {
  const out = [];
  const log = D.createLogger({ base: { sid: 's1', build: 'b' }, sink: (e) => out.push(e), now: () => 1000 });
  log.event('ai.inference.completed', {
    level: 'ok',
    msg: 'done',
    op: 'op1',
    parent: 'op0',
    pkg: 'lfm350',
    stage: 'generate.done',
    text: 'THE FULL PAGE TEXT',
    question: 'what is my secret',
    url: 'https://private.example/a',
    title: 'My private title',
    m: { tokens: 10, answer: 'secret answer', nested: { content: 'also secret', ok: 1 } },
  });
  const e = out[0];
  assert.deepEqual([e.v, e.t, e.sid, e.ev, e.level, e.op, e.parent, e.pkg, e.stage, e.area], [2, 1000, 's1', 'ai.inference.completed', 'ok', 'op1', 'op0', 'lfm350', 'generate.done', 'run']);
  const dumped = JSON.stringify(e);
  for (const secret of ['FULL PAGE TEXT', 'my secret', 'private.example', 'private title', 'secret answer', 'also secret']) assert.ok(!dumped.includes(secret), secret);
  assert.equal(e.m.tokens, 10);
  assert.equal(e.m.nested.ok, 1);
  log.event('ai.x.y', { msg: 'x'.repeat(2000), m: { long: 'y'.repeat(2000) } });
  assert.ok(out[1].msg.length <= 400 && out[1].m.long.length <= 301);
});

test('the log stays bounded and writing it never blocks or breaks anything', async () => {
  const written = [];
  let fail = false;
  const log = D.createLogger({ keep: 50, max: 80, flushMs: 5, write: async (b) => (fail ? Promise.reject(new Error('disk full')) : void written.push(...b)) });
  for (let i = 0; i < 500; i++) log.event('ai.model.note', { msg: `n${i}` });
  assert.equal(log.recent().length, 50, 'the in-memory ring is bounded');
  await log.flush();
  assert.ok(written.length <= 80, 'the write buffer is bounded');
  assert.equal(log.stats().dropped, 500 - written.length);
  fail = true;
  log.event('ai.model.note', { msg: 'again' });
  await log.flush();
  assert.equal(log.stats().writeFailures, 1, 'a failing store is counted, not thrown');
  assert.doesNotThrow(() => log.event('ai.model.note', { msg: 'still works' }));
  const broken = D.createLogger({ sink: () => { throw new Error('screen gone'); } });
  assert.doesNotThrow(() => broken.event('ai.x.y', {}));
});

test('performance summary and operation tracing', () => {
  const ev = (ev, f) => ({ ev, t: 1, level: 'info', ...f });
  const entries = [
    ev('ai.inference.completed', { status: 'ok', m: { ttft: 400, tps: 20, ms: 3000, completed: true } }),
    ev('ai.inference.completed', { status: 'ok', m: { ttft: 600, tps: 10, ms: 5000, completed: true } }),
    ev('ai.inference.completed', { status: 'ok', m: { ttft: 800, tps: 30, ms: 4000, completed: true } }),
    ev('ai.model.load.completed', { m: { ms: 2800 } }),
    ev('ai.retrieval.completed', { m: { totalMs: 900 } }),
    ev('ai.inference.failed', { level: 'error', code: 'GPU_DEVICE_LOST' }),
    ev('ai.inference.failed', { level: 'error', code: 'GPU_DEVICE_LOST' }),
  ];
  const p = D.performanceSummary(entries);
  assert.deepEqual([p.runs, p.medianTtftMs, p.medianTokensPerSec, p.medianRunMs, p.medianLoadMs, p.medianRetrievalMs, p.failures], [3, 600, 20, 4000, 2800, 900, 2]);
  assert.deepEqual(p.failuresByCode, { GPU_DEVICE_LOST: 2 });
  assert.equal(D.median([]), null);
  const trace = D.traceOperation(
    [
      { ev: 'ai.operation.started', op: 'a', t: 1 },
      { ev: 'ai.operation.stage', op: 'a', t: 2, stage: 'tokenize' },
      { ev: 'ai.operation.stage', op: 'b', parent: 'a', t: 3, stage: 'prefill' },
      { ev: 'ai.operation.failed', op: 'a', t: 4, stage: 'prefill', code: 'INFERENCE_FAILED' },
    ],
    'a',
  );
  assert.deepEqual([trace.lastStage, trace.failedStage, trace.failed, trace.code], ['prefill', 'prefill', true, 'INFERENCE_FAILED']);
});

test('the report is readable, complete and private by default', () => {
  const data = {
    now: Date.UTC(2026, 9, 15),
    build: '2026-10-15.1',
    runtimeVersions: 'Transformers.js 4.3.0',
    mode: 'worker',
    deviceClass: 'ios',
    device: { standalone: true, cores: 6, memory: null, gpu: { gpu: true, f16: true, adapter: 'apple' }, storage: { usage: 1, quota: 2 }, ua: 'iPhone' },
    memory: { jsHeap: null, jsHeapLimit: null, storageUsage: 123 },
    scheduler: { state: 'idle', active: null, queue: [] },
    worker: { state: 'responsive' },
    loaded: [],
    models: [{ id: 'lfm350', status: 'ready', dtype: 'q4f16', device: 'webgpu', revision: 'd11593fd9eb4', have: 258 }],
    limits: { lfm350: { maxInput: 600, maxNew: 200, maxTotal: 760, maxMs: 120000 } },
    interruption: { category: 'UNEXPECTED_INTERRUPTION', confidence: 'low', message: 'Previous inference was interrupted unexpectedly (x). iOS did not provide a termination reason.', reasons: ['r1'], checkpoint: { stage: 'prefill', pkg: 'lfm350', dtype: 'q4f16', device: 'webgpu', inputTokens: 180, maxNew: 60, started: 1, progress: 2, tokens: 0, vis: 'visible', hiddenMs: 0 } },
    lastInference: { status: 'ok', pkg: 'lfm350', dtype: 'q4f16', backend: 'webgpu', m: { inputTokens: 180, tokens: 50, requestedNew: 60, ttft: 400, tps: 20.1, ms: 3000, stopReason: 'eos' } },
    performance: { runs: 1, loads: 1, retrievals: 0, failures: 0, failuresByCode: {} },
    logger: { events: 3 },
    events: [{ t: 1, level: 'info', ev: 'ai.model.load.completed', op: 'op1', msg: 'Loaded', m: { ms: 1 } }],
    detail: null,
  };
  const { text, json } = D.buildReport(data);
  for (const heading of ['APP', 'DEVICE', 'MEMORY INDICATORS', 'CURRENT STATE', 'INSTALLED MODELS', 'TOKEN LIMITS', 'LAST INTERRUPTION AT LAUNCH', 'LAST INFERENCE', 'PERFORMANCE', 'RECENT EVENTS']) assert.ok(text.includes(heading), heading);
  assert.match(text, /iOS did not provide a termination reason/);
  assert.match(text, /JS heap: unavailable/, 'unavailable memory is said to be unavailable, not invented');
  assert.match(text, /lfm350: 600 \/ 200 \/ 760 \/ 120 s/);
  assert.ok(!text.includes('DETAIL'));
  assert.equal(json.eventsCount, 1);
  const detailed = D.buildReport({ ...data, detail: ['question: why is the sky blue'] }).text;
  assert.match(detailed, /DETAIL \(includes text you asked about/);
});

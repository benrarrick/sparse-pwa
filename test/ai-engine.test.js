import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, trimTail, withFields } from '../js/ai-engine.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for Transformers.js: counts words as tokens, "generates" one token per tick, and records overlap. */
function fake({ delay = 4, tokenFail = false, genFail = null, disposeFail = false, wordsPerToken = 1 } = {}) {
  const trace = [];
  let active = 0;
  let peak = 0;
  const enter = (what) => {
    active++;
    peak = Math.max(peak, active);
    trace.push(`+${what}`);
  };
  const leave = (what) => {
    active--;
    trace.push(`-${what}`);
  };
  const T = {
    env: { backends: { onnx: { wasm: {}, webgpu: null } }, version: 'fake' },
    InterruptableStoppingCriteria: class {
      interrupted = false;
      interrupt() {
        this.interrupted = true;
      }
    },
    TextStreamer: class {
      constructor(tok, o) {
        this.o = o;
      }
    },
    async pipeline(task, repo, opts) {
      enter(`load:${repo.split('/')[1]}`);
      await sleep(delay);
      leave(`load:${repo.split('/')[1]}`);
      const embed = task === 'feature-extraction';
      const pipe = async (input, o = {}) => {
        enter(embed ? 'embed' : 'generate');
        try {
          if (embed) {
            await sleep(delay);
            const n = input.length;
            const data = new Float32Array(n * 384);
            for (let i = 0; i < n; i++) data[i * 384] = 1;
            return { dims: [n, 384], data };
          }
          for (let i = 0; i < (o.max_new_tokens ?? 10); i++) {
            await sleep(delay);
            if (genFail && i === genFail.at) throw new Error(genFail.message);
            if (o.stopping_criteria?.interrupted) break;
            o.streamer.o.token_callback_function();
            o.streamer.o.callback_function(`t${i} `);
          }
        } finally {
          leave(embed ? 'embed' : 'generate');
        }
      };
      pipe.tokenizer = {
        apply_chat_template(messages) {
          if (tokenFail) throw new Error('tokenizer exploded');
          const words = messages.map((m) => m.content.split(/\s+/).filter(Boolean).length).reduce((a, b) => a + b, 0);
          return Array.from({ length: Math.ceil(words / wordsPerToken) + 6 }, (_, i) => i);
        },
      };
      pipe.dispose = async () => {
        enter(`dispose:${repo.split('/')[1]}`);
        await sleep(2);
        leave(`dispose:${repo.split('/')[1]}`);
        if (disposeFail) throw new Error('could not free');
      };
      pipe.model = { sessions: { model: { inputNames: repo.includes('350M') ? ['input_ids', 'num_logits_to_keep'] : ['input_ids'] } } };
      return pipe;
    },
  };
  return { T, trace, peak: () => peak };
}

function setup(opts) {
  const f = fake(opts);
  const out = [];
  const engine = createEngine((m) => out.push(m), { loadT: async () => f.T });
  const of = (type, id) => out.filter((m) => m.type === type && (id === undefined || m.id === id));
  const last = (type) => out.filter((m) => m.type === type).at(-1);
  return { engine, out, of, last, ...f };
}

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const msgs = (n) => [{ role: 'system', content: 'be brief' }, { role: 'user', content: words(n) }];
const load = (s, id, pkg = 'lfm350', extra = {}) => s.engine.handle({ type: 'load', id, pkg, dtype: 'q4f16', device: 'webgpu', chunks: 1, cls: 'ios', ...extra });
const gen = (s, id, n = 50, extra = {}) => s.engine.handle({ type: 'generate', id, pkg: 'lfm350', messages: msgs(n), maxTokens: 20, ...extra });

test('simultaneous requests never run at the same time inside the engine', async () => {
  const s = setup();
  await load(s, 'l1');
  await Promise.all([gen(s, 'g1'), gen(s, 'g2'), gen(s, 'g3')]);
  assert.equal(s.peak(), 1);
  assert.equal(s.of('done').length, 3);
  assert.ok(s.out.some((m) => m.type === 'log' && /Overlapping request/.test(m.msg)), 'the overlap is logged');
  assert.deepEqual(s.of('done').map((m) => m.id), ['g1', 'g2', 'g3'], 'in order');
});

test('generation submitted during a load or an embed waits for it', async () => {
  const s = setup({ delay: 8 });
  const l = load(s, 'l1');
  const g = gen(s, 'g1');
  await Promise.all([l, g]);
  assert.equal(s.peak(), 1);
  const order = s.trace.filter((t) => t.startsWith('+')).map((t) => t.slice(1));
  assert.deepEqual(order.slice(0, 2), ['load:LFM2.5-350M-ONNX', 'generate']);
  // embedding and generating do not overlap, and switching models disposes first
  const s2 = setup({ delay: 5 });
  await load(s2, 'a', 'bge', { dtype: 'q8', device: 'wasm' });
  const e = s2.engine.handle({ type: 'embed', id: 'e1', pkg: 'bge', texts: ['one', 'two'] });
  const l2 = load(s2, 'b', 'lfm350'); // model switching during an embed
  await Promise.all([e, l2]);
  assert.equal(s2.peak(), 1);
  const t = s2.trace;
  assert.ok(t.indexOf('-embed') < t.indexOf('+dispose:bge-small-en-v1.5'), 'the embed finished before the model was released');
  assert.ok(t.indexOf('-dispose:bge-small-en-v1.5') < t.indexOf('+load:LFM2.5-350M-ONNX'), 'the old model was fully released before the next one loaded');
  assert.deepEqual(s2.engine.models(), ['lfm350']);
});

test('a model cannot be released while it is generating', async () => {
  const s = setup({ delay: 6 });
  await load(s, 'l1');
  const g = gen(s, 'g1', 50, { maxTokens: 10 });
  const u = s.engine.handle({ type: 'unload', id: 'u1', pkg: 'lfm350' });
  await Promise.all([g, u]);
  const t = s.trace;
  assert.ok(t.indexOf('-generate') < t.indexOf('+dispose:LFM2.5-350M-ONNX'));
  assert.equal(s.of('unloaded').length, 1);
});

test('the prompt is counted exactly and the budget is enforced before anything runs', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 700); // 700 words + template: over the 600-token starting limit
  const err = s.of('error', 'g1')[0];
  assert.equal(err.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.ok(!s.trace.includes('+generate'), 'the model was never invoked');
  assert.equal(s.of('done').length, 0);
  // the person can raise the prompt limit (the page passes it), up to the model's ceiling
  await gen(s, 'g2', 700, { limits: { maxInput: 900, maxNew: 100 }, maxTokens: 10 });
  assert.equal(s.of('done', 'g2').length, 1);
  assert.equal(s.of('stage', 'g2').find((m) => m.stage === 'prompt.tokenized').limits.maxInput, 900);
  await gen(s, 'g3', 5000, { limits: { maxInput: 99999, maxNew: 99999 } });
  assert.equal(s.of('error', 'g3')[0].code, 'TOKEN_BUDGET_EXCEEDED', 'but never past the ceiling');
  // ... or lower it
  await gen(s, 'g4', 500, { limits: { maxInput: 300 } });
  assert.equal(s.of('error', 'g4')[0].code, 'TOKEN_BUDGET_EXCEEDED');
  // at the limit it is allowed
  await gen(s, 'g5', 590, { maxTokens: 10 });
  assert.equal(s.of('done', 'g5').length, 1);
});

test('prompt + answer never exceed the combined limit', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 580, { maxTokens: 500 }); // 588 prompt tokens; 600 + 200 = 800 together
  const done = s.of('done', 'g1')[0];
  assert.equal(done.stats.promptTokens, 588);
  assert.equal(done.stats.maxNew, 200, 'the answer limit');
  assert.ok(done.stats.promptTokens + done.stats.maxNew <= 800);
  assert.equal(done.stats.tokens, 200);
  assert.equal(done.stats.stopReason, 'length');
  assert.equal(done.stats.lastTokenLogits, true, 'read from the loaded graph, not assumed');
  assert.equal(done.stats.est.positions, 1);
  // a smaller combined limit leaves less room for the answer than was asked for
  await gen(s, 'g2', 190, { maxTokens: 500, limits: { maxInput: 200, maxNew: 50 } });
  const d2 = s.of('done', 'g2')[0];
  assert.equal(d2.stats.maxNew, 50);
});

test('a prompt that cannot be measured is refused, not run', async () => {
  const s = setup({ tokenFail: true });
  await load(s, 'l1');
  await gen(s, 'g1');
  assert.equal(s.of('error', 'g1')[0].code, 'TOKENIZATION_FAILED');
  assert.ok(!s.trace.includes('+generate'));
});

test('fit cuts the end of the last message, counted exactly, instead of refusing', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 900, { fit: true, maxTokens: 10 });
  const done = s.of('done', 'g1')[0];
  assert.ok(done, JSON.stringify(s.of('error', 'g1')));
  assert.ok(done.stats.promptTokens <= 600);
  assert.ok(done.stats.trimmed >= 1);
  assert.ok(s.out.some((m) => m.type === 'log' && /Trimmed the end of the text/.test(m.msg)));
  assert.equal(trimTail('First sentence. Second sentence. Third', 20), 'First sentence.');
  assert.equal(trimTail('short', 20), 'short');
});

test('a prompt a few tokens over the limit is trimmed and runs (with fit), or refused with a reason (without)', async () => {
  const s = setup();
  await load(s, 'l1');
  // 595 words + 6 template tokens = 601, one over the 600-token limit
  await s.engine.handle({ type: 'generate', id: 'g1', pkg: 'lfm350', messages: [{ role: 'user', content: words(595) }], maxTokens: 20, fit: true });
  const done = s.of('done', 'g1')[0];
  assert.ok(done && done.stats.promptTokens <= 600, JSON.stringify(s.of('error', 'g1')));
  await s.engine.handle({ type: 'generate', id: 'g2', pkg: 'lfm350', messages: [{ role: 'user', content: words(595) }], maxTokens: 20 });
  assert.equal(s.of('error', 'g2')[0].code, 'TOKEN_BUDGET_EXCEEDED', 'without fit it is refused with a clear reason');
});

test('Stop ends a generation and keeps the partial text; the queue carries on', async () => {
  const s = setup({ delay: 5 });
  await load(s, 'l1');
  const g = gen(s, 'g1', 50, { maxTokens: 70, limits: { maxNew: 70, maxTotal: 280 } });
  const next = gen(s, 'g2', 20, { maxTokens: 5 });
  await sleep(25);
  await s.engine.handle({ type: 'stop', id: 'g1' });
  await Promise.all([g, next]);
  const done = s.of('done', 'g1')[0];
  assert.equal(done.stats.stopped, true);
  assert.equal(done.stats.stopReason, 'stopped');
  assert.ok(done.stats.tokens < 70 && s.of('token', 'g1').length > 0, 'partial text was streamed');
  assert.equal(s.of('done', 'g2').length, 1, 'the next request still ran');
});

test('Stop on a request still waiting in the queue cancels only that one', async () => {
  const s = setup({ delay: 8 });
  await load(s, 'l1');
  const a = gen(s, 'g1', 20, { maxTokens: 5 });
  const b = gen(s, 'g2', 20, { maxTokens: 5 });
  await sleep(2);
  await s.engine.handle({ type: 'stop', id: 'g2' });
  await Promise.all([a, b]);
  assert.equal(s.of('done', 'g1').length, 1);
  assert.equal(s.of('error', 'g2')[0].code, 'CANCELLED');
  assert.equal(s.engine.sched.busy, false);
});

test('Stop during an embed batch', async () => {
  const s = setup({ delay: 6 });
  await load(s, 'l1', 'bge', { dtype: 'q8', device: 'wasm' });
  const e = s.engine.handle({ type: 'embed', id: 'e1', pkg: 'bge', texts: Array.from({ length: 40 }, (_, i) => `text ${i}`) });
  await sleep(14);
  await s.engine.handle({ type: 'stop', id: 'e1' });
  await e;
  assert.equal(s.of('error', 'e1')[0].code, 'CANCELLED');
  assert.equal(s.of('vectors').length, 0);
  await s.engine.handle({ type: 'embed', id: 'e2', pkg: 'bge', texts: ['a', 'b'] });
  assert.equal(s.of('vectors', 'e2')[0].vecs.length, 2, 'the engine is usable afterwards');
});

test('embeddings are done in small batches and long passages are cut', async () => {
  const s = setup({ delay: 1 });
  await load(s, 'l1', 'bge', { dtype: 'q8', device: 'wasm' });
  await s.engine.handle({ type: 'embed', id: 'e1', pkg: 'bge', texts: Array.from({ length: 10 }, () => 'x'.repeat(5000)) });
  const v = s.of('vectors', 'e1')[0];
  assert.equal(v.vecs.length, 10);
  assert.equal(v.batches, 3, '10 texts in batches of 4 on a phone');
  assert.equal(v.cut, 10);
});

test('an exception in the model is reported with its stage and does not lock the engine', async () => {
  const s = setup({ genFail: { at: 2, message: 'kernel failed' } });
  await load(s, 'l1');
  await gen(s, 'g1', 20, { maxTokens: 10 });
  const err = s.of('error', 'g1')[0];
  assert.equal(err.message, 'kernel failed');
  assert.ok(err.code, 'has a category');
  assert.equal(s.engine.sched.busy, false);
  assert.equal(s.of('token', 'g1').length, 2, 'text produced before the failure was delivered');
  const s2 = setup();
  await load(s2, 'l1');
  await gen(s2, 'ok1', 20, { maxTokens: 3 });
  assert.equal(s2.of('done', 'ok1').length, 1);
});

test('stage messages are posted in order, with exact token counts', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 100, { maxTokens: 12 });
  const stages = s.of('stage', 'g1').map((m) => m.stage);
  assert.deepEqual(stages.slice(0, 4), ['tokenize', 'prompt.tokenized', 'prefill', 'first_token']);
  assert.equal(stages.at(-1), 'generate.done');
  const tok = s.of('stage', 'g1').find((m) => m.stage === 'prompt.tokenized');
  assert.equal(tok.inputTokens, 108);
  assert.ok(tok.est.estimate === true);
  const loads = s.of('stage', 'l1').map((m) => m.stage);
  assert.deepEqual(loads, ['load.start', 'load.initialising', 'load.ready']);
});

test('configurations that cannot work are refused at load', async () => {
  const s = setup();
  await load(s, 'a', 'lfm12'); // no longer offered
  assert.equal(s.of('error', 'a')[0].code, 'MODEL_INCOMPATIBLE');
  await s.engine.handle({ type: 'load', id: 'b', pkg: 'lfm350', dtype: 'q8', device: 'wasm', chunks: 1, cls: 'ios' }); // no silent CPU fallback
  assert.equal(s.of('error', 'b')[0].code, 'MODEL_INCOMPATIBLE');
  await s.engine.handle({ type: 'load', id: 'c', pkg: 'nope', dtype: 'q4', device: 'webgpu' });
  assert.equal(s.of('error', 'c')[0].code, 'MODEL_INCOMPATIBLE');
  assert.deepEqual(s.engine.models(), []);
});

test('a lost GPU device stops further GPU work until the engine is restarted', async () => {
  const f = fake();
  const lost = [];
  f.T.env.backends.onnx.webgpu = { device: Promise.resolve({ lost: new Promise((r) => lost.push(r)), addEventListener() {} }) };
  const out = [];
  const engine = createEngine((m) => out.push(m), { loadT: async () => f.T });
  await engine.handle({ type: 'load', id: 'l1', pkg: 'lfm350', dtype: 'q4f16', device: 'webgpu', chunks: 1, cls: 'ios' });
  await sleep(5);
  lost[0]({ reason: 'unknown', message: 'GPU hung' });
  await sleep(5);
  assert.ok(out.some((m) => m.type === 'gpu-lost'));
  await engine.handle({ type: 'generate', id: 'g1', pkg: 'lfm350', messages: msgs(10), maxTokens: 5 });
  assert.equal(out.find((m) => m.type === 'error' && m.id === 'g1').code, 'GPU_DEVICE_LOST');
  assert.ok(!f.trace.includes('+generate'));
  await engine.handle({ type: 'load', id: 'l2', pkg: 'lfm230', dtype: 'q4', device: 'webgpu', chunks: 1, cls: 'ios' });
  assert.equal(out.find((m) => m.type === 'error' && m.id === 'l2').code, 'GPU_DEVICE_LOST');
});

test('work is refused while the app is in the background', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 20, { vis: 'hidden' });
  assert.equal(s.of('error', 'g1')[0].code, 'NOT_FOREGROUND');
  assert.ok(!s.trace.includes('+generate'));
});

test('a failed release is reported as MODEL_DISPOSE_FAILED', async () => {
  const s = setup({ disposeFail: true });
  await load(s, 'l1');
  await s.engine.handle({ type: 'unload', id: 'u1', pkg: 'lfm350' });
  assert.equal(s.of('error', 'u1')[0].code, 'MODEL_DISPOSE_FAILED');
  assert.deepEqual(s.engine.models(), [], 'the model is forgotten rather than reused');
});

test('ping answers at once, even while a long generation is queued', async () => {
  const s = setup({ delay: 10 });
  await load(s, 'l1');
  const g = gen(s, 'g1', 20, { maxTokens: 8 });
  await sleep(5);
  await s.engine.handle({ type: 'ping', id: 'p1', t: Date.now() });
  const pong = s.of('pong', 'p1')[0];
  assert.equal(pong.state, 'generating');
  assert.equal(pong.active.type, 'generate');
  await g;
});

test('withFields adds a code to any error, including one whose code is read-only', () => {
  const plain = withFields(new Error('boom'), { code: 'A', tokens: 3 });
  assert.deepEqual([plain.message, plain.code, plain.tokens], ['boom', 'A', 3]);
  const locked = Object.defineProperty(new TypeError('locked'), 'code', { get: () => 'X' });
  const w = withFields(locked, { code: 'B' });
  assert.deepEqual([w.message, w.name, w.code], ['locked', 'TypeError', 'B']);
  assert.equal(w.cause, locked);
  assert.equal(withFields('just text', { code: 'C' }).message, 'just text');
});

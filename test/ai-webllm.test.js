import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine } from '../js/ai-engine.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';

/** A stand-in for WebLLM: words are tokens; replies one token per tick; records what it was asked. */
function fakeWebllm({ models = [ID], reloadFail = null, wordsPerToken = 1, noTokenizer = false, createFail = null } = {}) {
  const calls = { reload: [], unload: 0, interrupt: 0, create: [], config: null };
  class MLCEngine {
    constructor(cfg) {
      calls.config = cfg;
      this.cfg = cfg;
      this.loadedModelIdToPipeline = new Map();
      this.stop = false;
      this.chat = { completions: { create: (req) => this.create(req) } };
    }
    async reload(id, opts) {
      calls.reload.push({ id, opts });
      for (const p of [0.2, 0.7, 1]) {
        this.cfg.initProgressCallback({ progress: p, text: `p${p}` });
        await sleep(2);
      }
      if (reloadFail) throw new Error(reloadFail);
      if (!noTokenizer) this.loadedModelIdToPipeline.set(id, { tokenizer: { encode: (t) => new Int32Array(Math.ceil(t.split(/\s+/).filter(Boolean).length / wordsPerToken)) } });
    }
    async unload() {
      calls.unload++;
      this.loadedModelIdToPipeline.clear();
    }
    interruptGenerate() {
      calls.interrupt++;
      this.stop = true;
    }
    async create(req) {
      calls.create.push(req);
      if (createFail) throw createFail();
      const self = this;
      const prompt = req.messages.reduce((n, x) => n + x.content.split(/\s+/).filter(Boolean).length, 0);
      return (async function* () {
        let n = 0;
        for (; n < req.max_tokens; n++) {
          await sleep(2);
          if (self.stop) {
            self.stop = false;
            yield { choices: [{ delta: {}, finish_reason: 'abort' }] };
            return;
          }
          yield { choices: [{ delta: { content: `t${n} ` } }] };
        }
        yield { choices: [{ delta: {}, finish_reason: 'length' }] };
        yield { choices: [], usage: { prompt_tokens: prompt + 14, completion_tokens: n } };
      })();
    }
  }
  return { W: { MLCEngine, prebuiltAppConfig: { model_list: models.map((model_id) => ({ model_id, model: 'x', model_lib: 'y' })) } }, calls };
}

function setup(opts) {
  const f = fakeWebllm(opts);
  const out = [];
  const engine = createEngine((m) => out.push(m), { loadW: async () => f.W });
  const of = (type, id) => out.filter((m) => m.type === type && (id === undefined || m.id === id));
  return { engine, out, of, ...f };
}
const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const msgs = (n) => [{ role: 'system', content: 'be brief' }, { role: 'user', content: words(n) }];
const load = (s, id, extra = {}) => s.engine.handle({ type: 'load', id, pkg: 'llama32', dtype: 'q4f16_1', device: 'webgpu', cls: 'ios', ...extra });
const gen = (s, id, n = 50, extra = {}) => s.engine.handle({ type: 'generate', id, pkg: 'llama32', messages: msgs(n), maxTokens: 20, ...extra });

test('WebLLM load: asks for the model with a fixed conversation window, and reports progress', async () => {
  const s = setup();
  await load(s, 'l1');
  assert.equal(s.of('loaded', 'l1').length, 1);
  assert.equal(s.calls.reload[0].id, ID);
  assert.equal(s.calls.reload[0].opts.context_window_size, 2048, 'above the model token limit');
  assert.equal(s.calls.config.appConfig.cacheBackend, 'indexeddb');
  assert.deepEqual(s.calls.config.appConfig.model_list.map((r) => r.model_id), [ID], 'only this model, nothing else can be fetched');
  const p = s.of('progress', 'l1');
  assert.ok(p.length >= 1 && p.at(-1).loaded === p.at(-1).total, 'progress reaches the full size');
  assert.equal(s.engine.models().join(), 'llama32');
});

test('WebLLM download (fetchOnly) loads once, reports, and releases the model', async () => {
  const s = setup();
  await load(s, 'd1', { fetchOnly: true });
  const done = s.of('loaded', 'd1')[0];
  assert.equal(done.fetched, true);
  assert.equal(s.calls.unload, 1, 'released straight away');
  assert.deepEqual(s.engine.models(), [], 'nothing stays in memory after a download');
  await gen(s, 'g1');
  assert.equal(s.of('error', 'g1')[0].code, 'MODEL_LOAD_FAILED', 'so it cannot be used until loaded');
});

test('WebLLM generate: streams tokens, reports figures, uses greedy decoding and the token cap', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 50, { maxTokens: 12 });
  const d = s.of('done', 'g1')[0];
  assert.equal(s.of('token', 'g1').length, 12);
  assert.equal(d.stats.tokens, 12);
  assert.equal(d.stats.stopReason, 'length');
  assert.equal(d.stats.device, 'webgpu');
  assert.equal(d.stats.promptCounted, 50 + 2 + 14, 'the library own count is reported next to the estimate');
  const req = s.calls.create[0];
  assert.equal(req.temperature, 0);
  assert.ok(req.max_tokens <= 12);
  assert.equal(req.stream, true);
});

test('WebLLM generate fails closed over the budget, counting with the model tokenizer', async () => {
  const s = setup();
  await load(s, 'l1');
  await gen(s, 'g1', 900); // the limit is 800 prompt tokens
  const e = s.of('error', 'g1')[0];
  assert.equal(e.code, 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(s.calls.create.length, 0, 'nothing was sent to the model');
  await gen(s, 'g2', 900, { fit: true });
  assert.equal(s.of('done', 'g2').length, 1, 'with fit, the end of the text is cut to the limit instead');
  assert.ok(s.of('done', 'g2')[0].stats.trimmed > 0);
  assert.ok(s.of('done', 'g2')[0].stats.promptTokens <= 800 + 20, 'what the library counted stays near the limit');
});

test('WebLLM without a reachable tokenizer still refuses a long prompt (a high estimate stands in)', async () => {
  const s = setup({ noTokenizer: true });
  await load(s, 'l1');
  await gen(s, 'g1', 520); // ~2,300 characters ≈ 880 estimated tokens at 2.6 characters per token
  assert.equal(s.of('error', 'g1')[0]?.code, 'TOKEN_BUDGET_EXCEEDED');
});

test('WebLLM stop interrupts the library and ends the run as stopped', async () => {
  const s = setup();
  await load(s, 'l1');
  const g = gen(s, 'g1', 20, { maxTokens: 100 });
  await sleep(15);
  await s.engine.handle({ type: 'stop', id: 'g1' });
  await g;
  assert.ok(s.calls.interrupt >= 1);
  assert.equal(s.of('done', 'g1')[0]?.stats.stopReason ?? 'stopped', 'stopped');
});

test('WebLLM: a model the library does not list, or a failing load, is a clear error and leaves nothing loaded', async () => {
  const a = setup({ models: ['Other-MLC'] });
  await load(a, 'l1');
  assert.equal(a.of('error', 'l1')[0].code, 'MODEL_INCOMPATIBLE');
  const b = setup({ reloadFail: 'Cannot find adapter that matches the request' });
  await load(b, 'l2');
  assert.equal(b.of('error', 'l2').length, 1);
  assert.equal(b.calls.unload, 1, 'the half-loaded engine is released');
  assert.deepEqual(b.engine.models(), []);
});

test('WebLLM unload releases it', async () => {
  const s = setup();
  await load(s, 'l1');
  await s.engine.handle({ type: 'unload', id: 'u1', pkg: 'llama32' });
  assert.equal(s.calls.unload, 1);
  assert.deepEqual(s.engine.models(), []);
});

test('WebLLM: a lost GPU is reported, the dead model is dropped, and the real error message survives', async () => {
  // WebLLM's own errors can have a read-only `code`; assigning to it must not hide the message
  const s = setup({ createFail: () => Object.defineProperty(new Error('Object has already been disposed'), 'code', { get: () => 'X', configurable: false }) });
  await load(s, 'l1');
  await gen(s, 'g1', 20);
  const err = s.of('error', 'g1')[0];
  assert.match(err.message, /already been disposed/, 'the real message, not a TypeError about a getter');
  assert.equal(err.code, 'GPU_DEVICE_LOST');
  assert.equal(s.of('gpu-lost').length, 1, 'the page is told');
  assert.deepEqual(s.engine.models(), [], 'the model is gone, so it is loaded again next time');
});

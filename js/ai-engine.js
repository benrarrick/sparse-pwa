// Runs the models. Lives in a Web Worker (ai-worker.js), or in the page where that is allowed. It
// never touches the network: Transformers.js reads every file through a custom cache backed by the
// downloaded pieces in IndexedDB, and any request it would send anywhere else is answered with a
// 404 and logged.
//
// ONE OPERATION AT A TIME, enforced here and not only in the screens: load, generate, embed and
// unload go through a scheduler (ai-ops.js), so a page that sends overlapping messages cannot make
// two models load, two generations run, or a model be released while it is working.
//
// Every request has an `id` that its replies carry.
// Messages in:  probe · ping · load {id, pkg, dtype, device, chunks, cls, fetchOnly} · generate {id, pkg, messages,
//               maxTokens, limits, fit, vis} · embed {id, pkg, texts, query} · stop {id}
//               · unload {id, pkg}
// Messages out: ready · pong · log {level, msg} · progress {id, pkg, file, loaded, total}
//               · stage {id, stage, ms, ...} · loaded {id, pkg, ...} · token {id, text} · done {id, stats}
//               · vectors {id, vecs} · probe {...} · unloaded {id, pkg} · gpu-lost {reason, message}
//               · error {id, pkg, phase, code, name, message, stack, stage}
import * as AS from './ai-store.js';
import { PACKAGES, parseModelUrl, AI_BUILD } from './ai-lib.js';
import { createScheduler, Cancelled } from './ai-ops.js';
import { profileFor, clampLimits, checkBudget, estimateAllocations } from './ai-policy.js';
import { AiError, classifyError } from './ai-diag.js';

const now = () => performance.now();

export async function probeGpu() {
  const out = { gpu: false, f16: false, where: typeof window === 'undefined' ? 'worker' : 'page' };
  try {
    if (!globalThis.navigator?.gpu) return { ...out, why: 'navigator.gpu is missing (no WebGPU here)' };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ...out, why: 'requestAdapter() returned no adapter' };
    const info = adapter.info ?? {};
    const lim = adapter.limits;
    return {
      ...out,
      gpu: true,
      f16: adapter.features.has('shader-f16'),
      adapter: [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' · ') || 'unnamed',
      limits: {
        maxBufferSize: lim.maxBufferSize,
        maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: lim.maxComputeWorkgroupStorageSize,
      },
      fallback: !!info.isFallbackAdapter,
    };
  } catch (e) {
    return { ...out, why: `WebGPU probe failed: ${e?.message ?? e}` };
  }
}

/** Adds fields (a code) to an error. Some libraries' errors have a read-only `code`: those are wrapped, keeping the message and stack. */
export function withFields(err, fields) {
  const e = err instanceof Error ? err : new Error(String(err));
  try {
    return Object.assign(e, fields);
  } catch {
    const w = new Error(e.message, { cause: e });
    w.name = e.name;
    w.stack = e.stack;
    return Object.assign(w, fields);
  }
}

/** Errors that mean WebLLM's GPU device is gone (it unloads itself when that happens). */
const GPU_GONE = /device was lost|already been disposed|deleted object|mapAsync|Buffer was unmapped|device.*(destroyed|lost)/i;

/** Cuts the end of `text` to about `keep` characters, at a paragraph or sentence end when one is near. */
export function trimTail(text, keep) {
  if (text.length <= keep) return text;
  const slice = text.slice(0, Math.max(0, keep));
  const end = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
  return (end > keep * 0.6 ? slice.slice(0, end + 1) : slice).trimEnd();
}

/**
 * `deps` is for tests: { loadT: async () => the Transformers.js module, now }.
 */
export function createEngine(post, deps = {}) {
  let T = null;
  let runtime = null;
  let W = null; // WebLLM, for the models that run on it
  let wRuntime = null;
  let cls = 'ios'; // the strictest class until the page says otherwise
  let gpuLost = false;
  let gpuErrors = 0;
  const models = new Map(); // pkg -> { pipe, info }
  const stoppers = new Map(); // op id -> { interrupt() }
  const clock = deps.now ?? now;
  const log = (level, msg, data) => post({ type: 'log', level, msg, data });
  const stage = (id, name, extra = {}) => post({ type: 'stage', id, stage: name, at: Date.now(), ...extra });
  const mem = () => ({ jsHeap: globalThis.performance?.memory?.usedJSHeapSize ?? null, jsHeapLimit: globalThis.performance?.memory?.jsHeapSizeLimit ?? null });

  const sched = createScheduler({
    onEvent: (e) => post({ type: 'sched', e }),
    maxQueue: 6,
  });

  const fail = (msg, phase, e, stageName) =>
    post({
      type: 'error',
      ...msg,
      phase,
      code: gpuLost && phase !== 'unload' ? 'GPU_DEVICE_LOST' : classifyError(e, { stage: stageName ?? phase }),
      name: e?.name ?? 'Error',
      message: e?.message ?? String(e),
      stage: stageName ?? null,
      stack: String(e?.stack ?? '').slice(0, 1500),
    });

  async function cacheMatch(req) {
    const url = typeof req === 'string' ? req : req?.url;
    const m = parseModelUrl(url);
    if (!m) return undefined;
    if (!m.pkg) {
      log('warn', `The engine asked for ${m.repo}/${m.path}, which is not one of the downloadable packages`);
      return undefined;
    }
    // Transformers.js asks for some files (config.json) at "main" whatever revision it was given;
    // the copy on the device is always the pinned one, so that is what it gets.
    const blob = await AS.fileBlob(m.pkg, m.path);
    if (!blob) {
      log('warn', `The engine asked for ${m.path} from ${PACKAGES[m.pkg].short}, which is not on this device`);
      return undefined;
    }
    return new Response(blob, { headers: { 'content-length': String(blob.size), 'content-type': 'application/octet-stream' } });
  }

  function loadRuntime() {
    return (runtime ??= (async () => {
      const t0 = clock();
      if (deps.loadT) {
        T = await deps.loadT();
        return T;
      }
      const [js, wasm] = await Promise.all([AS.fileBlob('engine', 'transformers.min.js'), AS.fileBlob('engine', 'ort-wasm-simd-threaded.asyncify.wasm')]);
      if (!js || !wasm) throw new AiError('MODEL_NOT_INSTALLED', 'The AI engine is not on this device. Download a model first: the engine comes with it.');
      // The module is imported from a blob: URL made from the stored file, so it works offline.
      const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
      T = await import(url);
      const { env } = T;
      env.allowLocalModels = false;
      env.allowRemoteModels = true; // "remote" URLs are only ever answered by the cache below
      env.useBrowserCache = false;
      env.useWasmCache = false;
      env.useCustomCache = true;
      env.customCache = { match: cacheMatch, put: async () => {} };
      env.fetch = async (u) => {
        log('warn', `The engine tried to download ${String(u).slice(0, 160)}; blocked, as everything must come from this device`);
        return new Response(null, { status: 404, statusText: 'Not on this device' });
      };
      const onnx = env.backends.onnx;
      onnx.wasm.wasmBinary = await wasm.arrayBuffer();
      onnx.wasm.wasmPaths = undefined; // the JS half of ONNX Runtime is bundled into transformers.min.js
      onnx.wasm.numThreads = 1; // threads need cross-origin isolation, which GitHub Pages can't turn on
      onnx.wasm.proxy = false;
      log('ok', `Engine started in ${Math.round(clock() - t0)} ms: Transformers.js ${env.version ?? '?'}, ONNX Runtime ${onnx.versions?.web ?? '?'}`, { ms: Math.round(clock() - t0), tjs: env.version, ort: onnx.versions?.web });
      return T;
    })().catch((e) => {
      runtime = null;
      throw e;
    }));
  }

  async function watchGpu() {
    try {
      const device = await T.env.backends.onnx.webgpu?.device;
      if (!device || device.__sparseWatched) return;
      device.__sparseWatched = true;
      device.lost.then((info) => {
        if (info.reason === 'destroyed') return log('info', 'GPU memory released (the model was unloaded)');
        gpuLost = true;
        post({ type: 'gpu-lost', reason: info.reason || 'unknown', message: String(info.message || '').slice(0, 300) });
        log('error', `The GPU device was lost (${info.reason || 'no reason given'}): ${info.message || 'no message'}. Loaded models need reloading.`);
      });
      device.addEventListener?.('uncapturederror', (ev) => {
        gpuErrors++;
        log('error', `GPU error: ${ev.error?.message ?? ev.error}`, { count: gpuErrors });
      });
    } catch (e) {
      log('warn', `Could not watch the GPU device: ${e?.message ?? e}`);
    }
  }

  // ---------- steps (always called inside a scheduled operation) ----------

  async function disposeModel(id, pkg, why) {
    const m = models.get(pkg);
    if (!m) return;
    const t0 = clock();
    stage(id, 'dispose.start', { pkg, why, mem: mem() });
    models.delete(pkg);
    try {
      if (m.engine) await m.engine.unload();
      else await m.pipe.dispose?.();
    } catch (e) {
      post({ type: 'log', level: 'error', msg: `Releasing ${PACKAGES[pkg]?.short ?? pkg} failed: ${e?.message ?? e}` });
      throw new AiError('MODEL_DISPOSE_FAILED', `Releasing ${PACKAGES[pkg]?.short ?? pkg} from memory failed: ${e?.message ?? e}`);
    }
    stage(id, 'dispose.done', { pkg, ms: Math.round(clock() - t0), mem: mem() });
    post({ type: 'unloaded', id, pkg, ms: Math.round(clock() - t0), why });
  }

  async function load({ id, pkg, dtype, device, chunks, cls: c, fetchOnly = false }) {
    if (c) cls = c;
    const spec = PACKAGES[pkg];
    if (!spec) throw new AiError('MODEL_INCOMPATIBLE', `Unknown model ${pkg}`);
    if (models.has(pkg)) return post({ type: 'loaded', id, pkg, already: true, ...models.get(pkg).info });
    if (device === 'webgpu' && gpuLost) throw new AiError('GPU_DEVICE_LOST', 'The GPU was lost earlier. The engine must be restarted before loading a model onto it.');
    const p = profileFor(pkg);
    if (p.status === 'unsupported') throw new AiError('MODEL_INCOMPATIBLE', p.why ?? `${spec.short} is not supported on this device`);
    if (!p.backends?.includes(device)) throw new AiError('MODEL_INCOMPATIBLE', `${spec.short} is not allowed to run on ${device} on this device`);
    // one model in memory at a time: release the others first, completely, before loading this one
    for (const other of [...models.keys()]) await disposeModel(id, other, 'switching to another model');
    if (spec.runtime === 'webllm') return loadWebllm({ id, pkg, spec, device, fetchOnly });
    stage(id, 'load.start', { pkg, dtype, device, mem: mem() });
    await loadRuntime();
    const t0 = clock();
    let last = 0;
    const progress_callback = (pr) => {
      if (pr.status !== 'progress' || clock() - last < 300) return;
      last = clock();
      post({ type: 'progress', id, pkg, file: pr.file, loaded: pr.loaded, total: pr.total });
    };
    // The weight file count is passed explicitly: some configs name the 8-bit export in a way
    // Transformers.js doesn't match (model_quantized), and would then load no weights at all.
    const opts = { revision: spec.revision, device, dtype, progress_callback, use_external_data_format: chunks };
    log('info', `Loading ${spec.short} (${dtype} on ${device})…`);
    stage(id, 'load.initialising', { pkg });
    let pipe;
    try {
      pipe = await T.pipeline(spec.kind === 'chat' ? 'text-generation' : 'feature-extraction', spec.repo, opts);
    } catch (e) {
      throw withFields(e, { code: gpuLost ? 'GPU_DEVICE_LOST' : classifyError(e, { stage: 'load.start' }) });
    }
    // what the exported graph can do is read from the session, not assumed
    const names = pipe.model?.sessions?.model?.inputNames ?? pipe.model?.sessions?.decoder_model_merged?.inputNames ?? null;
    const info = { device, dtype, ms: Math.round(clock() - t0), lastTokenLogits: names ? names.includes('num_logits_to_keep') : null, inputs: names?.length ?? null };
    models.set(pkg, { pipe, info });
    if (device === 'webgpu') watchGpu();
    stage(id, 'load.ready', { pkg, ms: info.ms, mem: mem() });
    post({ type: 'loaded', id, pkg, ...info });
  }

  function loadWebllmRuntime() {
    return (wRuntime ??= (async () => {
      if (deps.loadW) return (W = await deps.loadW());
      const js = await AS.fileBlob('webllm', 'web-llm.js');
      if (!js) throw new AiError('MODEL_NOT_INSTALLED', 'The WebLLM engine is not on this device. Download the model again: the engine comes with it.');
      // imported from a blob: URL made from the stored file, so it works offline; once evaluated the 6 MB
      // copy is let go (the bundle never refers to its own address)
      const url = URL.createObjectURL(new Blob([js], { type: 'text/javascript' }));
      try {
        W = await import(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      log('ok', `WebLLM engine started (${js.size ? Math.round(js.size / 1e6) : '?'} MB)`);
      return W;
    })().catch((e) => {
      wRuntime = null;
      throw e;
    }));
  }

  /**
   * A WebLLM model. WebLLM fetches and keeps the model files itself (its own IndexedDB store), so a first
   * load is also the download. `fetchOnly` loads, reports, and releases at once: that is the "download".
   */
  async function loadWebllm({ id, pkg, spec, device, fetchOnly }) {
    stage(id, 'load.start', { pkg, dtype: spec.dtype, device, mem: mem() });
    const WL = await loadWebllmRuntime();
    const record = WL.prebuiltAppConfig.model_list.find((r) => r.model_id === spec.modelId);
    if (!record) throw new AiError('MODEL_INCOMPATIBLE', `This version of WebLLM has no build of ${spec.short} (${spec.modelId})`);
    const t0 = clock();
    let last = 0;
    const engine = new WL.MLCEngine({
      appConfig: { model_list: [record], cacheBackend: 'indexeddb' },
      initProgressCallback: (p) => {
        if (clock() - last < 300 && p.progress < 1) return;
        last = clock();
        post({ type: 'progress', id, pkg, file: spec.modelId, loaded: Math.round(p.progress * spec.size), total: spec.size });
      },
    });
    log('info', `Loading ${spec.short} through WebLLM (${spec.dtype} on ${device})…`);
    stage(id, 'load.initialising', { pkg });
    try {
      // the conversation memory WebLLM reserves: above the model's combined token limit
      await engine.reload(spec.modelId, { context_window_size: spec.contextWindow ?? 1536, temperature: 0 });
    } catch (e) {
      await engine.unload().catch(() => {});
      throw withFields(e, { code: classifyError(e, { stage: 'load.start' }) });
    }
    const info = { device, dtype: spec.dtype, ms: Math.round(clock() - t0), lastTokenLogits: true, inputs: null, runtime: 'webllm' };
    if (fetchOnly) {
      await engine.unload();
      stage(id, 'load.ready', { pkg, ms: info.ms, fetched: true, mem: mem() });
      return post({ type: 'loaded', id, pkg, fetched: true, ...info });
    }
    models.set(pkg, { engine, pipe: null, info, modelId: spec.modelId });
    stage(id, 'load.ready', { pkg, ms: info.ms, mem: mem() });
    post({ type: 'loaded', id, pkg, ...info });
  }

  /** Tokens in a chat prompt for a WebLLM model: its own tokenizer when reachable, else a deliberately high estimate. */
  function countWebllm(m, messages) {
    const perMessage = 6; // role header and end-of-turn tokens of the chat template
    const enc = m.engine.loadedModelIdToPipeline?.get?.(m.modelId)?.tokenizer?.encode;
    try {
      if (enc) {
        const tk = m.engine.loadedModelIdToPipeline.get(m.modelId).tokenizer;
        return messages.reduce((n, x) => n + tk.encode(String(x.content)).length + perMessage, 8);
      }
    } catch (e) {
      log('warn', `Could not count the prompt's tokens with the WebLLM tokenizer: ${e?.message ?? e}`);
    }
    return messages.reduce((n, x) => n + Math.ceil(String(x.content).length / 2.6) + perMessage, 8);
  }

  function countTokens(tok, messages) {
    try {
      const ids = tok.apply_chat_template(messages, { add_generation_prompt: true, tokenize: true, return_tensor: false });
      const flat = ids?.input_ids ?? ids;
      const n = Array.isArray(flat) ? (Array.isArray(flat[0]) ? flat[0].length : flat.length) : (flat?.dims?.at(-1) ?? null);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch (e) {
      log('warn', `Could not count the prompt's tokens: ${e?.message ?? e}`);
      return null;
    }
  }

  /** Limits for this run: what the page asked for (the person's settings), made sensible and kept under the model's ceiling. */
  function limitsFor(pkg, requested) {
    return clampLimits(pkg, requested) ?? { maxInput: 0, maxNew: 0, maxTotal: 0, maxMs: 0 };
  }

  async function generate({ id, pkg, messages, maxTokens = 128, limits: asked = null, fit = false, vis = 'visible' }, ctx) {
    const m = models.get(pkg);
    if (!m) throw new AiError('MODEL_LOAD_FAILED', `${PACKAGES[pkg]?.short ?? pkg} is not loaded`);
    if (vis === 'hidden') throw new AiError('NOT_FOREGROUND');
    if (m.info.device === 'webgpu' && gpuLost) throw new AiError('GPU_DEVICE_LOST');
    const limits = limitsFor(pkg, asked);
    const tok = m.pipe?.tokenizer;
    const count = (msgs) => (m.engine ? countWebllm(m, msgs) : countTokens(tok, msgs));
    ctx?.stage('tokenize');
    stage(id, 'tokenize', { mem: mem() });
    const tt0 = clock();
    let inputTokens = count(messages);
    // `fit`: the end of the last message may be cut to fit the limit (source text, summary parts),
    // counted exactly with the model's tokenizer. Without it, a prompt over the limit is refused.
    let trimmed = 0;
    for (let i = 0; fit && inputTokens && inputTokens > limits.maxInput && i < 5; i++) {
      const last = messages[messages.length - 1];
      const keep = Math.floor(last.content.length * (limits.maxInput / inputTokens) * (i < 3 ? 0.95 : 0.85));
      const before = inputTokens;
      messages = [...messages.slice(0, -1), { ...last, content: trimTail(last.content, keep) }];
      inputTokens = count(messages);
      trimmed++;
      log('info', `Trimmed the end of the text to fit the ${limits.maxInput}-token limit (${before} → ${inputTokens} tokens)`, { before, after: inputTokens });
    }
    const tokenizeMs = Math.round(clock() - tt0);
    const check = checkBudget({ inputTokens, maxNew: maxTokens, limits });
    if (!check.ok) throw new AiError(check.code, check.message);
    const est = estimateAllocations(pkg, inputTokens);
    stage(id, 'prompt.tokenized', { inputTokens, maxNew: check.maxNew, total: check.total, limits, tokenizeMs, trimmed, est, mem: mem() });
    const stopper = m.engine
      ? {
          interrupted: false,
          interrupt() {
            this.interrupted = true;
            m.engine.interruptGenerate();
          },
        }
      : new T.InterruptableStoppingCriteria();
    stoppers.set(id, stopper);
    ctx?.signal?.addEventListener('abort', () => stopper.interrupt(), { once: true });
    let tokens = 0;
    let first = null;
    let lastStage = 0;
    let finish = null;
    let usage = null;
    const t0 = clock();
    const onToken = () => {
      tokens++;
      if (first == null) {
        first = clock();
        stage(id, 'first_token', { ms: Math.round(first - t0) });
      } else if (clock() - lastStage > 700) {
        lastStage = clock();
        stage(id, 'decode', { tokens });
      }
    };
    ctx?.stage('prefill');
    // Prompt processing is inside this one call and runs until the first token: its start is
    // recorded here, its end is the first_token stage. The runtime reports nothing in between.
    stage(id, 'prefill', { inputTokens, mem: mem() });
    let error = null;
    try {
      if (m.engine) {
        const chunks = await m.engine.chat.completions.create({
          messages,
          temperature: 0,
          max_tokens: check.maxNew,
          repetition_penalty: 1.05,
          stream: true,
          stream_options: { include_usage: true },
        });
        for await (const c of chunks) {
          const d = c.choices?.[0]?.delta?.content;
          if (d) {
            post({ type: 'token', id, text: d });
            onToken();
          }
          if (c.choices?.[0]?.finish_reason) finish = c.choices[0].finish_reason;
          if (c.usage) usage = c.usage;
        }
        if (usage?.completion_tokens) tokens = usage.completion_tokens;
        if (usage?.prompt_tokens > limits.maxInput) log('warn', `WebLLM counted ${usage.prompt_tokens} prompt tokens, over the ${limits.maxInput}-token limit (the estimate was ${inputTokens})`, { counted: usage.prompt_tokens, estimate: inputTokens });
      } else {
        const streamer = new T.TextStreamer(tok, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (text) => post({ type: 'token', id, text }),
          token_callback_function: onToken,
        });
        await m.pipe(messages, { max_new_tokens: check.maxNew, do_sample: false, repetition_penalty: 1.05, streamer, stopping_criteria: stopper });
      }
    } catch (e) {
      error = e;
    } finally {
      stoppers.delete(id);
    }
    const ms = Math.round(clock() - t0);
    const timedOut = ctx?.signal?.reason?.code === 'INFERENCE_TIMEOUT';
    const stopped = !!stopper.interrupted;
    const stopReason = error ? 'error' : timedOut ? 'timeout' : stopped || finish === 'abort' ? 'stopped' : tokens >= check.maxNew || finish === 'length' ? 'length' : 'eos';
    if (error) {
      // WebLLM unloads itself when its GPU device is lost: the model is gone, so say so and let the page reload it
      if (m.engine && GPU_GONE.test(String(error?.message ?? error))) {
        gpuLost = true;
        models.delete(pkg);
        post({ type: 'gpu-lost', reason: 'webllm', message: String(error?.message ?? error).slice(0, 300) });
      }
      // partial text already streamed stays with the page; the error says where it stopped
      throw withFields(error, { code: gpuLost ? 'GPU_DEVICE_LOST' : classifyError(error, { stage: first == null ? 'prefill' : 'decode' }), tokens });
    }
    const stats = {
      device: m.info.device,
      dtype: m.info.dtype,
      tokens,
      ms,
      ttft: first == null ? null : Math.round(first - t0),
      promptTokens: usage?.prompt_tokens ?? inputTokens,
      promptCounted: usage?.prompt_tokens ?? null,
      stopped,
      stopReason,
      requestedNew: maxTokens,
      maxNew: check.maxNew,
      clamped: check.clamped,
      tokenizeMs,
      trimmed,
      est,
      lastTokenLogits: m.info.lastTokenLogits,
      mem: mem(),
    };
    stage(id, 'generate.done', { tokens, ms, stopReason, mem: mem() });
    post({ type: 'done', id, stats });
  }

  async function embed({ id, pkg, texts, query }, ctx) {
    const m = models.get(pkg);
    if (!m) throw new AiError('MODEL_LOAD_FAILED', `${PACKAGES[pkg]?.short ?? pkg} is not loaded`);
    const p = profileFor(pkg);
    const prefix = query ? 'Represent this sentence for searching relevant passages: ' : '';
    const t0 = clock();
    const vecs = [];
    const stopper = { interrupted: false, interrupt() { this.interrupted = true; } };
    stoppers.set(id, stopper);
    ctx?.signal?.addEventListener('abort', () => stopper.interrupt(), { once: true });
    let cut = 0;
    try {
      for (let i = 0; i < texts.length; i += p.maxBatch ?? 4) {
        if (stopper.interrupted) throw new Cancelled('Stopped');
        const batch = texts.slice(i, i + (p.maxBatch ?? 4)).map((t) => {
          if (t.length > (p.maxChars ?? 1200)) cut++;
          return prefix + t.slice(0, p.maxChars ?? 1200);
        });
        stage(id, 'embed.batch', { done: i, of: texts.length, mem: i === 0 ? mem() : undefined });
        const out = await m.pipe(batch, { pooling: 'cls', normalize: true });
        const dim = out.dims[out.dims.length - 1];
        for (let k = 0; k < batch.length; k++) vecs.push(out.data.slice(k * dim, (k + 1) * dim));
        await 0; // let a Stop message in between batches
      }
    } finally {
      stoppers.delete(id);
    }
    stage(id, 'embed.done', { n: texts.length, ms: Math.round(clock() - t0) });
    post({ type: 'vectors', id, vecs, ms: Math.round(clock() - t0), cut, batches: Math.ceil(texts.length / (p.maxBatch ?? 4)) });
  }

  return {
    sched,
    get cls() {
      return cls;
    },
    get gpuLost() {
      return gpuLost;
    },
    models: () => [...models.keys()],
    /** Handles one message. Never throws; failures become `error` messages. */
    async handle(msg) {
      try {
        switch (msg.type) {
          case 'probe':
            return post({ type: 'probe', id: msg.id, ...(await probeGpu()) });
          case 'ping':
            return post({ type: 'pong', id: msg.id, t: msg.t, state: sched.state, active: sched.snapshot().active, queue: sched.depth, models: [...models.keys()], gpuLost, build: AI_BUILD });
          case 'stop': {
            // out of band: never queued behind the work it is stopping
            const s = stoppers.get(msg.id);
            if (s) s.interrupt();
            return sched.cancel(msg.id, 'Stopped');
          }
          case 'load':
          case 'generate':
          case 'embed':
          case 'unload': {
            const spec = { id: msg.id, type: msg.type, pkg: msg.pkg, label: msg.label };
            if (sched.depth > 0 || sched.busy) log('warn', `Overlapping request (${msg.type}) queued behind ${sched.snapshot().active?.type ?? 'another task'}: the page should not send these`, { type: msg.type });
            return await sched.run({ ...spec, timeoutMs: msg.type === 'generate' ? limitsFor(msg.pkg, msg.limits).maxMs : msg.type === 'embed' ? (profileFor(msg.pkg).maxMs ?? 0) : 0 }, async (ctx) => {
              if (msg.type === 'load') return load(msg);
              if (msg.type === 'generate') return generate(msg, ctx);
              if (msg.type === 'embed') return embed(msg, ctx);
              const had = models.has(msg.pkg);
              await disposeModel(msg.id, msg.pkg, msg.why ?? 'unload');
              if (!had) post({ type: 'unloaded', id: msg.id, pkg: msg.pkg, ms: 0, already: true });
              return;
            });
          }
          default:
        }
      } catch (e) {
        if (e instanceof Cancelled || e?.name === 'Cancelled') return post({ type: 'error', id: msg.id, pkg: msg.pkg, phase: msg.type, code: 'CANCELLED', name: 'Cancelled', message: e.message, stage: null, stack: '' });
        fail({ id: msg.id, pkg: msg.pkg }, msg.type, e, e?.stage);
      }
    },
  };
}

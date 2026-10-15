// Runs the models. Lives in a Web Worker (ai-worker.js), or in the page when this browser only
// offers WebGPU there. It never touches the network: Transformers.js reads every file through a
// custom cache backed by the downloaded pieces in IndexedDB, and any request it would send
// anywhere else is answered with a 404 and logged.
//
// Messages in:  probe · load {pkg, dtype, device} · generate {id, pkg, messages, maxTokens}
//               · embed {id, pkg, texts, query} · stop {id} · unload {pkg}
// Messages out: log {level, msg, data} · progress {pkg, file, loaded, total} · loaded {pkg, ...}
//               · token {id, text} · done {id, stats} · vectors {id, vecs} · probe {...}
//               · unloaded {pkg} · error {id?, pkg?, phase, name, message, stack}
import * as AS from './ai-store.js';
import { PACKAGES, parseModelUrl } from './ai-lib.js';

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

export function createEngine(post) {
  let T = null;
  let runtime = null;
  const models = new Map(); // pkg -> { pipe, device, dtype }
  const stoppers = new Map();
  const log = (level, msg, data) => post({ type: 'log', level, msg, data });
  const fail = (msg, phase, e) =>
    post({ type: 'error', ...msg, phase, name: e?.name ?? 'Error', message: e?.message ?? String(e), stack: String(e?.stack ?? '').slice(0, 1500) });

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
      const t0 = now();
      const [js, wasm] = await Promise.all([AS.fileBlob('engine', 'transformers.min.js'), AS.fileBlob('engine', 'ort-wasm-simd-threaded.asyncify.wasm')]);
      if (!js || !wasm) throw new Error('The AI engine is not on this device. Download a model first: the engine comes with it.');
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
      log('ok', `Engine started in ${Math.round(now() - t0)} ms: Transformers.js ${env.version ?? '?'}, ONNX Runtime ${onnx.versions?.web ?? '?'}`);
      return T;
    })().catch((e) => {
      runtime = null;
      throw e;
    }));
  }

  async function watchGpu(pkg) {
    try {
      const device = await T.env.backends.onnx.webgpu?.device;
      if (!device || device.__sparseWatched) return;
      device.__sparseWatched = true;
      device.lost.then((info) =>
        info.reason === 'destroyed'
          ? log('info', 'GPU memory released (the model was unloaded)')
          : log('error', `The GPU device was lost (${info.reason || 'no reason given'}): ${info.message || 'no message'}. Loaded models need reloading.`),
      );
      device.addEventListener?.('uncapturederror', (ev) => log('error', `GPU error: ${ev.error?.message ?? ev.error}`, { pkg }));
    } catch (e) {
      log('warn', `Could not watch the GPU device: ${e?.message ?? e}`);
    }
  }

  async function load({ pkg, dtype, device, chunks }) {
    if (models.has(pkg)) return post({ type: 'loaded', pkg, already: true, ...models.get(pkg).info });
    const spec = PACKAGES[pkg];
    await loadRuntime();
    const t0 = now();
    let last = 0;
    const progress_callback = (p) => {
      if (p.status !== 'progress' || now() - last < 300) return;
      last = now();
      post({ type: 'progress', pkg, file: p.file, loaded: p.loaded, total: p.total });
    };
    // The weight file count is passed explicitly: some configs name the 8-bit export in a way
    // Transformers.js doesn't match (model_quantized), and would then load no weights at all.
    const opts = { revision: spec.revision, device, dtype, progress_callback, use_external_data_format: chunks };
    log('info', `Loading ${spec.short} (${dtype} on ${device})…`);
    const pipe = await T.pipeline(spec.kind === 'chat' ? 'text-generation' : 'feature-extraction', spec.repo, opts);
    const info = { device, dtype, ms: Math.round(now() - t0) };
    models.set(pkg, { pipe, info });
    if (device === 'webgpu') watchGpu(pkg);
    post({ type: 'loaded', pkg, ...info });
  }

  async function generate({ id, pkg, messages, maxTokens = 400, maxPrompt = null }) {
    const m = models.get(pkg);
    if (!m) throw new Error(`${PACKAGES[pkg]?.short ?? pkg} is not loaded`);
    const tok = m.pipe.tokenizer;
    let promptTokens = null;
    try {
      const ids = tok.apply_chat_template(messages, { add_generation_prompt: true, tokenize: true, return_tensor: false });
      const flat = ids?.input_ids ?? ids;
      promptTokens = Array.isArray(flat) ? (Array.isArray(flat[0]) ? flat[0].length : flat.length) : (flat?.dims?.at(-1) ?? null);
    } catch (e) {
      log('warn', `Could not count the prompt's tokens: ${e?.message ?? e}`);
    }
    // A prompt over the limit is refused here: on iOS, running it would end the whole app.
    if (maxPrompt && promptTokens > maxPrompt)
      throw new Error(`The prompt is ${promptTokens} tokens, over the ${maxPrompt}-token limit set on the AI page, so it was not run`);
    const stopper = new T.InterruptableStoppingCriteria();
    stoppers.set(id, stopper);
    let tokens = 0;
    let first = null;
    const t0 = now();
    const streamer = new T.TextStreamer(tok, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (text) => post({ type: 'token', id, text }),
      token_callback_function: () => {
        tokens++;
        first ??= now();
      },
    });
    try {
      await m.pipe(messages, { max_new_tokens: maxTokens, do_sample: false, repetition_penalty: 1.05, streamer, stopping_criteria: stopper });
    } finally {
      stoppers.delete(id);
    }
    const stats = { device: m.info.device, dtype: m.info.dtype, tokens, ms: Math.round(now() - t0), ttft: first == null ? null : Math.round(first - t0), promptTokens, stopped: !!stopper.interrupted };
    post({ type: 'done', id, stats });
  }

  async function embed({ id, pkg, texts, query }) {
    const m = models.get(pkg);
    if (!m) throw new Error(`${PACKAGES[pkg]?.short ?? pkg} is not loaded`);
    const prefix = query ? 'Represent this sentence for searching relevant passages: ' : '';
    const t0 = now();
    const out = await m.pipe(
      texts.map((t) => prefix + t),
      { pooling: 'cls', normalize: true },
    );
    const dim = out.dims[out.dims.length - 1];
    const vecs = texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
    post({ type: 'vectors', id, vecs, ms: Math.round(now() - t0) });
  }

  async function unload({ pkg }) {
    const m = models.get(pkg);
    models.delete(pkg);
    if (m) await m.pipe.dispose?.();
    post({ type: 'unloaded', pkg });
  }

  return {
    async handle(msg) {
      try {
        if (msg.type === 'probe') return post({ type: 'probe', ...(await probeGpu()) });
        if (msg.type === 'load') return await load(msg);
        if (msg.type === 'generate') return await generate(msg);
        if (msg.type === 'embed') return await embed(msg);
        if (msg.type === 'unload') return await unload(msg);
        if (msg.type === 'stop') return stoppers.get(msg.id)?.interrupt();
      } catch (e) {
        fail({ id: msg.id, pkg: msg.pkg }, msg.type, e);
      }
    },
  };
}

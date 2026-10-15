// AI lab worker: runs ONE experiment, then the page terminates it. Messages out:
//   {type:'stage', name}      persisted by the page before the risky step runs
//   {type:'log', msg}
//   {type:'partial', text}    the answer so far (batched)
//   {type:'done', result}     {text, loadMs, firstTokenMs, genMs, tokens}   (null = unavailable)
//   {type:'fail', stage, message, stack}
import { EXPERIMENTS, PROMPT, SYSTEM, MAX_NEW, THINKING_NEW, TJS_VERSION, WEBLLM_VERSION } from './ai-lab-config.js';

const post = (m) => self.postMessage(m);
const stage = (name) => post({ type: 'stage', name });
const log = (msg) => post({ type: 'log', msg });
const now = () => performance.now();
const MB = (n) => `${(n / 1048576).toFixed(0)} MB`;

let lastPartial = 0;
function partial(text, force) {
  if (!force && now() - lastPartial < 250) return;
  lastPartial = now();
  post({ type: 'partial', text });
}

async function runTjs(x, dtype, prompts, maxNew) {
  stage('runtime initialization');
  log(`Importing Transformers.js ${TJS_VERSION} from jsDelivr`);
  const T = await import(`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/transformers.min.js`);
  const { env, AutoTokenizer, AutoModelForCausalLM, TextStreamer } = T;
  env.allowLocalModels = false;
  env.cacheKey = `sparse-lab-${x.n}`; // its own browser cache per experiment (experiment 1 caches our own graph)
  env.backends.onnx.wasm.numThreads = 1; // threads need cross-origin isolation, which this host can't give
  if (x.graphOverride) {
    const orig = env.fetch;
    env.fetch = (u, init) => {
      const hit = Object.keys(x.graphOverride).find((k) => String(u).endsWith(k));
      if (!hit) return orig(u, init);
      const local = new URL(`../${x.graphOverride[hit]}`, import.meta.url).href;
      log(`Using our graph ${x.graphOverride[hit]} instead of ${hit}`);
      return orig(local);
    };
  }
  log(`Transformers.js ${env.version ?? '?'} ready; WebGPU adapter: ${(await navigator.gpu?.requestAdapter())?.info?.description || (navigator.gpu ? 'present' : 'NOT AVAILABLE')}`);

  stage('model download / cache access');
  const pending = new Set();
  const seen = new Map();
  const progress = (e) => {
    if (e.status === 'initiate') pending.add(e.file);
    else if (e.status === 'done') {
      pending.delete(e.file);
      log(`  fetched ${e.file}`);
      if (!pending.size) stage('model loading');
    } else if (e.status === 'progress' && e.total) {
      const step = Math.floor(e.progress / 20);
      if (seen.get(e.file) !== step) {
        seen.set(e.file, step);
        log(`  ${e.file}: ${MB(e.loaded)} of ${MB(e.total)}`);
      }
    }
  };
  const t0 = now();
  const tokenizer = await AutoTokenizer.from_pretrained(x.repo, { progress_callback: progress });
  log('Tokenizer ready');
  const model = await AutoModelForCausalLM.from_pretrained(x.repo, { dtype, device: 'webgpu', progress_callback: progress });
  const loadMs = now() - t0;
  stage('model ready');
  const names = model.sessions ? Object.keys(model.sessions) : [];
  log(`Model loaded in ${(loadMs / 1000).toFixed(1)}s as ${dtype}${names.length ? ` (sessions: ${names.join(', ')})` : ''}`);

  const generate = async (prompt, maxNew) => {
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }];
    const inputs = tokenizer.apply_chat_template(messages, { add_generation_prompt: true, return_dict: true, enable_thinking: false });
    const promptTokens = inputs.input_ids.dims.at(-1);
    log(`Prompt is ${promptTokens} tokens (thinking off where the template supports it)`);
    stage('prompt submitted');
    let text = '';
    let tokens = 0;
    let tFirst = null;
    const tGen = now();
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (s) => {
        text += s;
        partial(text);
      },
      token_callback_function: () => {
        if (tFirst === null) {
          tFirst = now() - tGen;
          stage('first token received');
          log(`First token after ${(tFirst / 1000).toFixed(1)}s`);
        }
        tokens++;
      },
    });
    try {
      await model.generate({ ...inputs, max_new_tokens: maxNew, do_sample: false, streamer });
    } finally {
      partial(text, true);
    }
    stage('generation completed');
    return { text, loadMs, firstTokenMs: tFirst, genMs: now() - tGen, tokens, promptTokens };
  };
  try {
    await finishRun(generate, prompts, maxNew, x);
  } finally {
    try {
      stage('model unloading');
      await model.dispose?.();
    } catch (e) {
      log(`dispose failed: ${e?.message ?? e}`);
    }
  }
}

async function runWebLLM(x, prompts, maxNew) {
  stage('runtime initialization');
  log(`Importing WebLLM ${WEBLLM_VERSION} from jsDelivr`);
  const W = await import(`https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`);
  const rec = W.prebuiltAppConfig.model_list.find((m) => m.model_id === x.modelId);
  if (!rec) throw new Error(`WebLLM ${WEBLLM_VERSION} has no prebuilt entry for ${x.modelId}`);
  // WebLLM stores files with Cache.add, whose error names no file; say which one failed
  const add = Cache.prototype.add;
  Cache.prototype.add = async function (req) {
    try {
      return await add.call(this, req);
    } catch (e) {
      log(`  Cache.add failed for ${req?.url ?? req}: ${e?.message ?? e}`);
      throw e;
    }
  };
  log(`Model ${rec.model}`);
  log(`Compiled library ${rec.model_lib}`);
  log(`Needs about ${Math.round(rec.vram_required_MB)} MB of GPU memory${rec.required_features ? `; features: ${rec.required_features.join(', ')}` : ''}`);
  const gpu = await navigator.gpu?.requestAdapter();
  log(`WebGPU adapter: ${gpu ? gpu.info?.description || 'present' : 'NOT AVAILABLE'}; shader-f16: ${gpu?.features?.has('shader-f16') ?? 'unknown'}`);

  stage('model download / cache access');
  const t0 = now();
  let lastShown = '';
  const engine = new W.MLCEngine({
    appConfig: { ...W.prebuiltAppConfig, cacheBackend: 'indexeddb' }, // the Cache API path failed on one shard here without saying why
    initProgressCallback: (p) => {
      const line = p.text.replace(/\s+/g, ' ').slice(0, 140);
      const key = line.replace(/\d+(\.\d+)?/g, '#');
      if (/load|fetch|cach/i.test(p.text)) stage('model loading');
      if (key !== lastShown || p.progress >= 1) log(`  ${line}`);
      lastShown = key;
    },
  });
  await engine.reload(x.modelId, { temperature: 0, top_p: 1, max_tokens: MAX_NEW, ...x.chatOpts });
  const loadMs = now() - t0;
  stage('model ready');
  log(`Model loaded in ${(loadMs / 1000).toFixed(1)}s`);

  const generate = async (prompt, maxNew) => {
    stage('prompt submitted');
    let text = '';
    let tFirst = null;
    let usage = null;
    const tGen = now();
    const chunks = await engine.chat.completions.create({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: maxNew,
      stream: true,
      stream_options: { include_usage: true },
      ...(x.noThink ? { extra_body: { enable_thinking: false } } : {}),
    });
    try {
      for await (const c of chunks) {
        const d = c.choices[0]?.delta?.content;
        if (d) {
          if (tFirst === null) {
            tFirst = now() - tGen;
            stage('first token received');
            log(`First token after ${(tFirst / 1000).toFixed(1)}s`);
          }
          text += d;
          partial(text);
        }
        if (c.usage) usage = c.usage;
      }
    } finally {
      partial(text, true);
    }
    stage('generation completed');
    return { text, loadMs, firstTokenMs: tFirst, genMs: now() - tGen, tokens: usage?.completion_tokens ?? null, promptTokens: usage?.prompt_tokens ?? null };
  };
  try {
    await finishRun(generate, prompts, maxNew, x);
  } finally {
    try {
      stage('model unloading');
      await engine.unload();
    } catch (e) {
      log(`unload failed: ${e?.message ?? e}`);
    }
  }
}

// Runs each prompt in turn on the loaded model. The lab page sends none (one shared prompt); tools/lab-eval.local.mjs sends several.
async function finishRun(generate, prompts, maxNew, x) {
  const results = [];
  for (const [i, p] of prompts.entries()) {
    const budget = (typeof p === 'object' && p.maxNew) || maxNew;
    const r = await generate(typeof p === 'string' ? p : p.text, x.thinking ? Math.max(budget, THINKING_NEW) : budget);
    results.push(r);
    post({ type: 'answer', i, result: r }); // kept even if a later prompt fails
  }
  post({ type: 'done', result: results[0], results });
}

self.addEventListener('message', async (e) => {
  if (e.data?.type !== 'run') return;
  const x = EXPERIMENTS.find((v) => v.n === e.data.n);
  try {
    const prompts = e.data.prompts?.length ? e.data.prompts : [PROMPT];
    const maxNew = e.data.maxNew || MAX_NEW;
    await (x.kind === 'webllm' ? runWebLLM(x, prompts, maxNew) : runTjs(x, e.data.dtype || x.dtype, prompts, maxNew));
  } catch (err) {
    post({ type: 'fail', message: String(err?.message ?? err), stack: String(err?.stack ?? '') });
  }
});
self.addEventListener('error', (e) => post({ type: 'log', msg: `Worker error: ${e.message} (${e.filename}:${e.lineno})` }));
self.addEventListener('unhandledrejection', (e) => post({ type: 'log', msg: `Unhandled rejection: ${e.reason?.message ?? e.reason}` }));
post({ type: 'log', msg: 'Worker started' });

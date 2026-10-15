// Pure logic for the on-device AI: the catalog of downloadable packages, text chunking, keyword
// (BM25) and meaning (vector) search, prompts, and descriptions. No DOM, no storage: tested in test/.

const HF = 'https://huggingface.co';
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
const TJS_VERSION = '4.3.0';
export const WEBLLM_VERSION = '0.2.86';

/**
 * Everything the AI can download. Each package is a set of files fetched once and kept in
 * IndexedDB. Revisions are pinned, so the files (and sizes below) never change underneath us.
 * `variants` are alternative weight files: q4f16 needs WebGPU with 16-bit floats, q4 runs anywhere.
 */
export const PACKAGES = {
  engine: {
    id: 'engine',
    kind: 'engine',
    name: 'AI engine',
    short: 'AI engine',
    role: `Transformers.js ${TJS_VERSION} and ONNX Runtime Web. Downloaded with the first model; every model needs it.`,
    source: 'jsDelivr',
    wire: 5_900_000, // both files arrive compressed (brotli)
    files: [
      {
        path: 'transformers.min.js',
        url: `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${TJS_VERSION}/dist/transformers.min.js`,
        size: 581_935,
        sha256: '1475fd440e9932ab206682ee42cb18f6097403e9ee77ea62084c592d0f83597d',
      },
      {
        path: 'ort-wasm-simd-threaded.asyncify.wasm',
        url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`,
        size: 26_861_777,
        sha256: '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082',
      },
    ],
  },
  webllm: {
    id: 'webllm',
    kind: 'engine',
    name: 'WebLLM engine',
    short: 'WebLLM engine',
    role: `WebLLM ${WEBLLM_VERSION} (MLC), which runs the Llama model on WebGPU. Downloaded with that model; kept in this app's own files.`,
    source: 'this app',
    wire: 2_200_000,
    files: [
      {
        path: 'web-llm.js',
        url: new URL(`../vendor/web-llm-${WEBLLM_VERSION}.js`, import.meta.url).href,
        size: 6_178_213,
        sha256: '6abd753a15136ea1498868208b7e3530ea3e086252fd8f89f40ab33a1ed834aa',
      },
    ],
  },
  lfm350: {
    id: 'lfm350',
    kind: 'chat',
    name: 'LFM2.5 350M Instruct',
    short: 'LFM2.5 350M',
    role: 'Small and quick: short summaries and answers from your saved pages. Needs WebGPU.',
    repo: 'LiquidAI/LFM2.5-350M-ONNX',
    revision: 'd11593fd9eb408e322667926656598896c2d5ff9',
    license: 'LFM Open License 1.0',
    common: [
      ['config.json', 1443],
      ['generation_config.json', 136],
      ['tokenizer.json', 3_297_793],
      ['tokenizer_config.json', 3269],
      ['chat_template.jinja', 2553],
    ],
    variants: {
      q4f16: [
        ['onnx/model_q4f16.onnx', 182_827],
        ['onnx/model_q4f16.onnx_data', 254_965_760],
      ],
      q4: [
        ['onnx/model_q4.onnx', 183_442],
        ['onnx/model_q4.onnx_data', 293_629_952],
      ],
    },
    // The 8-bit export (model_quantized) has a 4-bit embedding (GatherBlockQuantized) that the CPU
    // backend cannot run: "Could not find an implementation". Tried and failed, so there is no CPU option.
    cpu: null,
    // Read from the exported graphs (see README, "What was measured"): this export takes a
    // `num_logits_to_keep` input, which Transformers.js sets to 1, so only the last position's
    // scores are computed, however long the prompt.
    graph: { vocab: 65_536, lastTokenLogits: true, logitsBytes: 4, logitsCast: false, kvBytesPerToken: 6 * 2 * 8 * 64 * 4 },
  },
  lfm230: {
    id: 'lfm230',
    kind: 'chat',
    name: 'LFM2.5 230M Instruct',
    short: 'LFM2.5 230M',
    role: 'Smallest: the lowest-memory choice. Needs WebGPU.',
    repo: 'LiquidAI/LFM2.5-230M-ONNX',
    revision: 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d',
    license: 'LFM Open License 1.0',
    common: [
      ['config.json', 1668],
      ['generation_config.json', 131],
      ['tokenizer.json', 4_733_389],
      ['tokenizer_config.json', 5347],
      ['chat_template.jinja', 4621],
    ],
    variants: {
      q4: [
        ['onnx/model_q4.onnx', 154_010],
        ['onnx/model_q4.onnx_data', 211_111_936],
      ],
    },
    cpu: null, // the model card lists Q8 and Q4F32 for servers only
    // This export has no `num_logits_to_keep`: scores for every prompt position (full sequence).
    graph: { vocab: 65_536, lastTokenLogits: false, logitsBytes: 4, logitsCast: false, kvBytesPerToken: 6 * 2 * 8 * 64 * 4 },
  },
  bge: {
    id: 'bge',
    kind: 'embed',
    name: 'BGE small (English)',
    short: 'BGE small',
    role: 'Finds saved passages by meaning, not just matching words. Runs on the CPU.',
    repo: 'Xenova/bge-small-en-v1.5',
    revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
    license: 'MIT',
    common: [
      ['config.json', 683],
      ['tokenizer.json', 711_396],
      ['tokenizer_config.json', 366],
      ['special_tokens_map.json', 125],
      ['vocab.txt', 231_508],
    ],
    variants: { q8: [['onnx/model_quantized.onnx', 34_014_426]] },
    cpu: 'q8',
  },
  // Runs on WebLLM, not Transformers.js. WebLLM downloads and keeps the model files itself (its own IndexedDB
  // store, ~700 MB), so there are no per-file entries here; `size` is the download. The weights are not pinned
  // to a revision (WebLLM always asks for the latest), so `revision` names the library version instead.
  llama32: {
    id: 'llama32',
    kind: 'chat',
    runtime: 'webllm',
    needs: 'webllm',
    name: 'Llama 3.2 1B Instruct',
    short: 'Llama 3.2 1B',
    role: 'The best answers of the small models tried, through WebLLM. Needs WebGPU with 16-bit floats.',
    modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    dtype: 'q4f16_1',
    size: 704_522_448 + 6_099_798, // weights + the compiled GPU library, from Hugging Face and GitHub
    revision: `webllm-${WEBLLM_VERSION}`,
    license: 'Llama 3.2 Community License',
    source: 'Hugging Face and GitHub, through WebLLM',
    contextWindow: 2048, // tokens of conversation WebLLM reserves memory for
    // 16 layers × 8 key/value heads × 64 values × 2 (keys and values) × 2 bytes (16-bit) per token
    graph: { vocab: 128_256, lastTokenLogits: true, logitsBytes: 4, logitsCast: false, kvBytesPerToken: 16 * 8 * 64 * 2 * 2 },
  },
};

export const MODEL_IDS = ['lfm350', 'lfm230', 'llama32', 'bge'];
/** Models that were offered before and are gone: their files are deleted at startup to give the space back. */
export const RETIRED_IDS = ['lfm12', 'lfm26'];
/** Packages that hold only an engine (code), not a model. */
export const ENGINE_IDS = ['engine', 'webllm'];
export const CHAT_IDS = MODEL_IDS.filter((id) => PACKAGES[id].kind === 'chat');

/**
 * Which weights and backend suit this device. `gpu` is the WebGPU probe ({ f16 }) or null.
 * Chat models: q4f16 on WebGPU with shader-f16, q4 on WebGPU without it, and on the CPU the
 * package's `cpu` export, if it has one ({ dtype: null } means it can't run here).
 * BGE always runs on the CPU (WASM): it is small, and it leaves GPU memory to the chat model.
 */
export function pickVariant(pkg, gpu) {
  if (pkg.kind === 'engine') return { dtype: null, device: null };
  // WebLLM's build is 16-bit only: without shader-f16 there is nothing to run
  if (pkg.runtime === 'webllm') return gpu?.f16 ? { dtype: pkg.dtype, device: 'webgpu' } : { dtype: null, device: null };
  if (pkg.kind === 'embed') return { dtype: 'q8', device: 'wasm' };
  if (gpu) {
    const dtype = [gpu.f16 ? 'q4f16' : null, 'q4'].find((d) => d && pkg.variants[d]) ?? null;
    return { dtype, device: dtype ? 'webgpu' : null };
  }
  return { dtype: pkg.cpu, device: pkg.cpu ? 'wasm' : null };
}

/**
 * Characters of page or saved text that fit a prompt of `maxPrompt` tokens, after `overhead` tokens
 * of instructions and chat template. English runs about 3–4 characters a token, but names, numbers
 * and markup run denser, so this assumes 2.8. It only sizes the text: the engine counts the real
 * tokens with the model's tokenizer and refuses (or trims) anything over the limit.
 */
export const textBudget = (maxPrompt, overhead = 90) => Math.max(200, Math.round((maxPrompt - overhead) * 2.8));

/** Changes whenever the AI files change shape; the page and the worker compare it to catch a half-updated app. */
export const AI_BUILD = '2026-10-15.3';

/** How many external weight files a variant has (Transformers.js must be told for some exports). */
export const dataChunks = (pkg, dtype) => (pkg.variants?.[dtype] ?? []).filter(([path]) => /\.onnx_data(_\d+)?$/.test(path)).length;

/** The files to download for a package and variant: [{ path, size, url, resume, sha256? }]. */
export function filesFor(pkg, dtype) {
  if (pkg.kind === 'engine') return pkg.files.map((f) => ({ ...f, resume: false }));
  // WebLLM keeps its own files: one stand-in entry so sizes and progress add up
  if (pkg.runtime === 'webllm') return [{ path: pkg.modelId, size: pkg.size, url: null, resume: false }];
  const list = [...pkg.common, ...(pkg.variants[dtype] ?? [])];
  return list.map(([path, size]) => ({ path, size, url: fileUrl(pkg, path), resume: size > 8 * 1024 * 1024 }));
}

export const fileUrl = (pkg, path) => `${HF}/${pkg.repo}/resolve/${pkg.revision}/${path}`;
export const totalSize = (files) => files.reduce((n, f) => n + f.size, 0);

/** Splits a Transformers.js cache key (a Hugging Face URL) into its package and file, or null. */
export function parseModelUrl(url) {
  const m = /^https:\/\/huggingface\.co\/(.+?)\/resolve\/([^/]+)\/(.+)$/.exec(String(url));
  if (!m) return null;
  const pkg = Object.values(PACKAGES).find((p) => p.repo === m[1]);
  return { repo: m[1], revision: decodeURIComponent(m[2]), path: decodeURIComponent(m[3]), pkg: pkg?.id ?? null, pinned: pkg?.revision === decodeURIComponent(m[2]) };
}

/** 1.2 GB, 760 MB, 34 MB… (lib.js formatBytes stops at MB). */
export function size(n) {
  if (n == null || Number.isNaN(n)) return '?';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

export function eta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return 'under a minute';
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min`;
  return `about ${(seconds / 3600).toFixed(1)} h`;
}

// ---------- text ----------

/** Markdown (from Jina Reader) to plain text: links keep their words, images and markup go. */
export function markdownToText(md) {
  return String(md ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\|?[-:| ]{3,}\|?\s*$/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`~]{1,3}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Cuts text to at most `max` characters, at a sentence end when there is one nearby. */
export function trimText(text, max) {
  if (text.length <= max) return { text, cut: false, of: text.length };
  const slice = text.slice(0, max);
  const end = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'), slice.lastIndexOf('\n\n'));
  return { text: end > max * 0.7 ? slice.slice(0, end + 1) : slice, cut: true, of: text.length };
}

/** Splits text into passages of at most about `size` characters along paragraphs, then sentences. */
export function passages(text, size = 700) {
  const units = [];
  for (const para of String(text).split(/\n\s*\n/)) {
    const p = para.trim();
    if (!p) continue;
    if (p.length <= size) units.push(p);
    else
      for (const s of p.match(/[^.!?]+(?:[.!?]+|$)\s*/g) ?? [p])
        for (let i = 0; i < s.length; i += size) units.push(s.slice(i, i + size).trim());
  }
  const out = [];
  let cur = '';
  for (const u of units) {
    if (cur && cur.length + u.length + 1 > size) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur} ${u}` : u;
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.length > 40);
}

const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have how i if in into is it its me my no not of on or our so than that the their them then there these they this to was we were what when where which who why will with would you your about after also any just more most only other over some such up very'.split(
    ' ',
  ),
);

/** Lowercased words without stop words, with a plural "s" removed. */
export function tokenize(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}

/** A BM25 index over a list of texts. */
export function bm25Index(texts) {
  const docs = texts.map((t) => {
    const tf = new Map();
    const words = tokenize(t);
    for (const w of words) tf.set(w, (tf.get(w) ?? 0) + 1);
    return { tf, len: words.length };
  });
  const df = new Map();
  for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((n, d) => n + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avg, n: docs.length };
}

/** Indices of the best keyword matches for `query`, best first: [{ i, score }]. */
export function bm25Search(index, query, limit = 20, k1 = 1.2, b = 0.75) {
  const terms = [...new Set(tokenize(query))];
  const scored = [];
  for (const [i, d] of index.docs.entries()) {
    let s = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const df = index.df.get(t);
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      s += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / (index.avg || 1)));
    }
    if (s > 0) scored.push({ i, score: s });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, limit);
}

/** Dot product: cosine similarity for the normalised vectors BGE returns. */
export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Reciprocal rank fusion of several best-first lists of indices. Returns [{ i, score, from }]. */
export function fuse(lists, k = 60) {
  const out = new Map();
  for (const [name, list] of Object.entries(lists))
    for (const [rank, i] of list.entries()) {
      const e = out.get(i) ?? { i, score: 0, from: [] };
      e.score += 1 / (k + rank + 1);
      e.from.push(name);
      out.set(i, e);
    }
  return [...out.values()].sort((a, b) => b.score - a.score);
}

/** A short, stable hash of a string (FNV-1a), to notice when a passage's text changed. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ---------- prompts ----------

const SUM_RULES = 'Keep names, numbers and dates exactly. Use only the text. Do not add facts.';

/** `excerpted`: the text is key sentences picked from across the page, not all of it. */
export function summaryMessages(title, text, { excerpted = false } = {}) {
  return [
    {
      role: 'system',
      content: `Summarise this web page${excerpted ? ' (key sentences picked from across it)' : ''} in 3 to 5 short bullets, each starting with "- ", then one line starting with "In short:". ${SUM_RULES}`,
    },
    { role: 'user', content: `Page title: ${title}\n\nPage text:\n${text}` },
  ];
}

/** Notes on one part of a long page, to be combined by combineMessages. */
export function partMessages(title, text, i, n) {
  return [
    { role: 'system', content: `Take 2 or 3 short notes, each starting with "- ", on the main facts in this part of a web page. ${SUM_RULES}` },
    { role: 'user', content: `Page title: ${title}\nPart ${i} of ${n}:\n${text}` },
  ];
}

/** Turns the notes from every part into the final summary. */
export function combineMessages(title, notes) {
  return [
    {
      role: 'system',
      content: `Summarise this web page from notes on each part, in 3 to 5 short bullets starting with "- ", then one line starting with "In short:". ${SUM_RULES}`,
    },
    { role: 'user', content: `Page title: ${title}\n\nNotes:\n${notes.map((x, i) => `Part ${i + 1}:\n${x.trim()}`).join('\n\n')}` },
  ];
}

const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');

/** The label before each source: "[2] Title › Section (saved 2026-10-03)". */
export const sourceLabel = (s, i) =>
  `[${i + 1}] ${s.title}${s.heading ? ` › ${s.heading}` : ''}${s.kind === 'result' ? ` (search result for "${s.q}")` : s.at ? ` (saved ${day(s.at)})` : ''}`;

/** The question comes first and the sources last, so a prompt that must be shortened loses only source text. */
export function answerMessages(question, sources) {
  const list = sources.map((s, i) => `${sourceLabel(s, i)}\n${s.text}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'Answer using only the numbered sources. Cite the ones you use like [2]. If they do not contain the answer, say the saved pages do not answer it. Be brief.',
    },
    { role: 'user', content: `Question: ${question}\n\nSources:\n${list}` },
  ];
}

export function generalMessages(question) {
  return [
    {
      role: 'system',
      content:
        'You are a small AI model running offline on a phone, with no internet access. Answer briefly and plainly. If you are not sure, say so instead of guessing.',
    },
    { role: 'user', content: question },
  ];
}

/** "142 words-pieces in 9.3 s (15 per second), first after 2.1 s, prompt 812 tokens" */
export function describeRun(s) {
  if (!s) return '';
  const secs = (s.ms / 1000).toFixed(1);
  const rate = s.tokens && s.ms ? (s.tokens / ((s.ms - (s.ttft ?? 0)) / 1000 || 1)).toFixed(1) : '?';
  return [
    `${s.tokens} tokens in ${secs} s (${rate}/s)`,
    s.ttft != null ? `first after ${(s.ttft / 1000).toFixed(1)} s` : null,
    s.promptTokens ? `prompt ${s.promptTokens} tokens` : null,
    s.stopped ? 'stopped early' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Bullet lines ("- x", "• x", "* x") become list items; everything else stays a paragraph. */
export function splitAnswer(text) {
  const blocks = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^(?:[-•*]|\d+[.)])\s+(.*)$/.exec(t);
    if (m) {
      const last = blocks[blocks.length - 1];
      if (last?.type === 'list') last.items.push(m[1]);
      else blocks.push({ type: 'list', items: [m[1]] });
    } else blocks.push({ type: 'p', text: t });
  }
  return blocks;
}

/** Splits "text [1] more [2,3]" into text and citation parts: [{ text } | { cite: n }]. */
export function citations(text) {
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    for (const n of m[1].split(',')) out.push({ cite: Number(n.trim()) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** What a crash marker left by the last launch most likely means. */
export function crashText(m) {
  const what = { load: 'loading', generate: 'writing with', embed: 'indexing with' }[m.what] ?? m.what;
  return `The app stopped while ${what} ${PACKAGES[m.pkg]?.short ?? m.pkg}${m.detail ? ` (${m.detail})` : ''}. It was closed, or iOS ended it, most often for using too much memory.`;
}

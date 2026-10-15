// Pure logic for the on-device AI: the catalog of downloadable packages, text chunking, keyword
// (BM25) and meaning (vector) search, prompts, and descriptions. No DOM, no storage: tested in test/.

const HF = 'https://huggingface.co';
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
const TJS_VERSION = '4.3.0';

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
  lfm12: {
    id: 'lfm12',
    kind: 'chat',
    name: 'LFM2.5 1.2B Instruct',
    short: 'LFM2.5 1.2B',
    role: 'Primary AI: summarises pages and answers questions, from your saved pages or on its own.',
    repo: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    revision: '10f72e70abf67ac0fd7ebf15bc5854726891d864',
    license: 'LFM Open License 1.0',
    common: [
      ['config.json', 1599],
      ['generation_config.json', 131],
      ['tokenizer.json', 3_297_799],
      ['tokenizer_config.json', 2391],
      ['chat_template.jinja', 1783],
    ],
    variants: {
      q4f16: [
        ['onnx/model_q4f16.onnx', 182_795],
        ['onnx/model_q4f16.onnx_data', 760_279_040],
      ],
      q4: [
        ['onnx/model_q4.onnx', 183_173],
        ['onnx/model_q4.onnx_data', 850_059_264],
      ],
      q8: [
        ['onnx/model_quantized.onnx', 185_703],
        ['onnx/model_quantized.onnx_data', 1_520_558_080],
      ],
    },
    cpu: 'q8', // the q4 exports use GatherBlockQuantized, which only the WebGPU backend implements
    // Prompts stay short: the export computes scores for its whole 65,536-word vocabulary at every
    // prompt position, so a 3,000-token prompt needs about 0.4–0.8 GB on top of the weights, which
    // made iOS end the app. Long pages are summarised in parts of `partChars` instead.
    maxInputChars: 12_000,
    partChars: 2_400,
    contextChars: 2_500,
  },
  bge: {
    id: 'bge',
    kind: 'embed',
    name: 'BGE small (English)',
    short: 'BGE small',
    role: 'Context retrieval: finds saved passages by meaning, not just matching words. Runs on the CPU.',
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
  lfm26: {
    id: 'lfm26',
    kind: 'chat',
    experimental: true,
    name: 'LFM2.5 2.6B (experimental)',
    short: 'LFM2.5 2.6B',
    role: 'Higher quality for longer summaries, comparisons and synthesis. Too big for an iPhone: on a test iPhone, iOS ended the app while loading it. For computers and large tablets.',
    repo: 'LiquidAI/LFM2.5-2.6B-ONNX',
    revision: '66826372fd4fa166f53be0371c9315745c07cace',
    license: 'LFM Open License 1.0',
    common: [
      ['config.json', 1728],
      ['generation_config.json', 146],
      ['tokenizer.json', 17_905_598],
      ['tokenizer_config.json', 6063],
      ['chat_template.jinja', 5404],
    ],
    variants: {
      q4f16: [
        ['onnx/model_q4f16.onnx', 222_160],
        ['onnx/model_q4f16.onnx_data', 1_063_972_864],
        ['onnx/model_q4f16.onnx_data_1', 469_958_656],
      ],
      q4: [
        ['onnx/model_q4.onnx', 315_101],
        ['onnx/model_q4.onnx_data', 1_854_562_304],
      ],
    },
    cpu: null, // no export of this model runs on the CPU backend (its 8-bit one is 3.9 GB)
    maxInputChars: 12_000,
    partChars: 2_400,
    contextChars: 2_500,
  },
};

export const MODEL_IDS = ['lfm12', 'bge', 'lfm26'];
export const CHAT_IDS = MODEL_IDS.filter((id) => PACKAGES[id].kind === 'chat');

/**
 * Which weights and backend suit this device. `gpu` is the WebGPU probe ({ f16 }) or null.
 * Chat models: q4f16 on WebGPU with shader-f16, q4 on WebGPU without it, and on the CPU the
 * package's `cpu` export, if it has one ({ dtype: null } means it can't run here).
 * BGE always runs on the CPU (WASM): it is small, and it leaves GPU memory to the chat model.
 */
export function pickVariant(pkg, gpu) {
  if (pkg.kind === 'engine') return { dtype: null, device: null };
  if (pkg.kind === 'embed') return { dtype: 'q8', device: 'wasm' };
  if (gpu) return { dtype: gpu.f16 ? 'q4f16' : 'q4', device: 'webgpu' };
  return { dtype: pkg.cpu, device: pkg.cpu ? 'wasm' : null };
}

/** Prompt-size limits to choose from. On a test iPhone, 338-token prompts worked and ~650 ended the app. */
export const PROMPT_LIMITS = [300, 450, 600, 900, 2000];

/**
 * Characters of page or saved text that fit a prompt of `maxPrompt` tokens. English runs about
 * 3–4 characters a token, but names, numbers and markup run denser, so this assumes 2.8, less
 * 130 tokens of instructions. Summary parts are also trimmed to fit by the engine, which counts exactly.
 */
export const textBudget = (maxPrompt) => Math.max(300, Math.round((maxPrompt - 130) * 2.8));

/** How many part-notes (about 60 tokens each) the final summary prompt can hold. */
export const maxParts = (maxPrompt) => Math.max(2, Math.floor((maxPrompt - 110) / 60));

/** How many external weight files a variant has (Transformers.js must be told for some exports). */
export const dataChunks = (pkg, dtype) => (pkg.variants?.[dtype] ?? []).filter(([path]) => /\.onnx_data(_\d+)?$/.test(path)).length;

/** The files to download for a package and variant: [{ path, size, url, resume, sha256? }]. */
export function filesFor(pkg, dtype) {
  if (pkg.kind === 'engine') return pkg.files.map((f) => ({ ...f, resume: false }));
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

const snippetText = (snippet) => (Array.isArray(snippet) ? snippet.map((s) => s.text).join('') : String(snippet ?? ''));

/**
 * Everything on the device that questions can be answered from, as passages:
 * pages read in the reader (split into passages) and search results (title + snippet).
 * `results` and `pages` are [key, record] pairs from store.js.
 */
export function collectPassages(results, pages, { perPage = 40 } = {}) {
  const out = [];
  for (const [, p] of pages) {
    if (!p?.url || !p.markdown) continue;
    const title = p.title || p.url;
    const chunks = passages(markdownToText(p.markdown)).slice(0, perPage);
    for (const [i, text] of chunks.entries())
      out.push({ id: `p|${p.url}|${i}`, kind: 'page', url: p.url, title, text, at: p.at, saved: !!p.saved });
  }
  const seen = new Set();
  const recs = results.map(([, r]) => r).filter((r) => Array.isArray(r?.results) && r.q).sort((a, b) => b.at - a.at);
  for (const r of recs) {
    if (r.instant?.text && !seen.has(`i|${r.q}`)) {
      seen.add(`i|${r.q}`);
      out.push({ id: `i|${r.q.toLowerCase()}`, kind: 'instant', url: r.instant.url ?? null, title: r.instant.heading || r.q, text: r.instant.text, q: r.q, at: r.at });
    }
    for (const x of r.results) {
      if (!x?.url || seen.has(x.url)) continue;
      seen.add(x.url);
      const text = `${x.title}. ${snippetText(x.snippet)}`.trim();
      if (text.length > 20) out.push({ id: `r|${x.url}`, kind: 'result', url: x.url, title: x.title || x.url, text, q: r.q, at: r.at });
    }
  }
  return out;
}

/** Picks fused passages up to a character budget, at most `max`, at most 3 from one page. */
export function pickContext(ranked, all, budget, max = 6) {
  const picked = [];
  const perUrl = new Map();
  let used = 0;
  for (const r of ranked) {
    const p = all[r.i];
    if ((perUrl.get(p.url) ?? 0) >= 3) continue;
    if (used + p.text.length > budget && picked.length) continue;
    picked.push({ ...p, from: r.from });
    perUrl.set(p.url, (perUrl.get(p.url) ?? 0) + 1);
    used += p.text.length;
    if (picked.length >= max) break;
  }
  return picked;
}

// ---------- prompts ----------

export function summaryMessages(title, text) {
  return [
    {
      role: 'system',
      content:
        'You summarise web pages for someone reading on a phone. Write 3 to 5 short bullet points, each starting with "- ", covering the main points. Then one line starting with "In short:". Use only the page text. Do not add facts.',
    },
    { role: 'user', content: `Page title: ${title}\n\nPage text:\n${text}` },
  ];
}

/** Notes on one part of a long page, to be combined by combineMessages. */
export function partMessages(title, text, i, n) {
  return [
    {
      role: 'system',
      content: 'You take brief notes on part of a web page. Write 2 or 3 short bullet points, each starting with "- ", with the main facts in this part. Use only the text given.',
    },
    { role: 'user', content: `Page title: ${title}\nPart ${i} of ${n}:\n${text}` },
  ];
}

/** Turns the notes from every part into the final summary. */
export function combineMessages(title, notes) {
  return [
    {
      role: 'system',
      content:
        'You summarise web pages for someone reading on a phone, from notes on each part of the page. Write 3 to 5 short bullet points, each starting with "- ", covering the main points of the whole page. Then one line starting with "In short:". Use only the notes.',
    },
    { role: 'user', content: `Page title: ${title}\n\nNotes:\n${notes.map((x, i) => `Part ${i + 1}:\n${x.trim()}`).join('\n\n')}` },
  ];
}

export function answerMessages(question, sources) {
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title}${s.kind === 'result' ? ` (search result for "${s.q}")` : ''}\n${s.text}`)
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        'Answer the question using only the numbered sources. Cite the sources you use in square brackets, like [2]. If the sources do not contain the answer, say that the saved pages do not answer it. Keep the answer short.',
    },
    { role: 'user', content: `Sources:\n${list}\n\nQuestion: ${question}` },
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

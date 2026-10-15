import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../js/ai-lib.js';

const P = A.PACKAGES;

test('catalog: pinned files, variants and sizes', () => {
  assert.deepEqual(A.MODEL_IDS, ['lfm350', 'lfm230', 'lfm12', 'bge', 'lfm26']);
  assert.deepEqual(A.CHAT_IDS, ['lfm350', 'lfm230', 'lfm12', 'lfm26']);
  for (const id of A.MODEL_IDS) {
    assert.match(P[id].revision, /^[0-9a-f]{40}$/, `${id} is pinned to a commit`);
    for (const dtype of Object.keys(P[id].variants)) {
      const files = A.filesFor(P[id], dtype);
      assert.ok(files.some((f) => f.path === 'config.json'));
      assert.ok(files.some((f) => f.path.startsWith('onnx/')));
      for (const f of files) assert.equal(f.url, `https://huggingface.co/${P[id].repo}/resolve/${P[id].revision}/${f.path}`);
    }
  }
  // the weights only resume when they're big; small JSON files restart
  const lfm = A.filesFor(P.lfm12, 'q4f16');
  assert.equal(lfm.find((f) => f.path === 'config.json').resume, false);
  assert.equal(lfm.find((f) => f.path === 'onnx/model_q4f16.onnx_data').resume, true);
  assert.equal(Math.round(A.totalSize(lfm) / 1e6), 764);
  assert.equal(Math.round(A.totalSize(A.filesFor(P.lfm350, 'q4f16')) / 1e6), 258);
  assert.equal(Math.round(A.totalSize(A.filesFor(P.lfm230, 'q4')) / 1e6), 216);
  // the 2.6B q4f16 weights come in two parts, as its config says
  assert.deepEqual(
    A.filesFor(P.lfm26, 'q4f16')
      .filter((f) => f.path.includes('_data'))
      .map((f) => f.path),
    ['onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1'],
  );
  const engine = A.filesFor(P.engine);
  assert.equal(engine.length, 2);
  for (const f of engine) assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test('pickVariant matches weights to the device', () => {
  assert.deepEqual(A.pickVariant(P.lfm12, { f16: true }), { dtype: 'q4f16', device: 'webgpu' });
  assert.deepEqual(A.pickVariant(P.lfm12, { f16: false }), { dtype: 'q4', device: 'webgpu' });
  assert.deepEqual(A.pickVariant(P.lfm12, null), { dtype: 'q8', device: 'wasm' }); // q4 needs WebGPU
  assert.deepEqual(A.pickVariant(P.lfm26, null), { dtype: null, device: null }); // no CPU export
  assert.deepEqual(A.pickVariant(P.lfm350, null), { dtype: null, device: null }); // its 8-bit export fails on the CPU backend
  assert.deepEqual(A.pickVariant(P.lfm230, { f16: true }), { dtype: 'q4', device: 'webgpu' }); // no q4f16 export of the 230M
  assert.deepEqual(A.pickVariant(P.lfm230, null), { dtype: null, device: null });
  assert.equal(A.dataChunks(P.lfm26, 'q4f16'), 2);
  assert.equal(A.dataChunks(P.lfm12, 'q8'), 1);
  assert.equal(A.dataChunks(P.bge, 'q8'), 0);
  assert.deepEqual(A.pickVariant(P.bge, { f16: true }), { dtype: 'q8', device: 'wasm' }); // BGE stays on the CPU
});

test('parseModelUrl finds the package behind a Transformers.js cache key', () => {
  const u = A.fileUrl(P.lfm12, 'onnx/model_q4f16.onnx_data');
  assert.deepEqual(A.parseModelUrl(u), { repo: P.lfm12.repo, revision: P.lfm12.revision, path: 'onnx/model_q4f16.onnx_data', pkg: 'lfm12', pinned: true });
  assert.equal(A.parseModelUrl(`https://huggingface.co/${P.bge.repo}/resolve/main/config.json`).pinned, false);
  assert.equal(A.parseModelUrl('https://huggingface.co/someone/else/resolve/main/x.json').pkg, null);
  assert.equal(A.parseModelUrl('/models/x/config.json'), null);
});

test('size and eta', () => {
  assert.equal(A.size(760_279_040), '760 MB');
  assert.equal(A.size(1_534_000_000), '1.53 GB');
  assert.equal(A.size(34_014), '34 KB');
  assert.equal(A.eta(30), 'under a minute');
  assert.equal(A.eta(600), 'about 10 min');
  assert.equal(A.eta(NaN), '');
});

test('markdownToText and trimText', () => {
  const md = '# Title\n\nSome **bold** [link](https://x.example) text.\n\n![img](a.png)\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const t = A.markdownToText(md);
  assert.ok(t.startsWith('Title\n\nSome bold link text.'));
  assert.ok(t.includes('• one'));
  assert.ok(!t.includes('https://') && !t.includes('**') && !t.includes('---'));
  const long = 'First sentence here. '.repeat(100);
  const cut = A.trimText(long, 500);
  assert.equal(cut.cut, true);
  assert.ok(cut.text.length <= 500 && cut.text.endsWith('.'));
  assert.equal(A.trimText('short', 500).cut, false);
});

test('passages split along paragraphs, then sentences', () => {
  const para = (n) => `Paragraph ${n} talks about something specific in a full sentence.`;
  const text = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(para).join('\n\n');
  const ps = A.passages(text, 200);
  assert.ok(ps.length >= 3);
  for (const p of ps) assert.ok(p.length <= 200, p.length);
  assert.ok(ps[0].startsWith('Paragraph 1'));
  // one enormous paragraph with no full stops is still split
  const blob = A.passages('word '.repeat(1000), 300);
  assert.ok(blob.length >= 15 && blob.every((p) => p.length <= 300));
});

test('BM25 ranks the passage that matches the question', () => {
  const docs = ['Focaccia is a flat oven-baked Italian bread.', 'The weather in Leeds is often rainy.', 'Bread recipes need flour, water and yeast.'];
  const idx = A.bm25Index(docs);
  const hits = A.bm25Search(idx, 'What is focaccia bread?');
  assert.equal(hits[0].i, 0);
  assert.ok(!hits.some((x) => x.i === 1));
  assert.deepEqual(A.tokenize('The cats were running'), ['cat', 'running']);
});

test('fuse', () => {
  const fused = A.fuse({ words: [2, 0, 1], meaning: [0, 3] });
  assert.equal(fused[0].i, 0); // in both lists
  assert.deepEqual(fused[0].from, ['words', 'meaning']);
  assert.equal(A.dot([0.6, 0.8], [0.6, 0.8]).toFixed(2), '1.00');
});

test('prompts, answers and citations', () => {
  const msgs = A.answerMessages('Why?', [{ title: 'T', text: 'Because.', kind: 'result', q: 'why' }]);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('[1] T (search result for "why")\nBecause.'));
  // the question comes first and the sources last: a prompt cut at the end loses only sources
  assert.ok(msgs[1].content.startsWith('Question: Why?\n\nSources:\n'));
  assert.equal(A.summaryMessages('T', 'body')[1].content, 'Page title: T\n\nPage text:\nbody');
  assert.ok(A.summaryMessages('T', 'body', { excerpted: true })[0].content.includes('picked from across'));
  assert.equal(A.sourceLabel({ title: 'T', heading: 'Part', kind: 'page', at: Date.UTC(2026, 9, 3) }, 1), '[2] T › Part (saved 2026-10-03)');
  assert.deepEqual(A.splitAnswer('- one\n- two\nIn short: done'), [
    { type: 'list', items: ['one', 'two'] },
    { type: 'p', text: 'In short: done' },
  ]);
  assert.deepEqual(A.citations('Yes [1], and [2, 3].'), [{ text: 'Yes ' }, { cite: 1 }, { text: ', and ' }, { cite: 2 }, { cite: 3 }, { text: '.' }]);
  assert.equal(A.describeRun({ tokens: 100, ms: 6000, ttft: 1000, promptTokens: 500 }), '100 tokens in 6.0 s (20.0/s), first after 1.0 s, prompt 500 tokens');
  assert.ok(A.crashText({ what: 'load', pkg: 'lfm26' }).includes('loading LFM2.5 2.6B'));
  assert.equal(A.textBudget(300), 588);
  assert.ok(A.textBudget(60) >= 200);
  assert.equal(A.hash('abc'), A.hash('abc'));
  assert.notEqual(A.hash('abc'), A.hash('abd'));
});

// AI lab page (#/ai-lab): pick one of seven experiments, run the shared prompt in a fresh worker, watch the log.
// Experimental and independent of the app's AI (ai.js): own worker, own caches, own localStorage key.
import { EXPERIMENTS, PROMPT } from './ai-lab-config.js';

const KEY = 'sparse-lab';
const MAX_LINES = 400;
const BUILD = '2026-10-15.lab2';

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
};
const write = (s) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage full or blocked: the log on screen still works
  }
};

const clock = () => new Date().toTimeString().slice(0, 8);
const secs = (ms) => (ms == null ? 'unavailable' : `${(ms / 1000).toFixed(1)}s`);
const el = (tag, props, ...kids) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids.filter((k) => k != null));
  return e;
};

// One run at a time, and it survives leaving and re-entering the screen.
let run = null; // { s: persisted state, worker, t0, started }
let paint = () => {};

function save() {
  if (run) write(run.s);
}
function line(msg) {
  if (!run) return;
  run.s.lines.push([clock(), msg]);
  if (run.s.lines.length > MAX_LINES) run.s.lines.splice(0, run.s.lines.length - MAX_LINES);
  save();
  paint();
}
function stage(name) {
  if (!run || run.s.stage === name) return;
  run.s.prev = run.s.stage;
  run.s.stage = name; // persisted BEFORE the step runs, so a crash leaves it behind
  line(`[${name}]`);
}

function report(x, r) {
  const total = performance.now() - run.t0;
  const tps = r.tokens != null && r.genMs > 0 ? (r.tokens / (r.genMs / 1000)).toFixed(1) : 'unavailable';
  return [
    'ANSWER:',
    r.text.trim() || '(empty)',
    '',
    'RESULT: SUCCESS',
    `Model: ${x.repo ?? x.modelId}`,
    `Runtime: ${x.kind === 'webllm' ? 'WebLLM (MLC)' : 'Transformers.js + ONNX Runtime WebGPU'}`,
    `Model load: ${secs(r.loadMs)}`,
    `Time to first token: ${secs(r.firstTokenMs)}`,
    `Generation: ${secs(r.genMs)}`,
    `Prompt tokens: ${r.promptTokens ?? 'unavailable'}`,
    `Tokens generated: ${r.tokens ?? 'unavailable'}`,
    `Tokens/sec: ${tps}`,
    `Total time: ${secs(total)}`,
  ].join('\n');
}

function finish() {
  run.s.done = true;
  save();
  run.worker.terminate();
  run.worker = null;
  line('Worker terminated');
  run.wake?.release?.().catch(() => {});
  run.running = false;
  paint();
}

async function start(n) {
  if (run?.running) return;
  const x = EXPERIMENTS.find((e) => e.n === n);
  run = { s: { n, label: x.label, build: BUILD, startedAt: Date.now(), stage: 'test selected', done: false, lines: [], answer: '', final: '' }, running: true, t0: performance.now() };
  stage('test selected');
  line(`Experiment ${n}: ${x.label}`);
  line(`${navigator.userAgent}`);
  line(`Download is roughly ${x.mb} MB (cached after the first run)`);
  try {
    run.wake = await navigator.wakeLock?.request('screen');
  } catch {
    // not allowed here: carry on
  }
  const worker = new Worker(new URL(`./ai-lab-worker.js?b=${BUILD}`, import.meta.url), { type: 'module' });
  run.worker = worker;
  worker.addEventListener('message', (e) => {
    const m = e.data;
    if (!run || run.worker !== worker) return;
    if (m.type === 'stage') stage(m.name);
    else if (m.type === 'log') line(m.msg);
    else if (m.type === 'partial') {
      run.s.answer = m.text;
      paint();
    } else if (m.type === 'done') {
      run.s.final = report(x, m.result);
      line('Generation completed');
      finish();
    } else if (m.type === 'fail') {
      const elapsed = performance.now() - run.t0;
      run.s.final = [
        'RESULT: FAILED',
        `Experiment: ${n} (${x.label})`,
        `Failed during: ${run.s.stage}`,
        `Last completed stage: ${run.s.prev ?? 'none'}`,
        `Error: ${m.message}`,
        `Stack: ${m.stack || 'unavailable'}`,
        `Elapsed: ${secs(elapsed)}`,
        run.s.answer ? `\nPartial answer before the failure:\n${run.s.answer}` : '',
      ].join('\n');
      line(`FAILED during ${run.s.stage}: ${m.message}`);
      finish();
    }
  });
  worker.addEventListener('error', (e) => {
    if (!run || run.worker !== worker) return;
    run.s.final = `RESULT: FAILED\nFailed during: ${run.s.stage}\nThe worker could not run: ${e.message || 'unknown error'} (${e.filename || ''}:${e.lineno || ''})\nElapsed: ${secs(performance.now() - run.t0)}`;
    line(`Worker error: ${e.message}`);
    finish();
  });
  // optional, invisible: #/ai-lab?dtype=q4 runs the ONNX experiments with another quantization (q4, q4f16, fp16, q8…)
  const dtype = new URLSearchParams(location.hash.split('?')[1] ?? '').get('dtype') || null;
  if (dtype && x.kind === 'tjs') line(`dtype overridden to ${dtype} by the address`);
  worker.postMessage({ type: 'run', n, dtype });
}

document.addEventListener('visibilitychange', () => {
  if (run?.running) line(`Page ${document.visibilityState}`);
});

export function showLab(main, version = '') {
  document.title = 'AI lab · Sparse';
  const saved = read();
  // A run that never finished and isn't running in this page: the app was ended in the middle of it.
  const interrupted = !run && saved && !saved.done ? saved : null;
  if (interrupted) {
    interrupted.interrupted = true;
    interrupted.lines.push([clock(), `Previous experiment ${interrupted.n} interrupted during ${interrupted.stage}. No termination reason available.`]);
    interrupted.done = true;
    write(interrupted);
  }
  const view = () => run?.s ?? saved;
  const all = new URLSearchParams(location.hash.split('?')[1] ?? '').has('all');
  const shown = all ? EXPERIMENTS : EXPERIMENTS.filter((x) => x.phone);

  const select = el('select', { id: 'lab-exp' }, ...shown.map((x) => el('option', { value: String(x.n), textContent: `${x.n}. ${x.label}` })));
  select.value = String(shown.some((x) => x.n === view()?.n) ? view().n : shown[0].n);
  const button = el('button', { type: 'button', textContent: 'RUN TEST' });
  const out = el('pre', { className: 'lab-out' });
  out.style.cssText = 'white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:1.35;max-height:70vh;overflow:auto;border:1px solid #888;padding:8px;margin:8px 0';
  const warn = el('p', { className: 'small' });

  paint = () => {
    const s = view();
    button.disabled = !!run?.running;
    button.textContent = run?.running ? 'RUNNING…' : 'RUN TEST';
    if (!s) {
      out.textContent = 'No experiment has run yet.';
      return;
    }
    const parts = s.lines.map(([t, m]) => `${t}  ${m}`);
    if (s.answer && !s.final) parts.push('', 'ANSWER SO FAR:', s.answer);
    if (s.final) parts.push('', '-----------------------------------', s.final);
    out.textContent = parts.join('\n');
    out.scrollTop = out.scrollHeight;
  };
  button.addEventListener('click', () => start(Number(select.value)));
  warn.textContent = interrupted ? `Previous experiment ${interrupted.n} interrupted during ${interrupted.stage}. No termination reason available.` : '';

  main.replaceChildren(
    el('header', { className: 'bar' }, el('a', { href: '#/ai', className: 'brand', textContent: 'Sparse' }), el('span', { className: 'muted', textContent: 'AI lab' })),
    el('h1', { textContent: 'SPARSE — AI LAB' }),
    el('p', { className: 'small muted', textContent: `App v${version} · lab ${BUILD}` }),
    el('p', { className: 'small muted', textContent: 'Experimental. One shared prompt, no page context. A model may fail or iOS may end the app; the log is kept so you can see how far it got.' }),
    el('label', { htmlFor: 'lab-exp', textContent: 'Experiment:' }),
    el('div', null, select),
    el('div', null, button),
    warn,
    out,
    el('p', { className: 'small' }, el('a', { href: all ? '#/ai-lab' : '#/ai-lab?all', textContent: all ? 'Show only the iPhone set (3 models)' : `Show all ${EXPERIMENTS.length} experiments (desktop-sized models; may crash the app)` })),
    el('details', null, el('summary', { className: 'small', textContent: 'The shared prompt' }), el('pre', { className: 'small', textContent: PROMPT })),
  );
  paint();
}

// The AI runs here, off the page's thread, so the app stays responsive while a model works.
import { createEngine } from './ai-engine.js';
import { AI_BUILD } from './ai-lib.js';

const engine = createEngine((m) => self.postMessage(m));
self.addEventListener('message', (e) => engine.handle(e.data));
self.addEventListener('error', (e) => self.postMessage({ type: 'log', level: 'error', msg: `Worker error: ${e.message} (${e.filename}:${e.lineno})` }));
self.addEventListener('unhandledrejection', (e) =>
  self.postMessage({ type: 'log', level: 'error', msg: `Worker: unhandled ${e.reason?.name ?? 'error'}: ${e.reason?.message ?? e.reason}` }),
);
self.postMessage({ type: 'ready', build: AI_BUILD });

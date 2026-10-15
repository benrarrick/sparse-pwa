// App-shell service worker. The app opens from this cache instantly, and offline. After each
// launch it re-downloads the shell in the background and swaps it in only when every file
// arrived, so the next launch runs the new version. Requests to other sites are never touched.
const CACHE = 'sparse-shell';
const FILES = [
  './',
  './index.html',
  './style.css',
  './js/app.js',
  './js/lib.js',
  './js/net.js',
  './js/store.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

let lastRefresh = 0;

async function refresh() {
  if (Date.now() - lastRefresh < 10 * 60 * 1000) return;
  lastRefresh = Date.now();
  try {
    const responses = await Promise.all(FILES.map((f) => fetch(f, { cache: 'no-cache' })));
    if (responses.some((r) => !r.ok)) return;
    const cache = await caches.open(CACHE);
    await Promise.all(responses.map((r, i) => cache.put(FILES[i], r)));
  } catch {
    // Offline or a partial deploy: keep the current shell.
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    event.waitUntil(refresh());
    event.respondWith(caches.match('./index.html').then((r) => r ?? fetch(req)));
    return;
  }
  event.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r ?? fetch(req)));
});

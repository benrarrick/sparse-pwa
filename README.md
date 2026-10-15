# Sparse (static PWA)

A light search app for the iPhone home screen that needs **no server of its own**. It is plain HTML, CSS and JavaScript (about 60 KB uncompressed, no build step) that any static host can serve.

It works because every service it reads sends CORS headers, so a web page may call it directly:

| What | Service | Key |
|---|---|---|
| Web results | [Mwmbl](https://mwmbl.org) (default), [Marginalia](https://marginalia-search.com), [Mojeek](https://www.mojeek.com/services/search/web-search-api/) | Mojeek needs a paid key (about £1 per 1,000 searches) and **never runs automatically**: searches use the free engines, and a "Try Mojeek" button under the results re-runs that one search on Mojeek. Marginalia's shared `public` key is often busy. |
| Instant answers | DuckDuckGo Instant Answer API | none |
| Reader view | [Jina Reader](https://jina.ai/reader) (`r.jina.ai`) | optional: works without one at 20 pages a minute, but Jina refuses anonymous requests from some networks with a 401. A free key from jina.ai, pasted into Settings, fixes that. |
| Weather | Open-Meteo (forecast, place lookup, air quality) | none |
| Archived copies | Internet Archive availability lookup (`archive.org/wayback/available`) | none to find a copy; reading it in the app needs a Jina key, because Jina refuses anonymous requests for archive.org |
| On-device AI (optional) | Models from Hugging Face, the engine (Transformers.js 4.3.0, ONNX Runtime Web) from jsDelivr: downloaded once, only when you tap Download | none |

DuckDuckGo's own results pages can't be read by a web page. The app opens them instead: there's a "DuckDuckGo Lite ↗" link under every result list, and any query containing a `!bang` goes straight to DuckDuckGo.

## Features

- **Results:** title, address and snippet, about 4–8 KB per search. If the chosen engine fails or finds nothing, the next one is tried. An engine that failed is skipped for 5 minutes.
- **Reader view:** tapping a result opens the page as text through Jina Reader. Links inside it open in the reader too. "Open original ↗" opens the real site. A Wikipedia article arrives as about 28 KB.
- **Cards:** an instant-answer card (Wikipedia abstracts, definitions, simple answers) and a weather card for `weather`, `weather in Leeds` or `paris weather`.
- **Weather, basic by default:** temperature and what it feels like, rain in the next hour (15-minute steps), and 3 days, in about 0.5 KB. **More weather** on the card fetches the rest only when tapped, about 1.2 KB more: wind direction and gusts, humidity, cloud, visibility, pressure, UV, sunrise and sunset, air quality (US scale with °F, European otherwise), 24 hours (every 3 hours, or every hour with a tap) and 7 days. Both are kept on the device for 30 minutes. Settings can make the card always show everything.
- **Archived copies:** when the reader can't load a page, the app asks the Internet Archive (about 0.2 KB) for its latest copy and offers it. Every reader page also has an **Archived copy** button that only looks when tapped. With a Jina key the copy opens in the reader as text. Without one it opens in Safari, at full size. The archive's lookup sometimes misses copies, or refuses when asked too often, so a direct link to the archive is always offered as well.
- **On-device AI (optional, off until you download a model):** see below.
- **Offline:**
  - The app opens from the service worker cache.
  - Searches and pages are kept on the device (IndexedDB): results for 30 days, up to 300 searches; pages for 30 days, up to 100, unless you tap **Save for offline**.
  - A search or page asked for while offline is queued. It runs when the connection comes back, and then appears under "Ready" on the home screen.
- **Repeat searches:** a search repeated within 6 hours (configurable) loads from the device and uses no data.
- **Settings:** engine, keys, fallback, region, safe search, instant answers, what tapping a result opens, DuckDuckGo Lite or HTML, weather units.

## On-device AI

Open **Settings → On-device AI** (`#/ai`). Nothing downloads until you tap Download, every model can be removed again, and **the browser works fully without any of it**. After the download, everything runs on the device with no connection, and nothing you read or ask is sent anywhere.

The full write-up (safety policy, what was measured, observability guide, benchmarks, tests, a manual iPhone test plan, known limits) is in **[docs/ai.md](docs/ai.md)**. In short:

| Model | On a phone | Download |
|---|---|---|
| LFM2.5 350M Instruct | provisional, the default; WebGPU | 258 MB (q4f16) / 297 MB (q4) |
| LFM2.5 230M Instruct | provisional, the lowest-memory fallback; WebGPU | 216 MB |
| LFM2.5 1.2B Instruct | **experimental: off until you opt in** | 764 MB (q4f16), 854 MB (q4), 1.52 GB (CPU, computers) |
| Llama 3.2 1B Instruct (through WebLLM) | **experimental: off until you opt in**; WebGPU with 16-bit floats | 711 MB (kept by WebLLM) + 6 MB engine |
| LFM2.5 2.6B | **blocked** (iOS ended the app while loading it); computers, opt in | 1.53 GB |
| BGE small en v1.5 | finds saved passages by meaning; CPU | 35 MB |
| AI engine (Transformers.js 4.3.0, ONNX Runtime Web) | needed by all | 27 MB (about 6 MB on the wire) |

"Provisional" means conservative limits that have **not been proven on a real device**, not a claim of safety. Licences: LFM Open License 1.0 for the LFM models, Llama 3.2 Community License for Llama, MIT for BGE.

**What it does**
1. **Summarise** a reader page: sentences are picked from the whole page (not just its start), one pass when possible, a bounded number of notes plus a combine only when one pass would see too little. The card says how much of the page was read. Summaries are kept with the page, keyed by model, method and page text.
2. **Ask from saved pages and searches** (`#/ask`): keyword (BM25, updated incrementally) plus meaning (BGE) matching over every saved page, a hard evidence budget, cited answers `[1]`. **If no model may run** (not downloaded, switched off, no WebGPU), it shows the closest passages with their sources instead.
3. **Ask from the model's own knowledge**, labelled as possibly wrong.

**How it is kept from destabilising the app** (iOS can end a page that uses too much memory, with no error to catch)
- Each model has per-device **token budgets** (prompt, answer, and combined), counted exactly with the model's tokenizer, enforced inside the engine, and refused rather than risked. Ordinary settings can lower them, never raise them.
- **One operation at a time**: loads, embeddings, generations, unloads and resets queue in one scheduler, enforced again inside the worker. Stop is never queued. One model in memory at a time; BGE is released before a chat model loads.
- **Checkpoints** are written before each risky stage. A leftover one at the next launch is *classified* (backgrounded, closed, GPU lost, unexplained, repeated) rather than assumed to be an out-of-memory crash; an unexplained foreground interruption **switches that model setup off** until you retest it in developer mode.
- The AI stops if the app goes to the background; it never runs on the page itself on a phone; a half-updated app is detected.

**Diagnostics** (AI page): live status, last inference, performance medians, recent failures and recovery actions, safety profiles, the structured log, and **Copy report** / **Copy as JSON**. Reports hold ids, counts and timings, never page text or questions unless you tick the opt-in. See docs/ai.md for how to read one.

**Downloads** resume where they stopped (8 MB pieces in IndexedDB, HTTP Range, retries, wait for the connection), keep the screen on, check free storage first, pin revisions, check sizes, and verify the engine's SHA-256.

**Memory facts, briefly** (details and caveats in docs/ai.md)
- Read from the model files: the 350M and 2.6B exports score only the last prompt position; the 1.2B and 230M score every prompt position, which is why long prompts hurt the 1.2B (an estimated 125 MB at 300 tokens, 1.25 GB at 3,000, against 8 MB and 74 MB for the 350M).
- Observed on a test iPhone with the 1.2B: 338-token prompts worked, about 650 ended the app, and the 2.6B ended the app while loading. Those runs predate this work; **none of the new models or limits has been run on an iPhone yet.**
- Safari does not report memory, so figures are labelled estimates. `tools/add_logits_to_keep.py` reproducibly rewrites a full-sequence graph to the last-token form (verified in ONNX Runtime on the 230M, not shipped).

**Testing:** `npm test` (96 tests); `node bench/run.mjs` (source selection and retrieval benchmark on `bench/fixtures`). Settings for testers: developer testing mode (AI page → Safety) allows longer prompts, a software GPU and retesting a switched-off model; `localStorage['sparse-ai-class']` can be set to `"ios"` or `"mobile"` to apply stricter limits on a device (it can never loosen them).

Files: `js/ai.js` (page side: downloads, worker, safety state, checkpoints, retrieval), `js/ai-engine.js` + `js/ai-worker.js` (run the models), `js/ai-policy.js` (profiles, budgets, interruption diagnosis), `js/ai-ops.js` (scheduler), `js/ai-diag.js` (events, error codes, report), `js/ai-select.js` (summary evidence and retrieval selection), `js/ai-store.js` (IndexedDB `sparse-ai`), `js/ai-lib.js` (catalog, prompts, BM25).

## Activity and network details

The app tells you what it is doing and what it costs:

- **Activity log, on every screen.** A timestamped list of each step, for example:
  - "Looking on this device for saved results…"
  - "Skipped Mojeek: no API key in Settings"
  - "Trying Marginalia…" then "Marginalia failed: timed out; trying Mwmbl"
  - "↓ Mwmbl: HTTP 200 · 22 KB received · ≈3.7 KB on the wire · first byte 334 ms · total 339 ms · ≈11 KB/s"
  - "Saved these results on this device (15 KB)"

  Its heading sums up the whole screen. Results, reader pages and weather cards also say what they cost to download, or "0 B downloaded now" when they came from the device.
- **Bottom bar, always shown.** What is happening right now, including live progress while a download runs, plus this session's totals. Tap it for the Network page.
- **Network page.** Shows:
  - the connection, where the browser shares it (Safari doesn't);
  - totals for this session;
  - totals per service since the last reset;
  - how each of the app's own files loaded on this launch (0 B = offline cache);
  - storage used;
  - the last 150 requests with full timings. API keys are blanked out.

How it is measured (`js/net.js`):

- **Received** is the exact byte count after decompression.
- **On the wire** is exact when the service sends `Content-Length`, as Jina, Open-Meteo places and Mojeek do. Otherwise it is estimated by gzip-compressing what arrived, and marked "≈", because browsers hide other sites' transfer sizes from web pages.
- **Speed** is on-the-wire size divided by total time, so latency is included.

## Run it locally

```sh
npm start            # python3 -m http.server 8080
open http://localhost:8080
npm test             # node --test, for the parsers in js/lib.js
```

## Host it

Any static HTTPS host works. iOS requires HTTPS for a home-screen app, but `localhost` counts as secure for testing on a computer.

- **GitHub Pages:**
  1. Push this folder to a repository.
  2. Go to Settings, then Pages, choose "Deploy from a branch" and pick the folder.

  All paths are relative, so it works under `https://<you>.github.io/<repo>/`. Nothing secret is in the files: your Mojeek key is typed into the app and stays on the phone.
- **Cloudflare Pages, Netlify:** drag and drop this folder.
- **Your homelab over Tailscale, with no Node process:**

  ```sh
  rsync -a --delete ./ <homelab>:/srv/sparse-pwa/
  sudo tailscale serve --bg /srv/sparse-pwa
  ```

Then open the address in **Safari**, tap Share, and choose **Add to Home Screen**.

## Updating

Upload the changed files. The installed app keeps opening instantly from its cache. On each launch, it downloads the files again in the background and switches to them only once every file has arrived, so the **next** launch runs the new version. To change the list of cached files, edit `FILES` in `sw.js`.

## Privacy

There is no server of yours involved, so each service sees only its own part:

- the search engine you use sees your searches;
- DuckDuckGo sees them too when instant answers are on;
- Jina sees the addresses of pages you open in reader view;
- Open-Meteo sees the places you ask about, or your coordinates for plain `weather`;
- the Internet Archive sees the address of a page when you ask for an archived copy;
- Hugging Face and jsDelivr see that you downloaded the AI files, once. The AI itself sends nothing anywhere.

History, cached results and saved pages stay on the device. The page's Content-Security-Policy only allows connections to the services above, and every link out uses `noreferrer`.

## Files

| File | |
|---|---|
| `index.html` | Shell, iOS meta tags, CSP |
| `js/app.js` | Views (home, results, reader, network, settings), activity log, bottom bar, routing, offline queue |
| `js/net.js` | Measured requests: timings, sizes, progress events, app-load figures |
| `js/lib.js` | Pure logic: engine URLs and parsers, instant answers, weather, Jina and Markdown parsing. Tested in `test/` |
| `js/store.js` | IndexedDB (kv, results, pages) and eviction |
| `sw.js` | App-shell cache with a background refresh |
| `manifest.webmanifest`, `icons/` | Home-screen install |

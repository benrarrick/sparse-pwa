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

Open **Settings → On-device AI** (`#/ai`). Nothing downloads until you tap Download, and every model can be removed again. After the download, everything runs on the device with no connection, and nothing you read or ask is sent anywhere.

| Model | Role | Download (WebGPU) |
|---|---|---|
| LFM2.5 1.2B Instruct | Primary: summaries and answers | 764 MB (q4f16), 854 MB (q4 without 16-bit floats) |
| BGE small en v1.5 | Finds saved passages by meaning; runs on the CPU | 35 MB |
| LFM2.5 2.6B (experimental) | Better summaries and synthesis; too big for an iPhone (iOS ended the app while loading it) | 1.53 GB |
| AI engine | Transformers.js and ONNX Runtime, needed by all | 27 MB (about 6 MB on the wire) |

Without WebGPU, the 1.2B model downloads its 8-bit CPU version (1.5 GB, slow) and the 2.6B can't run. The `q4` exports only work on WebGPU.

What it does:

1. **Summarise:** a button on every reader page, or automatically when a page loads (setting). Long pages are read in parts sized to the prompt limit: short notes on each, then a summary of the notes. Summaries are kept with the page.
2. **Ask, from saved pages and searches** (`#/ask`): passages from pages read in the reader and from search results are matched by keyword (BM25), and by meaning when BGE is downloaded. The two lists are combined, and the model answers from the best few, citing them as [1], [2], linking to the saved copies. Without a chat model, the matching passages are shown.
3. **Ask, from the model's own knowledge:** no sources, labelled as possibly wrong (training data to mid-2024).

Downloads:
- They resume where they stopped: they are saved in 8 MB pieces in IndexedDB, continue with HTTP Range requests, retry with backoff, and wait for the connection to come back.
- They keep the screen on while running, and check free storage first.
- Revisions are pinned, file sizes are checked, and the engine files are checked against SHA-256.

Diagnostics on the AI page:
- **Device check:** WebGPU, 16-bit floats, GPU limits, storage, and whether WebGPU works in a worker.
- **Log:** every download, load and run, with timings, tokens per second, and the error behind any failure.
- **Copy report:** puts all of this on the clipboard.
- **Crashes:** iOS ends a page that uses too much memory without an error the page can see. So a marker is written before each load or run and cleared after; one left over on the next launch is logged as a crash against that model and shown on the home screen.

Files: `js/ai.js` (page side: downloads, worker, log, retrieval), `js/ai-engine.js` (runs the models, in `js/ai-worker.js` or on the page if WebGPU only works there), `js/ai-store.js` (IndexedDB `sparse-ai`), `js/ai-lib.js` (catalog, chunking, BM25, prompts; tested).

**Memory on iPhone:**
- These exports compute a score for every word in the 65,536-word vocabulary at every prompt position. A 3,000-token prompt therefore needs about 0.4–0.8 GB beyond the 764 MB of weights, and iOS ended the app.
- On the test iPhone, 338-token prompts worked, and prompts of about 650 tokens ended the app, even after splitting summaries into parts.
- So there is a **Longest prompt** setting on the AI page (default 300 tokens). Summary parts and the saved text used for answers are sized to fit it.
- The engine refuses any prompt over the limit with a message, rather than letting iOS end the app.
- At 300 tokens, a summary covers the first ~1,800 characters of a page, in 3 parts of ~600 characters each. Raise the limit to cover more.
- After any prompt over 900 tokens, the model is unloaded to give the memory back. Reloading takes about 3 s.

**Measured on an iPhone, WebGPU with 16-bit floats:**
- The 1.2B model loads in about 2.8 s and writes 10–23 tokens a second.
- BGE indexed 344 saved passages in 57 s. That happens once; the results are kept.

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

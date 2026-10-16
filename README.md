# Sparse (static PWA)

A light search app for the iPhone home screen that needs **no server of its own**. It is plain HTML, CSS and JavaScript (about 60 KB uncompressed, no build step) that any static host can serve.

It works because every service it reads sends CORS headers, so a web page may call it directly:

| What | Service | Key |
|---|---|---|
| Web results | [Mwmbl](https://mwmbl.org) (default), [Marginalia](https://marginalia-search.com), [Mojeek](https://www.mojeek.com/services/search/web-search-api/) | Mojeek needs a paid key (about £1 per 1,000 searches) and **never runs automatically**: searches use the free engines, and a "Try Mojeek" button under the results re-runs that one search on Mojeek. Marginalia's shared `public` key is often busy. |
| Instant answers | DuckDuckGo Instant Answer API | none |
| Reader view | [Jina Reader](https://jina.ai/reader) (`r.jina.ai`) | optional: works without one at 20 pages a minute, but Jina refuses anonymous requests from some networks with a 401. A free key from jina.ai, pasted into Settings, fixes that. |
| Weather | Open-Meteo (forecast, place lookup, air quality) | none |
| Wikipedia articles | Wikipedia's own API (`*.wikipedia.org/w/api.php`) | none. The opening section and the list of sections load first (about 3–10 KB); other sections load when tapped; tables come through. Jina is used for every other site, and as the fallback. |
| Exchange rates | [Frankfurter](https://frankfurter.dev) (European Central Bank reference rates) | none. One download of about 0.5 KB on the wire serves every pair for 6 hours, and offline from the saved copy. |
| Speed test (button on the Network page) | `speed.cloudflare.com`, and static files in `speedtest/` served with the app | none. Cloudflare sees your IP address, like any service here. About 0.5 MB per test, up to 2.5 MB on a fast connection. |
| Nearby places | OpenStreetMap through Overpass (two servers), then Nominatim as a fallback | none. Overpass is often at capacity, so Nominatim usually answers. |
| Archived copies | Internet Archive availability lookup (`archive.org/wayback/available`) | none to find a copy; reading it in the app needs a Jina key, because Jina refuses anonymous requests for archive.org |
| On-device AI (optional) | Models from Hugging Face, the engine (Transformers.js 4.3.0, ONNX Runtime Web) from jsDelivr: downloaded once, only when you tap Download | none |

DuckDuckGo's own results pages can't be read by a web page. The app opens them instead: there's a "DuckDuckGo Lite ↗" link under every result list, and any query containing a `!bang` goes straight to DuckDuckGo.

## Features

- **Results:** title, address and snippet, about 4–8 KB per search. If the chosen engine fails or finds nothing, the next one is tried. An engine that failed is skipped for 5 minutes.
- **Reader view:** tapping a result opens the page as text through Jina Reader. Links inside it open in the reader too. "Open original ↗" opens the real site. A Wikipedia article arrives as about 28 KB.
- **Cards:** an instant-answer card (Wikipedia abstracts, definitions, simple answers) and a weather card for `weather`, `weather in Leeds` or `paris weather`.
- **Weather, basic by default:** temperature and what it feels like, rain in the next hour (15-minute steps), and 3 days, in about 0.5 KB. **More weather** on the card fetches the rest only when tapped, about 1.2 KB more: wind direction and gusts, humidity, cloud, visibility, pressure, UV, sunrise and sunset, air quality (US scale with °F, European otherwise), 24 hours (every 3 hours, or every hour with a tap) and 7 days. Both are kept on the device for 30 minutes. Settings can make the card always show everything.
- **Archived copies:** when the reader can't load a page, the app asks the Internet Archive (about 0.2 KB) for its latest copy and offers it. Every reader page also has an **Archived copy** button that only looks when tapped. With a Jina key the copy opens in the reader as text. Without one it opens in Safari, at full size. The archive's lookup sometimes misses copies, or refuses when asked too often, so a direct link to the archive is always offered as well.
- **Conversions:** `50 eur to usd`, `$20 in pounds`, `5 miles to km`, `72 f in c`, `500 mb to gb` show a card above the results. Units are worked out on the device and download nothing. Currency uses ECB rates, shown with their date.
- **Nearby places:** `coffee near me`, `pharmacy near Leeds`, `Tesco near me` (and a "Near you" row on the home page) list the 10 closest places with distance, direction, address, "open until 18:00" where OpenStreetMap has opening hours (only for places near you, using the device clock), Map, Call and Website links. Saved for an hour. Your coordinates go to the OpenStreetMap servers.
- **Wikipedia by section:** a Wikipedia link in the reader loads the opening section and an infobox summary, then a button per section; each loads only when tapped and is kept on the device. "Load the whole article" gets the rest. Turn it off in Settings to use Jina for Wikipedia too.
- **On-device AI (optional, off until you download a model):** see below.
- **Offline:**
  - The app opens from the service worker cache.
  - Searches and pages are kept on the device (IndexedDB): results for 30 days, up to 300 searches; pages for 30 days, up to 100, unless you tap **Save for offline**.
  - A search or page asked for while offline is queued. It runs when the connection comes back, and then appears under "Ready" on the home screen.
- **Repeat searches:** a search repeated within 6 hours (configurable) loads from the device and uses no data.
- **Settings:** engine, keys, fallback, region, safe search, instant answers, what tapping a result opens, DuckDuckGo Lite or HTML, weather units.

## On-device AI

Open **Settings → On-device AI** (`#/ai`). Nothing downloads until you tap Download, every model can be removed again, and **the browser works fully without any of it**. After the download, everything runs on the device with no connection, and nothing you read or ask is sent anywhere.

| Model | Download | Notes |
|---|---|---|
| LFM2.5 350M Instruct | 258 MB (q4f16) / 297 MB (q4) | small and quick; WebGPU |
| LFM2.5 230M Instruct | 216 MB | the smallest; WebGPU |
| Llama 3.2 1B Instruct (through WebLLM) | 711 MB, kept by WebLLM, + a 6 MB engine | the best answers of the small models tried; WebGPU with 16-bit floats |
| BGE small (English) | 35 MB | finds saved passages by meaning; runs on the CPU |

Licences: LFM Open License 1.0 for the LFM models, Llama 3.2 Community License for Llama, MIT for BGE. (Earlier versions also offered LFM2.5 1.2B and 2.6B; they are removed, and their files are deleted from the device the next time the app starts.)

**What it does**
1. **Summarise** a reader page: sentences are picked from the whole page (not just its start), one pass when possible, a bounded number of notes plus a combine only when one pass would see too little. Summaries are kept with the page.
2. **Ask from saved pages and searches** (`#/ask`): keyword (BM25, updated incrementally) plus meaning (BGE) matching over every saved page, a hard evidence budget, cited answers `[1]`. With no model available it shows the closest passages with their sources instead.
3. **Ask from the model's own knowledge**, labelled as possibly wrong.

**Keeping the app steady** (iOS can end a page that uses too much memory, with no error to catch)
- Each model has a **longest prompt** and a **longest answer** (in tokens), counted with the model's own tokenizer and enforced inside the engine. You can change both for each model on the AI page; they are kept on the device, and together they can't pass what the model can hold. The starting values are in `SAFETY` in `js/ai-policy.js`, the same on every device.
- **One operation at a time**, one model in memory at a time; the AI stops if the app goes to the background; a half-updated app is detected.
- **Checkpoints** are written before each risky stage. If the app is ended in the middle of one, the next launch says so on the AI page and in the log, with a plain diagnosis (backgrounded, closed, GPU lost, unexplained). Nothing is switched off because of it.

**The AI page** shows each model with Download / Pause / Test / Remove and its prompt and answer limits as editable fields, the model chooser, a one-line status, and the log (every download, load and run, with where and why anything failed), with **Copy report** / **Copy as JSON**. Reports hold ids, counts and timings, never page text or questions. See docs/ai.md.

**Downloads** (Transformers.js models) resume where they stopped, keep the screen on, check free storage first, pin revisions and verify sizes and the engine's SHA-256. Llama's weights are fetched by WebLLM itself.

**Testing:** `npm test`; `node bench/run.mjs` (source selection and retrieval benchmark). `localStorage['sparse-ai-class']` can be set to `"ios"` or `"mobile"` to make the app treat the device as a phone in its logs.

Files: `js/ai.js` (page side: downloads, worker, checkpoints, retrieval), `js/ai-engine.js` + `js/ai-worker.js` (run the models), `js/ai-policy.js` (limits, interruption diagnosis), `js/ai-ops.js` (scheduler), `js/ai-diag.js` (events, error codes, report), `js/ai-select.js` (summary evidence and retrieval selection), `js/ai-store.js` (IndexedDB `sparse-ai`), `js/ai-lib.js` (catalog, prompts, BM25), `vendor/` (WebLLM).

## Layout

One sticky bar (Back, Forward, Sparse for home, and a Menu for Network, On-device AI and Settings). Each screen is a stack of titled cards; Settings uses collapsible ones. Notices such as an AI interruption or a model error are banners with a × to dismiss them, on the home page too. Styles are in `style.css`: colour tokens at the top, then components (`.group`, `.banner`, `.chip`, `.rows`, `.button`).

## Activity and network details

The app tells you what it is doing and what it costs:

- **Activity log, on every screen** (collapsed by default; Settings → Reading expands it). A timestamped list of each step, for example:
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
- Wikipedia sees the article titles you open (instead of Jina);
- Overpass or Nominatim see your coordinates (or the place you named) for "near me" searches; Frankfurter sees only that you asked for rates;
- the Internet Archive sees the address of a page when you ask for an archived copy;
- Hugging Face and jsDelivr see that you downloaded the AI files, once. The AI itself sends nothing anywhere.

History, cached results and saved pages stay on the device. The page's Content-Security-Policy only allows connections to the services above, and every link out uses `noreferrer`.

## Files

| File | |
|---|---|
| `index.html` | Shell, iOS meta tags, CSP |
| `js/app.js` | Views (home, results, reader, network, settings), activity log, bottom bar, routing, offline queue |
| `js/net.js` | Measured requests: timings, sizes, progress events, app-load figures |
| `js/speed.js`, `speedtest/` | The speed test: latency, then 250 KB, then 1 MB only on a fast link. `speedtest/` holds random (incompressible) files of those exact sizes |
| `js/convert.js`, `js/places.js`, `js/wiki.js` | Pure logic for conversions and rates, nearby places and opening hours, Wikipedia's API and HTML-to-Markdown. Tested in `test/` |
| `js/lib.js` | Pure logic: engine URLs and parsers, instant answers, weather, Jina and Markdown parsing. Tested in `test/` |
| `js/store.js` | IndexedDB (kv, results, pages) and eviction |
| `sw.js` | App-shell cache with a background refresh |
| `manifest.webmanifest`, `icons/` | Home-screen install |

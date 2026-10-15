# Sparse (static PWA)

A light search app for the iPhone home screen that needs **no server of its own**. It is plain HTML, CSS and JavaScript (about 60 KB uncompressed, no build step) that any static host can serve.

It works because every service it reads sends CORS headers, so a web page may call it directly:

| What | Service | Key |
|---|---|---|
| Web results | [Mwmbl](https://mwmbl.org) (default), [Marginalia](https://marginalia-search.com), [Mojeek](https://www.mojeek.com/services/search/web-search-api/) | Mojeek needs a paid key (about £1 per 1,000 searches) and **never runs automatically**: searches use the free engines, and a "Try Mojeek" button under the results re-runs that one search on Mojeek. Marginalia's shared `public` key is often busy. |
| Instant answers | DuckDuckGo Instant Answer API | none |
| Reader view | [Jina Reader](https://jina.ai/reader) (`r.jina.ai`) | optional: works without one at 20 pages a minute, but Jina refuses anonymous requests from some networks with a 401. A free key from jina.ai, pasted into Settings, fixes that. |
| Weather | Open-Meteo (forecast and place lookup) | none |

DuckDuckGo's own results pages can't be read by a web page. The app opens them instead: there's a "DuckDuckGo Lite ↗" link under every result list, and any query containing a `!bang` goes straight to DuckDuckGo.

## Features

- **Results:** title, address and snippet, about 4–8 KB per search. If the chosen engine fails or finds nothing, the next one is tried. An engine that failed is skipped for 5 minutes.
- **Reader view:** tapping a result opens the page as text through Jina Reader. Links inside it open in the reader too. "Open original ↗" opens the real site. A Wikipedia article arrives as about 28 KB.
- **Cards:** an instant-answer card (Wikipedia abstracts, definitions, simple answers) and a weather card for `weather`, `weather in Leeds` or `paris weather`.
- **Offline:**
  - The app opens from the service worker cache.
  - Searches and pages are kept on the device (IndexedDB): results for 30 days, up to 300 searches; pages for 30 days, up to 100, unless you tap **Save for offline**.
  - A search or page asked for while offline is queued. It runs when the connection comes back, and then appears under "Ready" on the home screen.
- **Repeat searches:** a search repeated within 6 hours (configurable) loads from the device and uses no data.
- **Settings:** engine, keys, fallback, region, safe search, instant answers, what tapping a result opens, DuckDuckGo Lite or HTML, weather units.

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
- Open-Meteo sees the places you ask about, or your coordinates for plain `weather`.

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

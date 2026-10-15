# vendor/

`web-llm-0.2.86.js` is [WebLLM](https://github.com/mlc-ai/web-llm) 0.2.86 (Apache-2.0), the self-contained ES module that
jsDelivr builds at `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm`. It is kept here, not loaded from the CDN, so the
file the app checksums (SHA-256 in `js/ai-lib.js`) can never change underneath it. The app downloads it once, together with the
first WebLLM model, and runs it from the device afterwards.

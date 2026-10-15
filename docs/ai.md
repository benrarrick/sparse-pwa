# On-device AI: safety, stability and diagnostics

> **v2.2 simplified the AI.** The models are now LFM2.5 350M and 230M, Llama 3.2 1B (WebLLM) and BGE small. The 1.2B and 2.6B are gone, and so are developer mode, the experimental opt-in, per-device-class limits, the prompt-limit picker and quarantine. The limits are one set per model, and an interrupted run is diagnosed and shown but never switches anything off. Sections below that describe measurements and benchmarks (1.2B and 2.6B numbers, the 338/650-token iPhone observation) are history and are left as they were.

This describes how the optional on-device AI is kept from destabilising the app, how it is observed, and what has and has not been verified. The app is a reader first: **with the AI off, broken or unavailable, browsing, saved pages and searching saved pages all still work.**

> iOS can end a web process without any error the page can catch. Nothing here can guarantee that never happens. The approach is to refuse work that is known or suspected to be unsafe, to stop before limits, to switch off a setup that was interrupted unexpectedly, and to record enough to explain what happened next time.

**Nothing in this document was run on an iPhone by the author of these changes.** What was run is listed under [Tests](#tests-actually-run). Real-device steps are in [the manual test plan](#manual-test-plan-for-the-installed-ios-app).

## Models

| Model | Weights | Needs | Starting limits (prompt / answer tokens) and the most they may add up to |
|---|---|---|---|
| LFM2.5 **350M** Instruct | 258 MB (q4f16) or 297 MB (q4) | WebGPU | 600 / 200, together up to 4,096 |
| LFM2.5 **230M** Instruct | 216 MB (q4) | WebGPU | 500 / 200, together up to 4,096 |
| Llama **3.2 1B** Instruct (WebLLM) | 711 MB (q4f16_1, WebLLM's own store) + 6 MB engine | WebGPU with 16-bit floats | 450 / 200, together up to 2,048 |
| BGE small en v1.5 | 35 MB, CPU | none | batches of 4, ≤ 1,200 characters each, ≤ 64 passages per question |

- **You set the limits.** Each model's card on the AI page has two fields, the longest prompt and the longest answer, in tokens. They are saved on the device, Reset puts the starting values back, and a value that cannot work (below 100 / 24 tokens, or the two adding up past the ceiling) is adjusted and says so. Summaries and answers use the answer field as their length limit, and the text taken from a page is sized from the prompt field. The starting values are guesses, the same everywhere, in `SAFETY` in `js/ai-policy.js`.
- **Llama through WebLLM, measured on one computer** (ordinary English text, greedy decoding): correct at 180, 328 and 476 prompt tokens; an empty answer at 624; garbage or a lost GPU above that (about 1,000). That is why its starting prompt limit is 450 and why its card says so. Not measured on a phone, where the limits may be lower.
- Every Transformers.js entry has a pinned commit of the Hugging Face repository. Repository ids, file names, sizes and tensor names were checked against the live repositories (see [what was measured](#what-was-measured-about-memory)).
- A model removed from the app (1.2B, 2.6B) has its files deleted at the next start, and the old developer-mode and quarantine settings are cleared.
- **Licence:** the LFM2.5 models are under the *LFM Open License 1.0* (Liquid AI; the model cards link the terms, which include conditions for commercial use). Llama 3.2 is under the Llama 3.2 Community License. BGE small is MIT. Transformers.js, ONNX Runtime and WebLLM are Apache-2.0 / MIT. Models are downloaded by you to your own device; this repository does not redistribute them (it does keep the WebLLM library in `vendor/`).
- **No silent CPU fallback.** The 350M and 230M exports have no CPU-compatible version (the 350M's 8-bit export failed with "Could not find an implementation for GatherBlockQuantized" when tried), so without WebGPU they are simply not offered, and written answers are off. Saved pages can still be searched.

### Llama 3.2 1B through WebLLM (added in v2.1)

The one model here that does not run on Transformers.js. It came out best in the lab comparison (5 of 8 test questions on a computer, the next best 3) and it is the smallest to load, because WebLLM sends the weights to the GPU a shard at a time instead of holding the whole file in memory twice.

- **Engine:** WebLLM 0.2.86, kept in the repository (`vendor/web-llm-0.2.86.js`, SHA-256 in `js/ai-lib.js`) and downloaded once with the model like the other engine files. It then runs from the device, offline.
- **Model files:** WebLLM downloads and keeps them itself (its own IndexedDB store). The app's downloader does not manage them, so there is no byte-level resume: shards already stored are skipped when you retry. The weights are *not* pinned to a revision (WebLLM always asks for the latest); the recorded identity is the library version.
- **The download is a real GPU load**, run as a queued, checkpointed operation that releases the model straight away. If iOS ends the app during it, the next launch says so, like any other load.
- **Budgets:** counted with WebLLM's own tokenizer (an over-high estimate if it cannot be reached), refused or trimmed against the same limits, and the library's own count is logged next to it. The memory WebLLM reserves for the conversation is 2,048 tokens, above the model's combined limit.
- **Needs shader-f16** (WebGPU 16-bit floats). Without it the card says so: there is no CPU or 32-bit fallback.
- **Tested** end to end in a desktop browser: download, checksum, load, answer, and a second run with the network blocked. **Not tested on an iPhone.**

*Limits are in `js/ai-policy.js` (`SAFETY`). A model with no entry is unsupported.*

## Limits and diagnosis

**Token budgets (fail closed).** Before any inference the engine counts the prompt with the model's own tokenizer (system prompt, chat template, sources, question and all). If counting fails, nothing runs (`TOKENIZATION_FAILED`). It then enforces `input ≤ maxInput` and `input + new ≤ maxTotal`, and an answer is never allowed less than 24 tokens of room. A prompt over the limit is refused, or, where the caller allows it (source text, summary parts), its end is cut to fit, counting again after each cut. The limits are the person's settings (made sensible, and never past the model's ceiling); the engine applies the same rules as the page.

**One operation at a time.** Loading, embedding, generating, switching models, unloading and resetting go through one scheduler (`js/ai-ops.js`) with an explicit queue (at most 8 waiting). The same scheduler runs again inside the engine, so a second request there is queued and logged, never run alongside. Stop is never queued behind the work it stops.

**Preflight.** Before work starts: the model is downloaded, it can run on this backend, the app is on screen, the GPU has not been lost, and the page and worker are the same build (a half-updated app gets "close and reopen it, twice").

**Foreground only.** If the app goes to the background while the AI writes, the AI is stopped and the text so far is kept, labelled incomplete.

**Memory habits.** One model is resident at a time. BGE is released as soon as retrieval finishes, before a chat model loads. Phone models are released two minutes after last use, and straight after a prompt above 85% of the limit.

**Checkpoints and what the next launch says.** Before each risky stage the page writes a small versioned checkpoint to `localStorage`: model, backend, token counts, stage, start and last-progress times, visibility. It is deleted when the work ends. A leftover one at the next launch is classified and shown on the AI page and in the log:

| Diagnosis | When |
|---|---|
| `GPU_DEVICE_LOST` | the engine reported the GPU lost before the app ended |
| `APP_CLOSED` | the page reported it was being closed |
| `BACKGROUNDED` | the app had been in the background during the work |
| `UNEXPECTED_INTERRUPTION` (low confidence) | everything else: in the foreground, nothing reported |

The message never claims a cause it cannot show: "*The app was ended while working with … iOS did not say why; running out of memory is one possible cause.*" A swipe-away from the app switcher looks the same as an unexplained termination. Nothing is switched off because of it: the model count of unexplained interruptions is shown on its card.

**If no model is available**, Ask shows the closest passages from saved pages and searches (keyword, plus meaning if BGE is installed) with their sources, and says why no written answer is offered.

## What was measured about memory

Be careful with the words: **measured** (seen directly), **read from the file** (certain, but about shapes, not RAM), **estimated** (computed from shapes), **hypothetical**.

*Read from the exported graphs (ONNX protobuf, graph files only), certain:*
- 350M (q4f16, q4, 8-bit) and 2.6B: have a `num_logits_to_keep` input; `logits` is `[batch, num_logits_to_keep, vocab]`. Transformers.js 4.3.0 sets it to 1 for generation (read in its source), so the final projection runs for the last position only, whatever the prompt length. The app also confirms this at load time from the session's input names.
- **1.2B and 230M: no such input.** `logits` is `[batch, sequence_length, 65536]`: the 65,536-way projection runs for **every prompt token**. In the 1.2B q4f16 graph the head is computed in 16-bit and then cast to 32-bit (`Cast`), so two copies exist.
- Key/value caches are small: only 6 of the 16 layers use attention (8 kv-heads × 64), about 24 KB per token in 32-bit.

*Estimated from those shapes (not measurements):* the score tensor for the 1.2B is about 125 MB at 300 prompt tokens, 272 MB at 650 and 1.25 GB at 3,000; for the 350M, 8 MB, 16 MB and 74 MB (mostly the key/value cache). This matches what happened on the test iPhone (338 tokens fine, about 650 ended the app, ~3,000 certainly) but **is not proof that this tensor was the cause**: ONNX Runtime's WebGPU buffer pooling, the weights (764 MB), and Safari's per-process limits all contribute and none of them is visible to a web page.

*Not available:* Safari reports no process or GPU memory. The AI page and report show only what exists (JS heap on Chrome-based browsers, storage use) and print "unavailable" otherwise. Nothing is presented as peak device RAM.

*Hypothetical / not done:*
- Whether ONNX Runtime Web retains WebGPU buffers after a session is disposed was not measured. The design assumes it might and restarts the engine after anything suspicious; "dispose is enough" is not claimed.
- Whether a newer ONNX Runtime fixes any retention was not tested. The pinned build is `1.31.0-dev.20260914`, a development build selected in the earlier work on this project; changing it was out of scope.
- **A last-token variant of the 230M/1.2B graphs** is provided as a reproducible transformation: `tools/add_logits_to_keep.py` inserts the same three nodes (Neg, Unsqueeze, Slice) that Liquid's own 350M export has. Verified with ONNX Runtime on CPU against the 230M q4 weights: the rewritten graph returns exactly the last *k* positions of the original (max difference 9e-6 for *k* = 1, 0 for *k* = 5; same top token). It has **not** been loaded in the browser, not been timed, and is **not shipped or offered**: using it would mean hosting a modified copy of a licensed model. The 1.2B transform was only structurally checked (output shape becomes `[batch, num_logits_to_keep, 65536]`).

## Summaries

Previously: the first N characters of a page, in parts. Now (`js/ai-select.js`, deterministic, no model):
1. Markdown is split into sections; menus, "subscribe/share/related" lines, link lists and repeated paragraphs are dropped.
2. Each sentence is scored: first of its section, the page's lead, numbers/dates/quantities, named things, how central its words are to the page (and overlap with headings), minus very short/long ones; value per character is used so fact-dense sentences win.
3. Every section gets its best sentence before any gets a second (largest worth first), near-duplicates are skipped, and the picks are put back in page order. In prompts of 700+ characters, section headings label the text.
4. **Plan:** a short page is sent whole; otherwise **one** call over sentences chosen from the whole page ("extract"); only if one call would cover under 30% of a long, multi-section page does it use a **bounded** number of notes (2 on a phone, 4 on a computer) plus a combine call.
5. The prompt tells the model the text is picked sentences, and says to keep names, numbers and dates exactly and add nothing. The summary card says how much of the page it saw ("*… This is not the whole page: about 41% of its text was read*").
6. Summaries are cached by model **revision**, **strategy version** and a **hash of the page text**; any change invalidates them.

## Retrieval

- All of every saved page is indexed (the old 40-passages-per-page cap is gone, so text at the end of a page is findable); *what is indexed* is separate from *what fits a prompt*.
- The keyword index is **incremental**: unchanged passages keep their term counts, so a question no longer rebuilds it.
- Passages keep their section heading; a saved page replaces the shallow snippet of the same address; repeated paragraphs collapse; near-duplicates are not picked twice; at most 3 passages per page.
- **The evidence budget is hard**, labels included, and comes from the model's own limit. A passage that does not fit is cut to the most relevant sentences (the old code let the first passage skip the budget). The engine counts the finished prompt again and trims the end of the sources if needed; the question comes first so it is never the part cut.
- Meaning match: BGE vectors are cached per passage hash. A question embeds only the best keyword candidates plus recent pages (≤ 64 on a phone), not everything; damaged or wrong-length stored vectors are discarded. BGE runs in batches of 4 and is released before any chat model loads. If it fails, the question falls back to keywords.
- Answers cite sources as `[n]`, linking to the saved copy; each source label shows its section and the date it was saved.

## Streaming

Replies are drawn as plain text, at most every 100 ms, into one text node; lists and citations are formatted once at the end. Time spent drawing is logged as `ai.ui.render` (in the headless-Chrome runs: live updates ≈ 0 ms, final formatting under 2 ms). Stop is a button available from the first moment; a stopped or failed reply keeps its text, labelled incomplete.

## Observability

Everything stays on the device (IndexedDB, bounded to the newest ~600 events; in-memory ring of 300). Nothing is uploaded. By default **no page text, question, answer, search term or address is recorded**: events carry ids, counts, lengths and timings, free text is scrubbed of addresses/tokens, and private field names are dropped. Writes are batched off the token path and a failing store is counted, never thrown.

**Events** (all carry `sid` session, `op` operation, `parent`, model `pkg`/`rev`, `dtype`, `backend`, `mode`, `stage`, `code`, timings, and `m` metrics): `ai.operation.queued/started/stage/completed/failed/cancelled/timeout/abandoned`, `ai.model.load.started/completed`, `ai.prompt.tokenized`, `ai.inference.prefill.started`, `ai.inference.first_token`, `ai.inference.completed/failed/stop_requested`, `ai.model.dispose.started/completed/failed`, `ai.retrieval.completed`, `ai.ui.render`, `ai.worker.started/initialised/responsive/busy/unresponsive/terminated/restarted/reset/gpu_lost/version_mismatch`, `ai.recovery.interrupted`, `ai.app.visibility`, `ai.checkpoint.stale_cleared`, `ai.engine.overlap`, `ai.storage.vectors_discarded`.

**Recorded per generation:** load time and mode, input tokens (exact), allowed budget, tokenizing time, time to first token (prefill is *inferred* to end at the first token: the runtime reports nothing in between), tokens, tokens/s, requested vs actual output, stop reason (`eos`, `length`, `stopped`, `timeout`, `error`), queue wait. **Per retrieval:** index build/reuse, keyword time, BGE load and embed time, new vs cached vectors, ranking and fusion time, passages considered/selected/excluded/excerpted. **Resources:** dispose time, worker starts/terminations/resets, GPU loss, queue depth, device and adapter limits, and the memory indicators that exist (otherwise "unavailable"). Allocation sizes are in the report under *Expected allocations (estimates)*, separate from measurements.

**Error codes:** `MODEL_NOT_INSTALLED, MODEL_LOAD_FAILED, MODEL_INCOMPATIBLE, GPU_UNAVAILABLE, GPU_DEVICE_LOST, TOKEN_BUDGET_EXCEEDED, TOKENIZATION_FAILED, INFERENCE_FAILED, INFERENCE_TIMEOUT, WORKER_FAILED, WORKER_UNRESPONSIVE, MODEL_DISPOSE_FAILED, STORAGE_ERROR, POSSIBLE_MEMORY_EXHAUSTION, UNEXPECTED_INTERRUPTION` (plus `NOT_FOREGROUND, BACKGROUNDED, VERSION_MISMATCH, QUEUE_FULL, CANCELLED`). A code is only assigned when the error text or the stage supports it; otherwise `UNKNOWN`. Original messages and stacks are kept.

**Worker health:** states none → starting → initialised → responsive ⇄ busy → unresponsive/terminated → restarted. An *idle* worker answers a ping at once, so a ping before a model loads tells a dead worker from a busy one; a busy worker is judged by phase (load: 4 min; generation: the profile's time limit + 20 s). A worker that cannot be stopped is terminated and recreated.

**AI page** (Settings → On-device AI): the models with Download / Pause / Test / Remove, the model chooser, one line of live status (what is running, what is in memory, GPU or update problems), the log with an errors-only filter, Copy report / Copy as JSON, Reset AI engine, and Remove all.

### Reading a report

1. **LAST INTERRUPTION AT LAUNCH** says what the previous run left behind, its category, confidence and the reasons. `BACKGROUNDED`/`APP_CLOSED` are normal. `UNEXPECTED_INTERRUPTION` + `stage: prefill` + `input 180` means the app ended while the model read a 180-token prompt.
2. **RECENT EVENTS** (newest first): find the `op=` of the failed operation and read its events in order. The last `stage=` before silence is where it stopped. A `ai.operation.failed` carries the stage it failed in.
3. **TOKEN LIMITS** lists the limits each model ran under, to compare with the input size in the last interruption.
4. **PERFORMANCE** and **LAST INFERENCE** show whether it was slow (first token, tokens/s) before it failed.
5. `ai.worker.gpu_lost`, `ai.worker.unresponsive`, `ai.engine.overlap` and `ai.worker.version_mismatch` are explicit causes; `WORKER_FAILED` with "often a sign it ran out of memory" is a hint, not a diagnosis.

### Example (test data)

An excerpt assembled from reports produced in **headless Chrome on Linux with a software GPU and the phone limits forced on** (so it is not iPhone data). The interruption section is from a simulated checkpoint written for the test; the event lines are real, abbreviated; device details trimmed:

```text
Sparse on-device AI report · 2026-10-15T17:06:36Z
APP        build: 2026-10-15.1 · engine: Transformers.js 4.3.0 · ONNX Runtime Web 1.31.0-dev.20260914
DEVICE     class: ios (forced) · WebGPU: software adapter · storage persistent: false
INSTALLED MODELS
  lfm350: ready q4/webgpu rev d11593fd, 297118588 bytes, 2 failures
TOKEN LIMITS (prompt / answer / total / time)
  lfm350: 600 / 200 / 760 / 120 s
LAST INTERRUPTION AT LAUNCH
  UNEXPECTED_INTERRUPTION (confidence low)
  The app was ended while working with LFM2.5 350M (generate), last stage "prefill". iOS did not say why; running out of memory is one possible cause.
  last stage: prefill · model lfm350 q4/webgpu · input 180 tokens, output budget 60
  - the app was in the foreground and nothing was reported
RECENT EVENTS (newest first)
… ERROR ai.inference.failed op=op7 lfm350 stage=prefill code=INFERENCE_TIMEOUT LFM2.5 350M: Stopped after 90 s {"inputTokens":187,"tokens":4}
… OK    ai.inference.first_token op=op8 stage=first_token First token after 69878 ms
… INFO  ai.prompt.tokenized op=op8 Prompt is 187 tokens (limit 300); up to 50 may be written (total limit 380)
```

(Separately, during testing the harness did kill the browser mid-generation once, and the next launch diagnosed it as shown: the mechanism worked as designed.)

## Benchmarks

`node bench/run.mjs` (fixtures in `bench/fixtures`: a short news item, a long article, technical documentation, a date- and number-heavy page, two overlapping pages on the same topic, and a question with no answer). The OLD column re-creates the previous behaviour. Output of the run made while writing this:

```text
SUMMARY EVIDENCE (key facts kept / total, sections represented)

page         budget                 old: first chars   new: whole page    calls (new plan)
news-short   350M phone 308 ch      4/6                5/6 (3/4 sec)      extract 1 call, plan covers 5/6
news-long    350M phone 308 ch      1/8                3/8 (3/5 sec)      hierarchical 3 calls, plan covers 5/8
tech-docs    350M phone 308 ch      3/7                3/7 (4/5 sec)      extract 1 call, plan covers 3/7
data-heavy   350M phone 308 ch      4/6                4/6 (3/4 sec)      extract 1 call, plan covers 4/6
news-short   1.2B phone 532 ch      6/6                5/6 (4/4 sec)      extract 1 call, plan covers 5/6
news-long    1.2B phone 532 ch      3/8                4/8 (5/5 sec)      extract 1 call, plan covers 4/8
tech-docs    1.2B phone 532 ch      3/7                4/7 (5/5 sec)      extract 1 call, plan covers 4/7
data-heavy   1.2B phone 532 ch      5/6                5/6 (4/4 sec)      single 1 call, plan covers 5/6
news-short   desktop 1372 ch        6/6                6/6 (4/4 sec)      single 1 call, plan covers 6/6
news-long    desktop 1372 ch        7/8                8/8 (5/5 sec)      extract 1 call, plan covers 8/8
tech-docs    desktop 1372 ch        6/7                5/7 (5/5 sec)      single 1 call, plan covers 6/7
data-heavy   desktop 1372 ch        5/6                5/6 (4/4 sec)      single 1 call, plan covers 5/6

QUESTIONS OVER SAVED PAGES (does the evidence contain the answer; keyword search only)

question                                             old: answer in evidence    new      new chars used / budget
What temperature should I bake sourdough at?         true                       true     377/420
How much did the Harbour Line cost in the end?       false                      true     331/420
When does the Harbour Line open?                     true                       true     328/420
What happens when the cache returns error E_CACHE_   true                       true     415/420
What is the capital of Australia?                    0 passages for an unanswerable question 0 passages 0/420

answerable questions with the answer in the evidence: old 3/4, new 4/4; old exceeded the budget on 3 question(s), new never.

KEYWORD INDEX (a library of 300 saved pages, 12 passages each)

passages: 4496; rebuild + search every question: 78.9 ms; incremental, first time: 116.6 ms; every later question: 23.0 ms

EXPECTED SCORE-TENSOR ALLOCATIONS (estimates from tensor shapes)

prompt tokens  1.2B (all positions)     350M (last position only)
220            92 MB                    6 MB
300            125 MB                   8 MB
338            141 MB                   9 MB
650            272 MB                   16 MB
3000           1.25 GB                  74 MB
```

Reading it honestly:
- **Evidence:** with room (computer-size prompts) the two are close, and the old head-of-page approach is sometimes *better* on short pages where the lead holds the facts (e.g. 6/7 vs 5/7 on the technical page at 1,372 characters in the "extract" column; the plan sends a page that small whole, which is why the plan column differs). The new selection is clearly better where the old one fails, on **long pages in small prompts**: 1/8 → 3/8 key facts (or 5/8 with notes) on the long article at the 350M's phone budget, and it reaches the final sections. Key-fact counts are a crude proxy (string matching on synthetic pages) and say nothing about the wording of a summary.
- **Questions:** 4/4 answers present in the evidence vs 3/4, and the budget is never exceeded (the old code exceeded it on 3 of 5 questions).
- **Index:** 79 ms to rebuild and search 4,496 passages vs 23 ms for each later question (116 ms the first time). These are Node timings on a development PC, not a phone.
- **Not measured here:** answer faithfulness (needs a model and a judge), time to first token and tokens per second on real hardware, peak memory, and "no termination in qualified workloads" (needs the iPhone). The only model timings available were from a *software* GPU (≈0.2 tokens/s, 25-70 s to first token) and say nothing about phone speed. The earlier iPhone figures still stand for the 1.2B: loads in about 2.8 s, 10-23 tokens/s.
- A model-based benchmark (summaries and questions through the loaded model on the device, with the same fixtures) should be run on the phone; the events above (`ai.inference.completed`, `ai.retrieval.completed`) carry the numbers.

## Tests actually run

`npm test` (`node --test`): **104 tests, all passing**, in Node. They cover the catalog and pinned revisions; token budgets (null/NaN/over-limit/combined-limit, clamping); the 303-over-300 case; concurrency in the scheduler and in the engine with a fake runtime (simultaneous generations, generation during embed or load, model switching, release during generation, stop while running / queued / embedding, worker exceptions, GPU loss, tokenizer failure, disposal failure, background refusal, a failure not locking the queue); the backend and GPU-loss rules; interruption classification (foreground, backgrounded, closed, GPU lost, legacy marker); logging (unique ids, stage order, parent/child, failures keep stage, no source text, bounded storage, store failures harmless); report layout; summary selection and planning; retrieval budgeting (huge first passage, duplicates, per-page cap, late-page text findable, snippet replaced by saved page, damaged vectors); the incremental index against a full rebuild.

Also run, outside `npm test`, in **headless Chrome 155 on Linux** against the real files from Hugging Face and jsDelivr (CPU for BGE, a *software* WebGPU adapter for the chat model, so correct but slow): downloads and checksums of the 350M, BGE and the engine; loading and generating with the 350M (and confirming from the loaded graph that it scores the last position only); three generations + an embed + an unload submitted at once ran strictly one after another; retrieval over fixture pages with BGE released afterwards, vectors reused on later questions and a hard budget; engine reset and recovery; a simulated interrupted run → diagnosis, quarantine, the Ask page falling back to passages, backgrounded not quarantined, repeat escalation, developer-mode retest; a report with none of the saved text in it; a generation hitting its time limit with the partial text kept and a plain-language message. (A failed load leaving the ONNX runtime unusable for the next model was seen; the fix, restarting the engine after such a failure, is covered by design and unit tests of the error handling but was not re-run against the real runtime.)

**Not run:** anything on an iPhone; GPU (hardware) inference; Safari. The earlier failures seen on the phone (303 over 300) are covered by a unit test of the trimming, not reproduced on the device.

## Manual test plan for the installed iOS app

Install to the home screen, open **Settings → On-device AI**, download the 350M (Wi-Fi), then:

1. **Short summary:** open a short saved page, tap Summarise. Expect text streaming in, then formatted bullets, and a line saying how much of the page was read.
2. **Longer article:** a long saved article. Expect "picked from across the page", at most 3 passes, no crash.
3. **Question over several saved pages:** save 3-4 pages on one topic, ask. Expect passages listed, an answer citing [1], [2], "0 B downloaded".
4. **Repeat:** ask 5 more questions, then summarise 3 pages. Watch **Status now**; nothing should pile up.
5. **Load/unload:** Unload from the AI page, ask again (loads in a few seconds), repeat 5 times.
6. **Rapid taps:** tap Ask several times quickly, and tap Summarise on two pages in a row. Earlier ones should stop or wait; the app must stay responsive.
7. **Background it:** start a summary, lock the phone or switch apps. On return the reply should say it was stopped and keep its text; the AI page should show `BACKGROUNDED` at most, and **no** model should be switched off.
8. **Offline:** turn on airplane mode, force-quit and reopen, ask a question. It must work (it did before, with the 1.2B).
9. **Worker failure:** use Reset AI engine (AI page) mid-reply; the reply should stop with a clear message and the next question should work.
10. **Interrupted run:** start a summary, then swipe the app away from the app switcher mid-reply. On the next launch expect the home screen and AI page to say the previous inference was interrupted unexpectedly (low confidence), saved pages untouched, and Ask still working. Nothing is switched off.

After any problem, **Copy report** and read it as above (or paste it to a developer). Mark results honestly: only what you ran on the phone counts.

## Known limitations

- Llama 3.2 1B: the weights are not pinned; WebLLM stores them in IndexedDB, and large shards there are untested on iOS. Pausing a download restarts the engine. See the section above.
- iOS may end the app at any time, for reasons it does not disclose; no code here can prevent that. All limits are conservative guesses, not qualified limits. The first real-device runs decide whether 220 tokens is safe, too cautious, or still too much.
- A swipe-away during generation is indistinguishable from an OS termination, so the next launch reports it as an unexplained interruption.
- Prefill is a single runtime call: it can be neither interrupted nor observed in between, so a stuck prefill is only ended by restarting the engine after the time limit.
- Memory cannot be measured on Safari; allocation numbers are estimates. Whether disposal returns GPU memory is unverified.
- The 350M/230M need WebGPU; phones without it get saved-page search only.
- The pinned ONNX Runtime is a development build. The engine files come from jsDelivr and are checksum-verified, but a runtime upgrade needs re-testing.
- The extractive summary is a heuristic: it can miss what matters on unusual pages and adds nothing about faithfulness; the model can still misstate what it was given.
- Browsers update in the background: the app needs two full close-and-reopen cycles to pick up new code; a half-updated app is detected and the AI refuses to run until it is complete.

## Next recommended steps (after real-device results)

1. Run the manual plan on an iPhone, read the reports, and tighten or relax the 350M/230M limits from evidence; promote a profile from provisional only with a record of clean runs.
2. Try the last-token transform on the 230M/1.2B in a browser (load, equality of output, timing). If it helps, offer it as a variant with a documented source of the file.
3. Add a model-in-the-loop benchmark and a faithfulness check (answer contains only supported facts) to compare 350M, 230M and 1.2B on the same fixtures.
4. Measure whether disposal frees GPU memory on Safari (run N load/unload cycles and watch for termination), and whether a newer ONNX Runtime Web build helps.

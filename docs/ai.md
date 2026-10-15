# On-device AI: safety, stability and diagnostics

This describes how the optional on-device AI is kept from destabilising the app, how it is observed, and what has and has not been verified. The app is a reader first: **with the AI off, broken or unavailable, browsing, saved pages and searching saved pages all still work.**

> iOS can end a web process without any error the page can catch. Nothing here can guarantee that never happens. The approach is to refuse work that is known or suspected to be unsafe, to stop before limits, to switch off a setup that was interrupted unexpectedly, and to record enough to explain what happened next time.

**Nothing in this document was run on an iPhone by the author of these changes.** What was run is listed under [Tests](#tests-actually-run). Real-device steps are in [the manual test plan](#manual-test-plan-for-the-installed-ios-app).

## Models

| Model | Status on a phone | Status on a computer | Weights | Needs | Phone limits (prompt / answer / total tokens, time) |
|---|---|---|---|---|---|
| LFM2.5 **350M** Instruct | provisional (default) | provisional | 258 MB (q4f16) or 297 MB (q4) | WebGPU | 220 / 80 / 280, 90 s |
| LFM2.5 **230M** Instruct | provisional (fallback) | provisional | 216 MB (q4) | WebGPU | 200 / 80 / 260, 90 s |
| LFM2.5 **1.2B** Instruct | **experimental: off until you opt in** | experimental (opt in) | 764 MB (q4f16), 854 MB (q4), 1.52 GB (8-bit, CPU) | WebGPU, or CPU on a computer | 300 / 128 / 380, 120 s |
| LFM2.5 **2.6B** | **blocked** (iOS ended the app while loading it) | experimental (opt in) | 1.53 GB | WebGPU | 600 / 200 / 700 (computer only) |
| BGE small en v1.5 | provisional | provisional | 35 MB, CPU | none | batches of 4, ≤ 1,200 characters each, ≤ 64 passages per question |

- **Provisional** means conservative limits that have **not been proven on a real device**. It is allowed to be chosen automatically; it is not a claim of safety. A smaller model is not treated as safe because it loads.
- **Experimental** runs only after you tick "Allow this experimental model to run" on its card, and is never chosen automatically.
- Every entry has a pinned commit of the Hugging Face repository. Repository ids, file names, sizes and tensor names were checked against the live repositories while writing this (see [what was measured](#what-was-measured-about-memory)).
- Previously downloaded models and all saved data are kept. A 1.2B downloaded earlier stays on the device; it just needs the opt-in before it runs.
- **Licence:** the LFM2.5 models are under the *LFM Open License 1.0* (Liquid AI; the model cards link the terms, which include conditions for commercial use). BGE small is MIT. Transformers.js and ONNX Runtime are Apache-2.0 / MIT. Models are downloaded by you, from Hugging Face, to your own device; this repository does not redistribute them.
- **No silent CPU fallback on a phone.** The 350M and 230M exports have no CPU-compatible version (the 350M's 8-bit export failed with "Could not find an implementation for GatherBlockQuantized" when tried), so without WebGPU they are simply not offered, and written answers are off. Saved pages can still be searched.

*Safety profiles are in `js/ai-policy.js` (`SAFETY`). A configuration with no entry is unsupported.*

## Safety policy

**Token budgets (fail closed).** Before any inference the engine counts the prompt with the model's own tokenizer (system prompt, chat template, sources, question and all). If counting fails, nothing runs (`TOKENIZATION_FAILED`). It then enforces `input ≤ maxInput` and `input + new ≤ maxTotal`; a request for more output is cut to what remains, and refused if that leaves less than 24 tokens. The limits asked for by the page are clamped to the model's profile again inside the engine, so a stale or modified page cannot ask for more. Ordinary settings can only lower the prompt limit. *Developer testing mode* (AI page → Safety) can raise it, and is a deliberate act.

**One operation at a time.** Loading, embedding, generating, switching models, unloading and resetting go through one scheduler (`js/ai-ops.js`) with an explicit queue (at most 8 waiting) and these states: idle, loading, embedding, generating, unloading, recovering, failed. It is used in the page and again inside the engine, so even overlapping messages cannot overlap work: two models never load together, a model is never released while it works, and a model being replaced is fully released before the next loads. A step inside an operation (generate → load the model) runs under the same lock, so there are no deadlocks. An error always releases the lock. Stop is out of band: it is never queued behind the work it stops. Reset abandons whatever is running, drops the queue and restarts the engine; a late result from the abandoned work is ignored. Rapid repeated questions replace one another instead of piling up. Auto-summaries queue behind other work.

**Preflight.** Before work starts: the model is downloaded, its profile allows this backend on this device, it is not switched off, the app is on screen, the GPU has not been lost, and the page and worker are the same build (a half-updated app gets "close and reopen" instead of a mysterious failure). Any failure is a plain-language, recoverable error.

**Foreground only.** If the app goes to the background while the AI writes, the AI is stopped and the text so far is kept, labelled incomplete.

**Memory habits.** One model is resident at a time. BGE is released (disposed) as soon as retrieval finishes, before a chat model loads. Phone models are released two minutes after last use (1.2B: one minute), and straight after a prompt above 85% of the limit. A model that fails to release cleanly causes the whole engine to be restarted rather than reused. The engine is also restarted after a lost GPU, a suspected memory failure, a hung call or a failed load. The AI never runs on the page itself on a phone (it would freeze the screen and is not qualified): if the worker cannot start, the AI is off.

**Checkpoints, crash diagnosis and quarantine.** Before each risky stage the page writes a small versioned checkpoint to `localStorage` (a synchronous call, though the browser may flush it to disk a moment later, so the last instants before a sudden kill can be lost): session, operation, operation type, model, revision, backend, weights, token counts, stage, start and last-progress times, visibility and time spent hidden, runtime build. It is removed when the operation ends. If one is found at the next launch it is **classified, not assumed to be a crash**:

| Diagnosis | When | Held against the model? |
|---|---|---|
| `GPU_DEVICE_LOST` | the engine reported the GPU lost before the app ended | no |
| `APP_CLOSED` | the page reported it was being closed | no |
| `BACKGROUNDED` | the app had been in the background during the work | no |
| `UNEXPECTED_INTERRUPTION` (low confidence) | foreground, in a memory-heavy stage, nothing reported, first time | **yes: that configuration is switched off** |
| `POSSIBLE_MEMORY_EXHAUSTION` (medium) | the same, and the same configuration was interrupted that way before | yes |
| `UNEXPECTED_INTERRUPTION` (low) | a stage that uses little memory, or an older marker | no |

The message never claims a cause it cannot show: "*Previous inference was interrupted unexpectedly. iOS did not provide a termination reason.*" A swipe-away from the app switcher mid-generation looks the same as an unexplained termination, so a rare false quarantine is possible; it costs one tap in developer mode to undo. A switched-off configuration (model + pinned revision + backend + weights) stays off across launches, stops automatic summaries, and is shown on the AI page with the reasons. **Retrying it needs a deliberate act:** developer testing mode on, then "Allow a retest". Saved pages, summaries and downloads are untouched. Nothing automatically repeats the operation that preceded the interruption.

**If no safe model is available**, Ask shows the closest passages from saved pages and searches (keyword, plus meaning if BGE is allowed) with their sources, and says why no written answer is offered. It does not try another unvalidated model.

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

**Events** (all carry `sid` session, `op` operation, `parent`, model `pkg`/`rev`, `dtype`, `backend`, `mode`, `stage`, `code`, timings, and `m` metrics): `ai.operation.queued/started/stage/completed/failed/cancelled/timeout/abandoned`, `ai.model.load.started/completed`, `ai.prompt.tokenized`, `ai.inference.prefill.started`, `ai.inference.first_token`, `ai.inference.completed/failed/stop_requested`, `ai.model.dispose.started/completed/failed`, `ai.retrieval.completed`, `ai.ui.render`, `ai.worker.started/initialised/responsive/busy/unresponsive/terminated/restarted/reset/gpu_lost/version_mismatch`, `ai.recovery.interrupted`, `ai.quarantine.added/released`, `ai.app.visibility`, `ai.checkpoint.stale_cleared`, `ai.engine.overlap`, `ai.storage.vectors_discarded`.

**Recorded per generation:** load time and mode, input tokens (exact), allowed budget, tokenizing time, time to first token (prefill is *inferred* to end at the first token: the runtime reports nothing in between), tokens, tokens/s, requested vs actual output, stop reason (`eos`, `length`, `stopped`, `timeout`, `error`), queue wait. **Per retrieval:** index build/reuse, keyword time, BGE load and embed time, new vs cached vectors, ranking and fusion time, passages considered/selected/excluded/excerpted. **Resources:** dispose time, worker starts/terminations/resets, GPU loss, queue depth, device and adapter limits, and the memory indicators that exist (otherwise "unavailable"). Allocation sizes are in the report under *Expected allocations (estimates)*, separate from measurements.

**Error codes:** `MODEL_NOT_INSTALLED, MODEL_NOT_ENABLED, MODEL_QUARANTINED, MODEL_LOAD_FAILED, MODEL_INCOMPATIBLE, GPU_UNAVAILABLE, GPU_DEVICE_LOST, TOKEN_BUDGET_EXCEEDED, TOKENIZATION_FAILED, INFERENCE_FAILED, INFERENCE_TIMEOUT, WORKER_FAILED, WORKER_UNRESPONSIVE, MODEL_DISPOSE_FAILED, STORAGE_ERROR, POSSIBLE_MEMORY_EXHAUSTION, UNEXPECTED_INTERRUPTION` (plus `NOT_FOREGROUND, BACKGROUNDED, VERSION_MISMATCH, QUEUE_FULL, CANCELLED`). A code is only assigned when the error text or the stage supports it; otherwise `UNKNOWN`. Original messages and stacks are kept.

**Worker health:** states none → starting → initialised → responsive ⇄ busy → unresponsive/terminated → restarted. An *idle* worker answers a ping at once, so a ping before a model loads tells a dead worker from a busy one; a busy worker is judged by phase (load: 4 min; generation: the profile's time limit + 20 s). A worker that cannot be stopped is terminated and recreated.

**AI page** (Settings → On-device AI): live status (state, current stage, queue, engine, what is in memory, health, what is switched off), last inference, performance (medians), recent failures and recovery actions, safety profiles and estimates, the log, Copy report / Copy as JSON, Reset AI engine, Clear log. Source text goes into a report only if you tick the opt-in box (kept in memory only; never stored).

### Reading a report

1. **LAST INTERRUPTION AT LAUNCH** says what the previous run left behind, its category, confidence and the reasons. `BACKGROUNDED`/`APP_CLOSED` are normal. `UNEXPECTED_INTERRUPTION` + `stage: prefill` + `input 180` means the app ended while the model read a 180-token prompt.
2. **RECENT EVENTS** (newest first): find the `op=` of the failed operation and read its events in order. The last `stage=` before silence is where it stopped. A `ai.operation.failed` carries the stage it failed in.
3. **QUARANTINE / CONFIGURATION HISTORY** shows ok / failed / unexplained counts per setup. Several unexplained interruptions at the same stage and input size point at a limit; a spread of stages points elsewhere.
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
SAFETY PROFILES (this device class)
  lfm350: provisional · input ≤ 220, new ≤ 80, total ≤ 280, time ≤ 90 s
QUARANTINE
  lfm350@d11593fd|webgpu|q4: UNEXPECTED_INTERRUPTION (low)
LAST INTERRUPTION AT LAUNCH
  UNEXPECTED_INTERRUPTION (confidence low) · quarantined: yes
  Previous inference was interrupted unexpectedly (LFM2.5 350M (generate), last stage "prefill"). iOS did not provide a termination reason.
  last stage: prefill · model lfm350 q4/webgpu · input 180 tokens, output budget 60
  - the app was in the foreground and nothing was reported
  - first time this configuration was interrupted
RECENT EVENTS (newest first)
… ERROR ai.inference.failed op=op7 lfm350 stage=prefill code=INFERENCE_TIMEOUT LFM2.5 350M: Stopped after 90 s {"inputTokens":187,"tokens":4}
… OK    ai.inference.first_token op=op8 stage=first_token First token after 69878 ms
… INFO  ai.prompt.tokenized op=op8 Prompt is 187 tokens (limit 300); up to 50 may be written (total limit 380)
```

(Separately, during testing the harness did kill the browser mid-generation once, and the next launch diagnosed and quarantined it as shown: the mechanism worked as designed.)

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
- A model-based benchmark (summaries and questions through the loaded model on the device, with the same fixtures) should be run from the AI page in developer mode on the phone; the events above (`ai.inference.completed`, `ai.retrieval.completed`) carry the numbers.

## Tests actually run

`npm test` (`node --test`): **96 tests, all passing**, in Node. They cover the catalog and pinned revisions; token budgets (null/NaN/over-limit/combined-limit, clamping); the 303-over-300 case; concurrency in the scheduler and in the engine with a fake runtime (simultaneous generations, generation during embed or load, model switching, release during generation, stop while running / queued / embedding, worker exceptions, GPU loss, tokenizer failure, disposal failure, background refusal, a failure not locking the queue); quarantine and opt-in rules; interruption classification (foreground, repeated, backgrounded, closed, GPU lost, legacy marker); logging (unique ids, stage order, parent/child, failures keep stage, no source text, bounded storage, store failures harmless); report layout; summary selection and planning; retrieval budgeting (huge first passage, duplicates, per-page cap, late-page text findable, snippet replaced by saved page, damaged vectors); the incremental index against a full rebuild.

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
10. **Interrupted run:** start a summary, then swipe the app away from the app switcher mid-reply. On the next launch expect the home screen and AI page to say the previous inference was interrupted unexpectedly (low confidence), that model switched off, saved pages untouched, and Ask still listing passages. Then retest in developer mode.

After any problem, **Copy report** and read it as above (or paste it to a developer). Mark results honestly: only what you ran on the phone counts.

## Known limitations

- iOS may end the app at any time, for reasons it does not disclose; no code here can prevent that. All limits are conservative guesses, not qualified limits. The first real-device runs decide whether 220 tokens is safe, too cautious, or still too much.
- A swipe-away during generation is indistinguishable from an OS termination, so it can cause a (reversible) quarantine.
- Prefill is a single runtime call: it can be neither interrupted nor observed in between, so a stuck prefill is only ended by restarting the engine after the time limit.
- Memory cannot be measured on Safari; allocation numbers are estimates. Whether disposal returns GPU memory is unverified.
- The 350M/230M need WebGPU; phones without it get saved-page search only.
- The pinned ONNX Runtime is a development build. The engine files come from jsDelivr and are checksum-verified, but a runtime upgrade needs re-testing.
- The extractive summary is a heuristic: it can miss what matters on unusual pages and adds nothing about faithfulness; the model can still misstate what it was given.
- Browsers update in the background: the app needs two full close-and-reopen cycles to pick up new code; a half-updated app is detected and the AI refuses to run until it is complete.

## Next recommended steps (after real-device results)

1. Run the manual plan on an iPhone, read the reports, and tighten or relax the 350M/230M limits from evidence; promote a profile from provisional only with a record of clean runs.
2. Try the last-token transform on the 230M/1.2B in a browser (load, equality of output, timing). If it helps, offer it as an opt-in variant with a documented source of the file.
3. Add a model-in-the-loop benchmark and a faithfulness check (answer contains only supported facts) to compare 350M, 230M and 1.2B on the same fixtures.
4. Measure whether disposal frees GPU memory on Safari (run N load/unload cycles and watch for termination), and whether a newer ONNX Runtime Web build helps.

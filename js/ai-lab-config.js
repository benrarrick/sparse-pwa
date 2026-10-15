// AI lab: the seven experiments and the one shared prompt. Experimental and separate from the app's AI.
export const TJS_VERSION = '4.3.0';
export const WEBLLM_VERSION = '0.2.86';
export const MAX_NEW = 180;
export const SYSTEM = 'You are a careful assistant. Follow the formatting instructions exactly.';
export const PROMPT = `You have 2,000 MB of storage for an offline travel app and must keep at least 100 MB free. Two downloads are required: maps (900 MB plus a mandatory 200 MB update) and an emergency guide (260 MB). You may also install optional packs: weather (620 MB, value 8 points), photos (480 MB, value 5 points), and language (290 MB, value 4 points). Packs cannot be split, and nothing can be downloaded during the trip.

Which optional pack or combination should you install to maximize total value while obeying every constraint? Show the arithmetic, explain why the most tempting higher-value combination fails, and identify one limitation of your recommendation.

Respond in exactly three numbered lines, using fewer than 110 words.`;

// phone: true = in the short list the lab shows by default (small WebLLM models that have a chance on an iPhone); #/ai-lab?all shows every experiment.
// kind 'tjs' = Transformers.js + ONNX Runtime WebGPU; 'webllm' = WebLLM (MLC, WebGPU).
// `mb` is the approximate download, shown for information only.
export const EXPERIMENTS = [
  {
    n: 1,
    label: 'LFM2.5 1.2B, ONNX q4f16, last-token logits',
    kind: 'tjs',
    repo: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    dtype: 'q4f16',
    mb: 760,
    // the original graph computes scores for every prompt position; ours (tools/add_logits_to_keep.py) only for the last
    // one, and refers to the original weights file. Served from this site instead of Hugging Face:
    graphOverride: { 'onnx/model_q4f16.onnx': 'lab/lfm25-1.2b-q4f16-last.onnx' },
  },
  { n: 2, label: 'Qwen3.5 0.8B, ONNX q4', kind: 'tjs', repo: 'onnx-community/Qwen3.5-0.8B-ONNX-OPT', dtype: 'q4', mb: 650 },
  { n: 3, label: 'Granite 4.0 1B, ONNX q4f16', kind: 'tjs', repo: 'onnx-community/granite-4.0-1b-ONNX-web', dtype: 'q4f16', mb: 1250 },
  { n: 4, label: 'Qwen3 1.7B, ONNX q4f16', kind: 'tjs', repo: 'onnx-community/Qwen3-1.7B-ONNX', dtype: 'q4f16', mb: 1430 },
  { n: 5, label: 'Llama 3.2 1B, WebLLM q4f16_1', kind: 'webllm', modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', mb: 700, phone: true },
  { n: 6, label: 'SmolLM2 1.7B, WebLLM q4f16_1', kind: 'webllm', modelId: 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', mb: 950 },
  { n: 7, label: 'Gemma 4 E2B, ONNX q4f16 (text only)', kind: 'tjs', repo: 'onnx-community/gemma-4-E2B-it-ONNX', dtype: 'q4f16', mb: 3100 },
  // q4 not q4f16, like experiment 2: the 0.8B q4f16 printed only "!" on the desktop GPU tested (#/ai-lab?dtype=q4f16 to try it)
  { n: 8, label: 'Qwen3.5 2B OPT, ONNX q4', kind: 'tjs', repo: 'onnx-community/Qwen3.5-2B-ONNX-OPT', dtype: 'q4', mb: 1540 },
  // always reasons before answering (<think>…</think>), so it is given a much larger token budget
  { n: 9, label: 'LFM2.5 1.2B Thinking, ONNX q4f16', kind: 'tjs', repo: 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX', dtype: 'q4f16', mb: 760, thinking: true },
  { n: 10, label: 'Qwen3.5 2B, WebLLM q4f32_1', kind: 'webllm', modelId: 'Qwen3.5-2B-q4f32_1-MLC', mb: 1080, noThink: true },
  { n: 11, label: 'Qwen3.5 0.8B, WebLLM q4f16_1', kind: 'webllm', modelId: 'Qwen3.5-0.8B-q4f16_1-MLC', mb: 410, noThink: true, phone: true },
  { n: 12, label: 'Gemma 3 1B, WebLLM q4f16_1', kind: 'webllm', modelId: 'gemma3-1b-it-q4f16_1-MLC', mb: 600, phone: true, chatOpts: { context_window_size: -1, sliding_window_size: 512, attention_sink_size: 0 } },
];
export const THINKING_NEW = 1200; // token budget for a model that reasons first

#!/usr/bin/env python3
"""Rewrites an LFM2.5 ONNX graph so it computes scores (logits) only for the last N prompt positions.

Why: the 230M and 1.2B exports have no `num_logits_to_keep` input, so the final projection runs over
every prompt position and produces [batch, sequence, vocab] scores. Liquid AI's own 350M and 2.6B exports
do it differently, and this script applies the same three nodes to a graph that lacks them:

    num_logits_to_keep ─ Neg ─ Unsqueeze(axis 0) ─ Slice(final_norm_output, starts=-k, ends=INT_MAX, axes=[1]) ─ lm_head

Only the small graph file (the .onnx, 150-190 KB) changes. The weights file (.onnx_data) is untouched and
is referenced by the same name, so the result is used with the original weights.

Usage:
  python tools/add_logits_to_keep.py model_q4.onnx model_q4_last.onnx
  python tools/add_logits_to_keep.py model_q4.onnx model_q4_last.onnx --verify   # needs model_q4.onnx_data beside it, onnxruntime, numpy

--verify runs the original and the rewritten graph on the same random prompt (CPU) and checks that the
rewritten graph's scores equal the LAST position's scores of the original, and that k=1 and k=5 both work.
The rewritten file is NOT used by the app. Shipping it would mean hosting a modified copy of the model
(see the model licence) and adding it to the catalog as an opt-in variant after testing on a device.
"""
import argparse
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper


def rewrite(model: onnx.ModelProto) -> onnx.ModelProto:
    g = model.graph
    if any(i.name == "num_logits_to_keep" for i in g.input):
        raise SystemExit("This graph already has num_logits_to_keep; nothing to do.")
    out = next(o for o in g.output if o.name == "logits")
    producers = {o: n for n in g.node for o in n.output}
    # the node that makes the scores: either the head MatMul itself, or a Cast of its result
    head = producers[out.name]
    cast = None
    if head.op_type == "Cast":
        cast, head = head, producers[head.input[0]]
    if head.op_type not in ("MatMulNBits", "MatMul"):
        raise SystemExit(f"Unexpected final node {head.op_type}; this script knows MatMulNBits/MatMul heads.")
    hidden = head.input[0]  # [batch, sequence, hidden]

    g.input.append(helper.make_tensor_value_info("num_logits_to_keep", TensorProto.INT64, []))
    g.initializer.extend(
        [
            helper.make_tensor("lk_axis0", TensorProto.INT64, [1], [0]),
            helper.make_tensor("lk_axis1", TensorProto.INT64, [1], [1]),
            helper.make_tensor("lk_end", TensorProto.INT64, [1], [2147483647]),
        ]
    )
    neg = helper.make_node("Neg", ["num_logits_to_keep"], ["lk_neg"], name="/lm_head/num_logits_to_keep/Neg")
    uns = helper.make_node("Unsqueeze", ["lk_neg", "lk_axis0"], ["lk_start"], name="/lm_head/num_logits_to_keep/Unsqueeze")
    sl = helper.make_node("Slice", [hidden, "lk_start", "lk_end", "lk_axis1"], ["lk_hidden"], name="/lm_head/num_logits_to_keep/Slice")
    head.input[0] = "lk_hidden"
    # new nodes go right before the head, keeping the graph topologically sorted
    idx = list(g.node).index(head)
    for k, n in enumerate([neg, uns, sl]):
        g.node.insert(idx + k, n)
    # the output's sequence dimension is now "num_logits_to_keep"
    dims = out.type.tensor_type.shape.dim
    dims[1].ClearField("dim_value")
    dims[1].dim_param = "num_logits_to_keep"
    return model


def zero_inputs(model, ids, k):
    """Inputs for a first pass over `ids` with empty caches (what the app does for a prompt)."""
    feeds = {}
    n = len(ids)
    for i in model.graph.input:
        shape = [d.dim_value if d.dim_value else None for d in i.type.tensor_type.shape.dim]
        dt = {TensorProto.FLOAT: np.float32, TensorProto.FLOAT16: np.float16, TensorProto.INT64: np.int64}[i.type.tensor_type.elem_type]
        if i.name == "input_ids":
            feeds[i.name] = np.array([ids], dtype=np.int64)
        elif i.name == "attention_mask":
            feeds[i.name] = np.ones((1, n), dtype=np.int64)
        elif i.name == "position_ids":
            feeds[i.name] = np.arange(n, dtype=np.int64)[None]
        elif i.name == "num_logits_to_keep":
            feeds[i.name] = np.array(k, dtype=np.int64)
        else:  # past_conv.* [batch, dim, 3] and past_key_values.* [batch, heads, 0, head_dim]
            dims = [1 if s is None and j == 0 else (0 if s is None else s) for j, s in enumerate(shape)]
            feeds[i.name] = np.zeros(dims, dtype=dt)
    return feeds


def verify(src, dst):
    import onnxruntime as ort

    a = ort.InferenceSession(src, providers=["CPUExecutionProvider"])
    b = ort.InferenceSession(dst, providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    ids = rng.integers(10, 60000, size=23).tolist()
    old = a.run(["logits"], zero_inputs(onnx.load(src, load_external_data=False), ids, 0))[0]
    print("original logits shape:", old.shape)
    for k in (1, 5):
        new = b.run(["logits"], zero_inputs(onnx.load(dst, load_external_data=False), ids, k))[0]
        want = old[:, -k:, :]
        err = float(np.abs(new.astype(np.float32) - want.astype(np.float32)).max())
        same_top = bool((new.argmax(-1) == want.argmax(-1)).all())
        print(f"k={k}: new shape {new.shape}, max abs difference {err:.3g}, same top token: {same_top}")
        if new.shape != want.shape or err > 1e-3 or not same_top:
            sys.exit(f"FAILED for k={k}")
    print("OK: the rewritten graph returns exactly the last k positions of the original's scores.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--verify", action="store_true")
    a = ap.parse_args()
    m = onnx.load(a.src, load_external_data=False)  # the weights stay where they are
    onnx.save(rewrite(m), a.dst)
    print(f"wrote {a.dst} (graph only; keep it beside the original {a.src.split('/')[-1]}_data)")
    if a.verify:
        verify(a.src, a.dst)

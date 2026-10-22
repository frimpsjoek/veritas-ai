"""snowflake-arctic-embed-s on the GPU with MLX, using the weights in the ONNX file (no second download).

The ONNX export leaves the matrix weights unnamed, so each MatMul weight is matched to its layer through the
named bias added right after it. `check()` compares the output with onnxruntime.
"""
from __future__ import annotations

from pathlib import Path

import mlx.core as mx
import numpy as np

MODEL_DIR = Path(__file__).resolve().parent / "models" / "snowflake-arctic-embed-s"
WEIGHTS = MODEL_DIR / "mlx-weights.npz"
LAYERS, HEADS, HIDDEN, EPS = 12, 12, 384, 1e-12


def extract() -> dict[str, np.ndarray]:
    import onnx
    from onnx import numpy_helper

    model = onnx.load(str(MODEL_DIR / "onnx" / "model.onnx"))
    inits = {i.name: numpy_helper.to_array(i) for i in model.graph.initializer}
    weights = {k: v for k, v in inits.items() if not k.startswith("onnx::")}
    consumers: dict[str, list] = {}
    for node in model.graph.node:
        for name in node.input:
            consumers.setdefault(name, []).append(node)
    for node in model.graph.node:
        if node.op_type != "MatMul":
            continue
        matrix = next((n for n in node.input if n in inits and n.startswith("onnx::")), None)
        if matrix is None:
            continue
        for add in consumers.get(node.output[0], []):
            bias = next((n for n in add.input if n.endswith(".bias") and n in weights), None)
            if add.op_type == "Add" and bias:
                weights[bias.removesuffix(".bias") + ".weight"] = inits[matrix]  # [in, out], used as x @ W
    return weights


def load() -> dict[str, mx.array]:
    if not WEIGHTS.exists():
        np.savez(WEIGHTS, **extract())
    return {k: mx.array(v) for k, v in np.load(WEIGHTS).items()}


def layer_norm(x: mx.array, w: mx.array, b: mx.array) -> mx.array:
    return mx.fast.layer_norm(x, w, b, EPS)


class ArcticMLX:
    def __init__(self) -> None:
        # Half precision: ~50% faster than float32 on the GPU; vectors match float32 at cosine >= 0.9993.
        self.w = {name: weight.astype(mx.float16) for name, weight in load().items()}
        needed = [f"encoder.layer.{i}.{p}.weight" for i in range(LAYERS) for p in
                  ("attention.self.query", "attention.self.key", "attention.self.value", "attention.output.dense",
                   "intermediate.dense", "output.dense")]
        missing = [n for n in needed if n not in self.w]
        if missing:
            raise RuntimeError(f"weights not mapped: {missing[:3]}")
        # Every batch shape leaves buffers in MLX's cache; uncapped, that grew to 11 GB over one indexing run.
        mx.set_cache_limit(128 << 20)

    def forward(self, ids: mx.array, mask: mx.array) -> mx.array:
        w = self.w
        batch, length = ids.shape
        x = w["embeddings.word_embeddings.weight"][ids] + w["embeddings.position_embeddings.weight"][:length] \
            + w["embeddings.token_type_embeddings.weight"][0]
        x = layer_norm(x, w["embeddings.LayerNorm.weight"], w["embeddings.LayerNorm.bias"])
        bias = ((1.0 - mask[:, None, None, :].astype(mx.float32)) * -1e9).astype(x.dtype)
        head = HIDDEN // HEADS
        for i in range(LAYERS):
            p = f"encoder.layer.{i}."

            def lin(h, name):
                return h @ w[p + name + ".weight"] + w[p + name + ".bias"]

            def split(h):
                return h.reshape(batch, length, HEADS, head).transpose(0, 2, 1, 3)

            q, k, v = (split(lin(x, f"attention.self.{n}")) for n in ("query", "key", "value"))
            attn = mx.fast.scaled_dot_product_attention(q, k, v, scale=head ** -0.5, mask=bias)
            attn = attn.transpose(0, 2, 1, 3).reshape(batch, length, HIDDEN)
            x = layer_norm(x + lin(attn, "attention.output.dense"), w[p + "attention.output.LayerNorm.weight"],
                           w[p + "attention.output.LayerNorm.bias"])
            h = lin(x, "intermediate.dense")
            h = 0.5 * h * (1 + mx.erf(h / np.sqrt(2.0)))  # exact GELU, as in BERT
            x = layer_norm(x + lin(h, "output.dense"), w[p + "output.LayerNorm.weight"], w[p + "output.LayerNorm.bias"])
        cls = x[:, 0]
        return cls / mx.maximum(mx.linalg.norm(cls, axis=1, keepdims=True), 1e-9)

    def __call__(self, ids: np.ndarray, mask: np.ndarray) -> np.ndarray:
        out = self.forward(mx.array(ids.astype(np.int32)), mx.array(mask.astype(np.int32)))
        result = np.array(out.astype(mx.float32))
        mx.clear_cache()
        return result


def check() -> None:
    import time

    import kb

    kb.USE_MLX = False
    texts = ["Swift concurrency with actors and Sendable", "lorem ipsum dolor sit amet " * 60,
             "How banks create money by lending", "MACE polarisable foundation model"] * 8
    cpu = kb.Embedder()
    ref = cpu(texts)
    kb.USE_MLX = True
    gpu = kb.Embedder()
    got = gpu(texts)
    cos = (ref * got).sum(axis=1)
    print(f"min cosine vs onnxruntime {cos.min():.6f}")
    long = ["lorem ipsum dolor sit amet consectetur " * 40] * 256
    start = time.time()
    gpu(long)
    print(f"GPU: {256 / (time.time() - start):.0f} long chunks/s")
    import random
    import resource
    random.seed(0)
    for _ in range(40):  # many different batch shapes, as in a real run
        gpu(["word " * random.randint(5, 450) for _ in range(16)])
    print(f"peak MLX memory {mx.get_peak_memory() / 2**20:.0f} MB, "
          f"max RSS {resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20:.0f} MB")


if __name__ == "__main__":
    check()

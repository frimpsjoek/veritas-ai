# Spec 036: a knowledge-base build twice as fast with half the memory

Status: APPROVED 2026-11-21 (user: "optimize it until we have twice the speed and half the memory", /goal).

## What happens today (measured 2026-11-21, M4 Pro, 14 cores, 48 GB)

A build has two stages (`kb._index_stages`): stage 1 reads notes, PDFs and Zotero into text and the keyword index;
stage 2 (`kb.embed_pending`) makes a vector for every passage. The user's index: 4,583 documents, 95,090 passages
(median 326 tokens, 13% over the 512 limit).

- Stage 1, full build: 15 s, 300 MB (`bench_index.py text`).
- Stage 2, as the app runs it (onnxruntime on the CPU, 4 threads, batches of 16): 30.3 passages/s, peak 2,433 MB
  (`bench_index.py embed --sample 1000`, real path). The whole library: ~52 min.

Stage 2 is the whole cost. Where it goes (fixed 1,024-passage sample, one process per configuration; footprint is
the peak physical footprint, the figure Activity Monitor shows, which also counts GPU memory):

| configuration | passages/s | CPU ms/passage | peak footprint | min cosine to today |
|---|---|---|---|---|
| today: ONNX, batch 16 | 33 | 120 | 2,379 MB | 1 |
| ONNX batch 8 | 35 | 114 | 1,579 MB | 1 |
| ONNX fused (Attention, SkipLayerNorm, BiasGelu), batch 8 | 40 | 99 | 928 MB | 1 |
| ONNX int8 (dynamic, per tensor / per channel) | 35 | 114 | 1,540 MB | 0.87 / 0.99 |
| ONNX + CoreML | 7 | - | 24,045 MB | 1 |
| ONNX, 8 threads | 42 | 182 | 1,670 MB | 1 |
| MLX on the GPU (half precision), batch 64, as in `mlx_embed.py` | 132 | 5 | 1,899 MB | 0.9992 |
| MLX, batch 8, each layer evaluated before the next | 142 | 1.5 | 512 MB | 0.9992 |

Rejected: int8 (no speed on this CPU, vectors change), CoreML (slower, 24 GB), more threads (speed only by burning
more CPU, the opposite of "fewer resources").

## Goals

- R1. `server/bench_index.py` measures a build on a copy of the index (never the live one): `embed` (the real
  `embed_pending` path on a seeded sample) and `text` (stage 1), with passages/s, CPU time and peak footprint.
- R2. On a Mac with Apple Silicon the desktop app embeds with MLX on the GPU (`KB_BACKEND=mlx`), in batches of 8,
  evaluating one layer at a time (a lazy 12-layer graph kept every layer's attention alive: 1 GB a batch). If MLX
  cannot start, onnxruntime is used as today. The MLX weights come from the model folder the app downloads
  (`paths.models_dir`), not the source folder.
- R3. Everywhere else (and as the fallback) onnxruntime runs a fused copy of the model (`model-fused.onnx`, made once
  next to the model with onnxruntime's transformer optimizer, kept only if its vectors match the original at cosine
  >= 0.9999 on a probe), in batches of 8.
- R4. Passages with the same text are embedded once per run (6% of the user's passages repeat one exactly).
- R5. Vectors stay compatible: a new build or a partial re-embed mixes with existing vectors (min cosine to today's
  >= 0.999), so no re-embedding of the library is needed.
- R6. The app bundles what R2 and R3 need (mlx on macOS arm64, onnx everywhere).

## Goal and kill criteria

Fixed before results: on the user's machine, `bench_index.py embed --sample 3000 --seed 0` with the app's backend
must reach >= 2x today's passages/s and <= 0.5x today's peak footprint (the today figure re-measured with the same
script), with min cosine >= 0.999. The ONNX path must not get slower or use more memory than today. If MLX cannot
be bundled in the frozen app, R2 is dropped and the result reported honestly (R3 alone: ~1.3x speed, ~0.4x memory).

## Not in scope

- Stage 1 (15 s of a 52 min build).
- A different embedding model, or truncating passages differently (both change search results).

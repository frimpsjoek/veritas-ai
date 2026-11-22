# Spec 036 validation

Machine: M4 Pro (14 cores), 48 GB, macOS; load average 12-24 during the runs (Spotlight and media analysis after a
restart). Index: the user's (95,090 passages), copied for every run. "today" = the code at git HEAD before this
change, run from `git archive HEAD server`.

## Goal gate: `bench_index.py embed --sample 3000 --seed 0`

| run | backend | passages/s | CPU s | peak footprint | x today speed | x today memory |
|---|---|---|---|---|---|---|
| today | onnx (app) | 31.4 | 370 | 2,281 MB | 1 | 1 |
| new, first run (makes the fused model) | onnx | 34.2 | 328 | 1,944 MB | 1.09 | 0.85 |
| new | onnx | 33.9 | 343 | 883 MB | 1.08 | 0.39 |
| new, first run (makes mlx-weights.npz) | mlx | 125.4 | 6.3 | 854 MB | 4.0 | 0.37 |
| **new** | **mlx (the app on Apple Silicon)** | **127.1** | **6.2** | **516 MB** | **4.0** | **0.23** |

Goal (>= 2x speed, <= 0.5x memory, with the app's backend): **met on a Mac with Apple Silicon** (4.0x, 0.23x).
The ONNX path (Windows, Linux, and the fallback): memory 0.39x, speed 1.08x; not slower, not more memory (R3 as
specified); doubling there would need a GPU or a smaller model (out of scope).

## Other rows

| ID | Check | Expected | Actual (2026-11-21) |
|----|-------|----------|---------------------|
| R1 | `bench_index.py embed` / `text` on copies | live index untouched; JSON per run | as above; text stage 15.1 s, 300 MB |
| R2 | frozen app: `packaging/pyinstaller/build.sh` spec, `veritas-server index` with KB_BACKEND=mlx on a copy with 3,000 vectors removed | embeds on the GPU | 3,000 embedded in 22.8 s, 3.2 s user CPU (GPU); binary 141 MB (was 51 MB) |
| R2 | MLX each layer evaluated (`mlx_embed.forward`) | footprint of a batch of 8 drops | MLX peak 996 MB -> 277 MB a batch |
| R3 | `test_the_fused_model_is_made_once_when_its_vectors_match`, `..._differs_is_not_used...`, `test_no_onnx_package_keeps_the_original` | fused used only when it matches; retried after a code update | pass |
| R3 | `test_the_real_fused_model_gives_the_same_vectors` (needs the model and onnx+sympy) | cosine >= 0.9999 | pass |
| R4 | `test_a_repeated_passage_is_embedded_once_and_every_copy_gets_its_vector` | each distinct text embedded once, copies share vectors, batches of EMBED_BATCH | pass |
| R5 | re-embedded 3,000 passages vs the live index (cosine) | >= 0.999 | onnx min 1.0000, mlx min 1.0000 (mean 0.999999) |
| R6 | `pytest -q tests/` with requirements.txt (mlx, onnx, sympy) | pass | 630 passed, 3 skipped |
| R6 | `pytest -q tests/` in the old environment (no mlx, onnx, sympy) | pass (fallbacks) | 629 passed, 4 skipped |
| app | the released app indexes with MLX | GPU used | Not run: needs the release from this commit |

Rejected on measurement (spec table): int8 (no speed on this CPU, vectors 0.87-0.99), CoreML (7/s, 24 GB), more
threads (speed only by more CPU).

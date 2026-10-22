# Real-model checks for spec 010 (local models)

Nothing in this spec has been run against a real model: the unit tests use a fake OpenAI-compatible server and a fake
process. This is the runbook for the person who does the real check. Do it on a quiet Mac (close the heavy apps first:
Woof 4B needs about 5 GB free), one step at a time, and stop at the first step that fails.

Facts used below (checked 2026-10-02 against the files, not by running a model):

- Python: `~/woof-bench/.venv/bin/python` (arm64, mlx-lm 0.31.3). Never `python3` from PATH (x86_64 under Rosetta).
- Models: `/Volumes/Content/models/ConwayResearch/Underdog-Woof-4B-1.1` (default), `.../Underdog-Woof-2B-1.1`,
  `/Volumes/Content/models/mlx-community/Qwen3.5-4B-MLX-4bit`, plus the HF cache copies under
  `/Volumes/Content/Offload/dev/cache/huggingface/hub`.
- `mlx_lm.server` accepts `--chat-template-args '{"enable_thinking":false}'` and a per-request `chat_template_kwargs` field.
  Second Brain sends both.

## 0. Before you start

```bash
# The Content drive must be mounted (the status line says so plainly when it is not)
ls /Volumes/Content/models/ConwayResearch/

# Free memory and swap BEFORE (write these down)
vm_stat | head -5
sysctl vm.swapusage
memory_pressure | tail -3
ps -o rss,command -ax | grep -E "mlx_lm|agentd" | grep -v grep     # expect nothing for mlx_lm
```

## 1. The server alone (no Second Brain)

```bash
PORT=8791
~/woof-bench/.venv/bin/python -m mlx_lm.server \
  --model /Volumes/Content/models/ConwayResearch/Underdog-Woof-4B-1.1 \
  --host 127.0.0.1 --port $PORT --temp 0 --max-tokens 600 \
  --chat-template-args '{"enable_thinking":false}' --log-level WARNING &
SERVER_PID=$!
# wait until it answers (the first load reads about 4 GB from the Content drive)
until curl -sf http://127.0.0.1:$PORT/v1/models >/dev/null; do sleep 1; done; echo up
ps -o rss=,command= -p $SERVER_PID          # resident memory after load
```

Expected: `up` within about 10-60 s; RSS roughly the model size (about 3-5 GB).

## 2. One grounded question, thinking really off

```bash
curl -s http://127.0.0.1:$PORT/v1/chat/completions -H 'content-type: application/json' -d '{
  "model": "/Volumes/Content/models/ConwayResearch/Underdog-Woof-4B-1.1",
  "stream": false, "temperature": 0, "max_tokens": 600,
  "chat_template_kwargs": {"enable_thinking": false},
  "messages": [
    {"role": "system", "content": "Answer only from the numbered passages below. Cite as [@key]. If they do not answer, say so.\n\n1. [@smith2020] Smith on sleep (2020)\nSmith found a 12% gain in delayed recall after one night of extended sleep in 42 adults."},
    {"role": "user", "content": "What did Smith find?"}
  ]}' | python3 -m json.tool | head -30
```

Expected: a short answer that cites `[@smith2020]`, mentions 12%, and contains no `<think>` text. `usage.completion_tokens`
well under 600. If the answer starts with a long reasoning passage, thinking is NOT off: stop here and tell the
author which model (the template may use a different switch than `enable_thinking`).

Then the "no answer in the passages" case: ask `Who won the 1998 World Cup?` with the same system message. Expected:
it says the passages do not answer. Note any invented answer (that is the known failure; the app still shows the
passages and flags citations outside them).

Stop it: `kill $SERVER_PID; wait $SERVER_PID 2>/dev/null`. Memory should return near the "before" numbers within a few seconds.

## 3. Through Second Brain (after the unit builds have been installed by the owner)

Not run by the author. When the owner has built and installed (the author did not build or install anything):

1. Open the chat. The controls row shows an "Answer with" button reading `Cloud`. Open it: Cloud, then an "On this Mac"
   group listing the Woof models and the others found (no ASR / embedding / whisper / pii models), a line like
   `5 models found.`, and the honest note. Unplug or unmount the Content drive and reopen: the line says
   `The Content drive isn't connected, so its models can't be used.` and the disk models are gone.
2. Pick `Underdog Woof 4B 1.1`. The button reads `On this Mac: Underdog Woof 4B 1.1`. In Settings, Chat and Ask show "On this Mac".
   No `mlx_lm` process exists yet: `pgrep -fl mlx_lm.server` prints nothing (lazy start).
3. Ask a question that your library answers, in Chat. Expected, in order: an activity line "Searching your papers for ...",
   the notice "Opening Underdog Woof 4B 1.1... the first answer takes a little longer.", then a short streamed answer.
   Under it, a folded "Passages used (N)" with up to 5 passages. Citations to papers not among the passages show red.
4. While it is loaded, record memory and the process:

   ```bash
   pgrep -fl mlx_lm.server                          # exactly ONE line
   ps -o rss=,command= -p "$(pgrep -f mlx_lm.server | head -1)"
   vm_stat | head -5; sysctl vm.swapusage
   cat "$(ls -d ~/obsidian-kb/data/agent 2>/dev/null)"/local-server.json    # pid, model, port (the pid file)
   ```

5. Ask a question your library cannot answer. Expected: "I couldn't find anything in your library about this." with no
   model call (no change in the model's CPU use, no new tokens).
6. Idle shutdown: leave the app alone for the idle time (default 5 minutes; set it to 1 in Settings to test faster).
   Then `pgrep -fl mlx_lm.server` prints nothing, the pid file is gone, and memory is back near the "before" numbers.
   Ask again: the first answer is slow again (the model reloads), and the button/menu status says `Opening ...` meanwhile.
7. Switch models: pick `Underdog Woof 2B 1.1` after a Woof 4B answer. Expected: at most one `mlx_lm.server` at any moment.
8. Quit the app (or `pkill -f agentd.mjs` for the sidecar) while a model is loaded. Expected: `pgrep -fl mlx_lm.server` is empty
   within a few seconds. If you `kill -9` the sidecar instead, the orphan stays until the next start, which kills it
   (the stale pid file) before opening a new one.
9. Memory refusal: with a lot of apps open (free memory under about 5 GB) pick Woof 4B and ask. Expected: the turn fails with
   `There isn't enough free memory to open ... Close some apps and try again.` and no `mlx_lm.server` process starts.
10. Reports stay on the cloud: in Settings, set "Review: writing" to "On this Mac". Expected: refused with
    `On this Mac models only answer questions in Chat and Ask. ...` unless "Allow local models for reports" is on.

## 4. Record the results

Write what you saw (numbers from steps 0, 1, 3.4 and 3.6) at the bottom of this file under "Results", with the date and model.

## Results

2026-10-03, Underdog Woof 4B 1.1, arm64 mlx-lm 0.31.3, after a restart (Metal was down earlier the same day: `MTLCompilerService` unreachable).
Steps 0-2 only (the server alone, no Second Brain; step 3 not yet run). Load 14.6, swap 0, 17 GB disk free.

- Step 1: server up in 7 s; resident ~0.94 GB right after start, ~0.49 GB later (weights are mapped lazily).
- Step 2, grounded: `Smith found a 12% gain in delayed recall after one night of extended sleep in 42 adults [@smith2020].` (30 tokens, no think text, thinking is off).
- Step 2, ungrounded (1998 World Cup): `The provided passages do not contain information about the winner of the 1998 World Cup.` (21 tokens, no invented answer).
- After kill: no `mlx_lm.server` left.
- Step 3, engine level (the real `localProvider` in Node against the real Woof models, no GUI; run 2026-10-03, idle time set to 1 minute):
  - 3.2 lazy start: no `mlx_lm.server` before the first turn; status line `7 models found.`
  - 3.3 first turn: notice `Opening Underdog Woof 4B 1.1... the first answer takes a little longer.`, answer 11.8 s (load included), cites `[@smith2020]`; second question 0.8 s.
  - 3.4 exactly one server process, ~1.4 GB resident (Woof 4B); ungrounded question answered `The provided passages do not contain...`.
  - 3.7 switch to Woof 2B: one server process only (the 4B one was replaced), 8.2 s with load.
  - 3.6 idle stop: process gone about a minute after the last turn; the next question reloads it (9.2 s) with the `Opening ...` notice.
  - 3.8 `dispose()`: no process left.
  - Bug found and fixed (0.39.1): `scanModels` threw `ENOTDIR` on a stray `.DS_Store` in `/Volumes/Content/models`, so the status line and the model list failed on this Mac. Fix: `listDir` in `local/discover.js`; regression test in `local-discover.test.js` (fails without the fix).
  - 3.8 with `kill -9` (real, 2026-10-03): the first run FAILED. A leftover `mlx_lm.server`'s own memory counted against free memory, so the next start was refused ("not enough free memory", 2.1 GB free for a 2.2 GB model) before the stale server was reaped. Fixed in 0.39.2: reap first, wait up to 3 s for it to exit, then check memory (`local/server.js`, regression test in `local-server.test.js`, fails without the fix). Rerun: orphan reaped, Woof 2B answers, nothing left after dispose.
  - 3.9 low memory (real provider with a fake 1 GB free): `There isn't enough free memory to open Underdog Woof 4B 1.1 (it needs about 3.2 GB, about 0.9 GB is free). Close some apps and try again.`, no server process started.
- Not run: the GUI parts of step 3 (menu look, "Passages used" in the real apps, Settings rows), 3.5 (zero-hit answer in the real app), and 3.10 (report roles, covered by unit tests only). Published as 0.39.2: Obsidian installed by `install.sh`; Zotero picks it up through the updater when the server next runs.

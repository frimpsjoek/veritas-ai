# Spec: Local models on this Mac

Status: DRAFT 2026-10-02, written from the user's request "add a feature to use local models existing in this device".
Builds on spec 001 (providers, tool gateway), 007 (steps, citations) and the user's own benchmark of local models on
real data (LexImmigration, 2026-09-15; summary under "Evidence"). Nothing here is published until a person has run
`real-checks.md` against a real model.

## The problem

Every answer today goes to a cloud model (Codex or Claude Code). The user has small models on this Mac (the Woof
family, Qwen 3.5, Gemma 4, in MLX format on the Content drive, plus anything Ollama or LM Studio is serving) and wants
Second Brain to use them: private, free, offline.

The user's own benchmark says a local model cannot simply replace the cloud one:

- On real data, every local model fabricated: journal h-index reported as an author's, total vs independent
  citations, co-author affiliation swaps (7 fabrications in 33 questions for Woof-4B with thinking off; 6 for
  Qwen3.5-4B; 2 for Woof-2B plus 5-15 false refusals and 0/3 usable drafts).
- Woof-4B with thinking OFF is the only acceptable local option, and only for grounded Q&A: top-5 retrieved passages in
  the prompt, temperature 0, output capped near 600 tokens, repeated lines stopped, cited paths checked against the
  retrieved set, and the passages shown next to the answer.
- Thinking ON had no fabrications but takes ~50 s and often never answers. Long drafting prompts loop.
- The engine's current local path (the `oss:default` OpenAI-compatible provider) hands the model a tool loop. A 4B
  model cannot be trusted to drive tools, and nothing stops it being picked for a long report.

So the feature is "ask your own library questions, privately, with a model that cannot wander", not "run the
whole app on a small model".

## Goals

1. A provider `local`, "On this Mac", that works with no sign-in and no setup beyond having models on disk.
2. Models are found live: MLX model folders, the Hugging Face cache, and servers already running (Ollama, LM
   Studio). Never a hard-coded list.
3. Only grounded Q&A uses them by default: the `chat` and `ask` roles. Reports, planning, writing and column
   extraction stay on the cloud unless the user turns on an advanced switch that shows a warning.
4. A local turn is guarded: retrieval first (the engine searches, the model does not), temperature 0, thinking off,
   short output, repeated lines stopped, a citation outside the retrieved set flagged, the passages shown.
5. It is gentle on a memory-starved machine: one model at a time, started on the first question, stopped after an
   idle time, refused plainly when memory is clearly too low, and never left running after the app closes.
6. The words are plain. "On this Mac", "Not connected to the Content drive", never "MLX server" in a sentence a
   person reads, except in the fix hint for a missing install.

## Non-goals

- Downloading models, converting models, fine-tuning, or choosing quantization.
- Tool calling by a local model, web search by a local model, multi-step errands, or reports by default.
- GGUF/llama.cpp loading. Ollama and LM Studio serve GGUF themselves; those are used as-is through their API.
- Running a model inside Zotero or Obsidian's process.
- A per-message model switch inside one conversation (see decision 4). The menu sets the model for Chat and Ask.
- New dependencies. Node `fetch`, the platform's `spawn`, and the existing files only.

## Words used here

| Word | Means |
| --- | --- |
| On this Mac | The `local` provider. |
| Model source | Where a model comes from: `mlx` (a folder on disk that Second Brain starts), `ollama`, `lmstudio` (already-running servers). |
| Retrieved set | The up-to-5 passages the engine fetched for a local turn, with their citation refs. |
| Guarded turn | A turn on a provider that declares `caps.tools = false`: retrieval first, no tool calls. |
| Idle time | Minutes without a question after which the started model is stopped. Default 5. |

## The design

### 1. Provider and ids

`ProviderId` gains `"local"`. A model id is `<source>:<name>`: `mlx:ConwayResearch/Underdog-Woof-4B-1.1`,
`ollama:llama3.2:3b`, `lmstudio:qwen3-4b`. A `ModelChoice` is `{ provider: "local", model: "<id>" | null }`; `null`
means "the default": the first Woof 4B found, else the first model found.

`Provider.caps` gains two optional fields (existing providers omit them):

```ts
caps: { nativeWebSearch: boolean; nativeStructuredOutput: boolean;
        tools?: boolean;          // false: the engine runs retrieval; the provider gets no tools (default true)
        roles?: Role[] }          // roles the provider may serve by default (local: ["chat", "ask"])
```

`ProviderStatus.state` gains `"loading"` (a model is starting) and `ProviderStatus` gains `detail: string | null`, a plain
sentence for the settings row and menu. Local states:

| state | detail (examples) |
| --- | --- |
| `ready` | "3 models found." / "Woof 4B is loaded." |
| `loading` | "Opening Woof 4B..." |
| `unreachable` | "The Content drive isn't connected, so its models can't be used. Other servers on this Mac still work." |
| `missing` | "Local models need mlx-lm, which isn't installed." + `installHelp`: the exact fix (`~/woof-bench/.venv/bin/pip install mlx-lm`) |

Never `signed_out`. `signIn` and `signOut` do nothing.

### 2. Discovery (live)

`local/discover.js`, a function of a `fs` port (`list`, `read`, `stat`) and the list of folders (setting `local.scanDirs`,
defaults: `/Volumes/Content/models`, `/Volumes/Content/Offload/dev/cache/huggingface/hub`,
`~/.cache/huggingface/hub`).

- Layout A: `<dir>/<org>/<repo>/`. Layout B (HF cache): `<dir>/models--<org>--<repo>/snapshots/<hash>/`.
  An `<org>` folder is any directory without a `config.json`; an `<org>/<repo>` with `config.json` is a candidate.
- Chat-capable test, all required: `config.json` parses; at least one `*.safetensors` file; a chat template
  (`chat_template` in `tokenizer_config.json`, or a `chat_template.jinja`/`.json` file); and the repo name and
  `architectures` match none of `asr|whisper|speech|audio|tts|embed|rerank|pii|ctc|bert|clip|siglip|parakeet`.
  Name tokens `gguf` repos have no safetensors and drop out by the same test.
- Size is the sum of the safetensors file sizes (`fs.stat`), used for the memory check and the menu ("4.2 GB").
- Duplicates (same org/repo in two folders) collapse to the first folder scanned.
- Order: tested-first. A model whose name matches `/woof.*4b/i` is the default and goes first; other models follow by
  name. Each carries a short honest note: Woof 4B "Best of the models tried here. Still gets some facts wrong";
  Woof 2B "Often refuses or misses answers"; anything else "Not tested on your library".
- If a scan folder's top-level (`/Volumes/Content`) is missing, the drive is "not connected": `scan()` returns
  `{ models, missing: ["/Volumes/Content/..."] }` and status says so plainly. The other folders still scan.

External servers: `GET http://127.0.0.1:11434/v1/models` (Ollama) and `http://127.0.0.1:1234/v1/models` (LM Studio),
timeout 800 ms each, both in parallel; an unreachable one is simply absent (no error). Their models are listed as
`ollama:<id>` / `lmstudio:<id>` and used as-is, nothing spawned. Embedding models they list are dropped by the same
name test.

### 3. Starting a model (MLX)

`local/server.js` owns at most one child process per sidecar.

- Command: the arm64 venv python, `local.python` (default `~/woof-bench/.venv/bin/python`; never `python3` from PATH,
  which is x86_64 under Rosetta), `-m mlx_lm.server --model <path> --host 127.0.0.1 --port <free port> --temp 0
  --max-tokens 600 --chat-template-args {"enable_thinking":false} --log-level WARNING`.
- Port: a random port in 8700-8799 on which nothing answers; ready = `GET /v1/models` returns 200 (poll every 500 ms,
  give up after 120 s, or at once if the child exits; the child's cleaned stderr tail is the error).
- Lazy: nothing starts until the first local turn. Ready check on the next turn is a no-op if the same model is up.
- One model: asking for another model first stops the running one and waits for it to exit.
- Idle: a timer, reset when a turn starts and when it ends, stops the child after `local.idleMinutes` (default 5).
  Never fires during a stream.
- Memory refusal before spawning: needed = size x 1.2 + 0.6 GB; available = (free + inactive + speculative +
  purgeable pages) x page size from `vm_stat`. If needed > available the turn fails with `model_unavailable` and the
  sentence "There isn't enough free memory to open Woof 4B (it needs about 5.6 GB, about 1.1 GB is free). Close
  some apps and try again."; nothing starts. A failed `vm_stat` read never blocks a start.
- Exit: `dispose()` kills the child (and the sidecar calls it on SIGTERM and on process exit). A pid file
  `<dataDir>/local-server.json` is written at start; the next start kills a stale child whose command line is still
  `mlx_lm.server` (covers a sidecar that was killed hard).

### 4. A guarded turn

`local/provider.js` is the OpenAI-compatible request/stream path (`parseSse`, `applyChunk`, `buildMessages` from
`providers/openai.js`) with these differences:

- Body: `temperature: 0`, `max_tokens: 600`, `stream: true`, `chat_template_kwargs: { enable_thinking: false }`, no
  `tools`, no `response_format`.
- Stop on repetition: when a finished line of 12 or more characters has now appeared 3 times, abort the stream, drop
  the repeated copies, end the answer there, and add a notice "Stopped a repeating answer."
- A completion that ends for `length` adds the notice "Short answer: stopped at the length limit."
- Ask's `{status, markdown}` contract: the plain text is wrapped as `answered` (existing `wrapAsAnsweredMarkdown`).
- Sources are untrusted data; the system prompt is `LOCAL_INSTRUCTIONS` (below), not `ASK_INSTRUCTIONS`.

Engine side (`core.js` `TurnRunner.stream`), for a provider with `caps.tools === false`:

1. Role gate (section 5), before anything starts.
2. Retrieval first: `library.search` with the turn's scope and sources, `limit: 5`, query = the user's message (when it
   is under 5 words and a previous user message exists, prepend that message). The tool session opens with
   `none: true` so no tool is offered. The search shows as the usual "Searching your papers for ..." activity line.
3. Nothing retrieved: no model is started; the turn ends at once with the not-found answer ("I couldn't find
   anything in your library about this.", `status: "not_found"` for Ask).
4. The prompt is `LOCAL_INSTRUCTIONS` + the numbered passages (`[@key] Title (year): snippet`), then the question.
   `LOCAL_INSTRUCTIONS`: answer only from the passages below; cite as [@key] or [[Note]] exactly as listed; if they do not
   answer the question say so; no numbers (citation counts, h-index, dates) that are not in the passages.
5. After the answer: citations are validated as usual, then any citation whose key is not in the retrieved set becomes
   `unknown` (shown in red with the existing missing-citation note). The answer text is left as written.
6. `Answer.passages` (new, optional) = `[{ ref, title, snippet }]`, stored with the answer and sent on `done`; the
   chat shows a folded "Passages used (5)" block under the answer.
7. Turns with `session.on` (Chat with papers) are not guarded-capable: they fail with "Chatting with a paper set needs
   a cloud model."

### 5. Which roles

`provider.caps.roles` lists the roles a provider serves by default. For `local` that is `chat` and `ask`.
`settings.local.allowReports` (default false) lifts the limit for `lead`, `researcher`, `writer` and `extract`.

- `settingsStore.setRole(role, choice)` throws a plain error for a local choice on a gated role.
- The TurnRunner re-checks at turn time (a stale settings.json or an older client): a gated role resolved to `local`
  fails with `model_unavailable` and "On this Mac models only answer questions in Chat and Ask. Pick Codex or Claude
  Code for reports in Settings."
- With `allowReports` on, report roles are served by the plain OpenAI-compatible tool loop (`providers/openai.js`) against
  the same local server: the guarded path is only for `chat` and `ask`. The settings row says "Unreliable: it may
  invent numbers and loop on long reports." This is the user's explicit risk; the spec does not try to make it good.
  (`caps.tools === false` therefore means "guarded retrieval-first when the role is chat or ask".)

### 6. Settings and UI

Settings (`settings.json`, merged like the rest):

```ts
local: { scanDirs: string[]; idleMinutes: number; python: string | null; allowReports: boolean; external: boolean }
// defaults: see section 2; 5; null (= ~/woof-bench/.venv/bin/python); false; true
```

- **Chat**: the controls row gets a small "Answer with" button ("Cloud" or "On this Mac: Woof 4B"). It opens a menu:
  *Cloud (your usual model)* and an *On this Mac* group (one row per model: name, size, one-line note; rows for
  models that cannot be used say why), a status line under the group (the provider `detail`), and one honest line:
  "Runs on your Mac. Best for questions about your own library; it can get facts wrong, so check the passages shown
  under each answer." Choosing a row sets Chat and Ask to it; choosing Cloud puts both back to what they were (kept
  in `host.prefs` key `cloudRoles`, default Codex). The button is hidden when the engine reports no `local` provider.
- **Settings panes** (Zotero preferences, Obsidian settings): "On this Mac" row with the status, "Stop a model that
  has been idle for [5] minutes", "Folders to look for models in", and an Advanced toggle "Allow local models for
  reports" with the warning text. The per-role dropdowns offer "On this Mac" for Chat and Ask only (and for the
  rest only when the toggle is on).
- All new buttons with text that can be long set `white-space: normal`. Widths 960 / 700 / 360 checked in the ui-src
  harness, both token maps, light and dark.

## Evidence

`benchmarks/local-models/results.md` in LexImmigration, summarized in the user's memory note
`leximmigration-local-models`: gpt-5.6-luna 0 fabrications, 29/31; Woof-4B (thinking off) 7 fabrications, 27/31, 6.9 s,
4.2 GB; Qwen3.5-4B 6 fabrications; Woof-2B 5-15 false refusals; temperature 0; arm64 venv only.

## Success checks

1. With a temp folder tree holding two chat models, one ASR model, one embeddings model, one GGUF-only folder, a
   cache-layout model and a duplicate, `scan()` lists exactly the chat models, once each, Woof 4B first, with sizes.
2. With the Content drive absent, `status()` says the drive isn't connected and `models()` still lists Ollama/LM Studio
   models; with `mlx-lm` absent it says `missing` with the install hint.
3. The first local turn starts exactly one server; a second turn on the same model starts none; a turn on another model
   stops the first before starting the second; after the idle time with no turn the child is killed; a turn in progress
   is never cut off by the idle timer.
4. The request a local turn sends has `temperature: 0`, `chat_template_kwargs.enable_thinking === false`,
   `max_tokens <= 600`, `stream: true`, and no `tools`.
5. A model that repeats a line 3 times is stopped, the repeats are dropped and the notice is shown.
6. A local `lead`, `researcher`, `writer` or `extract` role is refused at `setRole` and at turn time unless
   `allowReports` is on.
7. A local Chat turn runs `library.search` itself (limit 5), the model receives the passages, the model sees no tools;
   zero hits means no model is started and the not-found answer is returned.
8. A citation to a key not in the retrieved set comes back `unknown`; one in the set is `resolved` with
   `retrievedThisTurn`; the answer carries `passages` and the chat shows them.
9. With free memory below the need the turn fails with the memory sentence and nothing is spawned.
10. Killing the provider (`dispose`) kills the child; a stale pid file from a dead sidecar is reaped on the next start.
11. The Answer-with menu and settings rows render in both token maps, light and dark, at 960 / 700 / 360 with no
    horizontal overflow, and long labels wrap.
12. All existing agent-src and ui-src tests still pass after every unit.
13. Real model (needs a person; `real-checks.md`): Woof-4B starts on demand, answers one grounded question with the
    passages shown, memory returns near the starting level after idle shutdown.

## Decisions

1. (Design brief, user) One provider `local` over the OpenAI-compatible path; `mlx_lm.server` from the arm64 venv
   spawned on demand; Ollama and LM Studio detected and used as-is.
2. (Brief) `chat` and `ask` only by default; an explicit advanced switch with a warning for the rest.
3. (Brief) Retrieval-first guarded turns; no model tool calling; no web search; no errands.
4. (Refinement) The brief put the picker on "the shared provider/model pickers in ui-src". There is no such picker:
   the chat has no model menu and the role dropdowns live in each host's settings code (Zotero `preferences.js`,
   Obsidian `main.ts`). This spec adds one shared menu in `ui-src` (both hosts get it) and keeps the settings rows in
   the host panes, because the Zotero preferences window does not load `sb-ui.js`. A per-message model switch is
   left out: the menu sets the Chat and Ask roles, the same state Settings shows.
5. (Refinement) "Nothing retrieved" never reaches the model. That removes the case the benchmark flagged most (a
   model answering from memory with no sources) at no cost.
6. (Refinement) The memory check uses `vm_stat` through `platform.spawn`, so it works the same in the sidecar and in
   Zotero's in-process engine; a failed read never blocks.

## Open questions

- Should the menu also let a person pick a model for one chat only? Not built; needs a `model` field on `SendInput`.
- Woof-4B 1.1 vs the older `woof-1.0-4B`: the benchmark used one build; the menu lists both and defaults to the newest by name.
- Does `mlx_lm.server` 0.31.3 honour per-request `chat_template_kwargs` for every listed architecture? Both the CLI
  flag and the request field are set; `real-checks.md` step 3 confirms thinking is really off.

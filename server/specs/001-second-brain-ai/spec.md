# Spec: Second Brain AI

Status: APPROVED 2026-09-25 (phase 1). Phase 2 (Plan) in progress.
Date: 2026-09-25

## Objective

Researchers using Second Brain should be able to talk to their own library. Today they can search the Obsidian vault and Zotero papers by meaning. They cannot ask a question and get an answer built from those sources, and they cannot run a literature review without doing every step by hand.

This feature adds an AI assistant to both the Zotero plugin and the Obsidian plugin. It has three modes.

1. **Chat.** A conversation that pulls context from notes, papers, the web and any MCP servers the user has added. It remembers the conversation and cites every claim.
2. **Ask.** One question, one grounded answer with citations. It says plainly when the library has no answer, instead of filling the gap from the model's memory.
3. **Literature review.** The user gives a research question and a scope. A lead agent plans sub-questions, several researcher agents search in parallel, and a writer agent produces a structured report saved as an Obsidian note. The report can also be exported.

The assistant runs on the user's choice of provider (amended 2026-09-25 at the user's request):

- **Codex**, signed in with ChatGPT (Plus or higher) or an OpenAI API key.
- **Claude Code**, signed in with a Claude subscription or an Anthropic API key.
- **Open-source models** through any OpenAI-compatible endpoint: local servers (LM Studio, Ollama, llama.cpp, mlx_lm.server) or hosted open-model APIs.

The provider is chosen per mode. For example, Claude for the review writer, Codex for researchers and a local model for quick Ask. The Zotero plugin is public, so the AI must also work in Zotero alone, with no Obsidian and no Second Brain server, for anyone with one of these providers.

### User stories

- As a researcher reading a paper in Zotero, I open Chat and ask how this paper's method compares to others in my library. I get an answer with clickable citations to the papers and my notes.
- As an Obsidian user, I ask "what have I written about X?" and get an answer that links my own notes first and AI notes last.
- As a researcher starting a project, I request a literature review on a question limited to a Zotero collection plus the web from 2018 onward. I watch progress, cancel if needed, and get a report note with an evidence table and references.
- As a public Zotero plugin user without the server, I sign in with ChatGPT and get Chat, Ask and Literature review over my Zotero library.
- As a power user, I add an MCP server (for example a PubMed or Semantic Scholar server) in settings and the assistant uses it for more accurate search.

## Decisions already made (from the user, 2026-09-25)

(The provider requirement was added later the same day; see Objective and grounding.md.)

| Question | Decision |
| --- | --- |
| Where it lives | Both plugins. Conversations and reports are shared when the server runs. |
| Zotero without the server | Yes. Zotero runs Codex itself and uses its built-in search model and Zotero's full text. |
| Report destination | Obsidian note, plus export on request (Markdown, DOCX, PDF). In Zotero-only mode the note goes to the plugin's local notes folder. |
| Agent permissions | Read and search only. Agents never run shell commands and never edit notes. The only writes are chat history and reports, done by our own code. |

## Assumptions (correct any of these before phase 2)

1. **Codex runs as `codex app-server`** (JSON-RPC over stdio), not `codex exec`. The app server gives multiple threads, streaming, sign-in, rate-limit readout, model list, per-thread MCP config, web-search mode, output schemas and host-provided tools (`dynamicTools`). All of these were confirmed in the protocol schema for codex-cli 0.155.0-alpha.16. LexImmigration uses `codex exec` and has no parallel orchestration, so it is a reference for binary discovery, sign-in and error cleanup only.
2. **Codex binary lookup order:** a `codex` path setting, then `CODEX_BINARY`, then `/Applications/ChatGPT.app/Contents/Resources/codex`, then `codex` on PATH. We do not bundle Codex in the public plugin. If it is missing, we show how to install it.
3. **Isolation from the user's own Codex config.** Threads start with `--ignore-user-config`, a read-only sandbox and approval policy `never`. MCP servers come only from Second Brain's own settings, never from `~/.codex/config.toml`. The auth in `CODEX_HOME` is reused, so an existing ChatGPT login just works.
4. **Library tools are host-provided `dynamicTools`.** The app that runs Codex answers the tool calls itself. Zotero answers with its local index and the Zotero API. The server answers with `kb.py` search, and its privacy rules apply as for other agents. No extra MCP process is needed for the built-in tools. If `dynamicTools` proves unusable with ChatGPT sign-in, the fallback is the existing `obsidian-kb` stdio MCP server plus a small Zotero-side MCP bridge. The first plan task tests this.
5. **Web search is Codex's own `web_search` tool**, set per conversation to off, cached or live. The scholarly sources in `discover.js` (OpenAlex, Semantic Scholar, arXiv, Crossref, Europe PMC, bioRxiv/medRxiv, ChemRxiv) become host tools as well, so reviews can search the literature, not just the open web.
6. **Parallel agents are capped.** The literature review defaults to 3 researcher agents with a maximum of 5. A memory note records that more than 6 parallel Claude processes pushed this Mac into swap. Each Codex thread shares one app-server process, which keeps this cheap, but the cap still guards rate limits.
7. **Model choice** comes from the live `model/list`. There is no hard-coded list, because LexImmigration's hard-coded list went stale. The default is the account's default model, with a setting per mode.
8. **Chat history** is stored as JSON Lines per conversation. With the server running, it lives in `~/obsidian-kb/data/chats/`. In Zotero-only mode, it lives in `<Zotero data dir>/second-brain/chats/`. When the server comes back, local conversations are adopted, the same pattern as local notes today.
9. **Obsidian mobile** can use Chat and Ask through the server, over Tailscale with the existing bearer token. It cannot run Codex itself.

## Functional requirements

### F1. Providers, sign-in and status
- A provider list in Settings: Codex, Claude Code, and any number of OpenAI-compatible endpoints (base URL, optional key, model). Each shows found or missing, version, sign-in state, and usage or rate limits where the provider reports them. Claude Code reports cost per turn; Codex reports rate limits.
- Per-mode defaults: Chat, Ask, and the review roles (lead, researcher, writer) each pick a provider and model.
- Open-source models get the same library, scholarly and MCP tools. Our core runs their tool loop. Web search for them uses a configured search backend (Exa, Tavily or SearXNG) when one is set. Otherwise it is off, and the UI says so.
- For Codex specifically, settings show Codex status: binary found and version, signed in as ChatGPT or API key, plan, and rate-limit usage (`account/rateLimits/read`).
- Buttons: "Sign in with ChatGPT" (browser flow, or device code as a fallback), "Use API key", "Sign out".
- If Codex is missing, show a plain-language install guide instead of the AI features' buttons. The same applies to Claude Code. For local models, the guide shows how to start LM Studio or Ollama.

### F2. Chat
- Streams the answer token by token. Shows tool activity in plain language ("Searching your papers for 'X'", "Reading Smith 2021", "Searching the web").
- Context attachments: the current Zotero item or selection, the open Obsidian note, a collection, a tag, or a pasted quote.
- Citations render as links: `[[Note]]` opens in Obsidian, `[@citekey]` selects the item in Zotero or opens its paper note, and web links open in the browser. A validator checks every citation against the library. Unknown ones are marked, never silently shown as real.
- Conversations are listed, renamed and deleted, and they continue after an app restart.
- Stop button (`turn/interrupt`).

### F3. Ask
- A single-shot answer with the same tools and citations as Chat. The prompt tells the model to answer only from retrieved sources and to say "not found in your library" when they don't cover the question.
- Available as a command on selected text in both apps.

### F4. Literature review
- Input: research question, scope (whole library, collection, tag or saved search), sources (library, scholarly APIs, web), year range, depth (quick, standard or deep). Depth sets how many sub-questions and researcher agents run.
- Pipeline:
  1. **Plan.** The lead agent writes sub-questions and search strategies as structured JSON (`outputSchema`). The user can edit or approve the plan, or set it to run automatically.
  2. **Research.** Up to N researcher threads run in parallel, one per sub-question. Each returns structured findings: claims, each with supporting sources, quotes and a confidence level.
  3. **Screen.** Findings are deduplicated by DOI and citekey. Papers found outside the library are listed with an "Add to Zotero" action. They are never added automatically.
  4. **Synthesize.** The writer agent produces the report. Its sections are Question and scope, Method (a search log of queries, sources and counts), Themes, an Evidence table (claim, sources, strength), Disagreements, Gaps and future work, and References.
- Progress view: stages, per-agent status, and papers found so far. Cancel stops every thread. A review survives an app restart and resumes from the last finished stage, because each stage writes its result to disk before the next stage starts.
- Output: `ai_notes/Literature Reviews/YYYY-MM-DD <title>.md` with front matter (`type: literature-review`, question, scope, model, date, sources). Export produces Markdown, DOCX or PDF.

### F5. Web search and MCP servers
- A per-conversation web search toggle: off, cached or live. The default comes from settings.
- The Settings page has an MCP server list. Each entry is a stdio command with args and env, or a streamable-HTTP URL. Entries can be enabled or disabled and tested; the test lists the server's tools (`mcpServerStatus/list`).
- A curated catalog of scholarly MCP servers offers one-click adds. What the catalog contains is decided in the plan phase from research.
- MCP tools are read-only by policy. The UI warns when a server exposes write tools.

### F6. Safety and privacy
- The sandbox is read-only and the approval policy is `never`. Approval requests are refused automatically. No shell tool is exposed.
- Server-hosted tools apply `privacy.json`, the same rules as the `X-KB-Client: agent` routes, and write to the audit log.
- Stderr is cleaned before display, because it can echo prompts and internal trace lines (a lesson from LexImmigration's `codexOutput.ts`).
- Notes, papers and web pages are untrusted data. The system prompt says so, and tool outputs are wrapped as data.

## Non-functional requirements

- First streamed token in 4 s or less after sending, with an already-running app server, measured on this Mac.
- Library search tool calls return in 300 ms or less (server p95), in line with the current 10 to 115 ms search.
- A quick review finishes in 10 minutes or less and a standard one in 25 minutes or less, excluding model queueing.
- No global lock is held across a streamed response. Search keeps its current latency while a review runs.
- The UI follows each host app's look (the user rejected a custom tinted sheet before). Plain-language copy with no developer terms, per the house style.

## Tech stack

- **Codex:** codex-cli app server, protocol v2 (schema generated with `codex app-server generate-json-schema`).
- **Server:** Python 3.12 in `~/obsidian-kb/.venv`, the stdlib `ThreadingHTTPServer` in `http_api.py`. New streaming routes use Server-Sent Events.
- **Zotero plugin:** plain JS bootstrap plugin (Zotero 7 to 10). Codex runs through Mozilla `Subprocess.sys.mjs`. The UI is a Zotero tab, following the note-tab pattern in `content/second-brain.js`.
- **Obsidian plugin:** TypeScript, esbuild, an `ItemView`. On desktop, streaming uses Node `http`, because `requestUrl` cannot stream.
- **Tool channel (verified by spike, see grounding.md):** our tools are served to Codex and Claude Code as an MCP server over streamable HTTP. For open-source models, the core calls them in-process.
- **Shared agent core:** one JavaScript module (JSON-RPC client, orchestration, prompts, citation validator) used by both plugins, and by the server if the plan picks a Node sidecar. The host decision for the Obsidian and server side is the phase 2 `architect` question. The candidates are a Node sidecar started by the server, a Python port of the orchestration, or the Obsidian desktop plugin hosting the core directly.

## Commands

```
# Server
cd ~/obsidian-kb && .venv/bin/python kb.py serve                     # run the HTTP server (port 27182)
cd ~/obsidian-kb && .venv/bin/python -m pytest tests/ -q             # server tests (new)
cd ~/obsidian-kb && .venv/bin/python eval.py                         # search recall must not regress (5/11 top-1, 9/11 top-5)
pkill -f obsidian-kb/server.py                                       # after server code changes, restart the MCP clients

# Shared agent core
cd ~/obsidian-kb/zotero-plugin/agent-src && npm test                 # node --test, against a fake app server
cd ~/obsidian-kb/zotero-plugin/agent-src && npm run build            # bundle to content/agent.js

# Zotero plugin
cd ~/obsidian-kb/zotero-plugin && ./build.sh                         # xpi + update.json in dist/
for f in bootstrap.js content/*.js; do node --check "$f"; done       # same as CI
MOZ_HEADLESS=1 /Applications/Zotero.app/Contents/MacOS/zotero -profile <scratch>/ztest -no-remote -purgecaches -ZoteroDebugText   # headless test run
open -g -a Zotero --args -purgecaches                                # after installing a new xpi

# Obsidian plugin
cd ~/obsidian-kb/obsidian-plugin && npx tsc --noEmit && ./install.sh

# Codex
/Applications/ChatGPT.app/Contents/Resources/codex app-server generate-json-schema --out <dir>
/Applications/ChatGPT.app/Contents/Resources/codex login status
```

## Project structure

```
~/obsidian-kb/
  specs/001-second-brain-ai/   spec.md, plan.md, tasks.md, decision trail
  agent_api.py                 server: chat, ask and review routes (SSE), chat store, host-tool handlers
  tests/                       pytest: routes, privacy filtering, chat store, report writer
  data/chats/                  conversation JSONL (git-ignored data)
  data/reviews/<id>/           per-stage review state (plan.json, findings-*.json, report.md)
  zotero-plugin/               public repo
    agent-src/                 shared agent core (JSON-RPC client, orchestrator, prompts, citations), node tests
    content/agent.js           built bundle
    content/chat.js            Zotero Chat/Ask/Review tab UI
    content/codex-host.js      Subprocess transport + Zotero-side tool handlers
  obsidian-plugin/src/
    chat.ts                    Obsidian Chat/Ask/Review view
    agent-client.ts            SSE client to the server
```

## Code style

Match the surrounding code. Zotero plugin code is plain modern JS classes on the `SecondBrain` namespace, with no framework. Obsidian code is TypeScript with `ItemView` subclasses and calls through the shared `Api`. Python is stdlib-first, with small functions and routes dispatched in `Handler`. Comments only for a non-obvious reason.

The domain is modelled as data, not as branches. A review is a state machine whose stages are a table:

```js
const REVIEW_STAGES = [
  { id: "plan",       run: planStage,       output: "plan.json" },
  { id: "research",   run: researchStage,   output: "findings.json" },
  { id: "screen",     run: screenStage,     output: "screened.json" },
  { id: "synthesize", run: synthesizeStage, output: "report.md" },
];
// resume = first stage whose output file is missing
```

Tools are a registry, one row per tool, and each host fills in the handlers:

```js
const TOOLS = {
  search_library: { description: "...", inputSchema: {...}, readOnly: true },
  read_source:    { description: "...", inputSchema: {...}, readOnly: true },
  search_scholarly: { ... },
};
```

## Testing strategy

- **Agent core (node:test).** A fake app server replays recorded JSON-RPC transcripts (initialize, thread/start, streaming deltas, a dynamic tool call, turn/completed, errors). Tests cover the stage machine (resume after each stage), the parallel cap, cancellation, the citation validator (a fabricated `[@key]` gets flagged) and the automatic refusal of approval requests.
- **Server (pytest).** SSE framing, privacy filtering on host tools (a private note never appears in a tool result), the chat store round-trip, the report writer (collision-safe filename, front matter) and the fact that search is not blocked while a stream is open.
- **Zotero (headless harness).** The existing scratchpad `ztest` profile plus the `sb-test@local` runner. It checks that the tab opens, that a local-mode conversation works against the fake app server, and that tool handlers return library results.
- **Real Codex smoke test.** Opt-in, because it spends quota. One Ask over the real library, and one quick review on a narrow topic. The checks are that every citation resolves and the report note exists.
- **Search recall.** `eval.py` stays at its current score.
- **UI verification.** Screenshot the Zotero window with `screencapture -l` and check the Obsidian view. Check the user is idle first (HIDIdleTime above 90 s).

## Boundaries

- **Always:** keep Codex isolated from the user's own config. Run agents read-only. Validate citations. Write reports only through our collision-safe writer. Restart MCP clients after server code changes. Launch Zotero with `-purgecaches` after an install. Run the CI checks before a commit to the public repo.
- **Ask first:** adding npm or pip dependencies. Changing `privacy.json` semantics. Anything that installs a LaunchAgent or runs `tailscale serve`. Pushing, tagging or releasing the public Zotero plugin. Real-Codex test runs beyond a few smoke prompts, since they spend the user's quota. Changing the user's `~/.codex/config.toml`.
- **Never:** write to `~/.codex` config. Let agents edit notes or run shell commands. Commit tokens or `data/`. Put personal paths or library content in the public repo. Delete vault files or conflict copies. Run more than 5 parallel researcher threads.

## Success criteria

1. With Codex signed in through ChatGPT, Chat in Zotero and Chat in Obsidian each answer "what does my library say about <topic>?" with at least 3 citations. 100% of them resolve to real notes or items, verified by the validator plus a manual check on 5 answers.
2. With the server stopped and Obsidian closed, the same Chat works in Zotero alone, using the built-in search model.
3. Ask on a topic that is absent from the library replies that it was not found, instead of inventing sources. Tested with 3 such prompts.
4. A quick literature review on a narrow question finishes in 10 minutes or less and writes `ai_notes/Literature Reviews/<date> <title>.md` with all 7 report sections. Every reference resolves, and the search log lists its queries. Cancelling mid-run stops every thread. Killing the app mid-run and reopening resumes from the last finished stage.
5. Adding an MCP server in settings, for example a scholarly-search server from the catalog, makes its tools appear in the connection test, and the assistant uses them in a conversation.
6. The agent never runs a shell command or edits a note. This is checked by reviewing the thread items in the stored transcripts, with no `commandExecution` or `fileChange` items.
7. Search p95 latency and `eval.py` recall are unchanged while a review runs.
8. The public Zotero plugin CI stays green, and the repo holds no personal data.
9. Criteria 1 and 3 also pass with Claude Code as the provider, and with one local open-source model through LM Studio or Ollama. Answer quality may be lower for the local model, but tool calls and citation validation must work.
10. Switching a mode's provider in settings takes effect on the next message, with no restart.

## Resolved on approval (2026-09-25, defaults taken)

- Review plan step pauses for approval by default; a setting runs it straight through.
- Out-of-library papers: an "Add to Zotero" button per paper plus "Add all".
- Export: Markdown, DOCX, PDF; References in APA.
- MCP catalog: researched in phase 2.

## Open questions (original list)

1. **MCP catalog contents.** Which scholarly MCP servers to offer by default (PubMed, Semantic Scholar, arXiv, OpenAlex, Consensus, Scite and others). I propose researching them in the plan phase and picking servers that are free, read-only and actively maintained.
2. **Review approval.** Should the plan step pause for your approval by default, or run straight through, with approval as an option?
3. **Adding papers.** When a review finds papers outside the library, is listing them with "Add to Zotero" buttons enough, or do you want one "add all" action?
4. **Export formats.** Are Markdown, DOCX and PDF enough, and should a citation style such as APA be applied to the References section?
5. **Obsidian and server host.** Resolved in phase 2 by `architect`, not by you.
6. **Other agent CLIs** (opencode, gemini CLI, and others through ACP) are out of scope for v1. The provider interface should admit them later.

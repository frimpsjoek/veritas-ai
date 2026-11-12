# Spec: saved findings you can check, and Veritas as one install for any agent

Status: DRAFT 2026-10-29. G3 (connectors through MCP) chosen by the user 2026-10-29 ("A"). Decisions D1-D7 open.
No plan.md yet; it comes after the decisions.
Written from the user's request of 2026-10-29, after comparing Veritas with John Kitchin's crucible
(github.com/jkitchin/crucible) and fairchem-mcp: "yes start drafting it" (idea 1: save answers as findings with
their sources; idea 2: ship a skill with the MCP server so one command installs both).

## Where we are

Checked in code 2026-10-29:

- Answers cite notes (`[[Note]]`), papers (`[@citekey]`) and web links. `agent/src/citations.js` resolves each one
  against the library or this turn's tool results; anything else is marked `unknown`, never shown as real
  (`agent/src/domain.d.ts:255`).
- Veritas writes notes only to its output folder (`server/sources.py:289`, `PATCH /sources/output`); digests go to
  `Second Brain/Digests/` (`PUT /digests/<file>`, atomic, 413 over 512 KB). Reports export as md/docx/pdf
  (`agent/src/export.js`).
- **No action saves a chat answer as a note that keeps its sources.** A good answer is lost in the chat history,
  and the next question starts from zero.
- `server/server.py` is an MCP server with six read-only tools: `search_notes`, `read_note`, `note_links`,
  `related_notes`, `recent_notes`, `index_status`. None carries `readOnlyHint` annotations, which Veritas's own MCP
  hub requires before it exposes a tool (`agent/src/mcp-hub.js`, `verdictFor`).
- Registering it in another agent takes a hand-written `claude mcp add ... /path/to/.venv/bin/python
  /path/to/server.py` (`docs/guide/connectors.md`). There is no `SKILL.md` and no `.mcp.json` in the repository,
  so the agent gets tools but no instructions on when to use them or how to cite. The repository is public.

What we borrow, and what we do not:

| From | Borrow | Leave out |
|---|---|---|
| crucible | "capture that as an article": insights accumulate; `DERIVED_FROM` chains; `history` walks them; `MANIFEST.md` tells an agent what the store holds | the LLM rewriting a wiki that becomes the source of truth; org-mode; peered stores |
| fairchem-mcp | `mcp/<name>.json` + `skills/<name>/SKILL.md` in one repo, installed together by `uvx knowhow add owner/repo --skill X --mcp X` | Python-in-process `execute` tools |

The line we keep: **a finding is always secondary.** It never replaces a source; every claim in it traces to a paper
or note you can open.

## Goals

### G1. Saved findings

- **R1.** Every chat answer gets a **Save as finding** action (shared `ui/`, so web, Zotero and Obsidian get it
  together). It writes one Markdown note, `<findings folder>/<YYYY-MM-DD>-<slug>.md` (folder: D1).
- **R2.** Front matter: `type: finding`, `created`, `question`, `model`, `conversation`, and `derived_from`: the
  answer's **resolved** citations, each as `{kind, path | citekey + doi | url}`. Citations marked `unknown` are
  handled by D2.
- **R3.** Body: the answer as shown, with its citations kept as links that open (`[[Note]]`, DOI links), then a
  **Sources** list built from `derived_from`. The user can edit the title and text before saving; they cannot add
  sources the answer did not cite.
- **R4.** Findings are indexed like any note, so later chats can find and cite them. When an answer cites a
  finding, its citation panel shows the finding **and** the sources it came from ("from: …"). The finding never
  appears as a source on its own.
- **R5.** A finding can derive from other findings (D3). `finding_history(path)` walks `derived_from` down to
  primary sources, safe against cycles and missing files.
- **R6.** Stale check: if a note in `derived_from` changed after the finding's `created` date, or was deleted, the
  finding shows "a source changed since this was saved" with the source named. Papers are checked by DOI or
  citekey still being in the library.
- **R7.** Saving writes only into the findings folder: atomic write, 413 over 512 KB (same as digests). It never
  edits a source.
- **N1.** Saving takes under 1 s on this Mac's library (4,036 notes, 85k passages); no re-index of anything except
  the new file.
- **N2.** No new dependencies.

### G2. One install for any agent: skill + MCP server

- **R8.** `skills/veritas/SKILL.md` that follows the Agent Skills spec (agentskills.io). It tells the agent: use
  Veritas for questions about the user's own papers, notes and reading; search, then `read_note` before citing;
  cite with `[[path]]` or the DOI; say "not in your library" rather than guess; treat findings as secondary and
  follow their `derived_from` to the source.
- **R9.** `.mcp.json` at the repository root with one server, `veritas`, launched by a command that works on any
  install, without absolute venv paths (D4).
- **R10.** These install the skill and the server:
  `uvx knowhow add frimpsjoek/veritas-ai --skill veritas --mcp veritas` (Claude Code, Codex, VS Code, Cursor,
  OpenCode, Gemini CLI) and `npx skills add frimpsjoek/veritas-ai --skill veritas` (skill only).
  `uvx knowhow validate .` runs in `./check.sh` and CI.
- **R11.** MCP server additions:
  - `library_overview`: sources, counts, date range, top topics and authors (crucible's `MANIFEST.md`, served live),
    so an agent can tell whether the library is relevant before searching;
  - with G1: `read_note` returns `derived_from` and the stale flag for findings, and `finding_history(path)`
    (R5) is a tool;
  - every tool, old and new, marked `readOnlyHint: true`.
- **R12.** `docs/guide/connectors.md` "Your library in other AI chats" is rewritten around the one command (the
  manual `claude mcp add` stays as a fallback), plus one line in the README.
- **N3.** `SKILL.md` stays under 500 lines with a description under 1024 characters; details go in
  `skills/veritas/references/`.
- **N4.** The MCP server stays read-only. Agents saving findings through MCP is D5.

### G3. Connectors through the same MCP server (added 2026-10-29)

Decided by the user 2026-10-29 ("A"): outside agents reach Veritas's connectors (Valency Bond, PubMed / Europe PMC,
arXiv full text, paper search, Unpaywall, PubChem, ChEMBL, Wikipedia, and any optional one the user connected)
through Veritas, not by registering each one in each agent.

Where we are (checked 2026-10-29): connectors live in the Node agent's MCP hub (`agent/src/mcp-hub.js`,
`createMcpHub`, merged into the gateway at `agent/src/tools.js:253-294`). `server/server.py` reaches only the index
routes in `AGENT_ROUTES` (`server/http_api.py:123`); `/agent/*` is "for the plugins and the sidecar only"
(`http_api.py:118-119`). The Veritas MCP server was registered in Claude Code on 2026-10-29 (user scope, Homebrew
copy, `VERITAS_DATA=/opt/homebrew/var/veritas`), so G3 extends a live registration.

- **R13.** Two routes added to `AGENT_ROUTES`, both answered by the sidecar's hub: `GET /connectors/tools` (the
  tools the hub exposes: connected servers only, `verdictFor` = `exposed`, names `<server>__<tool>`) and
  `POST /connectors/call {"tool","args"}`. A tool not in that list gets 403, so a hidden or write tool can never be
  called by name.
- **R14.** `server/server.py` lists those tools at start and registers each as an MCP tool with the connector's
  own description and input schema, prefixed `connector__<server>__<tool>`, all marked `readOnlyHint: true`. If the
  sidecar is down, the library tools still work and a `connectors_status` tool says why the connectors are missing.
- **R15.** Keys never leave Veritas: no key, header or token appears in `/connectors/tools`, in MCP tool
  descriptions, in results, or in logs written for agent clients (`X-KB-Client: agent`).
- **R16.** Results carry their source: each connector result is wrapped `{connector, tool, retrieved_at, result}` so
  an agent can cite `[connector: <server>]`. Results larger than the digest limit are cut with a note (512 KB, like
  `PUT /digests`).
- **R17.** Changes in Veritas's Settings > Sources and tools (connect, disconnect, trust) show up in a running agent
  within one minute, or on the agent's next session start, whichever the plan finds simpler (D7).
- **N5.** A connector call adds no more than 50 ms over calling the connector from Veritas's own chat (same hub).
- **N6.** No new dependencies; `privacy.json` and the agent request log apply to connector calls as to library calls.

## Success checks

| Check | Covers | How | Expected |
|---|---|---|---|
| V1 | R1-R3, R7 | Ask a question in the web app, Save as finding | one file in the findings folder; front matter lists exactly the resolved citations; links open; nothing else in the vault changed (git status of a test vault) |
| V2 | R2, D2 | An answer with a fabricated `[[Nope]]` | handled as D2 decides (blocked, or saved with it marked unknown); never in `derived_from` |
| V3 | R4 | Ask a follow-up that hits the finding | the citation panel shows the finding with its "from:" sources |
| V4 | R5 | Finding B derived from finding A; also A↔B cycle; also A deleted | `finding_history` reaches the primary sources; the cycle stops; the missing file is reported, no crash |
| V5 | R6 | Edit a source note after saving | the finding shows "a source changed" naming that note |
| V6 | N1 | Time 20 saves on the full index | median under 1 s |
| V7 | R8-R10 | In a scratch project: `uvx knowhow add <local clone> --skill veritas --mcp veritas -a claude-code`, then a fresh Claude Code session asks about a paper in the library | skill and server listed; the answer cites `[[path]]` or a DOI that the tool returned |
| V8 | R10 | `uvx knowhow validate .` in `./check.sh` | passes |
| V9 | R11 | MCP inspector `tools/list` | every tool has `readOnlyHint: true`; `library_overview` returns counts matching `index_status` |
| V10 | R11 | Veritas's own hub connects to its own MCP server | all tools `exposed` without "Trust this server" |
| V11 | N2 | diff of `server/requirements.txt` and every `package.json` | unchanged |
| V12 | N3 | `wc -l skills/veritas/SKILL.md`; `knowhow validate` | under 500 lines; description under 1024 characters |
| V13 | N4 | `tools/list` and a grep of `server/server.py` for writes | no tool writes; no file opened for writing |
| V14 | R12 | Follow the new connectors.md section on a clean scratch project | works as written, with no step missing |
| V15 | R13, R14 | Connect Valency in Settings; new Claude Code session; `tools/list` on the veritas server | `connector__valency__*` tools listed, all `readOnlyHint: true`; a disconnected connector is absent |
| V16 | R13 | `POST /connectors/call` naming a tool the hub marks `hidden_writes` or `hidden_unmarked`, and a made-up name | 403 both times; nothing reaches the connector (hub log) |
| V17 | R15 | grep `/connectors/tools` output, every MCP description, a sample result and the agent request log for the Valency token and "Bearer" | zero hits |
| V18 | R16 | `literature-expert` asks Valency for one paper | answer cites `[connector: valency]` with DOI; result wrapper present |
| V19 | R14 | Stop the sidecar, call `search_notes` and `connectors_status` | library answers; status names the missing sidecar |
| V20 | R17 | Disconnect Valency in Settings while a session runs | its tools disappear as D7 decides |
| V21 | N5 | 20 calls of one Valency tool from Veritas chat vs through MCP | median difference under 50 ms |
| V22 | N6 | dependency diff; private note matched by a connector query | unchanged; the private note never returned |

## Decisions for the user (recommended first)

- **D1. Findings folder:** `Second Brain/Findings/` next to `Digests/`, renamed with it if the `phase5/rename`
  branch ever lands (recommended, matches today's paths); or a new `Veritas/Findings/`.
- **D2. Answers with an unknown citation:** saving is blocked until the user removes the claim (recommended:
  findings hold only what can be checked); or saved with the citation marked `unknown` in the body and left out of
  `derived_from`.
- **D3. Chains:** findings may cite findings, with `finding_history` (recommended: this is how insight
  accumulates); or flatten, so saving copies the primary sources of any cited finding and chains never form.
- **D4. How `.mcp.json` launches the server:** a `veritas mcp` subcommand of the existing `veritas` command
  (Homebrew and the desktop app already ship it; recommended), so the agent reuses the installed index and nothing
  re-embeds; or `uvx --from git+https://github.com/frimpsjoek/veritas-ai veritas-mcp`, which needs the server
  packaged for PyPI and a second copy of the index and model (against the "reuse the index, never rebuild" rule).
- **D5. Write tools over MCP** (an outside agent saving a finding): not now (recommended, keeps N4); or a
  `save_finding` tool marked `readOnlyHint: false`, which Veritas's own hub would then hide by default.
- **D6. Telling people:** list on skills.sh and mention it in the README once V7 passes (a publish step: the
  user's gate); or keep it quiet for now.

- **D7. When agents see connector changes:** on the next session start (recommended: simplest; MCP tool lists
  are read at start by most clients), or live within a minute through MCP `notifications/tools/list_changed`
  (not every client honours it).

## Open questions

- Does the output folder get indexed by default on every install, or only when it is a listed source? The plan
  must check `server/sources.py` before R4 is built. (Owner: plan author.)
- Where the action sits in the Obsidian plugin: the shared chat pane is enough, or also a command-palette entry?
  (Owner: user.)

## Non-goals

- An LLM-maintained wiki: no concept or comparison articles written or rewritten without the user pressing Save.
- org-mode output, or linking several Veritas libraries together.
- Write access to the user's sources from any agent.

# Veritas Phase 1 — One Repo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `veritas` repo as a fresh copy of the three dev clones on this Mac (old repos and the running Second Brain server untouched), split into parts with enforced import boundaries, and every existing test passing — no behaviour change.

**Architecture:** Copy each old repo's tracked files at its branch tip (`git archive`) under a prefix into a new repo with fresh history; source commit SHAs are recorded for provenance. Then reorganise `agent/`, `ui/` and `web/` out of `zotero/` inside the new repo with `git mv`. Rewrite the relative paths the moves break. A small Node script enforces which part may import which; one root `check.sh` runs every part's tests plus the boundary check, locally and in CI.

**Tech Stack:** git 2.54 (`archive`), Node 22 + esbuild + tsc (JS/TS parts), Python 3 venv + pytest (server).

**Spec:** `~/Documents/second-brain-dev/2026-10-22-veritas-design.md` (goals 1, 2, 7). Roadmap: `2026-10-22-veritas-roadmap.md`.

## Global Constraints

- Repo location: `~/Documents/second-brain-dev/veritas` (never `~/Documents/second-brain`; macOS case-insensitive = the vault).
- Sources, at these branches, read-only (never modified): `obsidian-kb` @ `ai/web-page`, `zotero-plugin` @ `ai/web-page`, `obsidian-plugin` @ `ai/015-folders`.
- Layout: `server/ agent/ ui/ web/ zotero/ obsidian/ docs/specs/`.
- Allowed imports: `web/`, `zotero/`, `obsidian/` → `ui/`, `agent/`. `ui/` → `agent/`. `agent/` → nothing outside itself. Apps never import each other. `server/` contains no JS imports of other parts; it may name built artifacts (e.g. `agent/dist/agentd.mjs`) as file paths.
- No renames to "Veritas" in code in this phase (Phase 5). No behaviour change: same plugin IDs, ports, env vars, data paths.
- Veritas is a new server: its own data folder (`server/data/`, starts empty), its own port in dev (27190). It never reads or writes the old server's `obsidian-kb/data/` and never stops or replaces the old server or plugins.
- No `git push`, no GitHub repo creation in this phase without Joseph's explicit OK. Commit locally.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01L657nqBrxnWhEZg2s4V8nc
  ```

## Review Focus

1. **A path rewrite that still resolves to the old clone.** `../zotero-plugin/...` would keep working on this Mac because the old clones sit next door → the boundary check also rejects any path containing `zotero-plugin`, `obsidian-kb`, `obsidian-plugin`, `agent-src`, `ui-src` (Task 2 test `rejects old repo names`).
2. **JSDoc `import("...")` type paths** (dozens in `ui/src`) break only `tsc`, not tests → Task 3 runs `npm run typecheck` in `agent/` and `ui/`, and `npx tsc -p .` in `obsidian/`.
3. **Zotero build writes to the wrong place.** `ui-src/build.mjs` and `agent-src/build-zotero.mjs` write into `../content/`; after the move they must write into `zotero/content/` → Task 3 verify step checks `zotero/content/sb-ui.js` and `zotero/content/agent.js` exist with fresh mtimes after `zotero/build.sh`.
4. **Server can't find agentd.** `agent_api.py` resolves `zotero-plugin/agent-src/dist/agentd.mjs` → Task 4 test asserts the default entry is `<repo>/agent/dist/agentd.mjs`.
5. **Untracked live data lost or copied into git.** `obsidian-kb/data/`, `.venv`, `node_modules`, `dist*` are untracked and must not enter the repo → Task 1 verify: `git ls-files | grep -E '(^|/)(data|node_modules|\.venv|dist|dist-web)/'` prints only files that were tracked in the source repo.

---

### Task 1: Create the repo as a fresh copy

**Files:**
- Create: `veritas/README.md`, `veritas/.gitignore`, `veritas/docs/specs/veritas/2026-10-22-veritas-design.md` (copy), `veritas/docs/specs/veritas/plans/` (copy of these plan files), `veritas/server/requirements.txt`
- Create (evidence): `veritas/docs/specs/veritas/phase1-baseline.md`

**Interfaces:**
- Produces: repo with `server/` (= obsidian-kb), `zotero/` (= zotero-plugin), `obsidian/` (= obsidian-plugin) at their source branch tips; baseline test counts.

- [ ] **Step 1: Record baseline test results in the source clones** (read-only runs):
  - `cd obsidian-kb && KB_BACKEND=onnx .venv/bin/python -m pytest tests -q`
  - `cd zotero-plugin/agent-src && npm test`; `npm run typecheck`
  - `cd zotero-plugin/ui-src && npm test`; `npm run typecheck`
  - `cd obsidian-plugin && npm test`; `npx tsc -p .`
  - `cd zotero-plugin && node --test test/*.test.mjs`

  Write pass/fail counts and any pre-existing failures to `phase1-baseline.md`. A pre-existing failure is recorded, not fixed.
- [ ] **Step 2:** `git init veritas`, initial commit with README (one paragraph: what Veritas is, the part layout, `./check.sh`) and `.gitignore` covering `node_modules/ dist/ dist-web/ dist-versions/ .venv/ __pycache__/ .pytest_cache/ .DS_Store server/data/ server/models/`.
- [ ] **Step 3:** Copy tracked files only:
  ```bash
  mkdir server zotero obsidian
  git -C ../obsidian-kb     archive ai/web-page     | tar -x -C server
  git -C ../zotero-plugin   archive ai/web-page     | tar -x -C zotero
  git -C ../obsidian-plugin archive ai/015-folders  | tar -x -C obsidian
  ```
  Record the three source SHAs (`git -C ../<src> rev-parse <branch>`) in `README.md` under "Copied from".
- [ ] **Step 4: Verify the copy is exact and clean:**
  - For each part, `git -C ../<src> ls-files | sort` equals `(cd <part> && find . -type f | sed 's|^\./||' | sort)`.
  - Review Focus 5 command prints only paths tracked in the source repos.
- [ ] **Step 5:** `server/requirements.txt` = `../obsidian-kb/.venv/bin/pip freeze`; create `server/.venv` from it; run the server tests there — same counts as baseline.
- [ ] **Step 6:** Copy the design and plans into `docs/specs/veritas/`; commit "chore: copy Second Brain repos into Veritas".

### Task 2: Boundary check

**Files:**
- Create: `tools/boundaries.mjs`, `tools/boundaries.test.mjs`, `tools/fixtures/` (tiny fake trees)

**Interfaces:**
- Produces: `checkBoundaries(root: string): { file: string, line: number, spec: string, reason: string }[]` (exported) and CLI `node tools/boundaries.mjs [root]` → exit 0 when empty, else prints `file:line: reason` per violation and exits 1.

Scans `*.js *.mjs *.ts *.d.ts` (skipping `node_modules`, `dist*`, `vendor`, `content/` build outputs, `tools/fixtures`) for `import … from`, `import(…)` (incl. JSDoc), `require(…)`, `readFileSync(…)` and string paths in `*.config.mjs`/`build*.mjs`. Resolves each relative spec against the file, maps both ends to their part (first path segment), checks the allowed table from Global Constraints.

- [ ] **Step 1: Write failing tests** in `tools/boundaries.test.mjs` with fixtures:
  - `allows app → ui` (`web/src/a.js` imports `../../ui/src/dom.js`) → `[]`
  - `allows ui → agent` → `[]`
  - `rejects app → app` (`obsidian/src/x.ts` imports `../../zotero/content/y.js`) → one violation, reason contains `obsidian may not import zotero`
  - `rejects agent → ui` → one violation
  - `rejects old repo names` (`../zotero-plugin/ui-src/src/index.js`) → reason contains `old repo path`
  - `sees JSDoc import types` (`/** @type {import("../../web/src/x").T} */` inside `ui/`) → one violation
  - `rejects escaping the repo` (`../../../outside.js`) → one violation
- [ ] **Step 2:** `node --test tools/boundaries.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement `checkBoundaries` in `tools/boundaries.mjs`.
- [ ] **Step 4:** Tests PASS. Run `node tools/boundaries.mjs .` on the repo: expected exit 1, listing the obsidian→zotero-plugin imports (proves it bites).
- [ ] **Step 5:** Commit "feat: import boundary check".

### Task 3: Carve out agent/, ui/, web/ and fix paths

**Files (all `git mv`):**
- `zotero/agent-src` → `agent`; `zotero/agent-src/build-zotero.mjs` → `zotero/build-agent.mjs`
- `zotero/ui-src` → `ui`; `ui/build.mjs` (Zotero bundle) → `zotero/build-ui.mjs`
- `ui/src/web/*` → `web/src/`; `ui/build-web.mjs` → `web/build.mjs`; `zotero/install-web.sh` → `web/install.sh`
- `ui/src/web/sources.css` → `ui/styles/sources.css` (Home uses it in every app; ui must not depend on web)
- Web-only tests → `web/test/`: `library-data`, `web-view-kit`, `sources-data`, `pdf-geometry`, `web-progress`, `web-transport`, `browser-state` (`.test.js`); `ui/dev/web-checks.mjs`, `ui/dev/web-library-checks.mjs`, `ui/dev/harness/perf-web.html` → `web/dev/`
- `web/package.json` (new: name `second-brain-web`, scripts `build`, `test`, `typecheck`; deps esbuild, katex, typescript as used); `web/tsconfig.json` (copy of ui's)
- `server/specs/*` → `docs/specs/` (keep numbers 001–022 + ROADMAP.md)
- Modify: `zotero/build.sh`, `ui/home-assets.mjs`, `ui/package.json` (drop `build`, `build:web`), `.github/workflows/` (Task 5)

**Interfaces:**
- Consumes: `checkBoundaries` (Task 2).
- Produces: `npm test` + `npm run typecheck` green in `agent/`, `ui/`, `web/`; `web/build.mjs` writes `web/dist-web/`; `zotero/build.sh` builds the xpi from `../agent`, `../ui`.

- [ ] **Step 1:** Do the `git mv`s; commit "refactor: move parts" (pure moves inside the new repo).
- [ ] **Step 2:** Rewrite relative paths: `agent-src/` → `agent/` in `ui/` (depth unchanged: `ui/src/chat/x.js` → `../../../agent/src/...`); in `web/src/*` `../X` → `../../ui/src/X` and `../../../agent-src/` → `../../agent/`; Zotero build outputs `../content/` stay correct only if the scripts run from `zotero/` — set them to resolve `zotero/content/` from their own location (`new URL('./content/', import.meta.url)`), inputs from `../ui` / `../agent`. `home-assets.mjs`: `src/web/sources.css` → `styles/sources.css`. `zotero/build.sh`: build `../agent` (`npm run build` for agentd), `node build-agent.mjs`, `node build-ui.mjs`; the Obsidian type-check uses `../obsidian` and always runs (sibling now always present).
- [ ] **Step 3: Verify:**
  - `node tools/boundaries.mjs .` — only obsidian violations remain (fixed in Task 4).
  - `cd agent && npm ci && npm test && npm run typecheck`; same in `ui/`, `web/` — counts match baseline (tests are split between ui and web; sum equals ui baseline).
  - `cd zotero && ./build.sh` → `dist/second-brain-<version>.xpi` exists; `zotero/content/sb-ui.js`, `agent.js`, `home/sb-home.css` rebuilt (mtime now); `node --test test/*.test.mjs` matches baseline.
  - `cd web && npm run build` → `dist-web/index.html` + hashed `app-*.js`, `app-*.css`, `pdf-*.mjs`.
- [ ] **Step 4:** Commit "refactor: fix paths after split".

### Task 4: Obsidian and server point at the new parts

**Files:**
- Modify: `obsidian/src/{status,settings-tab,search,api,ui-host,home,context-sources,chat,zotero,related,duplicates,agent-api}.ts`, `obsidian/esbuild.config.mjs`, `obsidian/install.sh`
- Modify: `server/agent_api.py:27,54-56`, `server/http_api.py:360`, `server/plugin_updates.py`
- Test: `server/tests/test_layout.py` (new)

**Interfaces:**
- Produces: `agent_api.AGENTD_ENTRY == REPO / "agent" / "dist" / "agentd.mjs"`, `http_api.ZOTERO_DIST == REPO / "zotero" / "dist"`, where `REPO = kb.HOME.parent` (kb.HOME is `server/`). `SECOND_BRAIN_AGENTD_ENTRY` override unchanged. `plugin_updates` reads xpi from `REPO/zotero/dist` and Obsidian versions from `REPO/obsidian/dist-versions`.

- [ ] **Step 1: Write failing test** `server/tests/test_layout.py`:
  - `test_agentd_entry_in_repo`: `agent_api.AGENTD_ENTRY.relative_to(kb.HOME.parent) == Path("agent/dist/agentd.mjs")` (resolve however `agent_api` combines it today)
  - `test_zotero_dist_in_repo`: `http_api.ZOTERO_DIST == kb.HOME.parent / "zotero" / "dist"`
  - `test_plugin_update_paths`: the two dirs `plugin_updates` reads are `REPO/zotero/dist` and `REPO/obsidian/dist-versions`
- [ ] **Step 2:** Run → FAIL. **Step 3:** Fix the three server files. **Step 4:** Full server suite PASS, counts = baseline + 3.
- [ ] **Step 5:** Obsidian: `../../zotero-plugin/ui-src/` → `../../ui/`, `../../zotero-plugin/agent-src/` → `../../agent/`, `../zotero-plugin/ui-src/` → `../ui/`; `install.sh` last line → `../web/install.sh` with `KB=../server`. `web/install.sh` default `KB` → `$(cd ../server && pwd)`.
- [ ] **Step 6: Verify:** `node tools/boundaries.mjs .` exit 0; `cd obsidian && npm ci && npx tsc -p . && npm test && node esbuild.config.mjs` (do **not** run `install.sh` — it writes into the live vault); counts = baseline.
- [ ] **Step 7:** Commit "refactor: obsidian and server use repo parts".

### Task 5: One check command and CI

**Files:**
- Create: `check.sh`, `.github/workflows/check.yml`
- Delete: `zotero/.github/` (moved CI; its release.yml is replaced in Phase 5)

**Interfaces:**
- Produces: `./check.sh` → runs, in order, `node --test tools/*.test.mjs`, `node tools/boundaries.mjs .`, agent/ui/web/obsidian tests + typechecks, `zotero/build.sh` + its `test/*.test.mjs` + existing syntax/XML/update.json checks, server pytest (`KB_BACKEND=onnx`, skipped with a notice if `server/.venv` is absent and `python3 -m pytest` is not importable). Exit non-zero on first failure; prints a one-line summary per part.

- [ ] **Step 1:** Write `check.sh`; run it → all green, counts = baseline (+ Task 2/4 tests).
- [ ] **Step 2:** `check.yml`: Node 22 + Python 3.12, `pip install -r server/requirements.txt`, `./check.sh`; artifact upload of the xpi with `retention-days: 7` (account-wide quota note from the old check.yml).
- [ ] **Step 3:** Break it on purpose: add `import x from '../../obsidian/src/api.ts'` to a `web/src` file → `./check.sh` fails at the boundary step; revert.
- [ ] **Step 4:** Commit "ci: one check for the whole repo".

### Task 6: Live smoke test and hand-off

**Files:**
- Modify: `docs/specs/veritas/phase1-baseline.md` (add after-results + smoke evidence)

- [ ] **Step 1:** Stop nothing that is running (the old server keeps running). Start the Veritas server from `veritas/server` on port **27190** with `SECOND_BRAIN_AGENTD_ENTRY` unset (proves the new default), its own empty `server/data/`, and a fresh sources list written by `sources.add()` for `~/Documents/lab-notebook` and `~/Zotero` (read-only sources; Veritas builds its own index).
- [ ] **Step 2:** `cd web && ./install.sh` with `KB=$PWD/../server` → `server/data/web/index.html` present; `curl -s localhost:27190/app/ | grep -c app-` ≥ 1; a search request through the API with the token returns results; `/agent/` status shows agentd running from `agent/dist/agentd.mjs`.
- [ ] **Step 3:** Record before/after counts and the smoke outputs in `phase1-baseline.md`; stop the 27190 server; commit "docs: phase 1 evidence".
- [ ] **Step 4:** Report to Joseph: commits, counts, anything that differed from baseline. Ask for OK before creating `frimpsjoek/veritas` on GitHub (private) and pushing.

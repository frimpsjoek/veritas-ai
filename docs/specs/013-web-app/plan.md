# Plan: Second Brain in the browser (spec 013)

Date: 2026-10-11. Repos: `~/obsidian-kb` (server `http_api.py`, specs), `~/obsidian-kb/zotero-plugin` (`ui-src`,
`agent-src`, Zotero plugin), `~/obsidian-kb/obsidian-plugin`. Decisions: spec Status line (approved 2026-10-11).

## 1. Corrections to the spec after reading the code

- **No PDF route exists.** `POST /attachment` saves a pasted image; it does not stream PDFs. W2 adds
  `GET /zotero/pdf?key=<attachmentKey>`, path-checked against Zotero's `storage/` folder.
- **Related, Links, Duplicates and Status are Obsidian-only TypeScript** (`obsidian-plugin/src/related.ts` etc.), not
  shared panels. W2 ports their data logic into `ui-src/src/panels/` and Obsidian then uses the shared ones.
- **PUT is not forwarded to the sidecar** (`agent_api.forward` handles GET, POST, DELETE). Web prefs use POST.
- `ChatView` keeps page-global state (`OPEN_VIEWS`, `ChatView.refreshAll`, `setDefaultHost` in find-view.js). The
  shell mounts exactly one `ChatView` and switches its mode; it never mounts two.

## 2. Data shapes

```ts
type HostKind = "zotero" | "obsidian" | "web";
type Placement = "tab" | "sidebar" | "pane" | "dialog" | "page";
// Web shell route: one of these, kept in location.hash so reload and Back work.
type WebRoute =
  | { view: "home" } | { view: "chat"; mode?: ChatMode; session?: string }
  | { view: "library"; collection?: string } | { view: "notes"; q?: string }
  | { view: "paper"; key: string } | { view: "note"; path: string }
  | { view: "routines" } | { view: "settings" };
// Server-side web state, data/web/state.json: { prefs: Record<string, unknown>, files: Record<string, string> }
// Pending adds, data/web/pending-adds.json: { id, at, paper: OutsidePaper, collection: string|null, done: boolean }[]
```

Request classes for the security check (W0), decided per request from headers only:

| Class | How it is recognised | Rule |
|---|---|---|
| plugin / CLI / agent | no `Sec-Fetch-Site`, no `Origin` (or an allowlisted app origin seen in W0's header log) | today's rules |
| app page | `Sec-Fetch-Site: same-origin` / `none` with a local Host | allowed (only our own page can be same-origin; the Host check already blocks DNS rebinding) |
| another website | `Sec-Fetch-Site: cross-site` / `same-site`, or an `Origin` not on the allowlist | 403, every method |
| phone through Tailscale | proxy headers present | Bearer token or `sb_session` cookie from the QR sign-in |

The allowlist is filled from observation: W0 first logs the `Origin` / `Sec-Fetch-*` headers that real Zotero and
real Obsidian send, then encodes them. No guessing.

## 3. Units

| Unit | Roadmap slice | Content | Version |
|---|---|---|---|
| W0 | Slice 0 | Origin / Sec-Fetch-Site guard, `sb_session` cookie, tests | server only (commit) |
| W1 | Slice 1 | `build:web`, web host, shell (home with today's digest + recent conversations, chat with all modes, routines, skills, projects, settings), `/app` static serving, PWA manifest + icon | 0.46.0 |
| W2 | Slice 2 | Library table, Notes view, paper reader (PDF route), note reader, shared Related/Links/Duplicates panels, Open in Zotero / Obsidian | 0.51.0 |
| W3 | Slice 3 | Add to Zotero (connector when Zotero runs, queue otherwise + Zotero plugin consumer), Read later, notes to the vault | 0.52.0 |
| W4 | Slice 4 | Phone: QR sign-in, 360 px layout (bottom bar), real iPhone check | 0.53.0 |
| W5 | Slice 5 | Publish: web bundle installed with the plugins, perf rows for the web build, README | 0.53.x |

Order with spec 012: W0 + R1 in parallel, then W1, R2, W2, R3, R4, W3, W4, W5 + R5.

### W0. Security (server)
- Log real headers first: a temporary debug line in `_allowed` written to `data/serve.log` for one request each from
  real Zotero (chat send), real Obsidian (search), curl, and a browser page. Record them in this plan's Results.
- `http_api.py`: `request_class()` from headers (table above); `_allowed` applies its rule. Proxied (phone) requests
  accept the Bearer token or an `sb_session` cookie (random per sign-in, stored in `data/web/sessions.json`,
  `HttpOnly; Secure; SameSite=Strict; Path=/`); the cookie is issued by `POST /app/login {token}` (W0 adds the
  route; W4 adds the QR page). No CORS headers.
- Laziness: no cookie for localhost. A cross-site page cannot make a same-origin request, so blocking `cross-site`
  / `same-site` / foreign `Origin` is enough there.
- `tests/test_http_security.py`: starts the real server class on a free port; checks a cross-site Origin gets 403 on
  `POST /index`, `PUT /skills/x`, `GET /search`, `POST /agent/...`; the plugin-style request (no Origin) still gets
  200; a same-origin app request gets 200; a Tailscale-proxied request needs the token or a cookie from `/app/login`.
- Live: real Zotero chat and real Obsidian search still work after the server restart.

### W1. Web host and shell (0.46.0)
- `ui-src/build.mjs` gains a web target: `src/web/index.js` as an ES module bundle, `platform: 'browser'`, written
  to `ui-src/dist-web/` with `index.html`, `app.css` (`tokens-web.css` + `ui.css`), `manifest.webmanifest`, icons.
- `ui-src/src/web/host.js`: `createWebHost()` implementing `UiHost` (`kind: "web"`, `placement: "page"`) per the
  table in spec section 2; `ai()` = `createRemoteRuntime` with a `fetch` transport (same long-poll stream as
  `obsidian-plugin/src/agent-api.ts`); `prefs`/`files` through `POST /web/state`; `searchOutside` through the agent
  (`/agent/...` scholarly search) so no cross-origin fetch happens in the page.
- `ui-src/src/web/shell.js`: left rail (Home, Chat, Library, Notes, Routines, Projects; Settings and Search index in
  the ellipsis menu), hash router over `WebRoute`, one `ChatView`. Home = today's digests (routines with news) and
  recent conversations. Library/Notes/readers show "coming in W2" placeholders hidden from the rail until W2.
- Host-aware wording: source pills and "Add to Zotero" labels read from the host (spec 013 pitfall 3).
- Server: `GET /app/*` serves `data/web/` (no `LOCK`, content types for html/js/css/svg/png/webmanifest, no-cache on
  index.html, long cache on hashed assets); `GET/POST /web/state`.
- Tests: `ui-src/dev/harness/web.html` + fake web host, `dev/web-checks.mjs` (shell routes, chat send, routines
  list, at 1280 / 700 / 360 px, no sideways page scroll), Python test for `/app` and `/web/state`.
- Live: in a real browser over CDP with Zotero and Obsidian quit, ask a library question with citations, run Find
  papers, start a quick report (spec check 1, first half); screenshots in Results.

### W2. Library, notes, readers (0.51.0)
- Server: `GET /zotero/pdf?key=` (attachment file under Zotero storage, realpath check, `application/pdf`,
  streamed, Range support so the browser PDF viewer can seek), `GET /zotero/items` (shared with spec 012 R1).
- UI: `web/library-view.js` (collection tree + table artifact over `/zotero/items` and `/search`), `web/notes-view.js`
  (vault search + recent), `web/paper-view.js` (metadata, abstract, PDF in an `<iframe>` of the browser viewer,
  highlights/notes from `/zotero?key=`), `web/note-view.js` (`/note` + `/render`, wiki links routed in-app),
  "Ask about this" (adds the item as chat context), "Open in Zotero" (`zotero://select/library/items/KEY`) and
  "Open in Obsidian" (`obsidian://open?vault=...&file=...`).
- Shared panels: port Related/Links/Duplicates data logic from `obsidian-plugin/src/*.ts` into `ui-src/src/panels/`,
  switch Obsidian to them (migrate callers, delete the old TS in the same unit).
- Live: open a paper and its PDF, a note with links, both Open-in buttons (spec check 3).

### W3. Write-backs (0.52.0)
- Server: `POST /zotero/add {paper, collection}`: `GET 127.0.0.1:23119/connector/ping`; if Zotero answers, post
  `connector/saveItems` (with the collection as target) and report "added"; else append to
  `data/web/pending-adds.json` and report "queued". `GET /zotero/pending-adds`, `POST /zotero/pending-adds/done`.
- Zotero plugin: consume pending adds at startup and every 5 min, through `Discover.add()` (same lookup as the
  in-app Add), modeled on `applyObsidianEdits`; idempotent by id (spec check 4: exactly once).
- Read later = a queued Zotero edit of kind `tag`. Digests and saved answers go to the vault through `PUT /digests`.
- Live: add with Zotero open (item in collection in under 3 s); quit Zotero, add, start Zotero, item appears once.

### W4. Phone (0.53.0)
- Settings on the Mac shows a QR code of `https://<mac>.<tailnet>.ts.net/app/login#<token>`; the login page posts the
  token once and gets the `sb_session` cookie. QR drawn by a small vendored generator (no CDN).
- 360 px: bottom bar, composer pinned, tables scroll inside their card, no page-level horizontal scroll.
- Check: harness at 360 px; then the real iPhone over Tailscale (spec check 6, needs the user's phone).

### W5. Publish
- `obsidian-plugin/install.sh` (the existing publish step) also runs `build:web` and copies `dist-web/` to
  `~/obsidian-kb/data/web/`; the server serves the new version on the next page load.
- `perf/`: a `perf-web.html` row (first load under 1 s, stream render rows), budgets added; `perf/README.md`.

## 4. Verification per unit

`pytest tests`, `ui-src npm test` (includes the web checks), `agent-src npm test`, strict tsc in obsidian-plugin, the
real-Zotero harness for anything that touches shared UI, Obsidian over CDP, and the web app in a real Chromium over
CDP (never steal focus: background window). Screenshots go in Results.

## 5. Results

### W0 (2026-10-11, server 140e3df + fd3f269, merged 8203256)
- `request_class(headers)` -> foreign / local / proxied; `_allowed` refuses foreign with 403 (and logs Origin and
  Sec-Fetch-Site to serve.log), proxied needs Bearer or `sb_session` from `POST /app/login`.
- Header log step replaced by a live check: real Zotero (harness `t-int-d-remote-runtime.js`: server reachable,
  remote runtime picked) and real Obsidian 0.45.2 over CDP (`/search`, `/zotero/collections`, `/agent/conversations`)
  all pass; serve.log shows only the two deliberate foreign test requests refused.
- Tests: `tests/test_http_security.py` (21 classifier cases, 3 live-server tests); full suite 84 passed.

### W1 engineering (2026-10-11; server 965f4e9 merged 8bd34e5, ZP 783b350 merged 576a6f7, scholarly route + web Find papers ZP after e17bd63)
- Live at `http://127.0.0.1:27182/app/` (bundle copied to `data/web/`). Headless Chrome over CDP against the real
  server: Home lists real conversations; a real chat question ("GW calculations for point defects") answered in
  12 s with 6 library citations (chat role switched to Claude for that one turn and restored to the user's local
  Qwen 4B, which failed on the memory gate: 3.5 of 4.0 GB free). 390 px: bottom bar, no sideways scroll.
- Gap closed: `scholarly.search` service + `POST /agent/scholarly/search`; live: 15 papers (OpenAlex, arXiv),
  Semantic Scholar named as failed (rate limit).
- Regression: ui-src 139 unit + all harness suites (104 web checks); Obsidian strict tsc + build + 17 tests; real
  Zotero t-unified-chat 29/29, t-chat-look 17/17, t-find-papers 21/21 (fresh profiles).
- Merge incident: merging ai/w1-server into the live checkout conflicted in http_api.py; the merge was aborted at
  once (server kept running, file parsed). Rule since then: merge main into the feature worktree first, test,
  then fast-forward the live checkout.
- Reference board: `refs/board.md` (16 images, 13-rule ledger, direction "type over boxes"). Styling pass running.

### W2-W5 (2026-10-11; 0.48.0 and 0.49.0)
- W2: library/notes/paper/note views, shared Related/Links/Duplicates (Obsidian migrated, OP b66bef2), PDF route incl.
  linked files (1,626 of 4,131 resolve), slim items (0.94 MB, 33 ms). LaTeX titles as MathML (ZP 0e598fe).
- W3: Zotero's connector saveItems saved nothing without a Zotero window, so every add is queued and the running
  plugin is asked to apply it at once (POST /second-brain/pending-adds/apply, refuses any Origin). Live: queue ->
  plugin -> item once, in the collection, tagged, metadata from the DOI. 6-8 s with Zotero open (DOI lookup).
- W4: GET /app and /app/login public to tailnet callers, data needs the sb_session cookie; tailscale serve's http
  port sends no X-Forwarded-Proto, so either scheme on the tailnet host is our origin and the cookie is Secure only
  behind https (c1167c7). Verified from the Mac over the tailnet; the iPhone check is the user's.
- W5: install-web.sh in the release, perf rows, README.


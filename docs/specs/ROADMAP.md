# Second Brain roadmap

Updated 2026-10-12. Live version: **0.50.3** (Zotero and Obsidian, published in lockstep).

`- [x]` done · `- [ ]` to do · `- [~]` dropped on purpose. Items get ticked as soon as they are verified
(see `../CLAUDE.md`). Version and commit are in brackets; ZP = zotero-plugin, OP = obsidian-plugin. Server work
(kb.py, http_api.py) is not in git, so it has no commit.

---

## To do

### Next: spec 012 Reading radar (approved 2026-10-11, in progress)
- [x] Approve decisions D1-D5 and answer the open questions (name, Obsidian note, sites without RSS, MCP sources, sizes) [2026-10-11, see spec Status line]
- [x] Write plan.md (units and tasks are in the plan) [2026-10-11]
- [x] Slice 0: custom schedules for every routine: days (every day / weekdays / picked days / every N days / monthly) × times (up to 6, or every N hours in a window), once-an-hour floor, "When" row with next-run preview, old routines migrated (your Monday 08:00 routine checked) [0.45.2, ZP e9294cf, 7121f8d, 621839d]; real-Zotero t-routines 40/40
- [x] Slice 1: sources (databases, RSS/Atom feeds, journals, authors, MCP tools), merge preprint + journal version, seen set, local scoring [2026-10-11, server 58f9fdd, ZP 8a3b56e + R1b e17bd63; live: arXiv, chemRxiv, PRB + Science feeds, npj Comput. Mater. journal, Galli author, broken feed isolated, real radar routine through the sidecar wrote New + badge; Hugging Face MCP (streamable-HTTP session handshake, hf_fs search + trending preset) connected and called through the sidecar. Nature/ACS feeds block readers: use journal by name]
- [x] Slice 2: field profile from your library, profile editor, radar setup sheet [0.47.0, ZP a4d9d9e + 7182484, server d74dcf0; real Zotero t-radar-setup 11/11 against the live server; profile seeds title phrases (quantum dots, density functional theory, covalent organic frameworks) and OpenAlex-matched authors/journals; Nature feed -> journal suggestions]
- [x] Slice 3: "Worth reading" older papers from the citation graph [0.46.0, ZP e8a87ed; a live radar routine wrote New + Worth reading; counts hand-checked against OpenAlex (51/51, 35/35)]
- [x] Slice 4: digest view (New / Worth reading tables), Add to Zotero / Read later / Not relevant, learning from clicks [0.48.0, ZP 6316f3e..0dab488 merged 9a92221; real Zotero t-radar 14/14 on the live server: summary line, why lines, Add to Zotero / Read later / Not relevant + Undo, no repeats on the second run, vault note written]
- [ ] Slice 5: real runs with you, tune ranking, publish (built, check owed: your "Reading radar" routine was created 2026-10-11, daily 07:00, 7 sources, 12 phrase topics; rate the top 10 New rows of the 10-12 and 10-13 digests, target 7 of 10 relevant, then weights get tuned)

### Spec 014 Radar onboarding, discovery, highlighting, Home in Zotero and Obsidian (approved 2026-10-11, in progress)
Spec: `014-radar-onboarding-highlights/spec.md`.
- [x] Approve decisions D1-D5 [2026-10-11, as recommended]
- [x] Write plan.md [2026-10-11]
- [x] G1: onboarding "who and what to follow" (topics, authors, journals, feeds, databases; Dia-style chips and ring; Sources in More) [2026-10-11, ZP 521c3a4..fc932b0; live: your radar shows 35 followed, suggests Physical Review B; harness at 1280/700/360]
- [ ] G2: "Might interest you": up to 3 papers a day from outside the followed sources (citing your key papers, co-authors, related works), each with its reason (built, ZP 521c3a4, 702 tests on replayed OpenAlex; check owed: needs your free OpenAlex key, then the next morning's issue)
- [ ] G3: highlight in the web reader (PDF.js), saved as Zotero annotations through the queue, copied into the Obsidian note (built, ZP 575fff3..a15d013, server 9add81a + 1f2ab56; live: your highlights draw on the real PDF (RN54CKHQ, 21); saveFromJSON shape checked against Zotero 7's source; check owed after the plugin release: make one highlight, see it in Zotero and the Obsidian note)
- [ ] G4: the new Home in Zotero (tab) and Obsidian (view), fonts and photos bundled (built, ZP 690c2b1, OP c5eb57a; home harness 40 checks. Obsidian checked live in a separate test Obsidian against the real server: 0.50.0 showed a blank Home because HomeView.open replaced Obsidian's View.open, fixed in 0.50.1 (OP d78b3ba, test src/views.test.ts), now today's issue, figures and shelves draw. Check owed: Zotero's Home tab (Tools > Second Brain Home) after Zotero updates to 0.50.1)
- [x] Release after G4 [2026-10-11, 0.50.0 (ZP a422481, OP b96ba5c), 0.50.1 Obsidian Home fix (OP 05afc16, ZP 26f4745); both update feeds report 0.50.1]
- [x] Earlier radar issues open on Home as a list like today's (not inside the chat), with "Chat about this issue" one link away; the Artifacts (N) menu no longer opens as a clipped sliver [2026-10-12, 0.50.2, ZP 257f0f9 + 4829e77; harness web 282, home 40, artifacts 72; live: Oct 11 issue opens at #/home?issue=, 9 papers; Artifacts menu shows both rows whole]
- [x] Home papers: graphical abstract on the right in one 4:3 frame, filled and cropped from the top [2026-10-12, 0.50.3; harness 1280/700/360; live: Oct 11 issue, every figure 144x109 in two columns]

### Spec 013 Web app (approved 2026-10-11, in progress)
Second Brain in any browser at `127.0.0.1:27182/app`, with Zotero and Obsidian closed, connected to both. Spec: `013-web-app/spec.md`.
- [x] Home redesign (Folio reference): Fraunces + Inter, light/dark switch, today's radar issue full width with its papers in abstract form (one or two columns, where each was found, ‹ › to earlier days), shelves for Research reports / Chats / Earlier issues 8 a page, report covers with NASA photos, chats as text cards [2026-10-11, ZP eb283a9..f0b9f08; web/phone/library harness green; checked live in light, dark and at 390 px]
- [x] Web reader: vault images (![[x.png]]) and hidden %% comments %%; radar vault note as a reading list instead of a table [2026-10-11, ZP 0ea888c; PBE note image and today's digest checked live]
- [x] Home papers: graphical abstract on the left (arXiv figures, Springer Nature figure pattern, article preview image; ACS/APS/RSC/Elsevier block it), full abstract behind "Read the abstract" [2026-10-11, ZP acb1351, server 1c3e472; live: 4 of 9 papers with figures]
- [x] Web reader: maths as MathML in STIX Two Math ($$ alone = display, in a sentence = inline), note tables scroll and columns stretch, sources as a list, Obsidian line breaks and links, YouTube thumbnails, expired images labelled [2026-10-11, ZP 1c2eb0e, 06cc773, d55ee08; Sternheimer note: 156 formulas, 0 raw]
- [x] Server file-handle leak fixed: each request closes its index connections (ran out of handles: "unable to open database file", /app 500) [2026-10-11, server 1c3e472; 280 requests leave 8 handles]
- [x] Local models: greetings skip the search, swap-aware memory check, smaller-model fallback, models with no room disabled ("Free memory first"), web requests wait out a sidecar restart, tabs reload onto a new build [2026-10-11, ZP 0ea888c, 84e8a7a, f0b9f08; 692 server tests; live refusal message checked; a real Woof reply to "hi" owed (no free memory at the time)]
- [x] Approve decisions D1-D5 and answer the open questions (name/address, PWA, first view, no-Zotero users, keep plugin panes) [2026-10-11, see spec Status line]
- [x] Write plan.md (units and tasks are in the plan; UI references are chosen in W1) [2026-10-11]
- [x] Slice 0: security: Origin / Sec-Fetch-Site checks and session cookie (protects today's plugins too) [2026-10-11, server 8203256; 84 server tests; live: another site's POST /index and cross-site /search get 403, real Zotero (harness, remote runtime) and real Obsidian 0.45.2 (search, collections, /agent) unaffected]
- [x] Slice 1: web host + shell: `/app` static serving, `build:web`, chat, Find papers, reports, routines, skills, projects [0.46.0 + styling in 0.47.0, server 8bd34e5, ZP 576a6f7 + c91611b; live chat answer with 6 citations, outside search, 390 px; styled from the reference board (artifact D2zHrBMHE6FuEKpxSbSb4L)]
- [x] Slice 2: library table, notes view, paper and note readers, Open in Zotero / Obsidian [0.48.0, ZP 5516824..aad4419 + slim rows 05b79dc, server 3415baa + 05ff306, OP b66bef2 (Obsidian uses the shared Related/Duplicates panels); live Library 3,529 papers, slim list 0.94 MB / 33 ms; PDFs: 1,626 of 4,131 attachments resolve (linked files via Zotero's base folder)]
- [x] Slice 3: write-backs: Add to Zotero (connector or queue), Read later, notes to the vault [0.48.0, server c7e5f80, ZP 290b532; live: POST /zotero/add on the real server queued while Zotero was closed, a Zotero with the plugin applied it on its next poll: once, in the collection, tagged, metadata from the DOI. With Zotero open the server asks the plugin to apply at once (harness 11/11, 6-8 s because of the DOI lookup, not the spec's 3 s). Zotero's connector saveItems was tried and dropped: it saves nothing without a Zotero window]
- [ ] Slice 4: phone: QR sign-in, 360 px layout, real iPhone check (built, check owed: scan the QR in the web app's Settings with your iPhone, ask a question, open a PDF, see a routine's badge. Verified from the Mac through the tailnet 2026-10-11: sign-in sets the cookie over the http serve port, data needs it, the token page refuses tailnet callers; 0.49.0, server c1167c7, ZP 9179df1)
- [x] Slice 5: publish: web bundle in the updater, perf rows, README [0.49.0: obsidian-plugin/install.sh runs zotero-plugin/install-web.sh (atomic swap into data/web); perf rows ui.webFirstLoad (76-200 ms) and ui.streamWeb.*; README Web app section; server 1271a63]

### Checks owed on features already live
- [x] Speed baseline: first clean perf run, needs an idle Mac (load < 4, swap < 70%). The weekly job first fires Sun 2026-10-11 05:00 (009) [2026-10-11 06:16 by hand, perf/reports/2026-10-11.md: UI all within budget; server over the placeholder budgets]
- [x] Server runs at background priority: the LaunchAgent's `ProcessType Background` puts kb.py serve on the efficiency cores, making /related 4.5x slower (31 ms vs 140 ms), collections 6x and the vector load 0.9 s vs 3.9 s. Fix: Standard priority for the server, background QoS only for its indexing threads (009) [2026-10-11, kb.py `background_priority`, install-service.sh; after: search p50 48→14 ms, related p50 140→34 ms, cold first search 2.2→0.9 s; the perf LaunchAgent also moved off Background so weekly runs measure the performance cores]
- [x] Cache /zotero/collections until the index changes (12 ms per call, recomputes json_each over every Zotero item) (009) [2026-10-11, p95 76→0.8 ms]
- [x] Re-base the perf budgets from that run (009, 011) [2026-10-11, perf/budgets.json `_status`; 07:25 run passes all 17]
- [ ] Turn on the perf gate before publishing: add perf/gate.sh to install.sh/build.sh (009; needs your OK)
- [ ] Live skill run with a real model (011 U3)
- [ ] Live routine catch-up: stop the server past a routine's time, restart, see exactly one run (011 U4)
- [ ] Depth estimate within 25% for Fast and Smart (only Balanced checked: 14 estimated vs 15 actual) (011 U1)
- [ ] Skill edited in Obsidian shows in Zotero after one refresh (011 U3)
- [ ] Formal real-window look check of 0.40-0.45 in Zotero and Obsidian (011)
- [ ] Local models in the real apps: Answer-with menu, "Passages used", Settings rows, a no-results answer, reports refused for local (010)
- [ ] Shared panels in real Obsidian: Vault search, Related, Zotero item tab, Duplicates, Search index at 360 and 960 px; Settings model state in Zotero (005 D)
- [ ] A real systematic review of about 100 candidates, judged by you (007 E8)
- [ ] One real quick report started from Obsidian (007 E7)
- [ ] Ask from the phone over Tailscale, and 5 hand-checked answers in Obsidian (001 T3.5)

### Small fixes and leftovers
- [ ] OpenAlex free budget: keyless requests share ~$0.10/day per IP (~100 searches). Built in 0.49.0: key setting (web Settings, Zotero prefs, Obsidian settings), fail-fast with a plain message on 429, Obsidian Find papers via the agent. Owed: you add a free key from openalex.org/settings/api
- [x] Library titles show raw LaTeX ($U(1)$); render math like the chat does (013 W2) [ZP 0e598fe]
- [x] Radar: skip datasets, theses and Zenodo uploads from OpenAlex unless asked (seen in the R4 live run) (012 R5) [ZP b7f62c0, RECORD_KINDS table; live check waits for the OpenAlex reset]
- [ ] "Answer with" menu: rows can no longer be squashed (Obsidian fixed height / Zotero 25px cap), untested models folded under "More models (N)", "N models found" dropped (010) [0.45.2, ZP 226fdca] (built, check owed: open the menu in your real Zotero and Obsidian; the original overlap was not reproduced, see the harness worst-case checks)
- [x] `@` context picker in Zotero; "+" now opens it, "Search all papers…" keeps Zotero's dialog (008) [0.45.1, ZP 7826b32]
- [x] Zotero reader "Current" chip live check: works; new test t-reader-current (008) [0.45.1, ZP 858c662]
- [x] Define the missing `--sb-ui-shadow` colour token in both themes (008) [0.45.1, ZP 010eeb9]
- [x] Chat speed: streaming swaps only the growing tail; layout per stream 66 → 43 ms, Obsidian CSS 100 → 72 ms (008) [0.45.1, ZP d046333]
- [x] Perf harness: Obsidian fonts/images served; any HTTP error now fails the run (008) [ZP 23fb1f1]
- [ ] Zotero perf test for the weekly run (009)
- [x] Usage line under Depth: "Codex: 42% of 5-hour window · 3 minutes ago" (011 U1) [0.45.1, ZP 175a1f9]
- [ ] "Fastest" depth: abstracts only, no model screening (011 U1, deferred)
- [x] Auto-update test made current: reads the version, builds its own fixtures, 11/11 (006) [ZP dc49ba2]
- [x] Find table summary going stale: no longer possible (narrowing makes a new version without the summary); test added (002) [ZP 97bbc89]
- [x] Chat tab suggestions follow the library selection when you come back to the tab (was broken) (003) [0.45.1, ZP 6740af4]
- [ ] Measure search speed while several researchers run in parallel (001 T7.1)
- [ ] Copilot watcher: the 2026-10-09 report failed (no permission for `gh`/web), so no comparison was made
- [ ] Release housekeeping: GitHub branch stops at 0.38.0 (71 commits behind), no tag since v0.17.2, no PR (001 T7.3; ask first)
- [x] Result notes added to specs 002, 003, 005, 006 and 007 plans (2026-10-10)

---

## Done

### 0.45.2 (2026-10-10)
- [x] Custom routine schedules (012 slice 0) and decluttered Answer-with menu [ZP adc5cd8, OP e5a3ded]; real-Zotero suite 37/39 (the 2 are Codex not installed and no server in local mode)

### 0.45.1 fixes (2026-10-10)
- [x] Zotero `@` picker, usage line, lighter streaming, chat tab follows the selection, shadow token, reader chip test, auto-update test, perf harness 404s [ZP d1b3a26, OP f990ba3]; full real-Zotero suite 39 files green except Codex-not-installed and a local-model memory refusal (environment)

### 011 Elicit parity (0.39.3-0.45.0)
- [x] Abstracts for outside papers from OpenAlex [0.39.3, ZP 08e389f]
- [x] Depth slider Fast / Balanced / Smart with a time estimate [0.40.0, ZP 3f88215]; estimate recalibrated from live runs [f4f2f30, 56fdaa2]
- [x] Table edits as conversation, gap fill, follow-up chip, Sources view [0.41.0, ZP 2a06802, 252a986, 68eb218, 2108b1f]
- [x] Skills (SKILL.md in the vault, "Use skill" chip) [0.43.0, ZP d9d92c0, 4e92256]
- [x] Routines (daily/weekly, catch-up, quota rule) [0.43.0, ZP 54afb7a, f1d615f, 0917394]; chat replay bug, Stop cancels turns [0.43.2]; starter cards look fix [0.43.3]
- [x] KB server runs at login (LaunchAgent) [0.43.1, 0ee05e7]
- [x] Projects, New from selection, one-click provider switch [0.44.0, ZP 5104b9a]
- [x] Routine results as "N new" badges; routines can belong to a project [0.45.0, ZP d13ef0e]
- [~] Locked fifth depth stop; model-written follow-ups on every answer; Telegram alerts for routines; item-pane "New from selection" button

### 010 Local models (0.39.0-0.39.2)
- [x] Find local models (MLX, Ollama, LM Studio), memory check [ZP 24dde4a]
- [x] Start/stop models with guards [ZP 48ad45e]
- [x] Local provider, retrieval first, citations limited to retrieved passages [ZP f8a22f6, b7b228b]
- [x] Answer-with menu and "Passages used" [ZP 0d4d987]
- [x] Settings "On this Mac" rows [ZP 2567d1a, OP fc123db]
- [x] Real Woof 4B/2B run; fixed `.DS_Store` crash [0.39.1] and model reap [0.39.2]
- [x] Local chat with papers [0.43.2]
- [~] Switching model per message; local models running tools or long reports

### 009 Weekly performance check
- [x] Chat UI and Obsidian CSS perf harness [ZP 754e0e9, 79a85f4]
- [x] Server benchmark, weekly runner, budgets, gate script (perf/)
- [x] Weekly LaunchAgent loaded (Sundays 05:00)

### 008 Copilot-style chat (0.27.0)
- [x] Smooth streaming, live markdown, stick to bottom [ZP 7f25856]
- [x] Shimmer, spinner, "Worked for Ns"
- [x] Current-paper chip, selection chip, `@` picker (Obsidian), focus glow
- [x] Zotero collections as scope with a tree picker [ZP 627c386, c2b6e80]
- [x] Obsidian updater loop fix [0.27.1]

### 007 Modular research (0.26.0-0.37.0)
- [x] Steps and results in the engine [ZP a13ffe2]
- [x] Activity lines and folded reasoning [0.26.0]
- [x] Table artifacts: cards, side panel, versions, CSV/RIS/Markdown export [0.28.0]
- [x] Columns with quotes, filters [0.29.0]
- [x] Chat with papers [0.30.0]
- [x] "+ Add step", grouped mode menu, session cards [0.31.0]
- [x] Live activity feed [0.32.0]
- [x] Clarify questions, plan card, reports from a table [0.33.0]
- [x] Systematic review (PICOS protocol, criteria, unclear-paper review) [0.34.0]; overrides in the side panel [0.38.0, 5fe57e5]
- [x] Live researcher feed in reports [0.35.0]
- [x] Math rendering, Copy/Edit on messages [0.36.0]
- [x] Researcher tool budget fix [0.37.0]
- [~] Journal quality filter; tools that write to the library

### 006 Auto-update (0.25.0)
- [x] Server update routes
- [x] Zotero updater [ZP 5861e56]; fix [0.25.2]
- [x] Obsidian updater [OP 37a3b50]
- [x] install.sh publishes versions [OP a4bde8a]

### 005 One UI for Zotero and Obsidian (0.23.0-0.38.0)
- [x] Papers / Notes / Scholarly / Web source choice [ZP ea1aaa0, e8adeab]
- [x] Shared UI package (ui-src) [ZP 1a591c8]
- [x] Zotero chat on the shared UI [0.23.0]; Obsidian on the shared UI [0.24.0]
- [x] Drift guard between the two apps [ZP d5e5a06]
- [x] Search, Related notes, paper pane, Duplicates and status on shared panels [0.38.0]

### 004 Chat docked beside the paper (0.21.0)
- [x] Sidebar chat in the item and reader panes, with the current-paper chip
- [x] Options panel above the message box
- [~] Floating Grammarly-style window (you chose the docked sidebar)

### 003 Calmer chat look (0.19.0)
- [x] Focus keeps the layout still
- [x] Icons and empty state
- [x] Composer card and round send button

### 002 One research chat (0.18.0-0.20.0)
- [x] One message box with a mode menu, reports inline [0.18.0]
- [x] Find papers table [0.20.0]
- [x] Added columns and "Report on these" (finished in 007)
- [x] Screening criteria in the plan card (finished in 007)

### 001 Second Brain AI (before 0.18)
- [x] Codex, Claude and local OpenAI-style providers
- [x] Tools gateway, MCP, citation checks
- [x] KB server sidecar (agentd)
- [x] Chat in Obsidian and in Zotero, with and without the server
- [x] Literature review engine, screening, report export (md, docx, pdf)
- [x] MCP catalog, provider settings and sign-in
- [x] Audits, repo hygiene and CI

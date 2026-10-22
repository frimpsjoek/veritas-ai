# 008 todo (poteto-mode Feature playbook)
- [x] 1. how over the affected subsystem — done inline this session (chat.js stream/scroll, tokens, library-http scope, kb._allowed)
- [x] 2. architect skipped: shapes dictated by the Copilot reference + one data-shape decision (collection keys, below)
- [x] 3. throughput checkpoint
  - Blocking first steps: spec + Scope contract (collections by key) in agent-src/src/domain.d.ts; server route shape `GET /zotero/collections → [{key,name,parent,count}]`, `/search?collections=K1,K2`.
  - Independent workstreams: W1 server (python, ~/obsidian-kb/*.py, not a git repo) · W2 chat streaming+motion+composer (ui-src chat.js, obsidian ui-host.ts context) · W3 collection tree (new ui-src component, hosts, library-http, agent-host).
  - Shared mutable state: chat.js (W2, W3) → W3 keeps chat.js edits to the scope picker only; merge W2 first. Live server files (W1) → develop on a copy, swap in once verified.
  - Smallest safe decomposition: 3 workers; W3 starts after W1's route contract is fixed (it is, above).
- [x] 4. delegate W1, W2, W3; review diffs
- [x] 5. verify: harness + real-CSS probe + server probe + live app screenshot
- [x] 6. small ordered commits
- [x] 7. interrogate skip: not contested
- [ ] 8. PR: n/a (local repos; publish = version bump after verify)

## Shipped 2026-09-29 as 0.27.0 (zotero 0.27.0 commit after 378dea3/789b57d, obsidian 692ab4b)
- Verified: agent-src 245/245 tsc 0 · ui-src 14/14 + harness (12+10+8+7+14) · obsidian tsc 0, 14/14 · server pytest 18/18 · headless Zotero t-chat-scope 11/11, t-sidebar 23/23 · real Obsidian CSS probe (Blue Topaz).
- Follow-ups: [x] removed server `collection=<name>` param (2026-09-29, after both apps ran 0.27.x) · [ ] Zotero `@` picker (host.contextCandidates) · [ ] Zotero reader Current chip live check (harness has no PDFs) · [ ] define --sb-ui-shadow in both token maps · [ ] perf: redraw only the live block (layout dominates, see specs/009) · [ ] perf harness: extract Obsidian public/ fonts+images (404s)
- [x] 0.27.1: Obsidian updater loop fixed (loadManifests + reinstall guard); verified in the real app: loop stopped, chat styled

# 008 · Copilot-parity chat

Approved by the user 2026-09-28 ("implement the best ones"). Reference: logancyang/obsidian-copilot 4.0.12, read at
commit 8c56781 (clone in the session scratchpad). Research summary in research.md.

## What

S. Streaming that feels live
- S1 Text deltas reach the DOM at most once per animation frame (latest text wins; coalesce). Ref: use-raf-throttled-callback.ts.
- S2 The streaming answer renders Markdown while it streams (same renderer as the final answer), only the live turn re-renders; finished turns never re-render. Citation linking stays at `done`.
- S3 Stick-to-bottom: follow while within 24 px of the end; only an upward scroll pauses following; a ResizeObserver re-pins when content grows; a "jump to latest" affordance while paused. The space below the last user message is at least viewport − that message's height so a new answer starts under the question. Ref: useChatScrolling.ts.
- S4 Folded activity/reasoning state survives re-renders (open state keyed by id, applied after each render).
- S5 `<think>…</think>` in streamed text never shows (local models); an open think block truncates to the safe prefix.

A. Motion (all off under prefers-reduced-motion: static dot, plain text)
- A1 Shimmer text on the running status label: gradient muted→text→muted, 200% size, background-clip text, 2.5 s ease-in-out infinite, position −200%→200%.
- A2 Spinner beside the running status (the existing icon language; 1.4 s ease-in-out, stagger 155 ms per dot).
- A3 "Worked for Ns" line per turn: 1 s ticker while running (Xs / Xm Ys / Xh Ym Zs, tabular numerals), frozen when done; shimmer + spinner only while running. Reasoning finished → "Thought for Ns".

C. Composer
- C1 "Current" chip: the note (Obsidian) / paper (Zotero) being read shows in the box as `<title> Current`, removable; host context changes debounced 100 ms.
- C2 Selected text in the reading surface becomes its own removable chip (Obsidian: editor selection).
- C3 `+` button and typing `@` open one searchable picker (notes, papers, collections); fuzzy match, ≤30 results, categories in fixed order.
- C4 Box focus: accent border + soft glow `0 0 10px` of the accent at ~18%; placeholder "Ask anything · @ to add context". Round send button (exists).

Z. Zotero collections as scope (beyond Copilot)
- Z1 Server knows the collection tree (key, name, parent key) and each paper's collection keys; `GET /zotero/collections` returns the tree with item counts.
- Z2 Search accepts several collection keys; a key includes all its descendant collections.
- Z3 Scope type: `{ kind: "collections"; keys: string[] }` replaces `{ kind: "collection"; name }` (old persisted values are read and mapped, never rewritten).
- Z4 Obsidian + Zotero: the "Where to look" picker shows the collection tree with checkboxes; ticking a parent ticks its subcollections (tri-state parent when partly ticked); search box filters the tree; the button reads "3 collections" or the single name.

## Success checks
- Harness (ui-src/dev/run.mjs) new checks: RAF coalescing (100 deltas in one frame → 1 DOM write), markdown visible mid-stream, follow/pause/resume scroll, fold state survives, think stripped, reduced-motion disables animations, Worked-for ticks and freezes, Current chip + debounce, @ picker opens and filters, collection tree tri-state + scope sent as keys.
- Real CSS: the Obsidian probe (app.css from the installed asar + Blue Topaz + snippets) shows composer focus glow, shimmer and chips styled; tokens non-empty.
- Server: pytest/probe that /zotero/collections matches Zotero's collections table and search with a parent key returns items filed only in a child.
- agent-src 240+ tests, tsc 0; obsidian tsc 0 + tests; nothing published until all pass.

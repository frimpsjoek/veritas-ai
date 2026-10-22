# 009 · Weekly performance verification (server, shared chat UI, both apps)

Asked 2026-09-29: run perf tests once spec 008 lands, then every week. Earlier perf work covered only the server
(README "Before/after" table, 2026-09-23) and a one-off "warm first token ≤4 s" audit (P7). Nothing measures the UI.

## What we measure, and the budget each run is held to

| Layer | Scenario (deterministic, no network, no AI quota) | Metric | Budget |
|---|---|---|---|
| Server | 50 fixed queries from eval.py, warm | /search p50 / p95 | ≤ 15 / 40 ms |
| Server | same | /related, /zotero/collections p95 | ≤ 40 / 20 ms |
| Server | cold start after restart | first /search | ≤ 1.5 s |
| Chat UI | stream 120 updates into a 30-message chat (fake host, fixed seed; Copilot's own benchmark shape) | scripting ms total, per-update p95 | baseline −0%, p95 ≤ 6 ms |
| Chat UI | same | animation-frame interval p95; frames > 33 ms | ≤ 18 ms; 0 |
| Chat UI | same | long tasks > 50 ms | 0 |
| Chat UI | type 200 chars in the composer while a turn streams | keydown → next paint p95 | ≤ 16 ms |
| Chat UI | scroll up/down while streaming | scroll-follow correctness + jank frames | 0 wrong jumps, ≤ 1 frame > 33 ms |
| Chat UI | open/close a chat 20× (and 20 streamed turns) | JS heap growth after GC | ≤ 2 MB (leak guard) |
| Chat UI | first render of an empty chat view | ms to interactive composer | ≤ 50 ms |
| Chat UI | everything above again at 4× CPU throttle | same metrics | report only (slow-machine view) |
| Obsidian CSS | chat mounted in Obsidian 1.13.x app.css + user's theme (Blue Topaz) + snippets | style recalc + layout ms per update | ≤ 3 ms p95 |
| Zotero (real engine, headless copy profile) | plugin startup; open chat tab; stream 120 updates | ms; frame stats via Gecko profiler markers | startup ≤ 300 ms added; frames as Chat UI |
| Live AI (optional, 3 questions) | Quick answer through the sidecar | time to first token, total | ≤ 4 s / ≤ 30 s; skipped if Codex 5 h window > 50% |

Budgets start from Copilot's published numbers (PR #3349: frame p95 17.2 ms, 0 frames > 33 ms) and are
re-based to our first clean run; a regression = worse than budget, or > 20% worse than the median of the last 4
runs and above that metric's noise floor (measured as the spread of 5 repeats).

## How a run works (`~/obsidian-kb/perf/run.sh`)

1. **Clean conditions or skip.** Skip (and retry next hour, max 3) when the user is active (HIDIdleTime < 10 min),
   load average > 4, swap in use rising, on battery, or another heavy job runs (mnemo sleep 03:30, Perplexity 04:00,
   roadmap scout 02:00, an index pass). Record machine state (load, free RAM, swap, thermal state, git SHAs).
2. **Server**: `perf/server_bench.py` hits the live server on 127.0.0.1:27182 read-only (agent header off), 5
   repeats, reports p50/p95. Cold start measured on a second instance on another port, never the live one.
3. **Chat UI**: `ui-src/dev/perf.mjs` (Playwright Chromium, CDP `Tracing` + `Performance` + PerformanceObserver
   long-task/event-timing) drives the harness with a scripted fake stream; 5 repeats, median reported;
   traces saved for the worst run.
4. **Obsidian CSS**: same driver on the real-CSS page (app.css extracted from the installed Obsidian asar each run
   so an Obsidian update is picked up; the vault's current theme + enabled snippets).
5. **Zotero**: the existing headless harness (`agent-src/dev/zotero-harness`, `MOZ_HEADLESS=1`, a copy profile —
   never the user's) runs a perf test file that logs timings.
6. **Report**: append one JSON line per run to `perf/history.jsonl`; write `perf/reports/YYYY-MM-DD.md` (table,
   budget pass/fail, delta vs last 4, links to worst traces); send a 5-line summary to Telegram (`hermes send`),
   full report only when something regressed.

Headless everywhere: no window, no focus change (checked: frontmost app before == after, else the run fails).

## Schedule

launchd `com.frimpsjoe.secondbrain-perf`, Sundays 05:00 (clear of 02:00 scout, 03:30 mnemo sleep, 04:00 Perplexity),
`Nice 10`. Pause: `touch ~/obsidian-kb/perf/DISABLED`. Also runnable by hand: `perf/run.sh --now`.
Every release that bumps the plugin version runs the Chat UI + Obsidian CSS layers first (a publish gate), since
published builds auto-install.

## Order of work
1. After spec 008 merges: build perf.mjs + server_bench.py, run 5× by hand, set budgets from that baseline.
2. Zotero headless perf test.
3. run.sh + report + Telegram, then the LaunchAgent.
4. Publish gate hook in the version-bump path (build.sh / install.sh refuse when the last UI perf run failed).

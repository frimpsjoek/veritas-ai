# Perf pass: obsidian-kb (2026-09-23)

Playbook: Perf issue (poteto-mode).

1. [x] Capture a baseline trace. HTTP route timings + per-query SQLite timings + cProfile of index and vector load.
2. [x] `how` to ground hypotheses. skip: cause was measured directly (vec BLOB inline with text forces full-row reads).
3. [x] Plan the fix from the trace; delegate implementation. skip delegation: contained edits in kb.py/http_api.py, context already loaded.
4. [x] Parse and compare the artifacts. Before/after table in README.md.
5. [ ] Cite the measurement in the PR. skip: not a git repository.
6. [ ] Run Opening a PR. skip: not a git repository.

Checks run: migration integrity_check ok, 332,477 vectors moved, 0 orphans; eval 0.55 hit@1 5/11 hit@5 9/11 (unchanged);
duplicates groups identical (232/544/57); note_matrix identical to np.add.at; background rebuild swap keeps results identical;
scratch-vault add/edit/delete leaves vecs consistent; obsidian plugin tsc + build.

# Audit and fix: obsidian-kb (2026-09-22)

Playbook: Bug fix (poteto-mode), applied per confirmed finding.

1. [x] Reproduce it yourself on the matching surface via the driver skill (Non-negotiables).
2. [x] Binary-search the cause. Form the candidate hypotheses, then rule them out until one survives.
3. [x] Plan the fix. If it crosses a function boundary, `architect` first. Delegate implementation to a subagent using your configured bug-fix model; review the diff.
4. [x] Verify on the same surface; the original repro now passes.
5. [ ] Stage the commits so the failing repro lands before the fix in git history. skip: ~/obsidian-kb is not a git repository; backups go to data/*.bak-before-audit instead.
6. [ ] Run Opening a PR. skip: no repository or remote; the user reviews the local result.

Task todos:
- [x] Fan out read-only reviewers: backend/index, HTTP API + MCP + security, two-way sync, Zotero plugin UI + PDF fixer, Obsidian plugin.
- [x] Verify each finding against the code (reproduce where possible), drop non-issues with a reason.
- [x] Fix confirmed findings, smallest change each, with a check per fix.
- [x] Re-run compile, type check, eval, route smoke tests.

Done 2026-09-22. Zotero plugin 0.13.2 (audit fixes + writing sheet, Focus toggle, closeness ratings). Checks: check_sync.py 7/7,
audit-backend checks 7/7, sanitizer 6/6, closeness tiers, tsc, eval 5/11 + 9/11, route smoke (agent 403 on private routes, proxied 401).
Not verified by hand: rating dots in the pane (below the note), [[@key]] wikilink rendering, draft restore after a crash.
Install gotcha: after copying the xpi, launch Zotero with `open -g -a Zotero --args -purgecaches` or it keeps running the old code.

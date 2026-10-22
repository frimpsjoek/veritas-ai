# Spec 005 Stage D: real-app checks (runbook)

Run once, in this order, when the machine has memory. Nothing here was run when it was written (swap was 19/19 GB);
the two new tests (`t-search.js`, `t-item-pane-look.js`) have only passed `node --check`. Expect to fix test mistakes on
the first real run (the Stage E7 `t-report` took two rounds), and say so in the Result section rather than editing the
assertion to match the app.

Do not publish (no manifest bump, no xpi, **never `obsidian-plugin/install.sh`**: it copies into the real vault and
publishes a version both apps auto-install within 15 min) until every step below is green.

## 0. Preflight (stop if any line fails)

```sh
sysctl vm.swapusage                      # want used < 4 GB (it was 19 of 19)
memory_pressure | tail -1                # want "System-wide memory free percentage" >= 30%
df -h / | tail -1                        # want >= 3 GB free (each Zotero profile copy is ~350 MB)
pgrep -fl 'xcodebuild|Resolve|Simulator' # nothing heavy running; close Obsidian and Zotero (real ones) too
cd ~/obsidian-kb/zotero-plugin && git status --short   # content/sb-ui.js, sb-ui.css, tokens must be committed and current
```

If `ui-src/src` changed after the last `content/sb-ui.js` build: `cd ui-src && npm run build`, then check
`git diff --stat content/` and commit the rebuild before testing (the harness zips `content/` as it is).

## 1. ui-src and Obsidian unit checks (no app, ~1 min)

```sh
cd ~/obsidian-kb/zotero-plugin/ui-src && npm test          # expect 78 node tests, 678+ PASS lines, 0 FAIL
cd ~/obsidian-kb/obsidian-plugin && npx tsc --noEmit && npm test   # expect clean, 17 tests
```

## 2. Real-Zotero suite on fresh profiles

`setup` rebuilds the profile and data copy every time, so every test gets a fresh profile (t43-chat asserts an empty
chats dir; t-sidebar once failed in a polluted one). One headless Zotero at a time, ~350 MB each.

```sh
H=~/obsidian-kb/zotero-plugin/agent-src/dev/zotero-harness
Z=/private/tmp/sb-zh                     # scratch dir; pictures land here too (search-*.png, pane-*.png ...)
runone() {   # usage: runone <test-name> [secs]
  "$H/harness.sh" setup "$Z" >/dev/null &&
  SB_SERVER=http://127.0.0.1:9 "$H/harness.sh" run "$Z" "$H/tests/$1.js" "${2:-240}" | grep -E '^(FAIL|ERROR|DONE)'
}
# unchanged tests first (they must stay as they were), then the new ones
for t in t43-chat t-focus-steady t-sidebar t-unified-chat t-chat-look t-chat-scope t-history-collapse t-sources \
         t-find-papers t-activity-lines t-steps t-artifacts t-columns t-papers-chat t-math t-report t-systematic \
         t-t63-prefs-ai t-updater-idle; do echo "== $t"; runone $t; done
for t in t42-library t-sources-local; do echo "== $t (server down)"; runone $t; done
echo "== t-search";         runone t-search 240
echo "== t-item-pane-look"; runone t-item-pane-look 300
```

Every test must end `DONE pass=N fail=0` with no `FAIL` / `ERROR` line. Known counts: t-report 17, t-systematic 14,
t-unified-chat 29, t-steps 8, t-papers-chat 8, t-artifacts 9, t-math 9. Failures: read the whole `$Z/out.txt` and
`$Z/zotero.log`; rerun a flaky timing test once on a fresh profile before calling it a regression.

Not in the loop: `t41-endpoint`, `t44-real-chat`, `t-int-d-remote-runtime` (need the real server and signed-in Codex /
Claude), `t-auto-update` (own fixture server; run it separately: `runone t-auto-update 300`).

Looking at the pictures (a human look, not an assertion): `open $Z/search-empty-light.png $Z/search-empty-dark.png
$Z/search-results.png $Z/search-online.png $Z/pane-light.png $Z/pane-dark.png $Z/notetab-light.png $Z/notetab-dark.png
$Z/settings-*.png`. The Zotero chrome draws its own dark theme only if `ui.systemUsesDarkTheme` takes effect headless;
if `pane-light.png` and `pane-dark.png` are identical, the "text colour differs" check will say so.

What the new tests assert (so a failure is read correctly):
- `t-search`: SecondBrainUI + token map + `sb-ui.css` load in the XUL window and `--sb-ui-*` resolve (no `var(`);
  query -> 2 rows; Notes-off = `source=zotero`; Papers-off = `exclude_source=zotero`; click and Enter open; Find new papers
  -> rows, Add -> one "Added", item created (and erased at the end); Escape closes More, a second Escape closes the window.
- `t-item-pane-look`: 3 Sections / 3 Rows with closeness bar + label; transparent on the pane; light/dark text colour
  differs; note row -> recorded obsidian:// URL (not launched); paper row selects the paper; paper-note tab header
  (kicker, title, 20 px, flat); toolbar dropdown type / arrows / Enter / chips; then Settings model-state in five states
  (it logs `SKIP settings` and does not fail if headless Zotero will not open the Settings window: then do the manual
  check in section 4).

## 3. Obsidian smoke (isolated instance, never the real vault)

Recipe (from `update-e2e.sh` and the memory file): own `--user-data-dir`, own scratch vault, debug port, CDP driver
`obsidian-plugin/dev/update-e2e/cdp.mjs <port> '<js expr>'`. Reads the live kb server (read-only searches) on 27182;
check `curl -s localhost:27182/status` first, or start the stub server as `update-e2e.sh` does.

```sh
cd ~/obsidian-kb/obsidian-plugin && npx tsc -p . && node esbuild.config.mjs     # builds main.js only; no install.sh
W=$(mktemp -d); id=second-brain-search; D=$W/vault/.obsidian/plugins/$id; mkdir -p "$D" "$W/udd"
cp main.js manifest.json styles.css "$D/"
echo '{"startServer":false,"port":27182}' > "$D/data.json"
echo "[\"$id\"]" > "$W/vault/.obsidian/community-plugins.json"; echo '{}' > "$W/vault/.obsidian/app.json"
printf '# Plain note\n\nSome text about the effect.\n' > "$W/vault/Plain.md"
printf -- '---\nzotero-key: <8-char key of a library paper>\n---\n# Paper note\n' > "$W/vault/Paper.md"
echo "{\"vaults\":{\"smoke0000000001\":{\"path\":\"$W/vault\",\"ts\":1790000000000,\"open\":true}}}" > "$W/udd/obsidian.json"
open -n -g -a Obsidian --args --user-data-dir="$W/udd" --remote-debugging-port=9334 \
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-background-timer-throttling
until curl -s -m 1 localhost:9334/json | grep -q index.html; do sleep 1; done
node dev/update-e2e/cdp.mjs 9334 'app.plugins.setEnable(true)'   # a fresh instance starts in restricted mode
```

Open the views with `app.commands.executeCommandById(...)` (list ids: `Object.keys(app.commands.commands).filter(c=>c.includes("second-brain"))`)
and in a background instance call `await leaf.loadIfDeferred()` before touching `leaf.view.view`. Then bring the window
forward (`open -a Obsidian`) and check by eye, at widths 360 and 960 (drag the sidebar or `app.workspace.rightSplit`):

- Vault search (D2): query; Papers pill, Notes pill, More > PDFs; click a hit; Cmd-click (new tab); right-click menu; drag
  a row into a note; "Copy results as links". The hit opens once (no double open from a passage click).
- Related sidebar (D3), on `Paper.md` (has `zotero-key`) and `Plain.md`: rows with score bar + label, Cmd-click,
  right-click, "Add it now" on an unindexed note.
- Zotero item tab (D3): header, Open PDF menu with several PDFs, paper note create / open, highlights, full text opens only
  on demand.
- Duplicate notes (D4): tabs, Compare, Trash with the confirm modal, restore from trash, "Check again".
- Search index (D4): running and idle states, Stop, Update now, the confirm modal for re-reading images, the 2 s refresh
  keeps the scroll position.
- Always: buttons wrap (no nowrap overflow), no text cut off, action icons appear on hover/focus, no errors in the
  DevTools console (Cmd-Opt-I).

Clean up: `pkill -f "user-data-dir=$W/udd"; rm -rf "$W"` (resolve `$W` first, never `rm -rf` an unchecked variable; check
`echo "$W"` shows `/var/folders/...`). Delete any conversation a test created in the real sidecar.

## 4. Manual: Zotero Settings model state (only if t-item-pane-look logged SKIP)

Real Zotero > Settings > Second Brain > "Search model": read the line in each of Not downloaded / Downloading / Ready
(Remove the model and Download again to see them). Check the dot colour, the thin bar while it works, tokens (text is
Zotero's colour in light and dark) and that the row does not change height when Download/Remove swap.

## 5. Then

Record pass counts and fixes under "Result (Stage D)" in `plan.md`, and only then do the publish steps
(bump both manifests, xpi in `zotero-plugin/dist`, `obsidian-plugin/install.sh`, restart agentd with
`pkill -f agent-src/dist/agentd.mjs`).

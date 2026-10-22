# Spec: Second Brain in the browser (web app on the local KB)

Status: APPROVED 2026-10-11 (D1-D5 yes; address `127.0.0.1:27182/app`; installable as a web app with a Dock icon;
opens on a home page with today's digest and recent conversations; Zotero is assumed; the plugin chat panes stay).
Drafted 2026-10-11, written from the user's request: "a spec that makes this a webapp without the zotero and
obsidian but connect with them and run in a browser and local kb".
Builds on spec 005 (one shared UI, `ui-src`, behind the `UiHost` interface), the KB server (`kb.py serve`,
`http_api.py`, port 27182), the agent sidecar (`agentd`, reached through `/agent/*`) and spec 001 T3.5 (phone over
Tailscale). Nothing here is built until the user approves this spec and its plan.

## The problem

Every Second Brain feature lives inside a host app. Chat, Find papers, reports, tables, routines, skills and projects
are one shared UI (`ui-src`), but it only opens inside Zotero (a tab or the sidebar) or Obsidian (a pane). So:

- to ask a question you first open Zotero or Obsidian, even when you only want the answer;
- the screen is shared with the host's own panes, so tables and reports get a narrow column;
- the phone has no Second Brain at all (Obsidian mobile cannot run the plugin's server parts);
- the reading radar (spec 012) and routines produce results you only see when a host app is open.

Most of the work already happens outside the hosts. The KB server indexes the vault and the Zotero library on its
own, and the agent sidecar runs every model call, report and routine. The hosts mostly supply a window.

## Goals

1. **A full Second Brain at `http://127.0.0.1:27182/app`** in any browser, with Zotero and Obsidian closed: chat,
   Find papers, reports, systematic reviews, tables, routines, the radar, skills, projects and settings.
2. **Same code, third host.** The web app is `ui-src` with a new `web` `UiHost`, not a rewrite. A fix in the
   shared UI lands in all three places.
3. **Connected, not cut off.** Papers and notes come from the local KB index. "Open in Zotero" and "Open in
   Obsidian" jump to the item when those apps are installed. Adding papers to Zotero and writing notes to the vault
   still work (see section 4).
4. **Readers inside the app:** a paper view (metadata, abstract, PDF, your highlights and notes) and a note view
   (rendered Markdown with links), so you can read without either host app.
5. **The phone**, through the existing `tailscale serve` route, with the existing token.
6. **Safe on localhost.** Another website in the same browser must not be able to read or change anything (see
   section 5). This also closes the gap for today's plugins.
7. **Fast.** Same speed budgets as the plugins (perf/budgets.json), plus first page load under 1 s on the Mac.

## Non-goals

- A hosted or multi-user service. The app runs on this Mac and nowhere else. No cloud sync, accounts or sharing.
- Replacing Zotero or Obsidian. Editing papers' metadata, annotating PDFs and writing long notes stay in those apps.
- Its own paper library for people without Zotero (v1 reads Zotero's library; open question 4).
- Offline use on the phone. The phone needs the Mac to be awake and reachable.
- A native Mac app wrapper (Electron, Tauri). An installable web app (PWA) covers the Dock icon (open question 2).

## Words used here

- **Web host**: the `UiHost` implementation for the browser (`ui-src/src/web/host.js`).
- **Shell**: the app's frame: left navigation, top search, the open view.
- **Write-back**: a change the web app asks Zotero or the vault to make.

## The design

### 1. Where it runs

- The KB server serves the built app as static files under `/app/` (same origin as the API, so no CORS is needed
  and none is added). The LaunchAgent already keeps the server up, so the app is there whenever the Mac is on.
- Build: `ui-src` gains a `web` entry (`npm run build:web`) that writes `dist-web/`. `install-service.sh` and the
  publish step copy it to `data/web/`. The auto-updater already used by both plugins also updates the web bundle.
- Reload rule: the server serves `index.html` with no-cache and the hashed assets with long caching, so a new
  release shows on the next page load.

### 2. The web host

| `UiHost` part | Zotero host today | Web host |
|---|---|---|
| `ai()` | in-process engine or server | the server (`remote.js`, same as Obsidian) |
| `prefs`, `files` | Zotero prefs, data dir | server-side JSON under `data/web/` (the phone and the Mac see the same state) |
| `context()` | selected items, open PDF | what is open or ticked in the app (paper view, note view, ticked library rows) |
| `pickPapers`, `contextCandidates` | Zotero dialog | `/search` and `/zotero/collections` |
| `collections`, `scopeNames` | Zotero API | `/zotero/collections`; tags and saved searches from the index |
| `openRef` | select in Zotero | the in-app reader; a button there opens Zotero (`zotero://select/...`) or Obsidian (`obsidian://open?...`) |
| `searchOutside` | discover.js | the sidecar's `scholarly.js` (7 sources) through `/agent` |
| `addToLibrary` | Zotero API | write-back (section 4) |
| `saveFile` | save dialog | browser download |

`HostKind` gains `"web"`, and `Placement` gains `"page"`. The UI already hides what a host cannot do (`can`).

### 3. The shell

One window, minimal, content first (references and the visual system are chosen in the plan from real apps, not
from taste):

- **Left rail:** Chat, Library, Notes, Reports, Routines (the radar's digests show here with their `N new` badges),
  Projects. Settings and Search index go under the ellipsis menu.
- **Library:** the Zotero library as a table (search, collection tree, filters, tick rows to chat with them). Reuses
  the table artifact and Columns/Filters from spec 007.
- **Notes:** vault search, recent notes, and the shared panels already built for Obsidian (Related, Links,
  Duplicates).
- **Readers:** the paper view (from `/zotero?key=`, PDF from `/attachment`) and the note view (from `/note` and
  `/render`). Both have "Ask about this", which puts the item in the chat as context.
- Widths reuse the measured breakpoints (360 / 700 / 960). At 360 px the rail becomes a bottom bar for the phone.

### 4. Write-backs (connected to Zotero and Obsidian)

- **Add to Zotero:** the server posts the item to Zotero's own connector endpoint
  (`127.0.0.1:23119/connector/saveItems`, the one the browser extension uses) when Zotero is running, into the
  chosen collection. When Zotero is closed, the add is queued in `data/web/pending-adds.json` and the Zotero plugin
  applies it on its next start (the same pattern `/zotero/edits` uses today). The UI says which happened ("Added" or
  "Will be added when Zotero opens").
- **Notes to the vault:** digests, exports and saved answers are written as Markdown files into the vault folder by
  the server (as skills and exports already are). Obsidian picks them up through its own file watcher. Obsidian
  does not need to be running.
- **Read later / tags:** queued Zotero edits, same as Add.
- Nothing writes into `zotero.sqlite` directly. Zotero owns its database.

### 5. Security

Today a request addressed to localhost needs no token. That is safe for the plugins but not for a browser, where any
open website can send requests to `127.0.0.1:27182`. The web app slice therefore starts with:

- **Origin check:** every request that changes something (POST, PUT, DELETE) must carry an `Origin` of the app
  itself or no Origin (the plugins and the CLI send none), and browsers' `Sec-Fetch-Site` must be `same-origin` or
  absent. Anything else gets 403. GETs of private data get the same check.
- **Cookie for the browser:** the first visit to `/app` from localhost sets a random session cookie
  (`HttpOnly`, `SameSite=Strict`, path `/`). Browser requests need that cookie. The phone signs in once with the
  existing token (`data/api-token`), shown as a QR code in Settings on the Mac, and gets the same kind of cookie.
- No CORS headers, ever. The DNS-rebinding guard (Host header) stays.
- Tests: a page on another origin cannot read `/search` or call `POST /index` (fetch from a second local port in the
  harness).

### 6. Phone

- `tailscale serve` already forwards to the server. The app at `https://<mac>.<tailnet>.ts.net/app` works after the
  QR sign-in.
- Layout at 360 px: bottom bar, one view at a time, the composer pinned to the bottom, tables scroll sideways inside
  their card (the page itself never scrolls sideways).
- Long jobs (reports, routines) keep running on the Mac when the phone sleeps. The phone shows progress when it comes
  back (the event log already supports `after=`).

## Success checks

1. With Zotero and Obsidian both quit, the app at `127.0.0.1:27182/app` answers a library question with citations,
   runs Find papers, starts and finishes a quick report, and opens a routine's digest.
2. The real-Zotero harness tests and the Obsidian checks still pass. The shared UI change set has no
   `if (host.kind === "web")` outside `ui-src/src/web/` and the shell.
3. "Open in Zotero" selects the right item in Zotero, and "Open in Obsidian" opens the right note (both installed).
4. Add to Zotero with Zotero running adds the item to the chosen collection within 3 s. With Zotero closed, it is
   queued, and the item appears after Zotero starts, once only.
5. Security fixture: a page served from another origin gets 403 on `POST /index`, `PUT /skills/x` and the agent
   routes, and cannot read `/search`. The plugins still work with no change.
6. On an iPhone over Tailscale: sign in by QR, ask a question, open a paper's PDF, see a routine's `N new` badge.
   No sideways page scroll at 360 px.
7. Speed: first load of `/app` under 1 s on the Mac, and the existing UI perf rows pass in the web build.

## Release slices (for the plan)

0. Security: Origin and `Sec-Fetch-Site` checks plus the session cookie, with tests. Ships first; it protects the
   current plugins too.
1. Web host and shell: static serving, `build:web`, `web` `UiHost`, left rail, chat, Find papers, reports, routines,
   skills and projects working in the browser.
2. Library and readers: library table, notes view, paper and note readers, "Open in Zotero/Obsidian".
3. Write-backs: Add to Zotero (connector plus queue), Read later, notes to the vault.
4. Phone: QR sign-in, 360 px layout, real iPhone check.
5. Publish: the web bundle in the updater, perf rows for the web build, roadmap and README.

## Decisions (proposed, need the user's yes)

- D1. The web app is a third host of the shared UI, not a separate app with its own code.
- D2. The KB server serves it on the same port (27182, path `/app`). No second server or port.
- D3. Reads come from the KB index. Writes go through Zotero's connector or a queue the Zotero plugin applies, never
  into Zotero's database.
- D4. UI state (prefs, saved searches) lives on the server, so the Mac and the phone share it.
- D5. Slice 0 (security) ships before anything else, because a browser app on localhost needs it.

## Open questions

1. Name and address: keep "Second Brain" at `/app`, or a short local name such as `http://brain.localhost:27182`?
2. Install as a web app (PWA) so it gets a Dock icon and its own window?
3. Which view opens first: Chat, or a home page with today's radar digest and recent conversations?
4. Later, should the app work for someone with no Zotero (its own small library), or is Zotero always assumed?
5. Should the app replace the Zotero and Obsidian chat panes over time, or do all three stay?

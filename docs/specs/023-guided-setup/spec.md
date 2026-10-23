# Spec: guided setup on Home

Status: APPROVED 2026-10-22 (user: "Yes, build this"), the design shown in the chat (one step at a time, each done in
place).
Written from the user's request of 2026-10-22: "we want to guide the user in how to use it like when it checks sees
zotero it recommends to add it otherwise ask for your papers catalogue in a folder and user does not need to go to
settings."

Builds on the "Get set up" card (`web/src/setup-card.js`, commits 65907e3, 77de516), which only linked to Settings.
A light first step of the Veritas roadmap's Phase 4 (first-launch setup).

## Goals

### G1. The server suggests what to add (GET /setup/suggest)

`{zotero, vaults, pdf_folders}`, each item `{path, display, count, listed}`:

- `zotero`: the library `sources.discover_zotero()` finds (custom data directory or `~/Zotero`), with its number of
  items (regular items, not notes, attachments or annotations), or null.
- `vaults`: folders holding `.obsidian/` under `~/Documents` (3 levels), the iCloud Obsidian folder and `~` (1
  level), with their number of Markdown notes.
- `pdf_folders`: folders under `~/Documents`, `~/Downloads` and `~/Desktop` (2 levels) holding at least 5 PDFs
  directly, the 5 largest.
- `listed`: already in the folder list. Hidden folders, `Library`, `node_modules` and the output folder are skipped;
  the walk stops after 20,000 entries so it answers in about a second.

### G2. Home walks through five steps in place

The card shows the current step open and the others as one line each (ticked when done). Steps:

1. **Your papers library:** "Found your Zotero library at ~/Zotero (3,534 items) [Use my Zotero library]"; otherwise
   "Where do you keep your papers?" with the PDF folders found ([Add] each) and a path field.
2. **Your notes:** the Obsidian vaults found ([Add] each) and a path field.
3. **Your AI:** which of Claude, Codex and a local model is ready; for one that is not, how to install or sign in
   (the provider's own help text), and [Check again].
4. **Your papers:** "Tell Veritas your name to find the papers you wrote" and [Find my papers], which scrolls to the
   radar's "Your papers" just below and puts the cursor in the name field.
5. **Valency Bond (optional):** a token field, a link to app.valency.io/settings, and [Connect].

Each step has [Skip]; a step done or skipped moves to the next. Adding uses the existing `POST /sources` and
`mcp.save`; nothing opens Settings. The card disappears when every step is done or skipped, or with "Hide this card".

## Success checks

- G1: server tests on a fake home: a Zotero folder with `zotero.sqlite` (item count from the items table), a vault,
  a PDF folder of 6 files and one of 3 (not listed), a hidden folder and `Library` (skipped), `listed` true for a
  folder already in the list; route answers 200 and needs the token from outside.
- G2: unit tests for the step logic (current step, done and skipped); web tests and typecheck pass; a live run on a
  fake new user's Mac (fake Zotero, vault and PDF folder): each step done in place, screenshots recorded here.

## Non-goals

- A file picker (a browser cannot browse the server's disk); paths are typed or picked from the suggestions.
- Changing the AI choice per role (Settings > Models keeps that).

## Progress

- [x] G1 `GET /setup/suggest` (`server/setup_suggest.py`), Zotero item count without RSS feed items (3,573 on the
      test library: 3,534 own + 39 group; feeds add 3,623 and are left out), tests 3 + route auth
- [x] G2 guided card (`web/src/setup-card.js`), web tests 49/49, typecheck and boundaries clean
- [x] Live run 2026-10-22 on a fake new user's home (port 27197): Zotero found and added by the server's first-start
      defaults, so step 1 arrives done; the vault offered and added in place (step 2 ticks); AI shows how to sign in;
      Find my papers focuses "Your name" below; Valency shows the token field and link
- Note: a Zotero library found at first start is added by the server's defaults (spec 018), so "Use my Zotero
  library" shows only when it was not (e.g. removed by the user).

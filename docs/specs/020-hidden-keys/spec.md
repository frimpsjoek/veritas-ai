# Spec: guided connectors, keys kept hidden

Status: APPROVED 2026-10-20 (user: "go ahead"). Numbered 020 on 2026-10-21 (015 to 017 are taken on the main computer).
Written from the user's request of 2026-10-20: "for finding and adding the servers and connectors we need to make as
simple as possible for the user like guide them through how to setup and the api is stored as hidden somewhere so
people can't access." Decided the same day: keys in the macOS Keychain, a private file elsewhere. Part 2 of the
plan "progress, keys, seeds, superuser".

Code lives in the Zotero plugin repo (agent-src, ui-src); the server only starts the agent process.

## The problems

1. **Keys sit in plain text, readable by anyone on the account.** The agent's `settings.json`
   (`agent-src/src/settings.js:7,254`) holds the OpenAlex key, every model endpoint's key and every outside source's
   env and headers. It is written with the default mode, so other users and any program can read it
   (`node/platform.mjs:111`, no mode).
2. **Keys are sent back to the screen.** `GET /settings` returns them unredacted (`agentd.mjs:186`); the OpenAlex
   row, the Sources page and the outside-source list all receive them (`openalex-key.js`, `sources-model.js:126`,
   `mcp-hub.js:213`).
3. **Outside sources that need a key cannot be set up.** The catalog ships NASA ADS, Exa, Tavily and others with an
   empty key (`catalog.js:96,128`); Add saves that empty config and nothing lets the user type the key. There is no
   help on where to get one, and no way to add a server that is not in the catalog.

## Goals

### G1. A secret store

- `agent-src/src/secrets.js`: `set(name, value)`, `get(name)`, `remove(name)`, `has(name)`.
  - On a Mac: the login Keychain, service `second-brain`, account = the secret's name, through `/usr/bin/security`
    (value passed on stdin, never on the command line, so `ps` never shows it).
  - Elsewhere: `<data>/secrets.json`, created with mode 0600 in a 0700 folder.
- Settings hold references, never values: `{ secret: "openalex", last4: "a1b2" }`. The OpenAlex key, endpoint keys,
  and each outside source's env/header values marked secret are stored this way.
- On first start of the new version, any key found in `settings.json` moves into the store and is removed from the
  file; the file is rewritten with mode 0600 (`writeAtomic` gains a mode).
- Keys are read from the store only where they are used (the provider call, the outside-source process env, the
  OpenAlex request); nothing else can ask for a value.

### G2. Keys never come back to the screen

- `GET /settings`, the outside-source list and the Models list return `{ set: true, last4: "a1b2" }` for a key, never
  the key. A key row shows "Key saved (•••• a1b2)" with Replace and Remove.
- No route returns a secret's value; agents (MCP tools, `X-KB-Client: agent`) cannot reach the store at all.

### G3. Guided setup for outside sources and model services

- Catalog entries gain `setup`: what the key is for, where to get it (link), what to paste, and which fields are
  secret. A **Connect** button opens a short guide: 1 what it gives you, 2 get the key (link opens outside), 3 paste
  (password field), 4 Test, 5 Done. Sources with no key skip to Test.
- Test reuses what exists (reconnecting the outside source and listing its tools; fetching a model service's model
  list) and says plainly what went wrong ("The key was refused", "Couldn't reach the address").
- **Add your own**: name, address (or command) and an optional key, through the same guide.
- Model services (Settings > Models, "Other services") use the same guide and the same store.

## Success checks

- G1: unit tests for `secrets.js` with a fake `security` runner (set/get/remove, value on stdin) and the file
  fallback (mode 0600); a migration test: a `settings.json` with three keys ends with references only, mode 0600,
  and the values in the store.
- G2: `GET /settings` and the outside-source list contain no key value (test searches the response for it).
- G3: harness: Connect on a keyed catalog entry (steps, paste, Test success and failure messages, Done), Add your
  own, Replace and Remove a key; 1280, 700, 360 px.
- Live on this Mac: save the OpenAlex key through the page; `security find-generic-password -s second-brain -a
  openalex` finds it; `settings.json` does not contain it.

## Calls made in this spec (check while reading)

- One Keychain service name (`second-brain`) for every key, the secret's name as the account.
- The Codex and Claude sign-ins stay with their own tools (Codex keeps its `auth.json` under the agent folder);
  only keys Second Brain itself stores move.
- A key typed once is never shown again, even to its owner: Replace, not Reveal.

## Non-goals

- Sharing keys between computers (each computer keeps its own).
- Protecting keys from a program the user runs with their own account and full disk access; the Keychain prompt is
  the limit of what the system offers.

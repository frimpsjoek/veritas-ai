# Zotero and Obsidian plugins

Both plugins talk to the Veritas server, so install and start that first ([Getting started](getting-started.md)).

## Zotero 7

1. Download `veritas-zotero-<version>.xpi` from the [latest release](https://github.com/frimpsjoek/veritas-ai/releases/latest).
2. In Zotero: **Tools > Plugins**, the gear menu, **Install Plugin From File**, and pick the file.
3. Veritas appears in the item pane and as a tab: notes on each paper with highlights and citations, similar papers,
   search by meaning and chat over your library.

Zotero checks the release page for updates.

## Obsidian

1. Download `veritas-obsidian-<version>.zip` from the [latest release](https://github.com/frimpsjoek/veritas-ai/releases/latest).
2. Unzip it into `<your vault>/.obsidian/plugins/`.
3. In Obsidian: **Settings > Community plugins**, enable **Veritas**.

It adds search by words or meaning over your notes and Zotero library, related notes, and the chat.

## Build them yourself

```sh
cd zotero && npm ci && ./build.sh                                        # writes zotero/dist/*.xpi
cd obsidian && npm ci && npx tsc -p . && node esbuild.config.mjs         # writes obsidian/main.js and styles.css
```

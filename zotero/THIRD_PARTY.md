# Third-party components

| Component | Where | License |
|---|---|---|
| [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 (Kazuhiko Arase) | `ui-src/src/web/vendor/qrcode.cjs`, bundled into the web app's sign-in QR code; unchanged except for a `@ts-nocheck` first line | MIT |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist` 5.4.624, legacy build) | `ui-src/src/web/vendor/pdfjs/` (`pdf.min.mjs`, `pdf.worker.min.mjs`, `LICENSE`), copied unchanged into the web app as `pdf-<hash>.mjs` and `pdf-worker-<hash>.mjs` for the paper reader | Apache-2.0 |
| [CodeMirror 6](https://codemirror.net) and [Lezer](https://lezer.codemirror.net) | `content/note-editor.js` | MIT |

The AI assistant's client (`content/agent.js`, built from `agent/src/remote-entry.js`) is this repository's own code
and bundles no third-party libraries; esbuild is used only to build it. The assistant itself runs on the Veritas
server.

## Simple Icons (source logos)

`ui-src/src/logos.js` holds the paths and colours of eight icons from [Simple Icons](https://simpleicons.org) 13.21.0
(arXiv, Semantic Scholar, PubMed, Hugging Face, Zotero, Obsidian, Wikipedia, ORCID), released under CC0 1.0. The marks
are trademarks of their owners and are used only to name each source; Second Brain is not affiliated with them.

## Lucide (action icons)

`ui-src/src/icons.js` (`LUCIDE`) holds the paths of three icons from [Lucide](https://lucide.dev) 0.460.0 (thumbs-up,
thumbs-down, bookmark), released under the ISC License, Copyright (c) for portions of Lucide are held by Cole
Bemis 2013-2022 as part of Feather (MIT); all other copyright (c) for Lucide are held by Lucide Contributors 2022.

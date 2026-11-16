# Privacy

**On your computer:** your notes, PDFs and Zotero library, the search index and its vectors, chats, digests and
settings. The server reads Zotero's database read-only and writes Markdown files in its output folder; changes to
Zotero itself (adding a paper, saving a highlight) go through the Zotero plugin, and only when you ask for them.

**Sent out, only when you use the feature:**

- Chat: your question and the passages Veritas found go to the AI model you chose (Claude, Codex, an ALCF model or
  another OpenAI-compatible endpoint; none if you use a local model).
- Reading radar: searches go to arXiv, OpenAlex and the databases and feeds you switched on; candidate arXiv papers
  are downloaded to be read.
- Connectors: queries go to the tools you connected (for example Valency Bond).
- Links: Veritas fetches a page or PDF only when you open a link, and only from public websites.
- Globus sign-in: authorization-code exchanges and identity lookup go to Globus. ALCF model discovery and prompts go to ALCF only for a signed-in user who selects an ALCF model. Those provider calls use that user's own refreshed credential.

**Keys** (ordinary API keys) are stored in the macOS Keychain where available, or an owner-only file elsewhere. Independent Globus/ALCF access and refresh tokens are stored server-side in per-user owner-only files outside `data/web`; they are never placed in browser storage or shared model settings.

**Access:** the server listens on `127.0.0.1` only. A phone reaches it through `tailscale serve` and must sign in with
the code from Settings > Server and phone. Requests from other websites are refused. Independent Globus sign-in is also
available on a configured public reverse proxy. Its per-user chats, model choices and preferences stay in tenant data
directories, separate from the legacy administrator runtime and other Globus users. Ordinary library sources/admin
settings remain an administrator trust domain rather than writable tenant data.

See [Globus and ALCF](globus-alcf.md) for the callback, cookie and sidecar credential boundaries.

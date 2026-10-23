# Privacy

**On your computer:** your notes, PDFs and Zotero library, the search index and its vectors, chats, digests and
settings. The server reads Zotero's database read-only and writes Markdown files in its output folder; changes to
Zotero itself (adding a paper, saving a highlight) go through the Zotero plugin, and only when you ask for them.

**Sent out, only when you use the feature:**

- Chat: your question and the passages Veritas found go to the AI model you chose (Claude, Codex, or none if you
  use a local model).
- Reading radar: searches go to arXiv, OpenAlex and the databases and feeds you switched on; candidate arXiv papers
  are downloaded to be read.
- Connectors: queries go to the tools you connected (for example Valency Bond).
- Links: Veritas fetches a page or PDF only when you open a link, and only from public websites.

**Keys** (API keys and tokens) are stored in the macOS Keychain, not in files.

**Access:** the server listens on `127.0.0.1` only. A phone reaches it through `tailscale serve` and must sign in with
the code from Settings > Server and phone. Requests from other websites are refused.

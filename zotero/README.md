# Second Brain for Zotero

A Zotero 7+ plugin for reading and writing about papers.

- **Notes on each paper, inside Zotero.** A large Markdown editor in the item pane (and beside an open PDF) with
  live formatting, images you paste, and `[@citekey]` citations to other papers in your library. New highlights
  you make in the PDF can be added to the note as linked quotes. Notes are plain Markdown files in the Veritas
  server's notes folder.
- **Similar papers and search by meaning.** The Veritas server's index shows how close other papers and notes are
  to the one you're looking at.
- **Find new papers.** Search the services you pick (OpenAlex, Semantic Scholar, arXiv, Crossref, PubMed / Europe
  PMC, bioRxiv / medRxiv, ChemRxiv; Google Scholar opens in your browser, since it has no API) in your own words, or open *Find Related Papers
  Online* on a paper to see similar papers, the papers citing it, and its references. Papers you already have are
  marked; **+ Add** saves the others to Zotero (filled in from the DOI or arXiv ID, with a free PDF when there is one).
- **Free PDFs.** Right-click papers → *Find PDF (free sources)* tries Unpaywall, arXiv, OpenAlex,
  Semantic Scholar and Europe PMC after Zotero's own resolvers.
- **Focus.** One button hides the rest of the item pane and makes the note wider.

The plugin is a client of the Veritas server (one knowledge base for Zotero, Obsidian and the web app), the same
way the Obsidian plugin is. Notes, search, similar papers and the assistant need the server running; without it the
plugin says "Veritas server is not running" and keeps unsaved note text until it is back. Free PDFs, Find new
papers and your Zotero library itself work without it. Set the server address, and an access token for a server
on another computer, in **Zotero Settings → Second Brain → Server and phone**.

## AI assistant (optional)

The assistant runs on the Veritas server and answers questions from your own papers and notes, with
citations you can click.

**What you need.** One of these, already installed and signed in on your computer:

- **Codex** (from ChatGPT: the ChatGPT app or the `codex` command), signed in with your ChatGPT account, or
- **Claude Code** (the `claude` command), signed in with your Claude account, or
- **an OpenAI-compatible endpoint**, such as a model running on your own computer in LM Studio or Ollama, or a
  hosted service you have a key for.

The plugin does not come with a model and does not ask for a separate AI account. It uses the one you already
have. Pick which one each mode uses in **Zotero Settings → Second Brain → AI**.

**What it does.** Open it from the **Second Brain AI** toolbar button, or right-click a paper → **Ask About This
Paper…**.

The chat docks along the bottom of Zotero's right-hand pane, next to the library and next to an open PDF, and
the paper you're reading is attached to your question by itself (take it out with ×). Drag its top edge to resize
it, or open it in its own tab with ⤢. Pick what you want from the menu under the message box:

- **Chat**: a conversation about your library. Answers cite your papers as `[@citekey]` and your notes as
  `[[Note]]`; click a citation to open it. A citation the plugin can't find in your library is shown in red, so
  an invented source never looks real.
- **Quick answer**: one question, one answer. If your library doesn't cover it, the answer says so instead of making
  something up.
- **Find papers**: one table of papers on a topic from your library and scholarly databases, with no duplicates
  and a short cited summary of the top ones. Tick papers to chat about them, add them to Zotero, or export them as
  CSV or RIS. Searches are kept in the history.
- **Research report**: give it a question and it plans sub-questions, searches your library (and, if you
  choose, outside sources), shows you the plan to approve, and writes a report with themes, an evidence table,
  gaps and a reference list, all in the chat. Chats and reports share one history list. You can stop and resume it, and export it as Markdown, or as Word or PDF if the free [pandoc](https://pandoc.org) program is installed.

**Privacy.** The assistant can only look things up. It can search and read your papers and notes and, if you turn
them on, outside sources such as scholarly databases. It cannot run programs, change files or edit your notes.
Any attempt to do so stops the answer. It runs with its own private settings, separate from your normal Codex
or Claude Code setup, so your other add-ons and connected services are never loaded into it. Your question and
the passages it reads go to the AI service you chose, the same as when you use that service directly. With a
model on your own computer, nothing leaves it.

**Outside sources (catalog).** In **Settings → Second Brain → AI → Outside sources** you can add lookup services
with one click. The catalog includes PubMed / Europe PMC, ClinicalTrials.gov, PubChem, ChEMBL, arXiv full text,
Unpaywall and Wikipedia, which are free and mostly need no key. It also lists NASA ADS and INSPIRE-HEP for
physics and astronomy, and Consensus, Exa and Tavily, which are marked as paid or limited. A multi-source paper
search is listed but off, because it can't be kept away from Google Scholar. Before a service is used, every
tool it offers is checked. Anything that can change something is always hidden, and anything that doesn't say
is hidden until you choose to trust that service. **Test** shows what is available and why anything is hidden.

## Install

1. Download `second-brain-<version>.xpi` from the [latest release](https://github.com/frimpsjoek/zotero-second-brain/releases/latest).
2. In Zotero: **Tools → Plugins**, then the gear menu → **Install Plugin From File…**, and pick the file.
3. Open **Zotero Settings → Second Brain** to set the Veritas server address (and access token, if the server
   runs on another computer), and add your email for Unpaywall and OpenAlex.

Zotero checks this repository for updates.

## Where things are kept

| What | Where |
|---|---|
| Paper notes, chats, reviews and AI settings | On the Veritas server (its notes folder and data folder) |
| Settings | Zotero preferences, `extensions.secondbrain.*` (the access token is `extensions.secondbrain.token`) |

## Unpaywall and OpenAlex keys

Each user sets up their own. The settings page has these steps with buttons that open each page:

1. **OpenAlex** (free; a key gives 10× more lookups a day): create an account at
   [openalex.org](https://openalex.org), copy your key from
   [openalex.org/settings/api](https://openalex.org/settings/api), and paste it into **OpenAlex API key**.
2. **Unpaywall** (free; no sign-up): type your email. Unpaywall now runs on OpenAlex data and also accepts a
   key, so you can try your OpenAlex key in **Unpaywall API key**; if **Test keys** says "Invalid api_key", clear
   it and the email is used.
3. **Semantic Scholar** (free; without a key it often answers "too many requests"): request a key with the form
   at [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api#api-key-form) and paste it into
   **Semantic Scholar API key**.
4. Press **Test keys**. Each should say "works ✓". arXiv, Crossref, Europe PMC, bioRxiv and ChemRxiv need no key.

Nothing here is required: without keys the PDF finder still tries arXiv, Semantic Scholar and Europe PMC. Keys
and email are sent only to those services.

## Building

```sh
./build.sh   # builds the editor and the agent client bundles, then dist/second-brain-<version>.xpi and dist/update.json
```

See [THIRD_PARTY.md](THIRD_PARTY.md) for licenses.

## Releasing

GitHub Actions checks every push and pull request (the AI assistant's tests and type check, build, syntax check,
settings page, `update.json`). To publish a
version, set `"version"` in `manifest.json`, commit, and push a matching tag:

```sh
git tag v0.15.5 && git push origin v0.15.5
```

The release workflow builds the plugin and publishes `second-brain-<version>.xpi` and `update.json`; Zotero picks up
the update from there. It refuses a tag that doesn't match `manifest.json`.

## License

MIT

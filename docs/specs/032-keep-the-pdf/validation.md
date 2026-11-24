# Spec 032 validation

| Req | Check | Result (2026-11-19) |
|---|---|---|
| R1 | `server/tests/test_paper_store.py` "the rule" (local Zotero -> zotero; none, or an online default library -> folder) | pass |
| R2 | test_paper_store: downloaded now and held for the plugin (attach_pdf); a copy that cannot be downloaded is queued as an add; copies tried in turn | pass |
| R3 | test_paper_store: author-year-title name, safe characters, TeX kept as text; .json beside it; same file kept once, a different one never overwrites; nothing saved when no copy can be read | pass |
| R4 | test_paper_store "bytes from Browse"; Rust `the_server_answer_is_the_button_state` ("kept"); `web/test/browse-state.test.js` ("Save PDF" without Zotero; "Saved to Veritas › Papers"); harness Browse checks | pass |
| R5 | `ui/test/get-paper.test.js` (keptState; getPapers outside the Zotero pane); harness: Read later Get PDF keeps into Veritas › Papers (web, no Zotero); report "Get PDFs for these 3" (Zotero pane) | pass |
| R6 | `VERITAS_BROWSER=1 ./check.sh` | exit 0, 2066 browser checks |

## Live

- A, installed app, Zotero closed (this Mac has a Zotero library): `POST /agent/papers/keep` for the paper waiting in the
  queue since 2026-11-17 (an arXiv preprint). Answer
  `{"status":"queued","where":"zotero","downloaded":true,"access":{"access":"open","via":"arXiv"}}`; a 20,301,549-byte
  PDF is in `pdf-inbox/` and an `attach` entry is in the queue. Not yet seen: the plugin attaching it, because Zotero
  was not running and the plugin installed in Zotero is from 2026-11-10 (the new one must be installed).
- B, no Zotero: the same server code (`paper_store.keep`) with no Zotero library and a scratch notes folder, real
  download from arXiv: kept as `Papers/<First author> 2026 - <title>.pdf`
  (starts `%PDF-`), its `.json` beside it, listed by the indexer's file walk (`media.media_files`) and its text read
  (`media.pdf_text`). Not run: hiding this Mac's own Zotero library to try it in the installed app (that would change the
  user's setup).

## Choices made while building

- The Find table's "Add to Zotero" is unchanged (spec 031: it attaches the free copy through the plugin); Get PDF
  (report, Read later) and Browse's Save PDF follow the new rule.
- A paywalled paper: in the Zotero pane it is added to Zotero without a PDF (the plugin looks further); elsewhere nothing
  is saved and the row offers the publisher's page, with Get PDF still available.

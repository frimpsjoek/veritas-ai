# Spec 027: a paper browser in the desktop app (Browse), with Save PDF to Zotero

Status: APPROVED 2026-11-10 (user: "approved, go ahead with the plan"). The description was approved in chat first
("looks right, go ahead"); decisions marked "my call" were made by the writer, listed to the user before approval, and
"builder's call" ones are left to the plan.

Written from the user's request of 2026-11-10:

- "can we have a simple browser embedded that allows u to browse the papers easily?"
- the moment it was missed: "like acs journal and needed to leave"
- what they wanted to do there: "read the full paper and download the pdf"
- where the PDF goes: "into zotero"
- where it lives: option B of three mockups, "a full-width Browse view in the rail" (the others were a mode of the
  side panel and a separate window).

## The problem, measured

The reader (spec 022, `server/web_page.py`) fetches pages on the server. Publishers behind Cloudflare refuse it:

- `pubs.acs.org` and `chemrxiv.org` answer a server fetch with `403` and `cf-mitigated: challenge`, and send
  `x-frame-options: SAMEORIGIN`, so neither the reader nor a frame can show them (measured for ChemRxiv 2026-11-10;
  for ACS in spec 022, 2026-10-22). ChemRxiv's public API is blocked the same way.
- For a DOI, the reader shows the paper's landing page built from OpenAlex and Crossref (title, authors, abstract, an
  open-access PDF when there is one). The full text the user can read through their institution is not reachable:
  "Publisher's page" opens the system browser (`web_page.py` `_landing`, `kind: "outside"`).
- Saving a paper to Zotero exists (`server/pending_adds.py`: Zotero's Web API for an online default library, else a
  queue the Veritas Zotero plugin applies), but it never carries a file.

A real browser engine passes these checks. The desktop app already is one: Tauri 2 (`app/src-tauri`), whose window is
WebKit (WKWebView) on macOS, WebView2 on Windows and WebKitGTK on Linux.

## Goals

### G1. Browse, a full-width view in the rail (desktop app only)

- A **Browse** item in the rail, like Library and Notes, shown only when the web app runs inside the desktop app.
  On the phone and in a web browser there is no Browse item and paper links behave as they do now.
- The view is a bar and the page under it, filling the content area:
  - tabs: one per open page, each with its title and a close button, and a **+** that opens a blank tab with the
    address field focused; at most 8 tabs (opening a ninth closes the oldest one not shown) (my call);
  - **‹ ›** back and forward for the shown tab, a reload, and the address (editable; Enter goes there; text that is
    not a URL but is a DOI goes to `https://doi.org/<doi>`; anything else is not searched, the field says "Type a link
    or a DOI") (my call: no web search, it is for papers);
  - **Reader**: opens the shown page's address in today's reader panel (spec 022), for pages that read better cleaned
    up. On a site the server cannot fetch (ACS, ChemRxiv) that is the landing page from OpenAlex and Crossref, as now
    (my call for v1: the full text is in the Browse tab itself; handing the rendered page to the reader would be a
    second page-to-app channel, left for later);
  - **Save PDF to Zotero** (G3), with its state in its own place ("Saving…", "Saved to Zotero", "Waiting for Zotero",
    or the reason it could not).
- The page is a real page of the site, signed in or not as the user is, with the site's own links working inside the
  tab. A link the site opens in a new window opens a new Browse tab.
- Leaving Browse for another view keeps its tabs; coming back shows them as they were. Quitting the app may forget the
  tabs (builder's call whether to restore them).

### G2. Paper links open in Browse

- In the desktop app, a paper's title link (Home, chat citations, Library, the digest) opens in a new Browse tab
  instead of the reader panel. The reader panel stays reachable from Browse's **Reader** button and for links that
  are not papers (builder's call where exactly the line is; a DOI, an arXiv id or a publisher URL with a DOI is a
  paper).
- A ChemRxiv Engage link opens in Browse as the link itself (the reader's OpenAlex lookup, `web_page.engage_id`, is
  for the reader panel and the phone).

### G3. Save PDF to Zotero from the page

Pressing **Save PDF to Zotero** on a paper's page:

1. finds the paper: the page's DOI (`citation_doi` / `dc.identifier` meta, else the DOI in the URL) and its PDF
   address (`citation_pdf_url` meta, else the publisher's known PDF path for the DOI, e.g. ACS
   `/doi/pdf/<doi>`). If there is no PDF address the button says "No PDF on this page" and does nothing else.
2. fetches the PDF **as the page**: from inside the page, with the page's cookies and the browser's own connection, so
   an institution's access and Cloudflare's clearance apply. A response that is not a PDF (`%PDF-` at the start) is
   refused: "The site sent a page, not the PDF (sign in first?)".
3. hands the file to the server, which keeps it under the data folder and queues it for Zotero:
   - the paper is already in Zotero (matched by DOI, else by normalised title as `pending_adds._same` does): the PDF is
     attached to that item;
   - it is not: the item is added (from OpenAlex/Crossref metadata for the DOI, as the reader's landing page builds
     it) with the PDF attached;
   - duplicates (my call): the entry carries the file's SHA-256 and the PDF address it came from, and the plugin
     stores the address as the attachment's URL. An item that already has an attachment with the same content (hash)
     is not attached again, and the button says "Already in Zotero". An item that has a different PDF (an open-access
     copy, a preprint, an earlier Connector save) gets the publisher's PDF as a second attachment, titled
     "Publisher PDF", because getting the publisher's version is what Save is for.
4. says what happened, in the button's place, as Add to Zotero does today (added / queued / failed with the reason).

The local library is served through the Veritas Zotero plugin's queue: a new entry kind `attach` ({doi, title, file,
paper?}) that the plugin applies with `Zotero.Attachments.importFromFile` under the found or new item, then removes the
server's copy of the file. Applied at once when Zotero runs (as `pending_adds.apply_now`), else at the plugin's next
start or poll.

### G4. The user stays signed in

Cookies and site storage of Browse persist across app restarts, so an institution's sign-in is done once, not per
launch. A **Sign out of sites** action in Settings clears it (my call).

Browse keeps its own store, apart from the web app's (my call, from the builder check): the web app keeps its server
list, token, theme and cached rows in the default store, so a shared store could not be cleared without resetting
the web app. On macOS a separate persistent store (`data_store_identifier`) needs macOS 14, so **Browse is offered on
macOS 14 and later**; the app itself keeps `minimumSystemVersion` 11.0 and below 14 shows no Browse item (paper links
behave as on the phone). Windows and Linux use a Browse data folder under the app's data folder. Sign out clears only
Browse's store.

### G5. The web app gets only what Browse needs from the desktop app

Today the web app in the window has no access to the app at all (`app/src-tauri/capabilities/default.json`: "The web
app the window then loads from the local server gets no access to the app"). Browse needs the window to show a native
page view. That access is a short, named list of commands, granted only to the local server's own origin in the main
window, and nothing else:

`browse_open(tab, url)`, `browse_show(tab, rect)`, `browse_hide()`, `browse_back(tab)`, `browse_forward(tab)`,
`browse_reload(tab)`, `browse_close(tab)`, `browse_save_pdf(tab)`, plus events the app sends back:
`browse://state` ({tab, url, title, canGoBack, canGoForward, loading}) and `browse://saved` ({tab, status, message}).

Pages shown in Browse (ACS, ChemRxiv, any site) get no app commands and no access to the local server, except the
one-shot hand-over of G3, which is guarded so a page cannot use it on its own (see D3).

### G6. Checks

- Rust unit tests for the parts that are pure: the DOI-or-URL rule of the address field, the PDF-address rule, the
  hand-over guard.
- Server tests for the `attach` queue entry and its route (pytest, as `tests/test_pending_adds*.py`).
- Plugin tests for applying `attach` (as `zotero/test/pending-adds.test.mjs`).
- Harness checks for the Browse bar in the web app against a fake desktop bridge (no real webview in Playwright):
  the rail item only with the bridge, tabs, the address rule, the Save states, no sideways scroll at 1280 and 720 px.
- A manual check recorded in `evidence/`, on the installed app: an ACS paper the user has access to opens signed in,
  its PDF saves into Zotero under the right item, and a ChemRxiv Engage link opens.

## Non-goals

- Browse on the phone or in a web browser (they cannot show these sites; the reader and landing page stay).
- A general web browser: no bookmarks, no history list, no web search, no extensions, no downloads other than Save
  PDF to Zotero (my call, from "it's for papers" in the approved description).
- Reading the PDF inside Veritas's own PDF viewer with highlights (the saved PDF is read in Zotero, as the library's
  other PDFs are).
- An **online** default library (Zotero Web API) in the first version: the Web API file upload is a separate
  multi-step protocol. When the default library is online, Save says "Saving PDFs works with a local Zotero library
  for now" (D4).

## Decisions

- **D1. How the page is shown: a native child webview over the Browse content area** (recommended). Tauri 2's
  `Window::add_child` (behind its `unstable` feature, a Cargo feature switch, used for multiwebview) places a second
  webview inside the main window. The web app reports the content area's rectangle (`browse_show(tab, rect)`) on
  layout and resize; the app keeps the webview there and hides it when another view or a dialog covers it. Rejected:
  an iframe (the sites refuse frames); a separate window (the user chose B).
- **D2. One webview per tab, kept while the tab is open** (recommended), so switching tabs keeps each page's scroll
  and sign-in state; at most 8 (G1). Builder's call to share one webview if memory says so.
- **D3. The PDF leaves the page through a one-shot, single-use hand-over** (recommended). On Save, the app injects a
  script into the page (`Webview::eval`) that fetches the PDF address with the page's credentials and posts the bytes
  to the app. The channel must not be usable by the page without the button: the script carries a random token made
  for that press, the receiver accepts one file per token, only from that tab's webview, within 2 minutes, at most
  200 MB, and only a body starting `%PDF-`. Builder's call which channel (an IPC command scoped to that webview with
  the token, or a localhost POST with the token); the spike (T0) decides by what works in WKWebView.
- **D4. The local library first** (recommended): the `attach` queue entry and the plugin. The online library comes
  later with the Web API's upload (non-goal above).
- **D5. Address field without web search** (my call, G1).

## Risks the plan must retire first

T0, a spike on the real app on macOS, answers before any other work:

1. Does `add_child` work with the app's window (positioning, resize, hide/show, focus, the window's minimum size)?
2. Does an ACS article page open in it and pass Cloudflare? Does an institution's sign-in persist after a restart?
3. Can the injected script fetch the ACS PDF with credentials and hand the bytes out under D3's guard?
4. What WKWebView does with a site's own PDF link (shows it inline, which is fine, or downloads it).

If 2 fails (Cloudflare still blocks the embedded webview), stop and report: the feature would then not deliver what
the user asked for.

If 2 passes and 3 fails (for example ACS's `/doi/pdf/` turning into its `/doi/epdf/` viewer, or a challenge on the PDF
itself), a fallback is acceptable (my call): load the PDF address in the tab or a hidden webview of the same store and
take the file from the webview's download or navigation handler, with the same guard as D3 (one file per Save press,
from that tab, within 2 minutes, at most 200 MB, starting `%PDF-`). If neither way gets the PDF, stop and report.
Also check 5: the store kept per Browse (`data_store_identifier`, macOS 14+) persists a sign-in across a restart.

## Left to the builder

The exact tab and bar look within the existing `views.css` style; where Browse sits in the rail; restoring tabs after
a restart; the line between paper and non-paper links (G2); the D3 channel; whether `browse://state` is per event or
polled; Windows and Linux behaviour beyond "the same commands work" (macOS is the platform checked by hand).

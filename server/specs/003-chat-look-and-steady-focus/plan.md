# Plan: A calmer chat, and a Focus that doesn't move the note

Status: DONE 2026-09-26 as plugin 0.19.0 (built, installed in the real Zotero).

## Where the code is

- `zotero-plugin/content/second-brain.js`: `setFocus`, `applyFocus`, `widen` (Focus), and the `.sb-focus` CSS.
- `zotero-plugin/content/editor.js`: the Focus / Show all button and its tooltip.
- `zotero-plugin/content/chat.js`: `MODES`, `build()` (composer), `showEmpty()`, `chatRow`/`reportRow`,
  `setRunning`, and `ChatTab.style()`.
- Harness: `agent-src/dev/zotero-harness/harness.sh` + `tests/`.

## Phases

### F1. Focus keeps the layout (success checks 1, 2)
- `applyFocus` stops calling `widen(doc, true)`. `widen` becomes `restoreLayout(doc)`: if the old
  `focusLayout` pref exists, put the widths and collections state back and clear it; otherwise do nothing.
- Focus button tooltip: "Hide the other sections so only the note is left".
- New harness test `t-focus-steady.js`: measure note editor, item pane, context pane widths and collections
  splitter state; toggle Focus on and off; compare. Then seed an old `focusLayout` pref and check it is restored.

### C1. Icons and empty state (success checks 3, 4, 5)
- `MODES` gain an `icon` (SVG path data) and `suggestions`. One `icon(name)` helper builds the SVG.
- `showEmpty()` renders the icon + title + description at the top and the pills at the bottom of the thread,
  which fills the scroller's height.
- The mode menu shows the current mode's icon inside the select's left edge; history rows get icons.

### C2. Composer card and send button (success checks 6, 7)
- Controls row moves inside `.sb-ai-box`; the composer loses its border-top; radius 18 px.
- Send becomes a round icon button with `data-state` idle/ready/stop; aria-label and tooltip carry the words.
- Update t43's Stop check to read the aria-label instead of textContent.

## Verification

Harness (`SB_SERVER=http://127.0.0.1:9`): t-focus-steady, t-unified-chat, t43, t-history-collapse; pictures of
the empty chat in each mode, in light and dark, looked at before calling it done. Then bump to 0.19.0, build
the xpi and install it in the real Zotero.

## Result (2026-09-26)

- F1: `widen()` replaced by `restoreLayout()`. Measured at 1400 px: note 289 px wide and 866 px tall, item pane
  357 px, collections open, identical with Focus on and off. (A first reading of 652 px tall was the note frame
  still loading, not Focus.) `t-focus-steady.js` 4/4.
- C1/C2: `t-chat-look.js` 17/17, pictures `look-{chat,ask,report}-{light,dark}.png`, `look-thread.png`.
  Zotero reports no library selection while the chat tab is in front, so `ChatTab.open()` reads the selection
  before switching tabs and keeps it in `view.selected`.
- Regression: t-unified-chat 28/28, t43 22/22 (Stop check now reads the aria-label), t-history-collapse 17/17.
- Not done: selection changes made while the chat tab stays open don't refresh the pills until the chat is
  opened again from the toolbar or menu. Branch `ai/sidebar-chat` (~/obsidian-kb/.wt/sidebar-chat) also edits
  chat.js and will need merging against this.

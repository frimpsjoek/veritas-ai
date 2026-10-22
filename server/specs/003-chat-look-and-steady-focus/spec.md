# Spec: A calmer chat, and a Focus that doesn't move the note

Status: DONE 2026-09-26 (0.19.0), requested the same day ("lets implement that … make plan and use the spec"). Builds on spec 002 U1 (0.18.0).

## Objective

Two things the user asked for on 2026-09-26:

1. **The chat should look as finished as Grammarly's sidebar.** We studied a screenshot of Grammarly's AI Chat
   panel (macOS app, opened with ⌘G from the right edge of the screen). The Second Brain chat is built on the
   right base (Zotero's theme colors, so light and dark both work) but reads as a form: seven font sizes, six
   corner radii, no icons, a centered grey sentence as the empty state, and a message box fenced off by a
   divider line.
2. **Focus must not change the size of the note.** Today "Focus" in the note's toolbar folds the collections
   pane away and sets the item pane (and the pane beside an open PDF) to about half the window
   (`SecondBrain.widen()`, second-brain.js). The writing space jumps wider when Focus turns on and jumps back
   when it turns off. The user doesn't want that.

## What we take from Grammarly (screenshot analysed 2026-09-26)

1. **One icon per feature, used everywhere.** The AI Chat glyph is the rail button, the page title icon and the
   icon on its suggestion pill. You always know which tool you're in.
2. **Empty state with a top and a bottom.** Tool icon and a large bold title at the top left; a greeting and
   suggestion pills sit just above the message box. The suggestion comes from what you're looking at
   ("Summarize this page").
3. **The message box is a floating card.** Big radius (~24 pt), hairline border, no divider above it; the
   context chip on top, text in the middle, `+` bottom left, a round accent send button bottom right that is
   muted while empty.
4. **Few sizes.** Two type sizes, three radii, one accent.

What we don't take: the unlabeled 12-icon rail (spec 002 chose one window with a labeled mode menu), the fixed
dark theme (Zotero follows the system), and Grammarly's three mixed icon styles.

## The design

```
┌────────────────────────────────────────────────────────────┐
│  [≡] New chat                        Runs on this computer  │  (header unchanged)
│                                                             │
│   ◻  (mode icon, accent)                                    │
│   Research report            (large title)                  │
│   Give a research question. You'll get a plan…  (muted)     │
│                                                             │
│                                                             │
│   (◻ Summarize Hou 2024)  (◻ What do these papers agree on?)│  suggestion pills
│  ╭────────────────────────────────────────────────────────╮ │
│  │ [Hou 2024 ×]                                           │ │
│  │ Ask about this paper…                                  │ │
│  │ [◻ Chat ▾]  (Web)              + Selected papers  (↑)  │ │
│  ╰────────────────────────────────────────────────────────╯ │
└────────────────────────────────────────────────────────────┘
```

- **Mode icons** (one outline style, 1.5 px stroke, `currentColor`): Chat = speech bubble, Quick answer =
  lightning bolt, Research report = page with lines. Shown in the mode menu, as the empty-state icon, on
  suggestion pills and on each history row.
- **Suggestions** depend on the papers selected in the library when the chat opens or the mode changes: with a
  selection, "Summarize <paper>" / "What do these papers agree on?"; without one, two general questions per
  mode. Chat and Quick answer send at once; Research report only fills the box (a report plans first anyway).
- **Composer card**: the mode/source/attach/send row moves inside the box; radius 18 px; no border-top.
- **Send** is a round accent button with an arrow; muted while the box is empty; a square "stop" glyph while
  an answer is running. Its tooltip and aria-label say Send / Stop.
- **Tokens for the chat tab**: body 13 px, secondary 11.5 px, title 20 px; radii 6 (rows), 10 (chips, pills of
  the user message), 18 (composer), 999 (pills).

**Focus**: hides the other item-pane sections and the related lists, as today, and changes no pane size.
Anyone whose layout was widened by an earlier version gets it back once (the saved `focusLayout` pref is
restored and cleared on the next render).

## Success checks

1. Toggling Focus on and off leaves the note editor's width, the item pane's width, the context pane's width
   and the collections pane state exactly as they were (measured in the harness, to the pixel).
2. A profile with a saved `focusLayout` pref from the old behaviour gets those widths back and the pref cleared.
3. The empty chat shows the current mode's icon and title at the top and suggestion pills directly above the
   message box, in every mode.
4. With a paper selected in the library, a pill names that paper; clicking it in Chat sends the question with
   the paper attached.
5. The mode menu, the empty state and each history row show the mode's icon; the icons follow the text color
   in light and dark.
6. The send button is muted with an empty box, active once text is typed, and switches to Stop while an answer
   runs (existing Stop test still passes).
7. No divider above the composer; the controls row is inside the rounded box.
8. Existing harness tests (t-unified-chat, t43, t-history-collapse) still pass.

## Out of scope (later)

Two-line context chip with a source icon; progress rows drawn as icons instead of ✓ ✕ …; one accent color
across the note editor and the chat (the editor uses `--accent-blue` for primary buttons).

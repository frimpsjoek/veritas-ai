# Copilot 4.0.12 — implementation notes (read 2026-09-28, commit 8c56781)
Clone: /private/tmp/claude-501/-Users-frimpsjoe/1a3526dc-13c6-4b66-bdfc-42a07429da4c/scratchpad/copilot (src/...)

Streaming
- hooks/use-raf-throttled-callback.ts: store latest args; if a frame is pending return; else rAF → call with latest. A ref keeps the always-current text (for stop/save).
- utils/renderMarkdown.ts + components/Markdown.tsx: MarkdownRenderer.render of the WHOLE text per update into a cleared div (new Component per render, unload old; ignore stale async renders via a cancelled flag).
- PR #3349: finished turns are memoized and never re-render while a live answer streams (−47% scripting).
- ChatSingleMessage.tsx: citations linked only after streaming; embeds static while streaming; collapsible <details> toggled on pointerdown + open state kept in a Map keyed by id and re-applied after re-render.
- LLMProviders/chainRunner/utils/ThinkBlockStreamer.ts: strips <think>…</think> live; an open block truncates output to the prefix before it.
- hooks/useChatScrolling.ts: END_THRESHOLD_PX=24; isNearEnd = scrollHeight−clientHeight−scrollTop ≤ 24; onScroll: near end → follow; scrollTop decreased → pause; ResizeObserver(container+content) → if following or near end, scrollTop=scrollHeight; min-height of the transcript = max(100, clientHeight − lastUserMessageHeight).

Motion (styles/tailwind.css)
- .copilot-shimmer-text: linear-gradient(90deg, var(--text-muted) 0%, var(--text-normal) 50%, var(--text-muted) 100%); background-size 200% 100%; background-clip:text; color:transparent; animation copilot-text-shimmer 2.5s ease-in-out infinite (background-position −200% 0 → 200% 0).
- CopilotSpinner.tsx: 7 SVG dots, copilot-dot-chase 1.4s ease-in-out infinite, delays 0/155/…/930 ms, keyframes fade fill/opacity from --text-normal.
- agentMode/ui/AgentTurnDurationIndicator.tsx: setInterval 1000 ms → now; label "Worked for" (shimmer while running) + tabular-nums duration; aria-live polite "Agent is working".
- AgentReasoningBlock/AgentActivityCard: collapsed by default, re-collapses on complete, never auto-expands; chevron rotate(90deg) transition; done label "Thought for Ns".
- No prefers-reduced-motion handling (we add it).

Composer
- ChatInput.tsx: active-leaf-change → 100 ms debounce → getActiveFile → Current badge (ContextBadges.tsx: basename + <span text-xs text-faint>Current</span>). 4.0.9: selected text badge.
- Container: rounded border; Plan mode: border blue/60 + shadow 0 0 10px rgba(blue,0.18).
- AddContextButton.tsx: ghost "+" opens the same AtMentionTypeahead as "@".
- hooks/useAtMentionSearch.ts: fuzzysort.go(q, items, {keys, limit:30, threshold:-10000}); fixed category order (agents, tools, active tab, active note, then one fuzzy pass over notes+folders+tabs keyed on path).
- ui/ChatSendButton.tsx: round, accent bg, ArrowUp.

# Mobile chat port plan

Reference extract of what makes the desktop Work/chat surface feel strong, mapped against today's mobile `WorkChatSessionView`, with a ranked port list. Desktop source: `apps/desktop/src/renderer/components/chat/`. Mobile source: `apps/ios/ADE/Views/Work/WorkChat*.swift`.

## 1. Desktop strengths inventory

1. **Live streaming shimmer + glow on the active assistant bubble** while a turn is running (`AgentChatMessageList.tsx:1219-1232` — `ade-glow-pulse` and `ade-streaming-shimmer` applied only when `options.turnActive`). Makes "it's doing something right now" unmissable.
2. **Brain lottie + "Thinking…" pill inside a collapsible Reasoning card** that auto-opens while live, auto-closes with a duration stamp afterward (`AgentChatMessageList.tsx:1704-1756`, `BrainLottie`, `ThinkingDots`).
3. **Per-turn model badge** inline in the assistant bubble header (model/label chip, `AgentChatMessageList.tsx:1237-1241`, `deriveTurnModelState` at 934). Users always know which model wrote which turn.
4. **Streaming activity indicator** separate from reasoning: a discreet ping-bead line at the bottom of the transcript ("Label: detail…") driven by `deriveLatestActivity` (`AgentChatMessageList.tsx:2500-2509`, `ActivityIndicator` at 785).
5. **Collapsible tool call card** with status pill, tool icon, secondary label, preview text, and expand-on-failure default (`AgentChatMessageList.tsx:1763-1823` `tool_invocation`, 1825-1879 `tool_call`, and `ToolResultCard` at 804).
6. **Tool result truncation with "show all (N chars)" toggle** (`TOOL_RESULT_TRUNCATE_LIMIT = 500`, `AgentChatMessageList.tsx:802-881`).
7. **Command card with status glyph + stream-aware preview** via `CommandEventCard` (`AgentChatMessageList.tsx:1047`) and the full `ChatWorkLogBlock` surface (`ChatWorkLogBlock.tsx` 616 lines).
8. **File-change card with per-file status icon, +/− counts, dirname in muted treatment**, and collapsible diff preview via `DiffPreview` that opens automatically on failure (`AgentChatMessageList.tsx:1097-1133`, `DiffPreview` at 721).
9. **Plan / Todo update inline rows** with per-step status icons, strike-through on completed, active item expanded-by-default (`AgentChatMessageList.tsx:1264-1359`). Explanations sit below a hairline separator.
10. **Approval request cards with inline question cards, recommended option highlighting, freeform fallback, and an "approval responding" busy state** (`AgentChatMessageList.tsx:1886-2214`, plus `AgentQuestionModal.tsx`).
11. **Structured-question chips that dispatch through `onApproval` with a value** — answer without losing chat position (`AgentChatMessageList.tsx:1572-1602`).
12. **Queued-input strip above the composer** for messages submitted during an active turn (`PendingSteerItem` in `AgentChatComposer.tsx:203-312`, `pendingSteers` prop). Edit/cancel per pending item.
13. **Attachment tray with inline chip UI** (`ChatAttachmentTray.tsx`) and attachment picker with file search + recent results (`AgentChatComposer.tsx:453-513`).
14. **@-mention + /-slash command menu** with live filter, caret-anchored popover, family-specific defaults (`ChatCommandMenu.tsx`, `buildSlashCommands` at `AgentChatComposer.tsx:71`).
15. **Scroll-anchor `stickToBottom`** that remembers user scroll intent and re-anchors only when already at bottom; a `MutationObserver` scoped to the live turn keeps streaming content pinned without fighting user scroll (`AgentChatMessageList.tsx:2780-2930`).
16. **Virtualized row window** with `calculateVirtualWindow` / `reconcileMeasuredScrollTop` and measured row heights, kicking in above `VIRTUALIZATION_THRESHOLD = 60` (`AgentChatMessageList.tsx:2653-2748`).
17. **Per-turn summary card ("Turn summary")** aggregating files touched, tasks completed, token usage (`TurnSummaryCard` at 2343, `deriveTurnSummary` at 2240).
18. **Context-compact divider** — a horizontal rule with "Context compacted · ~N tokens freed · auto/manual" chip so users know context was truncated (`AgentChatMessageList.tsx:1626-1656`).
19. **Subagent strip with started / progress / result cards**, each with its own status color, last-tool chip, and usage rollup (`AgentChatMessageList.tsx:1469-1570`, `ChatSubagentStrip.tsx`).
20. **Navigation suggestions embedded in tool results** — clickable pills that route to `files/lanes/work/prs` surfaces when a tool returns navigation hints (`AgentChatMessageList.tsx:68-97`, rendered at 853-866).

## 2. Mobile gaps

- **No streaming shimmer / glow** on the active assistant card. `WorkChatMessageBubble` (`WorkChatHeaderAndMessageViews.swift:98`) is a flat glass rounded-rect with no live-state visual.
- **No Reasoning card** at all. Mobile timeline has no `reasoning` event rendering path.
- **No per-turn model badge**. The message bubble shows only "Assistant" / "You" labels, dropping which model wrote the turn.
- **No activity indicator**. Mobile surfaces a spinner in `streamingStatusSection` (`WorkChatSessionView.swift:268`) but no "Running tool X" / "Editing file Y" granular text.
- **Tool cards exist but lack truncation controls and preview** (`WorkToolCardView` in `WorkChatRichCardViews.swift:5`). No "show all" affordance, no result preview in the header.
- **No collapsible disclosure pattern** — rich cards are always-open. Desktop relies heavily on `CollapsibleCard` / `InlineDisclosureRow` to keep the transcript scannable.
- **Plan / Todo: we have `WorkEventCardView` (326) but no per-step status icon + strike-through treatment** comparable to desktop.
- **No queued-steer UI strip above composer.** `WorkQueuedSteerStrip` (`WorkChatComposerAndInputViews.swift:207`) exists but is sparse and lacks edit controls present on desktop.
- **Approval cards lack structured-question support beyond a single bucket.** `WorkApprovalRequestCard` / `WorkStructuredQuestionCard` are basic compared to desktop's multi-question card set with recommended tags.
- **No slash/@-mention menu in composer.** Attachments are supported only via sheet; slash commands and file-mentions are missing.
- **Autoscroll always snaps to bottom on timeline growth** (`WorkChatSessionView.swift:454-457`) — no "user scrolled up → pause autoscroll → show jump-to-latest pill" pattern.
- **No virtualization.** The mobile transcript is a plain `LazyVStack` inside `ScrollViewReader`. Fine at small counts; will hurt during long sessions.
- **No per-turn summary card, no context-compact divider, no subagent strip.**
- **No navigation-suggestion pills** baked into tool results.
- **Copy affordance** is a context-menu-only path on the bubble (`WorkChatHeaderAndMessageViews.swift:139`). Desktop exposes a hover copy button and also copies from inside tool result cards.

## 3. Prioritized port list (top 10 by value)

| # | Title | Why | Effort | Affected files |
|---|---|---|---|---|
| 1 | Add Reasoning / "Thinking…" card with live→collapse transition | Biggest single "this feels alive" signal. Users on desktop trust the agent partly because they see it think. | medium | `Views/Work/WorkChatRichCardViews.swift`, new `WorkReasoningCard.swift`, `WorkTimelineHelpers.swift` (add reasoning timeline entry), `WorkChatSessionView+Timeline.swift` |
| 2 | Activity indicator pill ("Running bash: ls -la", "Editing src/foo.ts") | Fills the silent-gap problem when streaming slows; huge perceived-responsiveness win. | small | `WorkChatSessionView.swift` (`streamingStatusSection`), new `WorkActivityIndicator.swift`, port of `deriveLatestActivity` |
| 3 | Per-turn model badge inline in assistant bubble | Critical when users juggle Claude/Codex/Cursor. Invisible cost, high clarity. | small | `WorkChatHeaderAndMessageViews.swift`, `WorkTimelineHelpers.swift` (derive per-turn model) |
| 4 | Collapsible tool / file-change / plan cards with default-open-on-failure | Keeps long transcripts scannable, matches desktop density cadence. | medium | `Views/Components/ADECollapsibleCard.swift` (new shared primitive), `WorkChatRichCardViews.swift` refactor |
| 5 | Smart autoscroll: pause when user scrolls up, "Jump to latest" pill to resume | Prevents the "I'm reading older output but it keeps yanking me back" frustration on long turns. | medium | `WorkChatSessionView.swift` (replace naive `onChange(of: timeline.count)`), new `WorkJumpToLatestPill.swift` |
| 6 | Streaming shimmer/glow on active assistant bubble | Mirrors #1 but on the bubble itself; the two together make live turns feel unmissable. | small | `WorkChatHeaderAndMessageViews.swift` (+ reduce-motion fallback via `ADEMotion`) |
| 7 | Queued-steer strip above composer with edit/cancel per item | Users will queue follow-ups; mobile drops them into a void today. | medium | `WorkChatComposerAndInputViews.swift` (flesh out `WorkQueuedSteerStrip` + `WorkQueuedSteerRow`) |
| 8 | Tool-result truncation with "show all" toggle and structured preview line | The thing that keeps tool transcripts usable at all. | small | `WorkChatRichCardViews.swift` (`WorkToolCardView`) |
| 9 | Slash-command menu on `/` trigger, anchored to composer | Huge ergonomic win; users memorize `/plan`, `/clear`, family defaults. | large | `WorkChatComposerAndInputViews.swift`, new `WorkSlashCommandMenu.swift`, slash registry port |
| 10 | Context-compact divider line ("~N tokens freed · auto") | Explains sudden memory loss; small but confidence-building. | small | `WorkChatRichCardViews.swift` (new `WorkContextCompactDivider`) |

## 4. Non-goals

- **Desktop information density.** Keep generous touch targets; don't port the 8-11px type stack literally. Mobile cards stay at 12-13pt body.
- **Virtualization (item 16 on desktop) in V1.** Our typical mobile session is short and our `LazyVStack` pagination already lazy-loads. Revisit only if a long-session regression appears.
- **@-mentions over file tree.** Desktop has a full file picker anchored at caret; mobile keyboards + Files tab already cover this. Ship `/slash` first.
- **Keyboard shortcuts** (Cmd-Enter to send, etc.) — iOS already exposes hardware-keyboard chords through `.keyboardShortcut`, but designing around them would mislead thumb-only users.
- **Per-provider permission mode pickers** (Claude thinking/plan/edit, Codex sandbox presets). Leave these on desktop; mobile Work runs against whatever the desktop session is configured as.
- **Computer-use / Proof panels.** Out of scope for mobile Work.
- **Subagent strip V1.** Useful but specialized; queue for a V2 once the core bubble feels right.

## 5. Design-system additions needed

Land these in `apps/ios/ADE/Views/Components/` so Lanes, Files, PRs can reuse as those tabs grow:

- **`ADECollapsibleCard`** — the workhorse: rounded-rect header (summary view + caret), tap-to-expand body, `defaultOpen` + `forceOpen` bindings. Must animate through `ADEMotion.quick/standard` and short-circuit under reduce motion. Mirrors desktop `CollapsibleCard` (`AgentChatMessageList.tsx:659`).
- **`ADEInlineDisclosureRow`** — denser variant (single-line summary + optional inline body) for plan steps, todo, tool-summary. Mirrors desktop `InlineDisclosureRow` (445).
- **`ADEActivityPill`** — dotted/pulsing bead + single-line status text. Respects reduce motion (static dot fallback).
- **`ADEStreamingShimmer` view modifier** — applies a one-shot gradient sweep to an overlay; guarded by `ADEMotion.allowsMatchedGeometry(reduceMotion:)`.
- **`ADEStatusGlyph`** — unified `working | completed | failed | interrupted` icon with size/tint input, replacing ad-hoc `Image(systemName: ...)` picks scattered across `WorkChatRichCardViews.swift`.
- **`ADEJumpToLatestPill`** — floating pill with up-arrow and unread-turn count; toggles visibility from the transcript container.
- **`ADEMarkdownRenderer` consolidation** — today `WorkMarkdownRenderer` and `PrMarkdownRenderer` (`Views/PRs/CreatePrWizardView.swift:255`) each re-implement `AttributedString(markdown:)`. Collapse into one `ADEMarkdown` component to avoid drift.

## Implementation notes

- Keep `.adeGlassCard` as the single wrapper — no nested `ADEGlassSection` inside it.
- Gate shimmer/glow behind `!reduceMotion` via `ADEMotion`; smart-autoscroll should persist scroll position per `sessionId` across tab switches.
- Extend `WorkTimelineEntry.Payload` cases rather than introducing parallel state.

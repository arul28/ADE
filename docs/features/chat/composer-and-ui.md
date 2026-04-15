# Composer and Chat UI

The chat UI lives under `apps/desktop/src/renderer/components/chat/`.
It is composed of a pane (`AgentChatPane`), a message list
(`AgentChatMessageList`), a composer (`AgentChatComposer`), and a
constellation of side panels (tasks, file changes, subagents, computer
use). The pane derives all visible state from the `AgentChatEventEnvelope`
stream plus session metadata.

## Source file map

| Path | Role |
|---|---|
| `AgentChatPane.tsx` | Top-level pane; IPC wiring, session state, presentation profile resolution, lane navigation, mounting of sub-panels and composer. |
| `AgentChatMessageList.tsx` | Virtualized message list (`@tanstack/react-virtual`). Renders transcript rows and turn dividers. |
| `AgentChatComposer.tsx` | Text input, attachments, model selector, permission controls, slash commands, pending-input answering. |
| `ChatSurfaceShell.tsx` | Floating chat header, body, footer layout. Backdrop-blur glass-morphism styling. |
| `ChatComposerShell.tsx` | Input container chrome reused by the composer. |
| `ChatAttachmentTray.tsx` | Inline file/image attachment tray inside the composer. |
| `ChatCommandMenu.tsx` | Popover for slash commands and `@`-prefixed file search. |
| `ChatTasksPanel.tsx` | Todo list rendered from `todo_update` events. |
| `ChatFileChangesPanel.tsx` | Turn-level file change summary with lazy diff expansion. |
| `ChatSubagentsPanel.tsx`, `ChatSubagentStrip.tsx` | Claude background subagent panels. |
| `ChatComputerUsePanel.tsx` | Computer-use backend status. |
| `ChatTerminalDrawer.tsx` | Collapsible terminal drawer at the bottom of the chat. |
| `ChatGitToolbar.tsx` | Git status and quick-action toolbar above the composer. |
| `ChatProposedPlanCard.tsx` | Plan approval card inline in the transcript. |
| `ChatWorkLogBlock.tsx` | Collapsible work-log group (see `chatTranscriptRows.ts`). |
| `AgentQuestionModal.tsx` | Pending input modal for question-type requests. |
| `CodeHighlighter.tsx`, `chatStatusVisuals.tsx`, `chatSurfaceTheme.ts`, `chatToolAppearance.tsx` | Supporting visuals. |
| `pendingInput.ts`, `chatExecutionSummary.ts`, `chatNavigation.ts`, `chatTranscriptRows.ts` | Pure state derivations consumed by the UI. |

## Pane layout

`AgentChatPane` is the mount point. It:

1. Subscribes to `ade.agentChat.event` for the current session and
   accumulates envelopes into local state.
2. Derives:
   - Message rows via `chatTranscriptRows.ts`.
   - Pending inputs via `pendingInput.ts`.
   - Todo items via `deriveTodoItems()` in `chatExecutionSummary.ts`.
   - Subagent snapshots via `deriveChatSubagentSnapshots()`.
   - Turn diff summaries via `deriveTurnDiffSummaries()`.
3. Resolves a `ChatSurfacePresentation` (standard, resolver, mission
   thread, mission feed) to drive header title, accent color, chips.
4. Mounts the header, message list, composer, and the appropriate
   side panels based on the session's `executionMode` and
   capabilities.

The `ChatSurfaceShell` wraps everything with a floating header (backdrop
blur + subtle glass-morphism), a body region using the theme `--color-bg`,
and a footer that contains the composer.

### Header

- Session title from `chatSessionTitle()`; falls back to "New chat".
- When the session is attached to a lane, a lane navigation button
  renders the lane's label with a branch icon. Clicking navigates to
  the lane in the Lanes tab via the app store.
- CTO and resolver surfaces override the title and chips through
  `ChatSurfacePresentation` (`assistantLabel`, `accentColor`, `chips`).

## Composer

`AgentChatComposer` supports:

- **Text input** with auto-grow up to `composerMaxHeightPx`. Grid tiles
  pass a fixed 144 px ceiling (computed statically from `layoutVariant`)
  rather than the old `ResizeObserver`-based 28 %-of-height formula;
  that eliminated the observer churn without changing the visible
  ceiling for normal tile sizes.
- **Focus-on-active.** The composer receives focus whenever the
  enclosing `AgentChatPane` reports `isTileActive: true` (for packed
  grid tiles) or any equivalent active state — typing in the grid
  immediately targets the focused tile's composer.
- **Attachments** via drag-drop, paste, and an inline picker. Images are
  written through `ade.agentChat.saveTempAttachment` (10 MB cap; MIME
  validated per provider).
- **File attach picker** opened with the `@` key. Runs a debounced
  `ade.agentChat.fileSearch` and discards stale results.
- **Slash commands.** Local commands (`/clear`, `/login`) are always
  available. Once the provider SDK is ready, its slash commands merge
  into the picker (`ade.agentChat.slashCommands`).
- **Model selection.** `ProviderModelSelector` is embedded and filters
  the registry via `filterChatModelIdsForSession`. Switching within the
  allowed family is a normal update; crossing families triggers a
  handoff.
- **Reasoning effort.** Dropdown for models that support reasoning
  tiers.
- **Context pack injection.** Allows the user to attach a context pack
  (PRD, ARCHITECTURE, mission pack) to the next turn.
- **Permission controls.** Inline with the composer:
  - Interaction mode selector (`default` / `plan`).
  - Claude permission mode — a popover picker with four tone-coded
    options: **Ask permissions** (default, green), **Accept edits**
    (blue), **Plan mode** (purple, read-only turns), **Bypass
    permissions** (red). Tone styles live in `CLAUDE_MODE_TONE_STYLES`;
    clicking outside or pressing Escape closes the popover.
  - Codex preset modes (Plan / Guarded Edit / Full Auto); custom and
    `config-toml` state shown as a summary row rather than raw
    inline dropdowns.
  - OpenCode permission mode selector.
  - Cursor mode snapshot + config options when on Cursor.
- **Pending steers.** When steers are queued during an active turn, the
  composer renders a pending-steers section above the input area with
  per-message edit and cancel controls. Each `PendingSteerItem`
  displays text with inline edit/cancel. Editing opens an inline
  textarea; saving calls `ade.agentChat.editSteer`; cancelling calls
  `ade.agentChat.cancelSteer`.
- **Question answering.** When a question-type pending input is active,
  pressing Enter submits the draft text as the answer via
  `onApproval("accept", answer)` rather than sending a new message.
  Multi-select questions render a toggle list plus a preview pane
  (sanitised via `ReactMarkdown` + `rehype-raw` + `rehype-sanitize` +
  `remark-gfm`). The per-question draft state (`QuestionDraft`) tracks
  `text`, `selectedValues`, and `activePreviewValue` independently.

### Layout variants

`AgentChatComposer` accepts a `layoutVariant` prop:

- `"standard"` -- full-width composer (default).
- `"grid-tile"` -- constrained for packed grid tiles; `composerMaxHeightPx`
  limits auto-grow.

### Attachment handling

- Pasted and dropped images are written to a temp location via
  `ade.agentChat.saveTempAttachment` (10 MB cap).
- `inferAttachmentType` and `mergeAttachments` in `shared/types/chat.ts`
  dedupe attachments by path (last-write wins).
- MIME-type validation happens per provider. Claude enforces
  `image/jpeg | image/png | image/gif | image/webp`; Codex uses local
  path references; OpenCode uses runtime content blocks.

## Message list

`AgentChatMessageList` uses `@tanstack/react-virtual` for windowed
rendering. Key rules:

- Assistant message cards constrain to `max-w-[78ch]` for readability
  (recent bump from `72ch` to `78ch` on large screens).
- User messages animate in with a `motion/react` spring transition.
- Code blocks render through `HighlightedCode`.
- Tables get rounded borders, separated spacing, and a subtle inset
  shadow.
- System notices render compact inline (no pill badges).
- Turn dividers (`ChatTurnDivider`) separate turns.
- Plan approval cards cap at `max-h-72` with pre-wrapped text so long
  plans scroll.

Row derivation uses `chatTranscriptRows.ts` (see
[transcript-and-turns](transcript-and-turns.md)).

## Tasks panel

`ChatTasksPanel` renders todos from `deriveTodoItems()`. Items carry
status (`pending | in_progress | completed`). The panel:

- Groups with in-progress first, then pending, then completed.
- Renders status glyphs (filled check, spinning arc, empty circle).
- Supports collapse/expand with a count badge in the header.

Wrapped in `BottomDrawerSection` for consistent collapse semantics with
other bottom drawer panels.

## File changes panel

`ChatFileChangesPanel` aggregates `turn_diff_summary` events across the
session using `aggregateFiles(summaries)`:

- Advances `afterSha` and stats as later turns amend the same file.
- Renders a compact list with status badges (`A`, `D`, `M`, `R`, `C`)
  and basename.
- Clicking a file lazily fetches the diff via
  `ade.agentChat.getTurnFileDiff` and shows a Monaco diff view.

## Subagents panel

When the Claude Agent SDK spawns background subagents, the service
emits `subagent_started`, `subagent_progress`, and `subagent_result`
events. `ChatSubagentsPanel` renders running/completed/failed/stopped
subagents with usage metrics. `ChatSubagentStrip` is the compact header
strip showing running subagent count.

Interrupt transitions all running subagents to `stopped` by emitting a
`subagent_result` with `status: "stopped"` for each, matching the
Claude Code CLI behavior.

## Terminal drawer

`ChatTerminalDrawer` is a collapsible drawer at the bottom of the chat
surface. Each drawer tab creates an untracked shell PTY in the current
lane, reusing the shared `TerminalView` component (with global
terminal preferences) rather than managing raw xterm instances
directly. Tabs track PTY exit state and auto-close the drawer when the
last tab is removed.

`ChatTerminalToggle` is the header button that shows the active tab
count.

## Pending input modal

`AgentQuestionModal` renders the first pending input inline in the
chat transcript with Accept / Accept-for-Session / Decline / Cancel
buttons plus optional freeform text.

Key behaviors:

- Questions with predefined options support multi-select: users can
  toggle multiple values for a single question, and a preview pane
  renders the selected option's description as sanitized HTML/Markdown.
- Options can carry `preview` content and `previewFormat` (`markdown`
  or `html`) for rich inline previews.
- Responses are sent back via `ade.agentChat.respondToInput` (accepts
  `AgentChatRespondToInputArgs` with structured `answers`, values may
  be `string` or `string[]` for multi-select, and optional `decision`).
- Legacy `ade.agentChat.approve` is still supported for backward
  compatibility.

Plan approval cards receive the plan text from the `ExitPlanMode` tool
input so the UI displays meaningful content rather than a generic
label.

## Presentation profiles

`ChatSurfacePresentation` (in `shared/types/chat.ts`) drives the
surface's visual treatment:

| Field | Effect |
|---|---|
| `mode` | `standard | resolver | mission-thread | mission-feed`. |
| `profile` | `standard | persistent_identity` -- persistent identity adjusts accent color, chips, title, and some layouts. |
| `modelSwitchPolicy` | Overrides the default switch policy for the session. |
| `title`, `subtitle`, `assistantLabel`, `messagePlaceholder` | Text overrides. |
| `accentColor` | Accent color used in header, chips, and active-turn indicators. |
| `chips` | List of `{ label, tone }` chips shown in the header. |
| `showMcpStatus` | Whether to render the MCP status indicator. |

CTO and resolver surfaces set `profile: "persistent_identity"` and
override the chips.

## State derivation helpers

These modules are pure and unit-testable:

- `chatTranscriptRows.ts` -- event-to-row pipeline (hidden/visible,
  work-log grouping, tool-use summary absorption).
- `pendingInput.ts` -- event-to-pending-input derivation (including
  `pending_input_resolved`, `done`-status-based clearing).
- `chatExecutionSummary.ts` -- todos, subagent snapshots, turn diff
  summaries.
- `chatNavigation.ts` -- keyboard navigation between transcript rows.
- `chatToolAppearance.tsx` -- tool-specific visuals (icons, tone, label
  formatting).
- `pendingInput.ts` exports `getPendingInputQuestionCount()` and
  `hasPendingInputOptions()` for introspection inside the composer.

## Fragile and tricky wiring

- **Session creation and first turn race.** When a new session is
  created from the composer, the pane awaits the `onSessionCreated`
  callback and the session-list refresh before sending the first agent
  turn. Skipping this wait renders a blank "new chat" screen because
  the parent surface has not yet navigated to the chat tab.
- **Model warmup on selection.** Selecting a Claude model triggers
  `ade.agentChat.warmupModel` to preload a V2 session. If the warmup
  promise is never awaited, the first turn incurs a 20 s latency.
- **Stale slash commands.** SDK-provided slash commands are fetched once
  per session initialisation. If the user switches model mid-session,
  the pane re-fetches. Missing the refetch surfaces slash commands
  from the previous provider.
- **File-search debounce.** The `@` picker debounces input (150 ms) and
  stamps each request with a sequence number to discard stale results.
  Stale-result handling is easy to regress when adjusting the
  debounce.
- **Question drafts persistence.** `QuestionDraft` state is local to
  `AgentQuestionModal`. If the user navigates away and back, drafts
  reset. This is intentional to avoid stale answers leaking across
  sessions.
- **Terminal drawer tab lifecycle.** PTY exit must trigger tab removal,
  and the last-tab-removed condition must collapse the drawer; the
  `ChatTerminalDrawer` state machine is the canonical source.
- **Virtual-scroll offset drift.** `@tanstack/react-virtual` is
  sensitive to changing row heights (plan approval cards, work-log
  expansion). Measurement caching uses stable keys; rolling back to an
  unstable key causes the list to "jump" on updates.

## Related docs

- [Chat README](README.md) -- service overview and IPC surface.
- [Transcript and Turns](transcript-and-turns.md) -- the data the UI
  renders.
- [Tool System](tool-system.md) -- tool tiers surfaced in the composer.
</content>
</invoke>
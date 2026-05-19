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
| `AgentChatPane.tsx` | Top-level pane; IPC wiring, session state, presentation profile resolution, lane navigation, parallel launch orchestration, mounting of sub-panels and composer. Visible Work grid tiles flush user/lifecycle/live events immediately and poll-recover active transcripts so inactive-but-visible tiles stay current. |
| `AgentChatMessageList.tsx` | Virtualized message list (`@tanstack/react-virtual`). Renders transcript rows and turn dividers, and keeps sticky-bottom sessions pinned across streamed row growth and late virtual-height measurements. |
| `AgentChatComposer.tsx` | Text input, attachments, model selector, permission controls, slash commands, pending-input answering, and parallel model-slot controls. |
| `ChatSurfaceShell.tsx` | Floating chat header, body, footer layout. Backdrop-blur glass-morphism styling. |
| `ChatComposerShell.tsx` | Input container chrome reused by the composer. |
| `ChatAttachmentTray.tsx` | Inline file/image attachment tray inside the composer. Image attachments render an inline thumbnail, open a full-size lightbox on click, and expose a copy-to-clipboard button that ships the image bytes via `window.ade.app.writeClipboardImage` so the user can paste them into another app. Pasted images can pass a seeded preview URL from the composer while the temp file is being saved; tray-only image refs fall back to `window.ade.app.getImageDataUrl`. Non-image attachments fall back to the file glyph. |
| `ChatCommandMenu.tsx` | Popover for slash commands and `@`-prefixed file search. |
| `ChatTasksPanel.tsx` | Todo list rendered from `todo_update` events. |
| `ChatFileChangesPanel.tsx` | Turn-level file change summary with lazy diff expansion. |
| `RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | Claude-only undo confirmation. Builds a message-scoped file list from SDK dry-run output plus turn diff summaries, then renders per-file expandable diffs before applying `rewindFiles`. |
| `ChatSubagentsPanel.tsx`, `ChatSubagentStrip.tsx` | Claude background subagent panels. |
| `ChatComputerUsePanel.tsx` | Computer-use backend status. |
| `ChatAppControlPanel.tsx` | App Control panel for Electron apps. Two mount points: under the chat composer (chat-scoped, `sessionId` set) and inside the Work right-edge sidebar (lane-scoped, `sessionId={null}`). Two modes: **Control** (live screencast frames + launch/connect form + click/type input + quick `terminal write` / `terminal signal` actions) and **Inspect** (hit-test crosshair on the screenshot; commits selections as `AppControlContextItem`s with screenshot, DOM packet, and source-file candidates). Persists panel state under `sessionStorage["ade.chat.appControlPanel.<key>"]`, where the key is `chat:<sessionId>` for the chat mount and `lane:<laneId>:<projectRoot>` for the sidebar mount. Connect/launch calls forward `laneId` so the resulting `AppControlSession` records its launching lane. See [App Control](../computer-use/app-control.md). |
| `ChatIosSimulatorPanel.tsx` | macOS-only iOS Simulator drawer. Two mount points: under the chat composer and inside the Work right-edge sidebar. Tool-readiness checklist, device + target pickers, three-backend live preview, `interact` vs `inspect` mode, hit-test overlay, and selection emission as `IosElementContextItem`. Accepts an optional `laneId` prop, forwarded into `iosSimulator.launch` so the resulting `IosSimulatorSession` records its launching lane. See [iOS Simulator feature](../ios-simulator/README.md). |
| `ChatBuiltInBrowserPanel.tsx` | In-app browser panel mounted under the Work right-edge sidebar's `browser` tab. Renders the address bar, navigation/tab strip, inspect toolbar, screenshot capture, and an empty/error state derived from `BuiltInBrowserStatus`; the actual page content is painted by a main-process `WebContentsView` whose bounds the panel reports back to the broker via `ade.builtInBrowser.setBounds`. Inspect-mode hit-tests emit `BuiltInBrowserContextItem` payloads through `onAddContext`; the sidebar then dispatches `ade:agent-chat:add-builtin-browser-context` to the active chat. The panel does not run inside `AgentChatPane` directly — instead, anywhere in the renderer that wants to open a URL calls `openUrlInAdeBrowser()` (in `apps/desktop/src/renderer/lib/openExternal.ts`), which fires `ADE_OPEN_BUILT_IN_BROWSER_EVENT` and asks the broker to open a new tab. |
| `ChatTerminalDrawer.tsx` | Collapsible terminal drawer at the bottom of the chat. |
| `ChatGitToolbar.tsx` | Git status and quick-action toolbar above the composer. The PR action opens a linked PR when one exists, otherwise opens the PR creation handoff for the current lane targeting the primary branch. |
| `ChatProposedPlanCard.tsx` | Plan approval card inline in the transcript. |
| `ChatWorkLogBlock.tsx` | Collapsible work-log group (see `chatTranscriptRows.ts`). Accepts `animate` so completed groups render a static glyph while in-flight ones pulse; prefers `waiting` over `working` when any entry is `interrupted`. Also renders a `LocalhostServersStrip` above the panels when any work-log entry produced a `localhost`/`127.0.0.1`/`0.0.0.0`/`[::1]` URL: a sky-toned chip per detected URL routes through `openUrlInAdeBrowser()` (so the click opens the Work sidebar Browser tab in a new tab), and a sibling Logs button either reveals the chat's currently active terminal (via `onRevealChatTerminal`) or — when no terminal exists — drafts a "please move this server into the ADE chat terminal" prompt for the agent through `onInsertDraft`. |
| `AgentQuestionModal.tsx` | Pending input modal for question-type requests. |
| `CodeHighlighter.tsx`, `chatStatusVisuals.tsx`, `chatSurfaceTheme.ts`, `chatToolAppearance.tsx` | Supporting visuals. `chatStatusVisuals.ChatStatusGlyph` takes an `animate` prop so non-active rows skip the ping/spin animation; `AgentChatMessageList.ActivityIndicator` mirrors this and switches to a dimmed static tone plus a non-looping Brain lottie for `thinking` once the turn ends. |
| `pendingInput.ts`, `chatExecutionSummary.ts`, `chatNavigation.ts`, `chatTranscriptRows.ts` | Pure state derivations consumed by the UI. |
| `apps/desktop/src/renderer/lib/visualContextFormatting.ts` | Prompt formatting for visual/tool context. Automatic macOS VM capability context is attached only when the outgoing prompt asks for ADE VM / macOS VM / Lume / isolated macOS GUI use, unless a caller forces it. |
| `apps/desktop/src/shared/types/chat.ts` | Shared composer/session DTOs, including `PARALLEL_CHAT_MAX_ATTACHMENTS`, parallel launch state types, the `AgentChatModelCatalog*` set, `AgentChatModelCatalogRefreshProvider` (`opencode` / `cursor` / `droid` / `lmstudio` / `ollama`), and `AgentChatModelCatalogArgs` (`mode`, `refreshProvider`). |
| `apps/desktop/src/renderer/components/shared/ModelPicker/` | Modular ModelPicker (see [ModelPicker structure](#modelpicker-structure)): `ModelPicker.tsx`, `ModelPickerContent.tsx`, `ModelPickerRail.tsx`, `ModelListRow.tsx`, `ReasoningEffortPicker.tsx`, `modelCatalog.ts`, `modelOrdering.ts`, `modelPickerSearch.ts`, `providerEmptyState.tsx`, `runtimeCatalogCache.ts`, plus the `useProviderAuthStatus` / `useAuthOnlyFilter` / `useModelFavorites` / `useModelRecents` / `usePerSurfaceModelDefaults` / `useReasoningByFamily` hooks. |

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
- **Attachments** via drag-drop, paste, and an inline picker. Pasted and
  dropped image files show a pending thumbnail while ADE writes the
  temp attachment. Electron clipboard images use
  `ade.app.saveClipboardImageAttachment` when available so the main
  process can save the PNG and return a small preview without sending
  the full base64 payload through the renderer; the legacy
  `ade.agentChat.saveTempAttachment` path remains as the fallback.
  Temp images keep the 10 MB cap and provider-specific MIME validation.
- **Linear issue context.** A Linear-branded chip in the composer
  opens `LinearIssueContextDialog`, which mounts the shared
  `LinearIssueBrowser` so the user can attach a Linear issue as
  chat context. Each attachment is an
  `AgentChatLinearIssueContextAttachment` (`type: "linear_issue"`)
  built by `makeLinearIssueContextAttachment(issue, source)` from
  `shared/chatContextAttachments.ts`. When the chat opens on a
  lane that already has a connected Linear issue, `AgentChatPane`
  automatically attaches the lane's issue with
  `source: "lane_link"` and pins it inside the dialog so the user
  can see what's already linked. The dialog also exposes a deep
  link to Settings > Integrations > Linear when the workspace
  isn't connected.
- **File attach picker** opened with the `@` key. Runs a debounced
  `ade.agentChat.fileSearch` and discards stale results.
- **Slash commands.** Local commands (`/clear`, `/login`) are always
  available and resolved renderer-side. SDK commands and project/user
  Claude commands discovered by `claudeSlashCommandDiscovery` merge in
  through `ade.agentChat.slashCommands`; discovery walks ancestor
  `.claude` roots and reads `.claude/commands`, `~/.claude/commands`,
  `.claude/skills/*/SKILL.md`, and `~/.claude/skills/*/SKILL.md` command
  metadata so both command files and local skills can appear in the
  picker. Only `/clear` with `source: "local"` is intercepted client-side
  — every other command is sent to the agent verbatim so provider-native
  commands still flow. The composer also
  decides whether a leading-slash draft is a command or just a sentence
  via `isProviderSlashCommandInput` (heuristics in
  `shared/chatSlashCommands.ts`): `"/rebase the lane?"` is treated as
  chat text, `"/plan"` is treated as a command.
- **Model selection.** `ProviderModelSelector` is embedded and filters
  the registry via `filterChatModelIdsForSession`. Switching within the
  allowed family is a normal update; crossing families triggers a
  handoff. Backed by the modular `ModelPicker` under
  `renderer/components/shared/ModelPicker/` (see
  [ModelPicker structure](#modelpicker-structure)). Dynamic-runtime
  inventories (Cursor / Droid / OpenCode / Ollama / LM Studio) are no
  longer fetched on chat boot — the picker calls
  `window.ade.agentChat.modelCatalog({ mode: "cached" | "refresh-stale" |
  "force", refreshProvider? })` and only triggers a runtime probe when
  the user actually opens the corresponding rail and the per-provider
  freshness TTL has lapsed (`runtimeCatalogCache.ts`: 30 min for
  Cursor / Droid / OpenCode, 30 s for `lmstudio` / `ollama`).
- **Reasoning effort.** A standalone `ReasoningEffortPicker` (extracted
  from the model row) is rendered next to the model trigger when the
  active descriptor exposes `reasoningTiers`. The picker remembers the
  last-used effort per model family via the `useReasoningByFamily`
  hook.
- **Fast mode (Codex).** A yellow Lightning chip next to the model
  selector that toggles `codexFastMode` for the selected session.
  Renders only when `modelSupportsFastMode(getModelById(modelId))`
  returns true and the session provider is Codex (today: GPT 5.4 /
  GPT 5.5 in the Codex CLI). The toggle is also exposed per-slot in
  parallel mode through `onParallelSlotCodexFastModeChange`. State
  flows into the next `turn/start` as `serviceTier: "fast"`.
- **Attachments.** Allows the user to attach files and artifacts to
  the next turn.
- **Permission controls.** Inline with the composer:
  - Interaction mode selector (`default` / `plan`).
  - Claude permission mode — a trigger button that opens a popover
    picker with four tone-coded options: **Ask permissions** (default,
    green), **Accept edits** (blue), **Plan mode** (purple, read-only
    turns), **Bypass permissions** (red). Tone styles live in
    `CLAUDE_MODE_TONE_STYLES`.
  - Codex preset modes (Plan / Guarded Edit / Full Auto) — trigger
    button + popover list. Custom and `config-toml` configurations
    appear as a non-selectable "Custom" row with the active summary
    tooltip, so the trigger can always show the effective preset.
  - OpenCode permission mode selector.
  - Cursor mode snapshot + config options when on Cursor.

  Both the Claude and Codex popovers render via `createPortal` into
  `document.body` and are positioned with `getBoundingClientRect` +
  `window.innerHeight`. That keeps them visible when the composer is
  inside an overflow-hidden container (grid tiles, shells). Clicking
  outside or pressing Escape closes them; the outside-click handler
  checks both the anchor ref and a `data-*-picker-dropdown` attribute
  on the portalized list so clicks inside the popover don't self-close.

- **Parallel launch controls.** When the Work pane mounts an empty,
  embedded draft composer with no locked or initial session, the
  composer can switch into parallel mode. Parallel mode shows a slot
  list instead of the single-session model selector; each slot captures
  the model, reasoning effort, execution mode, and provider-specific
  permission controls that will be copied into that child session.
  The first two slots are cloned from the current composer defaults.
  Users can add/remove slots and open one slot at a time for detailed
  controls. Send is enabled only when the draft is non-empty and at
  least two model slots are configured.

  Attachments in parallel mode are capped by
  `PARALLEL_CHAT_MAX_ATTACHMENTS = 12`. The same attachment list is
  sent to every child lane, so the cap is enforced both when toggling
  parallel mode and when adding files.

- **Work auto-create launch behavior.** The embedded draft composer can
  ask the main process for a lane name before creating a new Work lane.
  The request includes a temporary `chat-YYYYMMDD-HHMMSS` fallback so
  prompt-derived fallback names remain unique when model naming is
  unavailable. Foreground launches call `onSessionCreated` with
  `{ activate: true, source: "draft-launch" }` so Work selects the new
  lane/session; background launches pass `activate: false`, keep the
  current Work focus, and show a dismissible notice with an Open action.

- **Border beam.** On standard (non-grid-tile) layout the composer
  shell is wrapped in `BorderBeam` (`colorVariant="colorful"` at rest,
  `"ocean"` with a slower duration while a turn is active). `active`
  toggles off for quiet, mid-conversation states.
- **Pending steers.** When steers are queued during an active turn, the
  composer renders a pending-steers section above the input area with
  per-message controls. Each `PendingSteerItem` displays a "Sends after
  turn" badge plus the message text. Hover-revealed actions per
  entry: edit (inline textarea → `ade.agentChat.editSteer`), cancel
  (`ade.agentChat.cancelSteer`), and — for Claude SDK sessions only —
  **send now** (`ArrowBendDownRight`) and **send & interrupt**
  (`Lightning`). **Send now** dispatches the queued message into the
  active turn via `ade.agentChat.dispatchSteer({ mode: "inline" })`;
  the user message then appears in-transcript with
  `deliveryState: "inline"` and the model picks it up at its next
  thinking step. **Send & interrupt** calls
  `dispatchSteer({ mode: "interrupt" })`, which interrupts the current
  turn so the queued message runs as the next turn. Both buttons are
  hidden for non-Claude providers (Codex, OpenCode, Cursor) which only
  support post-turn delivery.
- **Question answering.** When a question-type pending input is active,
  the user answers (or declines) it through the inline question card.
  Multi-select questions render a toggle list plus a preview pane
  (sanitised via `ReactMarkdown` + `rehype-raw` + `rehype-sanitize` +
  `remark-gfm`). The per-question draft state (`QuestionDraft`) tracks
  `text`, `selectedValues`, and `activePreviewValue` independently.
- **Composer lock while pending input is unresolved.** When
  `pendingInput.blocking` is set, the composer hard-locks: the textarea
  / rich editor are disabled, attachment, slash-command, and edit
  affordances are gated, the placeholder switches to a "resolve the
  pending request above" hint, and Enter is a no-op (Escape cancels
  the request). The same gate runs server-side: `agentChatService`
  refuses `sendMessage`, queued steers, and `dispatchSteer` while a
  live pending input exists, throwing
  `"Answer or decline the pending request before sending another
  message."`. `AgentChatPane.submit` mirrors the message into the
  composer's error banner so a fast double-Enter doesn't silently
  drop the second send.

### Layout variants

`AgentChatComposer` accepts a `layoutVariant` prop:

- `"standard"` -- full-width composer (default).
- `"grid-tile"` -- constrained for packed grid tiles; `composerMaxHeightPx`
  limits auto-grow.

### ModelPicker structure

The desktop ModelPicker under
`apps/desktop/src/renderer/components/shared/ModelPicker/` is split into
focused modules. Each piece is independently testable; the same modules
power the TUI picker (`apps/ade-cli/src/tuiClient/components/ModelPicker/`).

| Module | Role |
|---|---|
| `ModelPicker.tsx` | Trigger + popover entry point. Owns runtime-catalog loading via `runtimeCatalogCache`, fast-mode chip, and the favorites/recents fan-out. |
| `ModelPickerContent.tsx` | The popover body: search bar, rail, list, empty state. |
| `ModelPickerRail.tsx` | Left-rail tabs (Favorites / Recents / per-provider groups). Reads `AuthStatus` per family to render auth gates and the OpenCode "Install OpenCode" CTA from `providerEmptyState`. |
| `ModelListRow.tsx` | A single model row (favorite star, brand logo, display name, sub-provider chip, availability tone). |
| `ReasoningEffortPicker.tsx` | Standalone reasoning-effort dropdown, mounted next to the model trigger and inside per-slot parallel-launch controls. |
| `modelCatalog.ts` | `descriptorsFromAgentChatModelCatalog`, `mergeSelectorModels`, `resolveModelDescriptorWithRuntimeCatalog`, `createUnknownModelPlaceholder` — pure helpers that flatten the IPC catalog into a `ModelDescriptor[]` and reconcile it with the static registry. |
| `modelOrdering.ts` | `sortModelItems` — provider/group ordering and intra-group ranking (favorites first, then recents, then default registry order). |
| `modelPickerSearch.ts` | `scoreModelPickerSearch` — fuzzy search across display name, family, provider, and ids; ranks favorites/recents above strict matches. |
| `providerEmptyState.tsx` | Per-provider empty/auth/install CTA copy. Surfaces "Install OpenCode" when the binary is missing, "Sign in to Cursor" when auth is missing, etc. |
| `runtimeCatalogCache.ts` | Renderer-side shared catalog cache. Tracks per-provider freshness (30 min for `opencode`/`cursor`/`droid`, 30 s for `lmstudio`/`ollama`) and dedupes concurrent `modelCatalog` requests by `${mode}:${refreshProvider}` keys. |
| `useProviderAuthStatus.ts` | Resolves `AuthStatus` (`authenticated` / `missing` / `unknown`) per `ProviderFamily` from the AI integration status. |
| `useAuthOnlyFilter.ts` | Hides models whose provider is not authenticated, with a toggle for the catalog browse mode. |
| `useModelFavorites.ts` / `useModelRecents.ts` | Cross-surface favorites and recents persisted to `~/.ade/modelPicker.json` via the `modelPicker.*` JSON-RPC methods on `adeRpcServer`. The TUI shares the same store. |
| `usePerSurfaceModelDefaults.ts` | Per-surface default-model resolver (Settings, parallel slots, mission planning, etc.) — keyed by surface so each call site can have its own remembered default. |
| `useReasoningByFamily.ts` | Last-used reasoning effort per model family. |

Renderer state and the TUI share descriptors and ordering: the TUI
`ModelPicker/modelPickerLayout.ts` imports
`modelPickerSearch`/`modelOrdering` from the desktop package directly,
so behaviour stays in lockstep.

### Attachment handling

- Pasted and dropped images are written to a temp location. File-backed
  renderer payloads use `ade.agentChat.saveTempAttachment`; native
  clipboard images prefer `ade.app.saveClipboardImageAttachment`, which
  reads the Electron clipboard, writes the PNG beside other chat
  attachments, and returns a downsized preview data URL. While either
  save is in flight, the composer disables send and shows a cancellable
  pending thumbnail in `ChatAttachmentTray`.
- iOS Simulator selections add `IosElementContextItem` chips to the
  composer instead of plain attachments. Each chip is a `data-ios-context`
  node in a contenteditable rich-input variant; submission serialises
  the chips back into the prompt via `formatIosElementContextForPrompt`
  so the model sees a structured tag with `componentId`, source
  file/line, and any metadata. When the same selection produced a
  paired screenshot within 10 s, the chip carries an
  `attachmentPath` so the chip and image stay linked. See the
  [iOS Simulator feature](../ios-simulator/README.md) for the upstream
  flow.
- `inferAttachmentType` and `mergeAttachments` in `shared/types/chat.ts`
  dedupe attachments by path (last-write wins).
- MIME-type validation happens per provider. Claude enforces
  `image/jpeg | image/png | image/gif | image/webp`; Codex uses local
  path references; OpenCode uses runtime content blocks.
- Parallel launches reuse this same attachment path after the renderer
  validates the 12-file cap. Every child session receives identical
  attachment refs; provider-specific handling still happens inside
  `agentChatService.sendMessage`.

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
  `ade.agentChat.getTurnFileDiff` and shows it in `AdeDiffViewer`
  (compact toolbar hidden).

## Rewind files confirmation

Claude user messages expose an undo affordance when the SDK provides a
file checkpoint. The pane first calls
`ade.agentChat.rewindFiles({ dryRun: true })`; if the checkpoint can be
restored, `rewindFilesPreview.ts` filters turn diff summaries after the
selected user message and pairs each reported file with the earliest
`beforeSha` and latest `afterSha` it can prove. The confirmation dialog
then shows:

- The user message being rewound to and its sent time.
- Aggregate insertion/deletion counts from the SDK dry run.
- One expandable row per file, including status and per-file stats when
  a turn diff summary is available.
- Lazy `AdeDiffViewer` previews via `ade.agentChat.getTurnFileDiff`.

Confirming calls `rewindFiles` without `dryRun`. Conversation history is
left untouched; only files are restored.

## Subagents panel

When the Claude Agent SDK spawns background subagents, the service
emits `subagent_started`, `subagent_progress`, and `subagent_result`
events. `ChatSubagentsPanel` renders running/completed/failed/stopped
subagents with usage metrics. `ChatSubagentStrip` is the compact header
strip showing running subagent count.

Interrupt transitions all running subagents to `stopped` by emitting a
`subagent_result` with `status: "stopped"` for each, matching the
Claude Code CLI behavior.

Codex parallel agent failures emit a system-notice plus `failed` /
`stopped` `subagent_result` rows. The agentChatService maps
`failed | errored | rejected | refused | denied` Codex status values
to `failed` and `stopped | interrupted | shutdown | notfound |
cancelled | canceled` to `stopped`; `readCodexCollabFailureSummary`
pulls the human-readable rejection out of `item.error` /
`item.result` / `item.contentItems[*].text` so the chat surface shows
a useful reason instead of a bare "Agent spawn failed".

`deriveChatSubagentSnapshots` (in `chatExecutionSummary.ts`) keeps
sibling Codex subagents distinct when they share a `parentToolUseId`:
it pre-scans every envelope to count the resolved subagent ids per
parent, only adopts the placeholder parent row when exactly one
sibling resolves under that parent, and otherwise creates separate
snapshots keyed by `agentId ?? taskId`. The TUI now imports the same
pure helpers from `apps/desktop/src/shared/chatSubagents.ts`
(`buildSubagentPaneRows`, `selectedSubagentSnapshot`,
`subagentIndexForPaneLine`, `subagentPaneSelectableLineOffsets`,
`buildSubagentTranscriptEvents`, `isLifecycleEventForSnapshot`,
`latestPlan`) — `apps/ade-cli/src/tuiClient/subagentPane.ts` and
`chatInfo.ts` re-export them so desktop and TUI never drift.

Subagent envelopes carry both an `agentId` (raw runtime id) and an
`agentType` label that's used as the row title when present. The label
sources differ per runtime:

- **Claude / ade-code.** `agentType` comes from the Task tool's
  `input.subagent_type` (e.g. `code-reviewer`, `Explore`). The service
  stashes that input at the assistant `tool_use` boundary
  (`runtime.taskToolInputByToolUseId`, keyed by `tool_use_id`) and
  joins it onto the later `system:task_started` / `task_progress` /
  `task_completed` envelopes via `parentToolUseId`. Stale entries are
  cleared at turn boundaries and on subagent completion.
- **Codex parallel agents.** The Codex wire format has no
  human-friendly name for collab agents, so the service assigns
  `Agent #N` labels via `assignCodexAgentLabel`: 1-based, per-turn,
  remembered in `runtime.codexAgentIndexByTurn` (a
  `Map<turnId, Map<threadId, index>>`), and cleared when the turn
  ends. The raw threadId is kept on the snapshot as `agentId`.
- **OpenCode subagents.** OpenCode encodes the agent's identity in
  `session.title`, which already flows through as `description`; the
  service intentionally does NOT set `agentType` so the renderer falls
  back to that description for the row label.

## Terminal drawer

`ChatTerminalDrawer` is a collapsible drawer at the bottom of the chat
surface. Each drawer tab creates an untracked shell PTY in the current
lane, reusing the shared `TerminalView` component (with global
terminal preferences) rather than managing raw xterm instances
directly. Tabs track PTY exit state and auto-close the drawer when the
last tab is removed. When a new chat-owned terminal is created from a
non-drawer source (e.g. an in-chat agent calling
`ade --socket app-control launch`, the localhost-strip "Logs" button,
or another chat surface) the pane subscribes to
`window.ade.sessions.onChanged` and dedupes the new terminal into the
drawer instead of opening a duplicate tab — `ChatTerminalDrawer.openTab`
checks the existing tab list by `sessionId` / `ptyId` before pushing a
new entry, and the `AgentChatPane` `revealCreatedTerminal` effect calls
the same drawer with the recovered `{ terminalId, ptyId, label }`.

`ChatTerminalToggle` is the header button that shows the active tab
count. The drawer is mounted only when lane tool drawers are visible on
the chat surface. Work-grid tiles pass `hideLaneToolDrawers` because the
Work sidebar owns lane-scoped tools there; in that mode the header
toggle is absent and the pane does not call `ade.terminal.list` just to
hydrate a hidden drawer.

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
| `showMcpStatus` | Whether to render the ADE CLI status indicator. |

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
  unstable key causes the list to "jump" on updates. Sticky-bottom
  recovery intentionally follows for a few animation frames after row
  measurement changes; removing that follow-up can make active streams
  appear to stop short of the newest output.
- **Automatic macOS VM context is intent-gated.** `submit()` passes the
  outgoing prompt text into `buildAutomaticMacosVmContextForPrompt()`.
  Ordinary sends should not call `ade.macosVm.getStatus` or inject VM
  state; only prompts that mention ADE VM / macOS VM / Lume / isolated
  macOS GUI usage get the automatic capability block.
- **Native permission picker updates serialize before submit.**
  `AgentChatPane` tracks the in-flight native-control update through
  `pendingNativeControlUpdateRef` (sessionId + monotonic `updateId` +
  promise). Every `updateSession` dispatched from the permission
  popovers chains onto the previous promise so the backend always sees
  the final picker state, and `submit()` awaits that chain for the
  active session before dispatching the turn. The handler also
  optimistically patches the renderer session summary with the fields
  returned from `updateSession` (`permissionMode`,
  `interactionMode`, `claudePermissionMode`, `codexApprovalPolicy`,
  `codexSandbox`, `codexConfigSource`, `opencodePermissionMode`,
  `cursorModeId`, `cursorModeSnapshot`) so the chip state reflects the
  server's normalized values before the list refresh lands.

## Related docs

- [Chat README](README.md) -- service overview and IPC surface.
- [Transcript and Turns](transcript-and-turns.md) -- the data the UI
  renders.
- [Tool System](tool-system.md) -- tool tiers surfaced in the composer.

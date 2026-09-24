# External Session Import

Users often run AI coding CLIs outside ADE in ordinary terminal windows. Those
tools keep their own sessions on disk, or expose a provider-native session
list. ADE's external-session import feature lets the user browse those sessions
from the Work surface and continue one inside ADE.

ADE imports sessions from 10 providers:

- Claude Code, Codex, Cursor `cursor-agent`, Factory Droid, OpenCode, and Pi.
- The ACP providers: Qwen Code, Kimi Code, Grok, and GitHub Copilot CLI.

Every import has two choices:

- **The surface.** An ADE chat, or a tracked CLI terminal.
- **The mode.** "Continue" uses the original provider-native session. The user
  must not also keep that session open in another terminal. "Copy" starts a new
  session from the history. The original session stays as it is.

Which of the four actions a session gets, and in which lanes, comes from one
policy table. See [Import policy](#import-policy). Every provider can open as an
ADE chat copy. The other three actions depend on the provider.

The reverse direction also matters. Sessions that ADE creates or imports stay
resumable from the provider CLI, because ADE records the provider-native ids
and, for fresh launches, chooses them. Tracked CLI sessions persist
`TerminalResumeMetadata`. Claude chat imports seed `sdkSessionId` and mirror a
Claude session pointer. Codex chat imports bind the ADE session to the provider
thread id. Droid, OpenCode, Pi, and Copilot chat continues seed the provider pointer
that the chat restores from after a restart. Fresh tracked launches of Claude,
Qwen, Grok, and Copilot get a pre-assigned session id (see
[Session tracking](#session-tracking)). The other CLIs record the target when
ADE first learns it.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/externalSessions/externalSessionsService.ts` | Service entry point (`list`, `importExternalSession`, `getDetail`). Runs provider discovery, stamps each row's capabilities, `home` lane, and `sizeBytes`, filters project/all scope, detects already-imported sessions, validates import ids, enforces optional lane cwd scope, refuses any import the policy does not offer (`importRejectionReason`), builds CLI resume/fork commands, delegates chat import, and creates tracked PTYs. `getDetail` wraps `loadExternalSessionDetail` with the service's own `homeDir`/`env`, so every detail caller (IPC, the watch, the ADE action, the sync command) reads the same provider stores as `list`. |
| `apps/desktop/src/main/services/externalSessions/discoverers.ts` | `EXTERNAL_SESSION_DISCOVERERS`: the one provider → discoverer table. Listing, import, and the exact-id detail lookup all use it. |
| `apps/desktop/src/main/services/externalSessions/sessionIds.ts` | Session id checks. `isWellFormedExternalSessionId` (strict UUID for Claude/Codex, `^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$` for the rest) and `validateExternalSessionId` (the same check plus the Cursor `agent-` refusal, throwing). Discoverers join the id into a store path, so an id with a separator must never reach them. |
| `apps/desktop/src/shared/externalSessionPolicy.ts` | The one import policy. `PROVIDER_IMPORT_RULES` (the per-provider table), `effectiveImportRules` (the table narrowed by host capabilities), `planImport` (what the action bar shows), `importRejectionReason` (the host guard), and `importProviderLabel` (the provider label every desktop and TUI surface uses). The renderer, the TUI, and the host import all use it. iOS mirrors it in Swift. |
| `apps/desktop/src/main/services/externalSessions/sessionHome.ts` | `createSessionHomeResolver`: maps a provider cwd to the lane that owns it (`ExternalSessionHome`). The deepest lane root wins. A folder under `.ade/worktrees/` that no live lane owns is a removed lane, not the primary lane. |
| `apps/desktop/src/main/services/externalSessions/discoveryUtils.ts` | Shared discovery helpers: safe stat/read, top-N mtime sorting, JSONL prefix/suffix scans, one record classifier shared by prompt extraction and the recent-`messages` sampler, provider-wrapper cleanup, the preview-only markup-density gate, word-boundary clipping, title cleanup, cwd slug helpers, shell quoting, and path-inside checks. |
| `apps/desktop/src/main/services/externalSessions/discoverClaude.ts` | Discovers resumable Claude CLI JSONL transcripts under `CLAUDE_CONFIG_DIR` or `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`; reads `ai-title`/custom titles, excludes SDK-origin transcripts, and collapses continuation chains to their leaf. |
| `apps/desktop/src/main/services/externalSessions/discoverCodex.ts` | Discovers interactive Codex threads from `CODEX_HOME/state_5.sqlite` (default `~/.codex`): top-level threads only, fork continuations collapsed, enriched from the rollout JSONL under `sessions/YYYY/MM/DD/` and `session_index.jsonl`. Falls back to scanning rollout files when the thread store is unusable. |
| `apps/desktop/src/main/services/externalSessions/discoverCursor.ts` | Groups every Cursor artifact — `~/.cursor/chats/<workspace-md5>/<id>/store.db`, its `meta.json`, and `~/.cursor/projects/<slug>/agent-transcripts/` (including `empty-window`) — by the bare conversation uuid, keeps the fullest copy of each, resolves cwd from `meta.json` before the md5/slug reverse-mappings, and excludes SDK `agent-<uuid>` sessions. Also owns `openCursorStoreConversation`, the reader for the conversation inside a `store.db` (see [Cursor](#cursor)). |
| `apps/desktop/src/main/services/externalSessions/discoverDroid.ts` | Discovers Factory Droid JSONL sessions under `<factoryConfigHome>/sessions/<escaped-cwd>/` (default `~/.factory`), one record per session id, using the `session_start` row for id/cwd/title. |
| `apps/desktop/src/main/services/externalSessions/discoverOpenCode.ts` | Discovers OpenCode sessions by running `opencode session list --pure --format json --max-count <N>` in the requested/project cwd. |
| `apps/desktop/src/main/services/externalSessions/discoverPi.ts` | Discovers Pi's native JSONL sessions in the one Pi session store that ADE chat and tracked Pi terminals also use. |
| `apps/desktop/src/main/services/externalSessions/discoverQwen.ts`, `discoverKimi.ts`, `discoverGrok.ts`, `discoverCopilot.ts` | The ACP-provider discoverers. Each reads its CLI's own on-disk store, drops ADE-launched and subagent sessions, and drops sessions with no prompt. See [ACP providers](#acp-providers-qwen-kimi-grok-copilot). |
| `apps/desktop/src/main/services/externalSessions/discoverAcpShared.ts` | Shared plumbing for the four ACP discoverers. Each discoverer maps its records to one neutral `{ type, timestamp, message: { role, content } }` form, and the shared helpers compute the preview, the sampled `messages`, and the prompt count from that form. Also: bounded head + tail reads, the `## ADE` guidance test, `~` expansion for env overrides, and a newest-first read loop that stops when enough sessions survive. |
| `apps/desktop/src/main/services/externalSessions/events/` | The per-provider converters from a provider store to ADE chat events (`AgentChatEventEnvelope[]`), plus byte-window paging. `loadExternalSessionEvents` (`index.ts`) serves both the preview (`purpose: "preview"`) and the chat import (`purpose: "import"`). `jsonlSourceFor` names the conversation file a converter reads; `records.ts` is the exact-id record lookup (it returns null for an ill-formed id). A store-only Cursor chat pages through `loadCursorStorePage` (`cursor.ts`). See [Conversation events](#conversation-events). |
| `apps/desktop/src/main/services/externalSessions/externalSessionDetail.ts` | `loadExternalSessionDetail`: one session's detail for a preview. Returns the text tail in `messages` and a page of `events` with `hasOlder`/`olderCursor`. Also owns the local file watch (`startExternalSessionDetailWatch`), which pushes a fresh newest page when the source file changes and loads through the `loadDetail` callback it is given (the service's `getDetail`). Callers go through `externalSessionsService.getDetail`, not this function directly. |
| `apps/desktop/src/main/services/externalSessions/providerSessionHandles.ts` | Maps a provider session id back to the files that hold it, and finds which live process holds each file. The Claude / Codex / Droid roots come from `shared/providerConfigHomes.ts` so `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `FACTORY_HOME_OVERRIDE` are all honoured — and honoured with the right shape, since only the first two name a directory while `FACTORY_HOME_OVERRIDE` replaces the HOME that `.factory` is appended to. The ACP roots come from the same module (`QWEN_HOME`, `GROK_HOME`, `COPILOT_HOME`, `KIMI_CODE_HOME`). See [Session tracking](#session-tracking). |
| `apps/desktop/src/main/services/externalSessions/liveChatProviderRefs.ts` | `providerPointersFromChatRecord`: every provider pointer that one ADE chat holds (`importedFrom` for a continue, the provider session ids, and `acpSessionId` for the ACP providers). `chatImportedRefsProvider(chatService)` builds the chat refs source from it over the non-archived chats. Both runtime hosts wire in that one function, so a session that ADE itself runs never lists as importable on either. |
| `apps/desktop/src/main/services/externalSessions/importedSessionStore.ts` | Machine-local durable log of every import (`<ADE_HOME>/external-sessions/imported.json`), the only imported-marking source that survives deleting the ADE session and the only one that knows a fork's new provider id. |
| `apps/desktop/src/main/services/externalSessions/claudeLiveSessions.ts` | Reads Claude's own live-session registry (`<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`) and returns the session ids whose pid is still alive, for `possiblyActive`. |
| `apps/desktop/src/main/services/externalSessions/claudeSessionTransplant.ts` | Non-destructive Claude transcript transplant. For forks it copies JSONL rows, rekeys `sessionId`, hard-links without clobbering, and leaves the source untouched; for moves it can link/unlink when requested by other callers. |
| `apps/desktop/src/shared/cliLaunch.ts` | Canonical CLI launch/resume/fork command builders. External import uses `buildTrackedCliResumeCommand`, `withCodexNoAltScreen`, provider permission/model mappings, and shell quoting from here. Also holds the pre-assigned session id helpers (`preassignedSessionIdArgs`, `withPreassignedSessionIdInCommandLine`) and `buildClaudeForkLaunchCommand`. |
| `apps/desktop/src/shared/importedTurnBoundaries.ts` | `withImportedTurnBoundaries`: adds a `done` event after each imported turn that did tool work. The preview and `appendImportedChatEvents` both apply it. See [Conversation events](#conversation-events). |
| `apps/desktop/src/shared/types/externalSessions.ts` | Canonical DTOs shared by desktop IPC, ADE actions, sync remote commands, `ade code`, and iOS. Also `EXTERNAL_SESSION_PROVIDERS` (display order), `EXTERNAL_SESSION_PROVIDER_LABELS` (the one provider list and label map), and `EXTERNAL_SESSION_PROVIDER_CAPABILITIES` (the per-provider base capabilities, which the host narrows per session and the browser mock shows as they are). |
| `apps/desktop/src/shared/types/externalSessionDetail.ts` | `ExternalSessionDetail` and its args. `events`, `hasOlder`, `olderCursor`, and the `before` arg are optional, so older hosts stay compatible. |
| `apps/desktop/src/main/services/chat/externalChatHistoryImport.ts` | Converts external Claude JSONL and Codex app-server thread history into ADE chat event envelopes with byte/event caps and provenance/truncation notices. Exports the building blocks the `events/` converters share (`externalImportEnvelope`, `finalizeExternalImportEvents`, `claudeRecordsToContentEvents`, `codexTurnsToContentEvents`). |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Owns `importExternalChatSession`. Creates the ADE chat session, imports history, seeds Claude `sdkSessionId`, Codex `threadId`, or the Droid/OpenCode/Pi/Copilot provider pointer, persists provenance (`importedFrom.mode`), and cleans up failed forks. Statically imports the Claude transplant module for the packaged brain bundle. |
| `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/services/ipc/registerIpc.ts` | Defines and registers `ade.externalSessions.list`, `.import`, `.getDetail`, `.watchDetail`, `.unwatchDetail`, and the `.detailUpdated` push channel. `list`, `import`, and `getDetail` are the legacy in-process fallback; the watch channels are always local. |
| `apps/desktop/src/preload/preload.ts`, `apps/desktop/src/preload/global.d.ts` | Exposes `window.ade.externalSessions.list/import/getDetail/watchDetail/unwatchDetail/onDetailUpdated`. `list`, `import`, and `getDetail` first call the bound project runtime's `external-sessions` ADE action domain and fall back to desktop IPC only when no runtime is bound. The watch calls always use local IPC. |
| `apps/desktop/src/main/services/adeActions/registry.ts` | Registers the `external-sessions` ADE action domain (`list`, `import`, `getDetail`) against the runtime's `externalSessionsService`. `watchDetail` is deliberately absent: it pushes on a per-sender Electron IPC channel that the action domain cannot reach. |
| `apps/desktop/src/main/main.ts` | Constructs `externalSessionsService` for desktop-owned project runtimes and injects it into IPC, ADE actions, sync, and runtime context. |
| `apps/ade-cli/src/bootstrap.ts` | Constructs the same service for the headless ADE brain/runtime so remote-bound desktop windows and the mobile sync host expose the feature. |
| `apps/ade-cli/src/adeRpcServer.ts` | Authorizes `run_ade_action` calls. Non-CTO callers are lane-scoped for `external-sessions`; CTO callers can use the domain unscoped. |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts`, `apps/desktop/src/main/services/sync/syncRemoteCommandService.ts` | Registers `work.listExternalSessions`, `work.getExternalSessionDetail` (the phone preview: the service's `getDetail` with 120-event pages, mobile-wire compacted), and `work.importExternalSession` for paired controllers. The desktop file is a re-export of the ade-cli implementation. |
| `apps/desktop/src/shared/types/sync.ts` | Sync command DTO aliases for external-session list/detail/import payloads and results. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionBrowser.tsx` | The desktop Import session dialog: a fixed-size split view (`LaneDialogShell`, up to 1180 × 860 px). Owns the scan, the filters, the selection, the target lane, the surface choice, and the import run. Asks for 200 rows per provider to match the service's project-scope discovery window. A provider that fails its scan leaves a muted per-provider notice ("OpenCode CLI not found…") instead of an unexplained empty list, and only a total scan failure becomes the blocking error state. See [Desktop dialog](#desktop-dialog). |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportTopBar.tsx` | The dialog's top bar: provider chips, the lane filter (`LaneCombobox` with per-lane counts and "Other folders"), search, refresh, and the computer (source) picker. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionList.tsx` | The left session list, grouped by date ("Today", "Yesterday", weekday, date). Keyboard moves keep the selected row in view and move roving focus. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionPreview.tsx` | The right pane: a who/where header, then the conversation rendered read-only by `AgentChatMessageList` in its own scroll box that opens at the bottom. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportActionBar.tsx` | The action bar pinned under the preview. Renders `planImport` and nothing else: the surface switch, the lane pill or locked lane pill, the model picker for a chat copy, the primary and secondary buttons, and one note line. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionParts.tsx` | Small shared parts, for example the lane dot + lane name label (a folder mark for a session outside every lane). |
| `apps/desktop/src/renderer/components/terminals/importSessions/importBrowserModel.ts` | Pure dialog rules with no React: `sessionPlace` (the lane a row names), lane-filter keys and counts, search, `defaultForkModel`, the per-provider surface memory in `localStorage` (`ade.importSession.surface.<provider>`), and `spliceNewestPage` for live preview updates. |
| `apps/desktop/src/renderer/components/terminals/importSessions/useExternalSessionDetail.ts` | Loads the preview transcript: the newest page after a short settle delay, older pages on scroll-back, and live updates through `watchDetail` for sessions on this computer. A live update replaces the newest page and keeps the pages the user already loaded. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportFloatingBadge.tsx` | The "Import your chats from outside ADE" hint on the Work draft surface, plus its machine-local per-project dismissal (`readImportBadgeDismissed`). It is the last row of the draft column, below the activity module, and is `shrink-0` because the wordmark above it is the only row meant to absorb overflow when the column is height-capped. It returns `null` — not an empty wrapper — once dismissed or when there is no project root, so a retired hint spends none of the column's row gap. |
| `apps/desktop/src/shared/externalSessionAffordances.ts`, `apps/desktop/src/renderer/components/terminals/importSessions/affordances.ts` | Row display helpers shared by the desktop dialog and the TUI: `shortenExternalSessionCwd` (and its renderer binding `shortenCwd`) and `formatExternalSessionSize` ("40 MB", "2.4 MB"; empty for a missing or zero size). The import actions live in `externalSessionPolicy.ts`. |
| `apps/desktop/src/renderer/components/terminals/importSessions/sessionPresentation.ts` | Pure desktop heading/time/anchor helpers. Provider titles win, then the opening prompt (`preview`), then cwd + relative time. `sessionAnchors` returns the row's "started"/"latest" pair and drops whichever one the heading is already showing, so a row never prints the same sentence twice. Also the date groups, compact row times ("13m"), and prompt counts. |
| `apps/desktop/src/renderer/components/terminals/importSessions/contract.ts` | Renderer bridge and types for external sessions (`readImportedFrom`, `PROVIDER_TOOL_TYPE`). The provider list and labels are not here: surfaces use `EXTERNAL_SESSION_PROVIDERS` and `importProviderLabel` directly. |
| `apps/desktop/src/renderer/components/terminals/LaneCombobox.tsx` | The shared lane picker. Options can carry a trailing `detail` (the import dialog's session counts) and an `icon` (the "Other folders" pseudo-option); `allDetail` puts a total on the "All lanes" row. |
| `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` | Adopts import results into the Work surface and focuses existing imported sessions without re-importing. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`, `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx`, `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` | Wires the import browser into the Work draft/new-session surface and routes imported or already-imported sessions to the selected Work tab. |
| `apps/ade-cli/src/tuiClient/externalSessionBrowser.ts`, `apps/ade-cli/src/tuiClient/components/RightPane.tsx`, `apps/ade-cli/src/tuiClient/components/ExternalSessionPreview.tsx`, `apps/ade-cli/src/tuiClient/app.tsx` | ADE Code TUI import browser. Rows show the home lane with its color. The action list is `planImport` flattened (one entry per surface and mode, with the lane, the lock reason, and the note), planned with `originLaneId` set to the lane `/import` scanned. The target lane defaults to the session's home lane, and an action with `confirmBeforeRun` asks for a second Enter. `withReloadedExternalSessions` swaps in a refreshed list and clears the row's lane, action, and confirm picks (`EXTERNAL_SESSION_ROW_RESET`) when a different session now sits at the selected index, so Enter never imports a new row into the lane picked for the old one. |
| `apps/ios/ADE/Models/RemoteModels.swift` | iOS Codable mirrors for `ExternalSessionSummary` (including `home`, `sizeBytes`, and `importedBefore`), `ExternalSessionMessage`, capabilities, imported refs, and import results. `messages` decodes through `ADELossyArray`, and `ExternalSessionMessage` rejects any role other than `user`/`assistant`, so a bad element is dropped instead of taking the whole summary down. A new key must be added in all three places inside the summary struct — `CodingKeys`, the memberwise `init`, and `init(from:)` — or it silently decodes as nil. The import result requires only `kind`: an embedded `session`/`chatSummary` this build cannot decode is dropped (the screen re-fetches the chat summary), because the import already happened on the host and a failed decode would invite a duplicate import. |
| `apps/ios/ADE/Services/SyncService.swift` | iOS client methods for `work.listExternalSessions` (including the exact `sessionId` lookup), `work.getExternalSessionDetail` (`getExternalSessionDetail(provider:sessionId:before:)`, gated by `supportsExternalSessionDetail`), and `work.importExternalSession` (optional model and permission mode). |
| `apps/ios/ADE/Views/Work/WorkNewChatScreen.swift` | Adds the Import session affordance when a concrete lane is selected. |
| `apps/ios/ADE/Views/Work/WorkExternalSessionAffordances.swift` | The Swift port of `externalSessionPolicy.ts`: `WorkImportLaneRule`, the provider table, `workEffectiveImportRules`, and `workPlanImport`. Keep the table, labels, notes, and lock reason in lockstep with the TypeScript file; `ADETests` mirrors its tests. `workExternalSessionProviderName` is the one iOS provider-label map. |
| `apps/ios/ADE/Views/Work/WorkImportSessionScreen.swift` | iOS list/detail flow: provider chips, a lane filter menu with counts and "Other folders", project/all scope, date-grouped rows, the scan and import runs, and the live-continue confirm state. |
| `apps/ios/ADE/Views/Work/WorkImportSessionRows.swift` | The compact list row, the detail header, the status badges ("In ADE", "Copied before", "May be open elsewhere"), and `WorkImportLaneLabel` (lane dot + name, "Removed lane", or the folder's last segment). |
| `apps/ios/ADE/Views/Work/WorkImportSessionPreview.swift` | The detail's conversation preview. On a host with `work.getExternalSessionDetail` it renders the ADE chat events through the Work chat builders and row views, in a bounded scroller with "Load earlier". Otherwise it shows the list's sampled messages. |
| `apps/ios/ADE/Views/Work/WorkImportActionBar.swift` | The action bar that renders `workPlanImport`: mode switch, lane control (`WorkLanePickerDropdown`, or a locked lane), note, primary button, and optional Copy. `workImportConfirmKey` keys the "Continue anyway" second tap to one session, action, and lane. |
| `apps/ios/ADE/Views/Work/WorkImportSessionPresentation.swift` | Pure row presentation on `ExternalSessionSummary`: headings, anchors, lane names, lane-filter buckets, the default target lane (`defaultImportTargetLaneId`), and `workExternalSessionSizeText`, which mirrors desktop `formatExternalSessionSize`. |
| `apps/ios/ADE/Views/Work/WorkRootComponents.swift`, `apps/ios/ADE/Views/Work/WorkStatusAndFormattingHelpers.swift`, `apps/ios/ADE/Views/Components/ADEDesignSystem.swift` | Shared iOS provider logos, fallback symbols, and provider accent colors consumed by the import screen. |

## Architecture

### Discovery

`externalSessionsService.list` fans out to one provider module per requested
provider, catches provider-specific failures, merges the rows, filters to the
current project scope unless `scope: "all"` is requested, and returns
`ExternalSessionSummary[]` sorted by `updatedAt` descending.

File-backed providers are stat-first. Discovery gathers candidate files, sorts
by mtime, and reads a bounded recent candidate window. Claude keeps scanning
past filtered SDK transcripts until it has filled the requested CLI-session
limit. Codex is the exception: it reads Codex's own thread store rather than the
rollout inventory (see "Codex thread store" below). The cheap JSONL read is bounded by
`JSONL_SCAN_BYTE_LIMIT` and `JSONL_SCAN_LINE_LIMIT`; meaningful user prompt
counts are only computed for files under `MESSAGE_COUNT_MAX_BYTES`.
Provider metadata, assistant/tool rows, local-command wrappers, and duplicate
Codex storage representations do not inflate `messageCount`. OpenCode is the
exception because its supported interface is the CLI list command, so discovery
runs `opencode session list --pure --format json --max-count <limit>` in the
requested cwd, project root, or home directory. The list schema does not expose
a preview or prompt count, and discovery deliberately avoids an expensive
per-session `opencode export` fan-out. The four ACP discoverers read a history
file whole when it is at most 768 KB, so the prompt count is exact. A larger
file gets a bounded head and tail and a null count, the same contract as the
other discoverers.

### Codex thread store

Codex maintains `CODEX_HOME/state_5.sqlite`, and that database — not the
`sessions/YYYY/MM/DD` rollout tree — is what ADE lists. It is strictly more
complete than the files: on a real 7.2k-thread store, 4.1k rollouts are spawned
subagents, and more than a third of them carry no parent id in their own
`session_meta`. Listing from files alone therefore showed thousands of subagent
runs as if they were conversations.

Discovery opens the database read-only, never takes a write lock, and selects
non-archived threads that are not a `thread_spawn_edges` child, newest first.
`id`, `cwd`, timestamps, and title/preview text come straight from `threads`,
which removes the per-file `session_meta` fan-out, the null-cwd project-scope
loss, and the file-count ceiling that project-scoped discovery used to need. The
thread id is the record identity everywhere, so a compressed `.jsonl.zst`
rollout and a plain one can no longer produce two rows for one conversation.
`rollout_path` can dangle (upstream `openai/codex#21196`); those threads still
list from their database metadata.

Two things the database does not answer are read from the rollout file, line 1
only, and only for threads that survive the cheap filters: the `originator`
(ADE's own Codex sessions are excluded from the import list) and
`forked_from_id`. Line 1 is the limit on purpose — a fork replays its parent's
transcript verbatim, so the parent's `session_meta` appears again further down.
When a fork exists and its parent recorded no activity after the fork point, the
parent is hidden: that pair is one conversation the user continued elsewhere. A
parent that kept going after being forked stays listed alongside its fork, and
only forks this surface would itself list can collapse a parent — ADE's own
chats fork Codex threads, and collapsing a real terminal session into a fork the
import list refuses to show would drop the conversation entirely.

Classification fails **open**. A structured (object-shaped) `source` is a
spawned subagent and is dropped, as are the known non-interactive `exec` and
`vscode` entrypoints; an unrecognized `source` string is listed and logged as
`external_sessions.codex_unknown_source`, because a new Codex entrypoint
silently vanishing from the import list is worse than one extra row.

When the database is missing, unreadable, or shaped differently than this build
expects, discovery logs `external_sessions.codex_state_db_unavailable` or
`external_sessions.codex_state_db_query_failed` and falls back to the older
rollout-file scan with its bounded candidate window. That fallback cannot see
spawn edges, so it lists subagent rollouts whose `session_meta` hides their
parentage — it is a compatibility path, not an equivalent one.

An **empty result is not by itself a reason to fall back.** Zero rows with
threads present is a real answer — everything was archived, spawned, or out of
scope — and falling back there would hand the list to a scan that cannot tell a
subagent rollout from a conversation. So an empty result triggers one extra
`SELECT 1 FROM threads LIMIT 1`, and only an actually empty table (a
freshly-migrated or truncated `state_5.sqlite`, which is no authority on what
exists) defers to the rollout tree.

Titles and previews are deliberately separate:

- `title` is a real provider-persisted title, or `null`. Discovery must not use
  the first user message as a title.
- `preview` is the thread's **opening prompt** — the first real human message,
  after ADE guidance and provider transport-wrapper stripping. It is what the
  row heading falls back to when the provider persisted no title, which is the
  common case for Claude CLI transcripts. Synthetic Claude
  `<local-command-caveat>`, `<command-name>`, `<local-command-stdout>`, and
  Codex environment/AGENTS payloads must never become previews. There is no
  separate first-prompt field: an alias of `preview` is one more thing to keep
  in sync across the DTO, the sync command, the iOS mirror, and two renderers,
  for no information the summary did not already carry.
- `messages` is a bounded sample of recent user/assistant exchanges, oldest to
  newest, capped by `EXTERNAL_SESSION_MESSAGES_MAX_COUNT` (8) and clipped per
  message by `EXTERNAL_SESSION_MESSAGE_MAX_LENGTH` (320). Claude derives it from
  the tail of its existing prefix + suffix scan at no extra I/O cost; Codex
  reads a bounded rollout suffix (64 KiB while browsing, 128 KiB for an exact
  `sessionId` lookup) and skips `.jsonl.zst` rollouts entirely. The four ACP
  discoverers derive it from the head + tail window they already read. Cursor,
  Droid, and OpenCode leave it absent rather than paying for new I/O — OpenCode
  in particular must not gain a per-session `opencode export` fan-out. (The
  preview reads the full conversation separately; see
  [Conversation events](#conversation-events).)

`messages` is **optional and nullable**, and must stay that way. The iOS mirror
decodes every field with `decodeIfPresent`, and a decode failure there drops the
entire summary through a swallowing `try?`, so the import screen would show an
empty "No sessions found" state with no error. `messages` additionally decodes
through a lossy array wrapper, so one malformed element costs that element, not
the session. Add new optional keys; never re-type an existing one.

Two rules keep previews honest:

- **Wrapper rejection is not an allow-list.** The named noise-tag list still
  exists, but it cannot be complete — a `<task-notification>` blob shipped to
  users as a preview precisely because it was not on it. Preview selection
  therefore also rejects text that is predominantly markup
  (`EXTERNAL_SESSION_MARKUP_TEXT_MIN_RATIO`), and wrapper stripping handles tags
  whose closing half fell outside the read window.

  That density gate is **preview-only**. It runs where a preview or a `messages`
  sample is chosen, never inside `cleanExternalSessionUserText`, because that
  cleaner also feeds `externalChatHistoryImport` and therefore the imported chat
  transcript. Rejecting markup-heavy or very short turns there would silently
  delete real user messages from someone's history — a pasted JSX snippet, or a
  reply as ordinary as "ok". Message counting must not use it either.
- **`preview` may only come from *prefix* records.** Claude's scan array is
  prefix ++ tail, so a loop that simply took the first record yielding text
  would fall through into the tail and surface a background-task receipt as the
  opening prompt. Recent `messages` are the only thing sourced from the tail.

Clipping snaps to a word boundary and never ends inside a tag; a hard `slice`
produces visibly bisected markup such as `<stat…`.

The desktop and iOS rows use the real title when present, then the opening
prompt, then a path/time heading. Placeholder titles such as "New Session" are
normalized to null. Both surfaces suppress an anchor that would repeat the
heading, so a one-message thread with no provider title shows its prompt once.

The service also stamps:

- `alreadyImported` and `importedSessionRef` (see "Import marking" below).
- `possiblyActive`. For Claude this is the CLI's own live-session registry,
  `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json`: an entry whose `pid` is still alive
  means the session is open right now, which is the question the badge is
  actually asking. Stale entries survive the process that wrote them, so
  liveness is checked, never assumed. Every other provider — and Claude when the
  registry directory does not exist — falls back to "backing file mtime within
  the last two minutes". The residual gap is pid reuse across a reboot; it costs
  one wrong badge, not a wrong import.
- `cwdMatchesRequestedLane`, comparing the provider cwd to the requested lane
  cwd when known.
- `home` and `sizeBytes`. See [Lane attribution](#lane-attribution).

A session that a live tracked ADE PTY owns is not listed. Ownership uses
`handleIsOwnedByTrackedPty`, so the CLI process can be any descendant of the
PTY. See [Session tracking](#session-tracking).

### Lane attribution

Every summary carries `home?: ExternalSessionHome | null`. The service resolves
it from the session cwd against the project's live lanes
(`sessionHome.ts`). It re-reads the lane list on every `list()` call, because
a stale lane name is worse than a slow list.

| `home.kind` | Meaning |
|---|---|
| `lane` | The session folder is a live lane's worktree root or a folder inside it. `laneId`, `laneName`, `branchRef`, `color`, and `laneType` name the lane. `atLaneRoot` is true only when the folder is exactly the worktree root. |
| `removed-lane` | The folder is under `.ade/worktrees/`, but no live lane owns it. |
| `outside` | Any other folder. It is never a lane. |

The primary lane's worktree is the project root, and that root also contains
every other lane under `.ade/worktrees/`. So the deepest lane root wins, and a
primary-lane match through `.ade/worktrees/` becomes `removed-lane`.

For an import, the service adds the target lane to the lane list when the list
does not have it. This stops the import guard from treating the target lane's
own sessions as sessions from another folder.

`sizeBytes` is the size of the provider's store entry for the session, when one
stat call finds it. All discoverers except OpenCode set it. The desktop
preview header shows it ("40 MB").

Why this exists: on 2026-09-23 a lane whose folder kept an old name looked
like a broken path in the dialog. The dialog also defaulted the target to the
Work view's lane, so a Claude "Continue" silently became a 40 MB transcript
copy into the wrong lane. Now rows name the lane, never the
`…/worktrees/<folder>` path. The target lane defaults to the session's home
lane. The policy locks the lane when an action cannot leave it.

### Import marking

Four sources feed one `provider:id` → ref map. Chat refs outrank CLI refs,
which outrank a bare "imported, nothing to open", so the UI can offer a single
"Open in ADE" action.

- **The durable import log**, `<ADE_HOME>/external-sessions/imported.json`
  (`importedSessionStore.ts`). Every import appends one record: provider,
  external id, the provider id ADE actually runs, chat/cli, continue/fork, ADE
  session id, timestamp. It is machine-scoped and a plain atomically-written
  JSON file with an `.lkg` fallback, deliberately **not** a cr-sqlite CRR table:
  it maps onto provider stores that are themselves machine-local, so a Claude
  transcript id means nothing on the paired machine.

  The desktop app and the headless brain can share one ADE home, and the atomic
  rename alone does not stop the later writer from clobbering a record the
  earlier one added between its own read and write. So each append takes a lock
  file for the span of one read-modify-write and re-reads inside it rather than
  trusting the cache. `record` is synchronous all the way up to the import call,
  so the wait has to block the main process — which is why `LOCK_WAIT_MS` is
  200 ms, and why failing to take the lock writes anyway instead of erroring: a
  lost race can drop one concurrent record, and that is a far better outcome
  than failing an import that already succeeded. A lock older than 5 s is
  treated as abandoned by a process that died holding it.
- ADE `terminal_sessions` resume metadata (`provider`/`targetId` and
  `importedFrom`).
- Claude session pointers from `sessionService.listClaudeSessionPointers`.
- The chat refs provider. Both runtime hosts (`main.ts` and the headless
  `bootstrap.ts`) build it with `providerPointersFromChatRecord` over the
  non-archived chat sessions. So it holds every provider pointer a live chat
  has, not only `importedFrom`. A session that ADE itself runs as a chat never
  lists as importable on either host.

The last three are all derived from live rows, which is why the durable log
exists. They lose the badge when the ADE session is deleted, and they never knew
the *new* provider id a fork import created — a Codex `thread/fork` thread or a
transplanted Claude transcript. Both ids are recorded, so the copy is
recognizable.

A row reports one of three states:

| State | Fields | Dialog |
|---|---|---|
| In ADE now | `alreadyImported: true`, `importedSessionRef` set | "Open in ADE" replaces the plan. |
| Imported before | `alreadyImported: false`, `importedBefore: true` | Listed as importable, with a hint. |
| Never imported | both false | Listed as importable. |

"Imported before" covers two cases: the ADE session behind the record is gone,
or the import was a **copy**. A copy leaves the original untouched, so the
original must stay importable. Each source applies this rule:

- The durable log records a copy's original with no ref (`mode: "fork"`). A
  replay copy (every provider except a Claude or Codex native fork) has no new
  provider id until its first turn. The service records only the original for
  it.
- Resume metadata with `importedFrom.mode: "fork"` gives the original no ref.
- `providerPointersFromChatRecord` skips `importedFrom` when the chat's
  `importedFrom.mode` is `"fork"`. `AgentChatImportedFrom.mode` is
  `"continue" | "fork"`. A chat imported before the field existed has no mode
  and counts as a continue.

`listClaudeSessionPointers` used to clamp any request to 500 rows silently, so
imports past that point looked un-imported; the ceiling is now
`CLAUDE_SESSION_POINTER_MAX_LIMIT` (5000) and the default page stays 200.

**Lineage.** Discovery collapses Claude continuation chains to their leaf and
hides a Codex parent behind its fork, so the id a session was imported under is
often no longer the id it is listed under. Collapsing providers therefore set
`lineageIds` on the surviving record — the ids it supersedes — and marking
matches against `id ∪ lineageIds`. The field is optional; the other providers
never collapse and never set it. It is discovery-internal and not part
of `ExternalSessionSummary`, so no DTO, sync payload, or iOS mirror changes.

**ADE-created artifacts are not new sessions.** A cross-cwd Claude fork writes a
transplanted copy into `~/.claude` under a fresh uuid, and a Codex chat fork
mints a new thread; both then re-list as fresh importable sessions. Rows whose
ids are all recorded fork *targets* are dropped from the list. "All", not "any":
when discovery collapses the user's original into the copy, that one row is also
the only place the original appears, so it stays listed and simply reads as
already imported. An exact `sessionId` lookup skips the filter entirely, the
same way Claude dedupe does, so a caller that names an ADE-created id still
resolves it.

### Import policy

`apps/desktop/src/shared/externalSessionPolicy.ts` is the one source of truth
for which import actions exist. The desktop renderer, the ADE Code TUI, and the
host import guard all call it. iOS has a Swift port in
`WorkExternalSessionAffordances.swift`, and `ADETests` mirrors the TypeScript
tests. No client decides on its own which actions exist.

The policy has four actions per provider. Each action has a lane rule:

| Rule | Where the action can run |
|---|---|
| `any` | Any lane. |
| `home` | Only the session's home lane. A session with no live home lane (`outside` or `removed-lane`) can go to any lane, and it runs in its original folder. |
| `root` | Only the home lane, and only when the session folder is that lane's worktree root (`home.atLaneRoot`). ADE chats always run at the lane root. |
| `none` | Not offered. |

`PROVIDER_IMPORT_RULES`:

| Provider | Chat continue | Chat copy | CLI continue | CLI copy |
|---|---|---|---|---|
| Claude | `root` | `any` | `home` | `any` |
| Codex | `any` | `any` | `any` | `any` |
| Cursor | `none` | `any` | `home` | `none` |
| Droid | `root` | `any` | `home` | `any` |
| OpenCode | `root` | `any` | `home` | `home` |
| Pi | `root` | `any` | `home` | `home` |
| Qwen | `none` | `any` | `home` | `home` |
| Kimi | `none` | `any` | `home` | `none` |
| Grok | `none` | `any` | `home` | `home` |
| Copilot | `root` | `any` | `home` | `none` |

What each cell does:

- **Chat continue.** Claude binds the ADE chat to the original Claude session.
  Codex binds it to the original thread. Droid, OpenCode, Pi, and Copilot seed
  the provider pointer (see [Chat target](#chat-target)).
- **Chat copy.** Claude and Codex make a native provider fork when the chosen
  model is of the same family. Every other case is a full-transcript replay
  into the chosen model.
- **CLI continue.** Resumes the original session in a tracked terminal.
- **CLI copy.** A provider-native fork in a tracked terminal: Claude
  `--fork-session` or a transplant, Codex `fork`, Droid `--fork`, OpenCode
  `--fork`, Pi `--fork`, Qwen and Grok `--fork-session`.

Chat continue for Cursor, Qwen, Kimi, and Grok is `none` on purpose. A chat
continue opens the CLI-created session from ADE's own chat runtime. For those
ACP providers, ADE has not yet proven on a live run that `session/resume` or
`session/load` can open a session that the CLI itself created. Copilot is
proven (see [Live verification](#live-verification-2026-09-23)). Cursor chats
use the Cursor SDK, which has no proven path to a `cursor-agent` CLI chat
either. Until then, chat mode offers only the replay copy for them.

#### Capabilities only narrow the table

The host still sends `ExternalSessionCapabilities` on every row. The base
values per provider are `EXTERNAL_SESSION_PROVIDER_CAPABILITIES` in
`shared/types/externalSessions.ts`; the host narrows them per session as listed
below. `effectiveImportRules` narrows the table with them. It never widens it.

| Capability | Meaning | Effect on the rules |
|---|---|---|
| `resumeInPlace` | The provider can continue the original session in the folder where it was created. | CLI continue is at most `home`. |
| `resumeInDifferentCwd` | The provider can continue the original session in the target lane folder. | CLI continue can be `any`. |
| `fork` | The provider can make a copy without changing the original. | CLI copy is at most `home`. |
| `forkIntoDifferentCwd` | The provider can make that copy in the target lane folder. | CLI copy can be `any`. |
| `importToChat` | The host can continue the session as an ADE chat. | Chat continue becomes `none` when false. |

Chat copy is never narrowed. A replay needs only the history, not the folder.
The chat importer itself refuses a session with nothing to replay.

The host narrows the capabilities for these cases:

- **The source folder is missing.** Every capability becomes false. Claude
  keeps its copy (the transplant does not need the folder). Droid keeps its
  fork (the fork runs in the target lane).
- **Droid `--fork` is not known yet.** The service starts a `droid --help`
  probe when it is built. Until the probe resolves, `list()` reports `fork`
  and `forkIntoDifferentCwd` as false. A Droid CLI copy import waits for the
  probe, then re-reads the capabilities before the guard runs.
- **The ACP providers and Cursor.** `importToChat` is false.

#### The plan

`planImport(summary, { surface, targetLaneId, originLaneId, laneName })`
returns an `ImportPlan`. `originLaneId` is the lane the session list was
scanned for; it matters only for an older host (see the notes below). Every
client renders the plan as it is:

| Field | Meaning |
|---|---|
| `surfaces` | The surfaces (`chat`, `cli`) that have at least one action. |
| `surface` | The requested surface, else the first available one. |
| `targetLaneId` | The lane the actions run in. A locked plan forces the home lane. |
| `laneLocked`, `lockReason` | True when no action on this surface can leave the home lane. The reason is short: "Cursor sessions stay in their own lane." |
| `primary`, `secondary` | The main action and the optional secondary "Copy". Each has `target`, `mode` (`resume` or `fork`, the wire value), `label`, `needsModel` (true for a chat copy), and `confirmBeforeRun` (true for a continue on a `possiblyActive` session; two writers on one provider session corrupt it). Clients arm their second press from `confirmBeforeRun` and never re-derive it. |
| `note` | One short line, or null. |

Labels:

- Continue allowed: the primary is "Continue". The secondary is "Copy" when a
  copy is also allowed.
- Chat surface, only a copy allowed: the primary is "Open as ADE chat".
- CLI surface, only a copy allowed: the primary is "Copy here" when the target
  is not the home lane, else "Copy".

Notes (at most one):

- A continue on a session that may be open: "Open elsewhere — close it there
  first."
- A copy out of the home lane: "Original stays in {home lane}."
- A CLI continue of a session outside every lane: "Runs in its original
  folder." An older host sends no `home`, so its `cwdMatchesRequestedLane` is
  the only signal. That flag answers for the scanned lane, so the note also
  shows when the flag is not true, or when the target is no longer
  `originLaneId`.

#### Host guard

`externalSessionsService.importExternalSession` finds the session summary
again (with `home`), then calls `importRejectionReason`. An import that the
plan would not offer for that lane fails with the same plain words the dialog
uses, for example "This Cursor session can only do that in Apple Sim." The
guard runs for both surfaces, so a client that skips the plan cannot import
around it.

### CLI target

`externalSessionsService.importExternalSession` validates the provider and
session id with `validateExternalSessionId` (`sessionIds.ts`: strict UUIDs for
Claude/Codex; bounded provider-safe ids with no path separators for the other
CLIs), resolves the target lane cwd, optionally enforces caller lane scope,
finds a currently resumable external summary, runs the policy guard, chooses
the run cwd, builds `TerminalResumeMetadata`, then builds a provider command.

Resume commands come from `buildTrackedCliResumeCommand` in
`apps/desktop/src/shared/cliLaunch.ts`. Codex resumes in the lane folder. Every
other provider resumes in the session's own folder, because its session is
keyed to that folder. The resume selector per ACP provider is:
`qwen --resume <id>`, `kimi -S <id>`, `grok -r <id>`, and
`copilot --resume=<id>`.

When an import does not explicitly override model or permission mode, the
resume command preserves provider state. ADE does not inject Claude plan mode,
Cursor `--model auto`, Droid spec/off settings, or an OpenCode ask-policy
config merely because the import UI omitted an override.

Fork commands mostly reuse the same builder and provider-specific flags:

- Claude same-cwd fork appends `--fork-session` to the Claude resume command.
  The PTY launch path then adds a pre-assigned `--session-id <new>`, so ADE
  knows the copy's id before the process starts (see
  [Session tracking](#session-tracking)).
- Claude cross-cwd fork calls `transplantClaudeSession` first, then resumes the
  copied/rekeyed session id from the lane cwd.
- Codex fork rewrites the tracked resume command from `resume` to `fork` and
  preserves `--no-alt-screen`.
- Droid fork launches `droid --fork <id>` after the installed-CLI probe says
  `--fork` exists.
- OpenCode fork appends `--fork` to the OpenCode tracked resume command.
- Pi fork launches `pi --fork <id>`.
- Qwen fork appends `--fork-session` to `qwen --resume <id>`.
- Grok fork appends `--fork-session` to `grok -r <id>`. The resume launch
  carries Grok's supervision environment, so the copy command puts those
  `NAME=value` pairs in front of the line.
- Cursor, Kimi, and Copilot have no fork. The service refuses a fork import for
  them.

OpenCode, Pi, Qwen, and Grok copies run in the source folder, because these
CLIs key a session to the folder it ran in. The policy guard has already
refused a copy into any other lane. So the source folder is the home lane (or a
folder inside it), or the original folder of a session that no live lane owns.

The final spawn is a tracked `ptyService.create` call with `tracked: true`,
provider `toolType`, `startupCommand`, direct shell launch fields, and
`resumeMetadata`. When the run cwd is not the lane cwd, the call also sets
`allowExternalCwd`. The import path lets `ptyService` allocate a fresh
ADE session id, so it does not pass `allowNewSessionId`; that flag is required
only for create/resume callers that preassign a new `sessionId`. Future changes
that preassign external-import session ids must set `allowNewSessionId: true`
or `ptyService.create` will treat the request as a missing-session resume.

`resumeMetadata.importedFrom` records the original provider id and whether the
ADE session opened or forked it (`mode`). That metadata is what lets later Work
continuation and `ade.pty.resumeSession` find the provider target again;
duplicate-import detection reads the durable log described under "Import
marking", because resume metadata dies with the session row.

Successful imports return the persisted `TerminalSessionSummary` or
`AgentChatSessionSummary` with the provider/ADE ids. Desktop and iOS install
that summary before navigating, so the first render cannot race database sync
and fall into a blank “session unavailable” state.

### Chat target

Every provider supports `target: "chat"`.
`externalSessionsService.importExternalSession` runs the policy guard, then
delegates to `agentChatService.importExternalChatSession`. The service passes
the session's recorded model as `sourceModel`. The importer creates a normal
lane-scoped `AgentChatSession`, stamps `importedFrom` (with `mode: "continue"`
or `"fork"`), appends imported history events, and binds future turns where
the provider allows it.

The importer picks one of four paths:

| Path | When | What it does |
|---|---|---|
| Claude native | Claude, target model of the Claude family (or none) | Continue binds the original session. Copy transplants the JSONL under a fresh id. |
| Codex native | Codex, target model of the Codex family (or none) | Continue binds the original thread. Copy calls `thread/fork`. |
| Native continue | Droid, OpenCode, Pi, or Copilot, `mode: "resume"` | Seeds the provider pointer. See below. |
| Replay copy | Every other case | Loads the history, writes it into a new chat, and stages it as a replay for the chosen model's first turn. |

The model for a replay copy is, in order: the model the user chose, the
session's recorded model when it resolves to a model of the same provider
family, that provider's default model, and then ADE's default model. A replay
with nothing to replay fails with "has no messages to replay" and creates
nothing.

**Native continue (Droid, OpenCode, Pi, Copilot).** The chat continues the provider
session in place, the same way a restart reopens one of ADE's own chats. Each
runtime opens the pointer from the store that the CLI writes:

- Droid: `droidSdkSessionId`, opened by the Droid SDK `resumeSession` from
  `~/.factory/sessions`.
- OpenCode: `providerSessionId`, opened by `session.get` on the user-env
  server, which uses the same data directory as the CLI.
- Pi: `piSessionId`, opened by `SessionManager.list(cwd)` over the one Pi
  session store that chat and CLI share.
- Copilot: `acpSessionId`, opened by `session/load` on `copilot --acp`, which
  reads the same `~/.copilot/session-state`. ADE already holds the transcript,
  so it suppresses the load replay.

The importer refuses a native continue when the session folder is not the lane
root, and when the requested model is from another family. The model is the
requested one, else the recorded model of the same family, else the provider
default. When that model is the session's recorded model and supports the
recorded reasoning effort (`sourceReasoningEffort`), the chat keeps it, as the
native Claude and Codex paths do. The
imported history is for display only: the provider already holds
it, so nothing is replayed into the prompt. The history is read before the chat
exists, so an unreadable session creates nothing.

`externalChatHistoryImport.ts` is the history converter for Claude and Codex.
It reads at most the last 32 MB of file-backed transcript bytes and keeps the
newest 2,000 imported content events. The importer prepends system notices for
provenance and truncation, then maps user/assistant text plus supported tool
calls/results, commands, file changes, web searches, image generation, and
image view events. Metadata-only user rows and provider transport wrappers are
excluded from the visible transcript, while user-authored JSX/XML and ordinary
text beginning with `User request:` remain intact. Failed Claude tool results
preserve their failed status. The other providers go through
`loadExternalSessionEvents` with `purpose: "import"`, which keeps the same caps
and notices (see [Conversation events](#conversation-events)).
`appendImportedChatEvents` adds turn boundaries to every imported history, so
imported tool calls show.

If the caller did not provide a title, the chat title falls back to the first
imported user or assistant text, else "Imported {provider} chat". That
provider-derived title is replaceable metadata, not a manual rename, so the
desktop **Name & status** action can refresh it later.

Claude chat import reads JSONL from `CLAUDE_CONFIG_DIR` or
`~/.claude/projects`. If the user asks to fork, or if the source cwd differs
from the target lane cwd, ADE transplants the JSONL into the target lane's
Claude project folder under a fresh session id. The new ADE chat sets the
Claude runtime `sdkSessionId`, sets `claudeBackgroundResumeSessionId`, mirrors a
Claude pointer through `sessionService`, repairs known thinking-transcript id
collisions when needed, and then appends the imported ADE transcript events.
The host refuses a Claude continue from another folder; the policy only offers
it at the home lane root.

`importExternalChatSession` returns `providerTargetId` alongside the chat
session: the Claude id actually adopted (transplanted or original) or the Codex
thread actually bound (fork or original). Without it the service could only
record the id the user picked, and a fork's own id would go unmarked. The field
is optional on the result type and never crosses the wire. A replay copy has no
provider id yet, so the service records only the original (see
[Import marking](#import-marking)).

Codex chat import creates a Codex ADE session and asks the app-server for
provider state. Open imports call `thread/read` with `includeTurns: true`.
Fork imports first call `thread/fork` with `excludeTurns: true`, then read the
forked thread. If import fails after creating a provider fork, ADE best-effort
archives the forked thread before deleting the ADE session. Successful imports
set `managed.session.threadId` and persist a `chat:codex:<threadId>` resume
command.

The Claude transplant dependency in `agentChatService.ts` must remain a static
import. A dynamic `import()` built from a variable path is not bundled into the
`ade-cli` brain `cli.cjs`; packaged/headless runtimes then fail at runtime with
a missing `externalSessions/claudeSessionTransplant` module.

### Conversation events

`events/index.ts` turns a provider store into ADE chat events
(`AgentChatEventEnvelope[]`, oldest to newest). The same events feed the
preview and the replay import, so the preview shows what an import writes.

`loadExternalSessionEvents` takes a `purpose`:

| | `preview` | `import` |
|---|---|---|
| Events per page | 200 (`EXTERNAL_SESSION_PREVIEW_PAGE_EVENTS`; the phone asks for 120) | 2,000 (`EXTERNAL_SESSION_IMPORT_MAX_EVENTS`) |
| Bytes read | A 2 MB window that doubles up to 16 MB until it holds a full page; up to 4 empty windows are skipped | 32 MB (`MAX_IMPORT_TRANSCRIPT_BYTES`), in one read |
| Notices | None | "Session imported from …" and truncation notices on the newest page |
| Paging | `before` / `olderCursor` | One page |

Paging (`paging.ts`): a JSONL store is read in byte windows that end on a line
boundary. `jsonlSourceFor` names the file: the session JSONL itself, or for the
ACP stores the conversation file inside the session folder. The cursor names the window (an absolute byte `end` and its size) and
the first event already shown from it. Offsets are absolute, so appends to a
live file never shift an older page, and `before` never encodes a page size.
Limits: a line longer than the window is skipped, and a tool call and its
result on the two sides of a window edge render as two rows. OpenCode pages by
event index alone. A store-only Cursor chat pages by message index (see the
Cursor row below). When no converter produces events, the first page falls back
to the discovery record's sampled messages (text only).

Converters and their fidelity:

| Provider | Source | What converts |
|---|---|---|
| Claude, Droid | The session JSONL (same message shape) | Text, tool calls, tool results (failed status kept). Thinking blocks are dropped, as on import. Shares `claudeRecordsToContentEvents` with the import. |
| Codex | The rollout JSONL | Three layouts: current (`event_msg` `item_completed` items, plus `function_call`s no item covers, such as `spawn_agent`), legacy (`user_message` / `agent_message` plus `response_item` tool calls), and bare (`response_item` only). Commands, file changes, reasoning, and MCP tool calls map through `codexTurnsToContentEvents`. The code-mode `exec` wrapper and its `wait` polls are dropped because the commands and patches they ran are already items. |
| Cursor | `agent-transcripts/<id>/<id>.jsonl`, else `store.db` | From the transcript: text and tool calls. The transcript has no timestamps, tool ids, or tool results, so each call gets an empty completed result. A chat known only through `store.db` goes through `loadCursorStorePage`: user text, assistant text, readable reasoning, tool calls, and tool results (failed status kept), plus a `context_compact` marker where a summarization replaced earlier turns. The cursor's `end` is a message index (the store's list only grows at its end), and a page reads back one message at a time until it holds the page's events or bytes. A message blob over 8 MB (`CURSOR_STORE_MAX_MESSAGE_BYTES`) is left out with an info notice ("One message (N MB) was left out…") instead of silently vanishing. Cursor's `<user_info>` environment message is dropped. |
| OpenCode | `opencode export --pure <id>` | The full export. Stdout goes to a temp file, because OpenCode 1.18 exits before a piped stdout drains and cuts the JSON at 128 KB. The file is created exclusive and owner-only (`0600`), since it holds a whole session and the temp folder can be shared. 15 s timeout, 96 MB cap. A timeout kills the process tree (a Windows `opencode.cmd` shim runs under `cmd.exe`) and waits up to 2 s for it to close before the file is deleted. |
| Pi | The session JSONL | Text, thinking, tool calls, and tool results. |
| Qwen | `chats/<id>.jsonl` | Text, `thought` parts as reasoning, `functionCall` / `functionResponse`. User rows that Qwen injected (a `provenance` other than `real_user`) are dropped, the same test discovery uses (`isQwenPromptRecord`). Verified only for text turns; tool shapes follow the Gemini CLI format. |
| Grok | `chat_history.jsonl` | Text, `tool_calls`, tool results, and reasoning summaries. Injected (`synthetic_reason`) user rows are dropped. Rows have no timestamps. |
| Copilot | `events.jsonl` | Text, `reasoningText`, tool requests, and tool results (failed status kept). Subagent rows (`parentToolCallId`) are dropped; the parent call stands for the run. Autopilot "keep going" user rows are dropped, the same test discovery uses (`isCopilotPrompt`). |
| Kimi | `agents/main/wire.jsonl` (legacy `context.jsonl`) | Unverified. Accepts persisted `context.append_message` and `turn_begin` rows, the streamed wire protocol (`TurnBegin`, `ContentPart`, `ToolCall`, `ToolResult`), and OpenAI-style role rows (with think/reasoning parts and failed tool results). When `context.append_message` user rows exist, `turn_begin`/`TurnBegin` input is not shown again, and user rows whose origin is not the person (`isKimiUserOrigin`) are dropped. |

**Turn boundaries.** ADE's transcript does not show finished tool calls as rows
of their own. It lists them in the turn's `done` summary. A provider transcript
has no such boundary, so without help every imported tool call was invisible.
`withImportedTurnBoundaries` (`shared/importedTurnBoundaries.ts`) closes each
imported turn that did tool work with a `done` event. A text-only turn gets no
boundary, and input that already has `done` events is returned unchanged. The
desktop preview and `appendImportedChatEvents` both apply it.

**Detail.** Every caller reaches `loadExternalSessionDetail` through
`externalSessionsService.getDetail`, which passes the service's `homeDir` and
`env`. It returns `ExternalSessionDetail`: `messages` (the text tail that older
clients read), plus `events`, `hasOlder`, and `olderCursor`. The text tail is
read from the same file the converter reads (`jsonlSourceFor`), never from a
session folder or a `store.db`. Without a JSONL tail it is the discovery
record's sampled messages, else the text of the preview events (clipped), so a
store-only Cursor chat still has one. An ill-formed session id finds no record
and returns an empty detail, because the id comes straight from the caller,
including a remote viewer. A preview uses the chat-session id
`external-preview:<provider>:<id>` and has no "Session imported from" notice.
The local watch (`watchDetail`) loads through the same `getDetail` and always
sends the newest page. A client that paged back keeps its older pages.

### Desktop dialog

`ImportSessionBrowser.tsx` is a fixed-size split view: the session list on the
left, the preview and the action bar on the right. There is no "back" step.

Top bar (`ImportTopBar.tsx`):

- **Provider chips.** A chip shows only for a provider that has sessions under
  the current lane filter. The chosen provider keeps its chip, so the user can
  clear the filter.
- **Lane filter.** The shared `LaneCombobox` with an "All lanes" row. Each lane
  row shows its session count. Only lanes with sessions are listed. The
  pseudo-entry "Other folders" holds sessions whose folder is not a live lane.
  The filter opens on the lane the dialog came from while the scan can still
  find sessions there, and falls back to "All lanes" when it finds none.
- **Search.** It matches the title, the opening prompt, the lane name and
  branch, the cwd, the id, and the sampled messages. When a search finds
  nothing in the chosen lane, the empty state offers "Show N in other lanes".
- **Refresh and computer.** A refresh swaps each provider's rows in place, so
  the list never goes blank.

List rows (`ImportSessionList.tsx`) are grouped by date. A row names the lane
with its color dot, never the `…/worktrees/<folder>` path. A removed lane reads
"Removed lane". A folder outside every lane shows its last path segment. Rows
also show the compact time ("13m") and the prompt count. The first visible row
is always selected, so the preview is never empty.

Preview (`ImportSessionPreview.tsx`): a header names the lane, the branch, the
time, the prompt count, the model, and the size. Then the conversation renders through the real
`AgentChatMessageList`, read-only (no handlers, `sessionEnded`,
`textPacingEnabled={false}`), keyed `external-preview:<provider>:<id>`,
inside a `data-chat-appearance-root` box with the chat appearance style. It has
its own scroll box that opens at the newest message and loads older pages on
scroll-back. `useExternalSessionDetail` waits a short settle delay before a
load, so fast keyboard moves stay cheap. Against an older host, the preview
renders the sampled `messages` as user bubbles and assistant text.

Action bar (`ImportActionBar.tsx`) renders the plan and nothing else:

- **Surface switch.** "ADE chat | CLI", only for the surfaces the plan offers.
  The last choice per provider is kept in `localStorage`
  (`ade.importSession.surface.<provider>`).
- **Lane pill.** A `LaneCombobox` pill. When the plan is locked, a locked pill
  with a lock icon and no dropdown; its tooltip gives the lock reason.
- **Buttons.** The primary button and a small secondary "Copy". A chat copy
  asks for the model first: when "Copy" is the secondary action, the first
  click shows the model picker and changes the buttons to "Cancel" and "Make
  copy". When a copy is the primary action, the model picker shows at once.
- **Live confirm.** An action with `confirmBeforeRun` (a continue on a session
  that may be open elsewhere) takes two clicks. The first click changes the
  button to "Continue anyway" (amber) for 4 s. One armed state covers both
  second presses (the live confirm and the chat-copy model step). It is keyed
  to the row, surface, and lane, and only the live confirm times out.
- **Already in ADE.** "Open in ADE" replaces the plan.

Target lane: the session's home lane when this computer has that lane, else
the lane the dialog came from. The dialog captures its lane once when it
opens. A change of the Work view's lane while the dialog is open never changes
the target and never starts a rescan. This fixes the 2026-09-23 wrong-lane copy
(see [Lane attribution](#lane-attribution)).

Default copy model (`defaultForkModel`): the session's recorded model when the
shared model registry resolves it, else the same provider's default model (so
a Cursor session stays on Cursor), else `anthropic/claude-sonnet-5`.

Keyboard: ↑/↓ move the selection (the preview follows), Enter runs the primary
action, and Esc closes. Enter runs only after the user chose a row (click or
arrow keys) or typed a search, never on the row the dialog picked by itself. A
focused control keeps its own Enter.

### Runtime routing

The desktop renderer calls `window.ade.externalSessions.list/import/getDetail`.
The preload bridge first calls `callProjectRuntimeActionIfBound` for the
`external-sessions` ADE action domain. This is the normal path for local-bound
and remote-bound windows. The legacy `ade.externalSessions.*` IPC handlers are
only fallback handlers when no project runtime is bound. `watchDetail`,
`unwatchDetail`, and `onDetailUpdated` always use local IPC: updates arrive on
a per-sender Electron channel with no remote equivalent. So a live preview
update works only for sessions on this computer.

The service is constructed in both runtime hosts:

- `apps/desktop/src/main/main.ts` constructs it for desktop-owned project
  runtimes.
- `apps/ade-cli/src/bootstrap.ts` constructs it for the headless ADE
  brain/runtime.

That dual construction is required. A remote-bound desktop window and the
mobile sync host talk to the brain/runtime, not to the renderer bundle. Both
hosts build the chat refs with `providerPointersFromChatRecord` over
non-archived chats, so both mark the same sessions.

The ADE action domain is `external-sessions` with actions `list`, `import`, and
`getDetail`.
Non-CTO agents calling it through `run_ade_action` are lane-scoped: the caller
must be authorized for the requested lane, list args are forced to the lane cwd
and project scope, and import args receive `enforceLaneScopeCwd`. CTO callers
are unscoped.

### Mobile

Mobile uses sync remote commands:

- `work.listExternalSessions`
- `work.getExternalSessionDetail`
- `work.importExternalSession`

All three are `viewerAllowed`; import is also `queueable`. This is intentional. A
paired phone is a trusted controller for the runtime machine, so it can ask the
host to list or import sessions even though it never reads provider session
files or launches provider CLIs locally.

`WorkImportSessionScreen` follows the desktop model: provider chips, a lane
filter menu with per-lane counts and "Other folders", project/all scope, rows
that name the home lane, imported/possibly-active badges, and "Open in ADE" for
`importedSessionRef`. `SyncService` sends the command envelopes and
`RemoteModels.swift` decodes the shared DTOs. Browsing and acting are separate
steps: selecting a compact row opens its detail with the full-conversation
preview and an action bar. The action bar renders `workPlanImport`: the mode
picker, the lane control (locked when the plan says so), the note, the primary
action, and an optional Copy. The target starts on the session's home lane. A
continue on a session that may be live asks for a second tap ("Continue
anyway"). For an imported row, "Open in ADE" is the main action and only a copy
stays on offer.

Rows show the same two anchors as desktop — what the thread started as and where
it left off — falling back to the single preview snippet when the host predates
`messages`. The phone sends no model or permission override. The host then
picks the model: for a chat copy, the recorded model of the same family, else
the provider default (see [Chat target](#chat-target)). A CLI import keeps
preserving provider state.

## Provider gotchas

### Claude

Claude stores CLI sessions under
`~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, or under
`CLAUDE_CONFIG_DIR/projects/...` when `CLAUDE_CONFIG_DIR` is set. Every Claude
path in discovery, CLI fork, and chat transplant must respect
`CLAUDE_CONFIG_DIR`.

Claude resume is strictly cwd-scoped. Same-cwd CLI fork can use
`--fork-session`; cross-cwd fork has to copy/rekey the JSONL into the target
cwd's Claude project folder. Claude `ai-title`, `customTitle`, and session-title
records are preferred when present; otherwise ADE leaves `title` null and lets
UI headings fall back to path/time.

Only `<projectSlug>/<uuid>.jsonl` is a session. Roughly nine in ten transcripts
on disk are sidecars nested under `<sessionId>/subagents/**`, including workflow
runs; discovery never descends into a project subdirectory, and non-uuid names
such as `agent-*.jsonl` are ignored.

SDK-origin transcripts — ADE's own Claude chats — are excluded because the CLI
cannot reliably resume them, but the test is the entrypoint the session *starts*
with, sampled over its head rows. Excluding on any single `sdk` row instead hid
whole CLI sessions the moment one SDK-driven turn landed in them.

A modern `claude --resume` appends in place, so one file normally spans every
resume. New files appear on `--fork-session`, on `/branch`, on a rewind, and on
`/cd`, which relocates the session into another project directory. Discovery
therefore dedupes continuation chains globally, across all project directories,
never per directory:

- The chain key is the uuid of the **first record that carries one**. The
  per-record camelCase `sessionId` is always rewritten to the filename, so it
  proves nothing about ancestry; snake-case `session_id` is a genuine ancestor
  pointer and is used as a second edge, but it is absent on SDK sessions.
  First-message **text** must never key a chain: ADE injects the same preamble
  into many chats, so identical openings are routine and unrelated. Finding that
  first uuid is a bounded walk, not a single small window — one transcript in
  seven opens with a pasted prompt big enough to push it past 64 KiB.
- Only pure continuations collapse — one file's records are a prefix of, or
  identical to, another's — and the leaf (longest, newest on a tie) is the row
  that survives. Members that diverge are real forks and both stay listed.
- The prefix test is bounded, never a full read of a multi-MB transcript: the
  longer file must still contain the shorter file's final record uuid near the
  shorter file's byte length, and record uuids sampled from windows at fractions
  of the shorter file must also appear in the longer file's windows at the same
  offsets. The tail check alone is not enough — a longer file can retain the
  final record while having dropped records in between. Copies rewrite
  `sessionId` with a same-length uuid, which is what keeps those byte offsets
  aligned closely enough to sample.
- An exact `sessionId` lookup skips dedupe entirely, so an ancestor the caller
  named by id still resolves.

### Codex

Codex stores rollout JSONL under `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`
and title/update metadata in `CODEX_HOME/session_index.jsonl`. ADE treats the
thread id as the rollout UUID. Chat import and continuation use the Codex
app-server `thread/read`, `thread/fork`, `thread/archive`, resume, and fork
surfaces.

Only interactive CLI rollouts are importable. ADE excludes exec, VS Code,
desktop/ADE-originated, and subagent rollouts. Structured/unknown `source`
metadata fails closed; current Codex subagents use an object-shaped source
record rather than the older string form. For preview/count ADE prefers the
canonical `event_msg.payload.type = user_message` row so duplicated
`response_item` rows and synthetic environment instructions are not shown.

Codex file-change history items use tagged enum shapes such as
`{ type: "add" }`, `{ type: "delete" }`, and `{ type: "update" }`; they are
not always bare strings. Keep `externalChatHistoryImport.ts` mapping aligned
with that shape.

Codex resume/fork flags must match the current provider schema and CLI and
app-server contracts. Do not revive stale `ThreadResumeParams` assumptions when
editing `buildTrackedCliResumeCommand` or Codex chat import; update the tests
that assert the actual request payloads and command argv.

### Cursor

**One conversation, up to four artifacts.** A single Cursor conversation can be
written to disk in several places at once, and the bare conversation uuid is the
only identity shared across all of them:

- `~/.cursor/chats/<md5(exact-process-cwd)>/<id>/store.db` — the bucket name is
  md5 of the *raw process cwd*, not the project root, so one project spawns a
  bucket per directory a session was ever launched from (repo root and
  `apps/desktop` are different buckets).
- A second bucket for the same id, when the conversation was resumed from another
  cwd. Resume does not mint a new id, so both buckets claim it — and the newer
  one is usually the near-empty stub. Size, not recency, says which holds the
  conversation.
- `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, sharing the id
  space with `chats/`.
- A duplicate of that transcript under `projects/empty-window/`. Either copy can
  be the partial one.

Discovery therefore groups by id first and picks the fullest artifact per group,
rather than treating each file as its own session; without that, duplicates
consume the caller's `limit` and the same conversation is listed more than once.

`meta.json` next to `store.db` records `cwd` directly for newer sessions and is
preferred over reverse-mapping the bucket md5 or the project slug — the hash is
only reversible for a cwd ADE can already name, so buckets for nested cwds were
previously invisible. `.workspace-trusted` and slug de-slugging remain the
fallback for older sessions. ADE reads the store's hex-encoded meta record for
name and creation time, includes store-only sessions, and treats the SQLite WAL
mtime as activity. Newer session headers can carry a `blobEncryptionKey`; an
unreadable body still leaves a resumable session, so `meta.json` supplies the
title in that case.

**The conversation inside `store.db`** (`openCursorStoreConversation`, checked
against 42 real stores on 2026-09-24). `blobs` is content-addressed (`id` is the
sha256 of `data`), so row order is not conversation order and a repeated
message is one blob listed twice. `meta['0']` (hex JSON) names
`latestRootBlobId`. That root blob is a protobuf whose repeated field 1 lists
the message blob ids oldest first, and each message blob is AI SDK JSON
`{ role, content }`. After a summarization the root starts over from the
summary: its field 13 names a summary blob whose field 1 lists the messages it
replaced and whose field 4 is the summary message the root carries, so the
full order is the replaced messages, then the root after that summary message.
Prompt counting (`readCursorStorePrompts`) and the store-only preview walk this
order. Cursor's `<system_reminder>` mode note and `<user_info>` environment
message are wrappers, never prompts.

Scope is decided from directory names, `meta.json`, and `.workspace-trusted`
before the recent-session cut, so out-of-project usage cannot crowd in-project
conversations out of the list. Artifacts whose cwd nothing on disk can confirm
(`empty-window`, buckets for deleted directories) are read only after every
confirmed in-project match.

Two ids are never sessions: SDK-origin `agent-<uuid>` runs, because
`cursor-agent` cannot resume them as meaningful CLI sessions and would start
empty; and `00000000-0000-4000-8000-000000000000`, which Cursor hands to
unrelated runs, so grouping its artifacts would fuse strangers into one session.
The `subagents/` tree beside a transcript holds nested runs and is not walked, and
`~/.cursor/acp-sessions/` is not a CLI session store.

Cursor has no fork support and its resume is cwd-scoped. A resume always names
the chat id; ADE never falls back to `cursor-agent --continue` (see
[Session tracking](#session-tracking)). Cursor edit mode must
not map to `--mode ask`; `ask` is read-only. In `cliLaunch.ts`, only plan mode
maps to `--mode plan`, full-auto maps to `--force`, and edit/default omit a mode
flag.

### Droid

Droid stores sessions under `<factoryConfigHome>/sessions/<escaped-cwd>/*.jsonl`
— `~/.factory` unless `FACTORY_HOME_OVERRIDE` is set, in which case that variable
replaces the HOME `.factory` is appended to rather than naming the directory
itself (`shared/providerConfigHomes.ts`). The first row must be `session_start`; ADE reads id, cwd, and title there. Current
Droid rows can omit a start timestamp, so creation time falls back to the first
timestamped message. `"New Session"` is a placeholder title and becomes null.
The `<id>.settings.json` sidecar holds model/mode, and `sessions-index.json` is
rewritten whole on every change — treat it as a hint, never as truth; ADE does
not read either.

The same id can appear under more than one escaped cwd, so discovery keeps one
candidate per id and reads the fullest copy. Because the directory name *is* the
slash-escaped cwd, out-of-project directories are ruled out before the
recent-session cut; a directory name that is not an escaped absolute path can
only be placed by the session's own `session_start` cwd, so those are read after
every directory scope already confirmed.

`droid --fork` is gated on an installed-CLI probe. Discovery can temporarily
show fork disabled while the probe is pending; import awaits the probe and
fails with a clear message if the installed binary lacks `--fork`. Resume is
cwd-locked.

### OpenCode

OpenCode discovery uses `opencode session list --pure --format json`; ADE does not
walk OpenCode's private storage. Resume and fork commands use OpenCode's
`--session`, `--continue`, and `--fork` flags.

A missing `opencode` binary throws rather than returning `[]`. An empty array is
exactly what "no sessions yet" looks like, so the old behavior showed a machine
without OpenCode installed an empty list and no reason for it. The service
propagates that error to a caller that asked only for OpenCode — which is every
call the desktop browser makes, since it scans one provider per request — and
logs `external_sessions.discovery_failed` for a mixed-provider scan instead of
failing the whole list. Note that binary resolution also searches HOME-derived
CLI directories, so a test that wants "OpenCode is not installed" has to
redirect `HOME` as well as `PATH`. Sessions are per-project by cwd,
so ADE resumes or forks in the source project cwd rather than transplanting
them into another lane cwd.

### Pi

Pi sessions live in the one native Pi session store that ADE chat and tracked
Pi terminals also use. CLI continue and CLI copy (`pi --fork <id>`) run in the
session's own folder. A chat continue seeds `piSessionId`.

### ACP providers (Qwen, Kimi, Grok, Copilot)

Each ACP CLI keeps sessions in its own store, and each discoverer reads that
store directly. Each one leaves out three kinds of session: sessions that ADE
launched (they belong to ADE's chat list), subagent sessions, and sessions with
no prompt.

| Provider | Store (env override) | ADE-launched and other exclusions |
|---|---|---|
| Qwen (verified 0.22.3) | `<runtime>/projects/<sanitized cwd>/chats/<id>.jsonl`, where `<runtime>` is `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen` (a leading `~` expands). The folder slug is not reversible, so the cwd comes from the records. | ADE's ACP chats never write an `attribution_snapshot` system row, and their first prompt opens with the `## ADE` guidance block. A session with both signs is left out. |
| Kimi (0.39.1, unverified) | `KIMI_CODE_HOME` (default `~/.kimi-code`): `sessions/wd_<slug>_<hash12>/<id>/` with `state.json` and `agents/main/wire.jsonl` (legacy `context.jsonl`), plus `workspaces.json` and `session_index.jsonl`. | Archived sessions, deleted sessions (index tombstones), and child sessions (`custom.child_session_kind: "child"` or `parent_session_id`). No file marker tells ADE's chats apart, so a first prompt that opens with `## ADE` is the test. |
| Grok (verified 1.0.40) | `$GROK_HOME/sessions/<percent-encoded cwd>/<id>/` (default `~/.grok`) with `summary.json` and `chat_history.jsonl`. The folder name is the cwd, so it is reversible. | `session_kind: "subagent"`, and any session with `updates.jsonl` (only an ACP client, that is ADE, writes it). The opening `<user_info>` workspace-context row is not a prompt. |
| Copilot (verified 1.0.88) | `$COPILOT_HOME/session-state/<uuid>/` (default `~/.copilot`) with `workspace.yaml` and `events.jsonl`. | `client_name` that starts with `ade` (`ade`, `ade-probe`, `ade-telemetry-probe`, …). Autopilot turns (`source: "autopilot"`) are not prompts. |

Kimi is unverified: no Kimi session existed on the machine where the code was
written. The discoverer, the converter, and the PTY watcher follow the shipped
`kimi` bundle. Every read is defensive, so an unexpected shape gives a thinner
row or no row, never a throw.

The ACP stores are mostly sessions the importer drops, so a fixed read budget
could be spent on rejects. `collectNewestSessions` reads candidates newest
first until enough sessions survive, up to a hard cap. An exact `sessionId`
lookup reads every candidate.

## Session tracking

Import depends on ADE knowing which provider session each tracked terminal
runs. These rules keep that knowledge correct.

**Pre-assigned ids.** A fresh tracked launch of Claude, Qwen, Grok, or Copilot
gets a new UUID on its command line, so the resume target exists from the first
byte. The flag is different per CLI (`preassignedSessionIdArgs` in
`cliLaunch.ts`, verified against the installed CLIs):

| CLI | Flag |
|---|---|
| Claude | `--session-id <uuid>` |
| Qwen | `--session-id <uuid>` |
| Grok | `-s <uuid>` |
| Copilot | `--session-id=<uuid>` |

The id names a NEW session, so `ptyService` never adds it to a launch that
continues an existing session (`--resume`, `--continue`, and the like). The one
exception is a fork. Claude Code accepts `--session-id` beside `--resume <id>`
only together with `--fork-session`, so a same-folder Claude CLI copy gets a
pre-assigned id too (`claudeArgsResumeExistingSession` returns false for a
fork). `buildClaudeForkLaunchCommand` builds the same
`--resume <source> --fork-session --session-id <new>` line directly; today only
its tests call it. The resume parser (`terminalSessionSignals.ts`) reads these
flags. A pre-assigned id wins over a resume selector. A fork without one mints
its own id, so the source id is NOT that launch's target. Kimi has no such
flag.

**Kimi.** `ptyService` finds the session a tracked Kimi launch created in
Kimi's real layout: `<kimiHome>/sessions/wd_<slug>_<sha256(cwd)[:12]>/<id>/`.
`kimiWorkDirKey` reproduces Kimi's bucket name for each spelling of the cwd,
and `workspaces.json` can add an alias bucket. An alias id must have Kimi's own
`wd_<slug>_<hash12>` shape, because it becomes a folder name: a hand-edited
entry cannot point the scan outside `sessions/`. `selectKimiLaunchSession` takes
a session born inside the launch window, whose recorded `workDir` (when it has
one) matches the cwd, and that no other terminal adopted. A session that proves its cwd wins. A
capture that cannot prove ownership is skipped: resuming the wrong conversation
is worse than no resume.

**Cursor.** Only a captured chat id resumes. `cursor-agent --continue` means
"the most recent chat", which can be another terminal's or an ADE chat. So the
resume builder never falls back to it, and the resume parser returns no target
for it. Pi follows the same rule.

**Handle ownership.** `inspectLiveProviderSessions` finds which process holds
each session file open. The holder is usually a descendant of the tracked PTY
(shell → node → CLI), never the PTY root itself. So `collectDescendantPidRoots`
walks the tracked PTY roots first and stamps each handle with
`trackedRootPid`. `handleIsOwnedByTrackedPty` decides ownership from that
field. Never compare `handle.pid` with the PTY pids. The importer uses it to
hide sessions that a live ADE terminal runs.

**Provider roots.** `providerSessionRoots` includes the ACP stores (Qwen
`projects`, Grok `sessions`, Copilot `session-state`, Kimi `sessions`), and the
CLI process scan matches the `qwen`, `grok`, `copilot`, and `kimi` binaries.
For these layouts the session id is a path segment, not a file name, because
their session folders hold fixed-name files (`chat_history.jsonl`,
`events.jsonl`, `state.json`, `wire.jsonl`). `sessionIdFromLayout` parses each
layout, and a file outside the known shape is not a session. A wrong id here
decides which session the importer hides as ADE-owned.

**OpenCode.** Only a `ses_<id>` path segment is a session id. `opencode` (the
`opencode.db` basename) never is.

## Testing constraints

This feature must exist on both sides of the connection: the client surface and
the host brain it talks to.

Desktop pre-merge testing can point the renderer at an isolated lane-built
brain by using an isolated `ADE_HOME` and runtime. That lets the desktop client
exercise the lane's `externalSessionsService`, ADE action domain, and PTY/chat
import paths before merge.

Mobile is harder. The iOS app pairs to a single sync host. Two sync-enabled
brains conflict on the shared port, mDNS publication, and tunnel routing, so
the phone cannot casually point at an isolated lane brain while the normal host
is still serving. Real mobile E2E requires the feature to be present on the
host the phone actually pairs to, usually because the branch is merged, or
because a deliberately isolated-port sync host is running and the phone is
paired to that host.

When mobile appears to "not have" the feature, check the host first. An updated
iOS client cannot import sessions if the paired brain does not expose
`work.listExternalSessions` and `work.importExternalSession`. Without
`work.getExternalSessionDetail` (an older brain) import still works, and the
preview falls back to the list's sampled messages.

## Live verification (2026-09-23)

Six real imports ran in a `--no-sync` dev app, on throwaway sessions made with
Claude Haiku and Codex GPT-6 Luna (low thinking), each checked in the software:

| Path | Check |
|---|---|
| Claude → ADE chat → Continue | Same Claude session id; the source file grew; the chat answered a question about its earlier turn; model stayed Haiku. |
| Codex → ADE chat → Continue (twice) | Same thread id; the rollout grew; the chat answered from memory; Luna with low thinking kept. |
| Claude → CLI → Continue | Tracked terminal runs `claude --model … --resume <id>` in the lane root. |
| Claude → ADE chat → Copy into another lane | New Claude session id, chat in the target lane, `importedFrom.mode: fork`, context carried. |
| Codex → CLI → Copy | `codex fork`; the new thread id was captured into the terminal's resume metadata. |

Bugs this found and fixed: a continue switched the session to the default model
and thinking level; the import notice sorted below the history; a deleted chat
left a Claude pointer that hid its session for good; a copy absorbed its
original through shared history (lineage folding), so the original vanished;
terminals inherited a parent Claude session's markers
(`CLAUDE_CODE_CHILD_SESSION`) and stopped saving transcripts
(`shared/parentAgentEnv.ts`).

Copilot 1.0.88 (2026-09-24), on hand-run sessions in the lane root:

| Path | Check |
|---|---|
| Copilot → CLI → Continue | Tracked terminal runs `copilot --resume=<id>`; the resumed CLI answered a question about its earlier turn. |
| Copilot → ADE chat → Copy | Replay into a new Copilot chat; the chat answered from the copied history. |
| Copilot → ADE chat → Continue | `acpSessionId` seeded; the same `events.jsonl` grew with the new turn; no replayed history in the chat. |

Bugs this found and fixed: every tracked Copilot launch passed
`--no-alt-screen`, which Copilot 1.0.88 rejects (exit 1); a session on "auto"
recorded the router's model, which `copilot --model` rejects; a resumed or
imported CLI of an output-titled provider lost its title to one made from
startup output (a banner or the folder-trust prompt).

## Known follow-ups / open items

- No feature flag gates external-session import. If the service is constructed
  and the UI is present, the feature is live.
- There are no TODO/FIXME markers in the current external-session service,
  chat importer, desktop import UI, iOS import screen, sync command path, or
  lane-scoped ADE action path.
- The Droid fork probe has a first-list conservative state: until `droid
  --help` resolves, Droid summaries report `fork: false` and
  `forkIntoDifferentCwd: false`. Refreshing after the probe resolves shows the
  actual capability. Fork import itself awaits the probe.
- Keep the shared DTOs, `externalSessionPolicy.ts`, its Swift port in
  `WorkExternalSessionAffordances.swift`, the iOS models, and the sync command
  payloads in lockstep. A server-only change will break mobile decoding or
  hide buttons; a UI-only change will show actions the runtime rejects (the
  host guard refuses them).
- ACP chat continue is enabled for Copilot only. `PROVIDER_IMPORT_RULES` keeps
  Qwen, Kimi, and Grok at `none` for chat continue (and their `importToChat` is
  false) until a live run proves that the ACP runtime can load a session the
  CLI created, through `session/resume` or `session/load`. To enable one, add
  it to `NATIVE_CHAT_CONTINUE_PROVIDERS`, seed `acpSessionId` in
  `importNativeContinueExternalChatSession`, and change the rule in both
  policy tables (TypeScript and Swift).
- Kimi is unverified end to end. The discoverer, the event converter, and the
  PTY watcher follow the shipped `kimi` 0.39.1 bundle, not real session files.
  Check them against a real Kimi session.
- Qwen tool-call conversion is verified only for text turns. The tool shapes
  follow the Gemini CLI chat-recording format.
- The iOS preview and policy port build and pass `ADETests` (2,167 tests,
  2026-09-23). The preview has not run against a live sync host, because the
  test brain runs with `--no-sync`.
- Keep `agentChatService.ts`'s Claude transplant dependency static. Dynamic
  imports can pass desktop dev runs and still fail in the packaged/headless
  brain bundle.

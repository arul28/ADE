# External Session Import

AI coding CLIs run outside ADE keep their own sessions on disk or list them
natively. External-session import lets the user browse those sessions from the
Work surface and continue one inside ADE.

ADE imports sessions from 12 providers:

- Claude Code, Codex, Cursor `cursor-agent`, Factory Droid, OpenCode, Pi, and
  Muse Code.
- The CLI stores of Qwen Code, Kimi Code, Grok, GitHub Copilot CLI, and
  Antigravity's `agy`. Copilot's chat runtime is an SDK provider; its CLI
  history imports the same way
  ([Copilot SDK provider](../chat/copilot-sdk-provider.md)).

Every import has two choices:

- **The surface**: an ADE chat, or a tracked CLI terminal.
- **The mode**: "Continue" uses the original provider session (do not keep it
  open in another terminal too). "Copy" starts a new session from the history
  and leaves the original as it is.

One policy table decides which of the four actions a session gets and in which
lanes ([Import policy](#import-policy)). Every provider can open as an ADE chat
copy.

Sessions that ADE creates or imports stay resumable from the provider CLI,
because ADE records (and for fresh launches chooses) the provider ids:

- Tracked CLI sessions keep `TerminalResumeMetadata`.
- Claude chat imports seed `sdkSessionId` and mirror a Claude session pointer;
  Codex chat imports bind the thread id; Droid, OpenCode, Pi and Copilot chat
  continues seed the provider pointer the chat restores from.
- Fresh tracked launches of Claude, Qwen, Grok and Copilot get a pre-assigned
  session id ([Session tracking](#session-tracking)); the other CLIs record the
  target when ADE first learns it.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/externalSessions/externalSessionsService.ts` | Service entry point (`list`, `importExternalSession`, `getDetail`). Runs provider discovery, stamps each row's capabilities, `home` lane, and `sizeBytes`, filters project/all scope, detects already-imported sessions, validates import ids, enforces optional lane cwd scope, refuses any import the policy does not offer (`importRejectionReason`), builds CLI resume/fork commands, delegates chat import, and creates tracked PTYs. `getDetail` wraps `loadExternalSessionDetail` with the service's own `homeDir`/`env`, so every detail caller (IPC, the watch, the ADE action, the sync command) reads the same provider stores as `list`. |
| `apps/desktop/src/main/services/externalSessions/discoverers.ts` | `EXTERNAL_SESSION_DISCOVERERS`: the one provider → discoverer table. Listing, import, and the exact-id detail lookup all use it. |
| `apps/desktop/src/main/services/externalSessions/sessionIds.ts` | Session id checks. `isWellFormedExternalSessionId` (strict UUID for Claude/Codex, `^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$` for the rest) and `validateExternalSessionId` (the same check plus the Cursor `agent-` refusal, throwing). Discoverers join the id into a store path, so an id with a separator must never reach them. |
| `apps/desktop/src/shared/externalSessionPolicy.ts` | The one import policy. `PROVIDER_IMPORT_RULES` (the per-provider table), `effectiveImportRules` (the table narrowed by host capabilities), `planImport` (what the action bar shows), `importRejectionReason` (the host guard), and `importProviderLabel` (the provider label every desktop surface uses). The renderer and the host import all use it. iOS mirrors it in Swift. |
| `apps/desktop/src/main/services/externalSessions/sessionHome.ts` | `createSessionHomeResolver`: maps a provider cwd to the lane that owns it (`ExternalSessionHome`). The deepest lane root wins. A folder under `.ade/worktrees/` that no live lane owns is a removed lane, not the primary lane. |
| `apps/desktop/src/main/services/externalSessions/discoveryUtils.ts` | Shared discovery helpers: safe stat/read, top-N mtime sorting, JSONL prefix/suffix scans, one record classifier shared by prompt extraction and the recent-`messages` sampler, provider-wrapper cleanup, the preview-only markup-density gate, word-boundary clipping, title cleanup, cwd slug helpers, shell quoting, and path-inside checks. |
| `apps/desktop/src/main/services/externalSessions/adeConfigHomes.ts` | The config homes ADE owns under `<ADE_HOME>/provider-homes/` that can hold a CLI's sessions: `providerConfigHomeDirs` (Claude/Codex accounts, presets, keys and routes) and `adeHarnessConfigHomes` (Droid/Grok/Kimi/Pi presets and routes, and Droid keys), each tagged with the launch identity that writes there. Also `ADE_HARNESS_HOME_ENV_KEY` (the variable that points each CLI at its home) and `uniqueByPath`. See [Where the other CLIs' sessions live](#where-the-other-clis-sessions-live). |
| `apps/desktop/src/main/services/externalSessions/discoverClaude.ts` | Discovers resumable Claude CLI JSONL transcripts under **every** Claude config home: `CLAUDE_CONFIG_DIR` or `~/.claude`, each account home under `<ADE_HOME>/provider-homes/claude/<instance>`, and the per-preset / per-credential homes ADE launches with. Reads `ai-title`/custom titles, excludes SDK-origin transcripts, collapses continuation chains to their leaf, and keeps the config home on the record so an import can resume under the account that owns the transcript. |
| `apps/desktop/src/main/services/externalSessions/discoverCodex.ts` | Discovers interactive Codex threads from **every** Codex config home — `CODEX_HOME` / `~/.codex`, each `<ADE_HOME>/provider-homes/codex/<instance>`, and the preset / API-key homes ADE launches with — reading each home's `state_5.sqlite`: top-level threads only, fork continuations collapsed, enriched from the rollout JSONL under `sessions/YYYY/MM/DD/` and `session_index.jsonl`. Falls back to scanning rollout files when a thread store is unusable, and keeps the config home on the record for import. |
| `apps/desktop/src/main/services/externalSessions/discoverCursor.ts` | Groups every Cursor artifact — `~/.cursor/chats/<workspace-md5>/<id>/store.db`, its `meta.json`, and `~/.cursor/projects/<slug>/agent-transcripts/` (including `empty-window`) — by the bare conversation uuid, keeps the fullest copy of each, resolves cwd from `meta.json` before the md5/slug reverse-mappings, and excludes SDK `agent-<uuid>` sessions. Also owns `openCursorStoreConversation`, the reader for the conversation inside a `store.db` (see [Cursor](#cursor)). |
| `apps/desktop/src/main/services/externalSessions/discoverDroid.ts` | Discovers Factory Droid JSONL sessions under `<factoryConfigHome>/sessions/<escaped-cwd>/` (default `~/.factory`) and under `<home>/.factory/sessions/` of each preset, route and API-key home ADE runs Droid on, one record per session id, using the `session_start` row for id/cwd/title. A record from an ADE home keeps that home (`configHome`). |
| `apps/desktop/src/main/services/externalSessions/discoverOpenCode.ts`, `openCodeStore.ts` | Discovers OpenCode sessions by reading the user's own OpenCode SQLite store and, for the import list, ADE's managed store directly, read-only (v1 `session`/`message`/`part` or v2 `session_v2`/`session_message`), and drops ADE's own background-task titles. The managed store is what every ADE-launched OpenCode terminal and chat uses. Never shells out to the CLI and never starts a 2.0 server on either store. |
| `apps/desktop/src/main/services/externalSessions/discoverPi.ts` | Discovers Pi's native JSONL sessions in the default Pi session store and in the session store of each preset and route home ADE runs Pi on (`PI_CODING_AGENT_DIR`). Drops ADE's own Pi chats: a session whose `.ade-owner` marker names owner `sdk` (an ADE chat; the marker outlives the chat), or one that opens with ADE's `## ADE` guidance. A CLI session from an ADE terminal (owner `cli`) still lists. `defaultHomeOnly` limits it to the default store, for the tracked-terminal id lookup in `ptyService`. |
| `apps/desktop/src/main/services/externalSessions/discoverQwen.ts`, `discoverKimi.ts`, `discoverGrok.ts`, `discoverCopilot.ts`, `discoverAntigravity.ts` | The ACP-provider discoverers. Each reads its CLI's own on-disk store, drops ADE-launched and subagent sessions, and drops sessions with no prompt. Kimi and Grok also read the store in each preset and route home ADE runs them on (`KIMI_CODE_HOME`, `GROK_HOME`). See [CLI stores](#cli-stores-qwen-kimi-grok-copilot-antigravity). |
| `apps/desktop/src/main/services/externalSessions/discoverAcpShared.ts` | Shared plumbing for the ACP discoverers. Each discoverer maps its records to one neutral `{ type, timestamp, message: { role, content } }` form, and the shared helpers compute the preview, the sampled `messages`, and the prompt count from that form. Also: bounded head + tail reads, the `## ADE` guidance test, `~` expansion for env overrides, and a newest-first read loop that stops when enough sessions survive. |
| `apps/desktop/src/main/services/externalSessions/events/` | The per-provider converters from a provider store to ADE chat events (`AgentChatEventEnvelope[]`), plus byte-window paging. `loadExternalSessionEvents` (`index.ts`) serves both the preview (`purpose: "preview"`) and the chat import (`purpose: "import"`). `jsonlSourceFor` names the conversation file a converter reads; `records.ts` is the exact-id record lookup (it returns null for an ill-formed id). A store-only Cursor chat pages through `loadCursorStorePage` (`cursor.ts`). See [Conversation events](#conversation-events). |
| `apps/desktop/src/main/services/externalSessions/externalSessionDetail.ts` | `loadExternalSessionDetail`: one session's detail for a preview. Returns the text tail in `messages` and a page of `events` with `hasOlder`/`olderCursor`. Also owns the local file watch (`startExternalSessionDetailWatch`), which pushes a fresh newest page when the source file changes and loads through the `loadDetail` callback it is given (the service's `getDetail`). Callers go through `externalSessionsService.getDetail`, not this function directly. |
| `apps/desktop/src/main/services/externalSessions/providerSessionHandles.ts` | Maps a provider session id back to the files that hold it, and finds which live process holds each file. Claude and Codex roots come from `providerConfigHomeDirs` (every config home ADE runs them under, classified by the CLI's own files so a Claude preset home is never scanned as Codex); Droid still uses `shared/providerConfigHomes.ts` so `FACTORY_HOME_OVERRIDE` is honoured with its own shape, and Droid, Pi, Grok and Kimi add the roots of their ADE preset and route homes (`adeHarnessConfigHomes`). The ACP roots come from the same module (`QWEN_HOME`, `GROK_HOME`, `COPILOT_HOME`, `KIMI_CODE_HOME`). The live-process scan (`isProviderCliCommandLine`) matches native CLIs by name, including ADE's absolute pinned paths, and ADE's Node-run pins (Qwen `lib/cli-entry.js`, Pi `dist/cli.js`, Cursor `index.js`) by their tools-cache package directory plus script path, so a terminal still on the previous pin matches too. See [Session tracking](#session-tracking). |
| `apps/desktop/src/main/services/externalSessions/liveChatProviderRefs.ts` | `providerPointersFromChatRecord`: every provider pointer that one ADE chat holds (`importedFrom` for a continue, the provider session ids including Copilot's `copilotSdkSessionId`, and `acpSessionId` for the ACP providers and older Copilot chats). `chatImportedRefsProvider(chatService)` builds the chat refs source from it over the non-archived chats. Both runtime hosts wire in that one function, so a session that ADE itself runs never lists as importable on either. |
| `apps/desktop/src/main/services/externalSessions/importedSessionStore.ts` | Machine-local durable log of every import (`<ADE_HOME>/external-sessions/imported.json`), the only imported-marking source that survives deleting the ADE session and the only one that knows a fork's new provider id. |
| `apps/desktop/src/main/services/externalSessions/claudeLiveSessions.ts` | Reads Claude's own live-session registry (`<config-home>/sessions/<pid>.json`) from every Claude config home ADE runs the CLI under and returns the session ids whose pid is still alive, for `possiblyActive`. |
| `apps/desktop/src/main/services/externalSessions/claudeSessionTransplant.ts` | Non-destructive Claude transcript transplant. For forks it copies JSONL rows, rekeys `sessionId`, hard-links without clobbering, and leaves the source untouched; for moves it can link/unlink when requested by other callers. |
| `apps/desktop/src/shared/cliLaunch.ts` | Canonical CLI launch/resume/fork command builders. External import uses `buildTrackedCliResumeCommand`, `withCodexNoAltScreen`, provider permission/model mappings, and shell quoting from here. Also holds the pre-assigned session id helpers (`preassignedSessionIdArgs`, `withPreassignedSessionIdInCommandLine`) and `buildClaudeForkLaunchCommand`. |
| `apps/desktop/src/shared/importedTurnBoundaries.ts` | `withImportedTurnBoundaries`: adds a `done` event after each imported turn that did tool work. The preview and `appendImportedChatEvents` both apply it. See [Conversation events](#conversation-events). |
| `apps/desktop/src/shared/types/externalSessions.ts` | Canonical DTOs shared by desktop IPC, ADE actions, sync remote commands, and iOS. Also `EXTERNAL_SESSION_PROVIDERS` (display order), `EXTERNAL_SESSION_PROVIDER_LABELS` (the one provider list and label map), and `EXTERNAL_SESSION_PROVIDER_CAPABILITIES` (the per-provider base capabilities, which the host narrows per session and the browser mock shows as they are). |
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
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionBrowser.tsx` | The desktop Import session dialog: a fixed-size split view (`LaneDialogShell`, up to 1180 × 860 px). Owns the scan, the filters, the selection, the target lane, the surface choice, and the import run. Asks for 200 rows per provider to match the service's project-scope discovery window. A provider that fails its scan leaves a muted per-provider notice ("Droid CLI not found…") instead of an unexplained empty list, and only a total scan failure becomes the blocking error state. See [Desktop dialog](#desktop-dialog). |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportTopBar.tsx` | The dialog's top bar: provider chips, the lane filter (`LaneCombobox` with per-lane counts and "Other folders") and the computer (source) picker side by side, search, and refresh. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionList.tsx` | The left session list, grouped by date ("Today", "Yesterday", weekday, date). Keyboard moves keep the selected row in view and move roving focus. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionPreview.tsx` | The right pane: a who/where header, then the conversation rendered read-only by `AgentChatMessageList` in its own scroll box that opens at the bottom. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportActionBar.tsx` | The action bar pinned under the preview. Renders `planImport` and nothing else: the surface switch, the lane pill or locked lane pill, the model picker for a chat copy, the primary and secondary buttons, and one note line. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportSessionParts.tsx` | Small shared parts, for example the lane dot + lane name label (a folder mark for a session outside every lane). |
| `apps/desktop/src/renderer/components/terminals/importSessions/importBrowserModel.ts` | Pure dialog rules with no React: `sessionPlace` (the lane a row names), lane-filter keys and counts, search, `defaultForkModel`, the per-provider surface memory in `localStorage` (`ade.importSession.surface.<provider>`), and `spliceNewestPage` for live preview updates. |
| `apps/desktop/src/renderer/components/terminals/importSessions/useExternalSessionDetail.ts` | Loads the preview transcript: the newest page after a short settle delay, older pages on scroll-back, and live updates through `watchDetail` for sessions on this computer. A live update replaces the newest page and keeps the pages the user already loaded. |
| `apps/desktop/src/renderer/components/terminals/importSessions/ImportFloatingBadge.tsx` | The "Import your chats from outside ADE" hint on the Work draft surface, plus its machine-local per-project dismissal (`readImportBadgeDismissed`). It is the last row of the draft column, below the activity module, and is `shrink-0` because the wordmark above it is the only row meant to absorb overflow when the column is height-capped. Provider marks stay horizontal and lose trailing logos as the chat column narrows while the full label remains visible. It returns `null` — not an empty wrapper — once dismissed or when there is no project root, so a retired hint spends none of the column's row gap. |
| `apps/desktop/src/shared/externalSessionAffordances.ts`, `apps/desktop/src/renderer/components/terminals/importSessions/affordances.ts` | Row display helpers used by the desktop dialog: `shortenExternalSessionCwd` (and its renderer binding `shortenCwd`) and `formatExternalSessionSize` ("40 MB", "2.4 MB"; empty for a missing or zero size). The import actions live in `externalSessionPolicy.ts`. |
| `apps/desktop/src/renderer/components/terminals/importSessions/sessionPresentation.ts` | Pure desktop heading/time/anchor helpers. Provider titles win, then the opening prompt (`preview`), then cwd + relative time. `sessionAnchors` returns the row's "started"/"latest" pair and drops whichever one the heading is already showing, so a row never prints the same sentence twice. Also the date groups, compact row times ("13m"), and prompt counts. |
| `apps/desktop/src/renderer/components/terminals/importSessions/contract.ts` | Renderer bridge and types for external sessions (`readImportedFrom`, `PROVIDER_TOOL_TYPE`). The provider list and labels are not here: surfaces use `EXTERNAL_SESSION_PROVIDERS` and `importProviderLabel` directly. |
| `apps/desktop/src/renderer/components/terminals/LaneCombobox.tsx` | The shared lane picker. Options can carry a trailing `detail` (the import dialog's session counts) and an `icon` (the "Other folders" pseudo-option); `allDetail` puts a total on the "All lanes" row. |
| `apps/desktop/src/renderer/components/terminals/useWorkSessions.ts` | Adopts import results into the Work surface and focuses existing imported sessions without re-importing. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`, `apps/desktop/src/renderer/components/terminals/WorkViewArea.tsx`, `apps/desktop/src/renderer/components/terminals/TerminalsPage.tsx` | Wires the import browser into the Work draft/new-session surface and routes imported or already-imported sessions to the selected Work tab. |
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

`externalSessionsService.list` runs one discoverer per requested provider,
catches each provider's failure, merges rows, filters to the project unless
`scope: "all"`, and returns `ExternalSessionSummary[]` newest `updatedAt`
first.

- File-backed providers stat first, sort by mtime, and read a bounded recent
  window. Claude keeps scanning past filtered SDK transcripts until it fills
  the limit. Codex reads its thread store instead (below).
- JSONL reads are bounded by `JSONL_SCAN_BYTE_LIMIT` and
  `JSONL_SCAN_LINE_LIMIT`. Prompt counts are computed only for files under
  `MESSAGE_COUNT_MAX_BYTES`. Metadata, assistant and tool rows,
  local-command wrappers and duplicate Codex records do not count.
- OpenCode reads its user-message count from its own SQL query
  (`userMessageCount`) and shows no preview text (no per-session row reads).
- The ACP discoverers read a history file whole up to 768 KB (exact count);
  a larger file gets a head and tail and a null count.

### Codex thread store

ADE lists Codex threads from `CODEX_HOME/state_5.sqlite`, not the
`sessions/YYYY/MM/DD` rollout tree. The database knows spawn edges; many
subagent rollouts carry no parent id in their own `session_meta`, so the files
alone list subagent runs as conversations.

- Discovery opens the database read-only and selects non-archived threads that
  are not a `thread_spawn_edges` child, newest first. `id`, `cwd`, times,
  title and preview come from `threads`. The thread id is the identity, so a
  `.jsonl.zst` and a plain rollout cannot make two rows. A dangling
  `rollout_path` (upstream `openai/codex#21196`) still lists.
- Line 1 of the rollout (only for threads that pass the cheap filters) gives
  the `originator` (ADE's own Codex sessions are excluded) and
  `forked_from_id`. Only line 1, because a fork replays its parent's
  `session_meta` further down.
- A parent with no activity after a fork point is hidden behind its fork. A
  parent that kept going stays listed. Only a fork this surface would list can
  hide a parent.
- Classification fails **open**: an object-shaped `source` (a spawned
  subagent) and the `exec` and `vscode` entrypoints are dropped; an unknown
  `source` string is listed and logged
  (`external_sessions.codex_unknown_source`).
- A missing, unreadable or differently shaped database logs
  `external_sessions.codex_state_db_unavailable` or
  `external_sessions.codex_state_db_query_failed` and falls back to the bounded
  rollout scan, which cannot see spawn edges.
- An empty result falls back only when one extra `SELECT 1 FROM threads LIMIT
  1` finds the table empty (a fresh or truncated store). Zero rows with
  threads present is a real answer.

Titles and previews stay separate:

- `title` is a provider-persisted title, or `null`. Never the first user
  message.
- `preview` is the **opening prompt**: the first real human message after ADE
  guidance and transport wrappers are removed. Claude
  `<local-command-caveat>`, `<command-name>`, `<local-command-stdout>` and
  Codex environment/AGENTS payloads are never previews. There is no separate
  first-prompt field.
- `messages` is a sample of recent user/assistant exchanges, oldest first, at
  most `EXTERNAL_SESSION_MESSAGES_MAX_COUNT` (8), each clipped to
  `EXTERNAL_SESSION_MESSAGE_MAX_LENGTH` (320). Claude takes it from its
  existing scan tail; Codex reads a rollout suffix (64 KiB browsing, 128 KiB
  for an exact `sessionId`) and skips `.jsonl.zst`; the ACP discoverers use
  their head and tail. Cursor, Droid and OpenCode leave it absent rather than
  read more (the preview reads the full conversation; see
  [Conversation events](#conversation-events)).
- `messages` is **optional and nullable** and must stay so. iOS decodes every
  field with `decodeIfPresent`, and a failed decode drops the whole summary
  through `try?`. `messages` also decodes through a lossy array. Add optional
  keys; never re-type one.

Preview rules:

- **Wrapper rejection is not an allow-list.** Besides the named noise tags,
  preview selection rejects mostly-markup text
  (`EXTERNAL_SESSION_MARKUP_TEXT_MIN_RATIO`), and wrapper stripping handles a
  tag whose closing half fell outside the window. The density gate is
  **preview-only**: never in `cleanExternalSessionUserText`, which also feeds
  the imported transcript (a pasted JSX snippet or "ok" is a real message),
  and never in counting.
- **`preview` comes only from prefix records.** Claude's scan is prefix ++
  tail; only `messages` come from the tail.
- Clipping snaps to a word boundary and never ends inside a tag.

Desktop and iOS rows use the title, then the opening prompt, then a path and
time heading. Placeholder titles ("New Session") become null. An anchor that
repeats the heading is hidden.

The service also stamps:

- `alreadyImported` and `importedSessionRef` ([Import marking](#import-marking)).
- `possiblyActive`. For Claude: the CLI's live-session registry
  (`<config-home>/sessions/<pid>.json`, every Claude config home) with a live
  `pid` (entries outlive their process, so liveness is checked). Otherwise,
  and for Claude with no registry folder: the backing file changed in the last
  two minutes. Pid reuse after a reboot can cost one wrong badge.
- `cwdMatchesRequestedLane`, when the lane cwd is known.
- `home` and `sizeBytes` ([Lane attribution](#lane-attribution)).

A session a live tracked ADE PTY owns is not listed
([Session tracking](#session-tracking)).

### Where Claude sessions live

Claude Code writes a transcript under the config home its process ran with.
ADE does not run CLIs on the provider default: an account gets
`CLAUDE_CONFIG_DIR=<ADE_HOME>/provider-homes/claude/<instance>`, and a harness
preset or a stored API key gets its own home. So a session from an ADE
terminal is not in `~/.claude`.

- Discovery scans every home (`claudeConfigHomeDirs` / `codexConfigHomeDirs`),
  and a record keeps its home (`configHome`, main process only).
- Import runs `--resume <id>` with that home in the env and records the
  account or preset in `resumeMetadata.launch`, so a later resume stays on the
  same account.
- **Choosing an account.** With more than one account on the source machine,
  the action bar shows an account picker for Claude and Codex, starting on the
  owner (`accountId`). Another account copies the session into that account's
  home first (`moveProviderThread`, source kept) and runs the CLI there; a
  chat import creates the chat on that account and the importer moves the
  transcript. A removed account id is refused, never defaulted.
- Route homes count: `ade new chat --mode cli --via <source>` runs Claude or
  Codex on `<ADE_HOME>/provider-homes/route/r<hash>`, listed when the CLI's
  own files are there.

### Where the other CLIs' sessions live

A harness preset or an ad-hoc route can move four more CLIs into an ADE home,
so discovery also reads these (`adeHarnessConfigHomes` in `adeConfigHomes.ts`):

| Provider | Variable ADE sets | What the variable names | Sessions inside |
|---|---|---|---|
| Droid | `FACTORY_HOME_OVERRIDE` | a HOME-like root; Droid adds `.factory` | `<home>/.factory/sessions/<escaped cwd>/` |
| Grok | `GROK_HOME` | the config folder | `<home>/sessions/<percent-encoded cwd>/<id>/` |
| Kimi | `KIMI_CODE_HOME` | the config folder | `<home>/sessions/wd_<slug>_<hash>/<id>/` |
| Pi | `PI_CODING_AGENT_DIR` | the agent folder | wherever Pi's own rules put sessions inside it (`piSessionRootForEnvironment`) |

The homes, under `<ADE_HOME>/provider-homes/`:

- `preset/<id>`: a saved preset (lower-case id, mapped back from the machine's
  preset list; a folder for a gone preset or another harness is skipped).
- `route/r<hash>`: an ad-hoc `--via` route (the first 16 hex of the SHA-256 of
  the route id, `routeConfigHomeId`), listed only when the CLI's own files are
  in it.
- `credential/droid/<id>`: a stored Droid API key. Grok, Kimi and Pi take a
  key in env only, so their sessions stay in the default store.

ADE never scans `<provider>/default` (the embedded-runtime chat sign-in) and
never walks `provider-homes` as a whole.

The other providers need no extra home: Copilot and Qwen presets set env only;
an OpenCode preset moves only `OPENCODE_CONFIG`; Cursor drops presets
(`CLI_PRESET_GATED_HARNESSES`); Muse and Antigravity are not preset harnesses.

**Resuming in the same home.** A record keeps its home (`configHome` with
`presetId`, `credentialId` or `routeHomeId`). Import puts the home's variable
and the preset's env (stored key, proxy endpoint) in the terminal env.

- A route home names only a hash, so import finds the route id from an ADE
  terminal (archived too) whose resume metadata names a route with that hash.
- A gone preset, key or route logs `external_sessions.import_preset_unresolved`
  or `external_sessions.import_route_unresolved` and still resumes in the
  home, on the CLI's own sign-in; an unnamed route records the home itself
  (`launch.routeHomeId`, `routeHomeLaunchEnv`).
- Key and preset folders are the lower-case id; import names the stored key
  or preset again from the folder before it resolves the env.
- A route launch marks its home in use (`touchRouteConfigHome`) before the
  30-day prune of idle route homes.
- Import and terminal resumes call `prepareHarnessLaunch` first, so a route
  through ADE's proxy resolves after a brain restart.

These homes have no account picker (`accountId` is Claude and Codex only). A
session in one offers CLI continue and chat copy, not chat continue
(`importToChat: false`), because a chat continue would seed a pointer into the
chat's own default home.

### Lane attribution

Every summary carries `home?: ExternalSessionHome | null`, resolved from the
session cwd against the live lanes (`sessionHome.ts`), read again on every
`list()`.

| `home.kind` | Meaning |
|---|---|
| `lane` | The session folder is a live lane's worktree root or a folder inside it. `laneId`, `laneName`, `branchRef`, `color`, and `laneType` name the lane. `atLaneRoot` is true only when the folder is exactly the worktree root. |
| `removed-lane` | The folder is under `.ade/worktrees/`, but no live lane owns it. |
| `outside` | Any other folder. It is never a lane. |

- The primary lane's root contains every other lane, so the deepest root wins
  and a primary match through `.ade/worktrees/` is `removed-lane`.
- For an import, the target lane is added to the list when missing, so the
  guard does not treat its sessions as foreign.
- `sizeBytes` is the store entry's size from one stat (all but OpenCode); the
  preview header shows it.

### Import marking

Four sources feed one `provider:id` → ref map. Chat refs outrank CLI refs,
which outrank a bare "imported, nothing to open", so the UI offers one
"Open in ADE" action.

- **The durable import log**, `<ADE_HOME>/external-sessions/imported.json`
  (`importedSessionStore.ts`). Each import appends one record: provider,
  external id, the provider id ADE runs, chat/cli, continue/fork, ADE session
  id and time. It is a machine-local JSON file (atomic write, `.lkg`
  fallback), not a CRR table: provider stores are machine-local too.
  - The desktop app and the headless brain can share one ADE home. So each
    append takes a lock file for one read-modify-write and re-reads inside it.
  - `record` is synchronous, so the wait blocks the main process:
    `LOCK_WAIT_MS` is 200 ms. If ADE cannot get the lock, it writes anyway; a
    lost race drops at most one record, never a finished import. A lock older
    than 5 s counts as abandoned.
- ADE `terminal_sessions` resume metadata (`provider`/`targetId` and
  `importedFrom`).
- Claude session pointers from `sessionService.listClaudeSessionPointers`
  (ceiling `CLAUDE_SESSION_POINTER_MAX_LIMIT`, 5000; default page 200).
- The chat refs provider. Both runtime hosts (`main.ts` and the headless
  `bootstrap.ts`) build it with `providerPointersFromChatRecord` over the
  non-archived chats, so it holds every provider pointer a live chat has. A
  session that ADE runs as a chat never lists as importable on either host.

The last three come from live rows: they lose the badge when the ADE session is
deleted, and they never know the new provider id of a fork (a Codex
`thread/fork` thread or a transplanted Claude transcript). The durable log
records both ids.

| State | Fields | Dialog |
|---|---|---|
| In ADE now | `alreadyImported: true`, `importedSessionRef` set | "Open in ADE" replaces the plan. |
| Imported before | `alreadyImported: false`, `importedBefore: true` | Listed as importable, with a hint. |
| Never imported | both false | Listed as importable. |

"Imported before" covers a gone ADE session and a **copy**. A copy leaves the
original untouched, so the original stays importable:

- The durable log records a copy's original with no ref (`mode: "fork"`). A
  replay copy (all but a Claude or Codex native fork) has no new provider id
  until its first turn, so only the original is recorded.
- Resume metadata with `importedFrom.mode: "fork"` gives the original no ref.
- `providerPointersFromChatRecord` skips `importedFrom` when its `mode` is
  `"fork"` (`"continue" | "fork"`; a chat with no mode counts as a continue).

**Lineage.** Discovery collapses Claude continuation chains to their leaf and
hides a Codex parent behind its fork, so the imported id is often not the
listed id. Collapsing providers set `lineageIds` (the ids the record
supersedes), and marking matches `id ∪ lineageIds`. The field is
discovery-internal, not part of `ExternalSessionSummary`.

**ADE-created artifacts are not new sessions.** A cross-cwd Claude fork writes
a transplanted copy under a fresh uuid, and a Codex chat fork mints a new
thread. Rows whose ids are **all** recorded fork targets are dropped. "All",
not "any": when discovery collapses the original into the copy, that row is
the only place the original appears, so it stays and reads as imported. An
exact `sessionId` lookup skips the filter.

### Import policy

`apps/desktop/src/shared/externalSessionPolicy.ts` is the one source of truth
for which import actions exist. The desktop renderer and the host guard call
it; iOS has a Swift port (`WorkExternalSessionAffordances.swift`, tests in
`ADETests`).

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
| Antigravity | `none` | `any` | `home` | `none` |

- **Chat continue.** Claude binds the original session, Codex the original
  thread. Droid, OpenCode, Pi and Copilot seed the provider pointer
  ([Chat target](#chat-target)).
- **Chat copy.** Claude and Codex make a native fork when the chosen model is
  of the same family. Every other case replays the full transcript into the
  chosen model.
- **CLI continue.** Resumes the original session in a tracked terminal.
- **CLI copy.** A native fork in a tracked terminal: Claude `--fork-session`
  or a transplant, Codex `fork`, Droid `--fork`, OpenCode `--fork`, Pi
  `--fork`, Qwen and Grok `--fork-session`.

Chat continue is `none` for Cursor, Qwen, Kimi, Grok and Antigravity. No live
run has proven that ACP `session/resume` or `session/load` opens a session the
CLI created, and the Cursor SDK has no path to a `cursor-agent` chat. Copilot
is proven: a continue through the Copilot SDK keeps the session id. To enable
one, add it to `NATIVE_CHAT_CONTINUE_PROVIDERS`, seed its pointer in
`importNativeContinueExternalChatSession`, and change both policy tables.

#### Capabilities only narrow the table

The host sends `ExternalSessionCapabilities` on every row. Base values are
`EXTERNAL_SESSION_PROVIDER_CAPABILITIES` (`shared/types/externalSessions.ts`).
`effectiveImportRules` narrows the table with them and never widens it.

| Capability | Meaning | Effect on the rules |
|---|---|---|
| `resumeInPlace` | The provider can continue the original session in the folder where it was created. | CLI continue is at most `home`. |
| `resumeInDifferentCwd` | The provider can continue the original session in the target lane folder. | CLI continue can be `any`. |
| `fork` | The provider can make a copy without changing the original. | CLI copy is at most `home`. |
| `forkIntoDifferentCwd` | The provider can make that copy in the target lane folder. | CLI copy can be `any`. |
| `importToChat` | The host can continue the session as an ADE chat. | Chat continue becomes `none` when false. |

Chat copy is never narrowed (a replay needs only history); the chat importer
refuses a session with nothing to replay. The host narrows per session:

- **Source folder missing.** Every capability is false, except Claude's copy
  (the transplant needs no folder) and Droid's fork (it runs in the target).
- **Droid `--fork` not known yet.** A `droid --help` probe starts when the
  service is built. Until it resolves, `fork` and `forkIntoDifferentCwd` are
  false; a refresh shows the real value. A Droid CLI copy waits for the probe
  and re-reads the capabilities before the guard.
- **ACP providers and Cursor.** `importToChat` is false.

#### The plan

`planImport(summary, { surface, targetLaneId, originLaneId, laneName })`
returns an `ImportPlan`, which every client renders as it is. `originLaneId`
is the scanned lane; only an older host needs it.

| Field | Meaning |
|---|---|
| `surfaces` | The surfaces (`chat`, `cli`) that have at least one action. |
| `surface` | The requested surface, else the first available one. |
| `targetLaneId` | The lane the actions run in. A locked plan forces the home lane. |
| `laneLocked`, `lockReason` | True when no action on this surface can leave the home lane. The reason is short: "Cursor sessions stay in their own lane." |
| `primary`, `secondary` | The main action and the optional secondary "Copy". Each has `target`, `mode` (`resume` or `fork`, the wire value), `label`, `needsModel` (true for a chat copy), and `confirmBeforeRun` (true for a continue on a `possiblyActive` session; two writers on one provider session corrupt it). Clients arm their second press from `confirmBeforeRun` and never re-derive it. |
| `note` | One short line, or null. |

Labels: "Continue" (secondary "Copy" when allowed). With only a copy: "Open as
ADE chat" on chat; on CLI "Copy here" out of the home lane, else "Copy".

Notes (at most one):

- A continue on a session that may be open: "Open elsewhere — close it there
  first."
- A copy out of the home lane: "Original stays in {home lane}."
- A CLI continue of a session outside every lane: "Runs in its original
  folder." An older host sends no `home`; then the note shows when
  `cwdMatchesRequestedLane` is not true or the target is not `originLaneId`.

#### Host guard

`importExternalSession` finds the summary again (with `home`) and calls
`importRejectionReason`. An import the plan would not offer fails with the
dialog's words ("This Cursor session can only do that in Apple Sim."). The
guard runs for both surfaces.

### CLI target

`importExternalSession`, in order:

1. Validates the id (`validateExternalSessionId`: strict UUIDs for
   Claude/Codex, bounded ids with no path separators for the rest).
2. Resolves the target lane cwd and the optional caller lane scope.
3. Finds a resumable summary and runs the policy guard.
4. Chooses the run cwd, builds `TerminalResumeMetadata`, then the command.

Resume commands come from `buildTrackedCliResumeCommand` (`cliLaunch.ts`).
Codex resumes in the lane folder; every other provider in the session's own
folder, because its session is keyed to that folder. ACP selectors:
`qwen --resume <id>`, `kimi -S <id>`, `grok -r <id>`, `copilot --resume=<id>`,
`agy --conversation <id>`. A session from an ADE account, preset, route or key
home resumes with that home and the preset's env.

With no explicit model or permission override, the resume keeps provider
state: ADE does not inject Claude plan mode, Cursor `--model auto`, Droid
spec/off settings, or an OpenCode ADE agent.

Fork commands:

- Claude same-cwd: `--fork-session` on the resume; the PTY launch adds a
  pre-assigned `--session-id <new>` ([Session tracking](#session-tracking)).
- Claude cross-cwd: `transplantClaudeSession`, then resume the rekeyed id from
  the lane cwd.
- Codex: `resume` → `fork`, keeping `--no-alt-screen`.
- Droid `droid --fork <id>` (after the probe); OpenCode `--fork` on the
  resume; Pi `pi --fork <id>`; Qwen `--fork-session` on `qwen --resume <id>`.
- Grok `--fork-session` on `grok -r <id>`, with Grok's supervision `NAME=value`
  pairs in front of the line.
- Cursor, Kimi, Copilot and Antigravity have no CLI fork; the service refuses.

OpenCode, Pi, Qwen and Grok copies run in the source folder (these CLIs key a
session to its folder); the guard already refused any other lane.

The spawn is `ptyService.create` with `tracked: true`, the provider
`toolType`, `startupCommand`, direct launch fields, `resumeMetadata`, and
`allowExternalCwd` when the run cwd is not the lane cwd. ptyService allocates
the ADE session id. **If** a future change pre-assigns an import session id,
it must set `allowNewSessionId: true`, or `create` treats it as a
missing-session resume.

`resumeMetadata.importedFrom` records the original id and `mode`, so Work
continuation and `ade.pty.resumeSession` find the target again. Duplicate
detection reads the durable log, because resume metadata dies with the row.

An import returns the persisted `TerminalSessionSummary` or
`AgentChatSessionSummary`. Desktop and iOS install it before they navigate, so
the first render does not race sync into "session unavailable".

### Chat target

`importExternalSession` runs the guard, then calls `agentChatService.importExternalChatSession` with the
recorded model as `sourceModel`. The importer creates a lane-scoped
`AgentChatSession`, stamps `importedFrom` (`mode: "continue"` or `"fork"`),
appends history, and binds future turns where the provider allows it.

| Path | When | What it does |
|---|---|---|
| Claude native | Claude, target model of the Claude family (or none) | Continue binds the original session. Copy transplants the JSONL under a fresh id. |
| Codex native | Codex, target model of the Codex family (or none) | Continue binds the original thread. Copy calls `thread/fork`. |
| Native continue | Droid, OpenCode, Pi, or Copilot, `mode: "resume"` | Seeds the provider pointer. See below. |
| Replay copy | Every other case | Loads the history, writes it into a new chat, and stages it as a replay for the chosen model's first turn. |

Replay model: the user's choice, else the recorded model when it is of the
same family, else that provider's default, else ADE's default. A replay with
nothing to replay fails ("has no messages to replay") and creates nothing.

**Native continue.** The chat continues the provider session in place, as a
restart reopens an ADE chat:

- Droid: `droidSdkSessionId`, opened by the Droid SDK `resumeSession` from
  `~/.factory/sessions`.
- OpenCode: `providerSessionId`, opened by `session.get` on ADE's shared
  server. Continue is offered only for a session in ADE's managed store; a
  personal-store session is offered as a copy (a forced continue throws
  `OpenCodeSessionInPersonalStoreError`).
- Pi: `piSessionId`, opened by `SessionManager.list(cwd)` over the store chat
  and CLI share.
- Copilot: `copilotSdkSessionId`, opened by the Copilot SDK `resumeSession`
  over `~/.copilot/session-state`. Nothing is replayed.

The importer refuses a native continue when the folder is not the lane root or
the model is of another family. The model is the requested one, else the
recorded one of the same family, else the provider default; a recorded model
keeps its recorded effort (`sourceReasoningEffort`) when it supports it. The
history is display-only and is read before the chat exists, so an unreadable
session creates nothing.

**History.** `externalChatHistoryImport.ts` converts Claude and Codex: the
last 32 MB of transcript, the newest 2,000 content events, provenance and
truncation notices, then text, tool calls/results, commands, file changes, web
searches and image events. Metadata-only user rows and transport wrappers are
dropped; user-authored JSX/XML and text that starts with `User request:` stay.
Failed Claude tool results keep their status. Other providers go through
`loadExternalSessionEvents` with `purpose: "import"`
([Conversation events](#conversation-events)). `appendImportedChatEvents` adds
turn boundaries.

With no caller title, the title is the first imported text, else "Imported
{provider} chat"; **Name & status** can refresh it.

**Claude.** The importer reads JSONL from `CLAUDE_CONFIG_DIR` or
`~/.claude/projects`. A fork, or a source cwd that differs from the lane cwd,
transplants the JSONL into the lane's Claude project folder under a fresh id.
The chat sets `sdkSessionId` and `claudeBackgroundResumeSessionId`, mirrors a
pointer through `sessionService`, repairs known thinking-transcript id
collisions, and appends events. The host refuses a Claude continue from
another folder.

`importExternalChatSession` returns `providerTargetId`: the Claude id or Codex
thread actually bound, so the service records a fork's own id. It is optional
and never crosses the wire; a replay copy has none.

**Codex.** Open imports call `thread/read` with `includeTurns: true`. Fork
imports call `thread/fork` with `excludeTurns: true`, then read the fork. If
the import fails after a fork, ADE archives the forked thread (best effort)
before it deletes the ADE session. Success sets `managed.session.threadId` and
a `chat:codex:<threadId>` resume command.

**Keep the Claude transplant import in `agentChatService.ts` static.** A
dynamic `import()` from a variable path is not bundled into the `ade-cli`
brain `cli.cjs`, and the packaged brain then fails with a missing
`externalSessions/claudeSessionTransplant` module.

### Conversation events

`events/index.ts` turns a provider store into ADE chat events
(`AgentChatEventEnvelope[]`, oldest first). The preview and the replay import
use the same events, so the preview shows what an import writes.

| | `preview` | `import` |
|---|---|---|
| Events per page | 200 (`EXTERNAL_SESSION_PREVIEW_PAGE_EVENTS`; the phone asks for 120) | 2,000 (`EXTERNAL_SESSION_IMPORT_MAX_EVENTS`) |
| Bytes read | A 2 MB window that doubles up to 16 MB until it holds a full page; up to 4 empty windows are skipped | 32 MB (`MAX_IMPORT_TRANSCRIPT_BYTES`), in one read |
| Notices | None | "Session imported from …" and truncation notices on the newest page |
| Paging | `before` / `olderCursor` | One page |

**Paging** (`paging.ts`). A JSONL store is read in byte windows that end on a
line boundary. `jsonlSourceFor` names the file (the session JSONL, or the
conversation file inside an ACP session folder). The cursor names the window
(an absolute byte `end` and its size) and the first event already shown, so
appends never shift an older page.

- A line longer than the window is skipped.
- A tool call and its result on two sides of a window edge show as two rows.
- OpenCode pages by event index; a store-only Cursor chat by message index.
- When no converter gives events, the first page uses the sampled messages
  (text only).

| Provider | Source | What converts |
|---|---|---|
| Claude, Droid | The session JSONL (same message shape) | Text, tool calls, tool results (failed status kept). Thinking blocks are dropped, as on import. Shares `claudeRecordsToContentEvents` with the import. |
| Codex | The rollout JSONL | Three layouts: current (`event_msg` `item_completed` items, plus `function_call`s no item covers, such as `spawn_agent`), legacy (`user_message` / `agent_message` plus `response_item` tool calls), and bare (`response_item` only). Commands, file changes, reasoning, and MCP tool calls map through `codexTurnsToContentEvents`. The code-mode `exec` wrapper and its `wait` polls are dropped because the commands and patches they ran are already items. |
| Cursor | `agent-transcripts/<id>/<id>.jsonl`, else `store.db` | From the transcript: text and tool calls, each with an empty completed result (the transcript has no times, tool ids or results). A `store.db`-only chat goes through `loadCursorStorePage`: user and assistant text, readable reasoning, tool calls and results (failed status kept), and a `context_compact` marker where a summary replaced turns. The cursor's `end` is a message index. A message blob over 8 MB (`CURSOR_STORE_MAX_MESSAGE_BYTES`) is left out with an info notice. The `<user_info>` environment message is dropped. |
| OpenCode | The SQLite store that owns the session (the user's or ADE's managed one), read-only (`loadOpenCodeStoreEvents`) | Every message/part row, up to a 96 MB cap that drops the oldest first. Reads the 1.x `session`/`message`/`part` and 2.0 `session_v2`/`session_message` shapes. Falls back to the sampled messages when the store cannot be read. |
| Pi | The session JSONL | Text, thinking, tool calls, and tool results. |
| Qwen | `chats/<id>.jsonl` | Text, `thought` parts as reasoning, `functionCall` / `functionResponse`. User rows that Qwen injected (a `provenance` other than `real_user`, `isQwenPromptRecord`) are dropped. Verified only for text turns; tool shapes follow the Gemini CLI format. |
| Grok | `chat_history.jsonl` | Text, `tool_calls`, tool results, and reasoning summaries. Injected (`synthetic_reason`) user rows are dropped. Rows have no timestamps. |
| Copilot | `events.jsonl` | Text, `reasoningText`, tool requests, and tool results (failed status kept). Subagent rows (`parentToolCallId`) and autopilot "keep going" rows (`isCopilotPrompt`) are dropped. |
| Antigravity | `conversations/<id>.db` (SQLite), read-only (`loadAntigravityStorePage` in `antigravitySessionLog.ts`) | User messages, reply text, thinking, tool calls and results (agy's "Created At / Completed At" header dropped), each at its step's time (a user message takes the next reply's time). The cursor's `end` is a step index; a page reads back 200 steps at a time. A subagent's report shows as text. |
| Kimi | `agents/main/wire.jsonl` (legacy `context.jsonl`) | Unverified. Accepts `context.append_message` and `turn_begin` rows, the streamed wire protocol (`TurnBegin`, `ContentPart`, `ToolCall`, `ToolResult`), and OpenAI-style role rows. With `context.append_message` user rows, `turn_begin` input is not shown again; user rows not from the person (`isKimiUserOrigin`) are dropped. |

**Turn boundaries.** ADE lists finished tool calls in the turn's `done`
summary, not as rows, and a provider transcript has no such boundary.
`withImportedTurnBoundaries` (`shared/importedTurnBoundaries.ts`) closes each
imported turn that did tool work with a `done` event. A text-only turn gets
none, and input that has `done` events is unchanged. The desktop preview and
`appendImportedChatEvents` apply it.

**Detail.** Every caller uses `externalSessionsService.getDetail`, which
passes the service's `homeDir` and `env` to `loadExternalSessionDetail`. It
returns `messages` (the text tail older clients read) plus `events`,
`hasOlder` and `olderCursor`.

- The text tail comes from the converter's file (`jsonlSourceFor`), never a
  session folder or `store.db`. Without one it is the sampled messages, else
  the clipped text of the preview events.
- An ill-formed id returns an empty detail (the id can come from a remote
  viewer).
- A preview uses the chat id `external-preview:<provider>:<id>` and has no
  "Session imported from" notice.
- `watchDetail` loads through `getDetail` and sends the newest page; a client
  keeps the older pages it loaded.

### Desktop dialog

`ImportSessionBrowser.tsx` is a fixed-size split view: the session list on the
left, the preview and the action bar on the right, with no "back" step.

Top bar (`ImportTopBar.tsx`):

- **Provider chips**, only for providers with sessions under the lane filter.
  The chosen provider keeps its chip.
- **Lane filter and computer.** `LaneCombobox` with "All lanes" beside the
  computer (source) picker; both menus render above the dialog. Lane rows show
  counts and list only lanes with sessions; "Other folders" holds sessions
  outside every live lane. The filter opens on the dialog's lane while the
  scan finds sessions there, else "All lanes".
- **Search** matches title, opening prompt, lane name and branch, cwd, id and
  sampled messages. An empty result in one lane offers "Show N in other
  lanes".
- **Refresh** swaps each provider's rows in place.

List rows (`ImportSessionList.tsx`) group by date and name the lane with its
color dot ("Removed lane", or a folder's last segment), plus the compact time
("13m") and prompt count. The first visible row is always selected.

Preview (`ImportSessionPreview.tsx`): a header (lane, branch, time, prompt
count, model, size), then the real `AgentChatMessageList`, read-only (no
handlers, `sessionEnded`, `textPacingEnabled={false}`), keyed
`external-preview:<provider>:<id>`, inside a `data-chat-appearance-root` box.
Its own scroll box opens at the newest message and loads older pages on
scroll-back. `useExternalSessionDetail` waits a short settle delay before a
load. Against an older host it renders the sampled `messages`.

Action bar (`ImportActionBar.tsx`) renders the plan and nothing else:

- **Surface switch** "ADE chat | CLI", only for offered surfaces; the last
  choice per provider is in `localStorage`
  (`ade.importSession.surface.<provider>`).
- **Lane pill.** A `LaneCombobox` pill, or a locked pill (lock icon, no
  dropdown, the lock reason as tooltip).
- **Buttons.** The primary and a small secondary "Copy". A chat copy asks for
  the model first: as secondary, the first click shows the picker and changes
  the buttons to "Cancel" and "Make copy"; as primary, the picker shows at
  once.
- **Live confirm.** A `confirmBeforeRun` action takes two clicks; the first
  turns the button into amber "Continue anyway" for 4 s. One armed state,
  keyed to row, surface and lane, covers both second presses; only the live
  confirm times out.
- **Already in ADE.** "Open in ADE" replaces the plan.

The target lane is the home lane when this computer has it, else the dialog's
lane, captured once at open. A Work lane change while the dialog is open
changes neither the target nor the scan.

`defaultForkModel`: the recorded model when the model registry resolves it,
else the same provider's default (a Cursor session stays on Cursor), else
`anthropic/claude-sonnet-5`.

Keyboard: ↑/↓ move the selection, Enter runs the primary action, Esc closes.
Enter runs only after the user picked a row or typed a search, and a focused
control keeps its own Enter.

### Runtime routing

`window.ade.externalSessions.list/import/getDetail` call
`callProjectRuntimeActionIfBound` for the `external-sessions` domain first
(the normal path, local or remote). The `ade.externalSessions.*` IPC handlers
are only the fallback when no runtime is bound. `watchDetail`,
`unwatchDetail` and `onDetailUpdated` always use local IPC (a per-sender
Electron channel), so a live preview update works only for sessions on this
computer.

Both runtime hosts construct the service: `apps/desktop/src/main/main.ts` for
desktop-owned runtimes and `apps/ade-cli/src/bootstrap.ts` for the headless
brain. A remote-bound window and the mobile sync host talk to the brain, so
both are required, and both build chat refs the same way.

The `external-sessions` action domain has `list`, `import` and `getDetail`.
Non-CTO `run_ade_action` callers are lane-scoped: they must be authorized for
the lane, list args are forced to the lane cwd and project scope, and import
args get `enforceLaneScopeCwd`. CTO callers are unscoped.

### Mobile

Mobile uses `work.listExternalSessions`, `work.getExternalSessionDetail` and
`work.importExternalSession`. All three are `viewerAllowed`; import is also
`queueable`. A paired phone is a trusted controller; it never reads provider
files or launches CLIs itself.

`WorkImportSessionScreen` follows the desktop model: provider chips, a lane
filter with counts and "Other folders", project/all scope, rows that name the
home lane, imported and possibly-active badges, and "Open in ADE". A row opens
its detail: the preview and an action bar that renders `workPlanImport` (mode,
lane control, note, primary action, optional Copy). The target starts on the
home lane, a continue on a possibly-live session needs a second tap
("Continue anyway"), and an imported row offers "Open in ADE" plus a copy.

Rows show the "started" and "latest" anchors, or the one preview snippet from
a host without `messages`. The phone sends no model or permission override:
the host picks the model ([Chat target](#chat-target)), and a CLI import keeps
provider state.

## Provider gotchas

### Claude

- Sessions live under `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`, or
  `CLAUDE_CONFIG_DIR/projects/...`. Every Claude path in discovery, CLI fork
  and chat transplant must respect `CLAUDE_CONFIG_DIR`.
- Resume is strictly cwd-scoped. A same-cwd CLI fork uses `--fork-session`; a
  cross-cwd fork copies and rekeys the JSONL into the target cwd's project
  folder.
- `ai-title`, `customTitle` and session-title records give the title;
  otherwise `title` is null.
- Only `<projectSlug>/<uuid>.jsonl` is a session. Most transcripts on disk are
  sidecars under `<sessionId>/subagents/**` (workflow runs too); discovery
  never descends into a project subfolder and ignores non-uuid names such as
  `agent-*.jsonl`.
- SDK-origin transcripts (ADE's own Claude chats) are excluded, because the
  CLI cannot reliably resume them. The test is the entrypoint the session
  *starts* with, over its head rows, never any single `sdk` row.

`claude --resume` appends in place, so one file normally spans every resume.
New files appear on `--fork-session`, `/branch`, a rewind, and `/cd` (which
moves the session to another project folder). So discovery dedupes
continuation chains across all project folders:

- The chain key is the uuid of the **first record that carries one**. The
  camelCase `sessionId` is rewritten to the filename and proves nothing;
  snake-case `session_id` is a real ancestor pointer and a second edge (absent
  on SDK sessions). First-message **text** must never key a chain: ADE
  injects the same preamble into many chats. The walk to the first uuid is
  bounded but goes past 64 KiB, because a pasted prompt can push it there.
- Only pure continuations collapse (one file's records are a prefix of, or
  equal to, another's); the leaf (longest, newest on a tie) survives.
  Diverging members are real forks and both stay.
- The prefix test is bounded: the longer file must hold the shorter file's
  final record uuid near the shorter file's length, and uuids sampled at
  fractions of the shorter file must appear at the same offsets in the longer
  one. The tail check alone is not enough. Copies rewrite `sessionId` with a
  same-length uuid, which keeps the offsets aligned.
- An exact `sessionId` lookup skips dedupe.

### Codex

- Rollouts live under `CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, titles
  in `CODEX_HOME/session_index.jsonl`. The thread id is the rollout UUID.
  Chat import uses the app-server `thread/read`, `thread/fork`,
  `thread/archive`, resume and fork.
- Only interactive CLI rollouts import ([Codex thread store](#codex-thread-store)
  has the classification). For preview and count ADE prefers the
  `event_msg.payload.type = user_message` row, so duplicate `response_item`
  rows and environment instructions do not show.
- File-change items use tagged shapes (`{ type: "add" }`, `"delete"`,
  `"update"`), not always bare strings. Keep `externalChatHistoryImport.ts`
  aligned.
- Resume and fork flags must match the current CLI and app-server contracts.
  Do not revive old `ThreadResumeParams` assumptions in
  `buildTrackedCliResumeCommand` or chat import.

### Cursor

**One conversation, up to four artifacts**, and the bare uuid is the only
shared identity:

- `~/.cursor/chats/<md5(exact-process-cwd)>/<id>/store.db`. The bucket is the
  md5 of the *raw process cwd*, so one project has a bucket per launch folder
  (repo root and `apps/desktop` differ).
- A second bucket for the same id, when the chat resumed from another cwd. The
  newer one is usually a near-empty stub: size, not recency, decides.
- `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.
- A duplicate transcript under `projects/empty-window/`; either copy can be
  partial.

Discovery groups by id and keeps the fullest artifact, so a duplicate never
lists twice.

- `meta.json` beside `store.db` gives `cwd` for newer sessions, before the
  md5 or slug reverse-maps (which work only for a cwd ADE can name).
  `.workspace-trusted` and de-slugging are the fallback.
- ADE reads the store's hex meta record for name and creation time, includes
  store-only sessions, and uses the WAL mtime as activity. A header can carry
  a `blobEncryptionKey`; an unreadable body is still resumable, and
  `meta.json` gives the title.

**The conversation inside `store.db`** (`openCursorStoreConversation`).
`blobs` is content-addressed (`id` = sha256 of `data`), so row order is not
conversation order and a repeated message is one blob listed twice.
`meta['0']` (hex JSON) names `latestRootBlobId`. The root blob is a protobuf
whose repeated field 1 lists message blob ids oldest first; each message is
AI SDK JSON `{ role, content }`. After a summary, the root's field 13 names a
summary blob: its field 1 lists the replaced messages and its field 4 is the
summary message. The full order is the replaced messages, then the root after
that summary message. `readCursorStorePrompts` and the store-only preview walk
this order. `<system_reminder>` and `<user_info>` messages are never prompts.

- Scope comes from folder names, `meta.json` and `.workspace-trusted` before
  the recent-session cut. Artifacts with an unconfirmed cwd (`empty-window`,
  buckets of deleted folders) are read after every confirmed match.
- Two ids are never sessions: SDK `agent-<uuid>` runs (`cursor-agent` cannot
  resume them) and `00000000-0000-4000-8000-000000000000`, which Cursor gives
  to unrelated runs. The `subagents/` tree and `~/.cursor/acp-sessions/` are
  not walked.
- No fork; resume is cwd-scoped and always names the chat id, never
  `cursor-agent --continue`.
- Edit mode must not map to `--mode ask` (read-only). In `cliLaunch.ts` only
  plan maps to `--mode plan`, full-auto to `--force`, and edit/default omit
  the flag.

### Droid

- Sessions live under `<factoryConfigHome>/sessions/<escaped-cwd>/*.jsonl`:
  `~/.factory`, or `FACTORY_HOME_OVERRIDE`, which replaces the HOME that
  `.factory` is added to (`shared/providerConfigHomes.ts`).
- The first row must be `session_start` (id, cwd, title). A row can omit the
  start time, so creation time falls back to the first timestamped message.
  "New Session" becomes null.
- ADE reads neither the `<id>.settings.json` sidecar nor `sessions-index.json`
  (rewritten whole on every change; a hint at best).
- One id can appear under several escaped cwds; discovery reads the fullest
  copy. Out-of-project folders are ruled out by name before the cut; a folder
  name that is not an escaped absolute path is read after every confirmed
  scope.
- Discovery also reads the preset, route and key homes
  ([Where the other CLIs' sessions live](#where-the-other-clis-sessions-live)).
- `droid --fork` waits for the installed-CLI probe and fails clearly when the
  binary lacks it. Resume is cwd-locked.

### OpenCode

`openCodeStore.ts` reads the OpenCode SQLite stores read-only. It never shells
out to the CLI (a piped `opencode session list` cuts its stdout at 64 KiB)
and never starts a 2.0 server on the user's store (2.0 migrates a v1 database
in place when it opens one).

- Two schemas: 1.x `session`/`message`/`part` and 2.0
  `session_v2`/`session_message`. A migrated store keeps both, and only
  `session_v2` lists every session.
- `ADE_BACKGROUND_TASK_TITLES` drops ADE's own background prompts (terminal
  summaries, commit messages, chat titles).
- The import list reads the user's store and ADE's managed store (every
  OpenCode terminal and chat ADE launches uses ADE's shared server). A managed
  row can continue in place; a user-store row is offered only as a chat copy.
  A row ADE already tracks shows "Already in ADE".
- No store or an unknown schema is an empty list, never an error.
- Resume and fork use `--session`, `--continue` and `--fork` on a tracked
  launch, which `attachOpenCodeTerminal` points at ADE's shared server
  ([OpenCode CLI: attach to ADE's server](README.md#opencode-cli-attach-to-ades-server)).
  Sessions are per-project by cwd, so ADE resumes or forks in the source cwd.

### Pi

- Pi sessions live in the native store that ADE chat and Pi terminals share,
  and in each preset and route home (`PI_CODING_AGENT_DIR`). CLI continue and
  copy (`pi --fork <id>`) run in the session's folder; a chat continue seeds
  `piSessionId`.
- Discovery drops a session that opens with the `## ADE` guidance block (ADE's
  chats, archived or from a removed lane too). A Work-tab CLI launch opens
  with "ADE session guidance." instead, so the user's CLI sessions stay.
- The tracked-terminal lookup (`resolvePiSessionIdFromStorage`) passes
  `defaultHomeOnly`, so a Pi terminal never adopts another preset's session.

### CLI stores (Qwen, Kimi, Grok, Copilot, Antigravity)

Each discoverer reads its CLI's store directly and leaves out ADE-launched
sessions, subagent sessions and sessions with no prompt. Copilot discovery
does not use the SDK's `listSessions()`/`getSessionMetadata()`: they need a
running runtime and their rows have no `client_name`, first prompt or model.
`workspace.yaml` plus the head of `events.jsonl` is fast.

| Provider | Store (env override) | ADE-launched and other exclusions |
|---|---|---|
| Qwen (verified 0.22.3) | `<runtime>/projects/<sanitized cwd>/chats/<id>.jsonl`, where `<runtime>` is `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `~/.qwen` (a leading `~` expands). The folder slug is not reversible, so the cwd comes from the records. | ADE's ACP chats never write an `attribution_snapshot` system row, and their first prompt opens with the `## ADE` guidance block. A session with both signs is left out. |
| Kimi (verified Kimi Code 2.3.1) | `KIMI_CODE_HOME` (default `~/.kimi-code`, and each ADE preset and route home): `sessions/wd_<slug>_<hash12>/<id>/` with `state.json` and `agents/main/wire.jsonl` (legacy `context.jsonl`), plus `workspaces.json` and `session_index.jsonl`. | Archived sessions, deleted sessions (index tombstones), and child sessions (`custom.child_session_kind: "child"` or `parent_session_id`). No file marker tells ADE's chats apart, so a first prompt that opens with `## ADE` is the test. |
| Grok (verified 1.0.46) | `$GROK_HOME/sessions/<percent-encoded cwd>/<id>/` (default `~/.grok`, and each ADE preset and route home) with `summary.json` and `chat_history.jsonl`. The folder name is the cwd, so it is reversible. | `session_kind: "subagent"`; `session_kind: "headless"` (a `grok --single` run, which is how ADE runs its naming and metadata tasks); and a first prompt that opens with `## ADE` (ADE's chats). `updates.jsonl` is not a sign: Grok's own terminal UI writes it too. The opening `<user_info>` workspace-context row is not a prompt, in the list and in the preview transcript. |
| Copilot (verified CLI 1.0.88, SDK runtime 1.0.98) | `$COPILOT_HOME/session-state/<uuid>/` (default `~/.copilot`, `%USERPROFILE%\.copilot` on Windows) with `workspace.yaml` and `events.jsonl`. | `client_name` that starts with `ade` (`ade`, `ade-probe`, `ade-telemetry-probe`, …). ADE's SDK chats create their session with `clientName: "ade"`; a resume keeps the name the session was created with, so a CLI session continued in ADE keeps its own. Older SDK chats recorded `client_name: sdk`; those are left out when their first `system.message` carries ADE's coding-agent prompt ("You are ADE's software engineering agent working in"). Sub-agents run inside the parent session, so there are no child folders. Autopilot turns (`source: "autopilot"`) are not prompts. |
| Antigravity (verified agy 1.5.6, Windows) | `~/.gemini/antigravity-cli/conversations/<id>.db`, one SQLite file per conversation from the TUI or ACP, with a WAL beside it while agy runs it (its time and size count). The cwd is the workspace in `trajectory_metadata_blob`; a conversation with none lists only in an unscoped import. | Subagent conversations (the first step is a message from the parent), and conversations whose ACP system prompt (`acp_system_prompt` in the metadata) opens with `## ADE`, which is every ADE chat. See [Antigravity provider](../chat/antigravity-provider.md#session-log). |

Every read is defensive: an unexpected shape gives a thinner row or no row,
never a throw. These stores hold mostly rejects, so `collectNewestSessions`
reads candidates newest first until enough survive, up to a hard cap; an exact
`sessionId` lookup reads every candidate.

## Session tracking

**Pre-assigned ids.** A fresh tracked launch of Claude, Qwen, Grok or Copilot
gets a new UUID on its command line (`preassignedSessionIdArgs` in
`cliLaunch.ts`), so the resume target exists from the first byte:

| CLI | Flag |
|---|---|
| Claude | `--session-id <uuid>` |
| Qwen | `--session-id <uuid>` |
| Grok | `-s <uuid>` |
| Copilot | `--session-id=<uuid>` |

- The id names a NEW session, so `ptyService` never adds it to a launch that
  continues one (`--resume`, `--continue` and the like).
- The exception is a Claude fork: Claude Code accepts `--session-id` beside
  `--resume <id>` only with `--fork-session`, so a same-folder Claude CLI copy
  gets one too (`claudeArgsResumeExistingSession` returns false for a fork).
  `buildClaudeForkLaunchCommand` builds the same line; only its tests call it.
- The resume parser (`terminalSessionSignals.ts`) reads these flags. A
  pre-assigned id wins over a resume selector. A fork without one mints its
  own id, so the source id is NOT its target. Kimi has no such flag.

**Kimi.** `ptyService` finds the session a tracked Kimi launch created in
`<kimiHome>/sessions/wd_<slug>_<sha256(cwd)[:12]>/<id>/`.

- `kimiWorkDirKey` reproduces the bucket name for each spelling of the cwd;
  `workspaces.json` can add an alias bucket. An alias id must have the
  `wd_<slug>_<hash12>` shape, because it becomes a folder name and must not
  point outside `sessions/`.
- `selectKimiLaunchSession` takes a session born in the launch window, whose
  recorded `workDir` (if any) matches the cwd, and that no other terminal
  adopted. A session that proves its cwd wins.
- A capture that cannot prove ownership is skipped: a wrong resume is worse
  than none.

**Cursor and Pi.** Only a captured chat id resumes. `cursor-agent --continue`
means "the most recent chat", which can belong to another terminal, so the
resume builder never uses it and the parser returns no target for it.

**Handle ownership.** `inspectLiveProviderSessions` finds which process holds
each session file open. The holder is usually a descendant of the tracked PTY
(shell → node → CLI), so `collectDescendantPidRoots` walks the PTY roots first
and stamps each handle with `trackedRootPid`, and `handleIsOwnedByTrackedPty`
decides from that field. Never compare `handle.pid` with the PTY pids. The
importer hides sessions that a live ADE terminal runs.

**Provider roots.** `providerSessionRoots` includes the ACP stores (Qwen
`projects`, Grok `sessions`, Copilot `session-state`, Kimi `sessions`), and
the process scan matches the `qwen`, `grok`, `copilot` and `kimi` binaries.
Their session folders hold fixed-name files (`chat_history.jsonl`,
`events.jsonl`, `state.json`, `wire.jsonl`), so the id is a path segment:
`sessionIdFromLayout` parses each layout, and a file outside it is not a
session. A wrong id here hides the wrong session.

**OpenCode.** Only a `ses_<id>` path segment is a session id, never `opencode`.

## Testing constraints

- Desktop testing before a merge can point the renderer at an isolated
  lane-built brain (its own `ADE_HOME` and runtime).
- The iOS app pairs to one sync host. Two sync-enabled brains conflict on the
  port, mDNS and tunnel routing, so a real phone test needs the feature on the
  paired host (merged, or an isolated-port sync host the phone pairs to).
- If mobile seems to lack the feature, check the host first. The iOS client
  cannot import when the brain lacks `work.listExternalSessions` and
  `work.importExternalSession`. Without `work.getExternalSessionDetail`,
  import works and the preview uses the sampled messages.

## Known follow-ups / open items

- No feature flag gates import: a constructed service and the UI make it live.
- Keep the shared DTOs, `externalSessionPolicy.ts`, its Swift port, the iOS
  models and the sync payloads in lockstep. A server-only change breaks
  mobile decoding or hides buttons; a UI-only change shows actions the host
  guard refuses.
- The Kimi PTY watcher is not checked against a real Kimi session. Discovery,
  the preview and CLI continue are (Kimi Code 2.3.1, in an ADE route home).
- A Droid route (`--via`) cannot run: Droid 1.0 sends the route's
  `FACTORY_API_KEY` to Factory, which rejects it (401). So a route-home Droid
  session lists and the import launches `droid --resume` in that home, but
  Droid stops with "Session not found". This is a route problem, not an
  import problem.
- `external-sessions.list` blocks the brain's event loop for 2–5 s on a large
  machine (Claude 2–5 s, Pi 1–1.6 s of discovery). The ADE homes add about
  0.1 ms per provider.
- The iOS preview has not run against a live sync host (the test brain runs
  with `--no-sync`).

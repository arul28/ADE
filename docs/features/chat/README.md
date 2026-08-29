# Chat

Agent Chat is the interactive AI coding surface inside ADE. Each chat binds a
lane (git worktree + branch), a provider runtime (Claude, Codex, OpenCode,
Cursor, Droid, Pi), and a transcript into a persistent `AgentChatSession`. The user talks
to the agent the same way they would use any IDE copilot, but with ADE's
lane/session tracking, tool approval flow, identity continuity, and handoff
machinery layered on top.

The same session/provider engine also backs machine-owned **personal chats**.
Those sessions use `surface: "personal"` and an internal hidden lane for schema
compatibility, but deliberately replace the coding prompt, cwd, environment,
slash-command discovery, ADE guidance, browser profile, and project tooling at
the boundary. Do not make the project chat schema nullable or treat a missing
lane/project id as personal scope. See [Personal chats](../personal-chats/README.md)
for its separate RPC, sync, storage, and UI contracts.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/renderer/components/chat/CrossMachineHandoffModal.tsx`, `crossMachineHandoffPresentation.tsx` | **Send to machine** workflow in the Handoff tab: source Git readiness, eligible connected-machine selection, brief or full-history fork selection, the destination chat's model / reasoning effort / fast mode / permission mode (the shared `PermissionModePicker` and `ReasoningEffortPicker`, each self-hiding when the chosen model can't honor it), optional continuation note, destination project matching or confirmed clone, storage/auth/model/commit/lane checks, a **Fetch & fast-forward there** offer when the destination lane is clean and a strict ancestor of the source commit, transport disclosure, route-pinned final send, and recoverable source-marker completion. Source blockers are `BlockedActionReason` values rendered next to a `BlockedActionButton`, so no blocker can hide behind a disabled control. The modal takes a `runtimePin` naming the machine the **source** chat runs on (`null` = this tab's bound machine) and pins every source-side call to it — lane list, `git.getSyncStatus`, `git.getOriginRemote`, `git.push`, `git.pull`, `agentChat.prepareCrossMachineHandoff`, `validateCrossMachineSource`, `markCrossMachineHandoff` — while destination dispatch keeps routing by target id. The pin lives in a ref and is frozen once per operation, so every await inside one handoff reaches the same runtime; reading it fresh after an await could cross a lane-index change and split one handoff across two machines. Eligibility follows the same rule: the Handoff menu offers the cross-machine card based on the chat's own binding (`isRemoteChat`), so a local chat viewed from a remote-bound tab can still hand off, and a chat pinned to a remote machine cannot. `crossMachineHandoffPresentation.tsx` holds the pure half — stage/mode types, `SourceCheck`, branch/route/readiness copy, permission tone and icon maps, and `CheckRow` — so the copy and lookups that shipped wrong are directly testable. Cross-machine fork transports provider-native history for Claude, Codex, and OpenCode; Cursor and Droid use brief mode because their histories are not portable between machines (Droid's session index is machine-local, and Cursor's local fork is ADE-side context seeding that produces no provider artifact to send). A fork that can't be completed always degrades to a one-click brief rather than a dead end: an older destination that omits `forkHandoffSupport`, a history over the transport cap, or an unforkable provider file (e.g. a Codex `.zst` rollout) each surface a plain-language reason and a **send as brief** action that re-runs prepare + preflight in brief mode. The insecure-route consent line is fork-aware — a fork discloses that the full chat history is sent exactly as recorded, while a brief states only the summary is sent, never secrets. See [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md). |
| `apps/desktop/src/shared/crossMachineHandoff.ts` and `apps/desktop/src/shared/types/chat.ts` | Renderer-safe Git-origin normalization, portable remote sanitization, untrusted remote-response decoders, and the versioned capsule/preflight/accept DTOs shared across renderer, preload, Electron main, and the ADE runtime. `chat.ts` also owns the fork-handoff contract: `HANDOFF_FORK_PROVIDERS` (`claude`, `codex`, `opencode`, `droid`, `cursor`) + `providerSupportsHandoffFork()`, the companion `providerForkReplaysTranscript()` (true only for Cursor, whose fork is an ADE-side full-transcript replay onto a brand-new agent rather than a native provider fork, so UI copy must not promise a copied provider thread — it promises the conversation, bounded by the target model's context window), `AgentChatHandoffArgs.targetLaneId` (brief may retarget any lane in the project; fork must stay in the source lane), the cross-machine capsule's optional `mode: "brief" \| "fork"` with `forkTransport` (provider-native session files) and `transcriptEnvelopes` (gzipped ADE JSONL), and the preflight's optional `forkHandoffSupport` (absent = older destination the source must treat as fork-unsupported, so a fork never silently downgrades to a brief). Cross-machine fork has its own narrower list: `CROSS_MACHINE_HANDOFF_FORK_PROVIDERS` + `providerSupportsCrossMachineHandoffFork()`, derived from `HANDOFF_FORK_PROVIDERS` by filtering out Droid (its session index is machine-local) and every replay-forked provider (Cursor produces no transportable artifact at all), so the two lists cannot drift. `validateForkTransport` gates inbound capsules on the cross-machine helper rather than the local one, so a provider whose fork has nothing to package is refused by the provider check instead of by the transport-kind allowlist. The preflight also carries an optional `laneFastForward` (`laneId`, `laneName`, `behindBy`) — the destination's own assertion that its existing lane is clean and a strict ancestor of the source commit. `decodeCrossMachineDestinationPreflightResult` decodes `forkHandoffSupport` and `laneFastForward` only when present, and rejects a `behindBy` that is not a positive integer because the destination refuses a zero-distance fast-forward. `chat.ts` also owns `ACTIVE_TURN_DISPATCH_MODES` — THE per-provider active-turn delivery matrix, in menu order with the first entry as the provider's default (`claude`: `inline`, `queue`, `interrupt`; `cursor`: `interrupt`, `queue`; everything else queue-only) — read through `activeTurnDispatchModes()`, `defaultActiveTurnDispatchMode()` and `supportsActiveTurnDispatchMode()`, with the companion facts `activeTurnInterruptContinues()` (true only for Cursor, whose interrupt cancels and resends on the same thread instead of folding into the live query, so the affordance says "continue") and `unsupportedActiveTurnDispatchModeMessage()` (the one rejection string, templated off the table). Every surface reads it rather than restating the rules — the composer's split send button, the chat pane's dispatch wiring, `agentChatService`'s steer/dispatch guards, and the `ade code` TUI's `/steer` commands; iOS mirrors it by hand in `WorkActiveSendCapability` because it cannot import TS. `chat.ts` is also the canonical cross-client contract for context-usage state/sample metadata, Claude result provenance/error/correlation fields, queue-aware interrupt results, the bounded `queue_recovery` lifecycle, and the desktop prompt-stash DTOs plus `MAX_PROMPT_STASHES`. |
| `apps/desktop/src/main/services/chat/crossMachineForkTransport.ts` | Node-only fork-transport plumbing shared by the source packaging and destination materialization paths. Owns the uncompressed limits (18 MiB provider main session file, 4 MiB total Claude sidecars, 3 MiB ADE transcript envelopes), the independent base64 bounds that reject oversized input before decoding, and `CROSS_MACHINE_FORK_ENCODED_BUDGET_BYTES` (20 MiB) — a whole-capsule encoded budget kept under the 25 MiB sync-envelope/WebSocket payload caps. `gzipToBase64` / `gunzipFromBase64` (the latter enforces a max output length) do the compression; `enforceCrossMachineForkEncodedBudget` drops the sidecar group first and only throws a "too large, send a brief" error when the main file plus transcript alone blow the budget; `crossMachineForkOversizeError` returns the typed `CROSS_MACHINE_FORK_OVERSIZE` failure; `runCliCapture` buffers `opencode export` / `import` stdout/stderr with a timeout; and `validateForkTransport` re-validates a received capsule's transport (cross-machine fork provider support, provider match, kind allowlist, base64 shape, path-traversal-safe side-file paths, per-file and total size caps) before any decode. It gates on `providerSupportsCrossMachineHandoffFork`, not the local-fork predicate, so a provider whose fork produces no transportable artifact (Droid's machine-local index, Cursor's context-only reseed) is refused by the provider check rather than incidentally by the kind allowlist. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Main service: session lifecycle, external chat import orchestration (`importExternalChatSession` for Claude/Codex sessions discovered by the external-session service), turn dispatch, event emission, provider adapters, steer queue, handoff, auto-title, prompt-derived lane-name suggestions for auto-created / parallel lanes, event-history snapshots, durable chat transcript replay/storage compaction, slash-command discovery/merge (delegates to per-provider discovery modules and `slashCommandPromptExpansion` for unified prompt expansion), and active-workload detection used by project/window close guards. Codex non-retrying app-server failures are deduplicated by turn plus semantic error identity across the early `error` notification and terminal `turn/completed`; retrying notifications (`willRetry: true`) remain provider-health notices while the turn stays active. OpenCode stream rendering gates every rendered content type on the assistant message role: `message.part.updated` events carry no role and user-message parts (including synthetic/ignored prompt context) ride the same event stream as assistant output, so text/reasoning deltas emit only for parts whose message id `message.updated` announced as `assistant` (`openCodeMessageRoleById` — unknown ids stay unrendered because OpenCode announces every message before its parts), synthetic/ignored parts are skipped outright, and image `file` parts still emit only for assistant-owned messages. Lane naming and chat auto-titling both run through the session-intelligence prompt path over the shared candidate chain in `sessionNaming.ts` (configured `titleModelId` → the model the chat was launched with → a model from another provider → a sibling on the leading provider), and only then fall back to a deterministic prompt-derived title/slug; branch uniqueness is handled by the lane id suffix added by lane creation. Tracks Fast Mode with the legacy `codexFastMode: boolean` session field for every provider whose descriptor advertises `serviceTiers: ["fast"]`; Codex forwards it as `serviceTier: "fast" \| null` on every `thread/start` and `turn/start` JSON-RPC call, while Cursor SDK sessions resolve it through discovered model parameters (see [Agent Routing](agent-routing.md#provider-service-tiers-fast-mode)). Codex chat goals are managed through the app-server `thread/goal/get` / `set` / `clear` RPCs, persisted in session summaries, validated to the provider's 4,000-character objective limit, and normalized to ADE's unlimited-budget policy by sending `tokenBudget: null` and clearing provider-reported budgets. `applyCodexEffectiveThreadState` accepts a `requestedCodexPolicy` option and uses `shouldPreserveRequestedCodexPolicy` to keep ADE-controlled picker selections authoritative when the lifecycle response echoes an older thread policy (prevents a manual Plan→Edit switch from snapping back); it also syncs the abstract `permissionMode` via `syncLegacyPermissionMode` after every policy application. Whenever an `updateSession` touches any permission/interaction/mode field, the service also emits a transient `session_meta_updated` chat event carrying the recomputed mode fields (`permissionMode`, `interactionMode`, `claudePermissionMode`, `codexApprovalPolicy`/`codexSandbox`/`codexConfigSource`, `opencodePermissionMode`, `droidPermissionMode`, `cursorModeId`, and the `cursorModeSnapshot`) so any other client viewing the same session — a desktop refreshing a session an iOS device just re-moded, or vice versa — updates its composer controls live. It is a direct state patch, emitted after the Cursor policy sync so `cursorModeSnapshot` reflects the recomputed mode, and is kept off the session-list refresh path. Builds ADE guidance from the active lane worktree so Agent Skill roots are lane-scoped in persistent system/developer prompts and provider fallback injection. `buildAgentRuntimeEnv(managed)` stamps every SDK-backed provider process with `ADE_CHAT_SESSION_ID`, `ADE_DEFAULT_ROLE=agent` (or `orchestrator` for a lead), `ADE_LANE_ID`, `ADE_PROJECT_ROOT`, and `ADE_WORKSPACE_ROOT`; the persistent guidance also names the concrete `--session <id>` argument for status commands so shared SDK servers do not depend on process-global env inheritance. `dismissPendingInputForSettlement` is the provider-neutral quieting boundary used by **Dismiss & settle**: it interrupts live Claude/Codex/OpenCode/Cursor/Droid turns best-effort, cancels local/provider waiters, removes Codex plan follow-ups, emits pending-input resolution, and persists an idle session before settle is written. It is single-flight per session (a second concurrent caller — a double-click, or a desktop and a phone dismissing at once — awaits the pass already running instead of starting a second one) and records which cards its own drains resolved so it never emits a second receipt for the same card. `settleCodexPendingInputs` is the single settle for a Codex turn: it answers each open app-server approval request, clears `runtime.approvals`, drains staged `pendingPlanFollowups`, cancels the local `codex` **and** `ade` cards, and emits exactly one `pending_input_resolved` per card; every path that ends a Codex turn calls it (`interrupt`, the local interrupt finish, the `turn/aborted` handler, runtime teardown, `thread/deleted`, the app-server `error`/`exit` handlers, and settlement). `settleClaudePendingApprovals` is the Claude counterpart for `canUseTool` waiters, which can only be answered on the query that raised them. When the session has Linear issues attached (`session_linear_issues`), `buildAgentRuntimeEnv` also materializes them into a per-session context file via `writeSessionLinearIssueContextFile` (`<contextDir>/<sessionId>/linear-issues.json`, written atomically; stale files cleared when nothing is attached) and sets `ADE_LINEAR_ISSUE_IDS` (comma-joined identifiers) + `ADE_LINEAR_CONTEXT_FILE` so the agent reads its issue context without Linear credentials. Attaching a `linear_issue` context attachment at run time calls `laneService.attachLinearIssueToSession({ chatSessionId, issues, role: "worked", source: "chat_attach", includeInPr: true })` so the link is persisted even for standalone (laneless) chats; when the session has a lane it additionally runs `laneService.linkLinearIssues` for the lane/PR-card semantics. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection). Claude SDK sessions also resolve the executable through `claudeCodeExecutable.ts` and pass `pathToClaudeCodeExecutable` so packaged builds can prefer the bundled native binary before PATH/auth fallbacks; interrupted Claude turns stop active subagents before emitting stopped `subagent_result`s, and every `subagent_result` is gated on a previously emitted `subagent_started` (tracked in `emittedSubagentStartIds`) so an interrupt can never emit a phantom stopped card for a subagent that never announced — terminal events clear both the taskId and agentId aliases. A plain Claude Code task run (`task_type` `other`, no agent metadata — e.g. "Re-run affected test files") is tracked for cleanup but never surfaces subagent rows. Claude resume paths run `claudeThinkingTranscriptRepair` before loading a transcript, and the runtime self-heals the same corruption after the Anthropic thinking-block 400 error. Plan-mode transitions run through `claudePlanMode.ts` and emit a plan-mode notice carrying the resulting access mode, so the renderer composer chip updates from an authoritative value even when the session refresh races with compaction. Cursor SDK setup records interrupts that arrive while the worker is still being acquired, releases the acquired generation if setup loses the race, and suppresses false provider-health failures for user-initiated setup interrupts. Every local Cursor turn is guarded by a 90 s first-event watchdog and at most one automatic recycle-and-resend (see [Cursor thread recycling and the first-event watchdog](#cursor-thread-recycling-and-the-first-event-watchdog)); an expired Cursor access token recycles the worker while resuming the *same* agent id, so the recovery is silent and the thread survives. Queued-steer settlement is claim-based: `settledSteerIds` is a per-session `WeakMap` of steer ids that have already had a delivered-or-cancelled notice emitted, claimed by every emitter that resolves a steer and re-opened whenever a steer goes back on the queue, so a runtime swap that detaches a queue the delivery attempt also drains cannot render two contradictory notices for one message. Cursor provider slash commands use a dedicated discovery path (`cursorSlashCommandDiscovery`) instead of falling through to the generic filesystem-backed list. Claude query startup is single-flight: concurrent `ensureClaudeQuery` callers latch onto one in-flight `queryStartPromise`, and a per-runtime `queryGeneration` token aborts and reaps a start that a reset or interrupt superseded, so a resumed session never spawns twin subprocesses; both reset and interrupt reap the SDK subprocess through `claudeSubprocessReaper` because a closed `query()` still leaves a live `claude --resume` child. `run_in_background` shell tasks (SDK `task_type` `local_bash`/`background`) survive turn boundaries — the query stays alive across turns and delivers their real completion — so interrupt, reset/dispose, a native subagent exit, or a host-restart rebind settle them as stopped; a reset that orphans still-open background tasks emits one `system_notice` that they were stopped without reporting completion, and background-task titles are sticky (the first spawn description is reused through the terminal row). A durable per-`(SDK message id, content index)` emitted-text record keeps a re-delivered assistant snapshot (after a stream-dedup reset from steer, message interleave, or idle handoff) from doubling the transcript. Claude `TaskCreate`/`TaskUpdate` tracking keys creates by tool-use id and remaps the harness's ordinal task id onto the Nth created task; an update for an id it cannot resolve or describe changes nothing rather than fabricating a todo row. `steer()` returns `AgentChatSteerResult` (`{ steerId, queued, reason?: "queue_full" }`); reasoning effort is normalized and applied at steer delivery, and an active Claude `interrupt-replace` uses SDK priority `now` without tearing down the query or its background work. When a spawned child chat ends, `reportChildSpawnEnded` reports its outcome to the spawner according to the child's `spawnKind`; an active Claude parent receives SDK `priority: "next"` delivery, an active Codex parent receives `turn/steer`, and idle or provider-fallback parents receive the normal message path, while scheduled work remains boundary-delivered (see [Spawn types and completion reporting](#spawn-types-and-completion-reporting)). Spawned agents also inherit `ADE_PARENT_CHAT_SESSION_ID` / `ADE_SPAWN_KIND` and a subagent self-report guidance line. Fork/import history seeding (`appendImportedChatEvents`) is chunked with event-loop yields, defers transcript flushes to chunk boundaries, and never publishes seeded historical envelopes to live event subscribers — readers load them via history APIs; live-publishing an entire source chat froze the app during fork handoff (ADE-122). The `chat.handoffSession` / `chat.prepareCrossMachineHandoff` runtime actions carry extended timeouts (120s daemon action, 150s IPC) because a brief handoff spans AI-brief generation plus first-message dispatch — the old 30s default fired a false timeout while the daemon-side handoff completed anyway. For orchestrator-lead sessions it builds the read-only capability services (`buildOrchestrationLeadReadServices` → `searchWorkspace` / `readLinearIssue` / `readPr` / `listProofArtifacts` / `mintDeeplink`), wiring each only when the backing service exists so a null service degrades to an omitted tool rather than a crash. Large service file. |
| `apps/desktop/src/main/services/chat/chatRuntimeBudget.ts` | The process-wide warm-runtime budget. Owns `MAX_CONCURRENT_ACTIVE_RUNTIMES` (5) and `createChatRuntimeBudget()`, which chat services register with as `RuntimeBudgetParticipant`s (`countActiveRuntimes` + `listEvictableRuntimes`). `enforce(excludeSessionId)` releases at most one runtime per call — the globally least-recently-used releasable one across every registered participant — and yields when nothing is releasable. Constructed once per host (`main.ts`, `bootstrap.ts`) and passed to every project scope's `createAgentChatService`; a service constructed without one gets a private budget, which is the old per-service behaviour and the right answer for tests. Deliberately dependency-free of any runtime type so the LRU choice is testable without standing up a chat service. See [Session lifecycle](#session-lifecycle) below. |
| `apps/desktop/src/main/services/chat/sessionNaming.ts` | Canonical home for everything the three naming callers share — automatic lane identity, chat auto-title, and the legacy lane-name suggestion — because each used to carry its own hand-copied chain that had already drifted. Owns the three system prompts and the lane-identity JSON schema, `MAX_NAMING_WORDS` (six words, handed to the model as a **guideline**: an over-long answer is clamped, never rejected, because a clamped real name beats a slug), `isProviderLevelNamingFailure` (a missing/unusable CLI, auth, quota, or an account that cannot run the model — including the "model is not supported when using X with a Y account" 400; it deliberately excludes "not supported for/on/by", which describes one model lacking a capability and must still retry a sibling), `buildNamingModelCandidates` (preferred ids → a model from a provider none of them belong to → a sibling on the leading provider, so a cross-provider candidate is always reachable), and `runNamingAcrossProviders` (walks the chain up to three attempts; a provider-level failure condemns every remaining model behind that provider, `run` returning null means "answered unusably" and the next candidate still gets a turn, and `shouldStop` abandons the chain when the user renames mid-flight). |
| `apps/desktop/src/main/services/chat/spawnMissionOwnership.ts` | The single statement of who a spawned child chat is currently working for, so the policy is written and tested in one place instead of inline in `reportChildSpawnEnded`. Wake vs quiet is the child's persisted `spawnKind` (`subagent` always wakes; `peer` never does). `isHumanChildMessage` / `countHumanChildMessagesForTurn` / `formatHumanChildMessageAnnotation` name how many human messages landed in a finished turn so the next subagent wake can say `The user also sent N message(s) to this chat.` Parent dispatches, scheduled wakes, relays, host continuations, and any orchestration origin are not human messages. `HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS` / `stripHostAuthoredMessageProvenance` export the same key list to every untrusted entry point (the ADE RPC edge, the automation action bridge) so provenance is always what the host observed, never what a caller asserted. |
| `apps/desktop/src/main/services/chat/chatMentionService.ts` | Composer @-mention service (chats / lanes / terminals), created inside `agentChatService` with injected roster/transcript/PTY deps. Owns the keystroke-rate `chat.listMentionSuggestions` action (daemon-routed, read-only): one shared 1.5 s-TTL roster cache with a single in-flight promise collapses a typing burst into one sessions/lanes/terminals read, per-source failures degrade only their own candidate pool, and ranking/caps come from `shared/chatMentions.ts` (mixed best-match, not per-kind sections). Also owns send-time expansion: `applyChatMentionExpansion` rewrites send/steer args so the provider receives `<ade-mention>` pointer blocks (identity attributes, a ≤1 KB CRLF-normalized neutralized preview, and literal `ade chat read` / `ade lanes show` / `ade terminal read` / `ade search` commands — double-quoted-only so they paste into sh, PowerShell, and cmd) while `displayText` keeps the user's literal chips. Idempotence uses a module-private Symbol marker (structured clone strips it, so nothing over IPC/sync can pre-mark), the single expansion owner on the steer side is `steerWithOptions`, and slash-command prompt rewrites re-attach blocks via `carryChatMentionBlocks`. Lane details never derive git state from `lane.status` (lanes are listed without a status probe and the unprobed default is indistinguishable from clean). Fires the content-free `onMentionsExpanded` analytics hook once per send that actually gained blocks. |
| `apps/desktop/src/shared/chatMentions.ts` | Pure, surface-agnostic mention grammar shared by desktop, TUI, web preview mock, and (future) iOS: `@chat:<id>` / `@lane:<id>` / `@term:<id>` token parsing derived from one prefix table (`CHAT_MENTION_KINDS` is the canonical kind order), word-boundary matching so emails never match, `renderChatMentionBlock` (attribute escaping + preview truncation on line boundaries + neutralization of forged `<ade-mention>` tags and block headers so another session's transcript text cannot inject fake pointer blocks), `rankChatMentionSuggestions` (exact > prefix > substring > subsequence, recency tie-break, deterministic id tie-break — kind is not a sort key), and per-message caps (16 mixed menu rows, 12 expansions, 1024-char previews). Types live in `shared/types/chatMentions.ts`. |
| `apps/desktop/src/shared/composerAtMenuRanking.ts` | Mixed `@` menu ranker used by `ChatCommandMenu` (and the same scorer by the ade-code TUI): files, chats, lanes, and terminals share one score so a better entity is not buried under vaguely matching files. File rows keep the full path as the title (so trailing prose still prefix-matches) and the basename as a subtitle; kind is never a sort key. |
| `apps/desktop/src/main/services/chat/claudePlanMode.ts` | Plan-mode transitions for Claude sessions, extracted from `agentChatService.ts` so the invariant is unit-testable. Entering plan mode sets `claudePermissionMode = "plan"` and stashes the suspended access mode in `claudePrePlanAccessMode` (persisted and rehydrated with the session); leaving restores it. `isSessionInPlanMode` is the single predicate the `ExitPlanMode` gate uses. Moving the access mode is what makes plan mode real: while it stayed on the pre-plan value, a `bypassPermissions` session read as bypass throughout, so the composer chip never left Bypass and the gate auto-approved the plan with no card. See [Agent Routing](agent-routing.md#interaction-mode). |
| `apps/desktop/src/main/services/chat/promptStashService.ts` | Runtime-owned create/list/delete contract for unsent desktop composer text and images. Preserves exact whitespace, accepts attachment-only image stashes, rejects empty or over-200,000-character prompts and malformed attachment references, stores optional provider/model context, returns newest-first rows, and retains at most 20 entries. The PK-only `prompt_stashes` table is CRR-compatible, so text, metadata, image counts, and portable HTTP(S) image references converge through sync. Before committing local images, the composer copies them into the owning runtime; those bytes remain on that runtime. A different synced runtime withholds the machine-bound paths, reports the images as unavailable, and refuses a destructive text-only restore, while connected desktop clients routed to the origin runtime can preview and restore them. Live origin-runtime stash images are excluded from stale temporary-attachment cleanup. Session-bound agent action callers are denied because stash contents are private user drafts. |
| `apps/desktop/src/main/services/chat/providerResumeClassifier.ts` | Classifies Codex resume failures without conflating missing threads with MCP/provider-environment or transient transport failures; rollout-file evidence keeps a locally known thread from being declared missing. |
| `apps/desktop/src/renderer/components/chat/ChatContinuityRecoveryCard.tsx` | Renders the explicit continuity-recovery choices from a `system_notice`: retry the preserved thread, reconstruct from durable ADE history, or start a separate chat. |
| `apps/desktop/src/main/services/chat/chatScheduledWorkScheduler.ts` | Runtime-owned durable mirror and wake coordinator for provider-neutral ADE action schedules plus Claude `ScheduleWakeup`, every successful `CronCreate`, and `/loop`. ADE's mirror is the delivery source of truth; Claude's native scheduler is an advisory latency path. The scheduler gives native Claude fire 90 seconds to claim a due record before ADE's timer backstops it. Every managed chat schedule that becomes due during an active Claude, Codex, Cursor, Droid, or OpenCode turn stays armed and retries in 20-second steps instead of entering that turn's disposable input queue; tracked CLI rows use the same defer loop until `ptyService` confirms a provider-specific composer boundary. Expiry remains authoritative during retries. Native no-id cron claims are limited to due CronCreate-owned rows, so an ambiguous provider event cannot consume a `ScheduleWakeup` or loop. The scheduler persists versioned records, optional provider ids, expiry/terminal timestamps, and per-chat pause state in the project SQLite `kv` store; restores and re-arms them on service start; coalesces overdue work to one late fire; and reports transitions back to `agentChatService`. Startup migration drops the pre-1.2.27 `cron-tool:` intent placeholders that Claude could never cancel, quarantines older active provider rows in a paused state for operator review, and bounds terminal history to the newest 200 rows or seven days. Uses injected time/timer/persistence adapters so restart, pause, collision, migration, expiry, and catch-up behavior can be tested without Electron. |
| `apps/desktop/src/main/services/chat/externalChatHistoryImport.ts` | Converts external Claude JSONL and Codex thread-turn history into ADE `AgentChatEventEnvelope` rows. It reads at most the last 32 MB of source transcript bytes, keeps the newest 2,000 imported content events, emits system notices for provenance/truncation, drops metadata-only/provider-wrapper user rows without stripping user-authored JSX/XML, preserves failed Claude tool-result status, maps user/assistant text plus tool calls/results/file changes/commands/search/image events where available, and derives a fallback imported-chat title from the first user or assistant text. |
| `apps/desktop/src/main/services/chat/runtimeEvents.ts` | Canonical cross-runtime event vocabulary (`turn.*`, `content.delta`, `tool.*`, `subagent.*`, teammate/task events, compaction boundaries) plus shims between legacy `AgentChatEvent` rows and the canonical runtime envelope. Claude emits canonical subagent events alongside the legacy rows while the other adapters migrate. |
| `apps/desktop/src/main/services/chat/contextCompactionEmitter.ts` | Normalizes Claude, Codex, OpenCode, Cursor, and Droid compaction lifecycle events into provider-tagged `context_compact` rows. It pairs started/completed boundaries, preserves provider-reported pre/post token counts and duration, and maintains the per-session compaction count used by transcript surfaces. |
| `apps/desktop/src/main/services/chat/hostSleepChipTracker.ts` | Bookkeeping for the **Paused — computer asleep** chip. Subscribes to the host `MachinePowerSource` (`hostPowerSource` on `createAgentChatService`; `getPowerStateService()` on desktop, `borrowSharedMachinePowerSource()` in the brain) and, on a suspend, emits one `system_notice` per session that actually has a turn in flight — an idle chat gets no chip. The chip is minted under a per-suspend `sleepId` and remembers the turn id it was born under, so the wake resolves it on the same row. It also owns `holdRetry`, the gate that decides whether a provider retry is attributable to the suspend. |
| `apps/desktop/src/shared/hostSleepNotice.ts` | The pure half: the two notice statuses (`host_asleep` / `host_awake`), the message strings, `shouldAttributeRetryToHostSuspend`, and `hostSleepNoticeMergeKey`. Dependency-free so main, renderer, and tests share one rule. |
| `apps/ade-cli/src/tuiClient/` | Terminal **Work** chat TUI (Ink + React): same action/RPC contracts as desktop, **attached** (socket) or **embedded** (headless runtime via `ade-cli`). See [ADE Code](../ade-code/README.md). |
| `apps/ade-cli/src/adeRpcServer.ts` | Runtime action-policy boundary, including the narrow mixed-version kickoff shim. Modern launchers send a new chat's first prompt through `chat.messageSession`; an ADE ≤1.2.41 `chat.sendMessage` request may be normalized only when the target is provably the caller's still-blank direct child. Every other cross-session send remains denied. |
| `apps/desktop/src/shared/modelRegistry.ts`, `apps/desktop/src/renderer/components/shared/ModelPicker/modelCatalog.ts` | Shared static model descriptors plus renderer merge of host-advertised catalogs. GPT-5.6 Sol/Terra/Luna stay first, Sol remains the Codex default, and runtime reasoning ladders pass through in provider order: Max precedes Ultra for Sol/Terra, while Luna ends at Max. |
| `apps/desktop/src/main/services/builtInBrowser/` | Main-process broker and security boundary for the in-app browser. `builtInBrowserService.ts` uses the single persistent `persist:ade-browser` profile for every remote-content tab while keeping visible tab collections independent by ADE window plus project/personal collection. `builtInBrowserProfileMigration.ts` performs one bounded, idempotent migration of unexpired persistent cookies from this channel's legacy project partitions; global cookies win, session cookies are excluded, and legacy directories remain because DOM storage, IndexedDB, service-worker state, and WebAuthn credentials cannot be safely merged. `builtInBrowserStateStore.ts` restores bounded HTTP(S)/blank tab URLs and active-tab selection, but never agent ownership, lightweight sessions, or synthesized session cookies. The service caps each collection at 10 tabs, routes global-session network events by webContents id, preserves OAuth opener relationships, sanitizes download names, captures observations/traces/selections, and tracks per-tab owner/lease metadata. `builtInBrowserAuthentication.ts` owns non-persisted HTTP/proxy credential prompts and explicit client-certificate choice. `builtInBrowserPermissions.ts` persists deny-by-default decisions per requesting/embedding origin. `builtInBrowserAgentAccess.ts` requires a non-persistent human grant for every agent-used non-local origin and for local origins with an allowed privileged permission; it intercepts cross-origin navigation/redirects and blocks sensitive popups until approved. `builtInBrowserActorCapabilities.ts` binds ADE-launched chats to their trusted collection; `desktopBridgeServer.ts` validates those opaque tokens in the issuing Electron process, restores only their bound scope, and separately authenticates the runtime with a rotating desktop-launch token. Unbound/elevated callers cannot force takeovers, forge scope, read another agent's tab status, inspect cookie-domain diagnostics, or administer permissions. `builtInBrowserNavigation.ts` owns protocol policy and `builtInBrowserWebAuthn.ts` resolves credential account selection. Project scratch observations live under `.ade/cache/browser-observations/`; personal observations use the channel user-data `browser-observations/personal/` root. Both can be promoted through the proof broker's narrow import allowlist. The service backs `ade.builtInBrowser.*` and is consumed by `ChatBuiltInBrowserPanel` and `openExternal.ts`. |
| `apps/desktop/src/shared/types/builtInBrowser.ts` | Cross-process types for the built-in browser: `BuiltInBrowserStatus`, `BuiltInBrowserTab` (including per-tab owner/lease metadata), `BuiltInBrowserSession`, `BuiltInBrowserContextItem` (`kind: "built_in_browser_element" | "built_in_browser_capture"`), `BuiltInBrowserSelectResult`, `BuiltInBrowserScreenshot`, `BuiltInBrowserObservation` / `BuiltInBrowserDomSnapshot` / `BuiltInBrowserObservationElementMap`, browser diagnostics/action trace DTOs, agent action args for click/type/key/scroll/fill/clear/wait, `BuiltInBrowserOpenPanelArgs`, and the `BuiltInBrowserEventPayload` union (`status`, `open-request`, `selection`, `selection-cleared`, `error`). Navigate / create-tab / switch-tab args carry an optional `openPanel: boolean` so callers can ask for the Work sidebar Browser tab to flip open atomically with the navigation. |
| `apps/desktop/src/shared/types/personalChats.ts` | Machine-scope personal-chat action, capability, result, queue-policy, and event-stream contract layered over the same `AgentChatSession` DTOs. |
| `apps/desktop/src/main/services/chat/buildClaudeV2Message.ts` | Builds Claude SDK user messages for the `query()` input stream. Handles base64 image content blocks and MIME inference. |
| `apps/desktop/src/main/services/chat/claudeInputPump.ts` | Async iterable input pump that feeds live user turns into the Claude Agent SDK `query()` stream. |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Provider-runtime system-prompt assembly, including runtime-specific native-subagent versus ADE-child routing guidance and the shared scheduled-work contract. |
| `apps/desktop/src/main/services/chat/claudeSdkCompat.ts` | Narrow runtime normalizers for Claude SDK response fields whose published declarations have drifted across SDK releases. It defensively reads interrupt receipt UUIDs (`still_queued`, `cancelled`), rewind `skippedLinks`, and historical/current session-message model fields without casting the whole chat service to an inaccurate SDK shape. |
| `apps/desktop/src/main/services/chat/claudeThinkingTranscriptRepair.ts` | Best-effort repair for Claude SDK JSONL transcripts where multiple distinct assistant responses reused one `message.id`. The repair preserves top-level threading, tool ids, thinking content, and signatures, but rekeys later responses before resume so Anthropic thinking blocks remain in the message shape originally generated by the model. |
| `apps/desktop/src/main/services/chat/chatEnvelopeSpliceRepair.ts` | Resume-time repair for historical ADE envelope streams written before Claude text fragments used the stable SDK message id. It detects only runs of at least three consecutive text envelopes in one turn with distinct message ids, rebuilds from SDK message text when possible (otherwise locally merges), preserves every other JSONL line verbatim, skips files over 64 MB, and rewrites atomically with a one-time `.splice.bak`. |
| `apps/desktop/src/shared/claudeSessionQuota.ts` | Classifies Claude hard session-quota rejects (`session limit` / non-`allowed` `rate_limit_event`), parses reset clocks, and builds the sticky `claude_session_quota` `ade_card`. Approaching (`allowed_warning`) stays a quiet notice. |
| `apps/desktop/src/main/services/chat/claudeSubprocessReaper.ts` | Tracks Claude SDK subprocesses and tears them down on runtime shutdown, plus a tmpdir registry (`ade-claude-subprocesses.json`) so a crashed owner's children are reaped at the next startup. **Both platforms kill the tree, not the leaf — and note the asymmetry, because it inverts the usual assumption: Windows was the platform that had most of this right and POSIX was the weak one.** Windows already routed its SIGTERM and its stale-registry reap through `taskkill /T /F` (`terminateProcessTree` / `killWindowsProcessTree`); macOS and Linux sent a single-pid signal on *every* path and orphaned everything below it. Do not "fix" this back toward the single-pid form on the assumption that the Unix path is the mature one. An SDK process owns 2-4 MCP servers with children of their own, so signalling one pid leaves the fan-out running and a later SIGKILL orphans it permanently: Windows now uses `taskkill /T /F` for the SIGKILL escalation too — that one branch was still a leaf `child.kill("SIGKILL")`, which is exactly what turns a surviving tree into a permanently orphaned one — and POSIX spawns the child `detached` so it leads its own process group and signals `-pid`, falling back to the child handle and then the bare pid. For a stale registry record — no live handle — one `ps -o pgid=,etime=,command=` read answers the identity question Windows puts to `tasklist` (does the live command line still look like the recorded process), plus two Windows has no equivalent for: whether the pid has been alive longer than the record that describes it (a pid younger than its own record was recycled; a minute of clock slack before that verdict), and whether it leads its own group, so the tree can be taken in one signal. Interpreter names (`node`, `electron`, `ade`) are not identity evidence, and the reaper never signals its own pid — both guards exist because a bad accept now force-kills a whole group rather than one process. An unreadable answer still gets reaped as a single pid, because leaking a Claude subprocess is the worse failure. `recordsForSession` backs the live-process line in `ade session show`. |
| `apps/desktop/src/main/services/chat/claudeOutputStyles.ts` | Discovers Claude output styles and plugins from project/user roots, and reads settings values (`readClaudeOutputStyleSelection`, `readClaudeWorkflowSizeGuideline`) across the same file chain the Agent SDK itself resolves, returning `null` when no file declares the key. Project roots are walked directly, while user-installed marketplace plugins are loaded only from Claude's installed-plugin registry when enabled in settings, so cache/source copies do not leak into ADE sessions. The user root and the plugin registry both come from `claudeConfigHome()`, so `CLAUDE_CONFIG_DIR` is honoured; the real `~/.claude` is dropped from the ancestor walk when that variable moved the user tier elsewhere, and roots are de-duplicated through `pathKey`/`pathsEqual` for Windows. |
| `apps/desktop/src/main/services/chat/markdownSlashCommandDiscovery.ts` | Shared markdown-based slash command discovery engine. Provides frontmatter parsing, filesystem walking, command/agent/skill file discovery, command resolution, prompt expansion (`$ARGUMENTS` substitution), ancestor config root traversal, and deduplication helpers. Consumed by the provider-specific discovery modules (`claudeSlashCommandDiscovery`, `codexSlashCommandDiscovery`, `cursorSlashCommandDiscovery`). |
| `apps/desktop/src/main/services/shared/providerConfigHomes.ts` | Resolves each provider CLI's user-level config home (`claudeConfigHome`, `codexConfigHome`, `factoryConfigHome`) and carries the config-ownership rule every provider adapter follows. The three env overrides have different shapes: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` name the config directory, `FACTORY_HOME_OVERRIDE` replaces the HOME that `.factory` is appended to. See [Provider config ownership](agent-routing.md#provider-config-ownership). |
| `apps/desktop/src/main/services/chat/claudeSlashCommandDiscovery.ts` | Discovers Claude-compatible command files plus Agent Skill entries. Delegates to `markdownSlashCommandDiscovery` for filesystem walking and markdown parsing. Command discovery walks ancestor and home `.claude/commands/**/*.md`; skill discovery uses `getAgentSkillRootCandidates()` so `.claude/skills`, `.agents/skills`, `.ade/skills`, `.cursor/skills`, `.codex/skills`, inherited env roots, and bundled ADE resources can surface `*/SKILL.md` command metadata. Consumed by `agentChatService` to enrich `chat.slashCommands` and provider prompt context with local command/skill metadata. |
| `apps/desktop/src/main/services/chat/cursorSlashCommandDiscovery.ts` | Discovers Cursor-compatible slash commands from `.cursor/commands/**/*.md`, `.cursor/agents/**/*.md`, built-in Cursor subagents (`/explore`, `/bash`, `/browser`), and Agent Skill roots. Delegates to `markdownSlashCommandDiscovery` for filesystem walking. Consumed by `agentChatService` for the Cursor provider's `chat.slashCommands` list and by `slashCommandPromptExpansion` for Cursor prompt expansion. |
| `apps/desktop/src/main/services/chat/projectSlashCommandDiscovery.ts` | Unified project-wide slash command discovery. Merges commands from Claude, Codex, and Cursor discovery modules into a single deduplicated list, filtering `/login`. Used by the ADE Code TUI's `discoverProjectSlashCommands` so all providers see the same cross-provider command catalog. |
| `apps/desktop/src/main/services/chat/slashCommandPromptExpansion.ts` | Provider-routed slash command prompt expansion. Given a provider, cwd, and slash command input, resolves the command's markdown body into prompt text through the appropriate provider-specific resolution path (Claude, Codex, or Cursor). Built-in and runtime-registered commands are skipped so the SDK handles them natively. Consumed by `agentChatService` to expand slash commands before dispatch. |
| `apps/desktop/src/main/services/chat/chatTextBatching.ts` | Batches streaming assistant text fragments (100 ms) before emission to reduce renderer re-renders. |
| `apps/desktop/src/main/services/chat/chatTranscriptEntries.ts` | Flattens an envelope stream into the canonical role-tagged `AgentChatTranscriptEntry[]` behind `chat.getTranscript`, the cursor-paged chat-history reader, and the internal auto-title/handoff transcript reads. Its invariant is that a message's canonical text is the **verbatim** concatenation of its `text` fragments: fragments sharing provider identity (the `messageId`/`itemId` *pair* — Claude sets only `messageId`, Codex sets `messageId` per turn and `itemId` per message, so either alone merges distinct messages) concatenate untouched no matter what interleaves, and only `isTranscriptContentEvent` rows (a deliberate *allowlist* of rendered types) end a run, and only for fragments ADE cannot tie to a provider message. Whitespace-only fragments are real deltas and are dropped only when no run is open to continue. Inventing a `"\n\n"` here spliced separators mid-word and made clients that reconcile canonical text against the live stream (iOS, web) render a message twice. See [Transcript and turns](transcript-and-turns.md#canonical-assistant-text-fragile--read-before-editing). |
| `apps/desktop/src/main/services/chat/claudeStructuredActivity.ts` | Normalizes Claude server-owned `web_search` / `web_fetch` and MCP content blocks into the same `web_search` and paired `tool_call` / `tool_result` events used by other providers, including deterministic turn-end closure for unfinished blocks. |
| `apps/desktop/src/main/services/chat/openCodeStructuredActivity.ts` | Maps OpenCode image `file` parts into compact image-generation events, preserving a local saved path when the URL points at a file. |
| `apps/desktop/src/main/services/chat/codexMcpElicitation.ts` | Converts Codex app-server MCP elicitation JSON Schemas into pending-input questions and coerces accepted form answers back to boolean/number/array/object values. Persistent consent is gated by request metadata. |
| `apps/desktop/src/main/utils/codexComputerUse.ts` | Resolves and strictly verifies the OpenAI-signed standalone Computer Use client after explicit user opt-in, then supplies the canonical `computer_use` MCP config to Work chat and tracked Codex CLI launch/resume paths. |
| `apps/desktop/src/main/services/chat/sessionRecovery.ts` | Version-2 persisted-state reconstruction when sessions resume from disk. |
| `apps/desktop/src/main/services/chat/cursorSdkPool.ts` | Cursor SDK adapter: spawns and pools `cursorSdkWorker.ts` Node workers per session, sends turns, brokers permission/hook callbacks, maps SDK events to chat events, and handles teardown. Worker env construction sanitizes ADE/runtime ownership variables while preserving packaged `NODE_PATH` entries through the shared runtime helper so workers copied under `Resources/ade-cli/` can still resolve unpacked app dependencies such as `@cursor/sdk`. The connection envelope carries stable durable-state keys, model parameters, worker request ids, SDK request ids, and structured `CursorSdkErrorDetail` so service logs can correlate ADE chat sessions with Cursor SDK/backend failures. Hook sockets are per worker instance (`…/<poolHash>/<instanceHash>/hook.sock`, unique named pipes on Windows) so a recycle cannot unlink the replacement's policy gate. `poisonCursorSdkConnection(poolKey, generation?)` force-evicts a pooled worker regardless of refcount so the next acquire forks a brand-new one after waiting for the previous process to exit (and fails rather than overlapping if that wait times out): process liveness (`isCursorSdkPooledAlive`) is not connection health, because a run that dies on a transport error leaves the worker process alive while the server-side Cursor agent thread is wedged, and a refcount cannot express that. Pool keys embed the session id, so the lease a refcount decrement would preserve belongs to the same session, never another chat. Cloud oneshot RPCs (`runCursorSdkCloudRequest`) share one `cloud-oneshot:<workspace>` worker whose idle timer lives on the pool entry (60 s, cancelled on the next acquire) so overlapping list/conversation/watch polls cannot collide with Windows named-pipe / state-dir cleanup. |
| `apps/desktop/src/main/services/chat/cursorCloudConversation.ts` | Cursor Cloud conversation unwrap, turn fingerprints, live-run status, and presence-gated inbound-sync helpers. `run.conversation()` is per-run, not full agent history; fingerprints plus prefix/suffix matching let hydrate skip turns ADE already has. `nextCursorCloudMirrorDelay` walks `3s → 8s → 20s → 45s` while a watched chat is quiet and resets to 3 s on new turns. `releaseCursorCloudAttachLease` drops a failed `cloud.run.attach` so watches can poll again. |
| `apps/desktop/src/main/services/chat/cursorCloudMirrorWatch.ts` | Per-session watch refcount + backoff scheduler extracted from `agentChatService`. First watch hydrates immediately; later ticks poll only that session; last unwatch clears the timer. Clients call `ai.watchCursorCloudMirror` (`cursorCloudWatchMirror` in preload). Desktop watches while the selected cloud chat is visible, TUI while that session is active, iOS while the scene is active. The sync host registers `ai.watchCursorCloudMirror` and `ai.openCursorCloudChat` so a web/remote client watching a cloud chat on that machine is a real host command, not an adapter fallback. Cursor Cloud has no create-time webhook, so this poll is the inbound path for an **open cloud chat**. The account-level **fleet view** deliberately does not join this timer: its freshness comes from the Cursor Cloud ingress relay (`cursorCloudIngressService`) re-broadcasting each terminal FINISHED/ERROR delivery as the `ade.ai.cursorCloud.fleetEvent` project event (`main.ts` dispatch), so open fleet surfaces refresh when agents finish and otherwise wait for the manual refresh button. |
| `apps/desktop/src/main/services/chat/cursorCloudFleetService.ts` | Project-scoped Cursor Cloud **fleet view** backend behind `ade.ai.cursorCloud.fleet` / `.pullIntoLane` / `.resolveLane` / `.stopRun` (registered as ADE actions on the `ai` domain and as sync remote commands, so iOS/web reach the same host implementation). An agent belongs to the open project's fleet when either an ADE chat session links to it (`cursorCloudAgentId`) or its repos include the project origin — compared through shared `cursorCloudRepoMatch.ts`, which normalizes SSH, HTTPS, and `.git`-suffixed spellings to one `host/owner/repo` key — and every entry reports which fact matched (`matchedBy: "session" \| "repo" \| "both"`). One page (default 100, cap 200) is deliberately the whole fleet rather than an unbounded crawl; only live rows are enriched with their latest run (concurrency 4), so finished rows cost nothing until a pull or expansion asks. Pull-into-lane resolves the target lane as linked session's lane → any local lane already on the pushed branch → a fresh lane imported from the remote branch, refuses dirty worktrees, fetches + merges `FETCH_HEAD`, aborts the merge and says exactly where things stand on conflict, scopes multi-repo agents to branches pushed to *this* project's repo (branches attributed to other repos refuse instead of falling back to a name-only fetch), and guards remote-reported refs against git argv injection (`safeBranchRef`). `resolveLaneForAgent` is the same resolution without touching git; `stopAgentRun` cancels an agent's latest run even when no ADE chat exists. |
| `apps/desktop/src/main/services/chat/cursorSdkWorker.ts` | Node worker that hosts the official `@cursor/sdk` and bridges it to the main process via the JSON line protocol in `cursorSdkProtocol.ts`. It creates the SDK local agent platform with the lane workspace/state root, configures local agents to use HTTP/1 by default (`ADE_CURSOR_SDK_USE_HTTP1_FOR_AGENT=0` disables it), enables SDK local agent retries, passes ADE mode/idempotency keys on sends, and tolerates stream-iteration failures long enough to call `run.wait()` and emit a structured terminal result. The SDK's `local.force` send option (expire the currently active persisted run before starting this message as a new follow-up) is wired to the explicit `forceExpireActiveRun` payload flag and is set **only** on ADE's automatic recovery re-send — a normal send that expired a genuinely running turn would discard its output. User images are materialized here from attachment paths or URLs (`workerAttachmentImages.ts`) rather than as base64 on the JSON IPC pipe — several large screenshots on `child.send` can stall the turn so Cursor never sees the message. |
| `apps/desktop/src/main/services/chat/cursorSdkErrors.ts` | Cursor SDK error normalization helpers shared by the worker: extracts `code`, `status`, `requestId`, `operation`, and `endpoint` from SDK errors/results, reads terminal run details through the public local store API, and classifies resource/backoff vs transport failures without reaching into private SDK run fields. Classification yields a bare `CursorSdkErrorKind`; there is no companion `retryable` bit, because what a caller does about a failure (recycle the thread, surface a rate limit, re-auth) is decided per call site rather than encoded in the classifier. |
| `apps/desktop/src/main/services/chat/cursorSdkProtocol.ts` | Shared types for the worker IPC: chat mode, approval policy, sandbox mode, hook decisions, hook requests, `CursorSdkModelParameterValue`, `CursorSdkWorkerInit`, local/cloud send payloads, SDK request ids, and `CursorSdkErrorDetail`. User images on those payloads are path/URL references (`CursorSdkUserImage`), not inlined screenshot bytes. It exports Cursor-specific error classifiers for transport (`nghttp2`, dropped sockets, stream closures, plus the socket-side cousins `ECANCELED` / `EPIPE` / `write after end`, which poison the server-side agent thread the same way) and backoff/resource exhaustion (`resource_exhausted`, `rate_limited`, `NGHTTP2_ENHANCE_YOUR_CALM`, 429-style text) so UI/service paths present rate-limit and network failures consistently. `classifyCursorSdkErrorText` returns a bare `CursorSdkErrorKind` (`auth` / `rate_limit` / `network` / `busy` / `not_found` / `unknown`). The expired-short-lived-access-token signature lives here too, as one greppable literal (`CURSOR_SDK_STALE_ACCESS_TOKEN_TEXT`) plus `isCursorSdkStaleAccessTokenText` (matches the sentence's two halves independently, so a reflowed clause or a request-id suffix still matches, while a genuinely bad API key does not) and `readCursorSdkStaleTokenFailure`, which reads the worker's synthetic terminal `status: ERROR` event into a `CursorSdkStaleTokenFailure` (`turnId`, message, optional code and request id) in one pass, or returns `null` for any other error. `CursorSdkPermissionPolicy.fullAuto` is a permission-mode marker only — it separates full-auto sessions into their own worker pool and labels logs, and deliberately does **not** map onto the SDK's `local.force`; run expiry is the separate recovery-only `CursorSdkSendPrompt.forceExpireActiveRun`. |
| `apps/desktop/src/main/services/chat/workerAttachmentImages.ts` | Shared forked-worker image IPC. Composer screenshots become `{ path, mimeType, rootPath }` (Cursor also appends `{ url }` for remote images); the worker re-opens the existing `.ade/attachments` file through `readFileWithinRootSecure` (10 MB cap, same as temp attachments) instead of stuffing screenshot base64 through `child.send`. |
| `apps/desktop/src/main/services/chat/cursorSdkPolicy.ts` | Maps ADE permission modes onto Cursor SDK chat mode + approval policy + sandbox mode (`ade` / `cursor-native` / `off`) plus the `fullAuto` marker; decides which tool calls auto-approve and which require a user prompt. `fullAuto` names ADE's full-auto permission mode and only affects pool partitioning and log labels — it is not a Cursor SDK option. |
| `apps/desktop/src/main/services/chat/cursorSdkSystemPrompt.ts` | Builds the system prompt the Cursor worker injects (lane context, ADE CLI guidance, persona overlays). |
| `apps/desktop/src/main/services/chat/cursorSdkEventMapper.ts` | Translates `@cursor/sdk` stream events into the ADE `AgentChatEventEnvelope` shape consumed by the renderer. SDK `task` messages remain parent-run activity summaries; typed `Task` tool calls/results produce subagent start/result events keyed by tool call id, including the returned child agent id when available. Cursor MCP calls retain provider/tool identity in `event.mcp`; generated-image tools become compact image-generation rows. On a terminal `ERROR` status it reads the worker-injected `adeErrorCode` / `adeErrorDetail`, emits stable user-facing headlines for rate-limit and transport failures (a transport failure reads **Cursor's connection dropped mid-run.** rather than leaking `NGHTTP2_INTERNAL_ERROR` or `[internal] write ECANCELED` into the transcript), preserves exact Cursor request ids/details in `detail`, and sets `errorInfo.category` to `rate_limit`, `network`, `busy`, or `auth` when classification is known. Whenever the friendly headline replaces the raw code, that code is kept as the first `detail` line so the underlying failure is still recoverable from the transcript. |
| `apps/desktop/src/main/services/chat/cursorModelsDiscovery.ts` | Probes the live `@cursor/sdk` and `cursor-agent` CLI model lists, merges their descriptors, and records `cursorAvailability` so chat sessions see SDK-capable models while Work CLI launches can include CLI-only models. Both JSON and text probes preserve aliases, descriptions, `parameters[]`, and `variants[]`; `*-fast` CLI rows are folded into their base model as `aliases` + `serviceTiers: ["fast"]` so the picker shows one model with a Fast toggle instead of duplicate "Fast" rows. Parameter and variant metadata is classified into `reasoningTiers` (`none`/`dynamic`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`thinking`) and `serviceTiers` (`fast`). `resolveCursorSdkModelSelectionParams` rebuilds the matching `CursorSdkModelParameterValue[]` so the SDK boot can target the right variant. The previous minimal `auto` / `composer-2` fallback list has been removed. **Cache resilience:** both the SDK and CLI caches are stale-while-revalidate — last-known-good rows are served well past the 120s freshness window (up to ~6h) and a background warm (at most one attempt per freshness window, so a broken CLI/SDK is not re-spawned on every passive read) refreshes them, so verified-provider models never blink out on passive status reads (`availableModelIds`, mobile, TUI). `markCursorModelCachesStale` ages the caches without dropping rows — generic readiness invalidation (forced status refresh, verifying any provider's key) calls it, while only a cursor key change does a full `clearCursorCliModelsCache`. Auth/SDK-resolution failures drop the SDK cache (a dead key/unusable module must not resurface phantom models); transient failures keep serving last-known-good. When the signed-in CLI reports "No models available" its cache is dropped and a provider runtime failure is surfaced (the stored login lost model access; re-auth via `cursor-agent logout`). |
| `apps/desktop/src/main/services/chat/droidSdkPool.ts` | Droid SDK adapter. Forks `droidSdkWorker.cjs` per session with the caller's `baseEnv` (including ADE session id and role), exposes `acquireDroidSdkConnection` / `releaseDroidSdkConnection`, and proxies prompt sends, settings updates, permission decisions, ask-user responses, and cancellation through the worker. Resolves the Droid SDK CLI executable via `resolveDroidExecutable` (PATH + bundle + configured install paths). |
| `apps/desktop/src/main/services/chat/droidSdkWorker.ts` | Node worker that hosts `@factory/droid-sdk`. Streams SDK events back to the main process and forwards permission / ask-user prompts back through the JSON-line protocol. |
| `apps/desktop/src/main/services/chat/droidSdkProtocol.ts` | Worker IPC types: `DroidSdkSessionSettings` (autonomy level, interaction mode, reasoning effort), `DroidSdkReasoningEffort`, `DroidSdkPermissionRequest`/`Decision`, `DroidSdkAskUserRequest`/`Response`, `DroidSdkReady` (handshake with `availableModels`), and `DroidSdkSendPrompt`. |
| `apps/desktop/src/main/services/chat/droidSdkEventMapper.ts` | Per-session `DroidSdkEventMapperState` + `mapDroidSdkMessageToChatEvents` / `mapDroidSdkRunResultToDoneEvent`. Tracks streaming text/thinking/image item ids, maps tool calls and results, maps `mission_worker_started` / `mission_worker_completed` notifications to provider-neutral subagent lifecycle events keyed by worker session id, surfaces image content as compact generation rows, and reports token usage. Replaces the deleted `droidAcpPool.ts` + `droidAcpEventMapper` path. |
| `apps/desktop/src/main/services/chat/droidModelsDiscovery.ts` | SDK-driven model probe (`listDroidModelsFromSdk`) plus the `<factoryConfigHome>/config.json` custom-proxy merge (`~/.factory` unless `FACTORY_HOME_OVERRIDE` is set — see [Provider config homes](agent-routing.md#provider-config-homes)). Normalizes the generic `opus` row to Opus 5 with its `high` default reasoning effort and Fast capability, while retired factory Claude ids still resolve forward (Sonnet 4.6 -> Sonnet 5, basic Opus 4.7 -> Opus 4.8) before descriptors reach desktop, mobile, or TUI model pickers. Exposes `discoverDroidSdkModelDescriptors` (alias for the legacy `discoverDroidCliModelDescriptors` while callers migrate). |
| `apps/desktop/src/main/services/chat/piSdkPool.ts` | Pi adapter. Forks `piSdkWorker` per session key, exposes `acquirePiSdkConnection` / `releasePiSdkConnection`, and proxies prompts, model/thinking changes, compaction, inventory reads, `login` / `cancelLogin`, and `respondToUi`. Also routes the reverse-RPC UI channel onto `bridge.onUiRequest` / `onUiNotice` / `onUiCancel`; when no `onUiRequest` handler is installed the pool answers `{ ok: false }` immediately, so an unattended worker fails closed instead of hanging a turn. |
| `apps/desktop/src/main/services/chat/piSdkWorker.ts` | Node worker that hosts the user's own Pi installation (resolved at runtime, never statically imported). Owns the Pi agent session, the model runtime, `ModelRuntime.login`, tool assembly (`ask_user` plus approval-gated rebuilds of Pi's built-ins), extension binding, and the settings manager that pins `projectTrusted: false`. User images are materialized here from attachment paths (`workerAttachmentImages.ts`) rather than as base64 on the JSON IPC pipe. |
| `apps/desktop/src/main/services/chat/piSdkProtocol.ts` | Worker IPC types and validators, at protocol version 2. Adds the `ui_request` / `ui_notice` / `ui_cancel` / `ui_response` frames and `login` / `login_cancel` on top of version 1, plus the `extensions` / `askUserTool` / `approvalTools` init flags and the `extensions` / `extensionsError` / `ungateableTools` fields on `PiSdkReady`. User images on send/steer/follow_up are path (or tiny inline `data`) references, not inlined screenshot bytes; remote `url` images are rejected because Pi's prompt API has no URL form. Every frame is validated in both directions. |
| `apps/desktop/src/main/services/chat/piSdkUiBridge.ts` | Worker-side bridge from Pi's callback-shaped UI APIs to ADE cards, with no Pi imports of its own. `createPiUiBridge` is the never-rejecting request channel; `createPiAskUserTool` / `createPiApprovalGate` / `withPiApproval` build the `ask_user` tool and the per-call approval wrapper; `createPiAuthInteraction` implements Pi's `AuthInteraction`; `createPiExtensionUiContext` implements `ExtensionUIContext`. |
| `apps/desktop/src/main/services/chat/piSdkEventMapper.ts` | Pi SDK event → `AgentChatEvent` translation, plus the card helpers: `piUiRequestToPendingInput` (blocking worker request → `PendingInputRequest` with `source: "pi"`), `piUiResponseFromAnswer` (card answer → worker reply, mapping `accept` / `accept_for_session` onto the gate's `allow` / `allow_session` values), `piUiNoticeToChatEvents`, and `piExtensionLoadNotice`. |
| `apps/desktop/src/main/services/chat/piSessionStore.ts` | The one native Pi session store ADE chat, tracked Pi CLI terminals, and external-session discovery all resolve against. `piSessionStoreForEnvironment` returns a `{ root, storageDir }` pair — the root is the authorization boundary, `storageDir` is set only when the user configured one, because Pi nests per-cwd subdirectories only when it is told nothing. Also owns header reads (`readPiSessionHeader`, `piSessionHeaderMatchesCwd`), file authorization (`resolvePiSessionFile`, `classifyPiSessionFile`), the per-cwd listing, and `repositoryOverridesPiSessionDir`. A checkout's `.pi/settings.json` is deliberately never read. |
| `apps/desktop/src/main/services/chat/piSessionLease.ts` | The `<session>.ade-lease` live-writer lock: a pid + process-start-keyed cross-process claim (`owner: "sdk" \| "cli"`) removed on release and reclaimable once its owner is gone. `piSessionLeaseIsHeld` is the cheap pre-launch probe; `piSessionCreationLeaseTarget(sessionRoot, cwd)` is the synthetic per-cwd token held while a session has no JSONL yet (hashed per working directory so one lane's starting chat cannot block every other lane's). |
| `apps/desktop/src/main/services/chat/piSessionOwnership.ts` | The `<session>.ade-owner` durable claim — `{ owner, ownerSessionId }`, never removed, because chat and the tracked CLI share one store and creation-time proximity cannot tell their sessions apart. `piSessionIsAdoptableByTerminal` leaves unclaimed sessions adoptable (a `pi` run started outside ADE) and `piSessionCouldBelongToTerminal` rejects a stored resume pointer at a session older than the terminal itself. |
| `apps/desktop/src/main/services/ai/piAuthService.ts` | In-app Pi sign-in on a dedicated inventory-only worker: provider enumeration, one flow per provider, prompt/notice fan-out through `addPiAuthStatusListener`, prompt answers, cancellation, and a 10-minute bound. A user-pressed cancel gives Pi `PI_LOGIN_CANCEL_GRACE_MS` to report a login it had already completed; a supersede (a replacement attempt) settles the outgoing flow at once and silently, so it cannot clear the card the newer attempt owns. Relays credentials, never retains them. |
| `apps/desktop/src/main/services/opencode/openCodeBinaryManager.ts` | Resolves the OpenCode CLI, and the order is **pinned runtime first**: the machine tools cache (`cachedToolEntryPath("opencode")`), then the bundled platform package, and only then a user-installed binary on PATH / `~/.opencode/bin`. `ADE_DISABLE_BUNDLED_OPENCODE=1` skips both pinned candidates and selects the user install outright; `ADE_OPENCODE_BUNDLE_ROOT` is a hermetic override that suppresses the cache and the user install as well. `resolveOpenCodeBinary` returns the `OpenCodeBinarySource` that won, so callers can tell a pinned runtime from a user install. Cache entries are re-validated with `canRunBinaryCandidate` on every lookup so user installs after launch are picked up; missing-binary lookups are intentionally not cached. `clearOpenCodeBinaryCache()` is wired into the AI integration's full cache reset. |
| `apps/desktop/src/main/services/opencode/openCodeInventory.ts` | OpenCode provider/model probe. Now classifies model variants into `reasoningTiers` + `serviceTiers` (alias map covering `minimal`/`mini`/`med`/`xhigh`/`extra-high`), reads `capabilities` (tools/vision/reasoning) into descriptor capabilities, and exposes `modelIds` — the selectable ids for connected providers only. (Descriptors are still registered for every catalog entry, so an id from an unconnected provider resolves; it just is not offered as a pick.) Anthropic rows normalize generic `opus` to Opus 5 with its `high` default reasoning effort and Fast capability; retired Sonnet 4.6 / basic Opus 4.7 ids still resolve to Sonnet 5 / Opus 4.8 so runtime catalogs cannot reintroduce removed picker rows. `OpenCodeProviderInfo.availableModelCount` exposes the connected count separately from `modelCount`. **Cross-launch persistence:** `persistOpenCodeInventory(projectRoot, providers)` writes each successful probe's provider list (keyed by project root, with `savedAt`) to `opencode-inventory-cache.json` under Electron `userData` (override via `ADE_OPENCODE_INVENTORY_CACHE_FILE`); on a cold start the Settings page reloads that persisted list flagged stale (`opencodeProvidersStale`) so the ~160-provider chip cloud renders immediately instead of blanking until the first live probe (stale-while-revalidate). Writes are best-effort and never break the probe. |
| `apps/desktop/src/main/services/opencode/openCodeRuntime.ts` | OpenCode server session runtime: the single `@opencode-ai/sdk/v2/client` every OpenCode call goes through, session handles over shared/dedicated server leases, the `buildOpenCodeConfig` / `OPENCODE_CONFIG_CONTENT` permission config (`OpenCodePermissionKey`), prompt assembly (`buildOpenCodePromptParts`), event-stream helpers, and the one-shot `runOpenCodeTextPrompt` behind `runProviderTask`. Three contracts are load-bearing. **Re-attach is 404-gated:** when a persisted session id fails `session.get`, only a confirmed "session does not exist" (`isOpenCodeNotFoundError`, HTTP 404 / `NotFoundError`, walking a bounded chain of `cause`/`body`/`error`/`data` wrapper shapes with any explicit non-404 status sealing the walk) may fall through to fresh-session creation; any other failure closes the server lease and surfaces, because silently starting an empty session would strand the user's thread. **System prompts ride the prompt body:** ADE's system prompt travels on the prompt body's first-class `system` field and is never injected as a synthetic/ignored text part — OpenCode drops `ignored` parts from model context entirely, so a part-shaped transport silently never reaches the model. **The `/event` subscription is bounded:** `openCodeEventStream` passes `OPENCODE_SSE_MAX_RETRY_ATTEMPTS` and forwards `onSseError`, because the generated SSE client reconnects forever by default and OpenCode sends no event ids, so a reconnect replays nothing. |
| `apps/desktop/src/main/services/opencode/openCodeAuthService.ts` | Drives the managed OpenCode server's auth API for subscription connect + API-key seeding, reusing the shared inventory server lease (never spawning its own process). `listAuthMethods` reads `GET /provider/auth`; `startOAuth` authorizes (`POST /provider/{id}/oauth/authorize`), opens the returned URL, and polls `provider.list().connected` every 2s until connected or a 5-min timeout, re-probing inventory on success; `cancelOAuth` stops the poller; `setProviderKey` does `PUT /auth/{id}` and mirrors the key into ADE's `apiKeyStore` so it is re-injected on future launches. One flow per `providerId` at a time (a new start supersedes the prior). Transitions are published through `addOpenCodeOAuthStatusListener` (`pending`/`connected`/`cancelled`/`timeout`/`failed`), a multi-sink fan-out so the same event reaches desktop windows and the remote/web runtime event buffer. Seeded credentials land in ADE's isolated managed OpenCode dir (XDG roots under `userData/opencode-runtime/xdg-v*`), never the user's `~/.local/share/opencode`. |
| `apps/desktop/src/shared/chatTranscript.ts` | Pure JSON-lines parser for `AgentChatEventEnvelope` values. Used by both the main process and the renderer. |
| `apps/desktop/src/shared/chatEventCompaction.ts` | The single compaction policy for heavy chat-event payloads, owned by the two consumers that must never disagree: the stored transcript (`compactChatEventForStorage`, called by `agentChatService`) and the mobile/web sync wire (`compactChatEventForWire`, called by the sync host's `compactChatEventEnvelopeForSync`). It owns the whole cap table — command output (4 KB running / 16 KB completed / 64 KB failed), `tool_result.result` (16 KB, 64 KB when failed or interrupted), `tool_result.structured` (8 KB), file diffs (32 KB), reasoning text (8 KB), and inline `data:image/*` URIs (64 KB) — plus `compactRunningCommandOutput`, exported as a whole operation so no caller re-derives the label/budget pairing. Shortened payloads keep original/omitted byte counts on the event (`outputOriginalBytes`, `resultOmittedBytes`, `diffOmittedBytes`, `textOmittedBytes`, `urlOmittedBytes`, …). The wire variant runs storage compaction first, then drops `structured` and `toolResultMeta` from `tool_result` entirely — no renderer, TUI, web, or iOS client decodes either field, so removing them needs no capability gate. |
| `apps/desktop/src/shared/chatSubagents.ts` | Cross-target subagent helpers: `normalizeSubagentLifecycleEvent` (canonicalizes legacy `subagent_*` and dotted `subagent.*` envelopes), the stable `groupPaneSectionItems` partition and pane caps, `buildSubagentPaneRows`, tagged pane click targets, `buildSubagentTranscriptEvents`, `isLifecycleEventForSnapshot`, plus the `latestPlan` derivation. Display-only model chips live here too (`subagentModelAttribution` / `chatInfoHeaderModelAttribution`): a reported envelope `model` is ground truth, and a missing model falls back to the parent session label marked **inherited** — never written onto the envelope. The partition keeps source order, forces pinned rows into the active cap, and excludes visually cleared Completed ids. It also owns the shared subagent-vs-background classification (`isBackgroundShellCommand`, `isRealSubagent`, `isNonAgentTaskRun`, `subagentAgentKey`) — `isNonAgentTaskRun` flags a `task_type` `other` run with no agent metadata (a plain Claude Code task, not a subagent) so both the idle-turn and foreground paths keep it out of the roster. Claude's raw `local_bash` kind is normalized only after explicit background evidence (`background_tasks_changed`, `is_backgrounded`, or `run_in_background`) because foreground Bash emits the same kind. The file also owns summary-quality helpers and `deriveSubagentTimelineRows` → `SubagentTimelineRow` (`spawn` / `result` / `background_chip`) — the portable timeline shape iOS mirrors, not what the desktop transcript renders; that pipeline is `chatTranscriptRows.ts`. Desktop consumes the partition directly; ADE Code consumes the expanded row model; iOS mirrors the same predicates and caps. |
| `apps/desktop/src/shared/chatScheduledWork.ts` | Cross-target scheduled-work validation and derivation. `resolveScheduledWorkTiming` accepts exactly one timing form: five-field brain-local cron, offset-qualified absolute `runAt`, or relative `delaySeconds`; it rejects ambiguous, past, non-integer, and unrepresentable schedules before persistence. The rest of the module folds `scheduled_work_update` envelopes into stable snapshots for Claude wakeups, cron tasks, `/loop`, remote triggers, and background work, then merges the transcript projection with the KV-backed management snapshot from `AgentChatSessionSummary.scheduledWork`. The merge removes stale active durable transcript rows that no longer exist in the management store, preserves provider-only/non-durable activity for display, and marks only ADE-managed rows as cancellable. It also partitions rows by surface: `deriveScheduleItems` returns schedule kinds (`wakeup` / `cron` / `loop` / `remote_trigger`) while `deriveBackgroundItems` returns `background_task` rows that do not duplicate a real subagent with the same `sourceTaskId`. A parent turn's terminal event does not coerce surviving background work to stopped; only an explicit work terminal state or runtime teardown does. `isEarlierBackgroundItem`, `isFiredOneShotWakeup`, and `isEarlierScheduleItem` define the shared Earlier membership mirrored by ADE Code and iOS. |
| `apps/desktop/src/main/services/chat/claudeWorkflowProgress.ts` | Defensive normalizer for the Claude Agent SDK's undocumented `workflow_progress` snapshot on `system:task_progress` (Workflow orchestration runs). Parses phases + per-agent entries (caps counts, clips previews, drops malformed entries, unknown states degrade to queued/running; unparseable snapshots return undefined so the generic task rendering is untouched), then `planClaudeWorkflowAgentTransitions` diffs each cumulative tick against per-task emit state to fan out `subagent_started/progress/result` events under a stable `<taskId>::a<index>` identity with the emitted agentId latched at first emission. Consumed by `agentChatService`'s `task_progress`/`task_notification` handlers and the interrupt path (which close still-running agents as `stopped`). |
| `apps/desktop/src/shared/chatMosaic.ts` | Mosaic v1 — agent-emitted interactive cards. Strict versioned (`"v":1`) parser for ```` ```mosaic ```` fence bodies (`parseMosaicCard`: unknown version/element types, duplicate ids, or malformed JSON → null → callers render the plain fence), submission serializer (`serializeMosaicSubmission`: readable lines + machine JSON, sent through the normal `agentChat.send` path with `displayText`), and `summarizeMosaicCard` for the TUI's one-line summary. Data only — no expressions, no eval, no host actions. Schema documented for agents in the `ade-mosaic` Agent Skill (`apps/desktop/resources/agent-skills/ade-mosaic/SKILL.md`). |
| `apps/desktop/src/renderer/components/chat/MosaicCard.tsx` | Interactive mosaic card renderer (text, select, multiselect, number/slider, input, approve/deny, key-value table). Hooked in at `MarkdownBlock`'s code-fence handler behind a Claude-gated `mosaic` context prop from `AgentChatPane`; answered state persists across virtualized unmounts via a session-lifetime latch that rolls back on send failure. Non-Claude sessions render the plain fence. |
| `apps/desktop/src/shared/types/chat.ts` | All chat types: `AgentChatSession`, `AgentChatEvent` union, `AgentChatEventHistorySnapshot` (with optional `sessionFound` for stale-session detection), provider-neutral `AgentChatMcpToolSource` / app context metadata, Codex goal/token-usage/runtime-state DTOs (`CodexSafetyBufferingState`, moderation metadata, sleep/thread-deleted/stall events), the `web_search` event's structured `CodexWebSearchResult[]` (`results`, max 8) plus `resultsTotal`, typed Codex goal/recovery control args, image generation/view events with large-inline-payload omission metadata, permission modes, pending input (including app-server `autoResolutionMs`), completion reports, `AgentChatMessageSession*` peer-message routing DTOs (`auto` / `queue` / `wake` / `interrupt-replace`), `AgentChatCreateScheduledWork*`, `AgentChatSetScheduledWorkPaused*`, `PARALLEL_CHAT_MAX_ATTACHMENTS`, and parallel launch state DTOs. `AgentChatSubagentSnapshot.label` carries provider-assigned display labels such as Codex Agent #N. `AgentChatScheduledWakeMetadata` marks synthetic unattended user turns with schedule id, kind, fire time, reason, and late state. `scheduled_work_update` captures action/Claude wake/cron/background lifecycle including `paused`, `firedAt`, and `late`; `AgentChatSessionSummary.nextWakeAt` and `scheduledWorkPaused` project durable scheduler state into session lists. `transcript_retraction` removes provider-superseded assistant text from renderers without rewriting the persisted JSONL stream. `user_message` events may also carry metadata such as `hideFullPrompt` for internal handoff briefs, while `displayText` remains the user-facing transcript text. `AgentChatSessionSummary.linearIssueLinks?: SessionLinearIssueLink[]` carries the Linear issues attached to the session (chat or CLI), populated from `session_linear_issues` independent of any lane link. The `session_meta_updated` event additionally carries optional permission/interaction mode fields (`permissionMode`, `interactionMode`, `claudePermissionMode`, `codexApprovalPolicy`, `codexSandbox`, `codexConfigSource`, `opencodePermissionMode`, `droidPermissionMode`, `cursorModeId`, `cursorModeSnapshot`) so a mode change made on one client patches every other client's composer state; a title-only emit carries none of them and stays backward-compatible. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Top-level renderer surface: state derivation, IPC wiring, composer mount, message-list mount, End/Delete chat controls in the header, parallel multi-model lane launch orchestration, transient-lane cleanup, and multi-lane deep-link navigation. Mounts `AskQuestionComposer` in place of the composer textarea when the active pending input is a question/structured-question. Resolves the surface accent colour through `chatAccentForRenderedChat(...)` so Claude/Codex/Cursor stay visually consistent regardless of model variant; the question/plan cards inherit that same `--chat-accent`. The provider comes from the **rendered** session (never the outgoing one), model-derived inputs are withheld until the composer model describes the chat on screen, and an embedding host may supply `lockSessionProvider` so a locked pane paints the right colour on the switch frame instead of borrowing the previous chat's — see [Resolving the accent](composer-and-ui.md#resolving-the-accent-for-the-chat-on-screen). Visible Work grid tiles flush user/lifecycle/live events immediately and poll-recover active transcripts when IPC misses an event, even when the tile is not focused. A visible session whose transcript is still empty but whose summary no longer looks active receives two bounded forced history reads (after 900 ms and 3 s), covering newly-created headless sessions whose first append/event raced the renderer without introducing idle polling. Event-history snapshots with `sessionFound: false` clear stale locked-pane state instead of rendering a dead transcript. Draft chats scope their last-launch config by project/lane/surface/draft-kind and mark local model/reasoning/permission edits as touched so late lane-session hydration cannot overwrite the user's draft selection; composer text is also keyed by the real session id or the lane draft key (`draft:<laneId>`) so switching draft lanes does not leak text through a shared null session key. During project transitions the pane blocks send/model/permission mutations and shows a "Project is switching..." composer placeholder so chat calls do not hit the wrong runtime binding. On macOS, polls `ade.iosSimulator.getStatus` and renders the iOS Simulator drawer toggle in the header when the platform is supported (see [iOS Simulator feature](../ios-simulator/README.md)); selecting elements inside the drawer flows back through the pane as `IosElementContextItem` chips on the composer. Polls `ade.appControl.getStatus` and exposes the App Control drawer toggle when the platform is supported, mounting `ChatAppControlPanel`; selections become `AppControlContextItem` chips + attachments on the composer. See [App Control](../computer-use/app-control.md). When mounted as a Work tile (`SessionSurface` passes `hideLaneToolDrawers={true}`) the iOS, App Control, and chat terminal drawer toggles are suppressed because the Work right-edge sidebar owns those lane-scoped drawers; hidden lane-tool mode also skips App Control status polling and terminal listing. Remote-bound panes keep proof snapshot polling and proof-event subscriptions active for inline proof, while continuing to defer local-only App Control work until its drawer is open, delay unfinished parallel-launch cleanup recovery briefly after mount, cache chat-session lists and slash-command catalogs by active project root, and avoid mount-time session-delta fetches until a remote turn completes. The pane still listens on `ade:agent-chat:add-attachment` / `add-ios-context` / `add-app-control-context` / `add-builtin-browser-context` / `insert-draft` window events so selections from the sidebar flow into the active chat composer; event handlers match on either `sessionId` (for active sessions) or `draftTargetId` (for unsaved draft composers when `draftContextTargetId` is set), enabling the Work sidebar to insert context into a draft composer before a chat session exists. Work-tab CLI launches pass the active lane worktree into the shared launcher so the spawned CLI sees lane-aware Agent Skill roots. Work CLI launches intentionally skip the direct-argv path: the pane drops `command` / `args` from the `onLaunchPtySession` payload and always sends `startupCommand` plus `workCliStartupDelayMs = 180` so the spawned shell can finish drawing its prompt before the CLI invocation is typed in (see [pty-and-sessions.md](../terminals-and-sessions/pty-and-sessions.md#create-flow-createargs) for how `ptyService.create` consumes the delay). The `onLaunchCliSession` prop is typed as `(args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>` and passes `disposition` matching the draft launch mode so background CLI launches do not steal focus. Internal draft launch state is structured through `DraftLaunchMode`, `DraftLaunchKind`, `DraftLaunchLaneTarget`, `StartedDraftLaunch`, and `DraftLaunchJob`. Each draft launch creates a `DraftLaunchJob` that tracks multi-step progress through a state machine (`creating-lane` -> `starting-session` -> `sending-prompt` -> `ready` | `failed`; auto-created lanes are named deterministically up front and the AI rename runs in the background via `startBackgroundLaneNaming` / `startBackgroundParallelLaneNaming`, surfaced through `laneNamingStore`, so there is no blocking `naming-lane` phase) and stores it in the **root** store's `draftLaunchJobsByScope` (read via `useRootAppStore` / `rootAppStoreApi.getState()`) keyed by project root, lane, surface profile, and Work draft kind so loading/error strips survive pane remounts — and a remote project switch that tears down the originating per-project store — without leaking into another lane pane. The detached launch chain captures the originating `OpenProjectBinding`, passes it as a `pin` to branch/lane/chat/orchestration/PTY calls so a mid-launch project switch keeps targeting the originating runtime, pins rollback (`lanes.delete` / `agentChat.delete` with a `pin`) to that binding, and caps each step with `withDraftLaunchTimeout` (90 s). The composer is cleared optimistically when the job starts rather than after it finishes; active jobs remain visible while terminal rows are pruned by scope. The pane renders status strips with Open/Restore for ready/failed jobs, Dismiss for terminal jobs, and a hide-status escape hatch for stale active jobs. Failed jobs offer a Restore button that merges the snapshot back into the composer (merging attachments and context items by identity rather than replacing). `clearDraftLaunchComposer` resets the draft, attachments, and context items after a successful launch. `DraftLaunchJob` carries `draftKind` so the dismissible job strip's "Open" action restores the correct Work draft kind (chat vs. CLI). Locked Work embeddings accept a full session-title index for spawned-chat roster labels, and spawned chats render a type-tinted **View parent thread** header control. Proof remains chat-scoped and stays on the chat header. The pane also owns **per-chat runtime routing**: a lane owns its machine and a chat inherits its machine from its lane, so a chat opened from the union Work sidebar can live on a machine this tab is not bound to. `createChatMachineRouter` (from `renderer/lib/chatMachineRouting.ts`) resolves the chat's lane to the owning `OpenProjectBinding`, and every chat-scoped `window.ade` call passes it as a plain trailing argument read from `chatRuntimePinRef.current` — preload treats `null` and `undefined` identically as "the bound path", so a pinned call and an unpinned one are the same call shape, and the ref lets the ~40 call sites read the pin without perturbing any hook dependency array. The pane resolves the whole scope once through `useChatScopeDerivation` and wraps its subtree in `ChatRuntimeScopeProvider` (both from `ChatRuntimeScope.tsx`) so the pane and its tools cannot disagree about which machine the chat is on. Two derived values it owns directly: App Control support is probed as `appControl.getStatus(chatRuntimePin)` — support is a property of the machine the chat runs on, and the probe used to be skipped entirely for a remote project, which left the toggle permanently hidden, and hiding the toggle is what kept the panel from ever opening to un-skip it; and `iosSimulatorProjectRoot` is `chatLaneWorktreePath ?? (chatRuntimePin ? chatRuntimePin.rootPath : projectRoot)`, the chat lane's checkout on the chat's own machine, because the old global fallback silently handed the local project root to a tool that was about to drive another machine. The pane builds the router's inputs with that module's shared constructors — `collectOpenProjectBindings` (active binding, open remote tabs, open local roots, cross-machine machine slices) and `buildChatMachineRoutingState` (which gives the active binding's live lane list precedence over any cached copy) — the same pair the Work tab's `useWorkMachineRouter` uses for CLI/shell rows, so the two surfaces cannot drift into different definitions of "open" or of lane precedence. A chat on the tab's own binding resolves to `null`, passes no extra argument, and takes the byte-for-byte unchanged path. The tab's binding is never rewritten by opening a chat — rebinding would drag Lanes / PRs / Files / Git / Run with it — and a pin that differs from the active binding is checked with `isLivePinnedBinding` (is it still open?) rather than against the active binding. |
| `apps/desktop/src/renderer/components/chat/ChatRuntimeScope.tsx` | The one answer to "which machine is THIS chat on, and what does it look like there". A lane owns its machine and a chat inherits its machine from its lane, but a Work tab unions chats from every machine on the account, so every chat-scoped surface — Git toolbar, iOS simulator, App Control, built-in browser, file changes, PR pane, terminals — has two candidate answers available to it: the chat's machine, and whatever machine the project tab happens to be bound to. Reading the tab's machine is wrong in exactly the case that matters, and it is the reading every global `useAppStore` selector gives you. `useChatRuntimeScope()` returns `{ pin, binding, laneId, lane, laneWorktreePath, rootPath, isRemote, machineName, online }` from context; `pin === null` means, and only means, "this chat lives on the tab's binding" — the unpinned path, byte-for-byte what the surface did before per-chat routing. Outside a provider it returns the unpinned/local/online fallback, which is how a chat-less surface (a bare preview, a test harness) should behave. `useChatRuntimeScopeForPin(pin, laneId, bindingOverride?)` is the same derivation from a pin handed in as a prop, for surfaces reused outside a chat pane — the CLI session header renders `ChatGitToolbar` with its own pin and no provider above it. `useChatScopeDerivation({...})` asks the same question one level higher: a pane starts from a *session*, not a pin, and has to find the lane (possibly a foreign one, absent from this tab's session list, found through `useForeignSessionLaneId`) before it can find the machine; it returns `chatScopeLaneId`, `chatRuntimePin`, `chatEffectiveBinding`, `isRemoteChat`, `chatMachineName`, `handoffLaneSourceLanes`, and `chatLaneWorktreePath`. `ChatRuntimeScopeProvider` is what `AgentChatPane` wraps its panel/drawer subtree in after resolving the scope once. Four derivation rules the module exists to enforce: a foreign lane is absent from the tab-bound `lanes` array, so its worktree path — and therefore the iOS / App Control project root — is knowable only from the pinned machine's slice of the cross-machine union (`useLanesForPin` in `renderer/state/crossMachineLanes.ts`), and never from `state.lanes`, because lane ids are unique only per machine and that fallback can match a *different* lane sharing the id; `handoffLaneSourceLanes` targets the chat's machine because a brief handoff lands in a lane there, while `availableLanes` / `lanes` describe the tab's bound machine and are right only for an unpinned chat; `online` is false only when the chat's *pinned* machine is known unreachable, since the bound machine's own liveness is the window's problem, not the chat's; and `machineName` comes from `machineNameForBinding` in `shared/machineIdentity.ts` and is always absolute ("This computer", "MacBook Pro (97)"), never the word "remote". The invariant is lint-enforced: `apps/desktop/eslint.config.mjs` bans global-store reads inside `src/renderer/components/chat/**` — `useAppStore` / `useRootAppStore` reads of `projectBinding` or `lanes` (subscribed or through `getState()`), reads of `project.rootPath`, and importing `selectActiveProjectRoot` — with messages pointing callers at `useChatRuntimeScope()`. `AgentChatPane.tsx` (which owns the tab-vs-chat distinction), this module (which is the derivation), and tests are exempt. |
| `apps/desktop/src/renderer/components/chat/usage/contextUsageModel.ts` | Provider-neutral context meter reducer. Automatic per-turn Claude `context_usage` snapshots (`origin: "live"`) are filtered out of the transcript and feed only this reducer, so the composer meter's hover (`ContextUsageDial`) — not an inline card — is the primary context-usage surface; the user-invoked `/context` command (`origin: "command"`) is the only `context_usage` that still renders an inline breakdown card. The reducer reads the snapshot's typed breakdown (`inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens`) so the dial's hover is a complete replacement for that card, falling back to showing the total as input when no breakdown is present. A completed `context_compact` boundary invalidates older usage for Claude, Codex, OpenCode, Cursor, and Droid; generic same-turn counters are ignored because those SDKs can report pre-compaction per-turn/cumulative totals after the history was replaced. Claude `postTokens` / exact `context_usage` and Codex `thread/tokenUsage/updated` snapshots can repopulate the meter immediately. Desktop, ADE Code, and iOS mirror this boundary rule. Codex token breakdowns are normalized in `agentChatService.ts` (`normalizeCodexTokenBreakdown`), which maps 0.145's `cacheWriteInputTokens` / `reasoningOutputTokens` onto `cacheWriteTokens` / `reasoningTokens`; the desktop `ContextUsageDial` tooltip renders `cache write` and `reasoning` segments (in addition to in/out/cached) whenever those counts are present. |
| `apps/desktop/src/renderer/components/usage/ActivityModule.tsx` | Reusable activity, token, code-movement, and client-mix module. `AgentChatPane` mounts `WorkActivityModule` directly below an empty Work draft composer (desktop and web only); it reads `usage.getAdeStats` through the active `window.ade` adapter, defaults to all-time activity, and preserves explicit tab/range choices locally. |
| `apps/desktop/src/renderer/lib/agentChatSessionListCache.ts` | Short-lived renderer cache for `ade.agentChat.list`, keyed by active project root, lane, automation, and archive flags. Normal reads coalesce; forced reads bypass an older in-flight promise, and promise-identity checks prevent the superseded response from repopulating the cache. Mutations invalidate by project/lane so remote Work panes do not fan out repeated list calls while still refreshing immediately after create/archive/delete. |
| `apps/desktop/src/renderer/lib/chatSessionEvents.ts` | Renderer-local chat-session lifecycle helpers. `announceWorkChatSessionCreated` invalidates both Work session-list caches and publishes the durable session; Work and Lanes subscribers seed an optimistic row before their background refresh. `shouldRefreshSessionListForChatEvent` separately gates list refreshes for streamed chat events. |
| `apps/desktop/src/renderer/lib/agentChatSlashCommandsCache.ts` | Short-lived renderer cache for `ade.agentChat.slashCommands`, keyed by project root plus session id or lane/provider. System notices can force-refresh the selected session's commands. |
| `apps/desktop/src/renderer/lib/draftLaunchJobs.ts` | Shared renderer helper for Work draft-launch job DTOs and pruning. Owns `NativeControlState`, `DraftLaunchSnapshot`, `PreparedDraftLaunch`, `DraftLaunchJobStatus`, `DraftLaunchJob`, `isDraftLaunchJobTerminal`, `isDraftLaunchJobStale`, and `pruneDraftLaunchJobs`; active jobs are kept ahead of terminal rows, with terminal rows filling the remaining retained slots and at least one terminal row retained alongside active jobs. Also owns the launch durability constants/helpers: `DRAFT_LAUNCH_TIMEOUT_MS` (90 s) + `withDraftLaunchTimeout(promise, label)` (rejects a launch step whose runtime call never settles; the underlying IPC is not cancellable, so on timeout it keeps running detached and the timeout only unwedges the renderer-side job) and `LAUNCH_PROJECT_CHANGED_MESSAGE` (the legacy/unpinned abort error used only when no originating project binding is available and the active project drifts mid-launch). |
| `apps/desktop/src/renderer/lib/handoffLaunchJobs.ts` | Shared renderer helper for in-flight chat handoff placeholders. Defines the handoff job DTO, scope keying, mode-aware status labels (`preparing-summary` for brief, `forking-history` for fork), search matching, the stable placeholder id used by the Work session sidebar, and `handoffJobLikelyMaterialized` — the ADE-122 dedupe that hides a placeholder as soon as a matching real session row (same lane + tool type, started at/after the job began) is visible, so an in-flight handoff never reads as two new sessions with one vanishing. |
| `apps/desktop/src/renderer/state/appStore.ts` | Shared renderer state store. Besides project/lane/work selection, it persists user preferences such as `launchPromptClipboardEnabled`, `launchPromptClipboardNoticeEnabled`, and the default-on `promptStashButtonEnabled`, mirrors them into per-project stores, and owns `draftLaunchJobsByScope` (+ `setDraftLaunchJobs`) for Work draft launch status strips plus `handoffLaunchJobsByScope` (+ `setHandoffLaunchJobs`) for Work sidebar handoff placeholders. These live in the **root** store (not the per-project store) on purpose: in-flight launches must survive a remote project switch that destroys the originating per-project store; `AgentChatPane` reads them via `useRootAppStore` / `rootAppStoreApi.getState()`. |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | Virtualized transcript renderer. Coalesces resize / measurement updates and, while sticky-to-bottom is active, follows height changes across multiple animation frames so streamed output and late row measurements do not leave the user above the newest message. Programmatic scroll writes are tracked by target scroll position, not a stale counter, so browser-coalesced scroll events do not swallow the next real user gesture. Workspace paths in Markdown links and inline code render with an explicit file glyph/click treatment and open with a relative path + lane id (parsing, resolution, index probing, and the opener live in `chatWorkspacePaths.tsx`, which the list feeds its `runtimePin` so a foreign chat's paths are looked up on the machine that has them). A file in this chat's own lane on this machine opens in the Work tools-pane Files panel next to the conversation; anything else navigates to `FilesTab`, which resolves the target against that machine's workspace roster — so the same click opens the correct file for local, remote-bound, and cross-machine chats without treating a remote path as a local OS file. `work_log_group` rows are filtered out of the rendered timeline entirely — tool calls are reachable from the working indicator and the done divider, and file changes are summarized once per turn by `ChatTurnFilesChangedSummary` at that turn's done divider (suppressed when the turn also emitted a checkpoint-backed `turn_diff_summary`). Older history prefetches roughly two viewport-heights before the top (`resolveOlderHistoryPrefetchTriggerPx`, shared by the scroll handler and the sentinel observer) so the reader normally never sees the head spinner. `stabilizeTranscriptToolActivity` reuses the previous per-turn entry arrays whenever a turn's entries did not change, so a streaming delta does not defeat `React.memo` on every settled turn in the thread. Activity bundles fold todo/scheduled updates and placeholder subagent updates into compact rows, dedupe placeholder subagent parents once the concrete child id is known, and open Chat Info / subagent detail instead of duplicating the drawer roster inline; real subagents instead render as inline `SubagentSpawnCard` / `SubagentResultCard` rows anchored where they started and settled (a backgrounded shell command instead gets a single `BackgroundJobLine` that covers its whole life), with jump-to-result / jump-to-start affordances that reuse the stable-row scroll machinery; a run of two or more interrupt-stopped subagents folds into one calm `SubagentStoppedGroupCard` instead of a wall of identical stopped cards. Synthetic scheduled turns render an amber `Woke on schedule` divider with fire time, reason, and late marker; the existing stable-row scroll machinery accepts jump requests from the while-you-were-away strip. Completed-turn dividers bucket chat-owned proof by capture timestamp, expose a collapsed `N proof` chip, and expand the filmstrip directly beneath the producing turn; there is no proof footer pinned to the tail. Codex goal lifecycle events render as compact user-facing rows (`Goal set`, `Goal paused`, `Goal cleared`) instead of raw JSON-RPC/status wording. Codex runtime notices (`codex_safety_buffering`, `codex_moderation_metadata`, `codex_sleep`, `codex_thread_deleted`) render as small transcript chips. `codex_turn_stalled` renders a live recovery card: Wait re-arms the watchdog, Nudge sends a status steer, Retry interrupts and replays work in the same thread, and Resume restarts app-server, resumes the thread, and retries. Handoff brief user messages with `metadata.hideFullPrompt` show only their `displayText` breadcrumb and do not expose or copy the internal prompt body. History seeded into a forked chat (envelopes tagged `providerOrigin: "handoff_fork"`) renders under a single `Forked from the previous chat — full history above` divider pinned to the first live row after the seeded tail, rather than a per-row marker. Error events whose `errorInfo.agentCli.category` is `"unauthenticated"` render as the calm `AgentCliAuthCard` (raw 401 behind a `Details` disclosure) rather than the red error block, so a recoverable logout reads as a re-login prompt, not a crash. The live turn's `working for <elapsed>` counter is painted imperatively through a callback ref that survives the status line's mid-turn remount (see [composer-and-ui.md](composer-and-ui.md)). It also owns `ChatInfoHostContext`: `AgentChatPane` provides it because it owns the chat actions pane and listens for `ade:chat:open-info`; `PersonalChatsPage` does not, so transcript affordances that reveal that pane render only where dispatching would actually do something. Scoping is per-subtree by necessity — hidden `ProjectSurface`s stay mounted, so a module-level registry would report a host on the one surface that lacks one. |
| `apps/desktop/src/renderer/components/chat/chatHistoryWindow.ts` | Shared bounded-history policy for project and personal desktop chats: canonical event identity, byte estimates and resident caps, page-seam merging, strict cursor advancement, bounded continuation through empty physical pages, and stale-request predicates. `readOlderHistoryBatch` is turn-anchored: because pages are cut by bytes, a page can be entirely superseded streaming deltas that fold to one rendered line, so it keeps pulling pages until the accumulated span contains a `user_message` — bounded by `maxPages` (default 8, covering both empty pages and the anchoring extension) and `maxAnchorEvents` (default 400). Pages already pulled are returned even when a later read reports `sessionFound === false`. Snapshot cursor reconciliation preserves a known exhausted head only when the authoritative refresh overlaps the current window and retains its oldest event; replacement snapshots and cap eviction re-arm paging. |
| `apps/desktop/src/renderer/components/chat/chatWorkspacePaths.tsx` | Workspace-path recognition, resolution, and navigation for every chat surface. Owns `parseWorkspacePathLocation` / `looksLikeWorkspacePath` / `resolveWorkspacePathFromHref` (line+column suffixes, `#L12C3` and `line=` fragments, `file:` URLs, Windows drive paths), `resolveFilesNavigationTarget` (absolute path → longest matching workspace root, preferring the chat's own lane), and the `useWorkspacePathOpener` hook. That hook takes the chat's `runtimePin` (`AgentChatPane` declares it below `chatRuntimePin`, and passes it to `AgentChatMessageList` too) because a chat on another machine reports paths on *that* machine's disk: `listWorkspaces` and the probe below are asked of it, and the workspace-root cache is keyed per machine so a foreign lane id can never resolve against the local roster. A clicked path is probed against the file-name index first (`probeWorkspacePath`): a bare filename resolves to a real path, several same-named files open the search panel instead of guessing, a folder reveals in the tree rather than erroring as a file, and a path under no known root raises a toast instead of the old silent no-op. A probe miss is deliberately **not** fatal for a path containing `/` — the index is stale by design (watcher-fed only while a Files/Git panel is open, gitignored files excluded, capped at 25,000), so the file an agent just created is opened anyway and a real read error is allowed to speak. Routing has two destinations: same machine + the chat's own lane + a `/work` surface goes to the Work tools-pane Files panel through the `files/v2/filesOpenRequests.ts` module channel (no navigation, the conversation stays put); anything else navigates to `/files` with `openFilePath` / `laneId` / `startLine` / `startColumn` plus `openPathType`, `searchQuery`, and `filesPin` in route state. `ChatWorkspacePathProvider` + `useChatWorkspacePaths` / `useChatWorkspacePathOpener` carry that opener through context so shared `ChatMarkdown` (plan cards, question-option previews) can route file paths to the Files tab instead of the browser opener; with no provider a path renders as inert text rather than a guessed URL. Workspace roots load lazily and are cached per module per machine (never on mount), warmed by the first click or by `ensureWorkspacesLoaded`, and force-re-read once after a resolve miss so a lane created since the warm-up is picked up — navigation always resolves against a fresh read, since a stale root that still *matches* would resolve successfully with the previous project's lane id. |
| `apps/desktop/src/renderer/components/chat/chatAppearance.ts` | Chat density/font geometry plus the single responsive transcript width contract. `--chat-content-width` is `min(100%, clamp(720px, 62vw, 1180px))`; `--chat-column` aliases it so prose, composer, cards, pills, plans, file changes, and floating-pane reserve math share one viewport-scaling measure. |
| `apps/desktop/src/renderer/components/chat/chatCardPrimitives.tsx` | Shared transcript-card vocabulary: one `[16px glyph | flexible content | auto meta]` grid, line/inset/bordered/rail/plain skins, status tones, chips/meters/detail rows/diff stats, human-readable agent identity and schedule formatting, and the collapsible proof filmstrip. Passing one-line facts use a hairline row; live/detail-bearing rows use inset chrome; failures use an amber rail rather than a red block. |
| `apps/desktop/src/renderer/components/chat/AdeCard.tsx` | Provider-independent `ade_card` renderer built only from the shared primitives. Shape follows state rather than variant: terminal success is one line, live work adds progress, failures show only warning rows, unknown variants fall back to text + deeplink, and degraded re-emits preserve prior detail as stale rather than blanking it. |
| `apps/desktop/src/renderer/components/chat/SubagentActivityCards.tsx` | Inline subagent transcript cards mounted by `AgentChatMessageList` from the render events `chatTranscriptRows.ts` derives. `SubagentSpawnCard` anchors where the agent started (identicon/colour from `chatSubagentIdentity`, task title, agent-type/background chips, a single live `running · <activity> · <N> tools · <elapsed>` line that ticks each second, and a `jump to result` link once the agent ends); `SubagentResultCard` renders at the settle position (status + duration, ~2-line report preview, View transcript, `jump to start`, warm amber tones for stopped/failed instead of red error blocks); `BackgroundJobLine` is the whole in-thread presence of a backgrounded shell command — one quiet centered rule-line in the scheduled-wake/spawn-return divider idiom (deliberately not a card), pushed when the job starts with a live ticking elapsed and mutated in place to `✓/✗ · exit <code> · <duration>` when it exits, with an `open` affordance that dispatches `ade:chat:open-info` to reveal the actions pane's agents tab where the job's full state lives — omitted entirely on a host that registers no chat-info listener, so it is never a button that does nothing. Its ticker is the file's one shared `useLiveDurationMs` hook (also driving the spawn card), anchored to the real start timestamp so scrolling the row out of the virtualizer and back keeps the true elapsed; it freezes on an ended session, and a job still marked `running` there drops its duration entirely rather than assert an elapsed nobody should read. Status glyphs are Phosphor components, not bare `⚙`/`✓`/`✗` codepoints, which Windows resolves to off-baseline emoji; `SubagentStoppedGroupCard` collapses a run of interrupt-stopped subagents into one amber "N agents stopped when you interrupted" line that expands to a per-agent list with `jump to start` links. All inherit `--chat-accent`. |
| `apps/desktop/src/renderer/components/chat/spawnNavigation.ts` | One canonical `navigateToSpawnedChat(sessionId, laneId?)` helper that dispatches the `ade:work:select-session` window event (behind a try/catch, no-op on a falsy id). Every spawn surface routes through it: the inline `SubagentSpawnCard`, `spawn_wake_divider` and `spawn_completed` completion rows, spawned-chat rows in `ChatSubagentsPanel`, the `AgentChatPane` parent-thread breadcrumb, and the `SessionCard` lineage glyph. `TerminalsPage` resolves an omitted lane from the loaded session list before focusing the target, so cross-lane jumps land on the correct lane. |
| `apps/desktop/src/renderer/components/chat/ChatActionsDrawerPanel.tsx`, `ChatSourcesPanel.tsx`, `chatSources.ts` | Codex Chat Actions source inventory. Sources is the first available tab and derives a deduplicated list of attachments/files, web searches/results, MCP apps/tools, and external resource URLs from the current transcript. HTTP(S) rows open in ADE's built-in browser; internal `node_repl` plumbing and unsafe protocols are excluded. |
| `apps/desktop/src/renderer/components/chat/ChatGitToolbar.tsx` | Git / PR quick-action toolbar above the composer. If the lane already has a linked PR, the PR button opens or toggles that PR; otherwise it routes to the PR workspace with a create-PR handoff (`create=1&sourceLaneId=<lane>&target=primary`). When the chat PR pane or compact PR menu opens, it asks `prReadCache.refreshLinkedPrCoalesced` for a targeted `prs.refresh({ prIds })` so the badge picks up merged/closed/check transitions without broad GitHub polling. An unmapped lane PR (a `github_pr_projections`-derived summary with `pr.unmapped === true` and a synthetic `gh:` id) has no DB row to refresh or fetch checks for, so both the live refresh and `getChecks` are skipped for it. The toolbar is a **status strip only** — the manual PR-sync (↻) control lives in the PR pane's title bar, so surfaces that render the toolbar without a PR pane heal through reconcile-on-focus and `prs-updated` instead. It takes an optional `runtimePin` — the CLI session header renders it with its own pin and no `ChatRuntimeScopeProvider` above it, so it derives its scope with `useChatRuntimeScopeForPin(runtimePin, laneId)` rather than from context. A lane's PR row lives in its own machine's database, so a chat on another machine reads and subscribes through that machine's runtime rather than showing the bare create-PR button for a session that already has one. Effects key on the pin's `key`, not the object, which is rebuilt on every cross-machine merge. Under a pin the unpinned `diff.getChanges` status read is skipped and PR *creation* is withheld — see [Pull requests](../pull-requests/README.md#which-machine-answers-a-pr-read). |
| `apps/desktop/src/renderer/components/chat/ChatPrPane.tsx`, `ChatPrInlineCreator.tsx` | Left floating PR pane for Work chat, with its own title bar (`Pull request` + ↻ refresh + ✕ close) — the manual PR-sync control lives here, not in `ChatGitToolbar`. Renders cached lane PR details immediately, then performs the same cooldown-bound targeted PR refresh as the toolbar before settling the state. Terminal PRs hide stale running-check labels so merged/closed PRs do not keep showing in-progress CI from an old cache row. An unmapped (`pr.unmapped`) lane PR skips the live refresh and the checks/reviews/status enrichment, since it has no DB row behind the synthetic `gh:` id. With no PR it embeds `ChatPrInlineCreator`, whose title defaults to the chat session title — unless the pane carries a `runtimePin`, in which case it says `Switch to <machine> to open one`, because the creator derives its branch, base, and Linear links from the bound machine's lanes and `createFromLane` is unpinned. Reads and the event subscription do follow the pin. The pane's open/closed state is per chat and persisted across restarts through `chatCompanionUiState` — see [Composer and chat UI](composer-and-ui.md#source-file-map). |
| `apps/desktop/src/renderer/lib/visualContextFormatting.ts` | Serializes iOS, App Control, built-in browser, and attachment context into prompt text. |
| `apps/desktop/src/renderer/components/chat/RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | Chat file-rewind confirmation surface. Claude uses the SDK `rewindFiles` control call; Codex uses ADE's git-backed file restore plan plus a version-gated app-server call — `thread/fork` before the target turn on servers >= 0.145.0, and the deprecated `thread/rollback` fallback on <= 0.144 or when the target turn has no usable id (see [agent-routing.md](./agent-routing.md#codex-rewind-and-0145-readiness)). `rewindFilesPreview.ts` maps the selected user message to turn diff summaries and per-file SHA ranges; the dialog lists every restored file, expands rows into `AdeDiffViewer`, and confirms the provider rewind without using browser-native confirm UI. |
| `apps/desktop/src/renderer/components/chat/ChatSubagentsPanel.tsx`, `chatExecutionSummary.ts`, `chatSubagentIdentity.tsx`, `codex/CodexGoalCard.tsx` | Chat Info drawer content: Codex goal card, capped/collapsible plan and task sections, and capped Subagents/Background/Schedule rosters. Every subagent row shows a sentence-case model chip: a reported envelope `model` is ground truth, and a missing model falls back to the parent session label marked **inherited**. Running subagent and background durations derive from the wall clock and tick once per second; terminal rows retain their final compact duration. Terminal work moves into one **Completed** disclosure without reordering survivors; failed and pinned rows stay active; Clear hides only terminal Completed rows and Restore reverses it. Schedule pause/play remains in the Schedule header, recurring rows show last-run plus next-fire timing, and each active ADE-managed durable row exposes Cancel; provider-only/non-durable transcript rows stay visible without a false cancellation control. Spawned-chat snapshots carry a derived `childSessionId`; the derivation preserves the `chat:` task id and `spawnKind` when the canonical dotted lifecycle twin merges into the underscore event. Their roster rows show the child's live session title, put the runtime in the small kind chip, and navigate directly to the child instead of opening a provider transcript drawer. `chatSubagentIdentity.tsx` centralizes deterministic identity and exposes status-optional, size-configurable glyphs for both roster state and compact lineage cues. |
| `apps/desktop/src/renderer/components/chat/ChatBuiltInBrowserPanel.tsx` | Renderer panel for the in-app browser. Renders the address bar, tabs strip, navigation controls, an inspect/select toolbar, and a `BuiltInBrowserStatus`-derived empty/error state, then asks the main process to position the underlying `WebContentsView` over the panel's bounding rect through `ade.builtInBrowser.setBounds`. Its trusted-renderer-only **Profile** panel shows global cookie counts/domains, cache size, last safe flush, and remembered site permissions, with per-row Remove and Clear all controls. Because native `WebContentsView` content sits above the renderer, the panel hides it while ADE overlays, dialogs, menus, or popovers overlap the browser surface so ADE chrome remains reachable. Mounted by `WorkSidebar` under the `browser` tab and (indirectly) by any renderer code that calls `openUrlInAdeBrowser()` — the helper opens the sidebar Browser tab and dispatches the URL into a fresh tab. Selections committed through inspect-mode hit-testing fan out via the `onAddContext` callback as `BuiltInBrowserContextItem` payloads. |
| `apps/desktop/src/renderer/components/work/WorkSurfaceHeader.tsx`, `ClaudeLoginPromptButton.tsx` | Shared Work surface header chrome for chat and CLI surfaces: title, lane chip, Claude cache badge, git toolbar, caller-provided trailing actions, and the dismissible Claude login CTA that starts `claude auth login` in a tracked PTY. The `WorkSurfaceTitle` sub-component plays a one-time CSS shimmer when the title transitions from a provider default (`Claude Chat`, `Codex Chat`, …) to a real auto-generated title while the surface stays mounted, and respects `prefers-reduced-motion`. `AgentChatPane` also reuses `ClaudeLoginPromptButton` as a sticky bar above the composer (keyed `composer-auth:<sessionId>`) while a Claude session is logged out, but only when the chat header pill is absent so the two never double up. The header also takes a `lifecycleSessionId` (the chat pane passes its selected session id) and renders `work/SessionLifecycleChips.tsx` for it — see [composer-and-ui.md › Header](composer-and-ui.md#header). |
| `apps/desktop/src/renderer/components/chat/AgentCliAuthCard.tsx` | Inline install / re-login card for missing or unauthenticated agent CLIs, rendered in the transcript from a decorated `error` event's `errorInfo.agentCli` payload. Copy chips + a tracked-PTY Run button (`window.ade.pty.create`) for the install / auth command. The logged-out (`category: "unauthenticated"`) variant is terracotta-toned for Claude (amber for other agents), retitles to "&lt;Provider&gt; is logged out", and adds an always-on **Retry turn** button that resends the last user message via the `CHAT_RETRY_AUTH_TURN_EVENT` (`ade:chat:retry-auth-turn`) window event; it collapses to a "Reconnected" confirmation when `AgentChatPane` fires `CHAT_AUTH_RECOVERED_EVENT` (`ade:chat:auth-recovered`) after a later turn succeeds. The "missing CLI" variant keeps the red-free amber install card. |
| `apps/desktop/src/renderer/components/chat/ProviderFailureRecoveryCard.tsx` | Classifies terminal provider capacity and usage-limit errors into actionable transcript cards. The card explains that the thread remains safe, offers an explicit same-thread **Retry turn**, and opens the composer model picker through a one-shot request for **Choose model**; neither action is enabled while another turn is active. |
| `apps/desktop/src/renderer/components/chat/chatTurnState.ts` | Shared renderer turn-state invariant used by cache hydration, history snapshots, live event flushes, and locked-session summary refreshes. A terminal `status`/`done` at the end of the transcript outranks an eventually consistent `status: "active"` session summary, so failed/interrupted turns restore an idle composer. Also resolves the user message associated with a failed turn, including Codex optimistic user rows that predate assignment of a provider `turnId`. |
| `apps/desktop/src/renderer/lib/claudeAuthPrompt.ts` | Renderer-side classifier for Claude logged-out / `/login`-required error text. Drives the header and sticky login CTAs; matches both Claude-first wording and ADE's own "Authentication failed for &lt;model&gt;" classified message. |
| `apps/desktop/src/renderer/lib/openExternal.ts` | Renderer-side router for outbound URLs. Defines the `ADE_OPEN_BUILT_IN_BROWSER_EVENT` window event plus `openUrlInAdeBrowser(url)` and `openExternalUrl(url)`. `openUrlInAdeBrowser` dispatches the event (so any open `WorkSidebar` can flip to its Browser tab), then calls `window.ade.builtInBrowser.navigate({ url, newTab: true })`. Anything that is not a normal `http`/`https`/`about:blank` URL falls through to `window.ade.app.openExternal` (system browser). All in-renderer URL clicks (markdown links, lane-runtime open buttons, etc.) go through this helper so the user stays inside ADE. |
| `apps/desktop/src/renderer/components/chat/ChatSubagentTakeoverBanner.tsx` | Non-blocking composer banner on a subagent chat that still reports to its parent. **Take over** demotes to peer; **Keep reporting** and dismiss persist `subagentTakeoverPromptShownAt` without closing the report channel. Sending does not answer the prompt. |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx`, `DraftMachinePicker.tsx`, `useDraftMachineRouting.ts`, `draftAttachmentTransfer.ts` | Composer UI and draft runtime routing: single-session prompt entry, attachments, model/permission controls, slash commands, pending input answering, parallel launch slot configuration, and inline smart-link chips. Running chats show a read-only amber tower plus their owning machine name beside the model and thinking controls; moving a chat is the explicit Chat actions → Handoff → Continue on another machine flow. Completed GitHub, Linear, ADE, and generic web URLs become atomic violet chips while their literal URL remains the serialized prompt text; click/keyboard actions offer Copy link and Remove link, hover exposes the canonical URL, and Backspace/Delete removes the whole token. During an active Claude turn, the split Send caret selects inline, after-turn, or interrupt delivery without sending; the primary button and Enter execute the chosen mode. Staged messages expose send-during-turn, interrupt, cancel, and Edit-back-to-composer actions. Permission popover rows keep only the mode title in the visible row (the explanation remains in the tooltip/title) for every provider-backed picker. Codex MCP elicitations show Allow once / Deny, conditionally show Always allow, and expose safe URL authorization through ADE's browser. Pasted, dropped, and native-path attachments are copied through `ade.agentChat.saveTempAttachment` on the draft's selected runtime, so a MacBook chat never receives a Studio-only path (and vice versa). The launch-prompt clipboard helper is gated separately from prompt copying: `launchPromptClipboardEnabled` controls copying and `launchPromptClipboardNoticeEnabled` controls whether composer reminder text is shown. Orchestration model-selection pending inputs decode the full agent briefing metadata (`workDescription`, `filesHint`, `dependsOn`) so the picker can show what the lead is spawning without preselecting a recommended model. The empty-draft launch shelf separates machine selection (`DraftMachinePicker`) from the lane list, scopes lanes to the chosen machine, and keeps Shell and Import beside the resulting target. It hides the machine control when there is only one choice and preserves Auto-create across machine changes. Attachment storage, model/auth discovery, slash commands, file search, parallel launch state, creation, rollback, and recovery all carry that captured `OpenProjectBinding`; unresolved or disconnected bindings fail closed instead of falling back to the tab's machine. `useDraftMachineRouting` restores the project/tab-selected machine before enabling the composer. When the user changes machines within the same draft scope, `draftAttachmentTransfer` copies pasted/local image bytes from the owning runtime into the newly selected runtime and rewrites their attachment paths; portable image URLs remain unchanged. Non-image files and iOS/App Control/built-in-browser visual context are removed because their paths and ownership cannot move safely. The composer blocks sends while a copy is pending, and a failed copy keeps the source images visible but blocks sending until the user switches back or removes them. A project-tab scope change establishes the restored machine as the attachment owner instead of treating tab hydration as a user-requested transfer. The **This computer** option resolves to *this repository's* local checkout through `thisMachineProjectRoot.ts` rather than to the first open local tab; when no matching local checkout exists, the composer shows an inline dismissible amber notice. |
| `apps/desktop/src/renderer/components/chat/ComposerPromptStash.tsx` | Desktop prompt-stash control mounted immediately left of the context meter. Cmd/Ctrl+S and the bookmark share one path: non-empty text is persisted before the exact saved draft is cleared, while an empty draft opens the keyboard-navigable stash menu. Restore is a take operation, but it puts text into the composer before waiting for a remote delete so edits cannot be overwritten; delete failure intentionally favors a duplicate over lost text. Attachments and context items never enter the stash. |
| `apps/desktop/src/renderer/components/shared/ModelPicker/ReasoningEffortPicker.tsx` | Shared reasoning slider. Supports pointer drag with nearest-tick snap, keyboard arrows/Home/End, a progressive filled gradient, and a directional roll transition for the active tier label, GPT-5.6 labels (Light, Medium, High, Extra High, Max, and Ultra where supported), and an Ultra multi-agent usage note. The collapsed trigger uses full tier names on desktop, keeps abbreviations for narrow/mobile layouts, and does not add a second border around the label. Choosing or dragging to a tier leaves the popover open; outside click or Escape closes it. |
| `apps/desktop/src/renderer/components/chat/ChatModelSelectionPendingCard.tsx` | Pending-input card used when ADE asks the user to choose a model for a new or rerouted agent. It renders the agent briefing, touched files, run-after dependencies, provider/model controls, cancel/confirm states, and leaves the model unset until the user chooses one. |
| `apps/desktop/src/renderer/components/chat/ChatCursorCloudPanel.tsx` | Side panel for Cursor Cloud (background agents): lists existing cloud agents and runs for the lane, lets the user open an existing cloud chat in ADE, archive/unarchive/cancel, and stream run output. Backed by `ade.ai.cursorCloud.*` IPC. |
| `apps/desktop/src/renderer/components/chat/CursorCloudInlineLaunch.tsx` | Inline composer affordance for "Send to Cursor Cloud": picks repo + branch + Cursor Cloud-eligible model, optionally targeting a detected PR, and dispatches the prompt to a fresh cloud agent. |
| `apps/desktop/src/renderer/components/app/CursorCloudQuickViewButton.tsx`, `CursorCloudFleetModal.tsx`, `CursorCloudFleetRow.tsx` | Top-bar Cursor Cloud **fleet view** (see [Composer and chat UI › Cursor Cloud fleet view](composer-and-ui.md#cursor-cloud-fleet-view) for the surface contract). The button mounts beside `LinearQuickViewButton` only while a Cursor connection exists — read through a per-project cached `ai.getStatus` reader (120 s connected / 5 s disconnected TTLs, checked after a 4 s delay and re-queued on bridge-ready) so it never lands in the Work startup IPC window — and counts finishes from `fleetEvent` pushes into an unread badge while the modal is closed. The modal owns filters (status / lane / archived), the active/lane/unlinked grouping, lazy row expansion with usage, all row actions, and the honest relay/key-missing/empty/error states; `FleetRow` renders one row plus its overflow menu. Status derivation lives in shared `cursorCloudFleetStatus.ts` so section placement, Stop-button visibility, and filter results cannot drift between main process and renderer. Opening the modal occludes the built-in browser's `WebContentsView` so native content cannot paint over it. |
| `apps/desktop/src/renderer/components/chat/ChatSurfaceShell.tsx` | Shell that wraps every chat surface (desktop pane, mobile lane, CTO chat) with a unified header/footer slot and `--chat-accent` CSS variable. Supports a `layoutVariant="mobile"` mode that the iOS companion mirrors. |
| `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts` | Chat chrome tokens. Exports `PROVIDER_CHAT_ACCENTS` (claude → amber, codex → warm white, cursor → near-black, droid/factory → burnt orange, opencode → periwinkle, pi → near-black, etc.) and `providerChatAccent(provider)`, plus `NEUTRAL_CHAT_ACCENT` and the single synchronous resolver `chatAccentForRenderedChat({ sessionProvider, lockSessionProvider, modelFamily, modelColor })` — best evidence first, caller-owned staleness, neutral gray rather than a borrowed color (see [composer-and-ui.md](composer-and-ui.md#resolving-the-accent-for-the-chat-on-screen)). The user bubble shades from `--chat-accent` itself rather than mixing toward a fixed violet, so two runtimes with different accents no longer come out the same purple; Claude and Codex are pinned to the original gradient (`ACCENTS_KEEPING_ORIGINAL_BUBBLE`) because they already read correctly, and near-black accents take a lifted gradient (`isDeepChatAccent`, luminance < 0.22) so the bubble does not disappear into the transcript background. iOS mirrors this table in `ADEDesignSystem.swift`. |
| `apps/desktop/src/renderer/components/chat/AskQuestionComposer.tsx` | The ask-question surface, anchored **in the composer** — it replaces the textarea inside the same prompt-box frame while a question blocks (there is no longer a separate `AgentQuestionModal`, no `InlineQuestionRequestCard`, and no question-kind `pendingBanner`). Header is the provider mark + a kind-derived verb (`{Provider} asks` / `{Provider} · Plan ready` via `pendingInputHeaderLabel`) plus a dot rail for paged sets, a minimize `⌄`, and a decline `×`; body shows the question's `header` kicker then the question text once; options render as a one-column ledger with radio/checkbox a11y roles and a flush-right `✓`; option previews render through `QuestionOptionPreview` — a column-preserving monospace `<pre>` for wireframes/ASCII (detected via `looksLikeWireframe`) and the code-fence-aware `ChatMarkdown` for prose — inside a natural-height, capped option region, disclosed by an explicit click rather than hover. Only genuinely long option content scrolls; header, note row, and footer stay pinned. Chrome inherits `--chat-accent` (per-provider), used in exactly two places plus one structural hairline. Keyboard: `1-9` pick, `↵` next/send, `←→` page, `esc` decline. Selecting marks and never submits; a pick and a typed note both travel (see `shared/pendingInputAnswers.ts`). Nothing is preselected. `QuestionReceipts.tsx` renders the transcript record: an "awaiting you" row while open, a one-line expandable receipt once resolved. |
| `apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts` | Two-layer event-to-row pipeline (render events + grouped envelopes) that powers the message list. It threads per-subagent anchor state through the collapse pass to emit identity-keyed `subagent_spawn_anchor` / `subagent_result_card` / `background_job_line` render events (keys `subagent-spawn:` / `subagent-result:` / `background-chip:<agentKey>`), mutating anchors in place as progress/result events arrive and repairing row positions when a `transcript_retraction` splices a row out — so the virtualizer's measured heights survive rebind. `background_job_line` is upserted by two producers on one shared key space — the live runtime's `scheduled_work_update {kind:"background_task"}` and legacy `subagent_*` events carrying `taskType: background` — so a transcript holding both shapes still renders exactly one row per job; a settled row is never reopened by a late progress tick, a task that has opened a job line stays a background job even if a late `agentType` would reclassify it, and a real subagent reported through the background stream has its job line spliced out before its spawn anchor lands. It derives a `scheduled_wake_divider` immediately before every synthetic `user_message` carrying `metadata.scheduledWake` and a `spawn_wake_divider` before completion deliveries carrying `metadata.spawnCompletion`; the latter renders as **Subagent returned** whether the completion steered an active turn or woke an idle chat. It also diffs `todo_update` snapshots per turn so only changed tasks render, normalizes dotted `subagent.*` lifecycle events into the legacy renderer shape while providers migrate, and falls back to a full collapse when incremental append would miss todo state. A second-layer grouping pass (`groupStoppedSubagentResultCards`) folds a run of two or more consecutive interrupt-stopped `subagent_result_card` rows into one `subagent_stopped_group` event; completed/failed cards and a lone stopped card stay individual. It also folds adjacent `spawn_completed` notices for the **same** `childSessionId` into one row carrying a render-only `repeatCount` (drawn as `×N`); the fold consults only the row just appended, which is what keeps incremental and full collapses byte-identical, and a notice whose child cannot be identified never folds. See [Spawn types and completion reporting](#spawn-types-and-completion-reporting). |
| `apps/desktop/src/main/services/opencode/openCodeAdeInstructions.ts` | Writes the ADE instruction file a tracked OpenCode CLI reads through config `instructions`, built from the same `buildCodingAgentSystemPrompt({ runtime: "opencode" })` the chat runtime sends so chat and CLI share one slim ADE base prompt. See [OpenCode CLI ADE instructions](../terminals-and-sessions/README.md#opencode-cli-ade-instructions). |
| `apps/desktop/src/main/services/ai/tools/` | Tool tiers consumed by the service when it provisions a Claude/Codex/OpenCode runtime (see [Tool System](tool-system.md)). |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | Validates chat IPC args, exposes `agentChat.*` handlers (including scheduled-work create, list, per-job cancel, and per-chat pause), persists/retrieves parallel launch recovery state in `kv`, and refreshes the runtime scheduler after the global AI config pause changes. |
| `apps/desktop/src/shared/ipc.ts` | `ade.agentChat.*` IPC channel constants. |

Explicit session metadata regeneration is a user-invoked, one-shot call through the selected chat runtime. It can refresh the chat title, lane name, status line, or all applicable fields together; the primary lane keeps its immutable name, and an explicit request may replace a title previously chosen by the user.

## Built-in browser authentication limits

- Signed, packaged macOS builds embed ADE's Developer ID provisioning profile and configure Electron's Touch ID WebAuthn platform authenticator with the matching `VQ372F39G6.com.ade.desktop.webauthn` keychain access-group entitlement. Source builds leave it off unless `ADE_ENABLE_TOUCH_ID_WEBAUTHN=1` is explicitly set; `ADE_ENABLE_TOUCH_ID_WEBAUTHN=0` is an operational kill switch. The account-selection event always resolves exactly once and uses a native chooser when a site returns multiple discoverable credentials.
- Electron documents these Touch ID credentials as device-bound to that Mac's Secure Enclave and scoped by Electron session metadata. Because ADE uses one global browser partition, the metadata is global across ADE projects in the same release channel, but the credentials are not iCloud Keychain-synced passkeys. See Electron's [`app.configureWebAuthn`](https://www.electronjs.org/docs/latest/api/app#appconfigureweb-authnoptions-macos) and [`select-webauthn-account`](https://www.electronjs.org/docs/latest/api/session#event-select-webauthn-account) contracts.
- ADE does not request Apple's managed-browser public-key credential entitlement or claim native AuthenticationServices integration. It also does not load Apple Passwords or arbitrary Chrome Web Store extensions: Electron supports only a documented subset of extension APIs. Roaming FIDO2 security keys and site-provided WebAuthn flows remain Chromium/Electron capabilities, subject to the hardware and site. See Electron's [extension support boundary](https://www.electronjs.org/docs/latest/api/extensions-api).
- ADE never converts persistent cookies into session cookies or recreates expired/logout-cleared credentials. A clean restart restores tab URLs only; Chromium and each site remain authoritative for cookie expiry and logout semantics.
- HTTP Basic/Digest and proxy authentication use a separate local, sandboxed modal. Entered values go directly to Electron's authentication callback and are never written to ADE storage or logs. Client-certificate requests always require an explicit human choice; cancellation returns no certificate rather than silently selecting the first one.

## Where the chat service runs

The chat service is constructed once per project, inside whichever
runtime owns that project. The desktop renderer talks to it through
the runtime IPC bridge — never directly. When a window is bound to the
local machine, that means the Electron main process's chat service;
when bound to a remote runtime, the **remote `ade serve` daemon**
constructs its own `agentChatService` and the renderer is just a
client. The headless `ade serve` bootstrap in
`apps/ade-cli/src/bootstrap.ts` wires the same `createAgentChatService`
the desktop main process uses, so the surface is identical whether
the host is local Electron or a remote daemon. The iOS app also
reaches the chat service over the same channel (via the sync command
surface), again as a client.

This is the framing to internalise: chat sessions are runtime-owned,
not desktop-owned. The renderer can render them, and the iOS app can
render them, but neither one *runs* them.

## Durable scheduled work

Every chat provider runtime and ADE-tracked provider CLI can create an ADE-owned
schedule through `chat.createScheduledWork`. The action validates a non-empty
prompt (maximum 4,000 characters) and requires exactly one timing input:
`delaySeconds` for a relative one-shot, `runAt` for an absolute one-shot, or a
five-field `cron`. `runAt` must be a future ISO 8601 timestamp with `Z` or an
explicit offset. Cron is interpreted in the ADE brain machine's local timezone,
defaults to recurring, and uses `recurring: false` for a one-shot at the next
cron match. Relative and absolute inputs cannot recur. The result carries the
brain's IANA `timeZone` alongside the scheduled item, whose `nextRunAt` remains
an absolute ISO timestamp, so callers can show and verify both representations.
Its durable id is `action:<sessionId>:<uuid>` and it deliberately has no
provider owner: chat delivery goes through `messageSession({ kind: "wake" })`,
while tracked CLI delivery goes through `ptyService.sendToSession` after a
verified composer boundary. Cancellation is handled directly by ADE rather
than a provider `CronDelete` round trip. Recurring action schedules use the same
seven-day creation TTL as recurring Claude cron rows.

Claude SDK chats can arm `ScheduleWakeup` one-shots, `CronCreate` jobs, and
`/loop` self-pacing work. Claude remains the authority for whether the provider
tool succeeded and for its canonical job id, but ADE's durable mirror is the
source of truth for delivery: the SDK's `CronList` view is advisory and ADE
state wins. ADE records a job only after the SDK's successful
`PostToolUse` hook returns its canonical id, clamped fire time, and recurrence.
A failed tool call or a tool-use intent never creates an ADE schedule. Every
successful `CronCreate` enters ADE's management store with `durable: true`,
even when the tool input omits the flag. Claude's `durable: true` persists the
provider copy to its own scheduled-task store; ADE's mirror is an independent
delivery guarantee and remains authoritative for ADE lifecycle controls.
`CronCreate` always creates a new provider job, so an
agent replacing or resetting a watcher must `CronList` + `CronDelete` the old
job before creating its replacement rather than relying on prompt de-duplication.

ADE maintains a project-scoped durable store under the SQLite `kv` key
`agent-chat:scheduled-work:v1` so a renderer, `ade serve`, or app restart does
not lose the wake boundary. Each record carries the owning ADE session, the
optional exact Claude SDK session that owns provider controls, ADE and optional
provider schedule ids, provider, kind, full prompt/reason, cron or next
fire time, lifecycle and pause state, expiry, last fire, terminal timestamp,
and late marker. Electron main and headless `ade serve` construct the same
scheduler. Claude's Stop/SubagentStop `session_crons` snapshot reconciles the
mirror with provider state, while ADE keeps the full prompt captured at
`PostToolUse` instead of replacing it with the hook's truncated snapshot.
Snapshots are scoped to their exact provider-session owner: a fresh provider
session's empty `session_crons` snapshot cannot cancel, pause, or re-own active
rows created by the prior provider session. If a later snapshot actually
reports an existing unpaused Claude job by canonical id, ADE may adopt that row
to the current provider session. Explicit continuity loss, disposal, or lineage
replacement still quarantines rows whose old provider owner is no longer
reachable.

At service start, armed records are loaded and timers are restored. If the
host was asleep or the runtime was down, an overdue one-shot fires once with
`late: true`. An overdue recurring cron also runs exactly one catch-up turn,
then computes its next ordinary cron occurrence from the current time; ADE
does not replay every missed interval. Paused schedules remain armed. Work
that became overdue while either the chat or global pause was active follows
the same one-late-fire rule after resume.

For Claude-owned rows, the SDK normally fires natively at the scheduled time
and ADE's `claimNativeFire` claims the mirrored record. ADE arms its own timer
for 90 seconds later, giving provider jitter and native delivery time to win;
the timer becomes the backstop when Claude skips a tick or its process is
unavailable. If a managed chat schedule becomes due while its Claude, Codex,
Cursor, Droid, or OpenCode session is mid-turn, ADE leaves the row `scheduled`,
preserves the original `fireAt` and prior fire metadata, and retries after 20
seconds instead of placing the wake in that turn's disposable input queue. This
rule applies regardless of whether Claude or an ADE action created the row. The
overdue row therefore remains claimable when Claude's native scheduler reaches
the turn boundary. A native claim requires an explicit SDK cron-task start. An
exact provider id claims that row; an older task event without an id may claim
only the earliest due CronCreate-owned cron, never a `ScheduleWakeup` or loop.
Unrelated idle background output cannot consume a schedule. If the native tick
does not arrive, a later ADE retry sends a real
`messageSession(kind: "wake")` turn; if the row reaches its expiry, expiry
cancels it without delivery. A native claim also makes any deferred timer a
no-op. Firing at the end of the initial grace window is on time (`late: false`);
a retry that eventually fires beyond grace plus timer tolerance is late.
Provider-neutral schedules become due at their exact `fireAt`, but their actual
delivery can be late when a foreground turn or tracked-CLI readiness boundary
defers them.

Session teardown distinguishes deliberate end from runtime lifecycle. Deleting
or archiving a chat cancels every durable schedule owned by that chat.
Claude-owned jobs are not hidden first: ADE pauses the mirror, sends the owning chat an exact-id
`CronDelete` request (or a prompt-exact `CronList` lookup for a current-session wakeup),
and waits up to 30 seconds for the successful provider hook before an archive
or delete proceeds. A manual Cancel returns immediately with whether provider
cancellation was requested and already confirmed; the paused row stays visible
until confirmation. If dispatch fails or a destructive chat operation times
out, ADE restores the prior pause state and leaves the chat unchanged.
If the job belongs to an earlier SDK session that Claude no longer exposes to
the live chat, ADE cannot truthfully issue `CronDelete` there. An explicit
Cancel, archive, or delete then tombstones the local mirror instead, reports
provider cancellation as neither requested nor confirmed, and never lets an
unreachable provider owner permanently block chat management.

Explicit dispose, continuity replacement, and lane teardown cannot safely
rebind a provider-owned job to a different Claude session. They therefore
pause the durable provider rows for recovery through Settings while cancelling
local-only work. Reconciliation uses the same quarantine rule for a durable
provider job whose owning session has ended or disappeared.

Project close and graceful app quit instead end live chat rows as `detached`;
their schedules remain armed so restart reconciliation can late-fire overdue
work and cold-resume the chat. The scheduler's `sessionState` contract treats
`running` and `detached` rows as `active`, any other non-archived terminal row
as `ended`, archived rows as `archived`, and absent rows as `missing`. A tracked
provider CLI remains an active durable target after its process ends because
`sendToSession` can resume it. Ended, archived, and missing chat owners are
reconciled before delivery: local-only work is cancelled, while durable
provider-owned work is quarantined as paused.

ADE backstop delivery reuses the session peer-message path with `kind: "wake"`.
While any managed chat has a foreground turn, the scheduler keeps its row armed
and retries instead of handing the wake to that runtime's queued input. At the
next safe boundary the service resumes or cold-starts the session and sends a
synthetic turn carrying `metadata.scheduledWake`. Claude's native idle reader
is only the advisory fast path and may claim a mirrored cron only from an
explicit SDK cron-task start. A narrow state race after the scheduler's boundary
check is still handled defensively by `messageSession`: the wake is queued as a
new turn, never steered into the running turn; Codex specifically drains through
its new-turn send path rather than `steer()`. Tracked provider CLI jobs use the PTY service's
provider-specific visible composer check plus a short quiet window; generic
output silence never proves a safe boundary. An ended CLI resumes before
delivery. Proven pre-delivery failures restore and retry the same occurrence,
while ambiguous partial-write failures remain consumed to avoid duplicates.
Untracked shells are not eligible schedule targets. One-shot
lifecycle is `scheduled` -> `fired` -> `completed`; completed
wakeups move into Chat Info history. Recurring cron rows briefly record the
fire, retain `lastRunAt`, and return to `scheduled` with their next fire time.
Durable recurring Claude and action crons expire after seven days. Terminal
rows are retained for at most seven days and the newest 200
records, then pruned. No scheduled-work spend cap is applied.

The startup migration is deliberately conservative. Pre-1.2.27
`cron-tool:<session>:<toolCall>` rows were intent placeholders with no provider
job id, so they are removed. Older active rows without provider metadata are
treated as Claude jobs, paused, and kept in the manager for explicit cleanup;
they are never silently fired or mistaken for an ADE-native schedule.

Controls and summaries project this runtime state rather than owning it:

- Chat Info's Schedule header pauses or resumes every schedule in that chat.
- Active ADE-managed rows in Chat Info have a per-job Cancel action.
- Settings > AI Features has both the persisted project-wide **Pause all
  scheduled work** toggle (`ai.chat.scheduledWorkPaused`) and an **Active
  scheduled work** manager that lists every eligible session's durable job and can cancel
  one directly. Jobs normally clean themselves up; the manager is a recovery
  surface rather than a required setup step.
- `ade chat scheduled-work create` accepts exactly one of `--in <duration>`,
  `--at <ISO-with-offset-or-Z>`, or `--cron "<expr>"`. `--in` supports
  `s`, `m`, `h`, `d`, and `w` suffixes and is the preferred one-shot form
  because it avoids timezone arithmetic; `--at` is also one-shot; `--cron`
  uses the brain machine's local timezone and may add `--once`. All forms
  require `--prompt "<text>"` and accept `--reason "<text>"` / `--session <id>`.
  Text output reports the brain timezone plus the next run in brain-local and
  ISO forms. The command creates an ADE-owned job.
  `ade chat scheduled-work list [session]` lists active managed jobs;
  `--all` includes recent terminal history, and
  `ade chat scheduled-work cancel <session> <id>` routes through the same
  provider-aware cancellation path. The equivalent generic actions are
  `chat.createScheduledWork`, `chat.listScheduledWork`, and
  `chat.cancelScheduledWork`; pause/resume is
  `ade chat schedules <session> --pause|--resume` or
  `chat.setScheduledWorkPaused`; omitting the flag reads the same pause/next-wake
  state through `chat.getScheduledWorkState`. In an ADE-launched chat or tracked provider CLI,
  create/list/cancel default an omitted `sessionId` to `ADE_CHAT_SESSION_ID`;
  the daemon rejects a bound agent that names another session and rejects an
  external caller with no bound session. An ended tracked CLI remains a valid
  target and resumes when its job fires.
- The mobile remote-command registry advertises non-queueable
  `chat.createScheduledWork` and `chat.setScheduledWorkPaused` mutations, plus
  `chat.cancelScheduledWork`. A controller gates create/pause/cancel on the
  connected host's descriptors, so an older host stays read-only for whichever
  controls it does not support. Create is owner-only; Pause/Resume and Cancel
  remain viewer-allowed recovery controls.
- Session summaries expose the earliest unpaused `nextWakeAt` plus the
  authoritative count of live provider background tasks. After the foreground
  turn becomes idle, Work rows show **Working** while background tasks remain,
  then **Waiting** with a compact alarm countdown while a future wake is armed;
  only a chat with neither reads **Done**. Active ADE chats use the current
  `interactionMode` to distinguish violet **Planning** from ordinary
  **Working**; legacy permission flags and CLI terminal text are not treated as
  plan-mode truth. The optional `scheduledWork` management snapshot lets desktop
  merge KV truth over stale transcript projections.
- Account-wide Activity applies the same two facts, so the sidebar and the phone
  cannot disagree about whether a turn is over. The push publisher tracks live
  background-task ids per run and holds a completed turn at `running`, parking
  the real outcome until the last task drains, and the sync roster reports a chat
  with live background tasks as `running` rather than letting it decay
  idle → stale → Done. It also carries `chatActivityMode: "planning"` alongside
  the `running` phase, because the push phase vocabulary is frozen and cannot
  gain a planning value; there is no chat event for an interaction-mode change,
  so the publisher re-reads the session summary on a bounded cadence.
- Every unattended turn starts with a `Woke on schedule` divider. Desktop
  tracks the last viewed time per session in renderer `localStorage` and
  offers a dismissible while-you-were-away strip with jump links to those
  stable divider row keys.

## Key concepts

- **Claude Agent SDK pipeline.** The Claude adapter is built on the
  stable `query()` API and exactly pins SDK `0.3.220` in both the desktop
  and ADE CLI packages so the bundled Claude Code runtime and protocol
  surface are reproducible: every chat owns a `ClaudeQuery`,
  fed by a `ClaudeInputPump` (`claudeInputPump.ts`) async iterable that
  hands live user turns to `query.streamInput`. Warmup goes through the
  SDK `startup()` hook, output styles and plugins are discovered by
  `claudeOutputStyles.ts`, slash commands by `claudeSlashCommandDiscovery.ts`
  (which delegates to the shared `markdownSlashCommandDiscovery` engine),
  and every spawned subprocess is
  tracked by `claudeSubprocessReaper.ts` so runtime shutdown reaps
  child processes. Claude executable resolution prefers an explicit
  `CLAUDE_CODE_EXECUTABLE_PATH`, then the packaged bundled native
  binary, then detected auth/PATH/common locations, and the resolved
  path is passed through `pathToClaudeCodeExecutable`. Context usage,
  rewindFiles, forkSession, and output-style selection all run through the SDK control channel surfaced on the active
  `Query` handle. The `claude_sdk.version` telemetry tag is derived from the
  resolved runtime package metadata (with `0.3.220` only as the partial-install
  fallback), so packaged telemetry reports the SDK that actually shipped.
- **Claude SDK 0.3.220 event surfaces.** ADE enables SDK hook events,
  agent progress summaries, prompt suggestions, defensive filtering of tagged child frames,
  file checkpointing, and all skills for full Claude chats. The adapter
  translates SDK retry/refusal/notification/memory/mirror/permission events
  into `system_notice` rows, drains the SDK-documented post-`result`
  `prompt_suggestion` message, maps Claude `TaskCreate`/`TaskUpdate` tool calls
  into `todo_update` snapshots for the actions-pane task board, and applies
  streamed tool inputs at `content_block_stop`. Claude background/idle turns can
  announce a `tool_use` with empty input and deliver the real JSON only through
  later `input_json_delta` chunks; ADE accumulates those chunks by content index,
  parses the full object at block stop, re-emits the original stable `tool_call`
  item with real args, and runs Task/scheduled-work derivation on that full
  input. Renderer/TUI folds collapse the re-emission by turn + item id, so a
  TaskUpdate completion advances the existing TASKS row without duplication.
  The adapter also preserves
  refusal-fallback retraction UUIDs through `transcript_retraction`, maps SDK
  `supersedes` to the same retraction path, and gives new built-in Claude tools
  readable badges in the transcript. ADE leaves full subagent-text forwarding
  disabled; any tagged child tool/stream frames the parent query still emits carry
  `parent_tool_use_id` and are kept out of the parent transcript. The full child
  transcript is read with the backing Claude session id. Claude sessions keep a long-lived idle reader
  attached after a visible turn completes, and the SDK's
  `system` / `session_state_changed` message with `state: "idle"` is the
  authoritative turn-over signal that closes an open idle turn: it fires after
  `heldBackResult` flushes and the background-agent loop exits, and an idle turn
  is opened by background/subagent output that carries no result envelope of its
  own, so without it such a turn lingers as permanently "running".
  `finishClaudeIdleTurn` no-ops when no idle turn is open, which makes the
  handler safe on every idle transition. Completion here is deliberately
  event-based — a time-based idle watchdog was removed for false positives during
  long tool calls and must not be reintroduced. The background-workload silence
  backstop described below is deliberately not that watchdog: it never runs
  against a live turn (the sweep already requires an at-rest session past its
  idle window), its clock is reset by any emitted event or real background-level
  change, and it reclaims a warm runtime rather than concluding a turn. ADE also consumes `conversation_reset`
  as a real SDK continuity change, deduplicates ADE-owned `command_lifecycle`
  frames, preserves the query when an interrupt receipt reports queued messages,
  and uses the capability-advertised interrupt request with
  `cancel_queued: true` for **Stop & clear queue**. Older compatible runtimes
  fall back to the public interrupt plus the capability-probed
  `cancelAsyncMessage` control for attributed queued steers. **Stop only**
  interrupts the model step while preserving queued messages. The SDK's
  level-triggered
  `background_tasks_changed` set and active subagents protect that query from
  idle-TTL cleanup and runtime-budget eviction until the work actually ends —
  and "actually ends" is enforced rather than assumed. The exemption is cleared
  by every terminal task edge and by the stop paths that settle background work,
  and as a backstop it expires after
  `RUNTIME_WORKLOAD_EXEMPTION_MAX_SILENCE_MS` of total silence — which is
  `SESSION_STALE_AFTER_MS` (3 h), ADE's own cross-surface bar for "nothing has
  happened here", not a shorter private threshold. Past it, every surface is
  already rendering the session neutral **Stale** rather than blue "Background
  work", so reclaiming the runtime agrees with what the product is already
  saying. The backstop exists because the flag used to be self-sealing:
  `liveBackgroundTaskIds` was cleared only by teardown, and the flag itself
  blocked teardown, so one task whose completion edge never arrived pinned the
  SDK process, its MCP children, and the whole project context for the life of
  the app (measured: 5 sessions, 5.4 GB across 35 processes). The level is also
  level-triggered, so an unchanged re-send is silence, not activity — counting it
  reset the idle clock on every frame.
  That level set is also authoritative for whether a `local_bash` task is
  backgrounded: foreground Bash emits the same task kind. Stop-hook snapshots
  retain real child shell/Monitor work but do not project native Agents or
  workflows into a second Background row. Subagent completion keeps Claude's
  status as-is while preferring the SubagentStop hook's real final text over a
  generic task-status summary,
  and SDK result entries prefixed `[ede_diagnostic]` are debug-logged as
  internal lifecycle diagnostics rather than rendered as chat errors; real
  errors in the same result remain user-visible. The successful `PostToolUse`
  hook is the authority for schedule creation/deletion metadata; Stop and
  SubagentStop snapshots reconcile provider state. ADE's durable mirror re-arms
  `ScheduleWakeup`, every successful `CronCreate`, and `/loop` after a runtime
  restart.
  SDK-origin and cold-start wake paths both produce
  synthetic turns plus `scheduled_work_update` snapshots for desktop, ADE
  Code, and iOS Chat Info. SessionStore reads are limited to resume-time
  envelope self-heal and the on-demand provider-fidelity `getMainTranscript`
  IPC (no longer wired to a desktop control — see the gotcha below); ADE
  envelopes remain the normal render backend. Deliberately not wired yet:
  SDK `SessionStore` as ADE's transcript backend and channels/external message
  origins.
  Runtime launch pins the Claude subagent policy explicitly
  (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3`,
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20`) rather than inheriting defaults that
  can change between bundled Claude Code releases. `workflowSizeGuideline:
  "medium"` is ADE's preferred default and is sent only when no settings file in
  the resolved chain states one — ADE's `settings` object lands at flag tier,
  above every `settings.json` the SDK reads, so a key ADE does not own has to
  stay absent. The same rule governs `outputStyle`, which is omitted entirely
  when no settings file names a style. See
  [Provider config ownership](agent-routing.md#provider-config-ownership).
- **Provider-agnostic sessions.** `AgentChatProvider` is one of `claude`,
  `codex`, `opencode`, `cursor`, `droid`, or a free-form string reserved for
  local providers. The service owns a pluggable adapter per provider (Claude
  Agent SDK query stream, Codex JSON-RPC app-server, OpenCode runtime, Cursor
  SDK pool via `cursorSdkPool.ts`, Droid SDK pool via `droidSdkPool.ts`). Both
  Cursor and Droid run their official SDKs (`@cursor/sdk`, `@factory/droid-sdk`)
  in dedicated Node worker children over JSON-line protocols
  (`cursorSdkProtocol.ts`, `droidSdkProtocol.ts`). ADE owns permissions,
  hooks, ask-user prompts, and the system prompt; the SDK owns model + tool
  execution. SDK events are translated to ADE chat events by
  `cursorSdkEventMapper.ts` / `droidSdkEventMapper.ts`. The previous
  ACP-based Droid bridge (`droidAcpPool.ts` / `acpEventMapper`) has been
  retired — only `mapStopReasonToTerminalEvents` is still imported from
  `acpEventMapper.ts` for terminal lifecycle parity.
- **Provider-native subagent lifecycle.** ADE never treats a parent turn's
  terminal event as proof that every child stopped. Codex app-server child
  threads settle from the child's own `turn/completed` / `turn/aborted`
  notification; a parent `turn/completed` may leave independently running
  children in Chat Info. OpenCode child sessions settle on `session.idle`,
  while `session.deleted` means the child was stopped; if the parent becomes
  idle first, ADE keeps consuming the documented session event stream until
  the announced children settle. Cursor's SDK `task` message describes the
  parent run summary, so ADE derives child lifecycle from the SDK's typed
  `Task` tool call/result instead. Cursor currently does not expose a separate
  detached child stream, and ADE says so in the result summary when the Task
  result reports a background launch. Droid already provides the explicit
  `mission_worker_started` / `mission_worker_completed` pair, which remains
  authoritative. Contract references: [Codex app-server 0.144.5](https://github.com/openai/codex/blob/rust-v0.144.5/codex-rs/app-server/README.md),
  [Cursor TypeScript SDK](https://cursor.com/docs/api/sdk/typescript),
  [Droid exec notifications](https://docs.factory.ai/cli/droid-exec/overview),
  and [OpenCode SDK events](https://opencode.ai/docs/sdk/).
- **Delegation routing.** When a provider exposes a native subagent tool, a
  short-lived child whose result belongs in the same SDK thread should stay
  inside that provider runtime. Claude chats use the native `Agent`/`Task` tool
  and its native `model` override for Claude-family model switches rather than
  creating an ADE `--type subagent` chat in the same lane solely to choose
  Opus/Sonnet/Fable. Current runtime guidance maps Codex to its native
  subagent/collaboration tool, Cursor to its native task tool, Droid to its
  native worker/subagent capability, and OpenCode to its native `task` tool.
  Pi's SDK path has no ADE-supported native subagent lifecycle, so independent
  delegation uses an ADE `--type subagent` chat. ADE child chats remain the
  right boundary for durable independent transcripts, scheduling,
  cross-provider execution, separate permissions, or a distinct user-visible
  lifecycle. The always-on runtime prompt and
  `ade-cli-control-plane` skill carry this rule so it applies to both desktop
  and agent-facing flows.
- **Lane-scoped.** Every session carries `laneId`; lane context (branch,
  worktree path) is injected into the system prompt, and working-directory
  resolution runs through `resolveLaneLaunchContext`. The injected ADE
  workspace directive treats the lane worktree as the boundary for
  writes and mutations: read-only inspection outside the worktree is
  allowed when needed, but file edits and mutating commands must stay
  inside the launched lane unless ADE relaunches the session elsewhere.
- **Event stream first.** All transcript content is a JSON-lines stream of
  `AgentChatEventEnvelope` values. Renderer components derive UI state
  entirely from this stream.
- **Pending input abstraction.** Approvals, questions, permission prompts,
  and plan approvals from every provider collapse into
  `PendingInputRequest`. Renderer derives them via
  `derivePendingInputRequests()`.
- **Codex permission switches.** Codex app-server receives approval/sandbox
  changes on thread/turn start. When a live Codex session is switched to
  Full Auto while an active turn still emits approval requests from its
  older policy, the service auto-responds to stale lane-confined
  command/file/permissions gates and clears existing approval cards. Permission
  auto-grants are turn-scoped and validate the request `cwd` and concrete
  filesystem grant paths; escaped or ambiguous whole-root grants remain manual
  and the planner guard still declines mutation requests from turns that
  started in plan mode.
- **Steer queue.** Follow-up user messages during an active turn can be
  staged for the turn boundary (cap 10) with per-entry edit/cancel/dispatch.
  Claude's active-turn composer also supports two atomic SDK deliveries:
  **Send during turn** uses `priority: "next"` plus `shouldQuery: true`, so the
  parent agent consumes it after the current tool step and before its next
  model call; **Interrupt & send** uses `priority: "now"` plus
  `shouldQuery: true`, so Claude redirects the current model step without ADE
  closing the query or killing background work.
  **Cursor** gets the same split control with two modes — **Interrupt &
  continue** (the default) and **Send after turn**. The Cursor SDK has no
  mid-run message API, so there is no "send during turn" there: the redirect
  cancels the run, waits for the turn to settle, and sends the message as the
  next turn on the same agent, which keeps the thread because the SDK's local
  agent store holds it. The transcript shows the previous turn marked
  interrupted, then the new turn streaming. Messages the user had already
  staged survive the redirect (the stop runs in `stop_only` mode with
  `preserveQueuedSteersOnInterrupt` armed until the interrupted turn's own tail
  consumes it, so a slow settle cannot wipe them) and are delivered after the
  redirect turn finishes. This softened stop is Cursor-only: `interrupt-replace`
  on OpenCode, Pi and Droid keeps its previous `stop_and_clear` contract. `dispatchMode: "inline"` on a Cursor session is rejected
  rather than downgraded. Choosing an item in the split
  menu only changes the primary action; the primary button or Enter performs
  the selected action. Every `steer()` call returns
  `AgentChatSteerResult` (`{ steerId, queued, reason?: "queue_full" }`); a
  queue already at its `MAX_PENDING_STEERS` cap comes back
  `queued: false, reason: "queue_full"` rather than silently dropping, the
  queued message's reasoning effort is normalized and applied at delivery
  (not at enqueue). Newly submitted immediate modes are one atomic `steer`
  call and emit one correlated user-message lifecycle event, so they never
  flash as queued or remain duplicated in the staged area. The pending-steer
  queue is persisted
  with chat state so undelivered messages survive restart. Each steer settles
  exactly once in the transcript: the delivered and cancelled notices are all
  emitted behind a per-session claim on the steer id (`settledSteerIds`), and
  the claim is re-opened only when the steer genuinely goes back on the queue
  (a failed delivery, an undone cancellation). Without it, a path that detaches
  a queue while a delivery attempt is also draining it — a Cursor thread
  recycle, a nested turn — could report the same message both delivered and
  cancelled. `sendMessage`
  accepts an opt-in `routeActiveToSteer` flag (overloaded so the steered
  path can return an `AgentChatSteerResult`): when set, a non-empty send
  that arrives while `canRouteActiveSendToSteer` reports the session busy
  is converted into a `steer()` call rather than starting a competing turn.
  The desktop composer already routes its own sends, so this flag exists for
  the sync command handler — a phone that fires `chat.send` mid-turn gets the
  message queued as a steer instead of racing the live turn (see
  [remote commands](../sync-and-multi-device/remote-commands.md)).
  Stop is a separate queue-aware action: active Claude sessions can choose
  **Stop & clear queue** or **Stop only**. Clear is the
  backward-compatible default. If clear cancels an ADE-attributed queued
  message, the transcript exposes one eight-second Undo card backed by
  `restoreCancelledQueue`; expiry is explicit and a restore reuses the
  original steer ids, text, attachments, and context attachments.
- **Identity sessions.** Sessions carrying `identityKey` (now just
  `"cto"`) are filtered out of the Work tab list and rendered by the
  dedicated CTO tab. See [Agent Routing and
  Identity](agent-routing.md).
- **Inline agent CLI install / auth.** When a chat targets a provider
  whose CLI (Claude, Codex, Cursor, Droid) is missing or
  unauthenticated, the service decorates the resulting error envelope
  with an `agentCli` payload (built via `classifyAgentCliError` from
  `apps/ade-cli/src/services/agentRegistry.ts`). The renderer renders
  that as an `AgentCliAuthCard` inline in the transcript: a copy chip
  for the install / auth command and a Run button that opens a
  tracked PTY in the active lane via `window.ade.pty.create`. The
  command runs in the **active runtime** — a remote-bound desktop
  window installs / logs in on the remote machine. Claude 401 /
  `Please run /login` failures also light up a dismissible
  `Login to Claude` action in the shared Work header; it opens the
  chat terminal drawer and runs `claude auth login` in the same
  lane/chat context. See
  [Agents](../agents/README.md#agent-cli-install--auth-from-chat).
- **Claude logged-out (401) fast-fail and recovery.** A 401 is not a
  transient error, so the Claude adapter does **not** let the SDK grind
  through its retry budget ("retry 1/10 … 10/10"). On the first
  definitive auth signal — an `auth_status` error, an `assistant`
  message with `error: "authentication_failed"`, an `api_retry` whose
  `error_status` is 401 (or whose error reads as auth), or a
  `result` whose errors look like invalid credentials
  (`isClaudeRuntimeAuthError`) — `failClaudeTurnUnauthenticated()`
  emits one terse `system_notice` (`noticeKind: "auth"`, "Claude is
  logged out — stopped retrying.") and throws `CLAUDE_RUNTIME_AUTH_ERROR`.
  The catch path recognises it, closes the query (halting further
  retries), reports the runtime auth failure, and emits a decorated
  `error` event carrying `errorInfo.agentCli` (category
  `"unauthenticated"`). Rate-limit / overloaded retries still proceed
  normally. `AgentChatMessageList` renders that decorated error as the
  calm `AgentCliAuthCard` (terracotta-toned for Claude) instead of the
  red error block, tucking the raw 401 text behind a `Details`
  disclosure. The card is always-on recoverable: a **Retry turn** button
  resends the last user message (via the `ade:chat:retry-auth-turn`
  window event that `AgentChatPane` listens for and dispatches into
  `ade.agentChat.send`); if Claude is still logged out the new turn
  fast-fails again and a fresh card appears. When a later turn succeeds,
  `AgentChatPane` dispatches `ade:chat:auth-recovered` and the card
  collapses into a quiet "Reconnected" confirmation. While the session
  stays logged out, the pane also pins a sticky `ClaudeLoginPromptButton`
  bar just above the composer when the chat header login pill is absent,
  so the re-login affordance
  stays reachable after the inline card scrolls away. The renderer-side
  classifier `claudeAuthPrompt.ts` matches the logged-out wording
  (including ADE's own "Authentication failed for &lt;model&gt;" message).
- **Work draft launches.** From an empty embedded Work composer, the
  user can auto-create a lane for a single foreground/background chat
  or CLI session, or enable parallel mode, select two or more
  model/control slots, and send one prompt. The launch flow is
  structured around typed envelopes: `DraftLaunchMode` (`"foreground"
  | "background"`), `DraftLaunchKind` (`"chat" | "cli"`),
  `DraftLaunchLaneTarget` (resolved lane + worktree + auto-created
  flag), `StartedDraftLaunch` (returned session id + kind), and
  `DraftLaunchJob` (multi-step progress tracker). Each launch creates
  a `DraftLaunchJob` with status states `creating-lane` ->
  `starting-session` -> `sending-prompt` -> `ready` | `failed`;
  auto-created lanes start at `creating-lane` because they are named
  deterministically up front (`createDeterministicAutoLaneName`) and
  created without waiting on the model. When AI titles are enabled the
  structured title + branch identity is generated in the background after
  creation. The deterministic fallback remains persisted but is masked by
  `Naming lane…` in lane-label positions until the completed identity is
  refreshed; failures reveal the fallback. This is surfaced through the
  per-lane `laneNamingStore` rather than a blocking launch-job phase.
  Active turns also carry `currentTurnStartedAt`: local optimistic starts and
  authoritative `status: started` events establish it once, while streamed
  activity and steers update `lastActivityAt` without resetting the turn clock.
  Jobs live in the **root**
  `appStore.draftLaunchJobsByScope` (read via `useRootAppStore` /
  `rootAppStoreApi.getState()`, not the per-project store), scoped by
  project root, lane, surface profile, and Work draft kind. The root
  store is used deliberately: a launch can outlive the pane (and its
  project surface) that started it — switching to another remote project
  tears down the originating project's per-project store entirely, which
  would otherwise drop the in-flight job with no trace. Living in the
  root store lets the job re-surface (ready jobs auto-open, failures show
  Restore) when the user returns, while the project-root-keyed scope keeps
  jobs partitioned per project, so a new chat pane or remount does not
  drop loading/error state and another lane pane does not inherit the
  strip. **Project-switch safety:** the launch chain runs detached from
  the pane lifecycle, so it captures the originating project's
  `OpenProjectBinding` up front and passes it as the optional `pin` arg
  (`callPinnedRuntimeAction`, see [Remote runtime internal
  architecture](../remote-runtime/internal-architecture.md#local-runtime-routing))
  to branch discovery, lane create/rename, session start, prompt send,
  orchestration bundle allocation, and CLI PTY create. That lets the
  launch keep running against the project that started it even after
  the active project changes. Only
  the legacy fallback where no binding is available aborts with
  `LAUNCH_PROJECT_CHANGED_MESSAGE` on project-root drift. Rollback of a
  partially-created launch (the auto-created lane via `lanes.delete`,
  the created chat session via `agentChat.delete`) is also **pinned** to
  that captured binding so cleanup deletes the rows it created even
  after a concurrent project switch. The chat-created announcement carries
  that same runtime pin plus the resolved lane name. `TerminalsPage` uses the
  ownership metadata to insert an active-binding chat through the normal
  `useWorkSessions` optimistic path, but projects a chat created on another
  machine directly into that machine's cross-machine Work slice. It never
  fabricates the foreign session in the active binding's local list or selects
  its raw lane id, so a detached launch cannot briefly render a duplicate
  UUID-named lane under the wrong machine. A `DRAFT_LAUNCH_TIMEOUT_MS = 90 s`
  ceiling (via
  `withDraftLaunchTimeout`) fails the job if a runtime call neither
  resolves nor rejects — e.g. a connection dropped mid-switch — so a
  wedged remote call cannot block re-submitting the same draft. The
  composer is cleared optimistically at job creation rather
  than after the async flow completes, so users can
  begin composing the next prompt immediately. Active jobs remain
  visible; terminal rows are pruned per scope while keeping at least one
  terminal row alongside active jobs. The pane renders a status strip
  per job with progress messages, an Open button (ready jobs), a
  Restore button (failed jobs that merges the draft snapshot back into
  the composer), Dismiss for terminal jobs, and a hide-status escape
  hatch for stale active jobs when an async launch never settles. The
  top error banner mirrors Restore for the matching failed job so the
  recovery action is visible where the failure text appears. The
  `DraftLaunchSnapshot` now captures the full composer state including
  `modelId`, `reasoningEffort`, `codexFastMode`, `executionMode`,
  `interactionMode`, and `nativeControls` so that
  `createSessionForLane` and `startDraftCliLaunch` use the
  snapshot's frozen settings rather than the current composer state.
  Foreground auto-create opens the new session in Work only if it is
  still the latest foreground job when the async flow finishes
  (tracked via `latestForegroundDraftLaunchJobIdRef`). Background
  auto-create records the session without stealing focus.
  `clearDraftLaunchComposer` resets the draft text, attachments, and
  context items after a successful launch so the composer is ready for
  the next prompt. CLI draft launches forward the prompt into the PTY
  through `onLaunchCliSession` (typed as `(args: WorkPtyLaunchArgs) =>
  Promise<WorkPtyLaunchResult>`) with `disposition` matching the
  launch mode. Parallel launch still creates child lanes, starts one
  chat in each lane, sends the same prompt and attachments to every
  session, then opens the Lanes view focused on the new lane set.
- **Composer draft persistence.** Draft composer state (text, model,
  reasoning effort, attachments, context items, draft launch target)
  is persisted to `localStorage` under the
  `ade.chat.composerDraft.v1` key family, scoped by
  `projectRoot:companionStateKey:surfaceProfile:workDraftKind`.
  `ComposerDraftStorageSnapshot` is the on-disk shape; it is
  normalized on read through `normalizeStoredComposerDraft` which
  validates every field, re-infers attachment types, dedupes context
  items, and falls back to defaults for invalid entries. On scope
  change (session switch, lane switch) the pane writes the current
  composer state and hydrates the destination scope's saved snapshot,
  restoring model/reasoning/permission settings for draft chats.
  Active session scopes skip model restoration so the session's
  server-side config is not overwritten by a stale draft. The
  persistence effect uses `composerDraftHydratingRef` to skip the
  first write-back after hydration so the freshly restored state
  does not immediately re-persist with a new timestamp.
- **Built-in browser.** The main process owns a persistent
  `persist:ade-browser` partition with multiple `WebContentsView` tabs.
  The Work right-edge sidebar's `browser` tab renders this surface
  through `ChatBuiltInBrowserPanel`; any URL clicked elsewhere in the
  renderer routes through `openUrlInAdeBrowser()` so it opens inside
  the sidebar instead of the system browser. The broker uses
  Electron's stock Chrome User-Agent — header rewriting is gone. Pages
  that call `window.open()` are honoured via `setWindowOpenHandler`
  returning `action: "allow"` with a `createWindow` factory that adopts
  Electron's pre-created `webContents` into a new internal tab; this
  preserves Chromium's popup lifecycle and `window.opener` for OAuth
  `postMessage` callbacks. Foreground popups end Inspect on the opener
  before activating, while deferred `background-tab` popups use the same
  secure browser preferences and load without stealing focus or clearing
  the opener's selection. Every browser view uses a white backing canvas
  so light sites with transparent roots remain readable. Download requests
  are assigned sanitized, unique filenames
  in the user's Downloads folder by the Electron session so download
  buttons do not fall through to unstable default handling. The renderer
  panel hides the native view whenever ADE overlays overlap the browser
  rectangle, since renderer z-index alone cannot cover a `WebContentsView`.
  Permission requests are deny-by-default and accepted only for managed
  browser web contents on secure origins. Promptable permissions use a
  native Allow / Block dialog and can be remembered per requesting and
  embedding origin; unknown permissions remain blocked. Google Accounts
  retains only a narrow compatibility exception for `storage-access` and
  `top-level-storage-access`. The toolbar's **Profile** panel shows
  non-secret cookie/cache/flush diagnostics and lets the human remove one
  or all remembered permission decisions. Those diagnostic and
  administration APIs are renderer-only and are not exposed through
  `ade browser`.
  Navigation, tab create, switch-tab, and the dedicated
  `built_in_browser.showPanel` / `ade.builtInBrowser.showPanel` IPC
  channel each accept `openPanel: true|false`; `true` emits an
  `open-request` event that `TerminalsPage` listens for to flip the
  Work sidebar to its Browser tab. The `--no-panel` / `--hidden` flags
  on the matching `ade browser ...` CLI commands set `openPanel: false`
  so headless callers can prefetch tabs without yanking the user's
  attention. Browser commands are available only inside an ADE-launched,
  chat-bound agent or owned terminal carrying a valid browser actor
  capability; an unbound shell cannot use the human-authenticated profile.
  Inspect-mode hit-tests produce `BuiltInBrowserContextItem`
  payloads that the sidebar forwards to the active chat as composer
  chips alongside iOS / App Control selections.
- **Localhost shortcuts in the work log.** When an agent's tool output
  surfaces a `localhost`/`127.0.0.1`/`0.0.0.0`/`[::1]` URL, the chat
  work-log block renders a sky-toned strip above the tool-call panels.
  The primary chip opens the URL inside the ADE built-in browser
  (`openUrlInAdeBrowser`); a sibling Logs button reveals the chat's
  active terminal inside the bottom drawer through `onRevealChatTerminal`,
  or — when no terminal exists yet — drafts a guided "please move this
  server into the chat terminal" prompt for the agent through
  `onInsertDraft`. URLs are extracted from `entry.localUrls` (set by
  `withLocalhostUrls` in `chatTranscriptRows.ts`) so the strip works
  uniformly across shell commands, tool calls, and arbitrary tool
  results.

See the detail docs for the specifics:

- [Transcript and Turns](transcript-and-turns.md) -- event envelope,
  message/tool lifecycle, batching, virtual scrolling.
- [Tool System](tool-system.md) -- three tiers (universal, workflow,
  coordinator) and their gates.
- [Agent Routing](agent-routing.md) -- provider selection, permission-mode
  mapping, model registry, handoff.
- [Composer and UI](composer-and-ui.md) -- composer, tasks, file changes,
  terminal drawer, message list.

## Pi UI bridge, `ask_user`, and extensions

Pi asks the human questions from three unrelated places — `AuthInteraction`
during login, a custom tool's `execute`, and an extension's UI context — and all
three are plain callbacks that block until they get a value back. `piSdkUiBridge`
funnels them into one reverse-RPC channel (protocol version 2) so the desktop
process has a single place to render a card and a single place to fail one
closed.

The channel carries four frame types: `ui_request` (worker → desktop, blocking),
`ui_response` (desktop → worker, reusing the request id), `ui_notice` (worker →
desktop, non-blocking), and `ui_cancel` (worker → desktop, "I settled this
myself"). Every request carries an `origin` of `auth`, `tool`, `extension`, or
`approval`, which decides both the card shape and which requests a targeted
drain affects.

`bridge.request()` never rejects. A dismissed card, an aborted turn, an
extension's own timeout, a malformed abort signal, or a disposed worker all
resolve to `null`, so a Pi callback awaiting an answer degrades to "no answer"
instead of throwing through the SDK's error channel. The desktop side has the
matching obligation: the worker is holding a Pi callback open, so every path out
of `presentPiUiRequest` must end in exactly one `respondToUi` — including
interrupt and teardown, which `cancelPendingInputsFrom(managed, "pi", "ade")`
drains. That helper is shared and variadic, and every caller must pass **every**
source the ending turn owns: a turn owns its own provider's cards *and* the
`ade` cards ADE's own tools raised during it, and either kind alone keeps
`hasPendingInput` reporting the session as blocked. OpenCode drains
`"opencode", "ade"` on its interrupt and error paths; Codex drains
`"codex", "ade"` from inside `settleCodexPendingInputs`.

Requests become ordinary ADE pending inputs with `source: "pi"`, so they reuse
the existing question-card, approval-card, and `respondToInput` machinery rather
than adding a Pi-specific surface. A request with options becomes a
`structured_question` whose answer must be a pick (free text would not match the
option id Pi expects back); one without becomes a free-text `question`; an
`approval` origin becomes an approval card. A `secret` prompt marks the question
`isSecret`.

**`ask_user`.** ADE injects an `ask_user` custom tool into every Pi chat,
including personal chats — it is how the model checks in mid-turn, which no tool
allowlist can express. The model supplies a question, an optional short header,
and optional labelled choices; the answer comes back as text. Declining is not
an error: the tool returns "the user did not answer, continue with your best
judgement and state the assumption you made."

**Approval gating.** `bash`, `edit`, and `write` are rebuilt from Pi's own
definition factories and wrapped so each call clears an approval card first. See
[Agent Routing › Pi](agent-routing.md#pi) for the full mode-to-policy table and
the `ungateableTools` fallback.

**Extensions.** The user's Pi extensions load in ADE chat by default
(`ai.chat.piExtensionsEnabled`), matching what `pi` does in a terminal, bound to
an ADE implementation of Pi's `ExtensionUIContext`:

- `select` / `confirm` / `input` / `editor` become ADE cards. A dismissal, a
  timeout, and an abort all read as "no answer" — which for `confirm` means
  deny.
- `notify` / `setStatus` / `setWorkingMessage` / `setTitle` become thread
  notices; `progress`-level notices render as activity rather than as a
  system notice.
- TUI-only surfaces (widgets, footers, headers, editor hooks, autocomplete,
  themes) no-op. Anything whose absence the user could notice warns **once** per
  method, so a chatty extension cannot spam the thread. Purely visual ones are
  silently ignored.

Three boundaries are deliberate and load-bearing:

- **Repository code never loads.** The worker builds Pi's `SettingsManager`
  itself with `projectTrusted: false` and passes it to both the resource loader
  and the session. Pi treats a trusted project as permission to auto-load and
  execute extensions from the checkout's own `.pi/` directory; ADE opens
  repositories the user has not vouched for, so only the user's own
  `~/.pi/agent/extensions` may load. If a Pi build will not let ADE pin that
  flag, extensions stay **off** rather than loading repository code ADE cannot
  constrain, and the reason is surfaced as `extensionsError`.
- **Extensions load only where the mode grants its tools outright** — `edit`
  and `full-auto`. Enabling them means giving up Pi's flat `tools` allowlist:
  extension tool names are not knowable until the session exists, so ADE
  switches to `excludeTools` for the unwanted built-ins and leaves the rest of
  the namespace alone. An extension tool also cannot be wrapped in an approval
  card the way a built-in can. A read-only mode promises no writes and an
  ask-first mode (`default`, `auto`, `config-toml`) promises a card before each
  one; neither promise survives an ungated tool, so those modes keep the
  allowlist and forgo extensions. Personal chats also skip them: they are not
  attached to a project worktree.
- **Extension-registered tools run outside ADE's permission modes.** This is
  disclosed, not hidden: when extensions are enabled the chat emits a one-time
  notice naming what loaded and stating that their own tools are not limited to
  the chat's tool list. Load failures and `ungateableTools`
  get their own notices.

Sign-in notices never reach a chat thread — login runs on `piAuthService`'s own
worker and is rendered by Settings.

## External chat import

The external-session import flow can turn provider-native Claude and Codex CLI
sessions into full ADE chats. `externalSessionsService.importExternalSession`
delegates `target: "chat"` imports to
`agentChatService.importExternalChatSession`, which creates a normal
lane-scoped `AgentChatSession`, stamps `importedFrom` provenance, seeds the ADE
transcript from the external history, and then binds future turns to the
imported provider identity. A successful import returns the persisted
`AgentChatSessionSummary` together with the new id so desktop, TUI, and iOS can
install the row before navigating instead of racing the next session-list
refresh. The full feature doc, including CLI imports,
provider storage, mobile routing, and testing constraints, is
[External Session Import](../terminals-and-sessions/external-session-import.md).

Claude imports read the source JSONL from Claude project storage. When the
source cwd differs from the target lane, ADE makes a non-destructive copied
Claude transcript with a new session id in the target lane's Claude project
folder, then points the Claude SDK resume state at that id. Codex imports read
thread turns from the app-server with `thread/read`; fork imports first ask
Codex for a new thread with `thread/fork` and then seed ADE from that thread.

Transcript seeding is bounded. `externalChatHistoryImport.ts` reads only the
last `MAX_IMPORT_TRANSCRIPT_BYTES` (`32 MB`) from file-backed transcripts and
keeps the newest 2,000 imported content events. It prepends system notices for
the import provenance and for any byte/event truncation, maps supported user,
assistant, tool, command, file-change, search, and image events into ADE's
`AgentChatEventEnvelope` stream, excludes metadata-only user rows and recognized
ADE/provider transport wrappers, and derives a fallback title from the first
imported user/assistant text when the caller did not provide one. The cleanup
grammar deliberately preserves ordinary user-authored JSX/XML and prompts that
happen to begin with `User request:`.

## Session lifecycle

1. `createSession({ laneId, provider, model, modelId?, permissionMode?,
   ...})` via `ade.agentChat.create` creates an `AgentChatSession`,
   persists it, and emits `status: "started"`.
2. Sessions warm up in the background. Claude SDK sessions have a 20 s
   warmup watchdog around the SDK `startup()` readiness probe; if warmup
   does not complete within that window the stale runtime is discarded and
   recreated on the next turn.
3. `sendMessage({ sessionId, text, attachments? })` via
   `ade.agentChat.send` dispatches a turn. The ADE action bridge exposes
   the same low-level path as `chat.sendMessage`, plus
   `chat.messageSession({ sessionId, text, kind })` as the normalized
   agent-to-agent primitive. `kind: "auto"` steers active sessions and wakes
   idle sessions, `queue` always routes through the provider-normalized steer
   path, `wake` starts a normal turn, and `interrupt-replace` uses Claude SDK
   priority `now` on active Claude sessions (other providers keep their native
   interrupt-then-send path). The result reports the routed action and whether a
   steer was delivered or queued. `ade chat send` uses the auto route, while
   `ade chat message --kind ...` exposes the explicit primitive. Provider
   dispatch and event streaming continue asynchronously after acceptance.
   `ade chat create --prompt` uses this same follow-up send after the session is
   created, and `ade chat read <session>` calls bounded
   `chat.readTranscript` / `chat.readTranscriptPage` actions to inspect any
   project-backed chat registered with the machine brain. Reads are silent,
   default to a small recent window, and page older content with a byte cursor;
   personal/no-project chats remain outside this route. Shell/terminal transcript
   reads stay on the terminal/session surfaces. When invoked through the generic
   ADE action bridge by a session-bound agent, low-level `chat.sendMessage`
   remains scoped to the caller's own chat; `chat.messageSession` is the reviewed
   peer-control primitive for deliberately messaging another ADE chat through
   ADE's routing contract. For still-scoped actions, the same self-session rule
   covers other trusted bound-agent chat/session history, scheduling, attention,
   status, and lifecycle calls; a plain unbound human/dev CLI retains its wider
   read surface. A cross-session target for one of those actions fails with
   JSON-RPC `policyDenied` and structured
   `session_scope_denied` data rather than `methodNotFound` or an
   `Unsupported chat method` message. The structured payload names the method,
   caller session, requested session, and `chat.messageSession` alternative, so
   clients can distinguish authorization from host-version skew without parsing
   presentation text.
   Fresh-chat kickoff is version-tolerant without weakening that boundary.
   Current desktop/CLI launch planners always create the session and follow with
   `chat.messageSession(kind: "auto")`. For ADE ≤1.2.41 callers that still emit
   cross-session `chat.sendMessage`, the runtime converts the request only when
   the target is the caller's direct child **and** its transcript is still
   empty. A sibling, unrelated, already-started child, unreadable transcript, or
   any other cross-session target keeps the structured policy denial. If the
   host lacks both contracts, the client must name that host and request an ADE
   update/restart; it must not leave a successfully created chat silently blank.
   Interactive chat sends are not wall-clock bounded by the service; the turn
   runs until the provider
   completes or the user/app interrupts it. The blocking `runSessionTurn`
   helper used by automation has a 5 min default RPC timeout unless the caller
   passes `timeoutMs: null`; background/headless chat launches opt out.
4. The runtime streams events through the main-process event emitter and
   into the renderer via `ade.agentChat.event` (a push channel owned by
   `registerIpc.ts`).
   Codex turns also run the watchdog described below: if `turn/start` succeeds
   but no useful model/tool event arrives, ADE reconciles the same app-server
   thread with `thread/read` and `thread/turns/list`, attempts at most one
   restart + thread resume, then publishes provider-neutral `turn_health` when
   manual recovery is still needed. Parent/orchestrator sessions receive the
   structured event with `sourceSessionId` and target the owning child.
5. On completion the service emits `status: "completed" | "failed" |
   "interrupted"`, optionally emits a `turn_diff_summary`, flushes
   buffered text, marks the session idle, and pulls the next queued steer.
   A terminal failure also stops still-active child subagents before the
   parent goes idle; that child closeout does not keep the parent active.
6. `dispose({ sessionId })` deliberately ends the runtime, persists the final
   state as `disposed`, pauses provider-owned durable work for operator cleanup,
   and cancels local-only scheduled work. Project
   close and graceful app quit use the lifecycle variant: live rows become
   `detached`, provider runtimes are torn down, and durable schedules remain for
   restart reconciliation and cold resume. Lane archive/delete applies the
   dispose rule to every session owned by that lane, including sessions that
   were not rehydrated into the current runtime.

Settling is a Work lifecycle mutation, not a provider answer. A normal settle
only writes `settledAt` (and an optional outcome status note). When the row is
in `Needs you`, the desktop uses one backend transaction with
`dismissPendingInput: true`: SDK chats route through
`dismissPendingInputForSettlement`, which interrupts the provider and clears
every restored/live waiter before the settle is committed. It intentionally
does not call `respondToInput`, because a decline can resume a provider turn
and a Codex plan decline can enqueue a revision. Tracked CLIs can dismiss only
an explicit `ade chat ask` marker; a raw native terminal prompt must be
resolved in the terminal and the menu says **Resolve input to settle**.

The teardown that a settle performs is deliberately narrower than the dismissal.
`sessions/settleTeardownWiring.ts` stops the session's work through
`interrupt({ mode: "stop_only" })`, and that mode does **not** settle Codex
cards: stopping work is
not the same as discarding a decision the user still owns, exactly as `stop_only`
already spares queued follow-ups. Only `stop_and_clear` — the user pressing Stop
— settles them, and only the explicit **Dismiss & settle** transaction discards a
card the user is still looking at. The exception is a card attached to a turn that
is genuinely running: the app-server request behind it dies when the turn aborts
either way, so it is settled regardless of mode.

Parallel launch is a renderer-orchestrated workflow layered on the same
session primitives:

1. `AgentChatPane` derives a deterministic slug base from the user's
   prompt (`createDeterministicAutoLaneName`) up front — no blocking
   `suggestLaneName` call before the lanes exist.
2. The pane creates one child lane per selected model slot using a
   unique `<base>-<model-family>` style name and persists progress under
   `agent-chat-parallel-launch:<projectRoot>:<parentLaneId>` in `kv`.
   When AI titles are enabled, `startBackgroundParallelLaneNaming` then
   makes a single background `ade.agentChat.suggestLaneName` call (which
   runs the shared session-intelligence title prompt against the
   requested, configured, and fallback title models) and renames every
   child to `<aiBase>-<model-family>` in place; one child's rename failure
   does not abort the rest, and the children are flagged in
   `laneNamingStore` so their lane labels are masked while the pass runs.
   If no model produces a usable
   name the deterministic base is kept; the generic empty-prompt fallback
   is `parallel-task`.
3. For each child lane it creates an `AgentChatSession`, sends the same
   prompt and attachments, and records `sentLaneIds` after each
   successful dispatch.
4. When all sends succeed, the persisted state is cleared and the app
   navigates to `/lanes?laneIds=<ids>&inspectorTab=work`, which opens
   the new lanes side-by-side with the Work pane emphasized.
5. If lane creation or send fails, unsent transient child lanes are
   cleaned up best-effort. On reload, unfinished persisted launch state
   is recovered and cleaned up before the user can start another launch.

Inactivity eviction runs every 15 s (`SESSION_CLEANUP_INTERVAL_MS`). A
runtime is torn down when its session is idle, has no live pending
input, and has exceeded its provider-specific inactivity window:
`SESSION_INACTIVITY_TIMEOUT_MS = 5 min` for Claude/Codex/Cursor runtimes,
`OPENCODE_SESSION_INACTIVITY_TIMEOUT_MS = 60 s` for OpenCode runtimes
(OpenCode holds a pooled server, so its idle window is much shorter to
free the underlying server sooner). Teardown routes through
`teardownRuntime(managed, "idle_ttl")`.

A Claude runtime whose only remaining claim is background work is exempt from
that sweep — but not forever. After `RUNTIME_WORKLOAD_EXEMPTION_MAX_SILENCE_MS`
(= `SESSION_STALE_AFTER_MS`, 3 h) with no emitted event and no real change to
the background-task level, the sweep reclaims it anyway: it logs
`agent_chat.runtime_workload_exemption_expired` with the silence and the counts
it overrode, and emits a `system_notice` in the chat, because this is the one
teardown path that ends background work the session still claimed and stopped
rows with no reason attached are worse than none. Anything bounded and
attributable — a live turn, a queued steer, an unanswered approval — still
exempts the runtime unconditionally, and every other provider is untouched
(Codex clears its subagents on turn end and Cursor reconciles cloud runs against
the server, so neither can wedge this way).

**The honest limit, stated because it decides a destructive action:** what ages
here is silence ADE can *see*. `background_tasks_changed` is level-triggered and
`emitClaudeScheduledWorkUpdate` dedupes an unchanged level, so a background job
that genuinely runs for three hours without emitting an event, a task edge, or a
membership change is indistinguishable from a wedged one and is stopped with the
runtime. That is the accepted cost of bounding the other direction, where a
single task whose completion edge never arrived pinned an SDK process, its MCP
children, and the whole project context for the life of the app. Two things keep
it defensible: the bar is the same three hours at which the product already
stops calling the session live, and the user is told in the chat.

`teardownRuntime` distinguishes **terminal** close reasons
(`handle_close`, `ended_session`, `model_switch`) from **non-terminal**
ones (`idle_ttl`, `budget_eviction`, `pool_compaction`, `paused_run`,
`project_close`, `shutdown`). For Claude and Cursor runtimes, a
non-terminal teardown preserves resume state: the service persists chat
state immediately (Claude additionally pins `runtime.sdkSessionId` to
the last known Claude SDK session id before releasing the session;
Cursor persists with its SDK agent id intact) and skips the usual
`runtimeInvalidated = true` + `clearLaneDirectiveKey` cleanup. The next
turn on that chat can therefore rehydrate the same provider SDK session
instead of creating a fresh one, even though the SDK process was
released to reclaim budget or compact the pool (a dead pooled Cursor
worker detected during turn setup also tears down with
`pool_compaction`, keeping that path non-terminal). Terminal closes
still run the full invalidation path so runtime stops and explicit
model switches don't leave stale continuation pointers behind. Cursor SDK
model switches are deferred while a turn is busy: the session model
updates immediately, the active turn keeps reporting the model it
started with, and runtime teardown waits until the turn finishes so
approvals and stream callbacks are not orphaned mid-run.

Cursor resume is best-effort on the SDK side: acquiring the pooled
worker can come back with a **different** agent id than the one ADE
persisted (the SDK opened a fresh agent instead of resuming). When that
happens, `stageCursorSdkAgentRotationRecovery` stages a continuity
recovery block into `pendingReconstructionContext` — a note naming the
previous and rotated agent ids (with an instruction not to claim access
to Cursor-side state that was not restored), the session's continuity
summary, and a recent-conversation tail — and clears the lane-directive
dedupe key so the brand-new agent gets the lane execution directive
re-emitted on its first turn. The rotation is logged as
`agent_chat.cursor_sdk_agent_rotated_after_resume`. ADE can also force that
rotation itself when it decides a thread is unusable — see [Cursor thread
recycling and the first-event watchdog](#cursor-thread-recycling-and-the-first-event-watchdog).
Pending
reconstruction context (from this path or session recovery) is injected
ahead of the next prompt under the label
`System context (ADE continuity, do not echo verbatim):`.

On app shutdown the service exposes `forceDisposeAll()` — called from
`runImmediateProcessCleanup()` in `main.ts`. It stops the cleanup timer,
rejects every outstanding `sessionTurnCollector` with a "closed during
shutdown" error so IPC callers don't hang, resolves local pending-input
promises with a `cancel` decision, and tears down every managed runtime
with reason `"shutdown"`.

`hasActiveWorkloads()` is the close/quit guard used by `main.ts`: a
chat counts as active when its session is active, it has a live pending
input, or its runtime still has work in flight (turn ids, approvals,
queued steers, subagents, Codex plan follow-ups, Cursor cloud runs,
etc.). The companion `hasRetainableSessions()` is broader: it returns
true for **any** managed session that the user has not explicitly
closed or deleted, including sessions sitting between turns. The
project-context rebalancer in `main.ts` checks `hasRetainableSessions`
first so a project context isn't evicted just because every chat
happens to be idle — the runtime stays warm so the next turn doesn't
cold-start.

`MAX_CONCURRENT_ACTIVE_RUNTIMES` (5) is a **process** budget, not a per-service
one. Both hosts build one `agentChatService` per open project scope, so applying
the cap inside each service made it `5 x open projects` — five Claude SDK
processes and their MCP children per project, which bounds nothing the operating
system cares about. `createChatRuntimeBudget()` is constructed once in
`apps/desktop/src/main/main.ts` and once in `apps/ade-cli/src/bootstrap.ts` and
handed to every scope; eviction picks the globally least-recently-used
releasable runtime — one per call, so coming under a shared budget cannot fire a
dozen synchronous teardowns at once — and a stale background-workload exemption
no longer shields one from it. **The cap is unchanged at 5, and that is a deliberate trade, not an
oversight.** Someone with three projects open used to keep up to fifteen agent
runtimes warm; they now keep five. In practice that means switching back to a
project you left a while ago can cold-start its agent — a few seconds before the
first turn, where it used to be instant. That is the cost of the cap meaning
anything at all: the previous bound was `5 x open projects`, which is not a
bound on the machine's memory, and five idle SDK processes plus their MCP
children were measured at 5.4 GB. If it needs revisiting, raise the constant
deliberately rather than reverting to a per-project cap. The budget is injected rather than kept in a module global so
ownership is explicit and an undisposed service cannot inflate somebody else's
count; a service constructed without one gets a private budget, which is the old
per-service behaviour. Nothing releasable means the budget yields — being over
budget beats killing a live turn. Process, not machine: desktop main and the
brain are separate processes and each keeps its own. Project/window close probes still fail closed: if the chat
workload probe throws, ADE keeps the project alive instead of closing
over a possibly running agent.

### Cursor thread recycling and the first-event watchdog

A Cursor transport failure — an `NGHTTP2` stream reset, an `[internal] write
ECANCELED`/`EPIPE`, a socket torn down mid-write — does not just fail the run
it hits. It poisons the server-side Cursor agent thread, and the worker process
stays perfectly alive on this side. Every later send on that thread then hangs
at `Preparing response` forever: no events, no result, no error. The only
observable signal is silence, so ADE guards each local Cursor turn with a
first-event watchdog and one automatic recovery attempt.

- **The watchdog.** `CURSOR_SDK_FIRST_EVENT_WATCHDOG_MS` is 90 s from the send.
  Any streamed worker event — text, reasoning, a tool call, a status change —
  disarms it. `run_started` deliberately does not count (the wedged-thread
  failure is exactly "the run is created and then nothing streams"), and neither
  does the terminal `run_result` or the synthetic terminal `status: ERROR` the
  worker posts just before it — both are the run *ending*, not progress.
  Counting that terminal error as activity is what previously made the
  transport-recovery branch unreachable in production. The budget is generous on
  purpose: unlike Codex's advisory 120 s stall watchdog, tripping this one is
  destructive, so it has to cover a full send round trip plus first token
  including attachment upload on a slow link. It is armed once per turn and
  never re-armed on progress, so a legitimately long tool call can never trip
  it. The watch is run-scoped as well as turn-scoped, so late events from an
  abandoned run cannot disarm the next turn's watchdog.
- **Recycling.** When the watchdog fires, or a send rejects with a transport
  error before any event arrived, `recycleCursorSdkAgentThread` best-effort
  cancels whatever is nominally running (bounded at 3 s), force-evicts the
  pooled worker via `poisonCursorSdkConnection`, drops the live runtime, and
  arms a forced rotation. The next `ensureCursorSdkRuntime` then acquires with
  `agentId: null` so a brand-new Cursor agent is opened instead of resuming the
  dead thread. Logged as `agent_chat.cursor_sdk_worker_poisoned`,
  `agent_chat.cursor_sdk_thread_recycling`, and
  `agent_chat.cursor_sdk_agent_recreated_after_forced_rotation`.
- **One re-send, one set of terminal events.** `runCursorSdkTurn` runs the
  attempt through `runCursorSdkTurnOnce`, which returns a recovery *sentinel*
  instead of recursing — produced before any error/status/done emission — so a
  turn is reported exactly once no matter which attempt settles it. The
  automatic re-send happens at most once per user turn and sets the SDK's
  `local.force` through `forceExpireActiveRun`, because the previous run may
  still be registered as active on the thread that stopped answering. A second
  failure surfaces to the user rather than looping. The re-send announces itself
  in the transcript ("Cursor stopped responding. ADE opened a fresh Cursor
  thread and is resending your message." / "Cursor's connection dropped. …"),
  and when no recovery is left the turn fails with "Cursor stopped responding.
  ADE opened a fresh Cursor thread — try sending again." under
  `errorInfo.category: "network"`.
- **Expired access tokens keep the thread.** The Cursor SDK exchanges the user
  API key for a short-lived access token once per worker and only re-exchanges
  it when a call faults with a Connect `Unauthenticated`. An in-stream expiry
  (~60 min in) never triggers that, so the run dies with "Authentication error
  If you are logged in, try logging out and back in." and every later send on
  the same worker fails instantly with the same text. The API key is fine; only
  the worker is spent. `isCursorSdkStaleAccessTokenText` matches that exact
  signature (never a bad key), and the recycle runs with `reason: "stale_token"`
  and `preserveAgentId: true` — the worker is replaced, but the same
  `cursorSdkAgentId` is resumed in the fresh one, so no rotation, no continuity
  preamble, and no lost conversation. The replacement worker listens on a new
  per-instance `hook.sock` (and the next acquire waits for the poisoned process
  to exit, failing instead of overlapping if that wait times out) so the dying worker's `server.close()`/unlink cannot delete the new
  policy gate; tools keep working in the same chat. The raw error card is
  swallowed in the bridge. Recovery is silent when nothing had streamed yet (the
  original prompt is re-sent verbatim, logged as
  `agent_chat.cursor_sdk_stale_token_recovered`); when the token died mid-turn
  the re-send asks Cursor to continue from where it stopped and the transcript
  says only "Reconnected to Cursor and continued." If the retry hits the same
  signature the turn fails with "Cursor's session expired. ADE reconnected and
  retried, but Cursor rejected the request again — sign in to Cursor again in
  Settings, then resend." (`errorInfo.category: "auth"`, keeping the Cursor
  request id as detail).
- **Steers survive the swap.** Steers queued on the dying runtime are lifted off
  it by the recycle and must be settled by the caller — re-queued onto the
  rebuilt runtime, or cancelled with a notice ("Queued message cancelled because
  ADE recycled the Cursor thread — resend it if still needed."). Because several
  paths can legitimately reach the same queued message, every emitter claims the
  steer id through `settledSteerIds` first, so exactly one notice is rendered.
- **The intents are durable.** Both one-shots live in `PersistedChatState`:
  `cursorSdkForceExpireNextSend` (the next send may expire a still-active
  persisted run) and `cursorSdkPendingRotationPreviousAgentId` (the next runtime
  must open a fresh agent, and here is the agent it is replacing). They have to
  survive a restart because `teardownRuntime("pool_compaction")` preserves and
  persists the *wedged* `cursorSdkAgentId` — an in-memory-only flag would let a
  restart resume the very thread ADE just abandoned. Both are cleared on
  consumption; a rotation also clears the expiry flag, since a fresh agent by
  definition holds no stale run.

Continuity for the fresh agent is staged the same way Cursor's fork stages it
(`stageCursorSdkAgentRotationRecovery` → `stageCursorSdkContinuityHeader`): a
short header explaining the rotation, plus the **full transcript replayed
verbatim** as `pendingTranscriptReplay` (`buildFittedTranscriptReplay`, trimmed
oldest-first only when it exceeds the session model's context window), plus a
cleared lane-directive dedupe key so the new agent receives the lane execution
directive. The replay is consumed exactly once, durably — see
`consumePendingTurnContextPrefix`. It replaced a 20-line conversation tail: the
new agent had all of the work and none of the thread. Staging is skipped
entirely when the transcript has no turns, because a header announcing restored
context with no context attached only misleads the model.

### Message delivery, turn health, and quiet diagnostics

The transcript is the durable truth for whether ADE merely accepted a message
or the provider actually processed it. A user message may move through
`accepted` to `processed`; if the active turn ends without consuming an
accepted steer, the service persists `unprocessed`. Desktop, ADE Code, hosted
web, and iOS fold those lifecycle snapshots onto one user bubble rather than
showing duplicate messages. An unprocessed bubble offers three explicit
outcomes:

- **Run next** sends the original text and attachments as a new turn only after
  the current turn is idle.
- **Edit** restores the original content to the composer without changing the
  durable message.
- **Dismiss** records that no turn should be created.

Run next and Dismiss converge through
`chat.resolveUnprocessedMessage` / `resolveUnprocessedMessage()` and a durable
`user_message_resolution` event. The replacement message carries
`metadata.replayedFromUnprocessedSteer`; that replacement is the dispatch
commit point. If the runtime stops after dispatch but before writing the
resolution receipt, a later retry reconstructs the missing receipt and still
resolves to Run next. Concurrent clients are serialized by session + steer id,
so Dismiss cannot race a replacement turn and repeated calls return the
already-completed outcome.

Turn stalls use the provider-neutral `turn_health` event and
`chat.recoverTurn`; `codex_turn_stalled` / `recoverCodexTurn` remain readable
for older clients. The event names the provider, owning turn, timestamps,
recovery count, whether automatic recovery was attempted, and the supported
actions (`wait`, `nudge`, `retry_same_runtime`, `restart_resume`). When a
child's health event is mirrored into a parent, `sourceSessionId` keeps every
surface's recovery action targeted at the child. Recovery progress is recorded
as `turn_recovery`, so a successful recovery replaces the stale warning instead
of leaving contradictory cards.

Codex is the first provider with an active watchdog behind that shared
contract. A turn that produces no useful model/tool event for 120 seconds is
reconciled against app-server thread state. ADE backfills any missed items or
terminal state it finds; otherwise it attempts one app-server restart + thread
resume per session before exposing manual recovery. After useful progress,
10 minutes without further model/tool activity produces a non-destructive
stall warning. Pending approvals and user input suspend reconciliation, and
answering them re-arms the 10-minute progress window.

### When the host machine sleeps

A closed lid is not a provider failure, and the transcript says so. When the
host announces a suspend, every session with a turn in flight gets one
`system_notice` chip reading **Paused — computer asleep**; on wake the same row
is replaced in place with **Resumed · paused 4m**. It is one row, not two
banners: `appendCollapsedChatTranscriptEvent` keys the row on
`host-sleep:<sleepId>` and overwrites it, so the chip self-resolves and the
transcript does not grow. `AgentChatMessageList` renders it as a pill — a
duotone moon while paused, a filled play glyph once resumed. Chips are only
emitted for sessions that had work running; an idle chat is not paused by
anything.

The chip's more important job is suppressing a lie. A provider call that dies
because the socket went dark would otherwise surface as **retry 3/10** and burn
a retry the user paid for. `shouldAttributeRetryToHostSuspend` decides, in
order: any finite HTTP status means a server answered and the socket was not
dark, so it is a real failure; a cause outside the transport allowlist
(`overloaded`, `rate_limit`, and `authentication_failed` are deliberately
excluded) is a real failure; a fresh `asleep` announcement — inside the same
10-minute window `resolveMachinePresence` uses — attributes it to sleep; and
within `HOST_RESUME_RETRY_GRACE_MS` (30 s) of an **announced** resume a nameless
transport failure is still attributable. Only an announced resume opens that
window; an inferred heartbeat gap must not. When the rule fires, the retry is
**held, not consumed**: no `api_retry` event, no warning notice, no increment of
the retry counter, and one `agent_chat.api_retry_held_for_host_suspend` log
line. A turn started after the wake is never handed a stray "Resumed" chip.

Whether ADE may hold the machine awake in the first place is an opt-in setting
— see
[keeping the machine awake](../onboarding-and-settings/README.md#keeping-the-machine-awake).
The default is that turns pause, which is why this chip exists.

Moderation metadata is operational evidence, not a conversational response.
Raw `codex_moderation_metadata` events are retained for compatibility but do
not render as individual cards. The service counts checks per turn and merges
them with deduplicated optional-integration startup failures in one
`turn_diagnostics` snapshot. Transcript folds keep only the latest snapshot per
turn; graphical clients render a quiet **Turn details** disclosure and ADE Code
renders one compact details line.

## Spawn types and completion reporting

A chat can spawn another chat. New relationships use `spawnKind = "subagent" |
"peer"` on the session
(`apps/desktop/src/shared/types/chat.ts`), which rides the same session
lineage field bag as `orchestrationParentSessionId` (persisted, hydrated,
and projected onto summaries through `ORCHESTRATION_SESSION_FIELD_NAMES` in
`agentChatService.ts`). Hydration ignores legacy `none` values, and every new
parented session rejects missing or `none` types.

The child remains a full ADE agent with normal runtime, permissions, and tools.
The type is a coordination contract: use `subagent` whenever the parent will
need, join, read, or review the result (including parallel fan-out); use `peer`
only for fire-and-forget work the parent does not expect to consume.

Where it is set:

- `ade new chat --mode chat|cli --type subagent|peer` (alias `--spawn-type`).
  Both modes default `orchestrationParentSessionId` from `ADE_CHAT_SESSION_ID`;
  `--parent` overrides it and `--no-parent` creates a genuinely independent
  top-level session. A parent without a type is a hard CLI/RPC/service error.
  Chat mode stores the fields on the child chat and uses `spawnKind` for the
  completion policy below. Agent-provider CLI mode sends the same fields to
  `start_cli_session`, which stores them in `TerminalResumeMetadata` for
  lineage UI; plain shell launches omit them, and CLI lineage never populates
  `chatSessionId` because that field means attached-terminal ownership.
- The orchestrator `spawnAgent` tool
  (`apps/desktop/src/main/services/ai/tools/orchestrationTools.ts`) and the
  orchestration domain's `spawnAgent`
  (`orchestration/orchestrationDomain.ts`) set it, defaulting to
  `"subagent"`.

### Type-decided completion reporting

When any spawned chat child completes a turn, `reportChildSpawnEnded` in
`agentChatService.ts` derives the parent from persisted lineage and reports
based on the child's current `spawnKind`:

- **`subagent`** — ADE always wakes the parent through its trusted
  `messageSession({ kind: "wake", metadata: { spawnCompletion } })` path.
  If the parent is active, Claude receives the completion inline as SDK
  `priority: "next"` and Codex receives `turn/steer`; the delivery is allowed
  while the parent is awaiting input. Other active providers use the existing
  provider-normalized `steer()` fallback, which may queue at their safe
  boundary; an idle parent uses the normal message path. The message carries a
  typed `AgentChatSpawnCompletion` (`childSessionId`, `childTitle`,
  `childTurnId`, `spawnKind`, `status`, the latest bounded assistant
  `summary`, and `humanMessageCount` when the user also messaged the child
  during that turn). The renderer derives a navigable
  `spawn_wake_divider` labeled **Subagent returned** whether the completion
  joined an active turn or started idle work. This is intentionally distinct
  from scheduled wakes, which remain deferred to a safe turn boundary.
- **`peer`** — a quiet `system_notice` with `status: "spawn_completed"`
  carrying the same `spawnCompletion` in its detail. Rendered as a compact
  navigable chip; the parent is not woken. Peers never wake, so they never pay
  for the ownership transcript read.

  The notice reads `Chat "<title>" finished its turn`, minted by
  `spawnCompletedNoticeMessage(childTitle)` in `shared/types/chat.ts`. The chip
  re-states that sentence rather than echoing the stored `message`, because a
  persisted one may predate the current wording — the word "peer" is not user
  copy, and the chip no longer carries a `peer` kicker. The transcript's own
  turn summary says **Chat turn finished.** for the same reason (subagents keep
  **Subagent turn finished.**). For a notice whose detail lost its
  `spawnCompletion`, `AgentChatMessageList` recovers the title with one anchored
  pattern that matches both the current sentence and the pre-rename
  `Peer "<title>" turn finished` still sitting in old transcripts; a message
  matching neither falls through to `"Chat"` instead of being handed back
  mangled.

  Repeated completions for the **same child** fold. `appendCollapsedChatTranscriptEvent`
  compares an incoming `spawn_completed` notice against the row it just
  appended and, when both name the same `childSessionId`, replaces that row and
  bumps a render-only `repeatCount` the chip draws as a trailing `×N`. The fold
  is adjacency-only: anything the parent said or did in between separates the
  runs, and consulting only the last row is what keeps the incremental and full
  collapses byte-identical. A notice whose child cannot be identified folds into
  nothing and keeps its own row, rather than silently absorbing a different
  child's. `repeatCount` is render-side only — nothing persists it and no
  emitter produces it.

`spawnKind` is mutable. Taking over a subagent (desktop/iOS banner, context
menu, `ade chat demote`, `/session demote`) sets `spawnKind = "peer"` and
posts a quiet parent notice `status: "spawn_takeover"`:
`The user took over "‹child title›" — reports stop here.` Promoting
(`ade chat promote`, `/session promote`) restores `subagent` when the parent
chat still exists. A later parent `spawnDispatch` into a peer child
auto-promotes it back to `subagent` without a takeover note.

A human message to a subagent does **not** steal the report channel. The next
wake appends `The user also sent N message(s) to this chat.` so the parent can
read the transcript before following up. The takeover banner is shown once
(`subagentTakeoverPromptShownAt` on the child); sending does not dismiss it.

There is no new silent spawn type. Delivery retries three times. A final failure
is logged as `agent_chat.spawn_completion_delivery_failed` and emits a visible
warning in the child with the direct-report recovery command. Per-turn dedupe
uses the child turn id found in the persisted parent transcript, so brain
restarts do not sever the completion channel or replay the same report. Every
child turn completion also writes one local
`agent_chat.spawn_completion_routed` line recording `routedTo: "wake"` versus
`"quiet_notice"`, because a parent that was never woken is otherwise
indistinguishable from a child that never finished.

#### Mission ownership decides the wake

Wake vs quiet is the child's persisted `spawnKind`, not the latest human
message. A plain human message does not close the report channel.
`isHumanChildMessage` in `spawnMissionOwnership.ts` counts those messages for
the next wake.

Host-authored inputs that are not human messages:
`scheduledWake` (the child's own scheduler), `spawnCompletion`
(a result from the child's own grandchild), `agentRelay` (any other bound agent
messaging the child), `hostContinuation` (ADE prompting the chat to resume or
repair its own work — plan follow-ups, interrupted-turn recovery, provider
schedule cleanup, the CTO intro seed, and continuity recovery, which older
transcripts carry as `kind: "continuity_recovery"`), any `orchestrationOrigin`,
and a `deliveryState: "queued"` row whose delivered twin carries the
authoritative metadata. A parent `spawnDispatch` auto-promotes a peer child
back to subagent; it is not counted as a human message. A human message on a
subagent is counted for the next wake's
`The user also sent N message(s) to this chat.` annotation instead of stealing
the channel.

All of this provenance is host-authored and never accepted from a caller. The
ADE RPC edge runs `withTrustedAgentProvenance` on `chat.messageSession`,
`chat.sendMessage`, and `chat.steer` before any role- or scope-specific branch:
it strips every key in `HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS`, then re-derives
`spawnDispatch` when the caller is the target's persisted parent or `agentRelay`
when any other bound agent is calling. Positional invocation of those three
actions is rejected (`chat.<action>` requires object arguments passed with
`--input-json`) so caller metadata cannot route around the re-derivation, and
the automation action bridge strips the same keys before dispatching a `chat`
action. A child therefore cannot manufacture ownership of itself, and a
grandchild's status report cannot revoke its grandparent's.

Both child types receive lineage env:
`ADE_PARENT_CHAT_SESSION_ID` (the parent session id) plus `ADE_SPAWN_KIND`,
and injected ADE guidance explains the type contract and direct-report recovery
through `chat.messageSession`.

### Inline card vs. quiet pill

A plain (non-orchestration) spawn also emits an inline `subagent_started` /
`subagent_result` card pair anchored in the transcript, so the
`subagent_spawned` notice sets `hasInlineCard: true` and the renderer
suppresses the redundant deep-link pill (the card is the surface). An
orchestration-run child emits the notice but no inline card
(`hasInlineCard` absent/false), so the quiet navigable pill is kept. Either
way the completion report is chosen by `spawnKind`, independent of whether
an inline card was emitted.

### Navigation and lineage surfacing

Every spawn surface routes through `navigateToSpawnedChat` in
`spawnNavigation.ts` (see the source file map). `spawnKind` and
`orchestrationParentSessionId` are projected onto `TerminalSessionSummary`
(`apps/desktop/src/shared/types/sessions.ts`) from either the chat session or a
tracked agent CLI's normalized `resumeMetadata`. CLI resume-command refreshes
merge with the existing metadata so these fields survive continuation. The
Work sidebar can therefore render, without any extra fetch:

- a type pill on the spawner-declared child (`SessionCard` — violet for
  `subagent`, slate for `peer`; legacy invalid values are ignored), and
- a live-children badge (`▸N`) counting a spawner's still-`running`
  children, derived in `SessionListPane` from the already-loaded session
  list, and
- a small status-optional lineage identicon immediately left of the status dot
  on every child with a parent. Its tooltip names the parent from the
  unfiltered session-title index when available; clicking it opens the parent
  without selecting the child card.

`AgentChatPane` renders a type-tinted **View parent thread** header button for
a spawned chat. The tooltip names the parent when its title is available, and
the button is the keyboard/assistive-technology route back to the parent.
A subagent that has not yet answered the takeover prompt also shows a
non-blocking composer banner: **Take over** / **Keep reporting**. Take over
demotes to peer; dismiss and Keep reporting persist
`subagentTakeoverPromptShownAt` without changing `spawnKind`. The Work session
context menu (and the iOS long-press menu) offer **Demote to peer** /
**Promote to subagent** for the same write. Spawned-chat rows in
`ChatSubagentsPanel` derive an explicit `childSessionId`
and navigate to it directly. Their labels prefer the live child title threaded
from `WorkViewArea`; preserving the `chat:` task id and `spawnKind` through the
canonical dotted/underscore event twin keeps the row navigable regardless of
event order.

## IPC surface

All channel constants live in `apps/desktop/src/shared/ipc.ts`; service
handlers live in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

| Channel | Direction | Purpose |
|---|---|---|
| `ade.agentChat.list` | invoke | List sessions with optional `includeIdentity`, `includeAutomation`, `includeArchived` (defaults to `true`; pass `false` to filter out archived rows). Claude summaries include `nextWakeAt` (earliest armed, unpaused schedule), `scheduledWorkPaused`, and the optional KV-backed `scheduledWork` management snapshot. |
| `ade.agentChat.getSummary` | invoke | Fetch `AgentChatSessionSummary` for a single session, including the durable schedule summary and management fields. |
| `ade.agentChat.scheduledWork.create` | invoke | Create durable ADE-owned work for an eligible chat or tracked provider CLI session using exactly one of brain-local five-field `cron`, offset-qualified absolute `runAt`, or relative `delaySeconds`. Cron defaults recurring; absolute and relative schedules are one-shot. The result includes the brain's IANA `timeZone` and an absolute `nextRunAt`. The typed preload method is `window.ade.agentChat.createScheduledWork`. |
| `ade.agentChat.listScheduledWork` | invoke | List KV-backed durable jobs across the project or for one `sessionId`. Active jobs are returned by default; `includeTerminal: true` adds bounded recent completed/cancelled history. |
| `ade.agentChat.cancelScheduledWork` | invoke | Cancel one managed job by exact `sessionId` + `scheduleId`. ADE-only jobs cancel immediately. Claude-owned jobs are paused and routed through that chat's `CronDelete`; the result reports `providerCancellationRequested` and `providerCancellationConfirmed` instead of pretending an unconfirmed request already succeeded. If the stored owner is an earlier SDK session, ADE explicitly tombstones its local mirror and reports both provider fields false. |
| `ade.agentChat.setScheduledWorkPaused` | invoke | Pause or resume every durable wakeup/cron/loop schedule for one eligible session. Returns the resulting pause state and recomputed `nextWakeAt`; overdue work follows the one-late-fire rule after resume. |
| `ade.agentChat.getEventHistory` | invoke | Return `AgentChatEventHistorySnapshot` for a session. Runtime clients use one object argument (`{ sessionId, maxEvents?, maxBytes? }`); the registry temporarily accepts the legacy positional call for packaged-client compatibility. `sessionFound: false` is the explicit stale-session signal used by renderer surfaces to clear dead locked panes; `unavailable: true` means the bound runtime could not be reached and is **not** an authoritative miss (clients keep what they have). `hasOlderHistory` is the authoritative "there is more to scroll back to" bit — derived from the tail read, not from cursor bookkeeping — and `tailStartOffset` is the `beforeOffset` cursor for paging older. See [History snapshots, scroll-back, and misses](transcript-and-turns.md#history-snapshots-scroll-back-and-misses). |
| `ade.agentChat.getEventHistoryPage` | invoke | Page older transcript events with one object argument (`{ sessionId, beforeOffset, maxBytes? }`), returning `AgentChatEventHistoryPage`. `startOffset` strictly decreases while `hasMore` is true, which is what makes client paging loops terminate; a non-decreasing cursor is a retryable protocol failure rather than exhaustion. Carries the same `sessionFound` / `unavailable` distinction as the snapshot; an unreachable-runtime page echoes the caller's cursor back as `startOffset` so it does not also claim the head of the transcript was reached. |
| `ade.agentChat.create` | invoke | Create a new session; returns the `AgentChatSession`. Accepts `codexFastMode?: boolean` as the legacy-named Fast Mode bit for any provider/model descriptor that advertises `serviceTiers: ["fast"]`. |
| `ade.agentChat.suggestLaneName` | invoke | Derive a slug-safe lane name from a Work launch prompt using the session-intelligence title prompt, with a prompt-slug + optional unique temporary fallback. |
| `ade.agentChat.parallelLaunchState.get` / `.set` | invoke | Read/write crash-recovery state for renderer-orchestrated parallel launches. State is scoped by project root and parent lane id. |
| `ade.agentChat.handoff` | invoke | Create a handoff session. `mode: "brief"` sends a compact summarized hidden first message and may use `targetLaneId` to move the new chat to any active lane in the project; unknown, unavailable, and archived lanes are rejected. `mode: "fork"` requires the same provider on both sides while allowing the target model to change within that provider, and always keeps the new chat in the source lane (a differing `targetLaneId` is rejected). Local forks also seed the source ADE transcript into the new chat with fork provenance. `handoffNote` is an optional user-authored addition: brief mode appends it to the hidden handoff prompt, while fork mode sends it as the first user turn. Claude forks through the SDK session pointer; Codex forks the app-server thread with `thread/fork`; OpenCode calls SDK `session.fork` (`POST /session/{id}/fork`); Droid calls SDK `forkSession()` (`droid.fork_session`). Cursor has no provider fork surface at all and a Cursor thread cannot be resumed twice, so ADE forks it at the ADE layer: the new chat carries no `cursorSdkAgentId`, so its first send opens a brand-new Cursor agent and prefixes that send with the full source transcript replayed verbatim (the same `buildFittedTranscriptReplay` path a cross-provider fork uses, and the same replay an agent rotation stages), trimmed oldest-first only if it exceeds the target model's context window — in which case the handoff result carries `replayFork` and the chat shows a truncation notice. OpenCode and Droid persist the forked provider session as the new chat's resume pointer (`providerSessionId` / `droidSdkSessionId`). Codex targets do not inherit ADE session goals or seed app-server goals during handoff, and forked Codex threads are goal-cleared before any optional note is sent. Cross-machine fork additionally transports and rematerializes provider-native history for Claude, Codex, and OpenCode; cross-machine Cursor and Droid handoffs remain brief-only, Cursor because a replay fork has no provider artifact to send. Forwards `codexFastMode` when the target model supports Fast Mode. |
| `ade.agentChat.send` | invoke | Dispatch a user message + attachments. If the session has ended, sending is the continuation path. |
| `ade.agentChat.steer` | invoke | Send a follow-up message mid-turn. Claude callers may pass `dispatchMode: "inline" | "interrupt"` for atomic SDK `priority: "next" | "now"` delivery; Cursor callers may pass `dispatchMode: "interrupt"` only (cancel + resend on the same agent thread) and are rejected for `"inline"`; omitting it stages the message. Returns `AgentChatSteerResult` (`{ steerId, queued, reason?: "queue_full" }`) — `queued: false, reason: "queue_full"` when the queue is at its cap. |
| `ade.agentChat.cancelSteer` / `ade.agentChat.editSteer` | invoke | Queue management for queued steers. `cancelSteer({ requireQueued: true })` rejects if delivery already claimed the row; desktop Edit uses that guarded form before restoring the message and attachments to the composer. |
| `ade.agentChat.dispatchSteer` | invoke | Deliver an already staged steer immediately. The accepted `mode` per provider comes from `ACTIVE_TURN_DISPATCH_MODES`, so this is one guard rather than a per-provider ladder. Claude pushes an SDK message with `priority: "next"` (`mode: "inline"`) or `priority: "now"` (`mode: "interrupt"`), both with `shouldQuery: true`, and the staged row is removed only after the input pump accepts it. Cursor accepts `mode: "interrupt"` only: the staged row is spliced out, resolved with a "Delivering your queued message..." notice, and promoted to the interrupt-and-continue redirect; the row is put back (and its settlement re-opened) if the redirect throws, so the message is never silently lost. Queue-only providers (Codex, OpenCode, Droid, Pi) and `"inline"` on Cursor are rejected with `unsupportedActiveTurnDispatchModeMessage`. |
| `ade.agentChat.cancelDispatchedSteer` | invoke | Claude-only cancellation for an attributed SDK-queued priority message. Resolves the ADE `steerId` to its bounded command UUID, capability-probes the runtime `cancelAsyncMessage` control, and returns `{ cancelled: true }` only after Claude confirms cancellation. |
| `ade.agentChat.interrupt` | invoke | Provider-specific interruption of the in-flight turn. Claude accepts optional `mode: "stop_and_clear" \| "stop_only"` (default `stop_and_clear`) and returns the chosen mode, cancelled queue count, and an optional eight-second recovery id/expiry. Codex reads the same `mode`: a `stop_and_clear` settles the session's pending Codex cards through `settleCodexPendingInputs` on every arm — including the two arms that return early because there is nothing to interrupt (no thread id, no active turn), which is the *common* case, since a plan approval is raised after its turn completes and would otherwise stay unanswerable and keep the composer locked. `stop_only` stops the work and leaves the cards. Other providers retain their existing stop behavior. |
| `ade.agentChat.restoreCancelledQueue` | invoke | Claude-only recovery for a recent `stop_and_clear`. Restores the original ADE-attributed queued steers when the matching recovery id is still live; returns `{ restored, restoredCount }` and never recreates expired or foreign-session entries. |
| `ade.agentChat.recoverCodexTurn` | invoke | Execute one guarded recovery action for the currently active stalled Codex turn: `wait`, `steer`, `interrupt_retry_same_thread`, or `restart_resume_thread`. Calls are single-flight per session/turn and reject stale cards once that turn is no longer active. |
| `ade.agentChat.approve` | invoke | Legacy approval channel (pre-pending-input). |
| `ade.agentChat.respondToInput` | invoke | Unified pending-input answer channel, including Codex MCP elicitation form values and metadata-gated persistent consent. |
| `ade.agentChat.delete` | invoke | Permanently remove a chat session: first waits for current-session Claude jobs to confirm provider cancellation, locally tombstones jobs whose earlier provider owner is unreachable, then disposes the runtime if still running, cancels any pending turn collector, resolves outstanding input waiters, removes the persisted JSON + transcript, and deletes the `terminal_sessions` row. A current-provider timeout leaves the chat unchanged. Archiving uses the same cancellation gate. |
| `ade.agentChat.updateSession` | invoke | Mutate permission modes, `manuallyNamed`, capability mode, the legacy-named `codexFastMode` Fast Mode toggle, Claude SDK session title/tag metadata, `spawnKind` (`subagent` / `peer`), and `subagentTakeoverPromptShown`. An empty tag clears the SDK tag. Demoting to peer posts a quiet takeover note on the parent. |
| `ade.agentChat.codex.goal.get` / `.set` / `.setStatus` / `.clear` | invoke | Codex-only IPC channels behind the preload API `window.ade.agentChat.codex.getGoal` / `.setGoal` / `.setGoalStatus` / `.clearGoal`. They call the app-server goal RPCs directly instead of sending `/goal` prompt text through the chat, preserve CLI/PTY sessions, validate objective length, persist goal state into session summaries, and keep ADE goals unlimited by clearing provider token budgets. |
| `ade.agentChat.warmupModel` | invoke | Preload a Claude SDK runtime for an eventual turn. |
| `ade.agentChat.slashCommands` | invoke | List provider + local slash commands. |
| `ade.agentChat.getContextUsage` | invoke | Claude-only: return the SDK control-channel context usage breakdown (`AgentChatContextUsage`) for the `/context` panel. The harness also performs this authoritative read after initialization, each settled turn, and compact completion; streamed estimates remain the responsive in-turn signal. |
| `ade.agentChat.rewindFiles` | invoke | Dry-run and apply provider-backed file rewind for a selected user message. Claude uses SDK file checkpoints and leaves conversation history untouched; `skippedLinks` reports linked paths the SDK could not restore and produces a visible notice rather than silently claiming a complete rewind. Codex restores ADE's git-tracked file plan and moves the app-server thread back — `thread/fork` before the selected turn on servers >= 0.145.0, or the deprecated `thread/rollback` (latest user message only) on older servers or when the turn id cannot be resolved. The renderer dry-run opens the same confirmation dialog with message context, aggregate stats, per-file rows, and lazy diff previews. |
| `ade.agentChat.claudePlugins.list` / `.reload` | invoke | Claude-only: enumerate discovered Claude plugins and force a plugin reload. Backs `/plugin`. |
| `ade.agentChat.claudeOutputStyles.list` / `.set` | invoke | Claude-only: list and select discovered output styles (user + project + plugin roots). Backs `/output-style`. |
| `ade.agentChat.claudeSessions.list` / `.info` / `.messages` | invoke | Claude-only: enumerate SDK sessions, fetch session info, and stream messages for `forkSession` handoff and resume flows. |
| `ade.agentChat.fileSearch` | invoke | Debounced attachment picker backend. |
| `ade.agentChat.saveTempAttachment` | invoke | Write pasted/dropped image bytes to a runtime-owned temp file (10 MB cap). Desktop and ADE Code clipboard-image paste use this route so local and remote chats both receive an attachment path the agent can read. |
| `ade.agentChat.getImageDataUrl` | invoke | Read a bounded project-local image file through the active runtime and return a data URL for attachment previews. The service validates realpath containment, file type, and size before reading; the renderer falls back to the local guarded app reader only when no runtime preview is available or the runtime read fails for a local-only path. |
| `ade.agentChat.listSubagents` | invoke | Provider-neutral subagent snapshot list. Snapshots are re-keyed on `agentId + parentToolUseId` (not just `taskId`) so multiple subagents spawned from the same parent tool call don't collide, and the renderer panel separates them into three tabs: Subagents, Teammates, and Background. Claude `subagent_*` envelopes are enriched with `agentType` (e.g. `code-reviewer`, `Explore`) by stashing the Task tool's `subagent_type` input at the assistant `tool_use` boundary and joining on `parentToolUseId` when the system-message `task_*` envelope arrives. Codex parallel-agent events carry an `Agent #N` label assigned at first announcement (1-based, per-turn) plus the raw threadId as `agentId`. OpenCode snapshots use the child session id, Cursor Task snapshots use the tool call id plus any returned child agent id, and Droid worker snapshots use the worker session id. |
| `ade.agentChat.getSubagentTranscript` | invoke | Fetch the transcript of one subagent run within a chat session. Dispatch by runtime kind: Claude/ade-code reads the SDK's per-subagent JSONL at `~/.claude/projects/<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`; OpenCode pulls the child session's messages over the OpenCode HTTP client (the child session id is the agentId); Codex returns captured child-thread stream rows for the registered collab thread and merges them with `thread/turns/list` app-server backfill, with the legacy parent `subagent_*` envelope filter only as fallback; Cursor filters the parent stream by either the returned child `agentId` or the Task tool call `taskId`, since failed starts may not return an agent id; LM Studio / Droid return `null`. Returns `AgentChatSubagentTranscriptMessage[]` (same shape as `AgentChatClaudeSessionMessage`). |
| `ade.agentChat.getMainTranscript` | invoke | Claude-only provider-fidelity view for an ADE chat session. Resolves the mirrored SDK session id, includes SDK system messages, and returns the byte-bounded subagent-transcript message shape. This is an alternate on-demand view and does not include ADE-only envelope events. |
| `ade.agentChat.models` | invoke | `{ provider, activateRuntime? }`. For OpenCode `activateRuntime: true` is required to *launch* a probe server; otherwise the main process only returns the cached inventory (via `peekOpenCodeInventoryCache`) and an empty list until a real probe has been run. Cursor and Droid always use `activateRuntime: true` in the TUI model listing path so the SDK can enumerate available models. The renderer cache (`aiDiscoveryCache.ts`) keys on `(projectRoot, OpenProjectBinding, provider, activateRuntime)` so local/remote and passive/active reads cannot collide. |
| `ade.agentChat.modelCatalog` | invoke | `({ mode?, refreshProvider? }, pin?)` → `AgentChatModelCatalog`. Takes the same optional `OpenProjectBinding` pin as `ade.agentChat.models`: a catalog describes the machine that served it (its ollama/LM Studio endpoints, its installed `cursor-agent`, its opencode inventory), so a composer for a chat on another machine passes that machine's binding and the renderer caches the result under it. Omitting the pin keeps the bound-runtime path and its local-IPC fallback. Returns the provider-grouped catalog (claude / codex / cursor / droid / opencode plus the local `ollama` / `lmstudio` groups when OpenCode-routed) for the desktop, TUI, and iOS ModelPickers. OpenCode contributes models from **connected providers only**; an empty block is still emitted for each unconnected provider (except `ollama`/`lmstudio`, which get their own groups), though no picker renders those blocks today — see the connected-only catalog gotcha below. `mode: "cached"` returns the in-memory snapshot, `"refresh-stale"` reuses the cache but optionally re-probes the named runtime when its per-provider freshness TTL is expired, and `"force"` re-probes unconditionally. `refreshProvider` is one of `"opencode" | "cursor" | "droid" | "lmstudio" | "ollama"`. The catalog carries an optional `stale: true` flag and per-model `connected` / `requiresConfiguration` / `sourceRuntime` / `providerId` / `providerName` / `serviceTiers` annotations; Cursor rows also carry `cursorAvailability` so renderer and TUI pickers can separate SDK chat models from CLI launch models. |
| `ade.agentChat.getSessionCapabilities` | invoke | Discover supported subagent/review features. |
| `ade.agentChat.getTurnFileDiff` | invoke | Lazy diff expansion for a turn-file-summary row. |
| `ade.agentChat.event` | push | Stream of `AgentChatEventEnvelope` into the renderer. |

Provider connection management lives on the `ade.ai.*` surface (handled in `registerIpc.ts`, backed by `openCodeAuthService.ts` and `modelsDevService.ts`), consumed by `ProvidersSection.tsx`:

| Channel | Direction | Purpose |
|---|---|---|
| `ade.ai.opencodeAuthMethods` | invoke | List the auth methods each OpenCode provider supports (`GET /provider/auth`). The Settings page derives its OAuth subscription rows from the providers whose methods include an `oauth` entry. Best-effort — rows stay hidden if unavailable. |
| `ade.ai.opencodeOAuthStart` | invoke | Start a subscription OAuth flow for `{ providerId, methodIndex, inputs? }`; opens the browser and begins polling. Returns `{ url, method, instructions }`. |
| `ade.ai.opencodeOAuthCancel` | invoke | Cancel the in-flight OAuth flow for `{ providerId }`. |
| `ade.ai.setOpencodeProviderKey` | invoke | Seed a plain API key for a provider (`PUT /auth/{id}`) and mirror it into ADE's key store. Backs the Kimi for Coding membership key and the `alsoOpenCode` key-save path for API/More-Providers rows. Invalidates provider-readiness caches on success. |
| `ade.ai.refreshModelsDev` | invoke | Force a models.dev metadata refresh now; returns `{ lastFetchedAt }` for the group-header "catalog synced" timestamp. `modelsDevService` also refreshes on boot and every 6h on its own timer. |
| `ade.ai.opencodeOAuthStatus` | push | Stream of `OpenCodeOAuthStatusEvent` (`pending`/`connected`/`cancelled`/`timeout`/`failed`) so the connect modal updates without polling. |
| `ade.ai.piLoginProviders` | invoke | List the Pi providers ADE can run an interactive sign-in for (`PiLoginProvider[]`, sorted by name), each carrying its `authTypes` (`oauth` / `api_key`), whether it is already `configured`, and the provider's own OAuth wording. Providers whose API key resolves ambiently are omitted — there is nothing to sign into. |
| `ade.ai.piLoginStart` | invoke | Run one provider sign-in for `{ providerId, method? }`, resolving only when the flow settles. Because it waits on a human completing an OAuth or device-code grant, it carries its own transport budget: `PI_LOGIN_IPC_TIMEOUT_MS` (11 min) in `ipcTimeouts.ts` and `localRuntimeTimeoutPolicy.ts`, outliving `piAuthService`'s 10-minute bound so the renderer cannot report failure while the daemon is still signing in. Invalidates provider-readiness caches on success. |
| `ade.ai.piLoginSubmit` | invoke | Answer the prompt Pi is currently blocked on (`{ providerId, requestId, value }`). The answer is relayed to Pi and never retained; `value` is in the IPC redaction set because for an API-key prompt it *is* the credential. A stale `requestId` is rejected rather than applied. |
| `ade.ai.piLoginCancel` | invoke | Stop the in-flight sign-in for `{ providerId }`, settle any open prompt, and release its worker. Also claims a fresh generation so a start still acquiring its worker is cancelled rather than orphaned. |
| `ade.ai.piAuthStatus` | push | Stream of `PiAuthStatusEvent` (`pending` / `prompt` / `success` / `error`) carrying Pi's prompts and its auth-URL / device-code / progress notices. Never carries a credential. Broadcast to renderer windows from `registerIpc.ts`; the remote/web fan-out is registered separately by the `ai` ADE action domain, which pushes the same transitions onto each runtime's event buffer. |
| `ade.ai.cursorCloud.fleet` | invoke | Project-scoped fleet read for the top-bar Cursor Cloud view: every cloud agent linked to an ADE session or matching the project origin, with latest-run status, pushed branch/PR, model, ownership (session/lane/Linear id), and `matchedBy`. Returns `relayState` + `lastEventAt` so clients can state honestly whether live updates are configured. Backed by `cursorCloudFleetService.ts`. |
| `ade.ai.cursorCloud.pullIntoLane` / `.resolveLane` / `.stopRun` | invoke | Fleet row actions. Pull merges a finished agent's pushed branch into its owning/matching/new lane (dirty worktrees refused; conflicts abort the merge); resolve maps an unlinked agent to a lane without touching git; stop cancels the agent's latest run host-side. |
| `ade.ai.cursorCloud.fleetEvent` | push | Per-project re-broadcast of Cursor Cloud relay deliveries carrying terminal statuses (FINISHED/ERROR). Wakes open fleet surfaces (no polling timer), lights the top-bar unread-finishes badge while the modal is closed, and carries `agentId`, `status`, `summary`, `branchName`, `prUrl`, and relay event identity. |

## Fragile and tricky wiring

- **The in-memory chat-event ring is live-tail only, LRU-capped at 64 sessions.**
  `eventHistoryBySession` exists so a snapshot can merge events that have not
  reached disk yet. It is **not** a transcript cache. Writing the merged
  snapshot back into the ring parked up to 4 MB per hydrated chat until
  process death — that is the ~1 GB heap that stalled the brain event loop
  for 30 s (`idle` / GC). History snapshots read the transcript (already
  LRU-cached, 32 sessions) and must not copy it into the ring. Live emits
  still touch the ring; idle sessions fall off the LRU. See
  `CHAT_EVENT_HISTORY_BUFFER_MAX_SESSIONS`.
- **Chat-event compaction is one policy with two consumers, and it must be
  idempotent.** `shared/chatEventCompaction.ts` serves both the stored
  transcript and the sync wire. Adding a heavy field to `AgentChatEvent` means
  adding it to that cap table — `tool_result.structured` was added to the event
  and to neither of the two cap tables that used to exist, and grew to 56.6% of
  a real 8 MB transcript. The wire path applies the same compaction to events
  that already came off disk compacted, so re-wrapping an already-compacted
  payload must be a no-op; it is detected by wrapper *shape*, never a marker
  key, because object-shaped tool results are rendered as raw JSON on every
  surface. The wire also runs storage compaction *before* dropping fields, so a
  live push and the same event after reconnect hydration are byte-identical —
  they were not, and an event visibly shrinking on reconnect is a user-visible
  bug. See [Persisted transcript](transcript-and-turns.md#persisted-transcript).
- **Event emission ordering in `agentChatService.ts`.** The service emits
  text, tool, command, file-change, status, and `done` events from
  multiple async sources (Claude SDK stream, Codex JSON-RPC
  notifications, OpenCode runtime, buffered-text flush). The
  `chatTextBatching` buffer must be flushed on every non-text event to
  preserve ordering. Losing that flush corrupts renderer state. Related
  guard: when `getRecentEntries` is called, the service flushes pending
  buffered text first so transcript reads always reflect the latest
  streamed content.
- **Claude streamed tool input is not optional metadata.** On background/idle
  turns, `content_block_start` commonly carries `input: {}` and the complete
  `TaskCreate`/`TaskUpdate` payload arrives as one or more
  `input_json_delta.partial_json` chunks. Keep the per-content-index input and
  tool metadata alive until `content_block_stop`, then parse and apply the full
  input even when a placeholder `tool_call` was already emitted. Gating
  Task/schedule derivation on “first tool emission” freezes later status
  transitions (for example TASKS staying at 0/N complete). Re-emission must
  reuse the same item id so clients update in place.
- **Claude system subtypes are triaged at the type level, not at runtime.**
  `agentChatService.ts` partitions
  `Extract<SDKMessage, { type: "system" }>["subtype"]` into two explicit unions —
  `HandledClaudeSystemSubtype` (`api_retry`, `background_tasks_changed`,
  `commands_changed`, `compact_boundary`, `files_persisted`, `hook_response`,
  `informational`, `init`, `local_command_output`, `memory_recall`,
  `mirror_error`, `model_refusal_fallback`, `notification`, `permission_denied`,
  `session_state_changed`, `status`, `task_notification`, `task_progress`,
  `task_started`, `task_updated`, `worker_shutting_down`) and
  `IgnoredClaudeSystemSubtype` (deliberately dropped:
  `control_request_progress`, `elicitation_complete`, `hook_progress`,
  `hook_started`, `model_refusal_no_fallback`, `plugin_install`,
  `thinking_tokens`). Whatever is left over becomes
  `UntriagedClaudeSystemSubtype`, fed to `AssertNever<T extends never>`. An SDK
  bump that adds a system subtype therefore fails **typecheck** instead of being
  silently swallowed. The maintenance contract on an SDK upgrade is to triage the
  new subtype into the handled or ignored union after checking **both** stream
  readers (the active-turn reader and `handleClaudeIdleMessage`) and the
  renderer — never to widen the ignored union just to make the build green.
- **Provider failures are terminal once, but retry notices are not failures.**
  Codex app-server may send an `error` notification before a failed
  `turn/completed` carrying the same message. ADE emits one visible `error`
  per turn + semantic error identity, then still emits the terminal failed
  `status` and `done` markers that release the composer. Distinct errors in
  the same turn must remain visible. An app-server error with
  `willRetry: true` is instead a `provider_health` notice and must not end or
  duplicate the active turn.
- **Terminal transcript evidence outranks a stale active summary.**
  `chatTurnState.resolveTurnActive` is the single invariant for snapshot
  hydration, resident cache hydration, live flushes, and locked-session
  summary refreshes. If the latest transcript turn ends in terminal
  `status`/`done` and no later turn starts, an eventually consistent active
  summary cannot put the UI back into running/Stop state. Keep every
  renderer rehydration path on this helper so failures always restore a
  sendable composer.
- **A detached chat must close the turn that died with its runtime.** Brain
  startup reconciles dead-owner chat rows to `detached`. When that chat is next
  hydrated, `agentChatService` finds the latest parent turn missing a terminal
  `status`/`done` pair, appends one provider-neutral `interrupted` close-out plus
  a restart notice, and reopens the durable session as idle. The repair is
  idempotent and applies to Claude, Codex, OpenCode, Cursor, and Droid; do not
  restore chat exclusions in the brain's stale-session reconciliation.
- **Turn-health events are provider-neutral; the Codex watchdog is the first
  producer.** MCP startup status and moderation notifications are diagnostics,
  not model progress. Do not let them clear the no-first-output watchdog. If
  app-server state can be read, recovered turn items are backfilled into the
  transcript and terminal turn state is finalized; only a genuinely silent or
  unreadable turn emits the neutral `turn_health` plus its legacy
  `codex_turn_stalled` twin. Desktop, ADE Code, hosted web, and iOS prefer the
  neutral event, preserve a mirrored child event's `sourceSessionId`, and avoid
  rendering both forms. Recovery calls `recoverTurn` when advertised and falls
  back to `recoverCodexTurn` for older hosts. Wait re-arms reconciliation,
  Nudge sends a progress steer, Retry interrupts/finalizes the turn before
  retrying on the same runtime, and Resume additionally tears down app-server
  and resumes the persisted thread. Only one action may run for a session/turn,
  and a late card must fail rather than mutating a newer turn.
  App-server `thread/deleted` notifications must clear live turn state,
  stop active Codex subagents, and remove the persisted thread id so the
  next user message starts from a fresh thread.
- **Codex app-server requests must always resolve or remain visibly pending.**
  Version 0.144.5 can request `currentTime/read` (reply in whole Unix seconds)
  and `mcpServer/elicitation/request` (form or URL mode). Unsupported silence
  stops the surrounding turn. `serverRequest/resolved` may arrive when a
  request is completed outside ADE; remove the matching approval and emit
  `pending_input_resolved` so a stale card cannot keep the composer locked.
  JSON-RPC decoding tolerates the `emittedAtMs` envelope field 0.145 adds to
  notifications, and the server version parsed from the `initialize` `userAgent`
  gates fork-before-turn rewind (see
  [agent-routing.md](./agent-routing.md#codex-rewind-and-0145-readiness)).
- **Every path that ends a Codex turn must settle that turn's pending cards.**
  A Codex approval is an open JSON-RPC server request; `runtime.approvals` is
  the only record of that waiter. Clearing the map alone leaves the chat
  rendering a card nobody can answer, keeps `hasLivePendingInput` reporting the
  session as blocked so every later send is refused, and strands the app-server
  on a reply that never comes. `settleCodexPendingInputs` is the one helper that
  does all of it — answer the request, drop the entry, drain staged
  `pendingPlanFollowups`, cancel the local `codex`/`ade` cards, emit one
  `pending_input_resolved` per card — and every turn-ending path calls it
  (`interrupt`, `finishCodexTurnInterruptedLocally`, the `turn/aborted` handler,
  `teardownRuntime`, `thread/deleted`, the app-server `proc.on("error")` /
  `proc.on("exit")` handlers, and settlement). The helper deletes each entry as
  it settles it, so a second call — the app-server's own `turn/aborted` landing
  after a local interrupt already settled — finds an empty map and cannot
  resolve the same card twice. Five details are load-bearing:
  - **`stop_only` does not settle.** Settle teardown stops the work without
    discarding a decision the user still owns, the same way it spares queued
    follow-ups. Only `stop_and_clear` and the explicit **Dismiss & settle**
    transaction settle cards.
  - **Runtime-death paths pass `preserveRecoverablePlanApprovals: true`**
    (`teardownRuntime`, `proc` error/exit). A plan approval outlives its runtime
    by design: the entry is dropped because the runtime holding it is finished,
    but its *receipt is withheld*, which is what lets `respondToInput` rebuild
    the card from the transcript via `latestTranscriptPlanApprovalRequest` and
    stage the follow-up. Every other kind dies with the process and still needs
    its receipt.
  - **The `proc` error/exit handlers settle only while they are still the
    current runtime** (`!managed.runtime || managed.runtime === runtime`). The
    approvals they settle belong to that runtime, but the local cards belong to
    the session, and a replaced runtime's exit can arrive long after its
    successor started — settling from a stale handler cancels a card the live
    turn is waiting on.
  - **Settlement takes staged plan follow-ups before its first `await`.** A
    `turn/completed` landing during the interrupt would otherwise drain one and
    start a fresh turn on the session the user just settled.
  - **Receipts are exactly one per card.** A settlement pass arms
    `pendingInputSettlementResolvedIds` (under `try`/`finally`, so a throw
    cannot silence every later settle on the session), records what its own
    drains resolved, and skips those when it emits for the cards it remembered
    up front. Two receipts for one card are two durable, synced events.
- **Dismiss & settle must quiet the provider before writing settle.** Keep this
  as one backend transaction through `settleTerminalSession` and
  `dismissPendingInputForSettlement`; do not implement it as a renderer
  `respondToInput` followed by settle. Provider declines can continue work,
  restored waiters may exist without a live request, and Codex plan responses
  can stage a revision turn. Raw native CLI prompts remain non-dismissible
  because ADE cannot truthfully answer an arbitrary terminal UI.
- **Structured provider activity shares one compact event contract.** Claude
  server web/MCP blocks, Codex `mcpToolCall` + app context, Cursor MCP/image
  tools, OpenCode image file parts, and Droid image content must map to the
  shared work-log/image events with stable item ids. Emit at most one start and
  one terminal event per item; finish any still-open Claude server block at
  turn completion. Keep large inline media out of durable/mobile transcript
  frames and retain byte-omission metadata when content is compacted.
- **Transcript read merges streaming text fragments.** The
  `MAX_TRANSCRIPT_READ_CHARS` budget is `120_000` (was `40_000`) and
  the transcript reader collapses consecutive assistant text events
  that share a `messageId` or `turnId` into one row instead of
  emitting one row per fragment. The merge runs in two paths: a
  keyed map indexed by `message:<id>` / `turn:<id>` for streamed
  fragments that carry an id, and a running `assistantDraft` for
  fragments that share state across events without an explicit id.
  Both flush back to plain `AgentChatTranscriptEntry` rows before
  returning so the on-wire shape is unchanged.
- **Resume-time envelope splice repair is bounded and lossless outside the
  detected run.** Before rebinding a persisted Claude SDK session, ADE queries
  the SDK messages and scans both the dedicated durable chat transcript and
  the legacy managed transcript once per process. Historical runs of at least
  three consecutive assistant text envelopes in one turn, each with a distinct
  message id, are rebuilt with SDK-stable message ids and full text; when SDK
  matching is unavailable, the run is locally merged. Unknown, malformed, and
  ADE-only event lines are preserved byte-for-byte. Healthy files are a
  byte-identical no-op, repaired files are written via temp-file rename with a
  one-time `.splice.bak`, and files over 64 MB are skipped. Cache invalidation
  plus a transient `session_meta_updated` event makes an open renderer refetch.
- **The full session transcript is an on-demand Claude-only IPC.**
  `ade.agentChat.getMainTranscript` resolves an ADE chat session to its live,
  persisted, or mirrored Claude SDK session id, requests system messages, and
  applies the same 4 MB response budget as subagent transcripts, expanding the
  response through the subagent-transcript conversion path. It explicitly omits
  ADE-only events such as approvals, schedules, and notices and never replaces
  ADE's persisted envelope backend. The Chat Info drawer no longer surfaces a
  "View full session transcript" control (removed with the drawer redesign);
  the IPC/action remains for programmatic callers.
- **Claude tags are lightweight session metadata.** The first tag stored in the
  mirrored Claude session pointer populates optional `claudeTag` on
  `AgentChatSessionSummary`. `updateSession({ tag })` writes or clears the SDK
  tag and refreshes the mirror. Desktop renders it in Work session rows and the
  chat header, includes it in the Work sidebar search haystack, and ADE Code
  displays `tag:<value>` in Chat Info.
- **`AgentChatSessionSummary.pendingInputItemId` is the addressable
  pending input.** When a session is awaiting input, the service
  resolves the latest pending item id from the live runtime's
  approval / permission / structured-question maps and, as a
  fallback, replays the last 512 events looking for an unresolved
  `approval_request` / `structured_question`. The same id is mirrored
  into `TerminalSessionSummary.pendingInputItemId` for sync clients
  that key off the terminal session row. iOS uses it to back
  Approve/Deny/Reply intents in the Activity drawer without opening
  the chat.
- **Steer delivery vs. turn completion.** `deliverNextQueuedSteer()` is
  invoked on every turn-end code path (success, failure, interrupt,
  Claude SDK error). Missing any path can strand a queued steer. It also
  declines to auto-deliver while an explicit dispatch is mid-flight: both
  runtimes that promote a staged row out-of-band (Claude's inline/interrupt
  push, Cursor's interrupt-and-continue redirect) hold the row's id in
  `dispatchingSteerIds` for the whole dispatch, so a parent turn that completes
  underneath the redirect cannot shift the *next* staged row into a turn the
  redirect is about to cancel. The same set is what makes
  `cancelSteer({ requireQueued: true })` report an in-flight row as busy rather
  than as "no longer queued".
- **Pending steer persistence.** The Claude runtime's `pendingSteers`
  array is mirrored into `PersistedChatState.pendingSteers` on every
  state flush and re-hydrated through `hydratePersistedPendingSteers`
  when the runtime is reattached. Attachment paths are re-resolved
  through `resolvePathWithinRoot` on hydration so the lane's worktree
  path (or project root for absolute paths) is the security boundary,
  not whatever the value was when the steer was queued. The cap is
  shared with the live queue (`MAX_PENDING_STEERS`), so a corrupt
  persisted record can't grow it beyond the in-memory budget.
- **Dispatched steer cancellation.** Every priority message receives a fresh
  client-side SDK UUID. ADE keeps a bounded UUID-to-`steerId` attribution map,
  returns those attributed messages in interrupt receipts, and capability-probes
  the runtime `cancelAsyncMessage(uuid)` control. SDK `0.3.220` additionally
  supports queue cancellation on the raw interrupt request; ADE uses it only
  when the session advertises `interrupt_cancel_queued_v1`, otherwise it
  preserves the per-message fallback. Successful cancellation
  clears the receipt/staged row through the existing `cancelDispatchedSteer`
  desktop, web, mobile, and ADE Code action. A user-initiated
  `stop_and_clear` snapshots the actually cancelled `QueuedSteer` payloads
  before clearing and offers one bounded restore; `stop_only` never enters
  that recovery path.
- **Authoritative Claude context lifecycle.** Streamed message usage is the
  responsive estimate, while control-channel `getContextUsage()` snapshots at
  initialization, settled turns, and compact completion are authoritative.
  `sampleId` and query/request generations reject late responses. Started
  compaction hides the old percentage as `compacting`; a completed boundary
  without exact `postTokens` becomes `recalculating`; a failed control read
  becomes `unknown`. Clients must not keep painting an old 100% as though it
  were current.
- **Pending input derivation.** The renderer's `derivePendingInputRequests`
  in `pendingInput.ts` must handle: (a) legacy `askUser` tool calls, (b)
  Claude `AskUserQuestion` SDK events, (c) Codex `permissions` requests,
  (d) Codex ADE CLI elicitation responses (JSON-schema coercion), (e)
  explicit `pending_input_resolved` events, and (f) `done` events which
  clear approvals but preserve plan-approval/question inputs when the
  turn was `completed`. Rule (f) is deliberate and must stay: Codex raises a
  plan approval *after* its turn completes, so a `done: completed` that swept
  the card away would erase the one gate the user is meant to answer. The
  backend is what makes a stale card impossible — the card is cleared by an
  explicit receipt from `settleCodexPendingInputs`, never by inferring death
  from a terminal turn.
- **Interrupt idempotency.** Each provider adapter guards repeat
  `interrupt()` calls. Missing the guard yields duplicate
  `subagent_result` or `error` events. See `interrupted` flag in
  `ClaudeChatRuntimeState`.
- **Claude post-compaction identity re-injection.** When the CTO
  identity session undergoes context compaction, the service calls
  `refreshReconstructionContext()` to re-inject persona, durable memory,
  and continuity protocols. Missing this path loses CTO identity and
  memory mid-session. See [CTO](../cto/README.md#flush-and-injection-lifecycle).
- **Transcript persistence.** Sessions persist version-2 state under the
  `.ade` layout. Re-derivation goes through `sessionRecovery.ts`;
  changing the on-disk format without bumping the version silently
  drops entries on next load.
- **Continuity recovery.** A provider resume failure never silently replaces
  the saved provider thread. ADE preserves the pointer, classifies the failure,
  and emits a `system_notice` with `detail.kind: "continuity_recovery"`; that
  discriminant is the renderer contract for `ChatContinuityRecoveryCard` and
  its retry-original, recover-from-history, and start-new-chat actions. The
  bounded `.ade/cache/chat-sessions/thread-pointers.jsonl` ledger stores the
  latest provider-pointer transition independently of metadata. If primary and
  `.lkg` metadata are both unavailable, reconciliation can restore the pointer
  from that ledger, the session resume command, or the durable transcript. See
  [Storage and recovery](../storage-and-recovery/README.md#durable-metadata-and-chat-continuity).
- **Parallel launch recovery.** The renderer owns the multi-lane launch
  loop, but crash recovery lives behind IPC in `kv`. Update
  `AgentChatParallelLaunchState` in `shared/types/chat.ts`,
  `registerIpc.ts`, `preload.ts`, and `global.d.ts` together whenever
  the state shape changes. The cleanup path must tolerate lanes that
  were already deleted.
- **Identity session filtering.** `listSessions` with
  `includeIdentity: true` is the only way to surface CTO chats. Regular
  renderer surfaces pass `undefined` to exclude them; the CTO page
  passes `true`. Double-check when wiring new chat lists.
- **OpenCode passive vs. active inventory reads.** `loadAvailableModels`
  for `provider: "opencode"` no longer unconditionally starts a probe
  server. A passive call (the default for Settings page mounts, model
  dropdown hydration, etc.) hits `peekOpenCodeInventoryCache` and
  returns whatever was last probed; only explicit `activateRuntime: true`
  calls (chat pane refresh for a Claude-to-OpenCode switch, sync
  remote command resolution for a `chat.create` missing an explicit
  model) will spin up the shared server. This avoids repeatedly
  launching an OpenCode process just to render chrome. The registered
  request key in `availableModelsRequests` is `${provider}:${mode}`
  so an active probe and a passive peek can be in flight concurrently
  without cross-resolving.
- **OpenCode binary gating.** `ade.ai.isOpenCodeInstalled` is a cheap
  IPC (no probe, just a `resolveOpenCodeBinary` lookup) used by the
  ModelPicker / Settings to gate the OpenCode rail and surface an
  "Install OpenCode" CTA without flashing before auth/install status
  loads. `openCodeBinaryManager.resolveOpenCodeBinary` re-validates the
  cached path on every call (so a fresh user install during the same
  session is picked up) and intentionally does not cache misses.
  `clearOpenCodeBinaryCache()` is wired into the AI integration's full
  cache reset alongside `clearOpenCodeInventoryCache` and the dynamic
  descriptor reset.
- **OpenCode inventory cache shape.** `probeOpenCodeProviderInventory`
  returns `{ modelIds, providers, error, descriptors }`. `modelIds` is
  the selectable list — connected providers only. There is no separate
  "full catalog" id list: `descriptors` still covers every catalog entry
  (so any id resolves through the dynamic descriptor registry), and
  `providers` still enumerates every provider, but only connected
  providers contribute selectable ids.
  `OpenCodeProviderInfo` carries both `modelCount` and
  `availableModelCount`. Variant keys are classified into
  `reasoningTiers` (alias map handles `mini`/`med`/`extra-high`/etc.)
  and `serviceTiers` (`fast`) instead of a flat `variantKeys` array; the
  Settings page UI consumes this when drawing per-provider model rails.
- **The model catalog lists connected OpenCode providers only.**
  `buildModelCatalog` in `agentChatService.ts` walks
  `opencodeInventory.modelIds`, not the whole OpenCode directory. The
  directory is models.dev in its entirety — ~195 providers / ~7.2k
  models — and emitting all of it produced a ~4.85 MB catalog that
  stalled or killed the iOS model picker; scoping to connected
  providers takes the same catalog to ~77 models / ~0.12 MB. This
  matches OpenCode's own clients: its TUI model dialog reads the
  connected-only `/config/providers` store, while the full `/provider`
  payload feeds only the provider-connect dialog, and the desktop app
  and `opencode models` CLI list connected providers only. The ~77
  figure is one machine's connected set, not a fixed ceiling — a single
  connected provider such as `openrouter` still lists hundreds. An empty
  block is still emitted for each unconnected provider except `ollama`
  and `lmstudio`, which get their own top-level groups; no picker
  currently renders those empty blocks, so treat them as payload shape
  rather than as the thing that makes browsing work. Do not "restore"
  unconnected models to make browsing work —
  browse from `opencodeInventory.providers`
  (`id` / `name` / `connected` / `modelCount`) instead.
- **OpenCode shared server pool compaction.** Acquiring a shared
  OpenCode server (`acquireSharedOpenCodeServer`) now calls
  `pruneIdleSharedEntries(excludeKey)` which shuts down every other
  idle shared entry with reason `"pool_compaction"`. The runtime /
  coordinator shutdown-reason union was widened accordingly
  (`teardownRuntime` in the chat service and
  `releaseOpenCodeCoordinatorSession` in `coordinatorAgent.ts` both
  accept `"pool_compaction"`). The effect: only one shared OpenCode
  server runs at a time per project; switching provider config or
  between chats with different configs recycles the pool instead of
  stacking processes.
- **OpenCode OAuth status has two independent fan-out paths.**
  `openCodeAuthService.addOpenCodeOAuthStatusListener` is a multi-sink
  emitter, and both sinks must be registered or one client class goes
  dark. `registerIpc.ts` broadcasts every event to all `BrowserWindow`
  renderers over `IPC.aiOpencodeOAuthStatus` (desktop). Separately,
  `adeActions/registry.ts` `ensureOpenCodeOAuthStatusRelayBridge` pushes
  the same event into the runtime event buffer as
  `{ kind: "opencodeOAuthStatus", event }` for remote/web clients. The
  poll timer is `unref`'d and the shared server lease is held only for
  the flow's lifetime, released on connect/cancel/timeout/failure.
- **OpenCode inventory persistence is stale-while-revalidate.** A cold
  start would otherwise blank the ~160-provider chip cloud until the
  first live probe. `persistOpenCodeInventory` writes each successful
  probe (keyed by project root) to `opencode-inventory-cache.json` under
  `userData`; `aiSettingsStatus` reloads it flagged `opencodeProvidersStale`
  so Settings renders the last-known catalog immediately, then a real
  probe replaces it and clears the flag. Persistence is best-effort and
  must never throw into the probe path. The in-memory `persistedInventoryMemo`
  and the `peekOpenCodeInventoryCache` passive-read cache are distinct;
  clearing one does not clear the other.
- **OpenCode runtime contracts: prompt-body system prompts, 404-gated
  re-attach, and role-gated rendering.** Three traps share one runtime
  boundary (`openCodeRuntime.ts` plus the service's OpenCode event pump).
  ADE's system prompt goes to OpenCode on the prompt body's `system` field —
  never as a `synthetic`/`ignored` text part, which OpenCode drops from model
  context entirely, so the part-shaped injection silently never reached the
  model. When a chat re-attaches to its persisted session id, only a confirmed
  404 (`isOpenCodeNotFoundError`) may fall through to fresh-session creation;
  transport blips, timeouts, and server-restart failures must surface instead
  of resetting the thread into an empty session. And because
  `message.part.updated` carries no message role, the service keys every seen
  message id on `message.updated` and renders parts only when that map says
  `assistant` — user-message parts (including synthetic or ignored prompt
  context) stream through the same channel and would otherwise echo into the
  transcript as assistant bubbles. Text and reasoning use the stricter
  `rendersAsAssistantOutput`, which also excludes auto-compaction summary
  messages (see the bullet below); file parts keep the plain role check, because
  a summary message carries no attachments to suppress. Incremental text arrives on a
  **different** event: OpenCode's processor calls `updatePartDelta` for every
  `text-delta` and only calls `updatePart` at text-start and text-end, so
  `message.part.updated` carries an empty part and then the finished one with
  nothing in between. The service therefore handles `message.part.delta`
  (`{sessionID, messageID, partID, field, delta}`) under the same assistant-role
  gate, accumulating into `textByPartId` / `reasoningByPartId` so the closing
  full-part update diffs to an empty delta instead of repeating the whole
  answer. Without that branch the transcript renders nothing until the turn
  ends and the reply lands in one jump.
- **A delta's `field` names the part property, not the part kind.** OpenCode
  publishes reasoning deltas with `field: "text"`, because a reasoning part's
  property is also called `text`. Classify every `message.part.delta` by the
  **part kind** recorded from the part-start `message.part.updated`
  (`partTypeByPartId`), never by `field`. Classifying by `field` renders the
  whole chain of thought as the assistant's answer, runs it together with the
  real reply, stores it in the assistant transcript message, and then repeats it
  inside the "Thought" chip when the closing full part arrives. The fallback runs
  only when no part kind was recorded, which happens on older OpenCode binaries
  that never send the part-start: it reads the part as reasoning when
  `reasoningByPartId` already holds text for it or `field` is `"reasoning"`, and
  as text otherwise.
- **Auto-compaction summaries arrive as an ordinary assistant message.** OpenCode
  writes the summary into a real assistant message flagged `summary: true` and
  streams it as normal text parts, so the assistant-role gate alone lets a recap
  of the whole conversation render as the model's reply. Track the flag from
  `message.updated` and suppress that message's text and reasoning; the
  `compaction` part and `session.compacted` already report the compaction. File
  parts keep the plain role check — a summary message carries no attachments to
  suppress.
- **Not every parent `session.error` ends the turn.** `ContextOverflowError` is
  *usually* recoverable — OpenCode compacts and continues without idling, so
  throwing kills a turn that was about to resume. ADE posts an info
  `provider_health` notice instead and keeps reading the stream. Recovery is not
  a guarantee, though: with the user's `compaction.auto` off OpenCode idles
  without compacting, and compaction can itself overflow and stop. So track the
  overflow and, if the turn reaches
  idle with no assistant text emitted after it, finish the turn as failed rather
  than reporting a completed turn that answered nothing. `MessageAbortedError` means
  something else (the OpenCode TUI or CLI on the same server) stopped the turn,
  which is an interruption rather than a failure. Everything else throws, and the
  throw must carry the structured error as `cause`, because
  `classifyOpenCodeError` reads the status code and nested messages out of it to
  tell auth from rate-limit from network.
- **Bound the SSE reconnect.** The generated SSE client reconnects forever unless
  a request passes `sseMaxRetryAttempts`, and OpenCode's `/event` sends no event
  ids, so a reconnect replays nothing: a `session.idle` published while the
  socket was down is lost and the `for await` never ends. `openCodeEventStream`
  caps the attempts and forwards `onSseError` so a dropped stream fails the turn
  with a logged cause instead of spinning forever. The count includes the FIRST
  connection and the client stops at `attempt >= max`, so the ceiling has to be
  2 to allow one real reconnect — 1 permits none. The `onSseError` log is skipped
  when the turn's abort signal already fired, because that is the user's Stop.
- **Cancel OpenCode question cards on interrupt and on turn failure, never on a
  clean completion.** `requestChatInput` parks the card in
  `managed.localPendingInputs`, which the interrupt path did not drain — it
  drained `pendingApprovals` only. A stranded card keeps `hasPendingInput`
  reporting the session as blocked, so the next send is refused, and a late answer
  replies into an aborted session. `cancelPendingInputsFrom(managed, "opencode")`
  runs on the interrupt path and the turn-failure path. It deliberately does NOT
  run on clean completion: on 1.18.x the question tool blocks server-side, so a
  clean idle with a card still open is not an expected state, and if it ever
  became one, cancelling would discard a card the user may still be reading — ADE
  can answer a card after the turn settles, which resumes the session. The
  exclusion is pinned by the test "bridges OpenCode question events through ADE's
  question UI".
- **Answer an OpenCode question on a detached task, never inline.** The event
  loop used to await `requestChatInput` while the card was open, so nothing else
  drained: a subagent's approval prompt, its streamed text, and every tool result
  sat in the socket until the person answered. `resolveOpenCodeQuestion` runs as a
  detached promise and the loop keeps reading. Failure handling moves with it —
  the turn no longer fails on this path, so the catch rejects the request through
  `question.reject` rather than leaving OpenCode waiting for an answer that is not
  coming, and it stays silent when `runtime.interrupted` is set, because Stop
  already cancelled the card and aborted the session. The test is "keeps draining
  OpenCode events while a question waits for the user".
- **Handle `message.part.removed` and `message.removed`.** OpenCode publishes
  both on a revert or an undo. The part event drops that part id from
  `textByPartId`, `reasoningByPartId`, `partTypeByPartId`, `toolStateByPartId`,
  `compactionStartedPartIds`, and the emitted-image set, so a part id OpenCode
  reuses later cannot diff against text that no longer exists, and a removed
  reasoning part stops classifying as reasoning. The message event drops the id
  from the role map and the summary set. Neither emits a renderer event:
  `transcript_retraction` matches rows by `messageId`, which OpenCode text events
  do not carry, and giving them one would merge every part of a message into a
  single row.
- **An unclassified OpenCode error is what the user reads, so bound it and
  de-duplicate it.** `classifyOpenCodeError` walks `message`, `data.message`, and
  `responseBody` down the `cause`/`error` chain. A thrown OpenCode error carries
  the structured original as `cause`, so the walk reaches the same wording twice
  and the chat printed it twice; a duplicate now keeps its first position only.
  Classification still reads the full text, but the displayed message truncates
  any raw `responseBody` to 500 characters, and a duplicate inherits the `isBody`
  flag from every occurrence, so a payload cannot dodge the cap by also arriving
  as `message`. `OPEN_CODE_ERROR_MESSAGES_BY_NAME` supplies wording for the one
  union member with no `data.message` of its own, `MessageOutputLengthError`,
  which otherwise reached the user as the generic fallback.
- **Reset the activity line at `step-finish`.** The line otherwise keeps naming
  the step's last tool until the next step starts, so a long gap between steps
  reads as a command that never finished. The `step-finish` part emits a generic
  `working` activity as well as recording token usage.
- **`runOpenCodeTextPrompt` gates its own accumulator.** Part events carry no
  role, so the caller's own prompt streams back through the same channel — and
  this helper's result names lanes and titles chats. It tracks roles from
  `message.updated` and keeps only non-synthetic, non-ignored `text` parts of
  assistant messages. Without that gate the user's prompt and the model's chain of
  thought landed in those names.
- **Never state `external_directory` in an ADE agent's permission block.**
  OpenCode's own default is `{"*": "ask", <tmp>: "allow", <skill dirs>: "allow",
  <reference dirs>: "allow"}`. A bare string expands to a single `{pattern: "*"}`
  rule, and an agent block's rules are appended after the defaults, with lookup
  being a `findLast` over the merged list — so `external_directory: "ask"` wins
  for every path and silently revokes OpenCode's access to its own temp, skill,
  and reference directories. Omitting the key already means "ask outside the
  worktree", which is what ADE wants. This binds all four ADE rulesets, `deny`
  included: `ade-plan` and `ade-helper` state no `external_directory` either,
  because a bare `"deny"` revokes the same built-in allowances a bare `"ask"`
  does. Name the trade rather than glossing it — plan and the helper used to
  hard-deny every outside-worktree path and now ask for one, which is a real
  loosening. It holds because each ask has an answer: plan raises an approval
  card the user decides, and a helper ask is rejected immediately by the
  `permission.asked` responder in `runOpenCodeTextPrompt`, since a one-shot
  prompt has no UI and would otherwise stall until its caller's abort.
- **`session.status` retry events are the only sign OpenCode is retrying.** When
  a provider fails, OpenCode retries with exponential backoff (2s, 4s, 8s, …)
  and publishes nothing else — no error, no text, no activity. A chat therefore
  shows a spinner for minutes and looks wedged. ADE handles
  `session.status` with `status.type === "retry"` and shows a
  `system_notice` with `noticeKind: "provider_health"` that carries the attempt
  number, the provider message, the wait computed from `status.next` (an epoch
  ms timestamp), and any `status.action` guidance, plus a `working` activity
  reading "Waiting for the provider". Every wire field is re-checked here even
  though the SDK declares it required, so a missing `next` cannot render
  "Retrying in NaNs." The first retry of a turn always posts a notice; after
  that a notice needs a changed provider message, or a new attempt at least 10s
  after the last notice. Reset
  that throttle on `status.type === "idle"` ONLY: OpenCode publishes `busy`
  between every two retry attempts (retry(1) → busy → retry(2) → …), so clearing
  it on `busy` clears it before every retry and the throttle never engages.
- **One OpenCode client, and it is the v2 one.** ADE talks to OpenCode
  exclusively through `@opencode-ai/sdk/v2/client`; the legacy entry point is
  imported for nothing but the `Config` type. The two clients call the *same*
  server routes (`/event`, `/session/{id}/fork`, …) — v2 is a corrected client
  for one wire, not a second protocol — but only its generated types track the
  current server. That matters in three places the legacy types got wrong:
  `question.asked` / `question.replied` / `question.rejected` and
  `permission.asked` are first-class events there (ADE used to hand-declare
  them), `message.part.updated` correctly carries no `delta` (the server
  publishes incremental text on `message.part.delta`, so the reconstruct-by-diff
  path is the one actually in use), and `Todo` has no `id` (OpenCode todo rows
  were being emitted with `id: undefined`, so they are keyed by list position
  now). Do **not** move to `@opencode-ai/sdk-next`: that is the 2.0 beta's
  Effect-native in-process embedding architecture, which would host OpenCode
  inside ADE instead of talking to a separately managed server.
- **`permission.updated` is gone from OpenCode, but not from ADE.** 1.18.21
  publishes only `permission.asked` / `permission.replied`, so the legacy event
  is absent from the v2 union. ADE still handles it through an explicit runtime
  guard rather than a union case, because `resolveOpenCodeBinaryPath` falls back
  to a *user-installed* binary when the tools cache and the bundle both miss (and
  `ADE_DISABLE_BUNDLED_OPENCODE=1` selects one outright) — dropping the handler
  would leave an older install's approvals unanswered forever.
- **New `ai.*` config fields must be added to BOTH `coerceAiConfig` and
  `mergeAiConfig`.** In `projectConfigService.ts`, `coerceAiConfig`
  validates/parses a config field off disk and `mergeAiConfig` folds the
  shared + local layers into the effective config. A field added to only
  one is silently dropped — it either fails to load or fails to survive
  the layer merge, with no error. This bit `ai.customProviders` and
  `ai.customModelSlugs` during the OpenCode providers build (custom
  providers/model slugs written by `ProvidersSection` never reaching the
  managed OpenCode config). Both keys are now folded by `mergeAiConfig`
  and validated by `coerceAiConfig`. The merge is **replace semantics,
  not union**: `local` supplies the full authoritative list and wins
  outright (`localAi ?? sharedAi ?? []`), because the same merge runs on
  the `ai.updateConfig` write-patch path where a union would make
  removals impossible — absent keeps the existing list, `[]` clears it.
  Add any future `ai.*` field to both functions, plus `AiConfig` in
  `shared/types/config.ts`.

## Configuration

Config flags that influence chat behavior (all stored under the project
config service):

- `ai.mode` -- `subscription` vs `guest`; gates auto-title, tool
  availability, and provider selection.
- `ai.sessionIntelligence.titles.*` -- AI title generation. Legacy
  `ai.chat.autoTitleReasoningEffort` is migrated into this tree.
- `ai.permissions.*` -- per-provider permission defaults
  (`claudePermissionMode`, Codex approval/sandbox defaults, OpenCode
  permission).
- `ai.taskRouting` -- provider/model selection per task type.
- `ai.customProviders` -- Advanced custom OpenAI-/Anthropic-compatible
  providers (`{ id, name, baseURL, npm, models[] }`) that flow into the
  managed OpenCode config.
- `ai.customModelSlugs` -- extra `providerId/modelId` slugs to surface in
  the picker. Like every `ai.*` field, both keys must be handled in
  `coerceAiConfig` and `mergeAiConfig` (see Fragile and tricky wiring).
- `ai.chat.piExtensionsEnabled` -- load the user's own Pi extensions inside
  ADE chat, bound to ADE's UI bridge. Defaults to **true**, matching what `pi`
  does in a terminal. Turning it off runs ADE chat with Pi's built-in tools
  only; the Pi CLI is unaffected either way. Plan-mode and personal sessions
  ignore the flag and never load extensions.

## Related docs

- [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md) -- clean/published Git, bounded context, destination setup, transport security, and retry semantics for **Send to machine**.
- [Personal chats](../personal-chats/README.md) -- projectless sessions that
  reuse the chat engine behind a machine-scoped isolation boundary.
- [Agents README](../agents/README.md) -- the CTO identity, persona
  overlays, and tool policy.
- [History README](../history/README.md) -- chat sessions are not
  recorded in the operations timeline, but the turns that cause git
  state changes (lane creation, PR creation, commits) are.
- [Search README](../search/README.md) -- chat transcripts (`.jsonl`) are
  FTS-indexed per message as the `chat` search source, deep-linking back to
  the matching message; ⌘K and the TUI palette merge those hits inline.

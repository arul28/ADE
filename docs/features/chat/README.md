# Chat

Agent Chat is the interactive AI coding surface inside ADE. Each chat binds a
lane (git worktree + branch), a provider runtime (Claude, Codex, OpenCode,
Cursor), and a transcript into a persistent `AgentChatSession`. The user talks
to the agent the same way they would use any IDE copilot, but with ADE's
lane/session tracking, tool approval flow, memory integration, and handoff
machinery layered on top.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Main service: session lifecycle, turn dispatch, event emission, provider adapters, steer queue, handoff. Large orchestrator file. |
| `apps/desktop/src/main/services/chat/buildClaudeV2Message.ts` | Builds the message payload the Claude Agent SDK V2 session consumes. Handles base64 image content blocks and MIME inference. |
| `apps/desktop/src/main/services/chat/claudeSlashCommandDiscovery.ts` | Discovers per-project (`.claude/commands/**`) and per-user (`~/.claude/commands/**`) slash commands, including `.md` command files and `.skill` user-invocable skills, parsing YAML frontmatter for description and argument hints. Consumed by `agentChatService` to enrich the `chat.slashCommands` response so the composer's picker lists local Claude commands alongside SDK-provided ones. |
| `apps/desktop/src/main/services/chat/chatTextBatching.ts` | Batches streaming assistant text fragments (100 ms) before emission to reduce renderer re-renders. |
| `apps/desktop/src/main/services/chat/sessionRecovery.ts` | Version-2 persisted-state reconstruction when sessions resume from disk. |
| `apps/desktop/src/shared/chatTranscript.ts` | Pure JSON-lines parser for `AgentChatEventEnvelope` values. Used by both the main process and the renderer. |
| `apps/desktop/src/shared/types/chat.ts` | All chat types: `AgentChatSession`, `AgentChatEvent` union, permission modes, pending input, completion reports. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Top-level renderer surface: state derivation, IPC wiring, composer mount, message-list mount, End/Delete chat controls in the header. Mounts `AgentQuestionModal` when the active pending input is a question/structured-question. Resolves the surface accent colour through `providerChatAccent(provider)` so Claude/Codex/Cursor stay visually consistent regardless of model variant. |
| `apps/desktop/src/renderer/components/chat/ChatSurfaceShell.tsx` | Shell that wraps every chat surface (desktop pane, mobile lane, CTO mission) with a unified header/footer slot and `--chat-accent` CSS variable. Supports a `layoutVariant="mobile"` mode that the iOS companion mirrors. |
| `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts` | Chat chrome tokens. Exports `PROVIDER_CHAT_ACCENTS` (claude → amber, codex → warm white, cursor → violet, opencode → blue, etc.) and `providerChatAccent(provider)`. iOS mirrors this table in `ADEDesignSystem.swift`. |
| `apps/desktop/src/renderer/components/chat/AgentQuestionModal.tsx` | Floating modal surface for question / structured-question pending inputs. Rendered above the transcript so the user can type or pick an option without losing the chat context. |
| `apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts` | Two-layer event-to-row pipeline (render events + grouped envelopes) that powers the message list. |
| `apps/desktop/src/main/services/ai/tools/` | Tool tiers consumed by the service when it provisions a Claude/Codex/OpenCode runtime (see [Tool System](tool-system.md)). |
| `apps/desktop/src/shared/ipc.ts` | `ade.agentChat.*` IPC channel constants. |

## Key concepts

- **Provider-agnostic sessions.** `AgentChatProvider` is one of `claude`,
  `codex`, `opencode`, `cursor`, or a free-form string reserved for local
  providers. The service owns a pluggable adapter per provider (Claude V2
  SDK, Codex JSON-RPC app-server, OpenCode runtime, Cursor ACP pool).
- **Lane-scoped.** Every session carries `laneId`; lane context (branch,
  worktree path) is injected into the system prompt, and working-directory
  resolution runs through `resolveLaneLaunchContext`.
- **Event stream first.** All transcript content is a JSON-lines stream of
  `AgentChatEventEnvelope` values. Renderer components derive UI state
  entirely from this stream.
- **Pending input abstraction.** Approvals, questions, permission prompts,
  and plan approvals from every provider collapse into
  `PendingInputRequest`. Renderer derives them via
  `derivePendingInputRequests()`.
- **Steer queue.** Follow-up user messages during an active turn are queued
  (cap 10) with per-entry edit/cancel; delivery happens on turn boundaries.
- **Identity sessions.** Sessions carrying `identityKey` (`"cto"` or
  `"agent:<id>"`) are filtered out of the Work tab list and rendered by
  dedicated surfaces (CTO tab, worker detail). See [Agent Routing and
  Identity](agent-routing.md).

See the detail docs for the specifics:

- [Transcript and Turns](transcript-and-turns.md) -- event envelope,
  message/tool lifecycle, batching, virtual scrolling.
- [Tool System](tool-system.md) -- three tiers (universal, workflow,
  coordinator) and their gates.
- [Agent Routing](agent-routing.md) -- provider selection, permission-mode
  mapping, model registry, handoff.
- [Composer and UI](composer-and-ui.md) -- composer, tasks, file changes,
  terminal drawer, message list.

## Session lifecycle

1. `createSession({ laneId, provider, model, modelId?, permissionMode?,
   ...})` via `ade.agentChat.create` creates an `AgentChatSession`,
   persists it, and emits `status: "started"`.
2. Sessions warm up in the background. Claude V2 has a 20 s warmup
   watchdog; if the Claude SDK's `unstable_v2_createSession` does not
   return within that window the stale session is discarded and recreated
   on the next turn.
3. `sendMessage({ sessionId, text, attachments? })` via
   `ade.agentChat.send` dispatches a turn. Each turn has a 5 min
   turn-level timeout enforced by the abort machinery.
4. The runtime streams events through the main-process event emitter and
   into the renderer via `ade.agentChat.event` (a push channel owned by
   `registerIpc.ts`).
5. On completion the service emits `status: "completed" | "failed" |
   "interrupted"`, optionally emits a `turn_diff_summary`, flushes
   buffered text, and pulls the next queued steer.
6. `dispose({ sessionId })` ends the runtime and persists the final state.

Inactivity eviction runs every 15 s (`SESSION_CLEANUP_INTERVAL_MS`). A
runtime is torn down when its session is idle, has no live pending
input, and has exceeded its provider-specific inactivity window:
`SESSION_INACTIVITY_TIMEOUT_MS = 5 min` for Claude/Codex/Cursor runtimes,
`OPENCODE_SESSION_INACTIVITY_TIMEOUT_MS = 60 s` for OpenCode runtimes
(OpenCode holds a pooled server, so its idle window is much shorter to
free the underlying server sooner). Teardown routes through
`teardownRuntime(managed, "idle_ttl")`.

`teardownRuntime` distinguishes **terminal** close reasons
(`handle_close`, `ended_session`, `model_switch`) from **non-terminal**
ones (`idle_ttl`, `budget_eviction`, `pool_compaction`, `paused_run`,
`project_close`, `shutdown`). For Claude runtimes only, a non-terminal
teardown preserves resume state: the service pins
`runtime.sdkSessionId` to the last known V2 session id before releasing
the session, persists chat state immediately, and skips the usual
`runtimeInvalidated = true` + `clearLaneDirectiveKey` cleanup. The next
turn on that chat can therefore rehydrate the same Claude V2 session
instead of creating a fresh one, even though the SDK process was
released to reclaim budget or compact the pool. Terminal closes still
run the full invalidation path so "End chat" and explicit model
switches don't leave stale resume pointers behind.

On app shutdown the service exposes `forceDisposeAll()` — called from
`runImmediateProcessCleanup()` in `main.ts`. It stops the cleanup timer,
rejects every outstanding `sessionTurnCollector` with a "closed during
shutdown" error so IPC callers don't hang, resolves local pending-input
promises with a `cancel` decision, and tears down every managed runtime
with reason `"shutdown"`.

## IPC surface

All channel constants live in `apps/desktop/src/shared/ipc.ts`; service
handlers live in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

| Channel | Direction | Purpose |
|---|---|---|
| `ade.agentChat.list` | invoke | List sessions with optional `includeIdentity`, `includeAutomation`. |
| `ade.agentChat.getSummary` | invoke | Fetch `AgentChatSessionSummary` for a single session. |
| `ade.agentChat.create` | invoke | Create a new session; returns the `AgentChatSession`. |
| `ade.agentChat.handoff` | invoke | End current session and create a new one with summarized context. |
| `ade.agentChat.send` | invoke | Dispatch a user message + attachments into an active session. |
| `ade.agentChat.steer` | invoke | Send a follow-up message mid-turn; queued when appropriate. |
| `ade.agentChat.cancelSteer` / `ade.agentChat.editSteer` | invoke | Queue management. |
| `ade.agentChat.interrupt` | invoke | Provider-specific interruption of the in-flight turn. |
| `ade.agentChat.approve` | invoke | Legacy approval channel (pre-pending-input). |
| `ade.agentChat.respondToInput` | invoke | Unified pending-input answer channel. |
| `ade.agentChat.dispose` | invoke | End the runtime and persist final state ("End chat"). The row stays in `terminal_sessions` as `ended` so it remains resumable. |
| `ade.agentChat.delete` | invoke | Permanently remove a chat session: disposes the runtime if still running, cancels any pending turn collector, resolves outstanding input waiters, removes the persisted JSON + transcript, and deletes the `terminal_sessions` row. Renderer surfaces this as "Delete chat" on ended sessions. |
| `ade.agentChat.updateSession` | invoke | Mutate permission modes, `manuallyNamed`, capability mode. |
| `ade.agentChat.warmupModel` | invoke | Preload a Claude V2 session for an eventual turn. |
| `ade.agentChat.slashCommands` | invoke | List provider + local slash commands. |
| `ade.agentChat.fileSearch` | invoke | Debounced attachment picker backend. |
| `ade.agentChat.saveTempAttachment` | invoke | Write pasted/dropped image bytes to a temp file (10 MB cap). |
| `ade.agentChat.listSubagents` | invoke | Claude subagent snapshot list. |
| `ade.agentChat.models` | invoke | `{ provider, activateRuntime? }`. For OpenCode `activateRuntime: true` is required to *launch* a probe server; otherwise the main process only returns the cached inventory (via `peekOpenCodeInventoryCache`) and an empty list until a real probe has been run. The renderer cache (`aiDiscoveryCache.ts`) keys on `(projectRoot, provider, activateRuntime)` so passive and active reads don't collide. |
| `ade.agentChat.getSessionCapabilities` | invoke | Discover supported subagent/review features. |
| `ade.agentChat.getTurnFileDiff` | invoke | Lazy diff expansion for a turn-file-summary row. |
| `ade.agentChat.event` | push | Stream of `AgentChatEventEnvelope` into the renderer. |

## Fragile and tricky wiring

- **Event emission ordering in `agentChatService.ts`.** The service emits
  text, tool, command, file-change, status, and `done` events from
  multiple async sources (Claude SDK stream, Codex JSON-RPC
  notifications, OpenCode runtime, buffered-text flush). The
  `chatTextBatching` buffer must be flushed on every non-text event to
  preserve ordering. Losing that flush corrupts renderer state. Related
  guard: when `getRecentEntries` is called, the service flushes pending
  buffered text first so transcript reads always reflect the latest
  streamed content.
- **Steer delivery vs. turn completion.** `deliverNextQueuedSteer()` is
  invoked on every turn-end code path (success, failure, interrupt,
  Claude SDK error). Missing any path can strand a queued steer.
- **Pending input derivation.** The renderer's `derivePendingInputRequests`
  in `pendingInput.ts` must handle: (a) legacy `askUser` tool calls, (b)
  Claude `AskUserQuestion` SDK events, (c) Codex `permissions` requests,
  (d) Codex ADE CLI elicitation responses (JSON-schema coercion), (e)
  explicit `pending_input_resolved` events, and (f) `done` events which
  clear approvals but preserve plan-approval/question inputs when the
  turn was `completed`.
- **Interrupt idempotency.** Each provider adapter guards repeat
  `interrupt()` calls. Missing the guard yields duplicate
  `subagent_result` or `error` events. See `interrupted` flag in
  `ClaudeChatRuntimeState`.
- **Claude post-compaction identity re-injection.** When a CTO or worker
  identity session undergoes context compaction, the service calls
  `refreshReconstructionContext()` to re-inject persona + core memory +
  protocols. Missing this path loses CTO identity mid-session.
- **ADE CLI approval bypass during auto-compaction.** The Claude runtime
  sets `compactionInProgress` when the SDK `PreCompact` hook fires and
  keeps it set for 60 s (the SDK emits no `PostCompact` signal). While
  the flag is true, `canUseTool` auto-approves ADE CLI tools (notably
  `memory_add`) so the compaction flush can persist memories without
  blocking on an approval prompt that no user is present to answer.
  Non-ADE CLI tools still go through the normal approval gate.
- **Transcript persistence.** Sessions persist version-2 state under the
  `.ade` layout. Re-derivation goes through `sessionRecovery.ts`;
  changing the on-disk format without bumping the version silently
  drops entries on next load.
- **Identity session filtering.** `listSessions` with
  `includeIdentity: true` is the only way to surface CTO and worker
  chats. Regular renderer surfaces pass `undefined` to exclude them;
  CTO and worker pages pass `true`. Double-check when wiring new chat
  lists.
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

## Configuration

Config flags that influence chat behavior (all stored under the project
config service):

- `ai.mode` -- `subscription` vs `guest`; gates auto-title, tool
  availability, and provider selection.
- `ai.sessionIntelligence.titles.*` and
  `ai.chat.autoTitleReasoningEffort` -- AI title generation.
- `ai.permissions.*` -- per-provider permission defaults
  (`claudePermissionMode`, Codex approval/sandbox defaults, OpenCode
  permission).
- `ai.taskRouting` -- provider/model selection per task type.

## Related docs

- [Memory README](../memory/README.md) -- memory tools are provisioned
  for every chat; turn-level memory guard blocks mutations on "required"
  intents until `memorySearch` is called.
- [Agents README](../agents/README.md) -- CTO and worker identities,
  persona overlays, tool policy.
- [History README](../history/README.md) -- chat sessions are not
  recorded in the operations timeline, but the turns that cause git
  state changes (lane creation, PR creation, commits) are.
</content>
</invoke>

# Claude SDK Migration & Chat Cleanup Plan

## Context

Claude chat in ADE is slow and feature-incomplete because it uses a community Vercel AI SDK wrapper (`ai-sdk-provider-claude-code`) that:
1. Reconstructs full message history O(n) on every turn (no session resume)
2. Flattens rich SDK events (TodoWrite, subagent hierarchy, structured questions) into generic Vercel AI SDK format — information permanently lost
3. Spawns a new subprocess per request instead of maintaining persistent sessions

This plan replaces the Claude CLI runtime internals with the official `@anthropic-ai/claude-agent-sdk`, adds UI renderers for all new event types, fills Codex event gaps, removes misplaced execution mode buttons, and cleans up dependencies.

## Safety Boundary — What Does NOT Change

**The public API of `agentChatService` (14 methods) is unchanged.** All 11 external callers continue working:

| Caller | Methods Used | Risk |
|--------|-------------|------|
| Missions (orchestratorService, workerDeliveryService, chatMessageService) | createSession, sendMessage, steer, interrupt, dispose | **None** — public API unchanged |
| coordinatorAgent.ts | **Does NOT call agentChatService** — has own independent `streamText()` via `providerResolver` | **None** — completely isolated |
| providerResolver.ts | **Not modified** — keeps `loadClaudeCodeProvider()` for coordinator's Vercel AI SDK path | **None** |
| PR conflict resolution (registerIpc.ts) | createSession, sendMessage, steer, interrupt | **None** — public API unchanged |
| CTO (openclawBridgeService, linearDispatcherService) | sendMessage | **None** — public API unchanged |
| Chat UI (AgentChatPane.tsx) | create, send, steer, interrupt, approve | **None** — public API unchanged |
| main.ts | disposeAll | **None** |

**Key isolation**: Changes are ONLY to the internal Claude runtime implementation inside `agentChatService.ts`. The `unified` runtime path (for API-key models) is also untouched — it keeps using Vercel AI SDK `streamText()`.

Worker sessions created by the orchestrator that specify `provider: "claude"` WILL use the new SDK path — this is **desired** (they get session resume performance). The behavior is identical from the caller's perspective since we emit the same `AgentChatEvent` types.

---

## Implementation Steps

### Step 1: Add new AgentChatEvent types

**File**: `apps/desktop/src/shared/types/chat.ts`

Add to the `AgentChatEvent` discriminated union:

- `todo_update` — for TodoWrite tool lifecycle (items with id, description, status)
- `subagent_started` — for subagent spawn (taskId, description)
- `subagent_result` — for subagent completion (taskId, status, summary, usage)
- `structured_question` — for AskUserQuestion with options (questions array with selectable options)

### Step 2: Update ClaudeRuntime type

**File**: `apps/desktop/src/main/services/chat/agentChatService.ts` (~line 147)

Replace `ClaudeRuntime` type:
- Remove `messages: PersistedClaudeMessage[]` — SDK manages history via sessionId
- Remove `abortController` — use SDK's `Query.close()` / `Query.interrupt()`
- Add `sdkSessionId: string | null` — for session resume
- Add `activeQuery: Query | null` — reference to live SDK query
- Add `activeSubagents: Map<string, { taskId: string; description: string }>` — subagent tracking

### Step 3: Replace Claude import and provider

**File**: `agentChatService.ts`

- Replace `import { createClaudeCode } from "ai-sdk-provider-claude-code"` with `import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk"` and relevant type imports
- Remove module-level `const claudeProvider = createClaudeCode()` (line 927) — only used by the Claude CLI `streamText` path being replaced
- **Keep** `ai-sdk-provider-claude-code` in package.json — still used by `providerResolver.ts` for coordinatorAgent

### Step 4: Rewrite `ensureClaudeSessionRuntime()`

**File**: `agentChatService.ts` (~line 3062)

Load `sdkSessionId` from persisted state instead of `messages[]`. If old persisted state has `messages` but no `sdkSessionId`, start fresh (old messages are incompatible with SDK sessions).

### Step 5: Extract `runClaudeTurn()` from shared `runTurn()`

**File**: `agentChatService.ts` (~lines 2124-2368)

This is the core change. Create a new `runClaudeTurn()` function that:

1. **Builds SDK options**: `cwd`, `model`, `permissionMode`, `includePartialMessages: true`, `resume: sdkSessionId`, `mcpServers`, `systemPrompt`, `maxBudgetUsd`, thinking/effort config
2. **Calls `claudeQuery({ prompt, options })`** — returns async iterator
3. **Iterates SDK messages** and maps each to `AgentChatEvent` emissions:
   - `system:init` → capture `session_id`, emit `activity`
   - `system:task_started` → emit `subagent_started`
   - `system:task_notification` → emit `subagent_result`
   - `assistant` message → process content blocks:
     - `text` block → emit `text`
     - `thinking` block → emit `reasoning`
     - `tool_use` block → emit `tool_call` (+ special handling for TodoWrite → `todo_update`, AskUserQuestion → `structured_question`)
   - `stream_event` (partial messages) → emit streaming `text` and `reasoning` deltas
   - `tool_progress` → emit `activity`
   - `result` → capture usage, emit errors if any
4. **On completion**: emit `status:completed` + `done`, persist `sdkSessionId`
5. **On error**: classify error, emit `error` + `status:failed` + `done`, handle resume failures by clearing sessionId and retrying fresh
6. **Process queued steers** after turn completes (same pattern as current)

Update `runTurn()` to dispatch: `if (managed.runtime?.kind === "claude") return runClaudeTurn(...)` — the unified path stays unchanged.

### Step 6: Build permission handler

**File**: `agentChatService.ts`

Create `buildCanUseToolHandler()` that wraps the existing approval flow:
- Emits `approval_request` event
- Creates a Promise that resolves when `approveToolUse()` is called
- Maps ADE decisions (`accept`/`accept_for_session`/`decline`/`cancel`) to SDK `PermissionResult` (`allow`/`deny`)
- Handles `accept_for_session` by passing `updatedPermissions` suggestions back to SDK

### Step 7: Update session lifecycle methods

**File**: `agentChatService.ts`

- **`persistChatState()`** (~line 1225): Persist `sdkSessionId` instead of `messages[]` for Claude runtime
- **`readPersistedState()`** (~line 1259): Extract `sdkSessionId` from persisted record
- **Interrupt** (~line 3570): Call `runtime.activeQuery?.interrupt()` instead of `abortController.abort()`
- **Teardown** (~line 1517): Call `runtime.activeQuery?.close()`, clear subagent maps
- **`sendMessage()` Claude branch** (~line 3477): Dispatch to `runClaudeTurn()` instead of shared `runTurn()`

### Step 8: Add UI renderers for new event types

**File**: `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`

Add to `renderEvent()`:

- **`todo_update`**: Checklist card with status badges (pending=yellow, in_progress=blue, completed=green), progress bar, strike-through for completed items. Similar visual to existing `plan` renderer.
- **`subagent_started`**: Activity chip with spinner + "Subagent: {description}" text
- **`subagent_result`**: CollapsibleCard showing status icon + summary + optional usage stats (tokens, tool uses, duration). Default collapsed for success, expanded for failure.
- **`structured_question`**: Handled via enhanced AgentQuestionModal (Step 9)

Add to `appendCollapsedEvent()`: `todo_update` events replace previous `todo_update` with same `turnId` (latest state wins). Subagent events are NOT collapsed.

### Step 9: Enhance AgentQuestionModal with structured options

**File**: `apps/desktop/src/renderer/components/chat/AgentQuestionModal.tsx`

Add `options?: Array<{ label: string; value: string }>` prop. When options provided:
- Render clickable option buttons above the textarea
- Clicking an option calls `onSubmit(option.value)`
- Textarea remains as fallback for custom answers

**File**: `AgentChatPane.tsx` — Update `extractAskUserQuestion()` to pass through options from `detail.options`.

### Step 10: Remove Claude execution mode buttons

**File**: `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`

In `getExecutionModeOptions()` (~lines 62-108): Remove the `model.family === "anthropic"` branch that returns `focused/subagents/teams` buttons. Claude subagents/teams are prompt-invoked, not button-invoked.

Keep the Codex `focused/parallel` buttons — those are valid runtime-level configurations.

**File**: `agentChatService.ts` (~lines 699-713): Remove `composeLaunchDirectives()` branches for `"subagents"` and `"teams"` execution modes since they can no longer be selected.

### Step 11: Fill Codex event gaps

**File**: `agentChatService.ts`

- **`handleCodexNotification()`** (~line 2859): Replace silent drop of unhandled notifications with `logger.warn()` including method name and param keys
- **`handleCodexItemEvent()`** (~line 2535): Add handlers for:
  - `delegation` item type → emit `subagent_started` / `subagent_result`
  - `planningItem` / `planning` type → emit `todo_update`
  - Fallback: `logger.debug()` for unrecognized item types

### Step 12: Dependency cleanup

**File**: `apps/desktop/package.json`

- **Add**: `@anthropic-ai/claude-agent-sdk` as explicit dependency (currently only transitive)
- **Remove**: `@openai/codex-sdk` — confirmed zero imports in `src/`, only referenced in `verify-ai-sdks.cjs`
- **Keep**: `ai-sdk-provider-claude-code` — still used by `providerResolver.ts` for coordinatorAgent
- **Keep**: `ai-sdk-provider-codex-cli` — still used by `providerResolver.ts`

**File**: `apps/desktop/scripts/verify-ai-sdks.cjs` — Remove `@openai/codex-sdk` check, add `@anthropic-ai/claude-agent-sdk` check

---

## Verification Plan

1. **Build**: `pnpm build` passes without errors
2. **Type check**: `pnpm typecheck` passes — all new event types correctly discriminated
3. **Unit tests**: Run existing `agentChatService.test.ts` — all existing tests pass (public API unchanged)
4. **Manual test — Claude chat**: Open chat, select Claude, send a message → verify streaming works, session resumes on second message without delay
5. **Manual test — Missions**: Start a mission with Claude workers → verify workers receive prompts, stream responses, complete successfully
6. **Manual test — PR resolution**: Open PR tab, trigger AI conflict resolution → verify it creates session, sends prompt, handles approval
7. **Manual test — CTO**: Open CTO tab, trigger an action that uses Claude → verify it works through agentChatService
8. **Manual test — Buttons**: Verify Claude chat has NO execution mode buttons; Codex chat still has focused/parallel buttons
9. **Manual test — Subagents**: Send a prompt that triggers subagent creation → verify `subagent_started` and `subagent_result` render in chat
10. **Manual test — Codex gaps**: Use Codex chat, check console for logged unhandled notifications (if any)

---

## Critical Files

| File | Changes |
|------|---------|
| `apps/desktop/src/shared/types/chat.ts` | Add 4 new event types to union |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Replace ClaudeRuntime, add runClaudeTurn(), update lifecycle, add Codex gap handlers, remove exec mode directives |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | Add 3 renderers (todo, subagent_started, subagent_result), update collapse logic |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Remove Claude exec mode buttons, update extractAskUserQuestion |
| `apps/desktop/src/renderer/components/chat/AgentQuestionModal.tsx` | Add structured options support |
| `apps/desktop/package.json` | Add @anthropic-ai/claude-agent-sdk, remove @openai/codex-sdk |
| `apps/desktop/scripts/verify-ai-sdks.cjs` | Update SDK verification list |

**Files NOT modified** (safety boundary):
- `providerResolver.ts` — untouched, coordinator keeps its Vercel AI SDK path
- `coordinatorAgent.ts` — untouched, independent streamText path
- `orchestratorService.ts` — untouched, calls public API only
- `workerDeliveryService.ts` — untouched, calls public API only
- `unifiedOrchestratorAdapter.ts` — untouched, calls createSession only
- `chatMessageService.ts` — untouched, calls steer only
- `aiOrchestratorService.ts` — untouched, calls sendMessage/interrupt/dispose only
- `openclawBridgeService.ts` — untouched, calls sendMessage only
- `linearDispatcherService.ts` — untouched, calls sendMessage only
- `registerIpc.ts` — untouched, routes to public API only
- `preload.ts` — untouched, bridges to IPC only

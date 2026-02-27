# Phases 1-2: Foundation (Complete)

## Phase 1 -- Agent SDK Integration + AgentExecutor Interface (3-4 weeks)

Goal: Replace all legacy AI call paths with subscription-powered agent SDKs unified behind ADE's `AgentExecutor` interface. Establish the execution layer that all downstream phases build on.

### Reference docs

- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — SDK strategy, AgentExecutor interface, ClaudeExecutor and CodexExecutor details, per-task-type configuration, migration path
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — AI provider detection, task routing UI, AI feature toggles, AI usage dashboard, budget controls
- [architecture/JOB_ENGINE.md](../architecture/JOB_ENGINE.md) — AI call site migration (narrative generation, conflict proposals)
- [features/PACKS.md](../features/PACKS.md) — narrative generation pipeline (§ Structured terminal summaries, § Narrative augmentation)
- [features/CONFLICTS.md](../features/CONFLICTS.md) — AI conflict proposal generation (§ Phase 6 completion notes)
- [features/PULL_REQUESTS.md](../features/PULL_REQUESTS.md) — AI PR description drafting
- [features/TERMINALS_AND_SESSIONS.md](../features/TERMINALS_AND_SESSIONS.md) — AI-enhanced terminal session summaries (§ Session concept, TERM-039/040)
- [architecture/CONFIGURATION.md](../architecture/CONFIGURATION.md) — `ai:` config block in `local.yaml` (providers, taskRouting, features, budgets)
- [architecture/CONTEXT_CONTRACT.md](../architecture/CONTEXT_CONTRACT.md) — AI context delivery paths, providerMode values

### Dependencies

- None beyond current baseline.

### Workstreams

#### W1: Package Installation and SDK Wiring
- Add packages: `ai` (Vercel AI SDK core), `ai-sdk-provider-claude-code`, `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk` (transitive dep).
- Wire agent SDKs into main process dependency graph.
- Verify subscription auth works for both: `claude login` for Claude, native ChatGPT Plus/Pro auth for Codex.

#### W2: AgentExecutor Interface
- Define `AgentExecutor` interface: `execute(prompt, opts): AsyncIterable<AgentEvent>` and `resume(sessionId): AsyncIterable<AgentEvent>`.
- Define `ExecutorOpts` with unified permission model (`read-only` / `edit` / `full-auto`), sandbox configuration, tool whitelists/blacklists, model selection, timeout, budget caps, and provider-specific overrides.
- Define `AgentEvent` union type: `text`, `tool_call`, `tool_result`, `structured_output`, `error`, `done`.

#### W3: ClaudeExecutor Implementation
- Wrap `ai-sdk-provider-claude-code` (community Vercel provider) → `@anthropic-ai/claude-agent-sdk` → `claude` CLI subprocess.
- Map ADE's unified permission model to Claude-specific options:
  - `read-only` → `permissionMode: "plan"`
  - `edit` → `permissionMode: "acceptEdits"`
  - `full-auto` → `permissionMode: "bypassPermissions"`
- Configure `settingSources: []` by default (ADE controls settings, not project .claude/settings.json).
- Wire `canUseTool` callback through the Vercel provider for per-invocation tool approval.
- Expose `systemPrompt` for task-specific instructions.
- Expose `maxBudgetUsd` for per-session budget caps.
- Model resolution: map aliases (`opus`, `sonnet`, `haiku`) to full model IDs (`claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`). Use `supportedModels()` SDK method to populate model picker dynamically.
- Subscription auth via `claude login` — ADE never stores credentials.

#### W4: CodexExecutor Implementation
- Wrap `@openai/codex-sdk` directly → `codex` CLI subprocess via JSONL over stdin/stdout.
- **Thread API** for complex tasks: `codex.startThread({ workingDirectory, config })`, `thread.run()`, `thread.runStreamed()`, `codex.resumeThread()`.
- **`codex exec`** for one-pass tasks: spawn `codex exec --full-auto --sandbox read-only --json` via `child_process` for narrative generation, PR descriptions, terminal summaries (Phase 4+ wraps these calls in ephemeral task-agent runtimes).
- Map ADE's unified permission model to Codex-specific options:
  - `read-only` → `sandbox_permissions: "read-only"`, `approval_mode: "untrusted"`
  - `edit` → `sandbox_permissions: "workspace-write"`, `approval_mode: "on-request"`
  - `full-auto` → `sandbox_permissions: "danger-full-access"`, `approval_mode: "never"`
- SDK `config` option overrides project-level `codex.toml` (ADE controls behavior).
- Model selection: `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `codex-mini-latest`, `o4-mini`, `o3`.
- Subscription auth natively supported by official SDK.

#### W5: AI Integration Service
- Create `aiIntegrationService` as the single AI execution surface for all main-process callers.
- Provider model: `guest` (no AI, all local features work) and `subscription` (uses existing CLI subscriptions via agent SDKs).
- Per-task-type model/provider routing with resolution order: step-level hint → task config → mission policy → global default → built-in default → first available CLI.
- All Phase 1 AI tasks were initially one-pass (no multi-turn): send prompt + context, receive result, session ends. Phase 4+ preserves this UX while routing through standardized agent runtime records.

#### W6: Migration — Narrative Generation
- Migrate pack narrative generation from direct CLI spawn to `AgentExecutor.execute()`.
- Default: Claude with `haiku` model, `read-only` permissions, 15s timeout.
- One-shot pattern: build prompt from `LaneExportStandard`, receive structured markdown, apply via marker replacement.
- Deterministic fallback when AI is unavailable (`guest` mode packs remain fully functional).
- Log every call to `ai_usage_log` table.

#### W7: Migration — Conflict Proposals
- Migrate conflict proposal generation to `AgentExecutor.execute()`.
- Default: Claude with `sonnet` model, `read-only` permissions, 60s timeout.
- One-shot pattern: build prompt from `LaneExportLite` × 2 + `ConflictExportStandard`, receive resolution diff + confidence + explanation.
- **New user configuration options** (added to Conflicts tab resolution UI):
  - **Where to apply changes**: target branch / source branch / AI decides optimal location.
  - **Post-resolution action**: apply changes unstaged / stage changes / commit with generated message.
  - **PR behavior**: do nothing / open PR if not already open / add to existing PR.
  - **AI autonomy level**: propose only (user reviews) / auto-apply if confidence > threshold.
- These configuration options are stored in `.ade/local.yaml` under `ai.conflict_resolution`.
- Preserve external CLI resolver chain as alternative path (Terminals tab).

#### W8: Migration — PR Descriptions
- Migrate PR description drafting to `AgentExecutor.execute()`.
- Default: Claude with `haiku` model, `read-only` permissions, 15s timeout.
- One-shot pattern: build prompt from `LaneExportStandard` with commit history, receive PR title + body markdown.

#### W9: Migration — Terminal Summaries
- Migrate terminal session summaries to `AgentExecutor.execute()`.
- Default: Claude with `haiku` model, `read-only` permissions, 10s timeout.
- One-shot pattern: build prompt from session transcript + metadata, receive structured summary (intent detection, outcome assessment, key findings, next steps).
- Displayed in the Session Delta Card in the Terminals tab.

#### W10: Migration — Mission Planning
- Upgrade mission planner from rule/keyword classifier to AI-assisted planning via `AgentExecutor.execute()`.
- Default: Claude with `sonnet` model, `read-only` permissions, 45s timeout.
- One-shot pattern: build structured planner prompt from mission prompt + project context, receive JSON plan conforming to mission plan schema.
- Preserve deterministic planner as fallback when AI is unavailable.

#### W11: Migration — Initial Context Loading
- Migrate onboarding PRD/architecture doc generation from direct CLI spawn to `AgentExecutor.execute()`.
- Uses SDKs (not CLI) — the user never sees a terminal for this operation.
- One-shot pattern: build prompt from repository scan results, receive document drafts.
- CLI is reserved exclusively for: (a) Terminals tab interactive sessions, (b) Work Pane in Lanes tab.

#### W12: Settings — AI Permissions and Sandbox Configuration
- Add a dedicated "AI Permissions & Sandbox" section in Settings (alongside existing provider settings).
- **Claude settings**:
  - Permission mode picker: `plan` (read-only) / `acceptEdits` / `bypassPermissions` (full autonomy)
  - Settings sources: checkboxes for loading user/project/local `.claude/settings.json`
  - Per-session budget cap (USD)
  - Sandbox toggle
- **Codex settings**:
  - Sandbox mode picker: `read-only` / `workspace-write` / `danger-full-access`
  - Approval mode picker: `untrusted` / `on-request` / `never`
  - Writable paths list (additional paths beyond cwd)
  - Command allowlist (shell commands the agent may run)
- These settings persist to `.ade/local.yaml` under `ai.permissions.claude` and `ai.permissions.codex`.
- Displayed with clear explanations of what each option does and security implications.

#### W13: Settings — Model Selection
- Add model picker to each task type row in the Task Model Routing table.
- Populate model lists dynamically:
  - Claude: call `supportedModels()` at startup, display available models with aliases.
  - Codex: hardcoded list (SDK doesn't expose a discovery method): `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `codex-mini-latest`, `o4-mini`, `o3`.
- Users can select any available model for any task type — defaults are suggestions, not requirements.

#### W14: Removal
- Remove `hostedAgentService`, `byokLlmService`, hosted auth, and all Clerk OAuth references.
- Remove all `infra/` and `apps/web` references from build and configuration.
- Remove cloud mirror sync paths.

#### W15: AI Usage Tracking
- Add `ai_usage_log` SQLite table: `id`, `timestamp`, `feature`, `provider`, `model`, `input_tokens`, `output_tokens`, `duration_ms`, `success`, `session_id`.
- Log every AI call from `aiIntegrationService` with structured metadata.
- Per-feature toggle persistence to `.ade/local.yaml` under `ai.features`.
- Per-feature budget controls to `.ade/local.yaml` under `ai.budgets`.
- Budget enforcement: when a daily limit is reached, pause AI calls for that feature with user notification.
- Settings renderer: AI Feature Toggles section, AI Usage Dashboard section (per-feature bars, subscription status, budget controls, usage history).

#### W16: Validation
- Integration tests for `aiIntegrationService` with mock providers.
- Regression tests confirming `guest` mode operation for all migrated paths.
- Settings round-trip tests for per-task-type configuration, permission/sandbox settings, and model selection.
- One-shot execution tests: verify each task type produces expected output format.
- Permission mapping tests: verify ADE's unified model maps correctly to both Claude and Codex provider-specific options.

#### Migration Note
- If Anthropic opens subscription access for the official Agent SDK, switch `ClaudeExecutor` internals to use `@anthropic-ai/claude-agent-sdk` directly, dropping the Vercel provider wrapper. Orchestrator code does not change because all callers use the `AgentExecutor` interface.

### Exit criteria

- All AI call sites route through `aiIntegrationService` via the `AgentExecutor` interface.
- `ClaudeExecutor` and `CodexExecutor` implementations pass integration tests against their respective SDKs.
- `AgentExecutor` interface abstracts SDK differences; orchestrator and job engine callers have no direct SDK imports.
- One-shot execution works for all 6 task types: narratives, conflict proposals, PR descriptions, terminal summaries, mission planning, initial context generation.
- Conflict resolution UI exposes user configuration options: change target, post-resolution action, PR behavior, AI autonomy level.
- No references to hosted backend, BYOK, Clerk, or API keys remain in the codebase.
- `guest` mode preserves full local functionality without AI.
- Per-task-type model/provider configuration persists and applies correctly.
- AI permissions/sandbox settings persist and map correctly to both Claude and Codex SDKs.
- Model selection dynamically populates from available models and persists per task type.
- AI usage is tracked per feature with configurable budget controls and visible in Settings.
- CLI is only used interactively in Terminals tab and Lanes Work Pane — all programmatic AI tasks use SDKs.
- Onboarding completes without sign-up or authentication.
- Initial context loading (PRD/arch docs) uses SDKs, not CLI.

---

## Phase 1.5 -- Agent Chat Integration (2-3 weeks, parallel with Phase 1)

Goal: Build a native agent chat interface inside ADE — a rich, provider-agnostic chat UI that lets users work interactively with Codex and Claude directly in lanes. Chat sessions are first-class sessions with full context tracking, delta computation, and pack integration. The UI replicates the core Codex app experience while also supporting Claude via the same community SDK used in Phase 1.

### Reference docs

- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — AgentChatService interface, CodexChatBackend (App Server protocol), ClaudeChatBackend (community provider multi-turn), ChatEvent types
- [features/TERMINALS_AND_SESSIONS.md](../features/TERMINALS_AND_SESSIONS.md) — Agent chat sessions as a session type, session lifecycle integration, chat transcript storage, delta computation
- [features/LANES.md](../features/LANES.md) — Work Pane agent chat view (alternative to terminal view)
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — Chat-specific settings (default provider, approval preferences, model selection)
- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — agentChatService in the service graph

### External references

- **Codex App Server protocol**: https://developers.openai.com/codex/app-server — JSON-RPC 2.0 protocol for building custom Codex frontends. Full specification for threads, turns, items, streaming, approvals, steering, models, skills, and configuration.
- **Codex App Server Node.js example**: https://developers.openai.com/codex/app-server (bottom of page) — Reference `child_process` spawn + JSONL readline implementation.
- **Codex App Server schema generation**: `codex app-server generate-ts --out ./schemas` — generates TypeScript types matching the exact protocol version installed.
- **Codex App features reference**: https://developers.openai.com/codex/app/features — UI patterns, split view, review pane, thread forking, pop-out windows.
- **Codex models**: https://developers.openai.com/codex/models — Available models and reasoning effort levels.
- **Community Claude provider**: https://github.com/ben-vargas/ai-sdk-provider-claude-code — Vercel AI SDK provider wrapping Claude Agent SDK. Used for ClaudeChatBackend multi-turn.

### Dependencies

- Phase 1 W1 (package installation) must be complete — SDKs installed and wired.
- Phase 1 W3/W4 (executor implementations) provide model lists and auth detection.
- No dependency on Phase 1 completion — can run in parallel once packages are installed.

### Workstreams

#### W1: AgentChatService Interface
- Define `AgentChatService` interface — the provider-agnostic abstraction for interactive chat sessions:
  ```typescript
  interface AgentChatService {
    createSession(laneId: string, provider: "codex" | "claude", model: string): Promise<ChatSession>;
    sendMessage(sessionId: string, text: string, attachments?: FileRef[]): AsyncIterable<ChatEvent>;
    steer(sessionId: string, text: string): Promise<void>;
    interrupt(sessionId: string): Promise<void>;
    resumeSession(sessionId: string): Promise<ChatSession>;
    listSessions(laneId?: string): Promise<ChatSessionSummary[]>;
    approveToolUse(sessionId: string, itemId: string, decision: ApprovalDecision): Promise<void>;
    getAvailableModels(provider: "codex" | "claude"): Promise<ModelInfo[]>;
    dispose(sessionId: string): Promise<void>;
  }
  ```
- Define `ChatEvent` union type mapping both providers to a common stream:
  - `text` — streaming agent text chunks
  - `tool_call` / `tool_result` — tool invocations and results
  - `file_change` — file edit with path and diff
  - `command` — shell command execution with live output
  - `plan` — step-by-step plan with per-step status
  - `reasoning` — thinking/reasoning summary blocks
  - `approval_request` — needs user decision (accept/decline/accept-for-session)
  - `status` — turn lifecycle (started, completed, interrupted, failed)
  - `error` — error with codex error info or Claude error details
  - `done` — session turn complete
- Define `ChatSession`, `ChatSessionSummary`, `ApprovalDecision`, `ModelInfo`, `FileRef` types.

#### W2: CodexChatBackend (App Server Protocol)
- Spawn `codex app-server` as a child process via `child_process.spawn("codex", ["app-server"])`.
- Implement JSON-RPC 2.0 client over JSONL stdin/stdout:
  - `initialize` handshake with `clientInfo: { name: "ade", title: "ADE", version: "<ade-version>" }`.
  - `initialized` notification.
  - Request/response correlation via `id` field.
  - Notification handling (no `id` field).
- Map Codex App Server primitives to `AgentChatService`:
  - `thread/start` → `createSession()` with `model`, `cwd` (lane worktree), `approvalPolicy`, `sandbox`.
  - `turn/start` → `sendMessage()` with text + optional image/file attachments.
  - `turn/steer` → `steer()` — inject instructions into active turn.
  - `turn/interrupt` → `interrupt()`.
  - `thread/resume` → `resumeSession()` with stored `threadId`.
  - `thread/list` → `listSessions()` filtered by `cwd`.
  - `model/list` → `getAvailableModels()`.
- Map Codex notifications to `ChatEvent` stream:
  - `item/agentMessage/delta` → `ChatEvent.text`
  - `item/started` (commandExecution) → `ChatEvent.command`
  - `item/commandExecution/outputDelta` → `ChatEvent.command` (output append)
  - `item/started` (fileChange) → `ChatEvent.file_change`
  - `item/*/requestApproval` → `ChatEvent.approval_request`
  - `turn/plan/updated` → `ChatEvent.plan`
  - `item/reasoning/summaryTextDelta` → `ChatEvent.reasoning`
  - `turn/completed` → `ChatEvent.done`
  - `turn/started` → `ChatEvent.status`
- Approval handling: `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` → present overlay in UI → user responds → send accept/decline/cancel back to app server.
- Thread lifecycle: archive, fork, rollback, compaction exposed for future use.
- Rate limit tracking: `account/rateLimits/read` → feed into AI usage dashboard.
- Error handling: map `codexErrorInfo` values (ContextWindowExceeded, UsageLimitExceeded, etc.) to user-facing messages.

#### W3: ClaudeChatBackend (Community Provider Multi-Turn)
- Use `ai-sdk-provider-claude-code` (same SDK from Phase 1) in multi-turn mode.
- Implement `AgentChatService` using Vercel AI SDK's `streamText()` with `messages` array:
  - `createSession()` → initialize messages array, store session state in memory.
  - `sendMessage()` → append user message, call `streamText()`, yield `ChatEvent` from stream chunks.
  - `steer()` → not natively supported by Claude SDK. Implementation: set a flag, on next yield point inject the steer text as a follow-up user message.
  - `interrupt()` → abort the stream via `AbortController`.
  - `resumeSession()` → reload stored messages array and resume conversation.
- Map Claude stream events to `ChatEvent`:
  - Text chunks → `ChatEvent.text`
  - Tool calls (via `canUseTool` callback) → `ChatEvent.tool_call` / `ChatEvent.approval_request`
  - Tool results → `ChatEvent.tool_result`
  - Structured output → extracted from final text
- Tool use approval: `canUseTool` callback intercepts every tool invocation → present in chat UI → user approves/denies → callback returns decision.
- Session state: maintain `messages[]` in memory (bounded by token budget). Persist to disk for resume (`.ade/chat-sessions/<sessionId>.json`).
- Model selection: use `supportedModels()` from SDK for `getAvailableModels()`.
- Permission control: inherit from Settings (Phase 1 W12) — `permissionMode`, `allowedTools`, `maxBudgetUsd`.

#### W4: Session Integration
- Map agent chat sessions to `terminal_sessions` table:
  - `tool_type`: `"codex-chat"` or `"claude-chat"` (new values added to `TerminalToolType` union).
  - `pty_id`: null (no PTY — chat uses JSON-RPC / SDK streams instead).
  - `tracked`: always `true` (chat sessions always produce context).
  - `transcript_path`: points to chat message log (`.ade/transcripts/<session-id>.chat.jsonl` — JSONL format with all ChatEvents).
  - `head_sha_start` / `head_sha_end`: captured at session create and last turn complete.
  - `summary`: generated from chat transcript (deterministic: last turn's outcome. AI: full session summary).
  - `last_output_preview`: last agent message text (truncated).
  - `resume_command`: stored as provider + threadId/sessionId for resume.
- Session delta computation: same algorithm as terminal sessions — diff `head_sha_start` vs current state, scan chat events for `file_change` items, extract failure lines from `command` events.
- Wire into `onSessionEnded` callback chain: job engine, agent service (automation pipeline), and orchestrator all receive chat session end events.
- Chat sessions appear in both:
  - **Terminals tab** session list (with "codex-chat" or "claude-chat" tool type badge)
  - **Lanes tab** Work Pane (in the agent chat view)

#### W5: Chat UI — Message List Component
- `AgentChatMessageList.tsx` — renders a scrollable list of chat events grouped by turns.
- Message item types (each rendered as a distinct card/bubble):

| Item Type | UI Rendering | Reference |
|-----------|-------------|-----------|
| User message | Right-aligned bubble with text, file attachments as chips | Standard chat pattern |
| Agent text | Left-aligned bubble with streaming markdown (use `react-markdown` + syntax highlighting) | Codex app agent messages |
| Command execution | Inline terminal block: command header, collapsible live output (monospace), exit code badge, duration | Codex app `commandExecution` items |
| File change | Inline diff viewer: file path header, unified diff with syntax highlighting (reuse `ConflictFileDiff` or Monaco diff) | Codex app `fileChange` items |
| Plan | Step list with status indicators: pending (gray), in-progress (blue spinner), completed (green check), failed (red x) | Codex app plan items |
| Reasoning | Collapsible "Thinking..." block with summary text, expandable for full reasoning | Codex app reasoning items |
| Approval request | Sticky overlay at bottom of chat: description of what needs approval, Accept / Decline / Accept for Session buttons | Codex app approval flow |
| Error | Red-tinted message block with error details and suggested actions | Standard error pattern |

- Auto-scroll: scroll to bottom on new content unless user has scrolled up (standard chat behavior).
- Turn separators: subtle divider between turns showing turn number and timestamp.
- Streaming indicator: animated dots/cursor while agent is generating text.

#### W6: Chat UI — Composer Component
- `AgentChatComposer.tsx` — input area at the bottom of the chat pane.
- Components:
  - **Text input**: Multi-line textarea with `Cmd+Enter` or `Enter` to send (configurable).
  - **Provider/Model selector**: Dropdown showing detected providers (Codex, Claude) and their available models. Remembers last selection per lane.
  - **File attachment**: `@` key triggers fuzzy file search popup — attach files as context references.
  - **Send button**: Sends `turn/start` (Codex) or appends to messages + `streamText()` (Claude).
  - **Steer indicator**: When a turn is active, the input area shows "Steering..." label and Enter sends `turn/steer` instead of starting a new turn.
  - **Interrupt button**: Red stop icon, visible when a turn is active. Sends `turn/interrupt` (Codex) or aborts stream (Claude).
  - **Approval quick-actions**: When an approval is pending, show Accept/Decline buttons inline in the composer area.
- **Keyboard shortcuts**:
  - `Enter` (while turn active): Steer the active turn
  - `Enter` (while idle): Send new message
  - `Escape`: Cancel current input / dismiss approval
  - `Cmd+.` or `Ctrl+.`: Interrupt active turn

#### W7: Chat UI — Integration with Lanes Tab
- **Work Pane**: Add a view toggle to `LaneWorkPane.tsx`:
  - **Terminal view** (existing): Shows `LaneTerminalsPanel` with PTY sessions
  - **Chat view** (new): Shows `AgentChatPane` with the agent chat interface
  - Toggle via tabs or segmented control at the top of the Work Pane
- **AgentChatPane** layout:
  ```
  +-----------------------------------------------+
  | [Terminal View] [Chat View]  (toggle)          |
  +-----------------------------------------------+
  | Chat Messages (scrollable)                     |
  |                                                |
  | [User]: "Fix the auth middleware timeout"      |
  |                                                |
  | [Codex]: "I'll look at the auth middleware..." |
  |   📁 src/middleware/auth.ts  +12 -3            |
  |   (inline diff viewer)                         |
  |                                                |
  |   $ npm test                                   |
  |   > 31 tests passed ✓                          |
  |                                                |
  | [User]: "Also add rate limiting"               |
  |                                                |
  | [Codex]: "Adding rate limiting..."             |
  |   (streaming...)                               |
  |                                                |
  +-----------------------------------------------+
  | [@ attach] [Model: gpt-5.3-codex ▾] [Send ▶]  |
  | Type a message...                              |
  +-----------------------------------------------+
  ```
- New chat sessions created from the Chat view are automatically scoped to the selected lane (cwd = lane worktree).
- Existing chat sessions for the selected lane are shown in the Chat view — user can switch between them via a session dropdown or tabs.

#### W8: Chat UI — Integration with Terminals Tab
- Chat sessions appear in the Terminals tab session list alongside PTY sessions.
- Tool type badges: "codex-chat" (blue), "claude-chat" (purple) — distinct from "codex" and "claude" (which are CLI sessions).
- Clicking a chat session in Terminals tab opens the chat view (not a terminal view).
- Session filters: `TerminalToolType` expanded to include `"codex-chat"` and `"claude-chat"`.
- Session delta card: same display as terminal sessions — files changed, insertions, deletions, AI summary.
- Resume: clicking resume on an ended chat session calls `agentChatService.resumeSession()`.

#### W9: Settings — Chat Configuration
- Add chat-specific settings to the Settings page (under AI Provider section):
  - **Default chat provider**: Codex / Claude / Last used
  - **Default approval policy**: Auto (never ask) / Approve mutations / Approve everything
  - **Send on Enter**: Toggle between Enter-to-send and Cmd+Enter-to-send
  - **Codex sandbox policy**: Read-only / Workspace write / Full access (overrides default for chat sessions)
  - **Claude permission mode for chat**: Plan / Accept edits / Bypass permissions
- Settings persist to `.ade/local.yaml` under `ai.chat`.

#### W10: Validation
- CodexChatBackend: JSON-RPC handshake, thread CRUD, turn lifecycle, streaming, approval round-trip, error handling tests.
- ClaudeChatBackend: multi-turn conversation, streaming, tool approval, session persistence, resume tests.
- Session integration: chat sessions appear in session list, delta computation, callback chain, resume flow.
- UI component tests: message rendering for each item type, composer input/send, approval overlay, steer/interrupt.
- Cross-provider: same UI works with both Codex and Claude backends.

### Exit criteria

- Users can open an agent chat in any lane's Work Pane and interact with Codex or Claude via a rich chat interface.
- Chat sessions are tracked as first-class sessions with transcripts, deltas, and pack integration.
- Chat sessions appear in both the Lanes tab (Work Pane chat view) and the Terminals tab (session list).
- The Codex chat experience closely mirrors the Codex desktop app: streaming messages, inline diffs, command output, plan tracking, approval flow, steering.
- Claude chat provides the same UI experience using the community provider in multi-turn mode.
- Users can switch between Codex and Claude in the composer dropdown — same UI, different backend.
- Session resume works for both providers.
- Chat-specific settings (provider, approval policy, sandbox) are configurable in Settings.
- All chat activity feeds into the same context pipeline as terminal sessions (deltas, packs, agents, orchestrator).

---

## Phase 2 -- MCP Server (3-4 weeks)

Goal: Expose ADE capabilities as MCP tools for AI orchestrator consumption. The MCP server is the bridge between the AI orchestrator and the deterministic ADE runtime.

### Reference docs

- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — MCP server tool surface (§ MCP Server), permission/policy layer, call audit logging
- [features/MISSIONS.md](../features/MISSIONS.md) — MCP tool usage from orchestrator (§ AI Orchestrator Session)
- [features/PACKS.md](../features/PACKS.md) — pack export tiers (Lite/Standard/Deep) used as MCP resources
- [features/CONFLICTS.md](../features/CONFLICTS.md) — `check_conflicts` tool contract
- [features/LANES.md](../features/LANES.md) — `create_lane`, `get_lane_status`, `list_lanes` tool contracts
- [architecture/SECURITY_AND_PRIVACY.md](../architecture/SECURITY_AND_PRIVACY.md) — trust boundary for AI tool access

### Dependencies

- Phase 1 complete.

### Workstreams

- Package setup:
  - Create `apps/mcp-server` package with stdio transport (JSON-RPC 2.0).
  - Wire into monorepo build and dev scripts.
- Tool adapters:
  - `spawn_agent` -- spawn a Claude or Codex CLI session in a lane-scoped tracked terminal.
  - `read_context` -- export lane/project/mission pack data for orchestrator consumption.
  - `create_lane` -- create a new lane/worktree for a task.
  - `check_conflicts` -- run conflict prediction against specified lanes.
  - `merge_lane` -- execute merge with conflict-aware sequencing.
  - `ask_user` -- route an intervention request to the ADE UI and await user response.
  - `run_tests` -- execute test commands in a lane-scoped terminal and return results.
  - `get_lane_status` -- return current lane state, diff stats, and rebase status.
  - `list_lanes` -- enumerate active lanes with metadata.
  - `commit_changes` -- stage and commit changes in a lane with a provided message.
- Resource providers:
  - Pack exports (project, lane, feature, conflict, plan, mission packs as structured resources).
  - Lane status snapshots.
  - Conflict prediction summaries.
- Permission and policy:
  - Add permission/policy layer for tool access control (which tools the orchestrator may call, under what conditions).
  - Policy enforcement aligns with agent identity policies (consumed in Phase 4).
- Audit:
  - Add call audit logging for every MCP tool invocation (tool name, arguments, result status, duration, caller identity).
  - Audit records are durable and queryable from History.
- Client testing:
  - Test with Claude Code MCP client mode (`claude --mcp`).
  - Test with Codex MCP client mode.
  - Document MCP server setup for external client consumption.
- Agent Chat UI polish (Phase 1.5 debt):
  - Redesign `AgentChatMessageList.tsx` to match the visual quality of the official Codex desktop app and opencode — rich message bubbles, clean inline diff rendering, polished command execution blocks, smooth streaming indicators, and refined approval overlays.
  - Redesign `AgentChatComposer.tsx` — cleaner input area, better provider/model selector styling, improved attachment UX.
  - Redesign `AgentChatPane.tsx` layout — proper spacing, session management chrome, and responsive panel behavior in the Work Pane split view.
- Agent Chat bug fix — Claude provider selection:
  - Fix bug where users cannot select Claude as the chat provider in the composer dropdown. Ensure both Codex and Claude are selectable when their respective CLIs are detected and authenticated.
- Agent Chat feature — model reasoning effort selector:
  - Add reasoning effort level selector to the chat composer model picker.
  - For Codex models: expose reasoning effort levels (`low`, `medium`, `high`, `extra_high`) as reported by `model/list` in the App Server protocol. Pass selected effort to `thread/start` and `turn/start` via the `reasoningEffort` parameter.
  - For Claude models: expose available model variants (opus, sonnet, haiku) with clear descriptions. The model picker should show all models returned by `supportedModels()`.
  - Persist last-used reasoning effort per lane in session state.
- Validation:
  - Tool contract tests for every adapter (input validation, expected output shape, error handling).
  - Permission denial tests (tool calls that violate policy are rejected with structured errors).
  - Audit completeness tests (every tool call produces an audit record).

#### WS8: Transport Abstraction — SHIPPED
- `JsonRpcTransport` interface decouples the MCP server from any specific transport mechanism.
- Stdio transport (`StdioTransport`) for headless/CLI usage.
- Socket transport (`SocketTransport`) for desktop embedding via Unix domain socket.

#### WS9: Headless AI Integration — SHIPPED
- `aiIntegrationService` wired into MCP server bootstrap for standalone operation.
- Auto-detects available AI providers (`ANTHROPIC_API_KEY`, `claude` CLI, etc.).
- Full AI-powered planning, meta-reasoner, and all 35 tools available in headless mode.

#### WS10: Desktop Socket Embedding — SHIPPED
- Desktop app serves `.ade/mcp.sock` using the same service instances as the main process.
- External agents connect via socket for live UI updates and shared database access.
- Eliminates SQLite write conflicts by sharing the desktop's database connection.

#### WS11: Smart Entry Point — SHIPPED
- MCP server auto-detects whether `.ade/mcp.sock` exists at startup.
- If present: connects as embedded proxy through the desktop socket.
- If absent: starts in headless mode with its own AI backend.

### Exit criteria

- MCP server starts via stdio and serves all defined tools over JSON-RPC 2.0.
- MCP server supports dual-mode operation: headless (stdio) and embedded (socket via `.ade/mcp.sock`).
- External MCP clients (Claude Code, Codex) can query and invoke ADE tools.
- Tool calls honor permission/policy constraints.
- Every tool invocation is audit-logged with structured metadata.
- Agent chat UI is visually polished with rich message rendering matching the quality of the official Codex app.
- Claude is selectable as a chat provider in the composer dropdown.
- Model reasoning effort levels are selectable for both Codex and Claude in the chat composer.

---

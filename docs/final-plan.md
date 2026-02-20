# ADE Final Plan (Canonical Roadmap)

Last updated: 2026-02-20
Owner: ADE
Status: Active

---

## 1. Purpose

This file is the canonical implementation roadmap for future ADE work.

- `docs/PRD.md` remains the product behavior/scope reference.
- This plan defines execution order, dependencies, and delivery gates.
- Feature and architecture docs should align to this file for forward-looking sequencing.

---

## 2. Code-Backed Baseline (Current State)

Baseline derived from code in `apps/desktop`.

### 2.1 Shipped surfaces

- Play (`/project`)
- Lanes (`/lanes`)
- Files (`/files`)
- Terminals (`/terminals`)
- Conflicts (`/conflicts`)
- Context (`/context`)
- Graph (`/graph`)
- PRs (`/prs`)
- History (`/history`)
- Automations (`/automations`)
- Missions (`/missions`)
- Settings (`/settings`)

### 2.2 Shipped capabilities

- Lane/worktree lifecycle with stacks, restack suggestions, auto-rebase status
- PTY sessions with transcripts, summaries, deltas, and lane-scoped quick launch profiles
- File explorer/editor with watch/search/quick-open and atomic writes
- Full git workflow coverage for day-to-day branch operations
- Conflict prediction, risk matrix, merge simulation, proposal apply/undo, external resolver runs
- PR workflows (including stacked and integration PR paths)
- Packs/checkpoints/version/event pipeline with bounded exports
- Automations engine + natural-language planner
- Mission intake/tracking lifecycle (status lanes, steps, interventions, artifacts, events)
- Deterministic orchestrator runtime: DAG scheduling, claims, context snapshots, timeline, gate evaluator
- Executor scaffold adapters for Claude/Codex/Gemini (tracked-session scaffold, not yet AI-driven)
- Mission planning with deterministic planner pass (rule/keyword classifier, dependency/join/done-criteria metadata)
- Local GitHub integration via `gh` CLI

### 2.3 Architectural leverage and constraints

- Main process is already service-oriented and extraction-friendly.
- IPC surface is broad (`234` channels in `apps/desktop/src/shared/ipc.ts`).
- `registerIpc.ts` concentration remains a known extraction bottleneck.
- Core product behavior is local-first and fully operational without any cloud backend.
- Orchestrator runtime (deterministic kernel) is shipped infrastructure; AI orchestration sits on top.

### 2.4 Confirmed gaps

Not implemented yet:

- Agent SDK integration (dual-SDK: `ai-sdk-provider-claude-code` for Claude, `@openai/codex-sdk` for Codex, unified via `AgentExecutor` interface)
- MCP server (`apps/mcp-server`) for AI orchestrator tool access
- AI orchestrator (Claude session via agent SDKs + MCP server for mission execution)
- Agent identities (persona/policy bundles)
- Night Shift automation family
- Play runtime isolation stack (ports/routing/preview/profile isolation)
- Integration sandbox for lane-set verification
- `packages/core` extraction
- Relay and machine registry/routing
- iOS control app

---

## 3. North Star

ADE becomes the execution control plane for parallel agentic development:

1. Users execute AI tasks via existing CLI subscriptions (Claude Pro/Max, ChatGPT Plus) -- no API keys, no sign-up.
2. ADE's `AgentExecutor` interface unifies agent SDKs -- `ai-sdk-provider-claude-code` for Claude and `@openai/codex-sdk` for Codex -- spawning CLIs against user subscriptions.
3. An MCP server exposes ADE capabilities as tools; a Claude session acts as AI orchestrator on top of the deterministic runtime.
4. Missions, lanes, packs, conflicts, and PRs share one coherent execution model.
5. Desktop, relay machines, and iOS share one mission/audit state model.
6. All core features work in `guest` mode (no AI) -- AI orchestration is additive, never mandatory.

---

## 4. Feature Coverage Matrix

Every planned feature in this roadmap is assigned to exactly one primary build phase.

| Feature | Primary Phase | Depends On |
|---|---|---|
| Agent SDK integration + AgentExecutor interface | Phase 1 | Current baseline |
| Agent Chat integration (Codex App Server + Claude SDK) | Phase 1.5 | Phase 1 (partial — SDK wiring) |
| MCP server | Phase 2 | Phase 1 |
| AI orchestrator | Phase 3 | Phases 1 and 2 |
| Agent identities | Phase 4 | Phase 3 |
| Night Shift | Phase 4 | Phase 3 |
| Play runtime isolation | Phase 5 | Phase 3 |
| Integration sandbox + readiness gates | Phase 6 | Phase 5 |
| Core extraction (`packages/core`) | Phase 7 | Phases 3, 5, 6 |
| Relay + Machines | Phase 8 | Phase 7 |
| iOS app | Phase 9 | Phase 8 |

---

## 5. Delivery Rules (All Phases)

- No phase ships with undocumented safety bypass defaults.
- Every new execution path emits durable event/audit records.
- Every phase includes migration notes for existing local state.
- Every phase includes automated test coverage additions.
- Every phase updates impacted docs in the same delivery window.

---

## 6. Program Roadmap (Detailed Phases)

## Phase 1 -- Agent SDK Integration + AgentExecutor Interface (3-4 weeks)

Goal: Replace all legacy AI call paths with subscription-powered agent SDKs unified behind ADE's `AgentExecutor` interface. Establish the execution layer that all downstream phases build on.

### Reference docs

- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — SDK strategy, AgentExecutor interface, ClaudeExecutor and CodexExecutor details, per-task-type configuration, migration path
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — AI provider detection, task routing UI, AI feature toggles, AI usage dashboard, budget controls
- [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md) — AI call site migration (narrative generation, conflict proposals)
- [features/PACKS.md](features/PACKS.md) — narrative generation pipeline (§ Structured terminal summaries, § Narrative augmentation)
- [features/CONFLICTS.md](features/CONFLICTS.md) — AI conflict proposal generation (§ Phase 6 completion notes)
- [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md) — AI PR description drafting
- [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) — AI-enhanced terminal session summaries (§ Session concept, TERM-039/040)
- [architecture/CONFIGURATION.md](architecture/CONFIGURATION.md) — `ai:` config block in `local.yaml` (providers, taskRouting, features, budgets)
- [architecture/CONTEXT_CONTRACT.md](architecture/CONTEXT_CONTRACT.md) — AI context delivery paths, providerMode values

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
- **`codex exec`** for one-shot tasks: spawn `codex exec --full-auto --sandbox read-only --json` via `child_process` for narrative generation, PR descriptions, terminal summaries.
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
- All Phase 1 AI tasks are **one-shot** (no multi-turn): send prompt + context, receive result, session ends. Multi-turn orchestration is deferred to Phase 3.

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

- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — AgentChatService interface, CodexChatBackend (App Server protocol), ClaudeChatBackend (community provider multi-turn), ChatEvent types
- [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) — Agent chat sessions as a session type, session lifecycle integration, chat transcript storage, delta computation
- [features/LANES.md](features/LANES.md) — Work Pane agent chat view (alternative to terminal view)
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — Chat-specific settings (default provider, approval preferences, model selection)
- [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) — agentChatService in the service graph

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
- Wire into `onSessionEnded` callback chain: job engine, automation service, orchestrator all receive chat session end events.
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
- All chat activity feeds into the same context pipeline as terminal sessions (deltas, packs, automations, orchestrator).

---

## Phase 2 -- MCP Server (3-4 weeks)

Goal: Expose ADE capabilities as MCP tools for AI orchestrator consumption. The MCP server is the bridge between the AI orchestrator and the deterministic ADE runtime.

### Reference docs

- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — MCP server tool surface (§ MCP Server), permission/policy layer, call audit logging
- [features/MISSIONS.md](features/MISSIONS.md) — MCP tool usage from orchestrator (§ AI Orchestrator Session)
- [features/PACKS.md](features/PACKS.md) — pack export tiers (Lite/Standard/Deep) used as MCP resources
- [features/CONFLICTS.md](features/CONFLICTS.md) — `check_conflicts` tool contract
- [features/LANES.md](features/LANES.md) — `create_lane`, `get_lane_status`, `list_lanes` tool contracts
- [architecture/SECURITY_AND_PRIVACY.md](architecture/SECURITY_AND_PRIVACY.md) — trust boundary for AI tool access

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

### Exit criteria

- MCP server starts via stdio and serves all defined tools over JSON-RPC 2.0.
- External MCP clients (Claude Code, Codex) can query and invoke ADE tools.
- Tool calls honor permission/policy constraints.
- Every tool invocation is audit-logged with structured metadata.
- Agent chat UI is visually polished with rich message rendering matching the quality of the official Codex app.
- Claude is selectable as a chat provider in the composer dropdown.
- Model reasoning effort levels are selectable for both Codex and Claude in the chat composer.

---

## Phase 3 -- AI Orchestrator (4-5 weeks)

Goal: Full AI-powered mission orchestration via a Claude session connected to the MCP server. The AI orchestrator sits on top of the existing deterministic runtime (DAG scheduling, claims, context snapshots) and makes intelligent decisions about what to do, when, and how.

### Reference docs

- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — AI orchestrator architecture (§ AI Orchestrator), planning phase, step execution, context window management, intervention routing
- [features/MISSIONS.md](features/MISSIONS.md) — mission lifecycle, orchestrator session concept, step DAG, interventions, artifacts, IPC channels, Phase 3 tracking
- [architecture/CONTEXT_CONTRACT.md](architecture/CONTEXT_CONTRACT.md) — context delivery to orchestrator, export tiers, context profiles
- [features/PACKS.md](features/PACKS.md) — mission packs, context hardening policy, bounded exports
- [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) — data flow diagram (mission → orchestrator → agents → results)

### Dependencies

- Phase 1 complete (Agent SDKs and `AgentExecutor` interface available).
- Phase 2 complete (MCP server available).

### Workstreams

#### W1: AI Orchestrator Service (Leader Session)
- Create `aiOrchestratorService` that manages a Claude session acting as team leader with the ADE MCP server connected.
- Orchestrator receives mission prompt + compressed context packs as initial input.
- Orchestrator plans execution steps via AI reasoning, producing a structured `MissionPlan` JSON with step dependencies, executor hints, claim policies, file ownership patterns, and merge policy.
- AI decisions (step ordering, agent selection, plan approval, intervention handling) are recorded as structured `OrchestratorEvent` records.
- Implement plan review gate: optionally present the AI-generated plan to the user before execution begins (configurable via `ai.orchestrator.require_plan_review`).

#### W2: Worker Agent Spawning and Lifecycle
- Implement worker agent spawning via `spawn_agent` MCP tool, creating tracked sessions (`tool_type: "codex-orchestrated"` or `"claude-orchestrated"`).
- Each worker operates in a dedicated lane worktree for file isolation — no two workers share a worktree.
- Workers receive scoped system prompts, bounded context packs, restricted MCP tool whitelists, and configurable permission modes.
- Implement worker lifecycle: `spawned → initializing → working → idle → disposed`.
- Implement idle detection: when a worker completes a step, the orchestrator assigns the next available step or requests shutdown.
- Implement heartbeat monitoring: workers emit claim heartbeats at configurable intervals. Missing heartbeats trigger failure handling.
- Implement graceful shutdown: orchestrator sends shutdown requests, workers acknowledge and exit. Workers with in-progress work can defer shutdown until completion.

#### W3: Shared Task List and Coordination Patterns
- Materialize all mission steps as a shared task list with states: `pending`, `claimed`, `in_progress`, `completed`, `failed`.
- Implement dependency resolution: steps blocked by incomplete predecessors cannot be claimed.
- Implement six coordination patterns:
  - **Sequential Chain**: Worker A → Worker B (output as context).
  - **Parallel Fan-Out**: Multiple workers in separate lanes simultaneously.
  - **Fan-In Merge**: Wait for all parallel workers, then merge lanes.
  - **Plan-Then-Implement**: Worker plans in read-only mode, orchestrator approves, worker implements.
  - **Review-and-Revise**: Implementation worker + review worker, orchestrator decides on revision.
  - **Speculative Parallel**: Multiple workers attempt same step, best result wins.
- Implement `parallelismCap` enforcement from the mission plan (max concurrent workers).

#### W4: File Conflict Prevention and Lane Merging
- Implement claim-based file ownership: each step declares `filePatterns` globs in its claim policy. The planner validates no two parallel steps claim overlapping patterns.
- Implement pre-merge conflict checking: before merging a worker's lane, call `check_conflicts` against other active worker lanes.
- Implement three merge policies:
  - `sequential`: merge each worker's lane immediately after step completion.
  - `batch-at-end`: merge all lanes in dependency order after mission completes.
  - `per-step`: orchestrator decides per-step based on downstream dependencies.
- Implement conflict handoff strategies: `auto-resolve` (use AI conflict resolution), `ask-user` (intervention), `orchestrator-decides` (orchestrator picks resolution).

#### W5: Plan Approval Gates
- Implement `requiresPlanApproval` flag on steps: workers with this flag start in read-only mode (`permissionMode: "plan"`), research the codebase, and submit a structured plan.
- Orchestrator evaluates worker plans: checks for scope creep, file ownership violations, test coverage, alignment with mission goals.
- Implement approve/reject flow: approved workers re-dispatch with edit permissions; rejected workers receive feedback and re-plan.
- Record plan approval events in orchestrator timeline for audit.

#### W6: Integration with Deterministic Runtime
- AI orchestrator issues commands to the existing orchestrator runtime rather than replacing it.
- Step creation, dependency wiring, and join policy decisions are made by AI and executed by the deterministic kernel.
- Claim acquisition, heartbeat, and collision handling remain in the deterministic layer.
- Worker agent sessions integrate with the existing session lifecycle: transcript capture, delta computation, pack refresh, `onSessionEnded` callback chain.

#### W7: Mission Lifecycle Integration
- Integrate with existing mission lifecycle states (`queued` → `planning` → `plan_review` → `in_progress` → `completed`/`failed`).
- Add `plan_review` state for missions with `require_plan_review` enabled.
- AI orchestrator triggers mission state transitions through the existing `missionService` and `orchestratorService`.
- Intervention routing: orchestrator detects need for human input, creates intervention via `ask_user` MCP tool, mission moves to `intervention_required`, user response flows back to orchestrator.
- Implement automatic intervention triggers: step retry exhaustion, unresolvable conflicts, gate failures, budget approaching limits.

#### W8: Context Window Management
- Context packs serve as compressed memory for the orchestrator session.
- Implement progressive context loading: start with mission pack + project pack, load worker result summaries on demand.
- Implement context window pressure management: when utilization exceeds configurable threshold (default 80%), trigger summarization of older step results and intermediate context.
- Orchestrator can always re-read step results from the deterministic runtime's durable state if summarized context is insufficient.

#### W9: Orchestrator Configuration
- Add `ai.orchestrator` configuration block in `.ade/local.yaml`: `require_plan_review`, `max_parallel_workers`, `default_merge_policy`, `default_conflict_handoff`, heartbeat intervals/timeouts, step timeouts, max retries, context pressure threshold, progressive loading toggle, budget caps.
- Settings renderer: Orchestrator section in Settings with controls for all configuration options, with clear explanations and security implications.
- Budget enforcement: when total mission budget or per-step budget is reached, pause execution with user notification.

#### W10: Renderer — Activity Feed
- Real-time activity feed streaming orchestrator decisions and agent outputs to the renderer.
- Feed items include: `step_assigned`, `step_started`, `agent_spawned`, `agent_output` (streamed), `plan_submitted`, `plan_approved`, `plan_rejected`, `intervention_requested`, `step_completed`, `step_failed`, `context_loaded`, `lane_merged`, `conflict_detected`.
- Feed supports filtering by step, worker, event type.
- Live worker count and status indicators (active/idle/completed).

#### W11: Renderer — DAG Visualization
- Visual DAG of the orchestrator's execution plan overlaid on the existing runtime graph.
- Nodes show AI-planned steps with real-time status from the deterministic runtime: pending (gray), claimed (blue), in_progress (animated), completed (green), failed (red).
- Edges show dependencies and data flow between steps.
- Click-to-inspect: clicking a step node opens step detail with context pack, worker assignment, transcript link, result summary.
- Parallel step groups visually clustered to show fan-out/fan-in patterns.

#### W12: Renderer — Worker Transcript Tailing
- Live session transcript tailing for running worker agent sessions in mission detail.
- Transcripts stream from tracked sessions linked to orchestrator attempts.
- Multi-worker view: split pane showing multiple worker transcripts simultaneously (configurable 1-4 panes).
- Transcript events color-coded by type: text (default), tool calls (blue), file changes (green), errors (red), approvals (amber).

#### W13: Validation
- End-to-end orchestrator tests: mission prompt → AI plan → worker spawning → parallel execution → lane merge → completion.
- Plan approval round-trip tests: worker plan → orchestrator review → approve/reject → worker re-dispatch.
- Intervention round-trip tests: orchestrator → UI → user → orchestrator.
- File conflict prevention tests: overlapping file patterns detected at planning time; pre-merge conflict checks work.
- Worker lifecycle tests: spawn, heartbeat, idle detection, graceful shutdown, crash recovery.
- Context window pressure tests: verify summarization triggers and graceful degradation under large missions.
- Crash recovery tests: verify orchestrator resumes from durable runtime state after restart.
- Coordination pattern tests: sequential chain, parallel fan-out, fan-in merge, plan-then-implement, review-and-revise.
- Budget enforcement tests: per-step and total mission budget caps halt execution correctly.

### Exit criteria

- Missions launch AI-powered orchestration from plain-English prompts.
- AI orchestrator plans and executes multi-step, multi-lane workflows using MCP tools.
- Worker agents operate in isolated lane worktrees with scoped permissions and context.
- File conflict prevention works at planning time (claim validation) and at merge time (pre-merge checks).
- Plan approval gates work for complex steps: workers plan in read-only mode, orchestrator reviews.
- All six coordination patterns function: sequential, parallel fan-out, fan-in, plan-then-implement, review-and-revise, speculative parallel.
- Orchestrator decisions flow through the deterministic runtime with full audit trail.
- Interventions route from orchestrator to UI and back with correct lifecycle transitions.
- Activity feed, DAG visualization, and worker transcript tailing provide real-time mission observability.
- Orchestrator session survives restart via deterministic runtime state recovery.
- Worker lifecycle (spawn, heartbeat, idle, shutdown) operates reliably under normal and failure conditions.
- Orchestrator configuration is fully controllable from Settings UI.

---

## Phase 4 -- Agent Identities + Night Shift (3-4 weeks)

Goal: Reusable persona/policy profiles for mission execution and safe unattended scheduled mission batches.

### Reference docs

- [features/MISSIONS.md](features/MISSIONS.md) — mission launch flow (identity selector), executor policy, autopilot mode
- [features/AUTOMATIONS.md](features/AUTOMATIONS.md) — automation engine (Night Shift builds on trigger-action infrastructure)
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard and budget controls (Night Shift reuses this infrastructure), identity management UI in Settings
- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — per-task-type configuration (identities override these defaults), MCP permission/policy layer (identities constrain tool access)
- [architecture/SECURITY_AND_PRIVACY.md](architecture/SECURITY_AND_PRIVACY.md) — trust model for unattended execution

### Dependencies

- Phase 3 complete.

### Workstreams

- Agent identities -- data/contracts:
  - Add identity schema: persona name, system prompt overlay, toolchain defaults (preferred model/provider per task type), risk policies (allowed tools, budget caps, auto-merge policy), permission constraints.
  - Add identity version history for auditability.
- Agent identities -- main process:
  - Add `agentIdentityService` (CRUD + validation + default preset library).
  - Bind identity policy enforcement into AI orchestrator and deterministic runtime execution gates.
  - Identity policies constrain which MCP tools the orchestrator may call and under what conditions.
- Agent identities -- renderer:
  - Identity management UI in Settings (create, edit, clone, delete identities).
  - Mission-level identity selector in launch form.
  - Effective-policy preview (show what the selected identity allows/restricts before launch).
- Night Shift -- budget infrastructure:
  - Night Shift budget caps reuse the per-feature budget infrastructure from Phase 1 (`ai_usage_log` table, `ai.budgets` config). Night Shift runs are constrained by the same daily limits plus additional session-level caps (time limit, step count, total token budget).
- Night Shift -- main process:
  - Add `nightShiftService` on top of automations engine.
  - Implement scheduled mission batches: users queue missions with time/date triggers.
  - Implement budget caps (time limit, step count limit, token limit) and stop conditions (first failure, budget exhaustion, intervention threshold).
  - Add morning digest artifact generator: summary of all Night Shift outcomes, pending reviews, and budget consumption.
  - Implement unattended failure handling: failed missions are parked with structured failure context, not retried without explicit policy.
- Night Shift -- renderer:
  - Night Shift preset builder in Automations (schedule, identity, budget, stop conditions).
  - Morning digest surface with intervention queue and outcome summaries.
- Validation:
  - Identity policy application tests (identity override precedence, denial enforcement).
  - Backward compatibility tests for missions with no explicit identity.
  - Budget enforcement tests (missions stop at budget boundaries).
  - Unattended failure and stop-condition simulations.

### Exit criteria

- Missions can run with selected agent identities that constrain orchestrator behavior.
- Identity policy is consistently enforced by both AI orchestrator and deterministic runtime.
- Identity changes are versioned and auditable.
- Scheduled mission batches execute unattended with hard guardrails.
- Morning digest consistently summarizes outcomes and pending reviews.
- Night Shift runs can be inspected and audited like manual missions.

---

## Phase 5 -- Play Runtime Isolation (5-6 weeks)

Goal: Concurrent lane runtimes without collisions.

### Reference docs

- [features/PROJECT_HOME.md](features/PROJECT_HOME.md) — Run tab (managed processes, stack buttons, test suites)
- [features/LANES.md](features/LANES.md) — lane/worktree lifecycle, lane types
- [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) — PTY sessions in lane worktrees
- [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) — main process service graph (new laneRuntimeService, laneProxyService)

### Dependencies

- Phase 3 complete.

### Workstreams

- Data/contracts:
  - Define runtime lease model (port/host/profile allocation and ownership).
- Main process:
  - Add `laneRuntimeService` (lease allocator + lease lifecycle).
  - Add `laneProxyService` (host-to-port routing).
  - Add `previewLaunchService` + optional `browserProfileService`.
  - Add runtime diagnostics + fallback mode.
- Renderer:
  - Add Play controls for isolated preview launch/stop and diagnostics.
- Validation:
  - Multi-lane collision tests.
  - Lease recovery tests on crash/restart.

### Exit criteria

- Multiple lanes run simultaneously with deterministic routing.
- Isolation state is visible and manageable from Play.
- Failures provide actionable fallback paths.

---

## Phase 6 -- Integration Sandbox + Merge Readiness (3-4 weeks)

Goal: Validate lane combinations before merge/land.

### Reference docs

- [features/CONFLICTS.md](features/CONFLICTS.md) — conflict prediction, merge simulation, risk matrix, proposal workflows
- [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md) — PR readiness gates, land stack flow
- [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md) — graph overlays for merge readiness
- [features/LANES.md](features/LANES.md) — stack workflows, restack operations

### Dependencies

- Phase 5 complete.

### Workstreams

- Data/contracts:
  - Define integration sandbox run records and PR gate signals.
- Main process:
  - Add `integrationSandboxService` for ephemeral lane-set composition.
  - Wire conflict merge plans to sandbox execution hooks.
  - Wire PR readiness/landing gates to sandbox results.
- Renderer:
  - Lane-set selection and sandbox run UX in Play/Conflicts.
  - Merge-readiness overlays in PRs and Graph.
- Validation:
  - Lane-set compose/teardown reliability tests.
  - Gate enforcement tests for PR landing flows.

### Exit criteria

- Users can run pre-merge lane-set verification flows.
- PR and conflict readiness signal one shared truth.
- Optional gate enforcement blocks unsafe land operations.

---

## Phase 7 -- Core Extraction (`packages/core`) (5-7 weeks)

Goal: Decouple core runtime from Electron transport.

### Reference docs

- [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) — main process service graph, IPC contract, registerIpc.ts concentration
- [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) — component breakdown, IPC architecture
- [architecture/DATA_MODEL.md](architecture/DATA_MODEL.md) — SQLite schema (transport-neutral extraction target)
- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — aiIntegrationService and MCP server (must operate through core contracts)

### Dependencies

- Phases 3, 5, and 6 complete.

### Workstreams

- Data/contracts:
  - Stabilize transport-neutral service contracts.
- Refactor:
  - Extract core services to `packages/core` (lanes, git, conflicts, packs, missions, orchestrator, AI integration, MCP server).
  - Break `registerIpc.ts` into domain adapters over shared core APIs.
  - Ensure `aiIntegrationService` and MCP server operate through core contracts, not Electron-specific bindings.
- Validation:
  - Parity tests for desktop adapter vs core behaviors.
  - Regression coverage for hot paths (lanes/pty/git/conflicts/packs).

### Exit criteria

- Core workflows run through transport-agnostic core package.
- Desktop behavior remains functionally equivalent.
- Domain adapters replace monolithic IPC registration structure.

---

## Phase 8 -- Relay + Machines (6-8 weeks)

Goal: Remote machine execution with explicit routing and ownership.

### Reference docs

- [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) — component overview (relay as future component)
- [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) — project switching model (basis for machine context switching)
- [features/MISSIONS.md](features/MISSIONS.md) — execution target metadata (`targetMachineId`), mission lifecycle (shared across machines)
- [architecture/SECURITY_AND_PRIVACY.md](architecture/SECURITY_AND_PRIVACY.md) — trust model extension for relay connections
- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — AgentExecutor interface (must work identically on VPS headless)

### Dependencies

- Phase 7 complete.

### Workstreams

- Data/contracts:
  - Machine identity/capability/heartbeat model.
  - Routing/ownership semantics for mission execution.
- Apps/services:
  - Add `apps/relay` (WS request/response + event streaming).
  - Add machine registry and reconnect semantics.
- Relay architecture:
  - WebSocket server runs on VPS/desktop. Both desktop and iOS connect as clients.
  - Persistent connection with auto-reconnect and exponential backoff.
- Pairing model:
  - One-time QR code or manual address entry for initial pairing.
  - Pairing token stored in OS keychain (macOS Keychain on desktop, iOS Keychain on phone).
  - No login/password/auth screen after initial pairing.
- VPS deployment:
  - ADE core runs headless on VPS alongside MCP server, CLI tools, git repos, SQLite DB, and relay server.
  - Desktop and phone are thin clients connecting to the VPS via WebSocket relay.
- Notification relay skeleton:
  - Minimal APNs relay component for push notifications when phone is backgrounded.
  - Options: tiny Lambda, Firebase Cloud Messaging, or third-party service (OneSignal, Pusher).
  - Keep `infra/` directory skeleton for this component.
- State sync:
  - VPS is source of truth for all mission/audit state.
  - Clients receive state via WebSocket push.
  - Clients cache state locally for instant screen loads.
- Renderer:
  - Add `Machines` tab (health, assignment, sync diagnostics).
  - Add local vs relay execution mode controls.
- Validation:
  - Reconnect and failover tests.
  - Ownership/race-condition tests.
  - Pairing flow tests (QR code, manual entry, token persistence).
  - State sync consistency tests under network interruption.

### Exit criteria

- Desktop can target local or relay machines predictably.
- Machine health and assignment are visible and actionable.
- Cross-machine mission state remains consistent under reconnect/failure.
- QR code / manual pairing completes in a single step with no re-auth required.
- VPS headless deployment runs ADE core, MCP server, and relay with no desktop dependency.
- Notification relay skeleton is in place with documented deployment options.

---

## Phase 9 -- iOS Control App (4-6 weeks)

Goal: Mobile mission control and intervention handling.

### Reference docs

- [features/MISSIONS.md](features/MISSIONS.md) — mission lifecycle, intervention flow, artifacts, mobile-first behavior (§ Mobile-First Behavior)
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard (mirrored on iOS for subscription visibility)
- [features/PACKS.md](features/PACKS.md) — pack exports consumed by iOS for context summaries
- Phase 8 workstreams — relay architecture, pairing model, notification relay, state sync (iOS is a client to this infrastructure)

### Dependencies

- Phase 8 complete.

### Workstreams

- App:
  - Add SwiftUI shell + relay auth/session handling.
  - Add mission inbox, intervention cards, and outcome summary views.
  - Add pack/PR/conflict summary surfaces.
  - Add push notifications for intervention-required/completed runs.
- Thin client architecture:
  - iPhone never runs agents. VPS does all compute.
  - Phone sends intent and displays results.
  - Token-by-token streaming via WebSocket for native-feeling responsiveness.
- Optimistic UI:
  - Phone caches mission state locally (SQLite on device).
  - Actions show immediately (optimistic), VPS confirms async.
- Push notifications:
  - APNs relay for "Mission completed", "Intervention needed", background notifications.
  - Tap notification -> app opens -> WebSocket reconnects -> back to real-time.
- Persistent connection:
  - WebSocket stays alive in background (iOS active session support).
  - Auto-reconnect with exponential backoff on network changes.
- One-time pairing:
  - QR code scan or manual entry on first launch.
  - Pairing token in iOS Keychain.
  - No re-auth needed after initial setup.
- Offline resilience:
  - Cached state available when offline.
  - Queue actions locally, replay when reconnected.
- Validation:
  - Mobile intervention flow tests.
  - Relay event sync latency and consistency checks.
  - Optimistic UI conflict resolution tests (server rejects optimistic action).
  - Push notification delivery tests (foreground, background, terminated states).
  - Offline queue replay tests.

### Exit criteria

- Users can monitor missions and resolve interventions from iOS.
- Mobile actions are reflected in desktop/relay state in near real time.
- Token-by-token streaming provides native-feeling responsiveness for agent output.
- Push notifications reliably surface intervention requests and mission completions.
- Offline cached state displays instantly; queued actions replay correctly on reconnect.
- One-time pairing requires no re-auth after initial setup.

---

## 7. Sequence and Pull-Forward Rules

Base build order:

1. Phase 1 (Agent SDK Integration + AgentExecutor Interface)
1.5. Phase 1.5 (Agent Chat Integration — runs in parallel with Phase 1)
2. Phase 2 (MCP Server)
3. Phase 3 (AI Orchestrator)
4. Phase 4 (Agent Identities + Night Shift)
5. Phase 5 (Play Runtime Isolation)
6. Phase 6 (Integration Sandbox + Merge Readiness)
7. Phase 7 (Core Extraction)
8. Phase 8 (Relay + Machines)
9. Phase 9 (iOS Control App)

Pull-forward rules:

- Phase 5 (Play Runtime Isolation) may begin after Phase 3 starts if resources allow, as it depends on the deterministic runtime (already shipped) rather than the AI orchestrator specifically.
- Phase 2 (MCP Server) and Phase 1 (Agent SDK Integration) may overlap in late Phase 1 for tool contract design work.
- Phase 1.5 (Agent Chat Integration) runs in parallel with Phase 1. It depends only on Phase 1 W1 (package installation) being complete. All other Phase 1.5 work is independent of Phase 1's migration workstreams.

---

## 8. Phase Gate Checklist (Before Next Phase)

Each phase must satisfy:

- Feature behavior validated by automated tests and manual smoke checks.
- No unresolved P0/P1 regressions in lanes/terminals/git/conflicts paths.
- Docs updated: affected feature docs + affected architecture docs + plan references.
- Migration path documented for local DB/state changes.
- Telemetry/audit events emitted for newly introduced execution surfaces.

---

## 9. Primary Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| CLI subscription availability varies by user | Some users may lack Claude or Codex subscriptions | `guest` mode preserves full local functionality; clear subscription detection in onboarding |
| CLI tool stability and breaking changes | Two different SDKs (`ai-sdk-provider-claude-code` and `@openai/codex-sdk`) are in play; provider SDK or CLI updates may break execution paths | Pin provider package versions; `AgentExecutor` interface isolates the orchestrator from SDK-level changes; executor implementations are the only code that touches SDK internals |
| Claude subscription auth policy uncertainty | Anthropic may restrict subscription OAuth in third-party tools | Community Vercel provider workaround; `AgentExecutor` interface enables quick switch to official SDK if policy changes |
| Context window limits under large missions | Orchestrator may lose coherence on complex multi-step missions | Progressive context loading; context pressure management; pack compression |
| Monolithic IPC concentration | Slows core extraction and relay work | Domain adapter split in Phase 7 with parity test gates |
| Unsafe unattended execution | High blast radius in Night Shift | Hard budgets, explicit policy gates, intervention states, identity-level constraints |
| Runtime isolation brittleness | Play instability | Deterministic lease model + diagnostics + fallback mode |
| Cross-device race conditions | Inconsistent mission outcomes | Ownership model + optimistic locking + event sequencing |
| MCP tool permission model gaps | Orchestrator may invoke unsafe operations | Permission/policy layer with deny-by-default; audit logging for all tool calls |
| Codex App Server protocol stability | App Server is relatively new; protocol changes may break integration | Pin `codex` CLI version; generate TypeScript schemas from installed version; adapter pattern isolates protocol changes |
| Claude multi-turn session quality vs Codex | Claude via community provider may have rougher multi-turn UX than Codex's purpose-built App Server | `AgentChatService` interface allows per-provider UX tuning; feature parity is a goal but not a hard requirement |

---

## 10. KPI Framework

### Product KPIs

- Mission prompt -> first meaningful action latency
- Mission completion rate without manual recovery
- AI orchestrator plan quality (step relevance, minimal unnecessary steps)
- Pre-merge issue discovery rate before merge attempt
- Integration sandbox pass rate before land
- Mobile intervention completion rate

### Reliability KPIs

- Orchestrator failure classification coverage
- AI session context window utilization efficiency
- Runtime isolation collision rate
- Relay reconnect success rate
- Conflict prediction false-positive/false-negative trend
- MCP tool call success rate and latency

### Adoption KPIs

- Subscription detection success rate at onboarding
- `guest` vs `subscription` mode usage ratio
- Mission weekly active users
- Night Shift adoption rate

---

## 11. Program Definition of Done

The program is complete when:

- Missions launch complex workflows from plain language with AI-powered orchestration and auditable outcomes.
- AI orchestrator executes across lanes/processes/tests/PRs via MCP tools with robust recovery.
- Orchestrator decisions flow through the deterministic runtime with full context provenance.
- Play supports deterministic lane isolation and integration sandbox verification.
- Automations includes Night Shift with guardrails and reliable morning digests.
- Agent identities provide reusable persona/policy profiles that constrain orchestrator behavior.
- Desktop and iOS can operate against local and relay machine targets.
- MCP server safely exposes ADE capabilities to the AI orchestrator and external agent ecosystems.
- All core features work in `guest` mode without any subscriptions.

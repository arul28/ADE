# ADE Final Plan (Canonical Roadmap)

Last updated: 2026-02-23
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
- Agents (`/agents`) (renamed from Automations in Phase 4)
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
- Automations engine + natural-language planner (rebranded as Agents in Phase 4)
- Mission intake/tracking lifecycle (status lanes, steps, interventions, artifacts, events)
- Deterministic orchestrator runtime: DAG scheduling, claims, context snapshots, timeline, gate evaluator
- Executor scaffold adapters for Claude/Codex/Gemini (tracked-session scaffold, not yet AI-driven)
- Mission planning with deterministic planner pass (rule/keyword classifier, dependency/join/done-criteria metadata)
- Local GitHub integration via `gh` CLI
- AI orchestrator runtime (mission lifecycle, fail-hard planner with 300s timeout)
- PR strategies (integration/per-lane/queue/manual replacing merge phase)
- Team synthesis and recovery loops
- Execution plan preview with approval gates
- Inter-agent messaging (sendAgentMessage IPC, backend routing)
- AgentChannels UI (Slack-style, replaces chat+transcript tabs)
- Model selection per-mission with per-model thinking budgets
- Activity feed with category dropdown (replaces 12+ filter buttons)
- Mission workspace with missionId-filtered queries

### 2.3 Architectural leverage and constraints

- Main process is already service-oriented and extraction-friendly.
- IPC surface is broad (`234` channels in `apps/desktop/src/shared/ipc.ts`).
- `registerIpc.ts` concentration remains a known extraction bottleneck.
- Core product behavior is local-first and fully operational without any cloud backend.
- Orchestrator runtime (deterministic kernel) is shipped infrastructure; AI orchestration sits on top.

### 2.4 Confirmed gaps

Not implemented yet:

- Agents hub (unified autonomous agent system — automation, Night Shift, watcher, review agents)
- Agent identities (persona/policy bundles)
- Morning Briefing (swipeable card review for overnight results)
- Play runtime isolation stack (ports/routing/preview/profile isolation)
- Compute backend abstraction (local/VPS/Daytona)
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

| Feature | Primary Phase | Depends On | Status |
|---|---|---|---|
| Agent SDK integration + AgentExecutor interface | Phase 1 | Current baseline | Complete |
| Agent Chat integration (Codex App Server + Claude SDK) | Phase 1.5 | Phase 1 (partial — SDK wiring) | Complete |
| MCP server | Phase 2 | Phase 1 | Complete |
| AI orchestrator | Phase 3 | Phases 1 and 2 | ~70% |
| Agents hub (Automations → Agents rebrand) | Phase 4 | Phase 3 | Planned |
| Agent identities | Phase 4 | Phase 3 | Planned |
| Night Shift agents | Phase 4 | Phase 3 | Planned |
| Watcher & Review agents | Phase 4 | Phase 3 | Planned |
| Morning Briefing UI | Phase 4 | Phase 3 | Planned |
| Play runtime isolation | Phase 5 | Phase 3 | Planned |
| Compute backend abstraction | Phase 5.5 | Phase 5 | Planned |
| Integration sandbox + readiness gates | Phase 6 | Phase 5 | Planned |
| Core extraction (`packages/core`) | Phase 7 | Phases 3, 5, 6 | Planned |
| Relay + Machines | Phase 8 | Phase 7 | Planned |
| iOS app | Phase 9 | Phase 8 | Planned |

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
- All chat activity feeds into the same context pipeline as terminal sessions (deltas, packs, agents, orchestrator).

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

## Phase 3 -- AI Orchestrator (~70% Complete)

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

### Shipped Workstreams

#### W1: AI Orchestrator Service (Leader Session) — SHIPPED
- `aiOrchestratorService` manages a Claude session acting as team leader with the ADE MCP server connected.
- Orchestrator receives mission prompt + compressed context packs as initial input.
- Orchestrator plans execution steps via AI reasoning, producing a structured `MissionPlan` JSON with step dependencies, executor hints, and claim policies.
- AI decisions recorded as structured `OrchestratorEvent` records.

#### W2: Execution Policies — SHIPPED
- Fail-hard planner with 300-second timeout and `MissionPlanningError` class.
- No deterministic fallback — planner failure = mission failure (forces quality planning).
- Planner normalization rejects generic step labels/descriptions.
- Mission-step dependency resolution preserves explicit empty dependency sets for true fan-out execution.

#### W3: PR Strategies (Replaces Merge Phase) — SHIPPED
- Merge phase completely removed from mission lifecycle.
- Replaced with `PrStrategy` enum: `integration` | `per-lane` | `queue` | `manual`.
- Strategy selected pre-mission in launch configuration.
- Integration: single PR from integration branch; Per-lane: one PR per lane; Queue: sequential merge queue; Manual: user handles PRs.

#### W4: Team Synthesis — SHIPPED
- Multi-agent coordination with role isolation between orchestrator and worker agents.
- Parallel lane auto-provisioning creates child lanes for independent root workstreams.
- Reuses pre-assigned non-base lanes to avoid duplicate lane creation on reruns.

#### W5: Recovery Loops — SHIPPED
- Deterministic health sweep loop in main process: ticks active runs, heartbeats active claims, detects stale running attempts by timeout policy.
- Reconciles attempts when tracked sessions already ended but callbacks were missed.
- Fails/retries stuck attempts and triggers autopilot reassignment.

#### W6: Completion Evaluator — SHIPPED
- Gate evaluator for step and mission completion assessment.
- Status/progress prompts trigger deterministic run telemetry replies (progress, active steps, blockers, recovered stale attempts).

#### W7: Execution Plan Preview — SHIPPED
- Plan review gate: AI-generated plan presented to user before execution begins.
- Configurable via `ai.orchestrator.require_plan_review`.

#### W8: Inter-Agent Messaging — SHIPPED
- `sendAgentMessage()` IPC handler for agent-to-agent communication.
- Backend message routing between agents.
- UI rendering of inter-agent messages in AgentChannels.

#### W9: Activity Feed — SHIPPED
- Category dropdown replaces 12+ filter buttons.
- Real-time activity feed streaming orchestrator decisions and agent outputs to the renderer.
- Feed supports filtering by step, worker, event category.

#### W10: Mission Workspace — SHIPPED
- missionId filter applied to all queries (previously only breakdown).
- Mission detail step-inspector surfaces lane assignment, current step status, worker heartbeat age, dependency names, completion criteria, and expected signals.

#### W11: Model Selection — SHIPPED
- Orchestrator model selector (choose AI model per mission).
- Per-model thinking budgets.

#### W12: Context System — SHIPPED
- Context packs serve as compressed memory for the orchestrator session.
- Progressive context loading: start with mission pack + project pack, load worker result summaries on demand.

### Remaining Workstreams

#### W13: Live Multi-Agent Orchestration
- End-to-end live multi-agent orchestration with real-time coordination.
- Worker agent spawning via `spawn_agent` MCP tool with full lifecycle management.
- Worker lifecycle: `spawned → initializing → working → idle → disposed`.
- Idle detection, heartbeat monitoring, and graceful shutdown.

#### W14: Real-Time Coordination Patterns
- Six coordination patterns: Sequential Chain, Parallel Fan-Out, Fan-In, Plan-Then-Implement, Review-and-Revise, Speculative Parallel.
- `parallelismCap` enforcement from the mission plan.
- Shared task list with dependency resolution.

#### W15: File Conflict Prevention at Merge Time
- Claim-based file ownership: each step declares `filePatterns` globs, planner validates no overlapping patterns.
- Pre-merge conflict checking via `check_conflicts` against active worker lanes.
- Conflict handoff strategies: `auto-resolve`, `ask-user`, `orchestrator-decides`.

#### W16: Worker Transcript Tailing
- Live session transcript tailing for running worker agent sessions in mission detail.
- Multi-worker view: split pane showing multiple worker transcripts simultaneously (configurable 1-4 panes).
- Transcript events color-coded by type: text (default), tool calls (blue), file changes (green), errors (red), approvals (amber).

#### W17: Validation
- End-to-end orchestrator tests: mission prompt → AI plan → worker spawning → parallel execution → completion.
- Coordination pattern tests, intervention round-trip tests, worker lifecycle tests.
- Context window pressure tests, crash recovery tests, budget enforcement tests.

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

## Phase 4 -- Agents Hub (5-6 weeks)

Goal: Rebrand Automations into a unified **Agents** tab — the control center for all autonomous ADE behavior. Users create, configure, and monitor agents that perform work on their behalf: running automations, executing Night Shift tasks, watching repos, and more. Each agent combines an identity (persona + policy), a trigger (when to run), a behavior (what to do), and guardrails (budget + stop conditions).

### Core Concept: What Is an Agent?

An **Agent** in ADE is a configured autonomous unit that performs work on the user's behalf. Every agent follows the same schema:

```
Agent = Identity + Trigger + Behavior + Guardrails
```

- **Identity**: Persona name, system prompt overlay, model/provider preferences, risk policies, permission constraints.
- **Trigger**: When the agent activates — event-driven (commit, session-end), scheduled (cron/time), polling (watch a resource), or manual.
- **Behavior**: What the agent does — run an automation pipeline, execute a mission, watch a repo/API and report findings, run code health scans.
- **Guardrails**: Budget caps (time, tokens, steps, USD), stop conditions (first failure, intervention threshold, budget exhaustion), and approval requirements.

### Agent Types

| Agent Type | Description | Trigger | Example |
|---|---|---|---|
| **Automation Agent** | Wraps the existing trigger-action automation engine. Runs pipelines of actions (update packs, predict conflicts, run tests, run commands). | Event-driven (commit, session-end, schedule, manual) | "On commit, run lint and unit tests" |
| **Night Shift Agent** | Queued tasks that run unattended during off-hours. Stricter guardrails, budget caps, and stop conditions. Produces a morning digest for review. | Scheduled (time-based, e.g., "run at 2am") | "Refactor auth module overnight, park on failure" |
| **Watcher Agent** | Monitors external resources (upstream repos, APIs, logs, dependency feeds) and surfaces findings. Does not modify code — observation only. | Polling (interval-based) or webhook | "Watch react repo for deprecation notices affecting our codebase" |
| **Review Agent** | Watches the team's PR feed and pre-reviews PRs assigned to the user. Summarizes changes, flags concerns, and provides a morning briefing card. | Polling (GitHub API interval) or webhook | "Pre-review my assigned PRs overnight, summarize in morning briefing" |

All agent types share the same underlying schema, identity system, and guardrail infrastructure. The type determines default behavior templates and UI affordances.

### Reference docs

- [features/AGENTS.md](features/AGENTS.md) — Agents tab feature doc (renamed from AUTOMATIONS.md)
- [features/MISSIONS.md](features/MISSIONS.md) — mission launch flow (identity selector), executor policy, autopilot mode
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard and budget controls (agents reuse this infrastructure), identity management UI in Settings
- [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) — per-task-type configuration (identities override these defaults), MCP permission/policy layer (identities constrain tool access)
- [architecture/SECURITY_AND_PRIVACY.md](architecture/SECURITY_AND_PRIVACY.md) — trust model for unattended execution

### Dependencies

- Phase 3 complete.

### Workstreams

#### W1: Rebrand Automations → Agents

- Rename route: `/automations` → `/agents`.
- Update tab label: "AUTOMATIONS" → "AGENTS" (follows ALL-CAPS label convention from design system).
- Update tab icon: from `zap` (automations) to `bot` (agents) — Lucide icon.
- Update tab numbering in sidebar navigation.
- Rename `AutomationsPage.tsx` → `AgentsPage.tsx`.
- Update all IPC channel references: `ade.automations.*` → `ade.agents.*` (maintain backward-compatible aliases during transition).
- Update config key: `automations:` → `agents:` in `.ade/ade.yaml` and `.ade/local.yaml` (with migration for existing configs).
- Rename feature doc: `features/AUTOMATIONS.md` → `features/AGENTS.md`.

#### W2: Agent Schema + Data Model

- Extend the existing `AutomationRule` schema into a unified `Agent` schema:

```typescript
interface Agent {
  id: string;
  name: string;
  type: 'automation' | 'night-shift' | 'watcher' | 'review';
  description?: string;
  icon?: string;                    // Lucide icon name or emoji
  identity: AgentIdentity;          // Persona + policy profile
  trigger: AgentTrigger;            // When to activate
  behavior: AgentBehavior;          // What to do
  guardrails: AgentGuardrails;      // Budget + stop conditions
  enabled: boolean;
  createdAt: string;                // ISO 8601
  updatedAt: string;                // ISO 8601
}

interface AgentIdentity {
  id: string;
  name: string;                     // e.g., "Careful Reviewer", "Fast Implementer"
  systemPromptOverlay?: string;     // Additional system prompt injected into AI sessions
  modelPreferences: {
    provider: 'claude' | 'codex';
    model: string;                  // e.g., "sonnet", "gpt-5.3-codex"
    reasoningEffort?: string;       // e.g., "low", "medium", "high"
  };
  riskPolicies: {
    allowedTools: string[];         // MCP tools this identity may invoke (empty = all)
    deniedTools: string[];          // MCP tools explicitly denied
    autoMerge: boolean;             // Whether the agent can merge without approval
    maxFileChanges: number;         // Max files the agent can modify per run
    maxLinesChanged: number;        // Max lines changed per run
  };
  permissionConstraints: {
    claudePermissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions';
    codexSandboxLevel: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexApprovalMode: 'untrusted' | 'on-request' | 'never';
  };
  version: number;                  // Incremented on every edit for auditability
  versionHistory: AgentIdentityVersion[];
}

interface AgentTrigger {
  type: 'session-end' | 'commit' | 'schedule' | 'manual' | 'poll' | 'webhook';
  cron?: string;                    // For schedule triggers
  branch?: string;                  // Branch filter for commit triggers
  pollIntervalMs?: number;          // For poll triggers (default: 300000 = 5min)
  pollTarget?: {                    // What to poll
    type: 'github-prs' | 'github-releases' | 'npm-registry' | 'url' | 'custom';
    url?: string;
    repo?: string;                  // GitHub owner/repo
    filter?: string;                // Optional filter expression
  };
  scheduleTime?: string;            // HH:MM for Night Shift (local timezone)
  scheduleDays?: string[];          // ['mon','tue','wed','thu','fri'] for weekday-only
}

interface AgentBehavior {
  // For automation agents: action pipeline
  actions?: AgentAction[];

  // For night-shift agents: mission template
  missionPrompt?: string;           // Natural language mission description
  missionLaneId?: string;           // Target lane (optional, agent can create one)
  prStrategy?: 'integration' | 'per-lane' | 'queue' | 'manual';

  // For watcher agents: observation config
  watchTargets?: WatchTarget[];
  reportFormat?: 'card' | 'summary' | 'diff';

  // For review agents: review config
  reviewScope?: 'assigned-to-me' | 'team' | 'all-open';
  reviewDepth?: 'summary' | 'detailed' | 'security-focused';
}

interface AgentGuardrails {
  timeLimitMs?: number;             // Max wall-clock time per run
  tokenBudget?: number;             // Max tokens per run
  stepLimit?: number;               // Max mission steps per run
  budgetUsd?: number;               // Max USD spend per run
  dailyRunLimit?: number;           // Max runs per 24h period
  stopConditions: StopCondition[];  // When to halt
  requireApprovalFor?: string[];    // Actions requiring user approval before execution
  subscriptionAware?: {             // Night Shift subscription utilization settings
    utilizationMode: 'maximize' | 'conservative' | 'fixed'; // How aggressively to use sub capacity
    conservativePercent?: number;   // For 'conservative' mode: max % of available capacity (default: 60)
    weeklyReservePercent?: number;  // % of weekly budget to always keep for daytime use (default: 20)
    respectRateLimits: boolean;     // Pause/reschedule when rate-limited instead of failing (default: true)
    allowMultipleBatches: boolean;  // Schedule work across rate limit resets (default: true)
    priority?: number;              // Agent priority within Night Shift queue (lower = higher priority)
  };
}

type StopCondition =
  | { type: 'first-failure' }
  | { type: 'budget-exhaustion' }
  | { type: 'rate-limited' }       // Stopped because subscription rate limit hit and no reset within window
  | { type: 'reserve-protected' }  // Stopped to protect weekly reserve threshold
  | { type: 'intervention-threshold'; maxInterventions: number }
  | { type: 'error-rate'; maxErrorPercent: number }
  | { type: 'time-exceeded' };
```

- Add `agents` table to SQLite (extends existing `automation_runs` schema):

```sql
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,              -- 'automation' | 'night-shift' | 'watcher' | 'review'
    config TEXT NOT NULL,            -- JSON: full Agent schema
    identity_id TEXT,                -- FK to agent_identities table
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE agent_identities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,            -- JSON: AgentIdentity schema
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE agent_identity_versions (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES agent_identities(id),
    version INTEGER NOT NULL,
    config TEXT NOT NULL,            -- JSON: snapshot of identity at this version
    changed_by TEXT,                 -- 'user' | 'migration'
    created_at TEXT NOT NULL
);
```

- Existing `automation_runs` and `automation_action_results` tables are preserved and reused for agent run tracking. Add `agent_id` column to `automation_runs` to link runs to agents.

#### W3: Agent Identity System

- **`agentIdentityService`** (main process):
  - CRUD operations for identities.
  - Default preset library shipped with ADE:
    - **Careful Reviewer**: Plan-only permission mode, read-only sandbox, low risk tolerance, security-focused review depth.
    - **Fast Implementer**: Accept-edits permission, workspace-write sandbox, higher file/line limits.
    - **Night Owl**: Designed for Night Shift — conservative guardrails, parks on first failure, generates morning digest.
    - **Code Health Inspector**: Read-only, observation-focused, no code modification allowed, reports findings only.
  - Identity version history: every edit increments version and snapshots the previous config.
  - Identity validation: ensures permission constraints don't exceed project-level AI permission settings.

- **Identity policy enforcement**:
  - When an agent runs, its identity's permission constraints are applied to the AI orchestrator and agent executor.
  - Identity `riskPolicies.allowedTools` filters the MCP tool set available to the orchestrator for that run.
  - Identity `riskPolicies.deniedTools` takes precedence over allowed tools (deny wins).
  - Budget caps from identity guardrails are enforced alongside project-level budget limits (lower of the two wins).

- **Identity management UI** in Settings:
  - Identity list with name, type badge, preset indicator, and version number.
  - Create/edit/clone/delete operations.
  - Effective-policy preview: before saving, show exactly what the identity allows and restricts.
  - Diff view between identity versions for audit.

#### W4: Agents Tab — Card-Based UI

The Agents tab replaces the old Automations list view with a card-based agent grid following the ADE design system (`docs/design-template.md`).

- **Page Layout**:
  ```
  +------------------------------------------------------------------+
  | AGENTS                                          [+ NEW AGENT]     |
  | [All] [Automation] [Night Shift] [Watcher] [Review]   [Search]   |
  +------------------------------------------------------------------+
  | ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              |
  | │ 🔧 Lint on   │ │ 🌙 Refactor │ │ 👁 Watch     │              |
  | │    Commit     │ │    Auth      │ │    React     │              |
  | │              │ │              │ │    Releases   │              |
  | │ AUTOMATION   │ │ NIGHT SHIFT  │ │ WATCHER      │              |
  | │ ● Active     │ │ ◐ 2:00 AM   │ │ ● Polling    │              |
  | │ Last: 2m ago │ │ Next: tonight│ │ Last: 1h ago │              |
  | │ ✓ 47 runs    │ │ ✓ 12 runs   │ │ 3 findings   │              |
  | │         [ON] │ │         [ON] │ │         [ON] │              |
  | └──────────────┘ └──────────────┘ └──────────────┘              |
  | ┌──────────────┐ ┌──────────────┐                                |
  | │ 📋 PR Review │ │ 🧹 Code     │                                |
  | │    Agent      │ │    Health    │                                |
  | │              │ │              │                                |
  | │ REVIEW       │ │ WATCHER      │                                |
  | │ ◐ Overnight  │ │ ● Weekly     │                                |
  | │ 5 PRs queued │ │ Last: Mon    │                                |
  | │ 2 flagged    │ │ 14 findings  │                                |
  | │         [ON] │ │         [ON] │                                |
  | └──────────────┘ └──────────────┘                                |
  +------------------------------------------------------------------+
  ```

- **Agent Card** (standard card from design system: `bg-secondary`, `border-default`, `0px` radius):
  - Top: Icon + name (heading-sm, JetBrains Mono 12px/600).
  - Type badge (label-sm, ALL-CAPS, 9px): `AUTOMATION` / `NIGHT SHIFT` / `WATCHER` / `REVIEW` with type-specific accent colors.
  - Status line: active/idle/sleeping/error with colored dot indicator.
  - Stats: last run timestamp, total run count, findings count (for watchers/reviewers).
  - Enable/disable toggle in bottom-right corner.
  - Click opens the Agent Detail panel (right pane or modal).

- **Agent Detail Panel** (split-pane or modal):
  - **Overview tab**: Agent name, description, type, identity selector, trigger config, behavior config, guardrails config.
  - **Runs tab**: Execution history with per-run expandable detail (reuses existing automation run history UI).
  - **Findings tab** (watchers/reviewers only): List of surfaced findings with approve/dismiss/investigate actions.
  - **Edit mode**: Inline editing of all agent fields with save/cancel.
  - **"Run Now" button**: Manual trigger for any agent type.
  - **Delete button** (danger styling from design system).

- **Type filter tabs**: Segmented control at top to filter by agent type (All / Automation / Night Shift / Watcher / Review).
- **Search**: Filter agents by name or description.

#### W5: Custom Agent Builder

A guided wizard for creating new agents, accessible via the "+ NEW AGENT" button.

- **Step 1 — Choose Type**:
  - Four type cards with icon, name, and short description.
  - Each card shows example use cases.
  - Selecting a type loads appropriate defaults for the remaining steps.

- **Step 2 — Configure Identity**:
  - Select an existing identity from the preset library or create a new one inline.
  - Identity picker shows name, model preference, and risk level summary.
  - "Create New Identity" expands an inline form with all identity fields.

- **Step 3 — Set Trigger**:
  - Trigger type selector (visual, not dropdown — each trigger type is a card).
  - Type-specific config:
    - **Event-driven**: Event type dropdown (commit, session-end) + optional branch filter.
    - **Schedule**: Time picker + day selector (weekdays, daily, custom cron).
    - **Poll**: Interval slider + target config (GitHub repo, URL, npm package).
    - **Manual**: No config needed — runs on demand.

- **Step 4 — Define Behavior**:
  - **Automation agents**: Action pipeline builder (add/remove/reorder actions, same as existing automation rule editor).
  - **Night Shift agents**: Mission prompt textarea + lane selector + PR strategy picker.
  - **Watcher agents**: Watch target list + report format selector.
  - **Review agents**: Scope selector + depth selector.

- **Step 5 — Set Guardrails**:
  - Budget controls: time limit, token budget, step limit, USD cap.
  - Stop conditions: checkboxes for first-failure, budget-exhaustion, intervention-threshold.
  - Daily run limit input.
  - Approval requirements: checkboxes for which actions need user approval.

- **Step 6 — Review & Create**:
  - Full summary of the configured agent.
  - Effective policy preview (what the agent can and cannot do).
  - Simulation preview (human-readable description of what will happen when the agent triggers).
  - "Create Agent" button.

- **Natural Language Creation** (alternative to wizard):
  - "Describe what you want" textarea at the top of the wizard.
  - Reuses the existing `automationPlannerService` NL-to-rule planner, extended for new agent types.
  - AI generates a full agent config from the description.
  - User reviews and edits before saving.

#### W6: Night Shift Mode

Night Shift is not a separate system — it's an agent type with specific UX affordances for unattended overnight execution. The core value proposition is **maximizing subscription utilization during idle hours** — Claude and Codex subscriptions have 5-hour rate limit reset windows, and most developers are asleep for 6-8 hours. Night Shift ensures those tokens don't go to waste by scheduling productive AI work while the user sleeps.

- **Night Shift Service** (`nightShiftService`):
  - Built on top of the agent/automation engine.
  - Manages the Night Shift queue: users queue agents with `schedule` triggers for after-hours execution.
  - Enforces strict guardrails: time limits, step caps, token budgets, USD limits.
  - Stop conditions: `first-failure` (park the mission, don't retry), `budget-exhaustion`, `intervention-threshold` (if an agent hits N intervention requests, park it — unattended means nobody is there to respond).
  - Failed runs are parked with structured failure context (error, last step, files changed, diff snapshot) for morning review.
  - Generates a **Morning Digest** artifact at the end of each Night Shift session.

- **Subscription-Aware Scheduling** (core differentiator):
  - Night Shift monitors the user's subscription utilization via rate limit headers and usage tracking:
    - **Claude**: Tracks rate limit headers (`x-ratelimit-*`) from CLI responses. Detects current usage tier (Pro = lower limits, Max = higher limits). Knows the 5-hour rolling window reset.
    - **Codex**: Tracks rate limit responses from the App Server. Detects subscription tier (Plus = lower, Pro = higher).
  - **Utilization modes** (user-selectable):
    - `maximize`: Use all available capacity before the next reset window. Ideal for users who want to squeeze every token out of their subscription overnight. Night Shift schedules work to fill the gap between when the user sleeps and when rate limits reset.
    - `conservative`: Use up to a user-defined percentage of remaining capacity (e.g., 60%). Leaves headroom for the next day's manual work and respects weekly/monthly aggregate limits. This is the default.
    - `fixed`: Ignore subscription utilization — just run the queued tasks with fixed per-agent budgets. For users who prefer explicit control.
  - **Rate limit awareness**:
    - Before starting each Night Shift agent, the service checks current rate limit state.
    - If a rate limit reset is due at 3am and the user queued work at 11pm, Night Shift can schedule a second batch after the 3am reset to use the refreshed capacity.
    - If remaining capacity is below a configurable threshold (e.g., 10%), Night Shift skips lower-priority agents and logs the skip reason.
  - **Weekly/monthly budget protection**:
    - Users set a weekly token/USD reserve: "always keep at least 20% of my weekly budget for daytime use."
    - Night Shift respects this reserve — it will not consume tokens that would drop the user below their reserve threshold.
    - The reserve is calculated from the AI usage dashboard data (`ai_usage_log` table).
  - **Subscription status display**:
    - Night Shift settings show current subscription tier, current rate limit state, estimated available overnight capacity, and projected utilization based on queued agents.
    - A simple bar visualization: `[████████░░░░] 65% of tonight's capacity will be used by queued agents`.
  - **Existing foundation**: `ai_usage_log` table, `logUsage()`, daily `checkBudget()`, aggregated usage queries, and cost estimation are already implemented. The usage dashboard component (`UsageDashboard.tsx`) exists in the Missions tab. Night Shift subscription-aware scheduling builds on this by adding rate limit header capture, tier detection, weekly aggregation, and the subscription status panel.

- **Night Shift Budget Infrastructure**:
  - Extends the existing per-feature budget infrastructure already implemented in `aiIntegrationService`: `ai_usage_log` SQLite table, `logUsage()` recording, daily `checkBudget()` enforcement, aggregated usage queries, and token cost estimation are all shipped.
  - **New for Phase 4**: subscription-aware scheduling layer — rate limit header parsing from Claude/Codex CLI responses, subscription tier detection (Pro/Max for Claude, Plus/Pro for Codex), weekly usage aggregation for reserve calculations, and multi-batch scheduling across rate limit reset windows.
  - Night Shift runs are constrained by: (1) per-agent guardrails, (2) global Night Shift budget cap, (3) subscription rate limits, and (4) weekly reserve protection. The most restrictive limit wins.
  - Budget enforcement is hard — when any cap is hit, the agent stops immediately with a structured budget-exhaustion record.

- **Morning Digest Generator**:
  - Runs after all Night Shift agents complete (or at a configured morning time, e.g., 7am).
  - Aggregates outcomes from all overnight agent runs.
  - Includes subscription utilization summary: how much capacity was used, how much remains, whether any agents were skipped due to rate limits.
  - Produces a structured digest artifact:
    ```typescript
    interface MorningDigest {
      id: string;
      generatedAt: string;
      nightShiftSessionId: string;
      agents: AgentDigestEntry[];
      totalBudgetUsed: BudgetSummary;
      subscriptionUtilization: SubscriptionUtilizationSummary;
      pendingReviews: number;
      requiresAttention: number;
    }

    interface SubscriptionUtilizationSummary {
      claude?: {
        tier: string;               // e.g., "Pro", "Max"
        tokensUsedOvernight: number;
        tokensAvailableAtStart: number;
        rateLimitResetsHit: number; // How many 5h resets occurred during the session
        capacityUtilized: number;   // 0.0-1.0 percentage of available overnight capacity used
        agentsSkippedDueToLimits: number;
      };
      codex?: {
        tier: string;
        tokensUsedOvernight: number;
        tokensAvailableAtStart: number;
        capacityUtilized: number;
        agentsSkippedDueToLimits: number;
      };
      weeklyReserveRemaining: number; // Percentage of weekly reserve still intact
    }

    interface AgentDigestEntry {
      agentId: string;
      agentName: string;
      status: 'succeeded' | 'failed' | 'parked' | 'budget-exhausted' | 'rate-limited' | 'skipped';
      summary: string;              // AI-generated summary of what happened
      findings?: Finding[];          // For watchers/reviewers
      changesProposed?: ChangeSet[]; // For night-shift agents
      prCreated?: string;            // PR URL if created
      failureContext?: FailureContext;
      budgetUsed: BudgetSummary;
      skipReason?: string;           // Why the agent was skipped (rate limit, reserve protection, etc.)
    }
    ```

#### W7: Morning Briefing UI

A distinctive, swipeable card interface for reviewing Night Shift results — inspired by Tinder/TikTok for rapid decision-making.

- **Morning Briefing View** (accessible from Agents tab or as a modal on app launch after Night Shift runs):
  ```
  +------------------------------------------------------------------+
  | MORNING BRIEFING                    ● ● ● ○ ○  (3/5 reviewed)   |
  +------------------------------------------------------------------+
  |                                                                    |
  |  ┌────────────────────────────────────────────────────────────┐  |
  |  │                                                            │  |
  |  │  🌙 NIGHT SHIFT — Refactor Auth Module                    │  |
  |  │                                                            │  |
  |  │  STATUS: SUCCEEDED                                         │  |
  |  │  Agent: Night Owl · Claude Sonnet · 12 steps               │  |
  |  │                                                            │  |
  |  │  WHAT HAPPENED:                                            │  |
  |  │  Extracted auth middleware into dedicated module,           │  |
  |  │  added refresh token rotation, updated 8 test files.       │  |
  |  │  All 142 tests passing.                                    │  |
  |  │                                                            │  |
  |  │  CHANGES:                                                  │  |
  |  │  +347 -128 across 12 files                                 │  |
  |  │  [View Diff]  [View PR #47]                                │  |
  |  │                                                            │  |
  |  │  CONFIDENCE: ████████░░ 82%                                │  |
  |  │                                                            │  |
  |  │  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐      │  |
  |  │  │ APPROVE │  │ DISMISS  │  │ INVESTIGATE LATER   │      │  |
  |  │  │    ✓    │  │    ✗     │  │         ◷           │      │  |
  |  │  └─────────┘  └──────────┘  └─────────────────────┘      │  |
  |  │                                                            │  |
  |  └────────────────────────────────────────────────────────────┘  |
  |                                                                    |
  |  ← Swipe left: Dismiss    Swipe right: Approve →                 |
  |                                                                    |
  +------------------------------------------------------------------+
  | [BULK APPROVE ALL (3)]                    [SKIP TO SUMMARY]       |
  +------------------------------------------------------------------+
  ```

- **Card Types** in Morning Briefing:
  - **Succeeded Mission**: Shows what changed, diff stats, PR link, confidence score, test results. Actions: Approve (merge PR) / Dismiss (close PR) / Investigate Later.
  - **Failed/Parked Mission**: Shows failure reason, last step, partial changes, error context. Actions: Retry / Dismiss / Investigate Later.
  - **Watcher Finding**: Shows what was detected (deprecation, vulnerability, upstream change), affected files, suggested action. Actions: Create Task / Dismiss / Investigate Later.
  - **PR Review Summary**: Shows PR summary, flagged concerns, suggested comments. Actions: Approve PR / Request Changes / Investigate Later.

- **Interaction Model**:
  - **Swipe right** (or click Approve): Executes the approval action (merge PR, create task, approve review).
  - **Swipe left** (or click Dismiss): Dismisses the finding, logs the decision.
  - **Swipe up** (or click Investigate Later): Moves to an "investigate" queue for later review.
  - **Keyboard shortcuts**: Right arrow = approve, Left arrow = dismiss, Up arrow = investigate, Space = expand details.
  - **Progress indicator**: Dots at top showing total items and how many reviewed.
  - **Bulk actions**: "Approve All" for high-confidence items, "Dismiss All Low-Confidence" quick action.

- **Morning Briefing Trigger**:
  - Automatically shown when user opens ADE after Night Shift agents have completed.
  - Also accessible on-demand from the Agents tab header.
  - Badge count on the Agents tab icon shows pending briefing items.

#### W8: Agent Service Refactor

- Rename and extend `automationService` → `agentService`:
  - All existing automation functionality preserved.
  - New agent types (night-shift, watcher, review) registered as additional behavior executors.
  - Agent lifecycle: `created → idle → triggered → running → completed/failed/parked`.
  - Watcher agents: run a polling loop, compare results against previous state, emit findings on change.
  - Review agents: poll GitHub API for assigned PRs, run AI review on new/updated PRs, emit findings.
  - Night Shift agents: execute missions via the orchestrator with identity constraints and guardrails.

- Rename and extend `automationPlannerService` → `agentPlannerService`:
  - Accepts natural language intent and generates full `Agent` config (not just automation rules).
  - Supports all four agent types.
  - Validates generated configs against identity constraints.

- **IPC Channels** (all prefixed `ade.agents.*`):
  - `ade.agents.list()` → Returns `Agent[]` with status and last run info.
  - `ade.agents.get(id)` → Returns single agent with full config.
  - `ade.agents.create(agent)` → Creates a new agent.
  - `ade.agents.update(id, agent)` → Updates agent config.
  - `ade.agents.delete(id)` → Deletes an agent.
  - `ade.agents.toggle(id, enabled)` → Enable/disable.
  - `ade.agents.triggerManually(id)` → Fire agent immediately.
  - `ade.agents.getHistory(id)` → Returns run history.
  - `ade.agents.getRunDetail(runId)` → Returns detailed run.
  - `ade.agents.getFindings(id)` → Returns findings for watcher/review agents.
  - `ade.agents.dismissFinding(findingId)` → Dismiss a finding.
  - `ade.agents.parseNaturalLanguage(args)` → NL-to-agent planner.
  - `ade.agents.validateDraft(args)` → Validate + normalize draft.
  - `ade.agents.simulate(args)` → Human-readable preview.
  - `ade.agents.event` → Push updates for agent state changes.
  - `ade.agents.identities.list()` → Returns all identities.
  - `ade.agents.identities.get(id)` → Returns single identity.
  - `ade.agents.identities.create(identity)` → Creates identity.
  - `ade.agents.identities.update(id, identity)` → Updates identity.
  - `ade.agents.identities.delete(id)` → Deletes identity.
  - `ade.agents.nightShift.getDigest()` → Returns latest morning digest.
  - `ade.agents.nightShift.getQueue()` → Returns queued Night Shift agents.
  - `ade.agents.briefing.getItems()` → Returns pending morning briefing items.
  - `ade.agents.briefing.respond(itemId, action)` → Approve/dismiss/investigate.
  - `ade.agents.briefing.bulkRespond(actions)` → Bulk approve/dismiss.

#### W9: Settings Integration

- **Settings → Agent Identities section**:
  - Identity list with CRUD operations.
  - Preset library (read-only presets shipped with ADE, user presets editable).
  - Version history viewer per identity.

- **Settings → Agents section** (replaces Automations section):
  - Per-agent summary with enable/disable, run-now, and history links.
  - Night Shift global settings:
    - Default Night Shift time window (e.g., 11pm–6am).
    - Default compute backend for Night Shift agents (local/VPS/Daytona).
    - Morning digest delivery time.
    - Global Night Shift budget cap (applies on top of per-agent caps).
    - **Subscription utilization mode**: `maximize` / `conservative` / `fixed` (default: `conservative`).
    - **Conservative mode percentage**: Slider for max % of available overnight capacity to use (default: 60%).
    - **Weekly reserve**: Slider for % of weekly budget to always protect for daytime use (default: 20%).
    - **Multi-batch scheduling**: Toggle to allow Night Shift to schedule work across rate limit reset windows (default: on).
    - **Subscription status panel**: Live display of current subscription tier per provider, current rate limit state, estimated available overnight capacity, and projected utilization bar based on queued agents.
  - Watcher agent global settings:
    - Default poll interval.
    - GitHub API rate limit awareness.

- **Settings → Compute Backends section** update:
  - "Night Shift default" toggle on VPS backend card: route Night Shift agents to VPS automatically.
  - "Night Shift default" toggle on Daytona backend card: route to Daytona instead.

#### W10: Migration & Backward Compatibility

- Existing automation rules are automatically migrated to agents of type `automation`.
- Migration runs on first load after upgrade:
  1. Read existing `automations:` config key.
  2. For each rule, create an `Agent` with `type: 'automation'`, the same trigger/actions, and a default identity.
  3. Write migrated agents to `agents:` config key.
  4. Preserve the old `automations:` key for one version cycle (deprecated, read-only).
- Existing `automation_runs` records remain queryable via the new agent run history UI.
- IPC backward compatibility: old `ade.automations.*` channels are aliased to `ade.agents.*` for one version cycle.

#### W11: Validation

- Agent schema validation tests (all four types, all trigger types, all behavior configs).
- Identity policy application tests (identity override precedence, denial enforcement, tool filtering).
- Identity version history tests (version increment, snapshot accuracy, diff correctness).
- Backward compatibility tests for missions with no explicit identity (default identity applied).
- Backward compatibility tests for existing automations (migration preserves behavior exactly).
- Budget enforcement tests (agents stop at budget boundaries — time, tokens, steps, USD).
- Night Shift stop-condition simulations (first-failure parking, intervention-threshold parking, budget-exhaustion).
- Morning digest generation tests (aggregation accuracy, finding deduplication).
- Morning briefing UI interaction tests (approve/dismiss/investigate actions, bulk actions, keyboard shortcuts).
- Watcher agent polling tests (change detection, finding emission, deduplication).
- Review agent PR detection tests (new PR detection, review generation, finding accuracy).
- Agent builder wizard flow tests (all steps, NL creation, validation on create).
- IPC backward compatibility tests (old `ade.automations.*` channels still work).
- Config migration tests (existing automations → agents, round-trip correctness).

### Exit criteria

- Automations tab is fully rebranded as Agents with card-based UI following the ADE design system.
- Users can create agents of all four types via the guided wizard or natural language.
- Agent identities provide reusable persona/policy profiles that constrain agent behavior.
- Identity policy is consistently enforced by both AI orchestrator and deterministic runtime.
- Identity changes are versioned and auditable.
- Night Shift agents execute unattended with hard guardrails (budget caps, stop conditions).
- Morning Briefing UI provides a swipeable card interface for rapid review of overnight results.
- Morning digest consistently summarizes outcomes, findings, and pending reviews.
- Watcher and Review agents surface actionable findings via the Morning Briefing.
- Existing automations are seamlessly migrated to automation agents with no behavior change.
- Night Shift runs can be inspected and audited like manual missions.
- Agent builder supports both guided wizard creation and natural language description.

---

## Phase 5 -- Play Runtime Isolation (5-6 weeks)

Goal: Concurrent lane runtimes without collisions. Full lane environment initialization, port isolation, hostname-based routing, and preview URL generation.

### Reference docs

- [features/PROJECT_HOME.md](features/PROJECT_HOME.md) — Run tab (managed processes, stack buttons, test suites)
- [features/LANES.md](features/LANES.md) — lane/worktree lifecycle, lane types, lane environment init, proxy & preview, overlay policies
- [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) — PTY sessions in lane worktrees
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — Lane Templates, Proxy & Preview, Browser Profiles settings
- [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) — main process service graph (new laneRuntimeService, laneProxyService)

### Dependencies

- Phase 3 complete.

### Workstreams

#### W1: Lane Environment Init
- BranchBox-style environment initialization on lane creation.
- Environment file copying/templating with lane-specific values (ports, hostnames, API keys).
- Docker service startup for lane-specific Docker Compose services (databases, caches, queues).
- Dependency installation (`npm install`, `pip install`, etc.).

#### W2: Port Allocation & Lease
- Dynamic port range per lane (e.g., 3000-3099 for lane 1, 3100-3199 for lane 2).
- Lease/release lifecycle with crash recovery.
- Port conflict detection and resolution.

#### W3: Per-Lane Hostname Isolation
- `*.localhost` reverse proxy with a single proxy port routing by Host header.
- Hostname pattern: `<lane-slug>.localhost`.
- Cookie/auth isolation via unique hostname per lane — no cross-lane session leakage.

#### W4: Preview Launch Service
- Generate preview URLs per lane.
- Open in browser with one click.
- Share preview links for quick visual review.

#### W5: Lane Template System
- Templates stored in `local.yaml` defining reusable initialization recipes.
- Template selection available in the Create Lane dialog.
- Templates specify env files, port ranges, Docker compose paths, and install commands.
- Project-level default template in Settings.

#### W6: Auth Redirect Handling
- Redirect URI rewriting per-lane hostname.
- OAuth callback routing to correct lane dev server.

#### W7: LaneOverlayPolicy Extension
- Extend existing `laneOverlayMatcher.ts` for env/port/proxy overlays.
- Per-lane overrides for environment variables, port mappings, proxy settings, and compute backend selection.

#### W8: Runtime Diagnostics
- Lane health checks (process alive, port responding, proxy route active).
- Port conflict detection across lanes.
- Proxy status dashboard.
- Fallback mode when isolation fails.

#### W9: Renderer Updates
- Play controls for isolated preview launch/stop and diagnostics.
- Lane template selection in Create Lane dialog.
- Proxy & preview status indicators in lane list.
- Runtime diagnostics panel.

#### W10: Validation
- Multi-lane collision tests.
- Lease recovery tests on crash/restart.
- E2E tests for lane isolation, proxy routing, env init.
- Port exhaustion and conflict detection tests.

### Exit criteria

- Multiple lanes run simultaneously with deterministic routing.
- Lane environment initialization is automatic and template-driven.
- Per-lane hostname isolation prevents cookie/auth leakage between lanes.
- Preview URLs are generated and shareable.
- Isolation state is visible and manageable from Play.
- Failures provide actionable fallback paths.

---

## Phase 5.5 -- Compute Backend Abstraction (3-4 weeks)

Goal: Abstract lane execution behind a pluggable compute backend interface, enabling lanes to run locally, on a VPS, or in Daytona cloud sandboxes (opt-in).

### Reference docs

- [features/LANES.md](features/LANES.md) — compute backend table, lane overlay policies
- [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) — Compute Backends settings
- [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) — main process service graph

### Dependencies

- Phase 5 complete.

### Workstreams

#### W1: ComputeBackend Interface
- Abstract backend interface with `create`, `destroy`, `exec`, `getPreviewUrl` methods.
- Typed configuration per backend.
- Backend capability discovery (supports Docker, supports preview URLs, etc.).

#### W2: Local Backend Adapter
- Implements `ComputeBackend` for local Docker/process execution.
- Default backend — no additional configuration required.
- Uses host machine resources.

#### W3: Daytona Backend (Opt-in)
- Daytona SDK integration for workspace creation and management.
- Opt-in cloud sandbox compute — never required for ADE functionality.
- Requires API key configuration in Settings.
- Region selection and resource allocation (CPU, RAM, disk).
- Auto-stop timeout for idle workspace cleanup.

#### W4: VPS Backend Stub
- Placeholder adapter for Phase 8 relay integration.
- Interface-compliant but delegates to relay connection.

#### W5: Backend Selection & Config
- Per-project default backend in project settings.
- Per-lane backend override on lane creation.
- Per-mission backend selection by orchestrator based on mission requirements.
- Settings UI for backend configuration.

#### W6: Preview URL Unification
- Preview URLs work across all backends.
- Local: `<lane-slug>.localhost` proxy.
- Daytona: SDK-provided workspace URL.
- VPS: relay-routed preview.

#### W7: Validation
- Backend interface contract tests.
- Local backend parity tests (existing behavior preserved).
- Daytona backend integration tests (opt-in, requires API key).
- Backend selection persistence and override tests.

### Exit criteria

- Lanes can execute on Local, Daytona, or VPS (stub) backends via unified interface.
- Daytona is fully opt-in with clear configuration in Settings.
- Preview URLs work across all backends.
- Backend selection is configurable per-project, per-lane, and per-mission.

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
  - Machine identity/capability/heartbeat model with support for local/VPS/Daytona types.
  - Routing/ownership semantics for mission execution.
  - Wire VPS `ComputeBackend` adapter (Phase 5.5 W4 stub) to relay connection.
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
  - Add preview URL viewer per backend (Local proxy, Daytona workspace URL, VPS relay).
  - Phone-only development via Daytona: launch missions targeting Daytona backend from iOS without a desktop machine.
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

1. Phase 1 (Agent SDK Integration + AgentExecutor Interface) — **Complete**
1.5. Phase 1.5 (Agent Chat Integration) — **Complete**
2. Phase 2 (MCP Server) — **Complete**
3. Phase 3 (AI Orchestrator) — **~70% Complete**
4. Phase 4 (Agents Hub)
5. Phase 5 (Play Runtime Isolation)
5.5. Phase 5.5 (Compute Backend Abstraction)
6. Phase 6 (Integration Sandbox + Merge Readiness)
7. Phase 7 (Core Extraction)
8. Phase 8 (Relay + Machines)
9. Phase 9 (iOS Control App)

Pull-forward rules:

- Phase 5 (Play Runtime Isolation) may begin after Phase 3 starts if resources allow, as it depends on the deterministic runtime (already shipped) rather than the AI orchestrator specifically.
- Phase 2 (MCP Server) and Phase 1 (Agent SDK Integration) may overlap in late Phase 1 for tool contract design work.
- Phase 1.5 (Agent Chat Integration) runs in parallel with Phase 1. It depends only on Phase 1 W1 (package installation) being complete. All other Phase 1.5 work is independent of Phase 1's migration workstreams.
- Daytona SDK exploration may begin during Phase 5 to derisk Phase 5.5 integration.

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
| localhost subdomain browser compatibility | Safari/Firefox may not resolve `*.localhost` subdomains | Feature detection at startup; fallback to port-based isolation; document browser requirements |
| Daytona SDK stability | Pre-1.0 SDK, API may change between versions | Pin SDK version; `ComputeBackend` interface isolates callers; Daytona is always opt-in |
| Port exhaustion on machines with many lanes | Machines with 20+ lanes may exhaust ephemeral port ranges | Configurable port range size per lane; lease release on lane archive; diagnostics for port pressure |
| Docker dependency for lane environment init | Lane env init features require Docker for service startup | Docker is optional; env file copying and dependency install work without Docker; clear error messages when Docker is unavailable |

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
- Lane setup time: <5s (env init + port allocation + proxy registration)
- Port collision rate: 0%
- Proxy latency overhead: <5ms per request
- Daytona workspace creation latency: <15s

### Adoption KPIs

- Subscription detection success rate at onboarding
- `guest` vs `subscription` mode usage ratio
- Mission weekly active users
- Night Shift agent adoption rate
- Morning Briefing items approved vs. dismissed ratio
- Watcher/Review agent finding actionability rate
- Agent builder completion rate (wizard started vs. agent created)

---

## 11. Program Definition of Done

The program is complete when:

- Missions launch complex workflows from plain language with AI-powered orchestration and auditable outcomes.
- AI orchestrator executes across lanes/processes/tests/PRs via MCP tools with robust recovery.
- Orchestrator decisions flow through the deterministic runtime with full context provenance.
- Play supports deterministic lane isolation and integration sandbox verification.
- Agents tab provides unified autonomous agent system with automation, Night Shift, watcher, and review agent types.
- Agent identities provide reusable persona/policy profiles that constrain agent and orchestrator behavior.
- Night Shift agents execute unattended with hard guardrails and produce reliable morning digests.
- Morning Briefing provides a swipeable card interface for rapid review of overnight agent results.
- Desktop and iOS can operate against local and relay machine targets.
- MCP server safely exposes ADE capabilities to the AI orchestrator and external agent ecosystems.
- Compute backend abstraction enables lanes to execute on Local, VPS, or Daytona (opt-in) backends.
- Preview URLs work across all compute backends with unified generation and access.
- Lane isolation (env, ports, hostname, cookies) prevents cross-lane interference.
- All core features work in `guest` mode without any subscriptions.

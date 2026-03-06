# Phase 4: CTO + Ecosystem

## Phase 4 -- CTO + Ecosystem (4-5 weeks)

Goal: Add the CTO agent as a persistent project-aware assistant with a configurable org chart of worker agents. Absorb Night Shift into Automations. Complete the memory architecture upgrade. Expand external ecosystem integration.

### Reference docs

- [features/CTO.md](../features/CTO.md) — CTO agent design, memory architecture, OpenClaw integration architecture
- [features/MISSIONS.md](../features/MISSIONS.md) — mission launch flow, executor policy, autopilot mode
- [features/AUTOMATIONS.md](../features/AUTOMATIONS.md) — automation rules, trigger-action engine (Night Shift absorbed here)
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard and budget controls
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — per-task-type configuration, MCP permission/policy layer
- [architecture/SECURITY_AND_PRIVACY.md](../architecture/SECURITY_AND_PRIVACY.md) — trust model for unattended execution

### Dependencies

- Phase 3 complete (orchestrator autonomy + missions overhaul).
- Existing orchestrator infrastructure: planner, worker spawning, inter-agent messaging, context compaction, phase engine, validation, intervention — all consumed and extended.
- Phase 4 has **zero dependency on Phase 5** (Play Runtime Isolation). Both phases depend only on Phase 3 and run fully in parallel.

### Prior Art

This phase draws heavily from three open-source projects. Each workstream credits its source patterns inline.

| Source | What ADE Adopts | What ADE Skips |
|--------|----------------|----------------|
| **[Paperclip](https://github.com/paperclipai/paperclip)** — `doc/SPEC.md`, `doc/SPEC-implementation.md` | Org chart with `reportsTo` hierarchy and cycle detection (§3 Org Structure), heartbeat system with coalescing and deferred promotion (§4 Heartbeat System), multi-adapter pattern with `process`/`http` interfaces (§4 Execution Adapters), config versioning with rollback (§2 Agent Model), budget auto-pause with monthly reset (§6 Cost Tracking), task session persistence keyed by `(agentId, adapterType, taskKey)` (§2), agent identity schema (§7.2 `agents` table), atomic issue checkout (§8 Concurrency Model) | Multi-company model (ADE is single-project), PostgreSQL dependency (ADE uses SQLite), approval gates for hiring (too heavy for single-user), Board governance layer (user IS the board), billing codes / cost attribution hierarchy |
| **[Symphony](https://github.com/openai/symphony)** — `SPEC.md` | Linear polling loop with candidate filtering (§8.2), per-state concurrency limits via `max_concurrent_agents_by_state` (§8.3), active-run reconciliation — terminal→cancel, reassign→release (§8.5), stall detection with configurable `stall_timeout_ms` (§8.5 Part A), workpad comment pattern — single persistent comment, not multiple (§10), blocker resolution — skip `Todo` with non-terminal blockers (§8.2), dispatch sort order — priority→created_at→identifier (§8.2), `IssueTracker` abstraction for pluggable backends (§3.1 Component 3), mission templates from WORKFLOW.md concept (§5), exponential retry with configurable max backoff (§8.4) | WORKFLOW.md file-driven config (CTO memory is richer), no-DB stateless recovery (ADE has SQLite persistence), workspace-per-issue isolation (ADE has lanes), coding-agent-only focus (ADE has multi-tool agents), Codex-specific app-server protocol (ADE is adapter-agnostic) |
| **[OpenClaw](https://github.com/openclaw/openclaw)** | Three-tier memory (MEMORY.md + daily logs → Tier 1/2/3), pre-compaction flush (silent agentic turn before context eviction), two-tier heartbeat execution (cheap deterministic checks before LLM), HEARTBEAT_OK suppression (no notification when nothing needs attention), SOUL.md identity pattern (→ `identity.yaml`), hybrid BM25+vector search with configurable weights, temporal decay with evergreen exemptions | Channel adapters (ADE is desktop-native), Docker sandboxing, node device system (ADE has its own multi-device sync in Phase 6) |

### Execution Order

Workstreams are numbered by topic but executed in dependency order. W1-W4 and W6 are complete. W5 is split into W5a (in progress) and W5b (remaining). Remaining workstreams execute W7→W5b.

Recent W6 closeout progress (2026-03-05):
- Removed dead renderer compatibility wrappers under `components/packs/`.
- Pruned unreferenced `packService` APIs (legacy refresh/version/diff/checkpoint/narrative helper surface) while keeping only explicit compatibility/export surfaces intact.
- Removed the dead onboarding `generateInitialPacks` no-op and the uncalled two-step context-doc prepare/install IPC bridge.
- Extracted context-doc runtime ownership into `contextDocService.ts` and session-delta ownership into `sessionDeltaService.ts`, so those IPC flows no longer route through `packService`.
- Migrated orchestrator context snapshots to live exports rather than persisted pack bootstrap/head/delta reads.
- Migrated external conflict resolver prompts to generated per-run context files instead of `.ade/packs/...` references.
- Migrated agent chat project/lane/conflict/plan context fetches to live exports, leaving only mission selection as an explicit picker limitation.

W5a kickoff (2026-03-06):
- W5 split into W5a and W5b sub-phases to manage scope and deliver incremental value.
- W5a covers: `usageTrackingService`, `budgetCapService`, IPC wiring, and Automations tab UI overhaul with five-tab layout (Rules / Templates / History / Usage / Night Shift).
- Key architectural decision: **CTO owns Linear dispatch; Automations does NOT duplicate it** (see W5 section for details).
- Usage tracking service design inspired by [CodexBar](https://github.com/steipete/CodexBar) — OAuth API polling + local cost scanning + pacing calculation.
- Competitive analysis incorporated from Cursor Automations (Mar 2026) and Codex Agents SDK (see W5 section).

```
Wave 1 (complete):
  W1: CTO Agent Core                  ✅ shipped
  W2: Worker Agents & Org Chart       ✅ shipped
  W3: Heartbeat & Activation          ✅ shipped
  W4: Bidirectional Linear Sync       ✅ shipped

Wave 2 (complete):
  W6: Unified Memory System           ✅ complete (runtime migrated; compatibility pack surfaces retained explicitly)
      Note: native sqlite-vec integration is deferred; current retrieval is lexical/composite scoring, and embeddings are not yet active in retrieval.

Wave 3 (after W6):
  W7: Skills + Learning Pipeline      ← needs W6 (episodic → procedural → skill materialization)
  W8: External MCP Consumption        ← independent infra, can parallel with W7

Wave 4 (after W6, can parallel with W7/W8):
  W5a: Automations — Usage + Budget + UI  🔧 in progress (2026-03-06)
  W5b: Automations — Executors + Night Shift + External Triggers  ← needs W5a + stable orchestrator
  W9: OpenClaw Bridge                 ← needs W1, W8
  W10: .ade/ Portable State           ← needs W1, W6
```

Dependency graph:
```
W1 (CTO Core) ──→ W2 (Workers) ──┐
     │                             ├──→ W4 (Linear Sync)     ✅ all complete
     ├──→ W3 (Heartbeat) ─────────┘
     │
     ├──→ W6 (Unified Memory) ──→ W7 (Skills + Learning)
     │         │
     │         ├──→ W5a (Usage + Budget + UI)  🔧 in progress
     │         │         └──→ W5b (Executors + Night Shift + External Triggers)
     │         └──→ W10 (.ade/ State)
     │
     └──→ W9 (OpenClaw) ←── W8 (External MCP)
```

Each workstream includes its own renderer/UI changes and tests (no standalone workstreams for these).

### End-to-End Flows (Workers + Linear Projects)

Phase 4 should enable a "tech department" loop: one persistent agent per employee, each connected to one or more Linear projects, with the CTO coordinating and staying globally informed.

- **Org + ownership setup** (W2 + W4):
  - Create workers (employees) under the CTO.
  - Connect workers to the Linear projects they own (default owner per project; optional label/priority routing).
  - Optionally map each worker to a real Linear user for assignment + attribution.

- **New issue intake → immediate delegation** (W3 + W4):
  1. CTO heartbeat polls configured Linear projects for candidates in active states.
  2. Issues are normalized + filtered (blocked rules, state rules, dedupe).
  3. Routing picks a responsible worker (label routing → project default owner → CTO classification fallback).
  4. CTO dispatches a mission to that worker, respecting budgets + concurrency limits.
  5. Linear issue is assigned (optional), moved to `In Progress`, and gets/updates a single persistent workpad comment.

- **Worker execution loop** (W2 + Phase 3 missions):
  - Worker runs in a lane and can use any ADE tool surface required by the mission (terminal, browser, git, external MCP).
  - Worker escalates to CTO (and the user) when blocked or when policy requires approval.

- **Completion and backlog movement** (W4):
  - Worker posts PR link + results; CTO reconciles Linear state and releases locks.
  - Issues move through `In Review`/`Done` based on project policy and whether a human review is required.

- **Proof of work** (W4 + W10):
  - Each mission emits an artifact bundle (logs, screenshots, short videos when relevant).
  - Artifact bundle is attached/linked to Linear (final comment + attachments) and kept under `.ade/` for audit.

- **Human-only work (user works without agents)** (W6):
  - ADE generates a "project change digest" (git commits + working tree deltas) and writes it into CTO memory.
  - Before starting a mission, workers run a freshness check against the last observed project snapshot; if diverged, request/auto-generate a digest and ingest it.

- **First-run CTO onboarding (OpenClaw-style)**:
  - On first launch or incomplete CTO setup (`.ade/cto/identity.yaml` missing, no workers, or no `linearSync` policy), the CTO sends a startup welcome message: "I’m your CTO. Glad to join your team. If you want, I can scan the repo and stand up an initial department."
  - If accepted, bootstrap sequence runs:
    1. Project fingerprint pass (stack/manifest detection, lane layout, CI, changelog signals).
    2. Context-pack ingestion (`.ade/context/PRD.ade.md`, `.ade/context/ARCHITECTURE.ade.md`, prior mission/context artifacts where available).
    3. Memory pack creation: project summary + conventions + conventions-to-enforce + known hotspots + recommended worker routing defaults.
    4. CTO-first default org suggestion (editable): suggested workers + per-worker default roles, adapters, and policies.
    5. Default auto-dispatch policy presented as editable templates before activation.
  - If skipped, ADE creates minimal `.ade/cto/` scaffold and keeps onboarding as a persistent in-chat task in the CTO tab (`needsSetup` state) until confirmed.

### Workstreams

#### W1: CTO Agent Core

> Source: Agent identity model from [Paperclip §2 Agent Model](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md). Identity persistence from [OpenClaw SOUL.md](https://github.com/openclaw/openclaw).

New **CTO** tab added to the main tab bar. Icon: `brain` (Lucide). The tab provides a persistent chat interface with a sidebar showing the org chart and worker list. Clicking the CTO or any worker in the sidebar opens a direct chat with that agent.

- **Core concept**: The CTO is a persistent entity that remembers the project, its history, its patterns, and the user's preferences across sessions. It has access to all ADE capabilities via MCP tools: create missions, spin up lanes, check project state, review PR status, query mission history, examine code. It can take autonomous action when appropriate ("I noticed the auth tests are flaky — I'll create a mission to investigate"), with user confirmation.

- **Three-tier memory model** (shared with W6, applies to CTO and all workers):
  - **Tier 1 — Core Memory**: Always in context (~2-4K tokens). Agent persona, current project context, critical conventions, user preferences. Self-editable via `memoryUpdateCore` tool.
  - **Tier 2 — Hot Memory**: Retrieved on demand via hybrid search. Recent conversations, relevant project facts, mission outcomes, decision history.
  - **Tier 3 — Cold Memory**: Archival. Old conversations, historical decisions, deprecated patterns.
  - Auto-compaction with temporal decay (30-day half-life) moves memories from hot to cold.

- **Identity persistence**:
  - CTO state stored in `.ade/cto/`; worker state in `.ade/agents/<name>/` (see W10 for full structure).
  - Core memory persists across sessions — agent reconstructs context from stored memory on session start.
  - Session history log tracks conversation summaries for long-term continuity.
  - On partial or missing CTO identity, onboarding state machine drives a visible welcome/setup mode before active delegation starts.

- **ADE capabilities via MCP tools**: CTO and all workers have access to the full ADE MCP tool set (same tools exposed by `apps/mcp-server`). They can create missions, query status, list lanes, check PR health, read files, search code, check conflicts, query usage metrics. External MCP tools (W8) also available if configured. Tool access governed by the same permission model as mission workers.

- **"Always-on" feel**: Smart memory tracking, context compaction with pre-compaction flush (W6), auto-refactoring of memory via consolidation (W6). Agents are not continuously running model processes — they reconstruct context from stored memory on each session start or heartbeat activation.

- **Renderer**: CTO tab with persistent chat interface, org chart sidebar, worker list. Direct chat with any agent via sidebar click.

**Implementation status (2026-03-05, updated 2026-03-05):**
- W1 is now locked as **CTO-only end-to-end**.
- Desktop and MCP runtimes instantiate a shared CTO state service with dual-canonical persistence:
  - DB tables: `cto_identity_state`, `cto_core_memory_state`, `cto_session_logs`
  - Files: `.ade/cto/identity.yaml`, `.ade/cto/core-memory.json`, `.ade/cto/sessions.jsonl`
- Startup reconciliation is implemented (missing-side hydration, newest-write wins, file-wins tie-break).
- CTO session reconstruction is injected on create/resume from identity + core memory + recent session summaries.
- CTO session summaries are appended to durable session logs on session end/dispose (handled in `agentChatService` on `identityKey === "cto"` close path).
- CTO chat is now identity-locked through `window.ade.cto.ensureSession()` and uses a persistent `lockSessionId` flow in the CTO tab.
- Capability mode is explicit in CTO session metadata/UI:
  - CLI models (`codex`, `claude`) => `full_mcp` (ADE MCP server injected in runtime startup options).
  - Unified/API models => `fallback` (reduced in-process tools).
- Fallback tool surface for unified CTO sessions includes `memoryAdd`, `memorySearch`, and `memoryUpdateCore`.
- MCP server now exposes `memory_update_core` for CTO Tier-1 core-memory updates.
- **CtoPage redesigned (2026-03-05)**: Monolithic 1700-line sidebar replaced with modular Tailwind-based layout matching the app's industrial shell theme. New structure: compact agent sidebar (240px, Slack-style) + tabbed content area (Chat / Team / Linear / Settings). Sub-components: `AgentSidebar.tsx`, `TeamPanel.tsx` (WorkerEditorPanel + WorkerDetailPanel), `LinearSyncPanel.tsx` (self-contained with own state), `CtoSettingsPanel.tsx` (identity + core memory + session history). All shared UI components: `Button`, `Chip`, `EmptyState`, `PaneHeader`, `cn()`. Capability badge shown in tab bar after session established.
- **Deferred to W2**: ~~worker persistence/runtime, worker org editing~~ (done). CTO model/identity settings UI now available in Settings tab via `ctoUpdateIdentity` IPC.

**Tests:**
- CTO core memory persistence across restarts (DB/file reconciliation paths).
- CTO reconstruction context injection on session create/resume.
- CTO session history log append/replay integrity.
- CTO chat identity/session lock behavior in renderer.
- CLI CTO sessions include ADE MCP config; unified CTO sessions expose fallback tool mode.
- MCP `memory_update_core` tool listing and core-memory update behavior.
- CtoPage: core memory view/edit/save/error, session history expand, error state (bridge unavailable), loading state, badge only after session established.
- Onboarding bootstrap: startup detects missing setup, runs repo/context-pack scan on opt-in, and surfaces confirmable defaults without forcing mission dispatch.

#### W2: Worker Agents & Org Chart

> Source: Org hierarchy from [Paperclip §3 Org Structure](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — strict tree, `reportsTo` chain, full visibility across org. Multi-adapter pattern from [Paperclip §4 Execution Adapters](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md). Config versioning from [Paperclip §2 Agent Model](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md). Budget auto-pause from [Paperclip §6 Cost Tracking](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md).

Configurable worker agents that sit under the CTO in an org hierarchy. Each worker is a persistent agent with its own identity, memory, capabilities, and budget.

- **Agent identity schema**:
  ```typescript
  interface AgentIdentity {
    id: string;                    // UUID
    name: string;                  // "Backend Dev", "Mobile Dev", "QA Engineer"
    role: AgentRole;               // 'cto' | 'engineer' | 'qa' | 'designer' | 'devops' | 'researcher' | 'general'
    title?: string;                // Optional display title
    reportsTo: string | null;      // Parent agent ID (null = root CTO)
    capabilities: string[];        // ["api", "db", "tests", "react-native", "ios"]
    status: AgentStatus;           // 'idle' | 'active' | 'paused' | 'running'

    // Adapter: how the agent runs
    adapterType: AdapterType;      // 'claude-local' | 'codex-local' | 'openclaw-webhook' | 'process'
    adapterConfig: Record<string, unknown>;  // Adapter-specific: model, cwd, CLI args, webhook URL, etc.

    // Runtime
    runtimeConfig: {
      heartbeat?: HeartbeatPolicy;   // Activation schedule (see W3)
      maxConcurrentRuns?: number;    // 1-10, default 1
    };

    // Budget
    budgetMonthlyCents: number;    // 0 = unlimited
    spentMonthlyCents: number;     // Auto-tracked, resets monthly

    // Metadata
    lastHeartbeatAt?: string;      // ISO 8601
    createdAt: string;
    updatedAt: string;
  }
  ```

- **Org chart**:
  - CTO is always the root node (`reportsTo: null`).
  - Workers report to CTO by default; users can create sub-hierarchies (e.g., "Lead Backend Dev" with junior workers reporting to it).
  - Cycle detection prevents circular reporting chains (max 50 hops, consistent with Paperclip's validation).
  - Visual org chart in the sidebar:
    ```
    CTO (brain)
    ├── Backend Dev (claude-local, idle)
    ├── Mobile Dev (openclaw-webhook, idle)
    └── QA Engineer (claude-local, paused - budget)
    ```
  - Chain-of-command traversal: any worker can escalate to its manager, up to CTO.
  - When an agent is removed, its direct reports are unlinked (`reportsTo: null`), not deleted.

- **Multi-adapter pattern** (adapted from Paperclip's `process`/`http` adapters):
  - Same `AgentIdentity` interface, different execution backends:
    - `claude-local`: Spawns Claude Code CLI with model/cwd/instructions.
    - `codex-local`: Spawns Codex CLI via app-server protocol.
    - `openclaw-webhook`: HTTP POST to a remote OpenClaw agent endpoint.
    - `process`: Generic subprocess with custom command.
  - Adapter config holds backend-specific settings (model, CLI args, webhook URL, timeout, etc.).
  - Workers are hot-swappable — change adapter type without losing identity or memory.

- **Config versioning** (adapted from Paperclip):
  - Every change to an agent's identity/config creates a revision with before/after snapshots.
  - Changed fields tracked explicitly (name, role, adapterType, capabilities, budget, etc.).
  - Rollback: revert to a previous revision. Redacted-secret protection prevents rollback to revisions where secrets were scrubbed.

- **Budget auto-pause** (adapted from Paperclip §6 — monthly period, hard ceiling):
  - Each worker has a `budgetMonthlyCents` ceiling. When `spentMonthlyCents >= budgetMonthlyCents`, the worker auto-pauses.
  - CTO notifies the user: "QA Engineer hit its $30 monthly budget. Paused. Want me to increase it?"
  - Company-level budget cap across all workers.
  - Cost events recorded per-run with provider/model/token attribution.
  - Monthly reset: `spentMonthlyCents` → 0 on the 1st of each month (UTC).

- **Task session persistence** (adapted from Paperclip):
  - Per-task session state survives across agent invocations, keyed by `(agentId, adapterType, taskKey)`.
  - When a worker stops and restarts on the same issue, it resumes with session context (thread ID, conversation state, workspace path).
  - Sessions stored in the agent's `.ade/agents/<name>/sessions.jsonl`.

- **Direct conversation**: Users can chat with any worker directly from the CTO tab sidebar. Workers have full project context via their memory tiers + ADE MCP tools. CTO is not a bottleneck — users bypass it for quick asks. Inter-agent messaging (shipped in Phase 3) enables CTO ↔ worker communication during missions.

- **Renderer**: Org chart sidebar with live status indicators (idle/active/paused/running). Agent creation dialog. Config editor with revision history. Budget display per agent. **Also includes**: `ctoUpdateIdentity` IPC (deferred from W1) for updating CTO model preferences + persona from the config editor — this is the proper home for it since it belongs alongside the general agent config editing surface.

**Implementation status (2026-03-05):**
- All W2 services fully implemented and tested:
  - `workerAgentService.ts`: Agent CRUD, org-tree hierarchy with cycle detection, `reportsTo` management, slug-based filesystem layout, core memory (file-backed), session logs (file-backed), status management, soft-delete with report unlinking.
  - `workerRevisionService.ts`: Config versioning with before/after snapshots, changed-keys detection, rollback with redacted-secret protection.
  - `workerBudgetService.ts`: Cost event recording (exact + estimated), per-worker and company-level budget enforcement, auto-pause on budget breach, monthly boundary handling, CLI telemetry reconciliation.
  - `workerTaskSessionService.ts`: Deterministic task key derivation, session persistence keyed by `(agentId, adapterType, taskKey)`, targeted and bulk clear.
  - `workerAdapterRuntimeService.ts`: Multi-adapter pattern (claude-local CLI spawn, codex-local CLI spawn, openclaw-webhook HTTP POST with env header, process adapter with unsafe command blocking).
- DB tables added to kvDb.ts migration: `worker_agents`, `worker_agent_revisions`, `worker_agent_task_sessions`, `worker_agent_cost_events`, `worker_agent_runs`.
- All W2 IPC handlers registered: `ctoListAgents`, `ctoSaveAgent`, `ctoRemoveAgent`, `ctoListAgentRevisions`, `ctoRollbackAgentRevision`, `ctoEnsureAgentSession`, `ctoGetBudgetSnapshot`, `ctoUpdateIdentity`.
- Preload bridge and global.d.ts updated with all W2 methods.
- Services instantiated in main.ts and wired into AppContext.
- CtoPage fully redesigned (2026-03-05): Slack-inspired modular layout with `AgentSidebar` (240px compact tree), `TeamPanel` (worker detail + editor), tabbed navigation (Chat/Team/Linear/Settings). Uses shared UI kit (`Button`, `Chip`, `PaneHeader`, `EmptyState`, Tailwind + `cn()`). Worker editor, budget summary, revision history with rollback, core memory inspector, session logs all functional. `ctoUpdateIdentity` IPC implemented for CTO model/persona editing from Settings tab.

**Tests:**
- Agent creation, `reportsTo` hierarchy, cycle detection (max 50 hops).
- Chain-of-command traversal, org tree reconstruction from flat list.
- Agent removal (unlink direct reports, preserve identity for audit).
- Multi-adapter: Claude-local adapter spawns CLI correctly, OpenClaw webhook adapter sends HTTP POST, process adapter spawns subprocess, adapter hot-swap preserves identity/memory.
- Config versioning: revision creation on config change, before/after snapshot accuracy, changed-keys detection, rollback, redacted-secret rollback prevention.
- Budget auto-pause: cost event recording, monthly spend increment, auto-pause at budget ceiling, CTO notification on pause, monthly reset.
- Task session persistence: session save on run completion, session resume on re-invocation, session keyed by `(agentId, adapterType, taskKey)`, session clear signal.
- CtoPage: worker tree rendering, worker row click selection, Wake Now trigger, budget summary display, listAgents/getBudgetSnapshot called on mount.

#### W3: Heartbeat & Activation System

> Source: Heartbeat scheduling from [Paperclip §4 Heartbeat System](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — adapter-based invocation, pause/resume, grace period. Two-tier execution from [OpenClaw](https://github.com/openclaw/openclaw) — cheap checks before LLM, HEARTBEAT_OK suppression. Wakeup coalescing from Paperclip. Issue execution locking from [Paperclip §8 Concurrency Model](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC-implementation.md) — atomic checkout, single-assignee.

A configurable activation system that determines when and how agents wake up.

- **Heartbeat policy** (per-agent, in `runtimeConfig.heartbeat`):
  ```typescript
  interface HeartbeatPolicy {
    enabled: boolean;              // Whether timer-based wakeups fire
    intervalSec: number;           // Seconds between automatic checks (0 = no timer)
    wakeOnDemand: boolean;         // Allow event-driven wakeups (task assigned, mentioned, etc.)
    activeHours?: {                // Optional time window (from OpenClaw)
      start: string;               // "09:00"
      end: string;                 // "22:00"
      timezone: string;            // "America/New_York" or "local"
    };
  }
  ```

- **Default heartbeat configurations**:
  | Agent | intervalSec | wakeOnDemand | Active Hours |
  |-------|-------------|--------------|--------------|
  | CTO | 300 (5 min) | yes | User-configured |
  | Workers | 0 (no timer) | yes | Follows CTO |

  CTO heartbeats periodically to check Linear/GitHub for new work and monitor running missions. Workers default to wake-on-demand only — CTO wakes them when it assigns work.

- **Two-tier execution model** (from OpenClaw):
  - **Cheap checks first**: On each heartbeat, run fast deterministic checks — is there new work in the issue tracker? Did a mission finish? Are there pending interventions? Zero LLM tokens.
  - **LLM escalation**: Only invoke the agent's model when something meaningful needs attention. "5 new Linear issues since last check" triggers CTO to classify and dispatch. "No changes" → skip.
  - **HEARTBEAT_OK suppression**: If the agent determines nothing needs attention, it returns `HEARTBEAT_OK`. No notification to user.

- **Wakeup coalescing** (from Paperclip):
  - If a wakeup arrives while the agent is already running on the same task, merge the new context into the active run instead of spawning a duplicate.
  - Example: 3 Linear updates to the same issue within 30 seconds → only 1 agent invocation with all 3 updates merged.
  - **Deferred promotion**: If the agent is busy on a different task, the wakeup is queued as `deferred`. When the current run finishes, the oldest deferred wakeup auto-promotes.

- **Issue execution locking** (adapted from Paperclip's atomic checkout — §8 Concurrency Model):
  - Only one agent run per issue at a time. When a worker claims an issue, it's atomically locked (`executionRunId` + `executionLockedAt`).
  - **Stale adoption**: If a run crashes, another run can adopt the orphaned issue instead of it being stuck forever.
  - **Orphan reaping**: On app restart, detect runs that are "queued" or "running" but have no corresponding process. Mark them failed, release locks, promote deferred wakeups.

**Implementation status (2026-03-05):**
- `workerHeartbeatService.ts` (789 lines): Full heartbeat engine with timer pool, wakeup queue with deferred promotion, two-tier execution (cheap check → LLM escalation), active hours gate, HEARTBEAT_OK suppression, orphan reaping, issue execution locking with atomic checkout and stale adoption, coalescing.
- All W3 IPC handlers registered: `ctoTriggerAgentWakeup`, `ctoListAgentRuns`, `ctoGetAgentCoreMemory`, `ctoUpdateAgentCoreMemory`, `ctoListAgentSessionLogs`, `ctoListAgentTaskSessions`, `ctoClearAgentTaskSession`.
- Preload bridge and global.d.ts updated with all W3 methods.
- CtoPage: "Wake Now" button on selected worker, heartbeat run history panel, wake status/error feedback.
- Service instantiated in main.ts with full dependency injection (workerAgentService, workerAdapterRuntimeService, workerTaskSessionService, workerBudgetService).

**Tests:**
- Timer-based wakeup fires at `intervalSec`.
- Active hours enforcement (wakeup rejected outside window).
- `wakeOnDemand` triggers on task assignment and user message.
- Two-tier execution: cheap check skips LLM when no changes detected.
- HEARTBEAT_OK suppression: no user notification on quiet heartbeat.
- Coalescing: duplicate wakeup merges context into running execution.
- Deferred promotion: wakeup promoted after current run completes.
- Orphan reaping: stale runs detected and released on app restart.
- Issue execution locking: atomic lock on checkout, stale adoption after crash, lock release on completion.

#### W4: Bidirectional Linear Sync

> Source: Polling loop from [Symphony §8 Polling, Scheduling, and Reconciliation](https://github.com/openai/symphony/blob/main/SPEC.md). Candidate selection, concurrency, reconciliation, and retry from Symphony §8.2-8.5. Workpad comment from Symphony §10. Atomic checkout from [Paperclip §8 Concurrency Model](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC-implementation.md). WORKFLOW.md → mission templates concept from Symphony §5.

The CTO agent watches one or more Linear project boards and autonomously dispatches missions from issues. Results flow back to Linear as state updates, comments, and proof of work.

- **Flow policy UI (CTO tab + Automations)**:
  - Add a policy composer UI for building intake, routing, execution, escalation, and closeout logic without direct YAML editing.
  - Intake controls: polling-only, trigger-aware, or manual queue-only modes.
  - Routing controls: ordered rule chains by label/project/priority/owner plus per-project fallback.
  - Execution controls: autonomy level, allowed tools, max parallelism, and active hours.
  - Escalation controls: confidence gates, manual-approval checkpoints, retry ladders, and escalation targets.
  - Closeout controls: workpad format, terminal summary fields, state mapping, artifact inclusion, and proof-of-work requirements.
  - Add route simulation mode: paste a sample issue and show predicted worker, template, assignment, and target status updates.
  - Add policy diff/rollback UI with enable/disable toggles and conflict warnings.

- **Inbound: Linear → ADE** (Symphony polling + Paperclip checkout):
  1. **CTO heartbeat fires** → cheap check: query Linear for issues in active states (`Todo`, `In Progress`) across configured projects.
  2. **Candidate filtering**: Sort by priority (ascending) → `created_at` (oldest first) → identifier. Skip issues blocked by non-terminal blockers (Symphony §8.2 blocker rule).
  3. **Routing**: Pick a responsible worker using configurable W4 rules: label routing → per-project default owner → CTO classification fallback.
  4. **Classification**: CTO uses its memory + project knowledge to pick a mission template and validate the routing decision (bug fix? feature? refactor?).
  5. **Concurrency check**: Respect per-state concurrency limits (Symphony §8.3): `max_concurrent_by_state: { todo: 5, in_progress: 3, bug: 2 }`.
  6. **Auto-dispatch or escalate**: Based on auto-dispatch policy, either create a mission automatically or surface the issue to the user for approval.
  7. **Atomic checkout + assignment**: When dispatching, atomically lock the issue in ADE (Paperclip-style). Optionally assign the issue in Linear according to user-configured policy. Move Linear issue to `In Progress`.

- **Outbound: ADE → Linear** (Symphony workpad pattern):
  - When a mission starts: move Linear issue to `In Progress`, post a "Workpad" comment with planned approach.
  - During execution: update the workpad comment with progress checklist (single persistent comment, not multiple — Symphony's workpad pattern).
  - When PR is created: post PR link to Linear issue, add `ade` label.
  - When mission completes: move issue to `Done` (or `In Review` if PR needs human review), post final summary with diff stats, test results, and proof of work.
  - When mission fails: post failure context to Linear, move to `Blocked` or keep in `In Progress` for retry.

- **Proof-of-work artifacts**:
  - On mission completion (success or failure), write a small artifact bundle under `.ade/artifacts/<missionId>/`:
    - logs: `build.log`, `tests.log`, `mission-summary.md`
    - evidence: `before.png`, `after.png`, `repro.mp4` (when relevant)
  - Post artifacts back to Linear:
    - Always: link or inline summary in the final comment (paths, hashes, how to reproduce).
    - When configured: upload files and create Linear attachments (screenshots/videos), not just links.

- **Reconciliation** (Symphony §8.5):
  - On every CTO heartbeat, validate running missions against current Linear state:
    - Issue moved to `Done` externally → cancel the ADE mission.
    - Issue moved to `Cancelled` → cancel and clean up.
    - Issue reassigned → release the worker, update mission.
    - Issue still active → refresh snapshot, continue.
  - **Stall detection** (Symphony §8.5 Part A): If no agent activity for `stalledTimeoutSec` (default 300s), kill the agent run and schedule retry.

- **Auto-dispatch policies** (user-configured):
  ```yaml
  # .ade/local.yaml
  linearSync:
    enabled: true
    pollingIntervalSec: 300        # CTO heartbeat interval for Linear checks
    projects:
      - slug: my-project
        defaultWorker: backend-dev
      - slug: mobile-app
        defaultWorker: mobile-dev
    routing:
      byLabel:
        ios: mobile-dev
        android: mobile-dev
        backend: backend-dev
    assignment:
      setAssigneeOnDispatch: true  # If policy allows assignment and identity is configured, set Linear assignee
    autoDispatch:
      rules:
        - match: { labels: ["bug"], priority: ["urgent", "high"] }
          action: auto              # Create mission immediately
          template: bug-fix         # Mission template to use
        - match: { labels: ["feature"] }
          action: escalate          # Surface to user for approval
        - match: { labels: ["refactor"] }
          action: queue-night-shift # Queue for Night Shift
      default: escalate             # Default for unmatched issues
    concurrency:
      global: 5                     # Max simultaneous missions from Linear
      byState:
        todo: 3
        in_progress: 5
    reconciliation:
      enabled: true
      stalledTimeoutSec: 300        # Kill agent if no activity for 5 min
  ```

- **Mission templates** (from Symphony's WORKFLOW.md concept, adapted):
  - Reusable mission archetypes stored in `.ade/templates/`:
    ```yaml
    # .ade/templates/bug-fix.yaml
    name: Bug Fix
    phases: [development, testing, validation, pr]
    prStrategy: per-lane
    defaultWorker: backend-dev
    budgetCents: 500
    promptTemplate: |
      Fix the following bug:
      Title: {{ issue.title }}
      Description: {{ issue.description }}
      Priority: {{ issue.priority }}
    ```
  - CTO selects template based on issue classification (labels, priority, description analysis).
  - Users create custom templates in Settings → Mission Templates.

- **Tracker abstraction** (from Symphony §3.1 Component 3 — Issue Tracker Client):
  - Linear is the first tracker, but the integration uses an abstract `IssueTracker` interface:
    ```typescript
    interface IssueTracker {
      fetchCandidateIssues(): Promise<NormalizedIssue[]>;
      fetchIssueStates(ids: string[]): Promise<Map<string, string>>;
      updateIssueState(id: string, state: string): Promise<void>;
      createComment(id: string, body: string): Promise<void>;
    }
    ```
  - GitHub Issues adapter planned as a fast-follow (same interface, different GraphQL queries).
  - Memory tracker for tests (consistent with Symphony's in-memory tracker pattern).

- **Linear client**: Built-in lightweight GraphQL client for the core polling/update loop (simpler, no MCP overhead). External MCP Linear tools (W8) available for ad-hoc agent queries.

  - **Configuration**: Linear API key stored in `.ade/local.secret.yaml` (gitignored). Poll interval, routing policy, and dispatch rules in `.ade/local.yaml` (git-tracked, no secrets).
- **Configuration**: Linear API key stored in `.ade/local.secret.yaml` (gitignored). Poll interval and dispatch rules in `.ade/local.yaml` (git-tracked, no secrets).

**Implementation status (2026-03-05):**
- All W4 services implemented and tested:
  - `linearClient.ts`: Lightweight GraphQL client for Linear API (issue queries, state mutations, comment CRUD).
  - `linearCredentialService.ts`: Secure token storage in `.ade/local.secret.yaml`, connection verification.
  - `linearIssueTracker.ts`: `IssueTracker` interface implementation for Linear (fetchCandidates, fetchStates, updateState, createComment).
  - `issueTracker.ts`: Abstract `IssueTracker` interface (pluggable backends — GitHub Issues planned as fast-follow).
  - `linearRoutingService.ts`: Label routing, per-project default owner, CTO classification fallback, route simulation.
  - `linearSyncService.ts`: Full polling loop, candidate filtering (priority+created_at sort, blocker skip), concurrency enforcement (global + per-state), auto-dispatch/escalate, atomic checkout, reconciliation (external close→cancel, reassign→release, stall detection→restart).
  - `linearOutboundService.ts`: State transitions (In Progress, Done, Blocked), workpad comment lifecycle (create, update, finalize), PR link posting, label addition.
  - `linearTemplateService.ts`: Mission template loading from `.ade/templates/`, variable rendering with issue context, CTO classification-based selection.
  - `flowPolicyService.ts`: Policy CRUD with versioned history (before/after snapshots), rollback, simulation mode.
- All W4 IPC handlers registered: `ctoGetLinearConnectionStatus`, `ctoSetLinearToken`, `ctoClearLinearToken`, `ctoGetFlowPolicy`, `ctoSaveFlowPolicy`, `ctoListFlowPolicyRevisions`, `ctoRollbackFlowPolicyRevision`, `ctoGetLinearSyncDashboard`, `ctoListLinearSyncQueue`, `ctoResolveLinearSyncQueueItem`, `ctoRunLinearSyncNow`, `ctoSimulateFlowRoute`.
- Preload bridge and global.d.ts updated with all W4 methods.
- `LinearSyncPanel.tsx` (2026-03-05): Self-contained panel with own state management, 6-step navigation (Connection/Intake/Routing/Execution/Escalation/Closeout), escalation queue, policy history with rollback, route simulation. Tailwind + shared UI kit.
- `projectConfigService.linearSync.test.ts`: Config integration tests for Linear sync policy persistence.

**Tests:**
- Candidate issue polling across multiple projects, priority sorting (ascending), blocked-by filtering (skip Todo with non-terminal blockers), routing by label/defaultWorker with CTO fallback.
- Auto-dispatch with template matching, escalation for unmatched issues, concurrency limit enforcement (global and per-state), optional assignee setting on dispatch.
- Linear outbound: state update on mission start/complete/fail, workpad comment creation and update, PR link posting, label addition.
- Reconciliation: external close → mission cancel, external reassign → worker release, stall detection → restart.
- Mission template: loading from `.ade/templates/`, variable rendering with issue context, template selection by CTO classification.
- Retry: exponential backoff on failure, short continuation retry on normal completion (consistent with Symphony §8.4).
- Flow composer UI: policy validation and simulation, versioned history, and readable diff before activation.

#### W5: Automations Platform + Night Shift

W5 turns Automations into a first-class product surface rather than a narrow trigger-action settings form. The Automations tab becomes the canonical place to create, simulate, run, and review background agent workflows. Settings holds defaults, connector auth, and policy presets, but not the main builder UI.

##### Linear Dispatch Boundary (decided 2026-03-06)

**CTO owns Linear dispatch; Automations does NOT duplicate it.**

- The CTO heartbeat (W4, already shipped) is the intelligent intake and routing path for Linear issues. It polls Linear, classifies issues, selects templates, and dispatches missions to workers. This is where "P0 bug arrives -> specific template -> specific worker" logic lives.
- The Automations tab handles local triggers (commit, schedule, session-end, manual), webhooks, and programmable workflows. It does NOT re-implement Linear issue intake or routing.
- Linear appears in Automations only as an **action** (e.g., "on commit -> update Linear issue status", "on session-end -> post summary to Linear"), NOT as a competing trigger for issue intake.
- If a user wants "P0 bug -> specific template", that is a CTO dispatch policy (W4 `linearSync.autoDispatch.rules`), not an automation rule.
- Rationale: prevents UX confusion of "which system handles my Linear issue?" and avoids duplicating the already-shipped W4 dispatch infrastructure.

##### W5a / W5b Sub-Phasing (decided 2026-03-06)

W5 is split into two sub-phases to deliver incremental value and manage scope:

**W5a (in progress):** Foundation services and UI overhaul
- `usageTrackingService`: OAuth API polling for Claude and Codex usage, local cost scanning from JSONL logs, pacing calculation
- `budgetCapService`: per-rule, per-night-shift-run, and global budget caps (% of weekly or USD)
- IPC wiring and preload bridge for usage/budget data
- Automations tab UI overhaul: five-tab layout (Rules / Templates / History / Usage / Night Shift) matching the app's industrial shell theme

**W5b (after W5a + stable orchestrator):** Full ADE tool access, executor modes, and external triggers

The core principle of W5b: **automations get access to everything ADE can do.** An automation rule can spawn an AI agent with the same capabilities as a CTO worker or mission worker — every MCP tool, every git operation, every terminal command, every PR workflow, every test runner, every external integration. The automation executor is not a limited "run shell command" system; it is a full mission dispatch through the orchestrator.

- **Executor mode expansion**: `automation-bot`, `employee`, `cto-route`, `night-shift` — all dispatch through the orchestrator's mission system
  - `automation-bot`: disposable worker with full ADE tool access, model/permission selection, optional automation-scoped memory
  - `employee`: target a persistent CTO worker who retains identity, memory, and domain knowledge across runs
  - `cto-route`: let the CTO decide which worker handles it (or handle directly)
  - `night-shift`: queue for unattended overnight execution with conservative permissions
- **Per-rule configuration**: model selection (any configured provider/model), permission level (sandbox mode, approval policy), tool palette (which MCP tools/actions are available), prompt/instructions, output handling (open PR, post comment, create Linear issue, run tests, verify before publish)
- **Full ADE tool surface available to automation agents**: repo/code tools, git operations, terminal/PTY, test runners, GitHub PR workflows (open/review/merge), Linear actions, browser automation, external MCP tools (W8), memory tools, conflict resolution — anything a mission worker can do
- **`automationExecutionService`**: translates automation rule + trigger context into an orchestrator mission launch with the correct model, permissions, tools, and prompt
- **`automationMemoryService`**: automation-scoped memories that persist across runs and compose with employee memory when targeting persistent workers
- **`nightShiftService`**: overnight queue orchestration, utilization management (conservative/maximize/fixed modes), rate-limit-aware multi-batch scheduling, morning briefing digest
- **External trigger adapters**: GitHub webhooks (push, PR opened/merged, review requested), generic webhooks (user-defined payloads), schedule enhancements (cron + active-hours windows). Linear trigger excluded per CTO dispatch boundary decision above.
- **Builder UX**: model/permission selector in rule editor, tool palette picker, prompt editor with template variables, output configuration (PR settings, Linear issue template, notification channel), simulation / dry-run with full preview
- **Full Night Shift tab**: queue controls (add/remove/reorder/pause), morning briefing modal (swipeable card interface per run), overnight schedule configuration, reserve budget management
- **Verification gates**: `verifyBeforePublish` flag on rules — the agent pauses before external actions (opening PRs, posting comments, creating issues) and either waits for user approval or runs in dry-run mode

##### Competitive Reference Notes (2026-03-06)

Design decisions informed by competitive analysis of recent releases:

| Source | What ADE Adopts | What ADE Skips |
|--------|----------------|----------------|
| **[Cursor Automations](https://cursor.com)** (Mar 2026) — triggers from GitHub/Linear/Slack/PagerDuty/webhooks/schedules, cloud sandbox agents with MCP access, memory tool, template categories | Template gallery pattern for common recipes (security review, PR review, incident triage, routine maintenance). Trigger category taxonomy. Memory-aware execution so automations improve over time. | Cloud sandbox execution (ADE is local-first). Cursor's "Linear trigger" approach (ADE uses CTO dispatch instead). Slack/PagerDuty triggers deferred. |
| **[Codex Agents SDK](https://openai.com)** — "works unprompted", skills system, multi-agent orchestration with PM agent, trace dashboard | "Works unprompted" framing for Night Shift and scheduled automations. Trace/history visibility for every automation run. Multi-agent orchestration patterns (CTO as PM agent equivalent). | Codex cloud execution model. Codex-specific app-server protocol. |
| **[CodexBar](https://github.com/steipete/CodexBar)** — macOS menu bar usage tracker for Claude and Codex | OAuth API polling pattern for Claude (`api.anthropic.com/api/oauth/usage`: five_hour + seven_day windows) and Codex (`chatgpt.com/backend-api/wham/usage` or CLI RPC). Pacing calculation (on-track / ahead / behind based on usage % vs time elapsed). | macOS menu bar UI (ADE integrates into Usage tab instead). |

##### Usage Tracking Service Design (W5a)

Inspired by [CodexBar](https://github.com/steipete/CodexBar), the usage tracking service provides real-time visibility into AI spend across providers:

- **OAuth API polling**: Claude usage from `api.anthropic.com/api/oauth/usage` (five_hour + seven_day windows), Codex usage from `chatgpt.com/backend-api/wham/usage` or CLI RPC
- **Local cost scanning**: Parse JSONL session logs from `~/.claude/projects/` and `~/.codex/sessions/` for granular per-session cost data
- **Pacing calculation**: Determine whether usage is on-track, ahead, or behind based on `usage% vs time_elapsed%` within the billing window
- **Budget cap model**: Per-rule caps, per-night-shift-run caps, and global caps expressed as percentage of weekly budget or absolute USD
- **Night Shift reserve**: Protect X% of weekly budget for overnight runs, preventing daytime usage from starving Night Shift

- **Surface model**:
  - `/automations` is the primary authoring and operations surface.
  - Settings stores default model/provider policy, connector credentials, shared templates, Night Shift defaults, and org-wide guardrails.
  - CTO/Employees remain the place where persistent workers live, but those workers can be assigned automations from the Automations tab.

- **Automation rule model**:
  ```typescript
  interface AutomationRule {
    id: string;
    name: string;
    triggers: AutomationTrigger[];
    executor: {
      mode: "automation-bot" | "employee" | "cto-route" | "night-shift";
      targetId?: string;
    };
    templateId?: string;
    prompt?: string;
    toolPalette: string[];
    memory: { mode: "none" | "automation" | "automation-plus-employee" };
    guardrails: {
      budgetUsd?: number;
      maxDurationMin?: number;
      activeHours?: { start: string; end: string; timezone: string };
      verifyBeforePublish: boolean;
    };
  }
  ```
  - Automations can run as disposable automation bots, target a specific persistent employee, let the CTO route the work, or queue work for Night Shift.
  - Automation-scoped memory persists per rule and combines with employee memory when the executor is persistent.

- **Trigger coverage for W5**:
  - Local triggers: `manual`, `schedule`, `commit`, `session-end`
  - External triggers: `GitHub`, `Linear`, `webhook`
  - Deferred connectors: Slack, PagerDuty, and similar event sources can plug into the same contract after the first connector set is stable.

- **Tool palette model**:
  - Replace the narrow fixed action enum with curated tool palettes per automation.
  - Initial tool families: repo/code/test tools, GitHub actions (open PR/comment/review/request reviewers), Linear actions (create/update/comment/transition), MCP tool bundles, memory tools, mission launch/validation utilities.
  - Each rule explicitly declares its available tools for safety, clarity, and reuse.

- **Builder UX**:
  - Template gallery with built-in recipes and user-created templates
  - Natural-language create flow that drafts a rule from plain English
  - Visual builder with explicit steps for Trigger, Run As, Tools, Memory, Guardrails, Output, and Verification
  - Simulation / dry-run before activation
  - Run history with rerun, pause, edit, and failure inspection

- **Night Shift as an execution mode**:
  - Night Shift is part of the automation system, not a separate agent type or separate tab.
  - Users can assign any eligible automation to the Night Shift queue and configure overnight-only rules directly from `/automations`.
  - Night Shift remains responsible for unattended scheduling, conservative permissions, overnight batching, and morning briefings.

- **Night Shift configuration**:
  ```
  +------------------------------------------------------------------+
  | AUTOMATIONS                                                        |
  | [Rules] [Templates] [History] [Night Shift]                        |
  +------------------------------------------------------------------+
  | RULE: "Triage new Linear bugs"                [SIMULATE] [ENABLE]  |
  | Trigger: Linear -> Issue opened with label=bug                    |
  | Run As: Backend Dev employee                                      |
  | Tools: Linear, GitHub, repo tests, memory                         |
  | Memory: automation + employee                                     |
  | Output: verify before comment / open PR                           |
  +------------------------------------------------------------------+
  | NIGHT SHIFT                                           [CONFIGURE]  |
  | Schedule: 11:00 PM - 6:00 AM (Mon-Fri)                            |
  | Mode: Conservative (60% capacity)                                 |
  | Queue: 3 automations / 5 tasks                                    |
  | Reserve: 20% weekly                                               |
  +------------------------------------------------------------------+
  ```

- **Smart token budget management**:
  - Utilization modes: `maximize`, `conservative` (default), `fixed`
  - Rate-limit awareness with optional multi-batch scheduling around reset windows
  - Weekly reserve protection and global Night Shift caps on top of per-rule caps

- **Strict guardrails**:
  - Per-rule and per-run budget caps (tokens, time, steps, USD)
  - Stop conditions: `first-failure`, `budget-exhaustion`, `intervention-threshold`, `rate-limited`, `reserve-protected`
  - Verification gates before publishing comments, opening PRs, or escalating externally
  - Conservative permission mode by default for unattended Night Shift work

- **Morning Briefing**:
  - Swipeable card interface for reviewing overnight results
  - Per-run summary with model, budget used, diff stats, test status, confidence, and linked artifacts
  - Modal on next app open after Night Shift completes, plus persistent access from Automations history

- **Automation services**:
  - `automationRuleService`: persistence, validation, templates, activation state
  - `automationTriggerService`: local events plus GitHub/Linear/webhook adapters
  - `automationExecutionService`: dispatch to automation bots, employees, CTO route, or Night Shift queue
  - `automationMemoryService`: automation-scoped memories and carry-forward summaries
  - `nightShiftService`: overnight queue orchestration, utilization management, morning briefing digest

- **Settings integration**:
  - Connector auth and health for GitHub, Linear, and webhooks
  - Default provider/model routing, budget presets, approval policy, and active hours
  - Shared templates and default tool palettes
  - Default Night Shift window, reserve policy, and notification delivery

- **Renderer**:
  - Automations tab with Rules, Templates, History, and Night Shift views
  - Builder + simulation flow
  - Run detail/history inspector
  - Morning Briefing modal overlay and Night Shift queue controls

**Implementation status (2026-03-06):**
- W5a in progress:
  - `usageTrackingService.ts`: In progress — OAuth API polling for Claude and Codex, local JSONL log scanning, pacing calculation, provider-agnostic usage snapshot interface.
  - `budgetCapService.ts`: In progress — per-rule, per-night-shift-run, and global budget cap enforcement, Night Shift reserve protection.
  - IPC wiring and preload bridge: Pending (blocked on service completion).
  - Automations tab UI overhaul: Pending (blocked on IPC wiring). Target layout: five tabs (Rules / Templates / History / Usage / Night Shift) matching the industrial shell theme from CtoPage redesign.
- W5b not started (depends on W5a + stable orchestrator).

**Tests (W5a):**
- Usage tracking: OAuth polling mock, JSONL log parsing, pacing calculation (on-track/ahead/behind), provider normalization
- Budget caps: per-rule enforcement, global cap, Night Shift reserve protection, budget breach notification
- IPC: usage snapshot retrieval, budget status queries, budget update handlers

**Tests (W5b — planned):**
- Executor dispatch: automation-bot spawns mission with correct model/permissions/tools, employee targets persistent worker, cto-route delegates to CTO, night-shift queues for overnight
- Full tool surface: automation agent can use repo tools, git, terminal, test runner, PR workflows, Linear actions, external MCP tools, memory tools — same as any mission worker
- Model/permission configuration: rule specifies model ID then mission uses that model; rule specifies sandbox mode then worker respects it
- Tool palette enforcement: rule declares available tools then worker only sees those tools
- Verification gates: verifyBeforePublish pauses before external actions (PR open, comment post, issue create)
- External trigger adapters: GitHub webhook (push/PR/review), generic webhook, schedule with active-hours
- Automation-scoped memory: persists across runs, composes with employee memory when targeting persistent workers
- Night Shift: queue orchestration, conservative permission enforcement, utilization modes, rate-limit-aware scheduling, morning briefing generation
- Output handling: automation agent opens PR with configured settings, creates Linear issue, posts results to configured channel
- Budget integration: automation dispatch checks budget caps before launching, records usage after completion

#### W6: Unified Memory System

> Source: Three-tier memory from [OpenClaw](https://docs.openclaw.ai/concepts/memory) (markdown-as-truth, hybrid BM25+vector search, temporal decay, pre-compaction flush). Composite scoring from [CrewAI](https://github.com/crewAI/crewAI). Consolidation from [Mem0](https://github.com/mem0ai/mem0). Episodic/procedural memory from [LangMem](https://github.com/langchain-ai/langmem). Org context from [Paperclip](https://paperclip.ing) (goal hierarchy, runtime skill injection).

##### Required Reading for Implementation

The implementing agent **must** read these references before starting work. Each link contains design patterns and implementation details that directly inform W6.

| Reference | What to Read | What ADE Adopts |
|-----------|-------------|-----------------|
| [OpenClaw Memory Concepts](https://docs.openclaw.ai/concepts/memory) | Full page — MEMORY.md format, daily logs, search, temporal decay, evergreen exemptions | Three-tier model, pre-compaction flush, hybrid BM25+vector search, evergreen pinning, temporal decay with half-life |
| [OpenClaw Source — `memory/`](https://github.com/nichochar/openclaw/tree/main/src/openclaw/memory) | `memory_manager.py`, `embedding.py`, `search.py` | Search implementation patterns, embedding cache, memory lifecycle hooks |
| [Mem0 — Memory Layer](https://github.com/mem0ai/mem0) | README + `mem0/memory/` source, especially `main.py` and the dedup/consolidation flow | Write-time dedup via vector similarity, LLM-driven PASS/REPLACE/APPEND/DELETE consolidation, confidence scoring |
| [Mem0 Docs — How It Works](https://docs.mem0.ai/overview) | "How Mem0 Works" section — the add/search/update flow diagrams | Four-stage write pipeline (extract → dedup → consolidate → store), update-vs-add decision logic |
| [LangMem — Long-Term Memory](https://github.com/langchain-ai/langmem) | README, `langmem/knowledge/` source, episodic/semantic/procedural concepts | Episodic → semantic → procedural extraction pipeline, memory consolidation patterns, namespace scoping |
| [LangMem Concepts](https://langchain-ai.github.io/langmem/concepts/) | Full concepts page — memory types, extraction, consolidation | Three memory types (semantic fact, episodic event, procedural instruction), extraction triggers, consolidation strategies |
| [CrewAI Memory](https://docs.crewai.com/concepts/memory) | Full page — short-term, long-term, entity, contextual memory | Composite scoring with multiple signals (recency, importance, access frequency), scope-based retrieval |
| [sqlite-vec](https://github.com/asg017/sqlite-vec) | README, API docs, `vec0` virtual table, distance functions | KNN search via `vec0` virtual table, cosine distance function, WASM/Node.js integration |
| [sqlite-vec Docs](https://alexgarcia.xyz/sqlite-vec/) | Full docs — creating tables, inserting vectors, querying, performance characteristics | Brute-force KNN (no index needed < 100K vectors), `vec_distance_cosine()`, BLOB vs JSON vector format |
| [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | Model card — dimensions (384), performance benchmarks, GGUF availability | Local embedding model, 384-dim vectors, ~25MB GGUF weight file for offline operation |
| [BM25 Algorithm](https://en.wikipedia.org/wiki/Okapi_BM25) | Formula and parameters (k1=1.2, b=0.75 defaults) | Keyword relevance scoring for hybrid search, term frequency saturation, document length normalization |
| [MMR — Maximal Marginal Relevance](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf) | Carbonell & Goldstein 1998 — MMR formula | Re-ranking to reduce redundancy in results: `lambda * sim(q, d) - (1-lambda) * max(sim(d, d_selected))` |
| [Paperclip Spec](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) | §2 Agent Model, §3 Org Structure, §6 Cost Tracking | Agent identity schema, org hierarchy context injection, budget-gated memory operations |
| [Factory.ai Missions](https://factory.ai/news/missions) | Blog post — skill extraction from mission runs | Skills compound over time from agent work; procedural knowledge extracted from successful patterns (W7 input) |

W6 replaces the old `memoryService` with a single unified memory backend and moves the renderer inspection surface over to that backend. As of 2026-03-05, this work is complete as a runtime migration: durable project/agent/mission memory runs through unified memory, and runtime context assembly no longer depends on persisted pack files. Deterministic pack exports still remain, but only as explicit compatibility/audit surfaces over live local state.

##### Why: The Current Problem

ADE currently has three overlapping knowledge systems:

1. **Context packs** (`packService.ts`, ~8,600 lines + ~1,700 lines UI): Deterministic markdown documents assembled from git/DB state. Project packs, lane packs, mission packs, plan packs, feature packs, conflict packs. Versioned, stored on disk, injected into worker prompts. Users see them in Settings > Context and Lane Inspector.
2. **Memory service** (`memoryService.ts`, ~420 lines): SQLite table where agents write facts/patterns/gotchas. Simple `LIKE %word%` keyword search. Scoped by project/lane/mission. Written by mission workers, read by mission workers.
3. **CTO state service** (`ctoStateService.ts`): Dual-persisted (file + DB) identity, core memory, and session logs. Separate from the memory service. Only used by CTO.

Problems:
- Project pack and CTO core memory store the same information (project conventions, stack details) in two places.
- Memory service and CTO memory are separate stores with separate search.
- Pack system pre-computes deterministic state into markdown blobs instead of letting agents query live.
- Pack versioning/events/deltas add complexity with little user value.
- Lane packs, mission packs, plan packs, feature packs are internal context assembly surfaced as user-facing artifacts.

##### The Replacement: One Memory Service, Three Scopes

```
┌─────────────────────────────────────────────────────────┐
│              UNIFIED MEMORY SERVICE                      │
│  unifiedMemoryService.ts — replaces packService.ts,     │
│  memoryService.ts, and ctoStateService core memory       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  PROJECT MEMORY (one per project, persistent)            │
│  Shared knowledge about this codebase.                   │
│  Writers: CTO, CTO workers, mission pipeline,            │
│           bootstrap scan, chat sessions (strict), user   │
│  Readers: everyone                                       │
│                                                          │
│  AGENT MEMORY (one per CTO-tab agent, persistent)        │
│  Personal knowledge for one CTO or CTO worker.           │
│  Writers: that agent only (self-editing via tools)        │
│  Readers: that agent only                                │
│                                                          │
│  MISSION MEMORY (one per mission run, temporary)          │
│  Shared state for workers in a single mission.            │
│  Writers: coordinator, mission workers, orchestrator sys  │
│  Readers: coordinator, workers in same mission            │
│  Lifecycle: promotes to project memory on completion,     │
│             then archived                                 │
│                                                          │
├─────────────────────────────────────────────────────────┤
│  Each scope has three tiers:                             │
│  Tier 1 (Pinned): Always in context (~2-4K tokens)       │
│  Tier 2 (Hot): Retrieved on demand via hybrid search     │
│  Tier 3 (Cold): Archived, rarely searched                │
└─────────────────────────────────────────────────────────┘
```

##### Memory Schema

```typescript
interface UnifiedMemoryEntry {
  id: string;
  projectId: string;
  scope: "project" | "agent" | "mission";
  scopeOwnerId: string | null;      // agentId for agent scope, missionId for mission scope, null for project
  tier: 1 | 2 | 3;
  category: "fact" | "convention" | "pattern" | "decision" | "gotcha" | "preference"
          | "episode" | "procedure" | "digest" | "handoff";
  content: string;
  importance: "low" | "medium" | "high";
  confidence: number;                // 0-1, increases with observations/confirmations
  observationCount: number;          // how many times this has been seen/confirmed
  status: "candidate" | "promoted" | "archived";
  sourceType: "agent" | "system" | "user" | "mission_promotion";
  sourceId: string | null;           // sessionId, missionId, runId, or null
  fileScopePattern: string | null;   // e.g. "src/auth/**" for scoped applicability
  embedding: Float32Array | null;    // populated async by embedding pipeline
  accessCount: number;
  lastAccessedAt: string;
  promotedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

SQLite table: `unified_memories` is the canonical durable memory store and receives a one-time backfill from the legacy `memories` table. `orchestrator_shared_facts` still remains live as a separate run-scoped coordination table.

##### Three-Tier Details Per Scope

**Project Memory tiers:**
```
Tier 1 (Pinned, always injected, ~2-4K tokens budget):
  - Critical conventions ("use vitest not jest", "run migrations after auth changes")
  - User-stated preferences ("prefer small PRs", "always write tests")
  - Active project focus ("currently refactoring billing module")
  - Self-editable by CTO via memoryUpdateCore, user-editable in UI

Tier 2 (Hot, searched on demand):
  - Learned patterns from missions ("Stripe webhook handler needs CORS update")
  - Episodic summaries from completed missions/sessions
  - Project change digests (what changed while user worked solo)
  - Architecture decisions, API patterns, gotchas

Tier 3 (Cold, archived):
  - Old episodic summaries past decay threshold
  - Superseded facts (replaced by consolidation)
  - Low-access-count entries that decayed out of Tier 2
```

**Agent Memory tiers (CTO tab agents only):**
```
Tier 1 (Pinned, always in that agent's context):
  - Agent identity: name, role, persona, adapter config
  - Domain ownership: "I own /api and /middleware"
  - Current focus: "working on billing refactor"
  - Replaces: ctoStateService core-memory.json fields

Tier 2 (Hot, searched when agent activates):
  - Past run summaries and outcomes
  - Domain-specific patterns learned
  - Recent session summaries (replaces ctoStateService session logs)

Tier 3 (Cold):
  - Old run history, superseded domain knowledge
```

**Mission Memory tiers:**
```
Tier 2 only (everything is hot during active mission):
  - Shared facts: "API endpoint changed from /v1 to /v2"
  - Coordinator decisions: "splitting into 3 parallel steps because X"
  - Step handoffs: "Step A completed, output: new middleware added at /api/auth"
  - Current status: mission-scoped entries exist in unified memory, but `orchestrator_shared_facts` and handoff tables are still part of the live run-state model

After mission completes:
  - Shared facts are reviewed and promoted into project memory on successful run completion
  - Candidate memories remain available for manual promotion/archive review
  - Automatic episodic-summary generation remains future work
```

##### Retrieval and Ranking (Shipped Baseline)

The current W6 implementation is intentionally native/local and does **not** require a vector DB migration. The shipped path is:

- Search uses SQL filtering plus service-level lexical/composite scoring from `unifiedMemoryService.ts`.
- Ranking uses query coverage, recency decay, importance, confidence, access frequency, and tier/pin boosts.
- **Budget tiers**: Control how many results are returned per search — **Lite (3 entries)** for quick tasks and chat sessions, **Standard (8 entries)** for normal work, **Deep (20 entries)** for mission planning and CTO activation.
- **Access tracking**: Every time an entry is returned from search, bump its `accessCount` and `lastAccessedAt`. This feeds the composite scoring formula and prevents useful entries from decaying.

`unified_memory_embeddings` exists in schema, but embeddings are **not part of the active retrieval path yet**. There is currently no shipped BM25/FTS fusion, query embedding, cosine similarity search, or MMR pass. Those remain later-phase enhancements if we decide lexical retrieval is no longer sufficient.

##### Composite Scoring for Retrieval

Every search result is ranked by composite score, not just semantic similarity. The formula combines five signals:

- **Lexical query match (40%)**: Query-word coverage plus a small exact-phrase bonus.
- **Recency (20%)**: Exponential decay with 30-day half-life on `lastAccessedAt`. An entry untouched for 30 days scores 0.50; at 90 days, 0.125; at 180 days, effectively zero. This is standard [exponential decay](https://en.wikipedia.org/wiki/Exponential_decay) — same math as radioactive half-life.
- **Importance (15%)**: High=1.0, Medium=0.6, Low=0.3. User-confirmed entries and conventions get high importance.
- **Confidence (15%)**: The entry's `confidence` field (0-1). Grows with observations and confirmations, decays on contradictions.
- **Access frequency (10%)**: `min(accessCount / 10, 1.0)`. Frequently retrieved memories rank higher, capped at 10 accesses.

##### Write Gate: Preventing Memory Bloat

The shipped write gate is smaller than the aspirational Mem0-style design. Today every write goes through:

**Stage 1 — Category filter (instant, no AI)**: Reject transient noise (tool invocation logs, raw diffs, step lifecycle events, reasoning preamble, one-line fragments). Accept only entries with valid categories (fact, convention, pattern, decision, gotcha, preference, episode, procedure, digest, handoff). Entries with high importance in knowledge-bearing categories (convention, decision, preference) pass directly as "promoted". Everything else enters as "candidate" status with low initial confidence — needs multiple observations to earn promotion. User-written entries always pass. Truncate content over 2,000 chars.

**Stage 2 — Lexical dedupe / merge (shipped)**: Search recent Tier 1/Tier 2 entries in the same scope and compare normalized content plus token overlap.
- Exact duplicate: reinforce the existing row.
- Near duplicate: merge content directly and boost confidence/observations.
- Otherwise: insert a new row.

There is currently **no** embedding-based dedupe and **no** LLM PASS/REPLACE/APPEND/DELETE consolidation step in the shipped backend.

**Stage 4 — Chat session strictness (for regular chat sessions only)**: Regular chat sessions (non-CTO, non-mission) write to project memory with a higher bar — only `importance: "high"` entries with categories `convention | pattern | gotcha | decision` pass. The agent's `memoryAdd` tool prompt instructs: _"Only save discoveries that other agents working on this project would need."_

**Pipeline order (current)**: Stage 4 (when applicable) → Stage 1 → Stage 2.

##### Memory Lifecycle: Decay, Compaction, and Upkeep

Current shipped lifecycle behavior:

- **Ranking decay is live**: recency decay is part of composite search scoring.
- **Access tracking is live**: reads bump `accessCount` and `lastAccessedAt`.
- **Manual state changes are live**: candidate review, promote, archive, and pin flows exist in the service and UI tooling.
- **Legacy backfill is live**: the old `memories` table is copied forward into `unified_memories` during schema bootstrap.
- **Successful-run promotion is live**: `orchestrator_shared_facts` are promoted into project memory on successful mission completion.

Not yet shipped:

- Periodic sweeps for stale candidates or automatic tier demotion
- Weekly/on-demand consolidation batches
- Hard-limit enforcement and health-dashboard events
- Automatic episodic-summary generation for every mission/session

##### Pre-Compaction Memory Flush

The current compaction path still writes summaries/shared facts, but it does **not** yet run the fully documented silent `memoryAdd` flush workflow. Treat the full OpenClaw-style pre-compaction memory flush as future work unless it is explicitly wired in code.

##### Mission Memory Lifecycle

**During mission**:
- Coordinator creates mission memory scope on mission start (automatic, no agent action needed).
- Coordinator writes decisions and plan rationale via `memoryAdd` with `scope: "mission"`.
- Mission workers write shared facts and handoffs via `memoryAdd` with `scope: "mission"`.
- Workers read mission memory via `memorySearch` with `scope: "mission"` to find peer discoveries.
- Worker prompts currently inject shared facts, project knowledge, and mission memory highlights, but structured lane/project context assembly still depends on pack exports.

**On mission completion**:
- System generates an episodic summary (structured: what happened, outcome, tools used, patterns found, gotchas):
  ```typescript
  interface EpisodicMemory {
    id: string;
    sessionId?: string;
    missionId?: string;
    taskDescription: string;
    approachTaken: string;
    outcome: "success" | "partial" | "failure";
    toolsUsed: string[];
    patternsDiscovered: string[];
    gotchas: string[];
    decisionsMade: string[];
    duration: number;
    createdAt: string;
  }
  ```
- Episodic summary saved to project memory as `category: "episode"`, Tier 2, `sourceType: "mission_promotion"`.
- High-confidence discoveries (confidence >= 0.7) auto-promoted to project memory.
- Everything else archived to Tier 3 (retained for audit, excluded from search).

**Promotion decision logic (current)**: successful mission runs promote persisted shared facts into project memory using fixed fact-type confidence thresholds. This is a deterministic promotion path, not a semantic/vector merge pipeline.

##### Human Work Ingestion (User-Only Changes)

Users frequently change code/config outside agent runs. Without ingestion, agents make decisions on stale assumptions.

- **Project snapshot tracking**: Track `lastSeenHeadSha` per project. Gate dispatch on freshness.
- **Change digest triggers**: App startup after repo change, before mission dispatch when HEAD diverged, explicit user action ("Sync knowledge"), PR merge / branch switch.
- **Digest contents** (noise-controlled, no raw diffs): Commit range summary, diffstat, changed file list, semantic clustering of changed files.
- **Write policy**: Digest saved as project memory entry with `category: "digest"`, Tier 2. CTO workers whose path routing matches the change cluster get notified so their next activation starts with fresh context.

##### Memory Tools for Agents

- **`memorySearch`** — Lexical/composite search over `unified_memories`, scope-aware (`project`, `agent`, `mission`).
- **`memoryAdd`** — Scope-aware writes through the current write gate (category filter + lexical dedupe/merge; chat sessions still use strict mode where configured).
- **`memoryUpdateCore`** — Self-edit Tier 1 pinned entries for the current agent. CTO edits project Tier 1, workers edit their own agent Tier 1.
- **`memoryPin`** — Pin a Tier 2 entry to Tier 1 (always in context, bypasses retrieval scoring).

All four tools available to: CTO sessions, CTO worker sessions, mission workers, regular chat sessions (with strict write gate for chat).

##### Context Export Compatibility Inventory

W6 renderer cutover and backend runtime migration are complete. The remaining deterministic export surfaces are intentional compatibility layers, not open migration blockers.

**Current status (2026-03-05):**
- Removed: renderer pack wrappers (`PackViewer.tsx`, `PackFreshnessIndicator.tsx`) and context UI moved to memory inspector.
- Removed from `packService` runtime ownership: context-doc IPC flows and session-delta IPC reads.
- Removed as runtime blockers: orchestrator pack bootstrap/head/delta reads and pack-backed conflict resolver references.
- Still live intentionally: MCP `read_context` / `ade://pack/...`, optional persisted pack refresh/version history, mission-pack refresh hooks for compatibility, and import/UI aliases such as `memoryService.ts` and `ContextSection.tsx`.
- Rule: delete pack modules only when the remaining compatibility contracts are intentionally replaced or versioned away.

**Deletion candidates once consumers are migrated:**
- `src/main/services/packs/packService.ts`
- `src/main/services/packs/projectPackBuilder.ts`
- `src/main/services/packs/missionPackBuilder.ts`
- `src/main/services/packs/conflictPackBuilder.ts`
- `src/main/services/packs/packExports.ts`
- `src/main/services/packs/packUtils.ts`
- `src/main/services/packs/packSections.ts`
- `src/main/services/packs/lanePackTemplate.ts`
- `src/main/services/packs/transcriptInsights.ts`
- Remaining tests under `src/main/services/packs/`
- `src/shared/types/packs.ts` (only after no runtime consumer imports remain)

**Consumers to migrate** (live compatibility surface):
- `orchestratorService.ts`: Replace `packService.getProjectExport()` / `packService.getLaneExport()` calls with `unifiedMemoryService.search({ scope: "project", budget: "standard" })`. The worker briefing assembly (L0/L1/L2) stays as structured prompt assembly but pulls from memory queries instead of pack markdown.
- `mcpServer.ts` / `bootstrap.ts`: Replace pack-backed `read_context` resources and `ade://pack/...` resources with memory/context-native exports, or explicitly keep them as compatibility resources.
- `conflictService.ts`: Query memory for conflict-relevant entries instead of reading conflict packs.
- `main.ts`: `packService` construction remains required until the consumers above are migrated or explicitly retained.

**Consumers already migrated off `packService` in this branch:**
- `registerIpc.ts`: context-doc status/generate/open now route through `contextDocService`; `ade.sessions.getDelta` now routes through `sessionDeltaService`.
- `MemoryInspector.tsx` / `ContextSection.tsx`: renderer inspection surface is memory-first via `window.ade.memory.*`.
- `memoryService.ts`: compatibility alias over `createUnifiedMemoryService(db)`.

**What stays**:
- `.ade/context/PRD.ade.md` and `ARCHITECTURE.ade.md` — user-editable reference docs. Indexed into project memory (Tier 2) by the bootstrap scan. `GenerateDocsModal.tsx` stays.
- Worker briefing assembly in `orchestratorService.ts` — the L0/L1/L2 structured prompt stays as-is architecturally but pulls from memory instead of packs.
- `contextContract.ts` / `contextShared.ts` — evaluate which parts are still needed for `.ade/context/` docs, remove the rest.

**New UI replacement**:
- `src/renderer/components/settings/MemoryInspector.tsx` — replaces ContextSection. Shows project memory entries by tier, search, filter by category/scope. Edit/pin/archive controls. Health dashboard (entry counts, last sweep, consolidation stats).

##### CTO State Migration

- `ctoStateService.ts` core memory fields (`projectSummary`, `criticalConventions`, `userPreferences`, `activeFocus`, `notes`) become Tier 1 pinned entries in project memory scope.
- `ctoStateService.ts` session logs become Tier 2 entries in agent memory scope (CTO agent).
- `ctoStateService.ts` identity fields (name, persona, model preferences) stay in `cto_identity_state` DB table — identity is not memory.
- `ctoStateService.buildReconstructionContext()` is replaced by: query Tier 1 project memory + Tier 1 CTO agent memory → assemble reconstruction context.
- Worker agent core memory (`getAgentCoreMemory`, `updateAgentCoreMemory`) migrates to agent-scoped Tier 1 entries.

##### Implementation Sub-Phases

**W6a — Memory engine** (core infrastructure):
- `unifiedMemoryService.ts`: CRUD, scoping, tiering, write gate (stages 1-2), temporal decay, candidate sweep.
- `unified_memories` SQLite table + migration from `memories` and `shared_facts`.
- Embeddings table reserved for future retrieval work; active shipped retrieval remains lexical/composite scoring (native sqlite-vec integration deferred).
- Composite scoring function.
- Memory tools: `memorySearch`, `memoryAdd`, `memoryUpdateCore`, `memoryPin`.
- Tests: search accuracy, dedup, scoring, tier promotion/demotion, candidate sweep, hard limits.

**W6b — CTO + worker migration**:
- Migrate CTO core memory → project memory Tier 1 + agent memory Tier 1.
- Migrate CTO session logs → agent memory Tier 2 episodes.
- Migrate worker core memory → agent memory Tier 1.
- Wire memory tools into all chat sessions (not just CTO). Strict write gate for regular chat.
- Update `agentChatService.ts` to inject relevant project memory (Tier 2 search) into regular chat session context.
- Pre-compaction flush hook in `compactionEngine.ts`.
- Tests: CTO reconstruction from memory, worker activation with agent memory, chat memory injection.

**W6c — Mission memory**:
- Replace `shared_facts` with mission-scoped memory entries.
- Coordinator writes decisions/rationale to mission memory.
- Mission workers write discoveries to mission memory.
- Episodic summary generation at mission/session end.
- Promotion pipeline: mission memory → project memory (rule-based, not AI).
- Update worker briefing assembly to pull from memory.
- Tests: mission memory lifecycle, episodic extraction, promotion rules, briefing assembly from memory.

**W6d — Pack removal + UI**:
- Delete all pack files listed above.
- Migrate all 22 consumer files.
- Remove pack-related IPC handlers, add memory IPC handlers.
- Remove pack-related preload bridge methods, add memory bridge methods.
- Build `MemoryInspector.tsx` replacing `ContextSection.tsx`.
- Remove `PackViewer.tsx`, `PackFreshnessIndicator.tsx`.
- Update `LaneInspectorPane.tsx` to show relevant memory entries instead of pack viewer.
- Human work ingestion: snapshot tracking, change digest triggers, digest-to-memory pipeline.
- Tests: consumer migration (orchestrator reads memory instead of packs), UI rendering, IPC handlers.

**Tests (comprehensive):**
- Lexical retrieval quality: current shipped retrieval is keyword/composite only, so vector/BM25/MMR evaluation remains future work rather than current behavior.
- Write gate: dedup detection at 0.95 threshold, near-dedup at 0.85, LLM consolidation PASS/REPLACE/APPEND/DELETE.
- Composite scoring: recency decay with 30-day half-life, importance weighting, confidence boost, access boost capping.
- Tier lifecycle: Tier 2 → Tier 3 decay (90 days), Tier 3 → archived (180 days), Tier 2 → Tier 1 pinning, Tier 1 max enforcement.
- Candidate sweep: auto-promote at confidence >= 0.7 + observationCount >= 2, auto-archive stale candidates.
- Consolidation batch: cluster detection, LLM merge, entry count reduction.
- Hard limits: project 2,000, agent 500, mission 200, Tier 1 max 20.
- Pre-compaction flush: memories persisted before compaction, flush counter prevents double-flush.
- Episodic memory extraction: post-session and post-mission summaries with correct structure.
- Mission memory lifecycle: creation, cross-worker reads, promotion on completion, archival.
- Human work ingestion: snapshot divergence triggers digest, digest stored as Tier 2, workers notified.
- Chat session strict mode: high-importance only, category filter, rejection of transient writes.
- Consumer migration: orchestrator builds worker briefing from memory, not packs.
- CTO reconstruction: Tier 1 project + Tier 1 agent → same quality as old buildReconstructionContext.

#### W7: Skills + Learning Pipeline

> Source: [Factory.ai missions](https://factory.ai/news/missions) — skill extraction pattern (missions extract skills, skill library compounds over time). [LangMem procedural memory](https://langchain-ai.github.io/langmem/concepts/) — episodic → semantic → procedural extraction pipeline. [Vercel/Anthropic skills format](https://docs.anthropic.com/en/docs/claude-code/skills) — `.claude/skills/` universal markdown convention. [Paperclip runtime skill injection](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) — SKILLS.md injected into agent context at runtime.

##### Required Reading for Implementation

| Reference | What to Read | What ADE Adopts |
|-----------|-------------|-----------------|
| [Factory.ai Missions Blog](https://factory.ai/news/missions) | Full post — how missions extract skills that compound over time | Core concept: agent work produces reusable skills. Skill library grows with each mission. |
| [LangMem Concepts — Memory Types](https://langchain-ai.github.io/langmem/concepts/) | Episodic, Semantic, and Procedural memory sections | Three-stage pipeline: episodes (what happened) → semantic facts (what we know) → procedures (what to do). Extraction triggers and consolidation. |
| [LangMem Source — `knowledge/`](https://github.com/langchain-ai/langmem/tree/main/langmem/knowledge) | Extraction logic, clustering, and procedural generation | Pattern detection from episode clusters, LLM-driven procedure extraction. |
| [Claude Code Skills Docs](https://docs.anthropic.com/en/docs/claude-code/skills) | Skills format, directory convention, how skills are loaded | `.claude/skills/<name>/SKILL.md` format — universal markdown, any agent can consume. Trigger description + step-by-step instructions. |
| [Paperclip SKILLS.md Injection](https://github.com/paperclipai/paperclip/blob/main/doc/SPEC.md) | §7 Runtime Context, SKILLS.md section | Skills injected into agent system prompt at activation time. Goal hierarchy provides skill selection context. |
| [CrewAI Memory — Long-Term](https://docs.crewai.com/concepts/memory) | Long-term memory and learning sections | Confidence evolution: success/failure tracking, automatic archival of low-confidence procedures. |

W7 builds the extraction and materialization layer on top of W6's unified memory. It turns accumulated mission experience into reusable skills that any agent (Claude, Codex, or any future adapter) can consume.

##### Procedural Memory Extraction

> Reference: [LangMem — procedural memory](https://langchain-ai.github.io/langmem/concepts/) — extraction from episodic clusters. [Factory.ai — missions](https://factory.ai/news/missions) — skills compound over time from agent work.

When the same pattern appears across 3+ episodic summaries (from different missions or sessions), the system extracts it as a procedural memory:

```typescript
interface ProceduralMemory {
  id: string;
  trigger: string;       // When to apply: "changing auth module", "updating API endpoints"
  procedure: string;     // What to do: "1. Run migration 2. Update CORS 3. Regenerate types"
  confidence: number;    // 0-1, increases with successful applications
  successCount: number;
  failureCount: number;
  sourceEpisodeIds: string[];  // episodic memories this was derived from
  lastUsed: string;
  createdAt: string;
}
```

**Extraction trigger**: After each episodic summary is saved to project memory, the system scans for recurring patterns. This follows [LangMem's episodic → procedural extraction pipeline](https://langchain-ai.github.io/langmem/concepts/):
1. Embed the new episode, search project memory for similar episodes (cosine > 0.75).
2. If 3+ similar episodes found with overlapping `patternsDiscovered` or `decisionsMade`, check if a procedure already exists for this pattern (cosine > 0.85 against existing procedures). If so, boost its confidence instead of creating a new one.
3. If no existing procedure matches, invoke LLM with the cluster of episodes. LLM extracts: trigger condition + step-by-step procedure + confidence estimate.
4. Saved as project memory entry with `category: "procedure"`, Tier 2, `status: "candidate"`.
5. On subsequent missions, procedures with matching triggers are injected into worker context.

**Confidence evolution**: Follows a Bayesian-style belief update — success increases confidence with diminishing returns (asymptotic to 1.0), failure decreases it more sharply (we take failures seriously). See [CrewAI's long-term memory confidence tracking](https://docs.crewai.com/concepts/memory) for a similar pattern. Auto-archive procedures that consistently fail (confidence < 0.3 after 5+ applications). Auto-promote procedures that consistently succeed (confidence >= 0.8 after 3+ applications).

##### Knowledge Source Capture

Automatic capture from agent interactions into project memory. These entries feed the episodic → procedural pipeline above. All captures go through the W6 write gate (dedup + consolidation), so duplicates are automatically merged.

- **Mission failures and resolutions**: Hook into the orchestrator's step failure → retry/resolution path. Capture the failure pattern and resolution as a gotcha/pattern entry with file scope inferred from changed files. Enters as candidate with medium confidence — needs confirmation from repeated observation.
- **User interventions**: When a user corrects an agent during a mission (steering message, manual fix), infer the implicit rule and save as a candidate convention. Example: user says "don't use default exports" → candidate convention, promoted after 2+ observations.
- **Repeated errors**: On session/mission end, check error patterns against existing gotcha entries via vector search. If the same error appears in 3+ sessions (2 existing + current, cosine > 0.85), escalate the existing entry's importance to "high" and boost confidence.
- **PR review feedback**: If available (via Linear sync or git), reviewer patterns that repeat → recorded as preferences.

##### Skill Materialization

Confirmed procedural memories can be exported as universal skill files:

- User reviews procedural memories in Settings > Memory (procedures section).
- User confirms a procedure → system materializes it as `.claude/skills/<name>/SKILL.md`.
- Skill file format: plain markdown with trigger description, step-by-step instructions, and context notes. Follows Vercel skills convention — any agent that reads markdown can consume it.
- Skills are also indexed back into project memory so ADE's own agents can discover and apply them.

```
.claude/
  skills/
    auth-migration/
      SKILL.md          # "When changing auth module: 1. Run migration..."
    api-versioning/
      SKILL.md          # "When updating API endpoints: 1. Update routes..."
```

##### Skill Ingestion

Read existing skill and command files into project memory:

- On startup and on file change, scan `.claude/skills/`, `.claude/commands/`, `CLAUDE.md`, `agents.md`.
- Parse each file and index into project memory as Tier 2 entries with `category: "procedure"`, `sourceType: "user"`.
- This means skills written by the user or imported from external sources (e.g. `npx skills add`) are automatically available to all ADE agents.

##### Renderer

- Settings > Memory section (built in W6d) gains a "Procedures" tab showing extracted procedures with confidence scores, source episodes, and "Export as Skill" button.
- Settings > Memory also shows a "Skills" tab listing `.claude/skills/` files with import status.

**Tests:**
- Procedural extraction: pattern detection from 3+ similar episodes, LLM extraction call, confidence initialization.
- Confidence evolution: success increments, failure decrements, archival at low confidence.
- Knowledge capture: failure→resolution recording, user intervention→candidate convention, repeated errors→gotcha.
- Skill materialization: procedure → `.claude/skills/SKILL.md` file, correct format, file write.
- Skill ingestion: `.claude/skills/` scan, parse, index into project memory, dedup with existing entries.
- End-to-end: mission run → episodic summary → pattern detected → procedure extracted → user confirms → skill file created → future mission reads skill.

#### W8: External MCP Consumption

ADE agents (mission workers and CTO) can consume external MCP servers, extending capabilities beyond what ADE provides natively.

- **Configuration**: External MCP servers declared in `.ade/local.secret.yaml` (gitignored):
  ```yaml
  externalMcp:
    - name: web-browser
      transport: stdio
      command: npx
      args: ["-y", "@anthropic/mcp-web-browser"]
    - name: notion
      transport: sse
      url: https://mcp.notion.so/sse
      headers:
        Authorization: "Bearer ${NOTION_TOKEN}"
    - name: linear
      transport: stdio
      command: npx
      args: ["-y", "@anthropic/mcp-linear"]
  ```
- **Tool discovery**: On startup, ADE connects to declared servers, discovers tools, registers with prefix (e.g., `ext.web-browser.navigate`, `ext.notion.search`).
- **CTO agent access**: External MCP tools available for research, documentation queries, issue tracking, cross-system tasks.
- **Mission worker access**: Per mission-level MCP profile. Mission launch flow includes MCP tool selector.
- **Lifecycle management**: ADE manages connections — start on demand, health-check, reconnect on failure, shutdown when unused.
- **Security**: External MCP tools subject to same guardrail enforcement as built-in tools. Budget enforcement applies to external tool invocations that incur costs.

- **Renderer**: External MCP configuration in Settings. Tool discovery status. Connection health indicators.

**Tests:**
- Tool discovery and namespace prefixing.
- Lifecycle management: connect, health-check, reconnect, shutdown.
- Permission enforcement on external tools.
- Configuration parsing: `.ade/local.secret.yaml`, stdio and SSE transport support.

#### W9: OpenClaw Bridge (External Agent Gateway)

> Source: OpenClaw integration architecture from [features/CTO.md § OpenClaw Integration Architecture](../features/CTO.md).

Connect ADE's CTO agent to OpenClaw (or similar external agent gateways), enabling bidirectional communication between the user's personal agent network and ADE's tech-focused CTO.

- **Conceptual model**:
  - OpenClaw is the user's personal life gateway — multiple agents handling different domains.
  - ADE CTO is the entire tech department — one persistent agent with deep project knowledge.
  - The bridge makes CTO accessible as a specialist within the user's OpenClaw agent network.

- **Bridge service** (`openclawBridgeService.ts` in `src/main/services/`):
  - **HTTP server** (port 3742): Receives inbound requests from OpenClaw hooks/skills. Acknowledges immediately, forwards to CTO via IPC, returns response.
  - **WebSocket operator client**: Connects to OpenClaw's Gateway (`ws://127.0.0.1:18789`) as `operator` role for bidirectional, low-latency communication.
  - Handles OpenClaw's device pairing protocol: challenge-nonce handshake, `connect` request with auth token, `deviceToken` persistence for reconnection.
  - Subscribes to `agent` and `chat` events for real-time message routing.

- **Inbound flow (OpenClaw → CTO)**: OpenClaw agent calls `sessions_send` targeting `hook:ade-cto` → Gateway hook POSTs to bridge → bridge forwards to CTO via IPC → CTO processes → bridge POSTs reply back.

- **Outbound flow (CTO → OpenClaw)**: CTO/orchestrator wants to proactively message OpenClaw agent → bridge calls `sessions_send` over WebSocket → target agent receives and replies stream back as `agent` events.

- **Fallback: skill-only bridge** (no WebSocket): Simpler one-directional integration where OpenClaw agents use `exec` + `curl` to hit ADE's HTTP endpoint.

- **IPC channels**:
  - `openclaw:message-received` — inbound message from OpenClaw to CTO.
  - `cto:forward-to-openclaw` — outbound message from CTO to OpenClaw agent.
  - `openclaw:connection-status` — bridge connection state for UI indicator.

- **Configuration** (in `.ade/local.secret.yaml`, gitignored):
  ```yaml
  openclaw:
    enabled: false
    gatewayUrl: ws://127.0.0.1:18789
    gatewayToken: ${OPENCLAW_GATEWAY_TOKEN}
    bridgePort: 3742
    hooksToken: <shared-secret>
    deviceToken: <persisted-after-first-handshake>
  ```

- **Scope boundary**: ADE implements the bridge service. OpenClaw-side configuration (hooks, skills, agent setup) is user-managed and documented in `docs/features/CTO.md`.

- **Renderer**: OpenClaw connection status indicator in CTO tab. Bridge configuration in Settings.

**Tests:**
- HTTP endpoint: inbound message acceptance, async CTO forwarding, response delivery.
- WebSocket operator: handshake (challenge-nonce, connect, hello-ok), reconnection with persisted `deviceToken`.
- Outbound: `sessions_send` over WebSocket delivers to OpenClaw and receives reply events.
- Configuration: `.ade/local.secret.yaml` openclaw section parsing, enabled/disabled toggle, secret isolation.
- Error handling: OpenClaw gateway unavailable (graceful degradation), CTO unavailable (queued retry), malformed inbound requests (reject with error).

#### W10: .ade/ Portable State

Consolidates the project-level `.ade/` directory structure, git-tracking policy, and configuration split (tracked vs. secret). This workstream materializes the storage layout that W1 (CTO state) and W6 (memory) populate.

- **Complete directory structure**:
  ```
  .ade/
  ├── cto/
  │   ├── identity.yaml          # CTO persona, model preferences, policy config
  │   ├── core-memory.json       # CTO Tier 1: persona and project context
  │   ├── memory/                # CTO Tier 2: hot memories + archive/
  │   └── sessions.jsonl         # CTO session history log
  ├── agents/
  │   ├── backend-dev/
  │   │   ├── identity.yaml      # Worker persona, adapter config, heartbeat policy
  │   │   ├── core-memory.json   # Worker Tier 1 core memory
  │   │   ├── memory/            # Worker Tier 2 + archive
  │   │   └── sessions.jsonl     # Worker session log
  │   └── ...
  ├── templates/
  │   ├── bug-fix.yaml           # Mission template: bug fixes
  │   ├── feature.yaml           # Mission template: features
  │   └── refactor.yaml          # Mission template: refactors
  ├── context/
  │   ├── PRD.ade.md             # AI-generated project context
  │   └── ARCHITECTURE.ade.md   # AI-generated architecture context
  ├── memory/
  │   ├── project.json           # Project-level facts (Tier 2/3)
  │   ├── learning-pack.json     # Auto-curated knowledge (W7)
  │   └── archive/               # Cold storage (Tier 3)
  ├── history/
  │   └── missions.jsonl         # Mission run log (append-only)
  ├── local.yaml                 # Git-tracked: project config (lane templates, phase profiles, feature flags - NO secrets)
  ├── local.secret.yaml          # Gitignored: machine-specific secrets (API keys, local paths, external MCP configs)
  ├── ade.db                     # cr-sqlite synced (Phase 6): ALL app state (gitignored)
  ├── ade.db-wal                 # WAL file (gitignored)
  ├── mcp.sock                   # Runtime socket (gitignored)
  ├── embeddings.db              # sqlite-vec embeddings cache (gitignored, regenerated)
  ├── artifacts/                 # Proof-of-work artifacts (screenshots/videos/logs) (gitignored)
  ├── transcripts/               # Machine-specific logs (gitignored)
  ├── cache/                     # Machine-specific cache (gitignored)
  ├── worktrees/                 # Machine-specific lane checkouts (gitignored)
  └── secrets/                   # Machine-specific secrets (gitignored)
  ```

- **Git-tracking policy**:
  - **Tracked** (committable): `cto/`, `agents/`, `templates/`, `context/`, `memory/`, `history/`, `local.yaml` — tiny config files for version tracking.
  - **Gitignored** (machine-specific): `local.secret.yaml`, `ade.db*`, `mcp.sock`, `embeddings.db`, `artifacts/`, `transcripts/`, `cache/`, `worktrees/`, `secrets/`.

- **Configuration split**:
  - `local.yaml` (tracked): Lane templates, phase profiles, feature flags, Linear sync config (project slug, dispatch rules, concurrency limits). No secrets.
  - `local.secret.yaml` (gitignored): API keys, external MCP server configs, Linear API token, OpenClaw gateway token, local paths.

- **App state sync strategy**: Git tracks code and config. cr-sqlite (Phase 6) syncs app state (`ade.db`). Embeddings are local-only and regenerated on new machines.

- **Startup validation**: On app startup, verify `.ade/` structure exists and is well-formed. Create missing directories. Validate `local.yaml` schema. Warn on missing `local.secret.yaml` if features require it.

- **Migration**: Move any existing state (from pre-Phase-4 storage) into the `.ade/` structure.

- **Renderer**: `.ade/` structure visible in Settings → Project. Configuration editor for `local.yaml`.

**Tests:**
- Config files round-trip via git (tracked files preserve through clone/checkout).
- `local.secret.yaml` isolation: never appears in git status after `.gitignore` setup.
- Startup validation: missing directories created, schema validation catches malformed `local.yaml`.
- Migration: existing state moved correctly into new structure.

### Exit criteria

- CTO tab provides persistent project-aware agent interface with three-tier memory model and org chart sidebar.
- CTO agent has access to all ADE MCP tools and external MCP tools.
- Worker agents can be created, configured, and managed under the CTO in an org hierarchy.
- First-run CTO onboarding exists for empty projects: detects missing setup and supports opt-in repo/context-pack bootstrap into core memory.
- Each worker has its own identity, memory tiers, adapter config, heartbeat policy, and budget.
- Heartbeat system activates agents on schedule or demand, with coalescing, deferred promotion, and orphan reaping.
- Bidirectional Linear sync: CTO polls Linear for issues, auto-dispatches missions via templates, and posts results back (state updates, workpad comments, PR links).
- Reconciliation validates running missions against Linear state on every heartbeat.
- Auto-dispatch policies are user-configurable per label/priority with escalation for complex work.
- Linear sync supports multiple projects with per-project default owners (worker routing), plus optional assignee setting for attribution.
- Mission runs emit a proof-of-work artifact bundle and link/attach it back to Linear on completion (logs + screenshots/videos when relevant).
- Human-only work ingestion creates change digests when the repo diverges outside agent runs and feeds them into CTO/worker memory before the next dispatch.
- Per-agent monthly budgets with auto-pause enforcement and CTO notification.
- Agent config versioning with rollback support.
- Multi-adapter pattern supports claude-local, codex-local, openclaw-webhook, and process backends.
- Task session persistence enables workers to resume context when re-invoked on the same task.
- CTO and worker memory persists across sessions via `.ade/cto/` and `.ade/agents/` directories.
- Automations tab provides trigger-driven workflows, template-driven setup, executor routing, and Night Shift scheduling with subscription-aware guardrails.
- Morning Briefing provides a swipeable card interface for reviewing overnight results.
- Memory retrieval uses composite scoring, with embedding-backed/BM25 hybrid retrieval remaining optional future work rather than a baseline requirement.
- Pre-compaction flush prevents memory loss during context compaction.
- Memory consolidation prevents unbounded growth via real-time deduplication on save.
- Episodic memories are generated after session/mission completion.
- Procedural memories are extracted from recurring episodic patterns.
- Learning packs accumulate project knowledge with confidence scoring and scope matching.
- ADE agents can consume external MCP servers for extended capabilities.
- OpenClaw bridge provides bidirectional communication between ADE CTO and external agent gateways.
- `.ade/` directory provides portable state across machines — git tracks config, cr-sqlite (Phase 6) syncs app state.

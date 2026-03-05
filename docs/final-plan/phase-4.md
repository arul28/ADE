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

Workstreams are numbered in dependency order. Hand them to agents sequentially — or in parallel where noted.

```
Wave 1 (start day 1, parallel):
  W1: CTO Agent Core                  ← org foundation
  W6: Memory Architecture Upgrade     ← knowledge foundation
  W8: External MCP Consumption        ← independent infra

Wave 2 (parallel, after W1):
  W2: Worker Agents & Org Chart       ← needs W1
  W3: Heartbeat & Activation          ← needs W1
  W5: Night Shift Mode                ← needs W1

Wave 3 (parallel, after their deps):
  W4: Bidirectional Linear Sync       ← needs W2, W3
  W7: Learning Packs                  ← needs W6
  W9: OpenClaw Bridge                 ← needs W1, W8
  W10: .ade/ Portable State           ← needs W1, W6
```

Dependency graph:
```
W1 (CTO Core) ──→ W2 (Workers) ──┐
     │                             ├──→ W4 (Linear Sync)
     ├──→ W3 (Heartbeat) ─────────┘
     │
     ├──→ W5 (Night Shift)
     │
     └──→ W9 (OpenClaw) ←── W8 (External MCP)

W6 (Memory) ──→ W7 (Learning Packs)
     │
     └──→ W10 (.ade/ State) ←── W1
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
- **CtoPage sidebar**: Core memory inspector (view + inline edit via `updateCoreMemory` IPC) and session history panel (collapsible, pulls from `getState`) added. Capability badge only shown after session is established.
- **Deferred to W2**: worker persistence/runtime, worker org editing, worker acceptance tests, CTO model/identity settings UI (`ctoUpdateIdentity` IPC not yet built — model preferences live in `identity.yaml` and are only configurable by editing the file directly; W2 config editor will expose this).

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
- CtoPage redesigned with industrial shell theme: org chart sidebar (320px) with CTO card, worker tree with status dots and depth indentation, inline worker editor (hire/edit), budget summary, config revision history with rollback, worker core memory inspector and session logs.

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

**Tests:**
- Candidate issue polling across multiple projects, priority sorting (ascending), blocked-by filtering (skip Todo with non-terminal blockers), routing by label/defaultWorker with CTO fallback.
- Auto-dispatch with template matching, escalation for unmatched issues, concurrency limit enforcement (global and per-state), optional assignee setting on dispatch.
- Linear outbound: state update on mission start/complete/fail, workpad comment creation and update, PR link posting, label addition.
- Reconciliation: external close → mission cancel, external reassign → worker release, stall detection → restart.
- Mission template: loading from `.ade/templates/`, variable rendering with issue context, template selection by CTO classification.
- Retry: exponential backoff on failure, short continuation retry on normal completion (consistent with Symphony §8.4).
- Flow composer UI: policy validation and simulation, versioned history, and readable diff before activation.

#### W5: Night Shift Mode (in Automations)

Night Shift becomes a mode within the existing Automations tab, not a separate agent type or tab.

- **Night Shift as an Automations mode**:
  - The Automations tab gains a "Night Shift" section alongside existing automation rules.
  - Night Shift queues missions and tasks for unattended overnight execution.
  - Users configure: what tasks to run overnight, which models to use, budget caps, and stop conditions.

- **Night Shift configuration**:
  ```
  +------------------------------------------------------------------+
  | AUTOMATIONS                                                        |
  | [Rules] [Night Shift]                                              |
  +------------------------------------------------------------------+
  | NIGHT SHIFT                                           [CONFIGURE]  |
  |                                                                    |
  | Schedule: 11:00 PM - 6:00 AM (Mon-Fri)                            |
  | Mode: Conservative (60% capacity)                                  |
  | Weekly reserve: 20%                                                |
  |                                                                    |
  | QUEUED TASKS                                           [+ ADD]     |
  | 1. Refactor auth module          Claude Sonnet  Budget: $2         |
  | 2. Update test coverage          Claude Haiku   Budget: $1         |
  | 3. Harden API endpoints          Codex          Budget: $3         |
  |                                                                    |
  | SUBSCRIPTION STATUS                                                |
  | Claude: Pro tier | Available tonight: ~3.2 hrs                     |
  | [████████░░░░] 65% of capacity allocated                           |
  +------------------------------------------------------------------+
  ```

- **Smart token budget management**:
  - **Utilization modes** (user-selectable):
    - `maximize`: Use all available capacity before the next reset window.
    - `conservative` (default): Use up to a user-defined percentage of remaining capacity (default: 60%).
    - `fixed`: Ignore subscription utilization — run with fixed per-task budgets.
  - **Rate limit awareness**: Before starting each task, check current rate limit state. If a reset is due during the night, schedule a second batch after the reset.
  - **Weekly reserve protection**: Users set a reserve (default: 20% of weekly budget) that Night Shift will not consume.

- **Strict guardrails**:
  - Per-task budget caps (tokens, time, steps, USD).
  - Global Night Shift budget cap (applies on top of per-task caps).
  - Stop conditions: `first-failure`, `budget-exhaustion`, `intervention-threshold` (park if N intervention requests), `rate-limited`, `reserve-protected`.
  - Risk restrictions: Night Shift tasks run with conservative permissions by default.

- **Morning Briefing sub-view**: Swipeable card interface for reviewing overnight results.
  ```
  +------------------------------------------------------------------+
  | MORNING BRIEFING                    . . . o o  (3/5 reviewed)     |
  +------------------------------------------------------------------+
  |  NIGHT SHIFT - Refactor Auth Module                                |
  |                                                                    |
  |  STATUS: SUCCEEDED                                                 |
  |  Model: Claude Sonnet · 12 steps · $1.84                          |
  |                                                                    |
  |  WHAT HAPPENED:                                                    |
  |  Extracted auth middleware into dedicated module,                   |
  |  added refresh token rotation, updated 8 test files.               |
  |  All 142 tests passing.                                            |
  |                                                                    |
  |  CHANGES: +347 -128 across 12 files                                |
  |  [View Diff]  [View PR #47]                                        |
  |                                                                    |
  |  CONFIDENCE: ████████░░ 82%                                        |
  |                                                                    |
  |  [APPROVE]    [DISMISS]    [INVESTIGATE LATER]                     |
  +------------------------------------------------------------------+
  | [BULK APPROVE ALL (3)]                    [SKIP TO SUMMARY]        |
  +------------------------------------------------------------------+
  ```

  - **Card types**: Succeeded (diff stats, PR link, confidence, test results) and Failed/Parked (failure reason, partial changes, error context).
  - **Interaction**: Swipe right = approve, left = dismiss, up = investigate later. Keyboard shortcuts: Right/Left/Up arrows, Space = expand.
  - **Trigger**: Modal overlay on app launch after Night Shift completes. Also accessible from Automations tab.

- **Night Shift service** (`nightShiftService`):
  - Manages the Night Shift queue and executes tasks via the mission orchestrator with Night Shift-specific guardrails.
  - Generates a structured digest artifact at the end of each session:
    ```typescript
    interface NightShiftDigest {
      id: string;
      generatedAt: string;
      sessionId: string;
      tasks: NightShiftTaskEntry[];
      totalBudgetUsed: BudgetSummary;
      subscriptionUtilization: {
        claude?: { tier: string; tokensUsedOvernight: number; capacityUtilized: number; tasksSkippedDueToLimits: number; };
        codex?: { tier: string; tokensUsedOvernight: number; capacityUtilized: number; };
        weeklyReserveRemaining: number;
      };
      pendingReviews: number;
      requiresAttention: number;
    }
    ```

- **Settings integration** (Automations → Night Shift section):
  - Default time window, morning briefing delivery time, global budget cap.
  - Utilization mode selector, conservative mode percentage slider, weekly reserve slider.
  - Multi-batch scheduling toggle, subscription status panel.

- **Renderer**: Night Shift tab within Automations, task queue UI, Morning Briefing modal overlay, subscription status panel.

**Tests:**
- Stop conditions: first-failure, budget-exhaustion, intervention-threshold, rate-limited, reserve-protected.
- Subscription-aware scheduling: utilization modes, rate limit awareness, weekly reserve protection.
- Multi-batch scheduling across rate limit resets.
- Morning briefing card rendering and interaction (approve/dismiss/investigate).
- Bulk action tests.
- Digest generation accuracy.

#### W6: Memory Architecture Upgrade

> Source: Three-tier memory from [OpenClaw](https://github.com/openclaw/openclaw) (MEMORY.md + daily logs). Pre-compaction flush from OpenClaw. Composite scoring from [CrewAI](https://github.com/crewAI/crewAI). Consolidation from [Mem0](https://github.com/mem0ai/mem0). Hybrid search from OpenClaw + RAG literature. Episodic/procedural memory from [LangMem](https://github.com/langchain-ai/langmem).

A comprehensive upgrade to ADE's memory system, introducing tiered storage, vector search, composite scoring, pre-compaction flushing, memory consolidation, episodic memory, and procedural memory. These capabilities serve both mission workers and the CTO agent.

##### Carry-Over Scope: Candidate Memory Triage Automation

To absorb the remaining near-term memory gap into Phase 4 (instead of shipping a separate patch), W6 explicitly includes candidate-memory lifecycle automation:

- Add a candidate sweep path that runs at safe checkpoints (app startup, run finalization, optional periodic timer):
  - promote `candidate` entries with `confidence >= auto_promote_threshold`,
  - archive stale `candidate` entries older than `max_candidate_age_hours`.
- Keep manual user controls unchanged (review/promote/archive from existing candidate panel).
- Align runtime config typing/validation with documented memory policy keys.

##### Three-Tier Memory

```
Tier 1: Core Memory (always in context, ~2-4K tokens)
  - Agent persona block (identity, role)
  - Current task context (what am I working on)
  - Critical project conventions
  - Self-editable via memoryUpdateCore tool

Tier 2: Hot Memory (retrieved on demand via hybrid search)
  - Recent episodic memories
  - Relevant semantic memories (facts, patterns, decisions)
  - Mission shared facts
  - Retrieved via composite scoring

Tier 3: Cold Memory (archival, searched rarely)
  - Old episodic memories
  - Low-importance facts
  - Archived/superseded memories
  - Stored in .ade/memory/archive/
```

##### Vector Search with sqlite-vec

- Add `sqlite-vec` extension to the existing SQLite database.
- Store embeddings alongside memory records in a `memory_vectors` table.
- Hybrid search: BM25 keyword (30% weight) + vector similarity (70% weight).
- **MMR re-ranking**: Maximal Marginal Relevance with lambda=0.7 to reduce redundant results.
- Embedding model: local `all-MiniLM-L6-v2` GGUF (~25MB, 384 dimensions) for offline operation, `text-embedding-3-small` (1536 dimensions) as online fallback. Retrieval pipeline normalizes across both dimension sizes.
- **Scalability**: sqlite-vec uses brute-force KNN — performant up to ~100K vectors, sufficient for per-project memory. Cold archival keeps active vector count manageable.
- Cache embeddings in `.ade/embeddings.db` (gitignored, regenerated in ~30s background job on first startup).
- Budget tiers for context injection: **Lite (3 entries)** for quick tasks, **Standard (8 entries)** for normal work, **Deep (20 entries)** for mission planning.

##### Mem0 Sidecar Decision (Deferred)

Mem0 remains a candidate integration as an optional semantic sidecar. Phase 4 does **not** depend on Mem0. Revisit after Phase 4 memory baseline + CTO rollout stabilizes.

##### Composite Scoring for Retrieval

```typescript
function computeMemoryScore(memory: Memory, semanticSimilarity: number): number {
  const ageDays = daysSince(memory.lastAccessedAt);
  const recencyScore = Math.pow(0.5, ageDays / 30); // 30-day half-life
  const importanceScore = { high: 1.0, medium: 0.6, low: 0.3 }[memory.importance];
  const accessBoost = Math.min(memory.accessCount / 10, 1.0);

  return (0.5 * semanticSimilarity) +
         (0.2 * recencyScore) +
         (0.2 * importanceScore) +
         (0.1 * accessBoost);
}
```

##### Pre-Compaction Memory Flush

- Before context compaction (at 70% threshold, shipped in Hivemind HW6), trigger a silent agentic turn.
- Agent is prompted to persist important memories to disk before context is lost.
- Uses agent's own intelligence to decide what matters — reviews current context and calls memory tools.
- Flush counter prevents double-flushing: each compaction event gets a monotonic ID, flush skipped if current ID already flushed.
- Integrates with existing `compactionEngine.ts` via a pre-compaction hook.

##### Memory Write Policy

- **Always write**: durable architectural decisions, stable conventions, high-signal gotchas, repeatable procedures.
- **Candidate first**: uncertain observations, plan assumptions, risks pending validation.
- **Do not write**: transient tool noise, one-off logs, stale intermediate reasoning.
- Candidate memories promoted via confidence + review flow; low-value/aged entries archived.

##### Memory Consolidation

- On save, compare new memory against existing memories using cosine similarity (threshold > 0.85).
- If similar memory found, invoke LLM to decide:
  - **PASS**: New memory is redundant — discard silently.
  - **REPLACE**: New supersedes existing — update.
  - **APPEND**: Both unique — merge into single richer memory.
  - **DELETE**: Existing obsolete — remove old, save new.
- Runs on save, not as batch job. Prevents unbounded growth.

##### Episodic Memory

After each session/mission, generate a structured summary:

```typescript
interface EpisodicMemory {
  id: string;
  sessionId?: string;
  missionId?: string;
  taskDescription: string;
  approachTaken: string;
  outcome: 'success' | 'partial' | 'failure';
  toolsUsed: string[];
  patternsDiscovered: string[];
  gotchas: string[];
  decisionsMade: string[];
  duration: number;
  createdAt: string;
}
```

Stored as Tier 2 initially, decay to Tier 3 over time based on access patterns.

##### Human Work Ingestion (User-Only Changes)

Users frequently change code/config/Linear state outside agent runs. Without ingestion, workers and the CTO will make decisions on stale assumptions. Phase 4 should explicitly capture and distribute "what changed" when the human user works solo.

- **Project snapshot tracking**:
  - Track `lastSeenHeadSha` and a lightweight working-tree fingerprint per agent and per project.
  - Use this to gate dispatch and detect when a worker's understanding is stale.

- **Change digest triggers**:
  - App startup (first run after a repo change).
  - Before dispatching a mission when HEAD changed since the last digest.
  - Explicit user action ("Sync knowledge").
  - On PR merge / branch switch (best-effort, derived from git + lane events).

- **Digest contents** (noise-controlled; no raw diffs):
  - Commit range summary (`git log --oneline`), diffstat (`git diff --stat`), changed file list.
  - Semantic clustering of changed files (e.g., auth, billing, mobile) for routing to the right worker.
  - Optional issue linkage heuristics (commit message mentions `ABC-123`, branch naming, PR title).

- **Write + distribution policy**:
  - Write digest as a Tier 2 memory entry (category: `project-change-digest`) owned by the CTO.
  - Optionally notify relevant workers (project owner + anyone whose path/label routing matches the change cluster) so their next run starts with fresh context.

##### Procedural Memory

```typescript
interface ProceduralMemory {
  id: string;
  trigger: string;       // When to apply
  procedure: string;     // What to do
  confidence: number;    // 0-1, increases with successful applications
  successCount: number;
  failureCount: number;
  lastUsed: string;
}
```

Extracted from episodic memories when a pattern is observed multiple times. Encode learned workflows applied automatically when trigger conditions match.

##### New Memory Tools for Agents

- **`memorySearch`** — Hybrid BM25+vector search, ranked by composite score.
- **`memoryAdd`** — With consolidation check on save.
- **`memoryUpdateCore`** — Self-edit Tier 1 working context.
- **`memoryPin`** — Pin a critical memory to Tier 1 (always in context, bypasses retrieval scoring).

**Tests:**
- Vector search accuracy: hybrid BM25+vector vs keyword-only retrieval quality.
- Pre-compaction flush: memories persisted before compaction, flush counter prevents double-flush.
- Memory consolidation: PASS/REPLACE/APPEND/DELETE operations with cosine similarity threshold.
- Episodic memory extraction: post-session and post-mission summaries with correct structure.
- Procedural memory extraction: pattern detection from repeated episodic memories.
- Composite scoring: recency decay with 30-day half-life, importance weighting, access boost capping.
- Memory tier promotion/demotion: Tier 2 → Tier 3 decay, Tier 2 → Tier 1 pinning.
- Candidate sweep: auto-promote at confidence threshold, archive stale candidates.
- Human work ingestion: snapshot divergence triggers digest creation, digest stored as Tier 2 memory, relevant workers notified, digests are noise-controlled (no raw diffs).

#### W7: Learning Packs (Auto-Curated Project Knowledge)

A context pack type that automatically accumulates project-specific knowledge from agent interactions. Learning packs feed into the memory system (W6) as high-confidence project-scope entries.

- New pack type: `LearningPack` alongside existing Lane/Project/Mission/Feature packs.
- **Knowledge sources** (automatic):
  - Mission/agent run failures and their resolutions.
  - User interventions during agent work (what the user corrected → inferred rule).
  - Repeated issues across agent chat sessions (same error 3+ times → recorded pattern).
  - PR review feedback patterns (reviewer consistently requests X → recorded preference).
- **Knowledge entries**:
  ```typescript
  interface LearningEntry {
    id: string;
    category: 'mistake-pattern' | 'preference' | 'flaky-test' | 'tool-usage' | 'architecture-rule';
    scope: 'global' | 'directory' | 'file-pattern';
    scopePattern?: string;           // e.g., "src/auth/**"
    content: string;                 // Human-readable rule
    confidence: number;              // 0-1
    observationCount: number;
    sources: string[];               // IDs of contributing missions/sessions
    createdAt: string;
    updatedAt: string;
  }
  ```
- **Injection**: High-confidence entries (confidence > 0.7) always included in orchestrator context; low-confidence entries included when scope matches current task.
- **User review**: Entries visible and editable in Settings → Learning. User confirmation boosts confidence.
- **Export/import**: Learning packs exportable to/from CLAUDE.md or agents.md format.
- **Storage**: New `learning_entries` SQLite table with full-text search.
- **Privacy**: Local-only (never transmitted). Travels with project directory.

##### Carry-Over Scope: Skill Library

- **Phase 4 baseline**: Read-only visibility for agent commands/skills files (aligned with PROJ-039).
- **Recipe candidate extraction**: Derive candidate "how-to" recipes from repeated successful missions/interventions (stored as reviewable learning entries first).
- **User-approved materialization**: Confirmed recipe candidates exportable to `.claude/skills/<name>/SKILL.md`.
- **Separation**: Memory entries = "what is true" (facts/decisions); Skill recipes = "how to do it" (workflows).

- **Renderer**: Learning entries panel in Settings. Confidence indicators. Scope badges. Export/import buttons.

**Tests:**
- Entry accumulation: auto-capture from failures, interventions, repeated issues.
- Confidence scoring: observation count → confidence increase, user confirmation boost.
- Injection: high-confidence always included, scope-matched low-confidence included.
- Export/import roundtrip: CLAUDE.md format, agents.md format.

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
- Night Shift mode in Automations tab provides overnight execution with subscription-aware scheduling and guardrails.
- Morning Briefing provides a swipeable card interface for reviewing overnight results.
- Memory retrieval uses hybrid BM25+vector search with composite scoring.
- Pre-compaction flush prevents memory loss during context compaction.
- Memory consolidation prevents unbounded growth via real-time deduplication on save.
- Episodic memories are generated after session/mission completion.
- Procedural memories are extracted from recurring episodic patterns.
- Learning packs accumulate project knowledge with confidence scoring and scope matching.
- ADE agents can consume external MCP servers for extended capabilities.
- OpenClaw bridge provides bidirectional communication between ADE CTO and external agent gateways.
- `.ade/` directory provides portable state across machines — git tracks config, cr-sqlite (Phase 6) syncs app state.

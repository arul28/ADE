# Phase 4: CTO + Ecosystem

## Phase 4 -- CTO + Ecosystem (4-5 weeks)

Goal: Add the CTO agent as a persistent project-aware assistant. Absorb Night Shift into Automations. Complete the memory architecture upgrade. Expand external ecosystem integration.

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

### Workstreams

#### W1: CTO Agent + Org System

A new tab providing a persistent, project-aware AI org chart — the CTO agent sits at the top, with configurable worker agents underneath (Backend Dev, Mobile Dev, QA, etc.). Users can talk directly to the CTO or any worker. All agents share the three-tier memory model, have full ADE knowledge, and can be configured to autonomously process work from external issue trackers.

> **Prior art**: This design draws from [Paperclip](https://github.com/paperclipai/paperclip) (org chart, heartbeat, task sessions, budget auto-pause, multi-adapter, config versioning), [Symphony](https://github.com/openai/symphony) (Linear polling, per-state concurrency, reconciliation, stall detection, WORKFLOW.md), and [OpenClaw](https://github.com/openclaw/openclaw) (three-tier memory, HEARTBEAT.md, SOUL.md identity, pre-compaction flush, two-tier execution).

##### W1a: CTO Agent (Core)

- **New tab: CTO** (may rename to "Org" based on UX testing):
  - Added to the main tab bar alongside existing tabs (Lanes, Missions, PRs, etc.).
  - Icon: `brain` (Lucide icon) or similar representing strategic/technical intelligence.
  - The tab provides a persistent chat interface with a sidebar showing the org chart and worker list.
  - Clicking the CTO or any worker in the sidebar opens a direct chat with that agent.

- **Core concept**:
  - The CTO is not a one-shot Q&A bot — it is a persistent entity that remembers the project, its history, its patterns, and the user's preferences across sessions.
  - It has access to all ADE capabilities via MCP tools: create missions, spin up lanes, check project state, review PR status, query mission history, examine code.
  - It provides strategic guidance: architecture decisions, code review, refactoring suggestions, dependency management, security considerations.
  - It can take autonomous action when appropriate: "I noticed the auth module tests are flaky — I'll create a mission to investigate" (with user confirmation).
  - It manages worker agents: creates them, assigns work, monitors their progress, adjusts their configurations over time.

- **Three-tier memory model** (shared with W3, applies to CTO and all workers):
  - **Tier 1 — Core Memory**: Always in context (~2-4K tokens). Agent persona, current project context, critical conventions, user preferences. Self-editable via `memoryUpdateCore` tool.
  - **Tier 2 — Hot Memory**: Retrieved on demand via hybrid search. Recent conversations, relevant project facts, mission outcomes, decision history.
  - **Tier 3 — Cold Memory**: Archival. Old conversations, historical decisions, deprecated patterns.
  - Auto-compaction with temporal decay (30-day half-life) moves memories from hot to cold.

- **Identity persistence**:
  - CTO state is stored in `.ade/cto/` directory; worker state in `.ade/agents/<name>/`:
    ```
    .ade/
    ├── cto/
    │   ├── identity.yaml        # CTO persona, model preferences, policy config
    │   ├── core-memory.json     # Tier 1: always-in-context persona and project context
    │   ├── memory/              # Tier 2: hot memories + archive/
    │   └── sessions.jsonl       # Session history log (append-only)
    ├── agents/
    │   ├── backend-dev/
    │   │   ├── identity.yaml    # Worker persona, adapter config, heartbeat policy
    │   │   ├── core-memory.json # Worker's Tier 1 core memory
    │   │   ├── memory/          # Worker's Tier 2 + archive
    │   │   └── sessions.jsonl   # Worker session log
    │   ├── mobile-dev/
    │   │   └── ...
    │   └── qa-engineer/
    │       └── ...
    ```
  - Core memory persists across sessions — when the user opens any agent chat, the agent reconstructs context from stored memory rather than starting fresh.
  - Session history log tracks conversation summaries for long-term continuity.

- **ADE capabilities via MCP tools**:
  - CTO and all workers have access to the full ADE MCP tool set (same tools exposed by `apps/mcp-server`).
  - They can: create missions, query mission status, list lanes, check PR health, read files, search code, check conflict status, query usage metrics.
  - They can also use external MCP tools (W5) if configured.
  - Tool access is governed by the same permission model as mission workers.

- **"Always-on" feel**:
  - Smart memory tracking: agents remember what was discussed, what decisions were made, what the user's preferences are.
  - Context compaction: when conversation grows long, agents use pre-compaction flush (W3) to persist important context before compaction.
  - Auto-refactoring of memory: agents periodically consolidate memories (W3 consolidation) to keep knowledge base clean and non-redundant.
  - Agents are not continuously running model processes — they reconstruct context from stored memory on each session start or heartbeat activation.

##### W1b: Worker Agents & Org Chart

Configurable worker agents that sit under the CTO in an org hierarchy. Each worker is a persistent agent with its own identity, memory, capabilities, and budget.

- **Agent identity schema** (inspired by Paperclip's agent model):
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
      heartbeat?: HeartbeatPolicy;   // Activation schedule (see W1c)
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
  - Cycle detection prevents circular reporting chains (max 50 hops, same as Paperclip).
  - Visual org chart in the sidebar:
    ```
    CTO (brain)
    ├── Backend Dev (claude-local, idle)
    ├── Mobile Dev (openclaw-webhook, idle)
    └── QA Engineer (claude-local, paused - budget)
    ```
  - Chain-of-command traversal: any worker can escalate to its manager, up to CTO.

- **Multi-adapter pattern** (from Paperclip):
  - Same `AgentIdentity` interface, different execution backends:
    - `claude-local`: Spawns Claude Code CLI with model/cwd/instructions. Best for code-focused workers.
    - `codex-local`: Spawns Codex CLI via app-server protocol. Best for OpenAI-native workflows.
    - `openclaw-webhook`: HTTP POST to a remote OpenClaw agent endpoint. For workers running on external infrastructure.
    - `process`: Generic subprocess with custom command. For specialized tools.
  - Adapter config holds backend-specific settings (model, CLI args, webhook URL, timeout, etc.).
  - Workers are hot-swappable — change a worker's adapter type without losing its identity or memory.

- **Config versioning** (from Paperclip):
  - Every change to an agent's identity/config creates a revision with before/after snapshots.
  - Changed fields tracked explicitly (name, role, adapterType, capabilities, budget, etc.).
  - Rollback: revert to a previous revision. Redacted-secret protection prevents rollback to revisions where secrets were scrubbed.
  - Useful for learning: "I changed the QA engineer's prompt on March 3 because it missed accessibility checks — and it worked."

- **Budget auto-pause** (from Paperclip):
  - Each worker has a `budgetMonthlyCents` ceiling. When `spentMonthlyCents >= budgetMonthlyCents`, the worker auto-pauses.
  - CTO notifies the user: "QA Engineer hit its $30 monthly budget. Paused. Want me to increase it?"
  - Company-level budget cap across all workers.
  - Cost events recorded per-run with provider/model/token attribution.

- **Task session persistence** (from Paperclip):
  - Per-task session state survives across agent invocations, keyed by `(agentId, adapterType, taskKey)`.
  - When a worker stops and restarts on the same issue, it resumes with session context (thread ID, conversation state, workspace path).
  - Bridges the gap between stateless agent runs and persistent memory — session state is hot context for a specific task, memory is long-term knowledge.
  - Sessions are stored in the agent's `.ade/agents/<name>/sessions.jsonl`.

- **Direct conversation**:
  - Users can chat with any worker directly from the CTO tab sidebar.
  - Workers have full project context via their memory tiers + ADE MCP tools.
  - CTO is not a bottleneck — users bypass it for quick asks to specific workers.
  - Inter-agent messaging (already shipped in Phase 3) enables CTO ↔ worker communication during missions.

##### W1c: Heartbeat & Activation System

A configurable activation system that determines when and how agents wake up. Combines Paperclip's heartbeat scheduling with OpenClaw's two-tier execution model.

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

- **Two-tier execution model** (from OpenClaw):
  - **Cheap checks first**: On each heartbeat, run fast deterministic checks — is there new work in the issue tracker? Did a mission finish? Are there pending interventions? This costs zero LLM tokens.
  - **LLM escalation**: Only invoke the agent's model when something meaningful needs attention. "5 new Linear issues since last check" triggers the CTO to classify and dispatch. "No changes" → skip.
  - **HEARTBEAT_OK suppression** (from OpenClaw): If the agent determines nothing needs attention, it returns a `HEARTBEAT_OK` signal. No notification is sent to the user. Prevents notification spam.

- **Wakeup coalescing** (from Paperclip):
  - If a wakeup arrives while the agent is already running on the same task, merge the new context into the active run instead of spawning a duplicate.
  - Example: 3 Linear updates to the same issue within 30 seconds → only 1 agent invocation with all 3 updates merged.
  - **Deferred promotion**: If the agent is busy on a different task, the wakeup is queued as `deferred`. When the current run finishes, the oldest deferred wakeup auto-promotes to the front of the queue.

- **Issue execution locking** (from Paperclip):
  - Only one agent run per issue at a time. When a worker claims an issue, it's atomically locked (`executionRunId` + `executionLockedAt`).
  - **Stale adoption**: If a run crashes, another run can adopt the orphaned issue instead of it being stuck forever.
  - **Orphan reaping**: On app restart, detect runs that are "queued" or "running" but have no corresponding process. Mark them failed, release locks, promote deferred wakeups.

- **Default heartbeat configurations**:
  | Agent | intervalSec | wakeOnDemand | Active Hours |
  |-------|-------------|--------------|--------------|
  | CTO | 300 (5 min) | yes | User-configured |
  | Workers | 0 (no timer) | yes | Follows CTO |

  - CTO heartbeats periodically to check Linear/GitHub for new work and monitor running missions.
  - Workers default to wake-on-demand only — CTO wakes them when it assigns work.
  - Users can override any agent's heartbeat policy.

##### W1d: Bidirectional Linear Sync

The CTO agent watches a Linear project board and autonomously dispatches missions from issues. Results flow back to Linear as state updates, comments, and proof of work.

- **Inbound: Linear → ADE** (inspired by Symphony's polling + Paperclip's issue checkout):
  1. **CTO heartbeat fires** → cheap check: query Linear for issues in active states (`Todo`, `In Progress`).
  2. **Candidate filtering**: Sort by priority (ascending) → `created_at` (oldest first) → identifier. Skip issues blocked by non-terminal blockers (from Symphony).
  3. **Classification**: CTO uses its memory + project knowledge to classify each issue: bug fix? feature? refactor? Which worker should handle it?
  4. **Concurrency check**: Respect per-state concurrency limits (from Symphony): `max_concurrent_by_state: { todo: 5, in_progress: 3, bug: 2 }`.
  5. **Auto-dispatch or escalate**: Based on auto-dispatch policy (see below), either create a mission automatically or surface the issue to the user for approval.
  6. **Atomic checkout**: When dispatching, atomically lock the issue in ADE (prevents duplicate work). Move Linear issue to `In Progress`.

- **Outbound: ADE → Linear** (inspired by Symphony's workpad pattern):
  - When a mission starts: move Linear issue to `In Progress`, post a "Workpad" comment with planned approach.
  - During execution: update the workpad comment with progress checklist (single persistent comment, not multiple — from Symphony's workpad pattern).
  - When PR is created: post PR link to Linear issue, add `ade` label.
  - When mission completes: move issue to `Done` (or `In Review` if PR needs human review), post final summary with diff stats, test results, and proof of work.
  - When mission fails: post failure context to Linear, move to `Blocked` or keep in `In Progress` for retry.

- **Reconciliation** (from Symphony):
  - On every CTO heartbeat, validate running missions against current Linear state:
    - Issue moved to `Done` externally → cancel the ADE mission.
    - Issue moved to `Cancelled` → cancel and clean up.
    - Issue reassigned → release the worker, update mission.
    - Issue still active → refresh snapshot, continue.

- **Auto-dispatch policies** (user-configured):
  ```yaml
  # .ade/local.yaml
  linearSync:
    enabled: true
    projectSlug: my-project
    pollingIntervalSec: 300        # CTO heartbeat interval for Linear checks
    autoDispatch:
      rules:
        - match: { labels: ["bug"], priority: ["urgent", "high"] }
          action: auto              # Create mission immediately
          worker: backend-dev       # Route to specific worker (optional)
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

- **Mission templates** (from Symphony's WORKFLOW.md, but richer):
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
  - Users can create custom templates in Settings → Mission Templates.

- **Tracker abstraction** (from Symphony):
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
  - Memory tracker for tests (from Symphony's in-memory tracker pattern).

- **Configuration**: Linear API key and project slug stored in `.ade/local.secret.yaml` (gitignored). Poll interval and dispatch rules in `.ade/local.yaml` (git-tracked, no secrets).

- **Dependency**: W5 (External MCP Consumption) provides the Linear MCP tools. W1d uses these tools for the polling/update loop. Alternatively, ADE can ship a lightweight built-in Linear GraphQL client (simpler, no MCP overhead for the core polling loop) and reserve MCP for ad-hoc Linear queries from agents.

#### W2: Night Shift Mode (in Automations)

Night Shift becomes a mode within the existing Automations tab, not a separate agent type or tab.

- **Night Shift as an Automations mode**:
  - The Automations tab gains a "Night Shift" section alongside existing automation rules.
  - Night Shift is a way to queue missions and tasks for unattended overnight execution.
  - Users configure: what tasks to run overnight, which models to use, budget caps, and stop conditions.

- **Night Shift configuration**:
  ```
  +------------------------------------------------------------------+
  | AUTOMATIONS                                                        |
  | [Rules] [Night Shift]                                              |
  +------------------------------------------------------------------+
  | NIGHT SHIFT                                           [CONFIGURE]  |
  |                                                                    |
  | Schedule: 11:00 PM – 6:00 AM (Mon-Fri)                           |
  | Mode: Conservative (60% capacity)                                  |
  | Weekly reserve: 20%                                                |
  |                                                                    |
  | QUEUED TASKS                                           [+ ADD]    |
  | ┌──────────────────────────────────────────────────────────────┐  |
  | │ 1. Refactor auth module          Claude Sonnet  Budget: $2   │  |
  | │ 2. Update test coverage          Claude Haiku   Budget: $1   │  |
  | │ 3. Harden API endpoints          Codex          Budget: $3   │  |
  | └──────────────────────────────────────────────────────────────┘  |
  |                                                                    |
  | SUBSCRIPTION STATUS                                                |
  | Claude: Pro tier | Available tonight: ~3.2 hrs                    |
  | [████████░░░░] 65% of capacity allocated                          |
  +------------------------------------------------------------------+
  ```

- **Smart token budget management**:
  - Night Shift monitors subscription utilization via rate limit headers and usage tracking.
  - **Utilization modes** (user-selectable):
    - `maximize`: Use all available capacity before the next reset window.
    - `conservative`: Use up to a user-defined percentage of remaining capacity (default: 60%). This is the default.
    - `fixed`: Ignore subscription utilization — run with fixed per-task budgets.
  - **Rate limit awareness**: Before starting each task, check current rate limit state. If a reset is due during the night, schedule a second batch after the reset.
  - **Weekly reserve protection**: Users set a reserve (default: 20% of weekly budget) that Night Shift will not consume, preserving capacity for daytime use.

- **Strict guardrails**:
  - Per-task budget caps (tokens, time, steps, USD).
  - Global Night Shift budget cap (applies on top of per-task caps).
  - Stop conditions: `first-failure` (park the task, don't retry), `budget-exhaustion`, `intervention-threshold` (park if N intervention requests — nobody is there to respond), `rate-limited` (pause and wait for reset or skip), `reserve-protected` (stop to protect weekly reserve).
  - Risk restrictions: Night Shift tasks run with conservative permissions by default.

- **Morning Briefing sub-view**:
  A swipeable card interface for reviewing overnight results.
  ```
  +------------------------------------------------------------------+
  | MORNING BRIEFING                    ● ● ● ○ ○  (3/5 reviewed)   |
  +------------------------------------------------------------------+
  |                                                                    |
  |  ┌────────────────────────────────────────────────────────────┐  |
  |  │                                                            │  |
  |  │  NIGHT SHIFT — Refactor Auth Module                        │  |
  |  │                                                            │  |
  |  │  STATUS: SUCCEEDED                                         │  |
  |  │  Model: Claude Sonnet · 12 steps · $1.84                   │  |
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

  - **Card types**:
    - **Succeeded Task**: Shows what changed, diff stats, PR link, confidence, test results. Actions: Approve (merge PR) / Dismiss (close PR) / Investigate Later.
    - **Failed/Parked Task**: Shows failure reason, last step, partial changes, error context. Actions: Retry / Dismiss / Investigate Later.

  - **Interaction model**:
    - **Swipe right** (or click Approve): Execute the approval action.
    - **Swipe left** (or click Dismiss): Dismiss, log the decision.
    - **Swipe up** (or click Investigate Later): Move to an "investigate" queue.
    - **Keyboard shortcuts**: Right arrow = approve, Left arrow = dismiss, Up arrow = investigate, Space = expand details.
    - **Progress indicator**: Dots at top showing total items and reviewed count.
    - **Bulk actions**: "Approve All" for high-confidence items.

  - **Morning Briefing trigger**:
    - Automatically shown as a modal overlay when user opens ADE after Night Shift tasks have completed.
    - Also accessible on-demand from the Automations tab → Night Shift section.
    - Badge count on the Automations tab icon shows pending briefing items.

- **Night Shift service** (`nightShiftService`):
  - Manages the Night Shift queue: users queue tasks for after-hours execution.
  - Executes tasks via the mission orchestrator with Night Shift-specific guardrails.
  - Tracks subscription utilization and rate limits across providers.
  - Generates a structured digest artifact at the end of each Night Shift session:
    ```typescript
    interface NightShiftDigest {
      id: string;
      generatedAt: string;
      sessionId: string;
      tasks: NightShiftTaskEntry[];
      totalBudgetUsed: BudgetSummary;
      subscriptionUtilization: {
        claude?: {
          tier: string;
          tokensUsedOvernight: number;
          tokensAvailableAtStart: number;
          rateLimitResetsHit: number;
          capacityUtilized: number;    // 0.0-1.0
          tasksSkippedDueToLimits: number;
        };
        codex?: {
          tier: string;
          tokensUsedOvernight: number;
          tokensAvailableAtStart: number;
          capacityUtilized: number;
          tasksSkippedDueToLimits: number;
        };
        weeklyReserveRemaining: number;
      };
      pendingReviews: number;
      requiresAttention: number;
    }

    interface NightShiftTaskEntry {
      taskId: string;
      taskName: string;
      status: 'succeeded' | 'failed' | 'parked' | 'budget-exhausted' | 'rate-limited' | 'skipped';
      summary: string;
      changesProposed?: ChangeSet[];
      prCreated?: string;
      failureContext?: FailureContext;
      budgetUsed: BudgetSummary;
      skipReason?: string;
    }
    ```

- **Settings integration** (Automations → Night Shift section in Settings):
  - Default Night Shift time window (e.g., 11pm-6am).
  - Morning briefing delivery time.
  - Global Night Shift budget cap.
  - Subscription utilization mode: `maximize` / `conservative` / `fixed` (default: `conservative`).
  - Conservative mode percentage: slider for max % of available overnight capacity (default: 60%).
  - Weekly reserve: slider for % of weekly budget to protect (default: 20%).
  - Multi-batch scheduling: toggle to schedule work across rate limit reset windows (default: on).
  - Subscription status panel: live display of current tier per provider, rate limit state, estimated available capacity, and projected utilization bar.

#### W3: Memory Architecture Upgrade

A comprehensive upgrade to ADE's memory system, introducing tiered storage, vector search, composite scoring, pre-compaction flushing, memory consolidation, episodic memory, procedural memory, and portable `.ade/` directory storage. These capabilities serve both mission workers and the CTO agent.

##### Carry-Over Scope: Candidate Memory Triage Automation

To absorb the remaining near-term memory gap into Phase 4 (instead of shipping a separate pre-Phase-4 patch), W3 explicitly includes candidate-memory lifecycle automation:

- Add a candidate sweep path that runs at safe checkpoints (app startup, run finalization, and optional periodic timer):
  - promote `candidate` entries with `confidence >= auto_promote_threshold`,
  - archive stale `candidate` entries older than `max_candidate_age_hours`.
- Keep manual user controls unchanged (review/promote/archive from the existing candidate panel).
- Align runtime config typing/validation with documented memory policy keys so behavior is deterministic.
- Scope intent: this is a cleanup/quality guardrail for the existing memory lifecycle, not a semantic-search upgrade.

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

- Add `sqlite-vec` extension to the existing SQLite database (works with `better-sqlite3` in Electron).
- Store embeddings alongside memory records in a `memory_vectors` table.
- Hybrid search: BM25 keyword (30% weight) + vector similarity (70% weight).
- **MMR re-ranking**: Maximal Marginal Relevance with lambda=0.7 to reduce redundant results in retrieval.
- Embedding strategy: local GGUF model (`all-MiniLM-L6-v2`, ~25MB, 384 dimensions) for offline operation, OpenAI `text-embedding-3-small` (1536 dimensions) as fallback when online. Retrieval pipeline normalizes across both dimension sizes.
- **Scalability**: sqlite-vec uses brute-force KNN — performant up to ~100K vectors, which is more than sufficient for per-project memory (typical project accumulates hundreds to low thousands of memories). If a project exceeds this threshold, cold archival (Tier 3) keeps the active vector count manageable.
- Cache embeddings to avoid recomputation — embeddings are stored in `.ade/embeddings.db` (gitignored, regenerated on new machine in ~30s background job on first startup).
- Budget tiers control how many memories are injected into agent context: **Lite (3 entries)** for quick tasks, **Standard (8 entries)** for normal agent work, **Deep (20 entries)** for mission planning and complex reasoning.

##### Mem0 Sidecar Decision (Deferred)

- `Mem0` remains a candidate integration as an optional semantic sidecar layer on top of ADE memory.
- Phase 4 does **not** depend on Mem0 shipping; the baseline remains native/local memory retrieval (`sqlite-vec` hybrid search) with durable memory lifecycle in ADE.
- Revisit Mem0 after Phase 4 memory baseline + CTO rollout stabilizes, and evaluate:
  - sidecar reliability and fallback behavior,
  - provider flexibility (fully local vs API-backed embeddings/extraction),
  - operational complexity vs incremental retrieval quality gains.
- If adopted later, Mem0 should be opt-in and non-breaking: semantic path first, then fallback to existing ADE retrieval when unavailable.

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

Memories are ranked by this composite score during retrieval. The weights ensure that semantically relevant memories dominate, but frequently accessed and recent memories get a meaningful boost.

##### Pre-Compaction Memory Flush

- Before context compaction (at 70% threshold, already shipped in Hivemind HW6), trigger a silent agentic turn.
- The agent is prompted to persist important memories to disk before context is lost.
- Uses the agent's own intelligence to decide what matters — the agent reviews its current context and calls memory tools to save anything it deems important.
- Flush counter prevents double-flushing: each compaction event is assigned a monotonic ID, and the flush is skipped if the current ID has already been flushed.
- Integrates with existing `compactionEngine.ts` via a pre-compaction hook.

##### Memory Write Policy (Phase 4 + CTO-aligned)

- Memory writes should be policy-driven rather than "save everything":
  - **Always write**: durable architectural decisions, stable project conventions, high-signal gotchas, repeatable procedures.
  - **Candidate first**: uncertain/temporary observations, plan assumptions, risks pending validation.
  - **Do not write**: transient tool noise, one-off logs, stale intermediate reasoning.
- Candidate memories are promoted via confidence + review flow; low-value/aged entries are archived.
- Pre-compaction flush captures critical facts before context eviction, with the agent deciding what is worth preserving.
- This policy applies to mission workers and is the same foundation the CTO uses when Phase 4 W1/W3 land together.

##### Memory Consolidation

- When a new memory is saved, compare against existing memories using cosine similarity (threshold > 0.85).
- If a similar memory is found, invoke an LLM to decide the consolidation action:
  - **PASS**: New memory is redundant — discard it silently.
  - **REPLACE**: New memory supersedes the existing one — update the existing record with new content.
  - **APPEND**: Both contain unique information — merge them into a single, richer memory.
  - **DELETE**: Existing memory is obsolete in light of new information — remove the old one and save the new one.
- Runs on save, not as a batch job — keeps memory clean in real-time.
- Prevents unbounded growth by ensuring the memory store does not accumulate near-duplicate entries.

##### Episodic Memory

After each session or mission completes, generate a structured summary capturing what happened, what was learned, and what to remember for next time.

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

Episodic memories are generated by prompting the agent to reflect on the completed work. They are stored as Tier 2 (hot) memories initially and decay to Tier 3 (cold) over time based on access patterns.

##### Procedural Memory

```typescript
interface ProceduralMemory {
  id: string;
  trigger: string;       // When to apply (e.g., "when running tests in the auth module")
  procedure: string;     // What to do (e.g., "always run setup checks first, then seed, then test")
  confidence: number;    // 0-1, increases with successful applications
  successCount: number;  // How many times this procedure led to success
  failureCount: number;  // How many times this procedure led to failure
  lastUsed: string;      // ISO 8601 timestamp
}
```

Procedural memories are extracted from episodic memories when a pattern is observed multiple times. They encode learned workflows that agents can apply automatically when the trigger condition matches.

##### New Memory Tools for Agents

- **`memorySearch`** — Upgraded with hybrid BM25+vector search. Agents call this to retrieve relevant memories during execution. Returns results ranked by composite score.
- **`memoryAdd`** — Upgraded with consolidation check. When an agent saves a new memory, the system automatically checks for near-duplicates and consolidates as needed.
- **`memoryUpdateCore`** — Self-edit Tier 1 working context. Agents can update their own core memory block (persona, current task context, critical conventions) without a full memory save cycle.
- **`memoryPin`** — Pin a critical memory to Tier 1. Ensures the memory is always included in context, bypassing the retrieval scoring system.

##### Prior Art & Design References

ADE's memory architecture is informed by research across the agent memory landscape. This section documents the external systems and academic findings that shaped our design decisions.

**Tiered Memory Hierarchy — MemGPT / Letta**
The three-tier model (Core / Hot / Cold) is directly inspired by MemGPT (now Letta). MemGPT introduced the idea of treating LLM context as "main memory" and external storage as "disk", with the agent managing its own memory via explicit read/write operations. Their architecture uses core memory blocks (always in context, self-editable), archival memory (vector-searched cold storage), and recall memory (conversation history). ADE adapts this into Tier 1/2/3 with the addition of composite scoring and cross-machine portability via `.ade/`. Letta's benchmark found that simple file operations achieved 74% accuracy on memory tasks — validating our choice of file-based portable storage over complex database replication.

**Memory Consolidation — Mem0**
The PASS/REPLACE/APPEND/DELETE consolidation model is adapted from Mem0's memory management system. Mem0 performs real-time deduplication on every write by comparing new memories against existing entries using cosine similarity. When overlap is detected, an LLM decides whether to keep both (PASS), replace the old (REPLACE), merge them (APPEND), or remove the old one (DELETE). ADE uses Mem0's approach with a conservative 0.85 similarity threshold and extends it with scope-aware matching (only compare within the same memory scope). Mem0's benchmark (68.5% accuracy) and Letta's (74%) both informed our decision to keep the consolidation model simple and file-backed.

**Composite Scoring — CrewAI**
The weighted composite score formula (`semantic(0.5) + recency(0.2) + importance(0.2) + access(0.1)`) is adapted from CrewAI's memory retrieval system. CrewAI's `RecallFlow` uses a similar multi-signal approach combining semantic similarity with temporal decay and access frequency. ADE simplifies the weights for predictability and adds the explicit importance dimension (user-set tags rather than inferred importance).

**Pre-Compaction Flush — OpenClaw**
The silent agentic turn before context compaction is inspired by OpenClaw's memory management. OpenClaw uses Markdown-based memory files (MEMORY.md + daily logs) that the agent reads and writes as part of its workflow. Before context is evicted, the agent is prompted to persist anything important — using the agent's own intelligence rather than a mechanical extractor. ADE formalizes this with a flush counter (prevent double-flush) and integration with the compaction engine's threshold system.

**Hybrid BM25 + Vector Search — OpenClaw / RAG Literature**
OpenClaw's memory search combines keyword (BM25) and semantic (vector) search with configurable weights. This hybrid approach is well-established in RAG literature — BM25 excels at exact identifier matching (function names, error codes) while vector search finds conceptually related content. ADE adopts the 30/70 BM25/vector split with MMR re-ranking to reduce result redundancy.

**Episodic & Procedural Memory — LangMem / LangChain**
LangMem (LangChain's memory research project) introduced the taxonomy of episodic memory (structured post-session summaries) and procedural memory (learned tool-usage patterns) for LLM agents. ADE's `EpisodicMemory` and `ProceduralMemory` interfaces are informed by LangMem's approach, adapted with confidence scoring and self-reinforcement (success/failure counts). LangMem's key insight: procedural memories should be extracted from recurring episodic patterns, not from individual sessions — ADE follows this by requiring pattern observation across multiple episodes before creating a procedural entry.

**Zettelkasten-Inspired Linking — A-MEM**
A-MEM's research applies Zettelkasten (networked note-taking) principles to LLM memory. Each memory entry is enriched with automatic links to related entries, creating a knowledge graph rather than a flat list. While ADE does not implement full Zettelkasten linking in Phase 4, the consolidation system's APPEND operation creates implicit links, and the composite scoring formula ensures related memories surface together. Full graph-based memory navigation is a candidate for a future phase.

**Observation Masking — JetBrains NeurIPS 2025**
JetBrains' research (presented at NeurIPS 2025 Agentic AI workshop) found that **observation masking** — replacing old tool outputs with simple placeholders — outperforms LLM-based summarization for context management while being significantly cheaper. Their finding: replacing `<tool_output>full output here</tool_output>` with `<tool_output>[output omitted]</tool_output>` preserves agent performance better than asking an LLM to summarize the output. ADE applies this in context assembly: when building prompts for resumed sessions, old tool outputs beyond the most recent N are masked rather than summarized.

**Context Window Separation — Elvis Sun (ZOE/CODEX)**
Elvis Sun's ZOE/CODEX architecture (documented in his X thread and community discussions) demonstrates the principle of separating business context from code context. His setup uses ZOE as an orchestrator managing business logic and decision-making in one context window, while CODEX workers handle pure code generation in separate windows. This informed ADE's leader/worker separation: the orchestrator maintains mission context (planning, coordination, decisions) while workers maintain code context (file contents, test results, implementation details). Context windows are zero-sum — mixing both degrades both.

**SOUL.md Pattern — Community Practice**
The identity persistence pattern using versioned Markdown files to define agent persona, voice, constraints, and behavioral rules emerged from community practice around Claude Code's `CLAUDE.md` and OpenClaw's `MEMORY.md`. ADE formalizes this as `.ade/cto/core-memory.json` with explicit version history and audit trail, extending the informal pattern into a structured, policy-enforced system.

##### Storage: .ade/ Directory for Portability

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
│   ├── mobile-dev/
│   │   └── ...
│   └── qa-engineer/
│       └── ...
├── templates/
│   ├── bug-fix.yaml           # Mission template: bug fixes
│   ├── feature.yaml           # Mission template: features
│   └── refactor.yaml          # Mission template: refactors
├── memory/
│   ├── project.json           # Project-level facts (Tier 2/3)
│   ├── learning-pack.json     # Auto-curated knowledge
│   └── archive/               # Cold storage (Tier 3)
├── history/
│   └── missions.jsonl         # Mission run log (append-only)
└── embeddings.db              # sqlite-vec embeddings cache
```

- Tiny config files (agents, identities, context docs, `local.yaml`) are committable to the repo for version tracking.
- **App state syncs via cr-sqlite** (Phase 6) — the database (`ade.db`) replicates across devices in real-time. Git tracks code and config, cr-sqlite syncs app state.
- `.ade/local.yaml` (git-tracked) holds project-level config (lane templates, phase profiles, feature flags — no secrets).
- `.ade/local.secret.yaml` (gitignored) holds machine-specific secrets (API keys, local paths, external MCP server configs).

#### W4: Learning Packs (Auto-Curated Project Knowledge)

A context pack type that automatically accumulates project-specific knowledge from agent interactions, building a persistent memory that improves agent performance over time. Learning packs feed into the memory system (W3) as high-confidence project-scope entries.

- New pack type: `LearningPack` alongside existing Lane/Project/Mission/Feature packs.
- **Knowledge sources** (automatic):
  - Mission/agent run failures and their resolutions (what went wrong, how it was fixed)
  - User interventions during agent work (what the user corrected → inferred rule)
  - Repeated issues across agent chat sessions (same error 3+ times → recorded pattern)
  - PR review feedback patterns (reviewer consistently requests X → recorded preference)
- **Knowledge entries**:
  ```typescript
  interface LearningEntry {
    id: string;
    category: 'mistake-pattern' | 'preference' | 'flaky-test' | 'tool-usage' | 'architecture-rule';
    scope: 'global' | 'directory' | 'file-pattern';  // How broadly it applies
    scopePattern?: string;                              // e.g., "src/auth/**" for directory scope
    content: string;                                    // The actual learning (human-readable rule)
    confidence: number;                                 // 0-1, increases with repeated observations
    observationCount: number;                           // How many times this was observed
    sources: string[];                                  // IDs of missions/sessions that contributed
    createdAt: string;
    updatedAt: string;
  }
  ```
- **Injection**: Learning pack contents are injected into orchestrator context alongside project packs. High-confidence entries (confidence > 0.7) are always included; low-confidence entries are included when scope matches the current task.
- **User review**: Entries are visible and editable in Settings → Learning. Users can confirm, edit, or delete entries. Confirmed entries get confidence boost.
- **Export/import**: Learning packs can be exported to/from CLAUDE.md or agents.md format for interoperability with standard agent config files.
- **Storage**: New `learning_entries` SQLite table with full-text search for efficient retrieval.
- **Privacy**: Learning packs are local-only (never transmitted). They travel with the project directory.

##### Carry-Over Scope: Skill Library (Recipes + Extraction + `.claude/skills/`)

To absorb the remaining skill-library gap into Phase 4, W4 includes a staged bridge from learning signals to reusable skills:

- **Phase 4 baseline (viewer/discovery)**: ship read-only visibility for agent commands/skills files (aligned with PROJ-039 goals).
- **Recipe candidate extraction**: derive candidate "how-to" recipes from repeated successful missions/interventions (stored as reviewable learning entries first, not auto-published as skills).
- **User-approved materialization**: confirmed recipe candidates can be exported to `.claude/skills/<name>/SKILL.md`.
- **Separation of concerns**:
  - Memory entries capture "what is true" (facts/decisions/preferences),
  - Skill recipes capture "how to do it" (repeatable workflows).

#### W5: External MCP Consumption

ADE agents (mission workers and the CTO agent) can consume external MCP servers, extending their capabilities beyond what ADE provides natively.

- **Configuration**: External MCP servers are declared in `.ade/local.secret.yaml` (gitignored, contains API keys) under an `externalMcp` key:
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
- **Tool discovery**: On startup, ADE connects to declared external MCP servers, discovers their available tools, and registers them in the tool namespace with a prefix (e.g., `ext.web-browser.navigate`, `ext.notion.search`).
- **CTO agent access**: The CTO agent can use external MCP tools for research, documentation queries, issue tracking, and other cross-system tasks.
- **Mission worker access**: Mission workers can use external MCP tools per a mission-level MCP profile. The mission launch flow includes an MCP tool selector that specifies which external tools are available for the mission.
- **Use cases**:
  - Agent needs to browse the web → connects to an MCP server that provides web browsing tools
  - Agent needs to read Notion documentation → connects to Notion MCP server
  - Agent needs to create Linear issues → connects to Linear MCP server
  - Agent needs to query a database → connects to a database MCP server
- **Lifecycle management**: ADE manages the lifecycle of external MCP server connections — starting them on demand, health-checking, reconnecting on failure, and shutting down when no agents need them.
- **Security**: External MCP tools are subject to the same guardrail enforcement as built-in tools. Budget enforcement applies to external tool invocations that incur costs.

#### W6: OpenClaw Bridge (External Agent Gateway Integration)

Connect ADE's CTO agent to OpenClaw (or similar external agent gateways), enabling bidirectional communication between the user's personal agent network and ADE's tech-focused CTO.

- **Conceptual model**:
  - OpenClaw is the user's personal life gateway — multiple agents (virtual self, CFO, marketing lead, etc.) handling different domains via messaging platforms.
  - ADE CTO is the entire tech department — one persistent agent with deep project knowledge.
  - The bridge makes CTO accessible as a specialist within the user's OpenClaw agent network.

- **Bridge service** (`openclawBridgeService.ts` in `src/main/services/`):
  - **HTTP server** (port 3742, configurable): Receives inbound requests from OpenClaw hooks and skills. Acknowledges immediately, forwards to CTO via IPC, returns response.
  - **WebSocket operator client**: Connects to OpenClaw's Gateway (`ws://127.0.0.1:18789`) as an `operator` role client for bidirectional, low-latency communication.
  - Handles OpenClaw's device pairing protocol: challenge-nonce handshake, `connect` request with auth token, `deviceToken` persistence for reconnection.
  - Subscribes to `agent` and `chat` events for real-time message routing.

- **Inbound flow (OpenClaw → CTO)**:
  1. OpenClaw agent calls `sessions_send` targeting a `hook:ade-cto` session key.
  2. Gateway hook triggers `message:received`, POSTs to ADE bridge HTTP endpoint.
  3. Bridge forwards to CTO via IPC, CTO processes with full memory + MCP tools.
  4. Bridge POSTs reply back via OpenClaw's `POST /hooks/agent` endpoint.

- **Outbound flow (CTO → OpenClaw)**:
  1. CTO (or orchestrator) wants to proactively message an OpenClaw agent.
  2. Bridge calls `sessions_send` over the WebSocket operator connection.
  3. Target OpenClaw agent receives the message; replies stream back as `agent` events.

- **OpenClaw-side configuration** (documented for users, not implemented by ADE):
  - `~/.openclaw/openclaw.json`: Enable `agentToAgent`, configure hooks token and `allowRequestSessionKey`.
  - `~/.openclaw/workspace/skills/ade-cto/SKILL.md`: Custom skill teaching OpenClaw agents how to invoke CTO.

- **Fallback: skill-only bridge** (no WebSocket):
  - Simpler one-directional integration where OpenClaw agents use `exec` + `curl` to hit ADE's HTTP endpoint.
  - Suitable for initial setup; the full bidirectional bridge is recommended for production.

- **IPC channels**:
  - `openclaw:message-received` — inbound message from OpenClaw to CTO.
  - `cto:forward-to-openclaw` — outbound message from CTO to an OpenClaw agent.
  - `openclaw:connection-status` — bridge connection state for UI indicator.

- **Configuration** (in `.ade/local.secret.yaml`, gitignored — contains secrets):
  ```yaml
  openclaw:
    enabled: false
    gatewayUrl: ws://127.0.0.1:18789
    gatewayToken: ${OPENCLAW_GATEWAY_TOKEN}
    bridgePort: 3742
    hooksToken: <shared-secret>
    deviceToken: <persisted-after-first-handshake>
  ```

- **Dependency**: W1 (CTO Agent) must be functional — the bridge routes to CTO.
- **Scope boundary**: ADE implements the bridge service and HTTP/WS endpoints. OpenClaw-side configuration (hooks, skills, agent setup) is user-managed and documented in `docs/features/CTO.md`.

#### W7: Validation & Testing

Comprehensive test coverage for all Phase 4 workstreams.

- **CTO + Org system tests** (W1):
  - Core memory persistence across sessions (CTO and workers).
  - Memory reconstruction on session start.
  - Session history log integrity.
  - MCP tool access from CTO and worker contexts.
  - **Org chart tests** (W1b): Agent creation, reportsTo hierarchy, cycle detection (max 50 hops), chain-of-command traversal, org tree reconstruction from flat list, agent removal (unlink direct reports).
  - **Multi-adapter tests** (W1b): Claude-local adapter spawns CLI correctly, OpenClaw webhook adapter sends HTTP POST, process adapter spawns subprocess, adapter hot-swap preserves identity/memory.
  - **Config versioning tests** (W1b): Revision creation on config change, before/after snapshot accuracy, changed-keys detection, rollback, redacted-secret rollback prevention.
  - **Budget auto-pause tests** (W1b): Cost event recording, monthly spend increment, auto-pause at budget ceiling, CTO notification on pause, monthly reset.
  - **Task session persistence tests** (W1b): Session save on run completion, session resume on re-invocation, session keyed by (agentId, adapterType, taskKey), session clear signal.
  - **Heartbeat tests** (W1c): Timer-based wakeup fires at intervalSec, active hours enforcement, wakeOnDemand triggers, two-tier execution (cheap check skips LLM when no changes), HEARTBEAT_OK suppression.
  - **Coalescing tests** (W1c): Duplicate wakeup merges context into running execution, deferred promotion on run completion, orphan reaping on restart.
  - **Issue execution locking tests** (W1c): Atomic lock on checkout, stale adoption after crash, lock release on completion.
  - **Linear sync tests** (W1d): Candidate issue polling, priority sorting, blocked-by filtering, auto-dispatch with template matching, escalation for unmatched issues, concurrency limit enforcement.
  - **Linear outbound tests** (W1d): State update on mission start/complete/fail, workpad comment creation and update, PR link posting, label addition.
  - **Reconciliation tests** (W1d): External close → mission cancel, external reassign → worker release, stall detection → restart.
  - **Mission template tests** (W1d): Template loading from `.ade/templates/`, variable rendering with issue context, template selection by CTO classification.

- **Night Shift guardrail tests** (W2):
  - Stop conditions (first-failure, budget-exhaustion, intervention-threshold, rate-limited, reserve-protected).
  - Subscription-aware scheduling (utilization modes, rate limit awareness, weekly reserve).
  - Multi-batch scheduling across rate limit resets.
  - Morning briefing card rendering and interaction (approve/dismiss/investigate).
  - Bulk action tests.
  - Digest generation accuracy.

- **Memory architecture tests** (W3):
  - Vector search accuracy (hybrid BM25+vector vs keyword-only retrieval quality).
  - Pre-compaction flush (memories persisted before compaction, flush counter prevents double-flush).
  - Memory consolidation (PASS/REPLACE/APPEND/DELETE operations with cosine similarity threshold).
  - Episodic memory extraction (post-session and post-mission summaries with correct structure).
  - Procedural memory extraction (pattern detection from repeated episodic memories).
  - Composite scoring (recency decay with 30-day half-life, importance weighting, access boost capping).
  - Memory tier promotion/demotion (Tier 2 → Tier 3 decay, Tier 2 → Tier 1 pinning).
  - `.ade/` portability (config files round-trip via git, app state round-trip via cr-sqlite in Phase 6, local.secret.yaml isolation).

- **Learning pack tests** (W4):
  - Entry accumulation (auto-capture from failures, interventions, repeated issues).
  - Confidence scoring (observation count → confidence increase, user confirmation boost).
  - Injection (high-confidence always included, scope-matched low-confidence included).
  - Export/import roundtrip (CLAUDE.md format, agents.md format).

- **External MCP consumption tests** (W5):
  - Tool discovery and namespace prefixing.
  - Lifecycle management (connect, health-check, reconnect, shutdown).
  - Permission enforcement on external tools.
  - Configuration parsing (.ade/local.yaml, stdio and SSE transport support).

- **OpenClaw bridge tests** (W6):
  - HTTP endpoint: inbound message acceptance, async CTO forwarding, response delivery.
  - WebSocket operator: handshake (challenge-nonce, connect, hello-ok), reconnection with persisted deviceToken.
  - Outbound: `sessions_send` over WebSocket delivers to OpenClaw and receives reply events.
  - Configuration: `.ade/local.yaml` openclaw section parsing, enabled/disabled toggle, secret isolation.
  - Error handling: OpenClaw gateway unavailable (graceful degradation), CTO unavailable (queued retry), malformed inbound requests (reject with error).

### Phase 4 / Phase 5.5 Bridge Notes

Phase 4 does not introduce compute backend selection (VPS/Daytona/E2B) — that remains Phase 5.5 scope. Mission workers run locally in Phase 4. When Phase 5.5 ships, remote compute backends become available for mission phases, and the CTO agent can leverage remote environments for exploration and testing.

### Exit criteria

- CTO tab provides persistent project-aware agent interface with three-tier memory model and org chart sidebar.
- CTO agent has access to all ADE MCP tools and external MCP tools.
- Worker agents can be created, configured, and managed under the CTO in an org hierarchy.
- Each worker has its own identity, memory tiers, adapter config, heartbeat policy, and budget.
- Heartbeat system activates agents on schedule or demand, with coalescing, deferred promotion, and orphan reaping.
- Bidirectional Linear sync: CTO polls Linear for issues, auto-dispatches missions via templates, and posts results back (state updates, workpad comments, PR links).
- Auto-dispatch policies are user-configurable per label/priority with escalation for complex work.
- Per-agent monthly budgets with auto-pause enforcement and CTO notification.
- Agent config versioning with rollback support.
- Multi-adapter pattern supports claude-local, codex-local, openclaw-webhook, and process backends.
- Task session persistence enables workers to resume context when re-invoked on the same task.
- CTO and worker memory persists across sessions via `.ade/cto/` and `.ade/agents/` directories.
- Night Shift mode in Automations tab provides overnight execution with subscription-aware scheduling and guardrails.
- Morning Briefing provides a swipeable card interface for reviewing overnight results (approve/dismiss/investigate).
- Morning Briefing appears as modal overlay on app launch after Night Shift completes, and on-demand from Automations tab.
- Memory retrieval uses hybrid BM25+vector search with composite scoring (semantic similarity, recency, importance, access frequency).
- Pre-compaction flush prevents memory loss during context compaction by triggering agent-driven memory persistence.
- Memory consolidation prevents unbounded growth via real-time deduplication on save (PASS/REPLACE/APPEND/DELETE).
- Episodic memories are generated after session/mission completion with structured summaries.
- Procedural memories are extracted from recurring episodic patterns and applied automatically when trigger conditions match.
- `.ade/` directory provides portable state across machines — git is the sync layer.
- Learning packs accumulate project knowledge from agent interactions with confidence scoring and scope matching.
- Learning pack entries are visible and editable in Settings; export/import to CLAUDE.md format is supported.
- ADE agents (mission workers and CTO) can consume external MCP servers for extended capabilities.
- External MCP tools are subject to the same guardrail enforcement as built-in tools.
- OpenClaw bridge service provides bidirectional communication between ADE CTO and OpenClaw agents via HTTP + WebSocket.
- OpenClaw-side configuration (hooks, skills, agent setup) is documented in `docs/features/CTO.md` for user self-service.

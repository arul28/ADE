# Phase 4: CTO + Ecosystem

## Phase 4 -- CTO + Ecosystem (4-5 weeks)

Goal: Add the CTO agent as a persistent project-aware assistant with a configurable org chart of worker agents. Absorb Night Shift into Automations. Complete the memory architecture upgrade. Expand external ecosystem integration.

### Workstream Index

| Workstream | File | Status |
|------------|------|--------|
| W1: CTO Agent Core | [W1-W4.md](W1-W4.md) | ✅ Complete |
| W2: Worker Agents & Org Chart | [W1-W4.md](W1-W4.md) | ✅ Complete |
| W3: Heartbeat & Activation | [W1-W4.md](W1-W4.md) | ✅ Complete |
| W4: Bidirectional Linear Sync | [W1-W4.md](W1-W4.md) | ✅ Complete |
| W5: Automations Platform + Night Shift | [W5.md](W5.md) | W5a ✅ / W5b not started |
| W6: Unified Memory System | [W6.md](W6.md) | ✅ Complete |
| W6½: Memory Engine Hardening | [W6-half.md](W6-half.md) | Not started |
| W-UX: CTO + Org Experience Overhaul | [W-UX.md](W-UX.md) | Not started |
| W7a: Embeddings Pipeline | [W7a.md](W7a.md) | Not started |
| W7b: Orchestrator ↔ Memory Integration | [W7b.md](W7b.md) | Not started |
| W7c: Skills + Learning Pipeline | [W7c.md](W7c.md) | Not started |
| W8: External MCP Consumption | [W8.md](W8.md) | Not started |
| W9: OpenClaw Bridge | [W9.md](W9.md) | Not started |
| W10: .ade/ Portable State | [W10.md](W10.md) | Not started |

### Reference docs

- [features/CTO.md](../../features/CTO.md) — CTO agent design, memory architecture, OpenClaw integration architecture
- [features/MISSIONS.md](../../features/MISSIONS.md) — mission launch flow, executor policy, autopilot mode
- [features/AUTOMATIONS.md](../../features/AUTOMATIONS.md) — automation rules, trigger-action engine (Night Shift absorbed here)
- [features/ONBOARDING_AND_SETTINGS.md](../../features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard and budget controls
- [architecture/AI_INTEGRATION.md](../../architecture/AI_INTEGRATION.md) — per-task-type configuration, MCP permission/policy layer
- [architecture/SECURITY_AND_PRIVACY.md](../../architecture/SECURITY_AND_PRIVACY.md) — trust model for unattended execution

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

Workstreams are numbered by topic but executed in dependency order. W1-W4, W5a, and W6 are complete. The orchestrator is being rebuilt from the ground up (Phase 3 overhaul). Remaining workstreams are reordered based on dependency analysis and lessons from Symphony, Paperclip, and OpenClaw reference implementations (2026-03-09 audit).

**Completed workstreams (locked):**
- W1: CTO Agent Core ✅
- W2: Worker Agents & Org Chart ✅
- W3: Heartbeat & Activation ✅
- W4: Bidirectional Linear Sync ✅
- W5a: Automations — Usage + Budget + UI ✅
- W6: Unified Memory System ✅ (lexical/composite scoring; no embeddings)

**Known gaps in shipped work** (addressed by remaining workstreams):
- Memory system has no pre-compaction flush, no lifecycle sweeps, no batch consolidation, no embeddings
- CTO works without setup flow — no onboarding, no identity configuration, no guided Linear connection
- Inconsistent theming across CTO/Automations/Memory surfaces; poor discoverability of worker management
- Orchestrator doesn't systematically write to or read from unified memory during missions
- No episodic summary generation, no skill extraction pipeline

```
Wave 3 (current — memory + UX foundation):
  W6½: Memory Engine Hardening            ← needs W6 (shipped)
  W-UX: CTO + Org Experience Overhaul     ← needs W1-W4 (shipped), can parallel with W6½

Wave 4 (after W6½ — embeddings + orchestrator memory):
  W7a: Embeddings Pipeline                ← needs W6½
  W7b: Orchestrator ↔ Memory Integration  ← needs W6½ + stable orchestrator

Wave 5 (after W7a + W7b — skills):
  W7c: Skills + Learning Pipeline         ← needs W7a (embeddings) + W7b (episodic summaries)

Wave 6 (after stable orchestrator — automations):
  W5b: Automations — Executors + Night Shift + External Triggers  ← needs W5a + stable orchestrator + W6½

Wave 7 (ecosystem — independent, can parallel):
  W8: External MCP Consumption            ← independent infra
  W9: OpenClaw Bridge                     ← needs W1, W8
  W10: .ade/ Portable State               ← needs W1, W6½
```

Dependency graph:
```
W1-W4 ✅ ──→ W5a ✅ ──→ W5b (Automations Full)
     │                      ↑
     │                      │ (needs stable orchestrator)
     │
     ├──→ W6 ✅ ──→ W6½ (Memory Hardening) ──→ W7a (Embeddings) ──→ W7c (Skills)
     │              │                                                    ↑
     │              ├──→ W7b (Orch ↔ Memory) ────────────────────────────┘
     │              │         ↑ (needs stable orchestrator)
     │              └──→ W10 (.ade/ State)
     │
     ├──→ W-UX (CTO + Org UX) ← can parallel with W6½
     │
     └──→ W8 (External MCP) ──→ W9 (OpenClaw Bridge)
```

Each workstream includes its own renderer/UI changes and tests (no standalone workstreams for these).

**New reference material incorporated (2026-03-09):**

| Source | What ADE Adopts (new) |
|--------|----------------------|
| **[OpenClaw Memory Masterclass](https://velvetshark.com/articles/openclaw-memory-masterclass)** | Pre-compaction flush with `reserveTokensFloor`, "file as truth" principle, bootstrap file reload pattern, sub-agent memory inheritance contract |
| **[Symphony §8](https://github.com/openai/symphony/blob/main/SPEC.md)** | Continuation vs failure retry distinction (1s vs exponential backoff), dynamic config reload (file-watch), agent-driven tracker writes via pass-through tool, workspace containment invariant |
| **[Paperclip adapters](https://github.com/paperclipai/paperclip)** | Additional adapters (cursor-local, opencode-local, pi-local), billing codes for cross-agent cost attribution, context snapshots per run, idempotency keys on wakeups, log integrity (SHA-256), fat/thin context delivery |

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
  - On first launch or incomplete CTO setup (`.ade/cto/identity.yaml` missing, no workers, or no `linearSync` policy), the CTO sends a startup welcome message: "I'm your CTO. Glad to join your team. If you want, I can scan the repo and stand up an initial department."
  - If accepted, bootstrap sequence runs:
    1. Project fingerprint pass (stack/manifest detection, lane layout, CI, changelog signals).
    2. Context-pack ingestion (`.ade/context/PRD.ade.md`, `.ade/context/ARCHITECTURE.ade.md`, prior mission/context artifacts where available).
    3. Memory pack creation: project summary + conventions + conventions-to-enforce + known hotspots + recommended worker routing defaults.
    4. CTO-first default org suggestion (editable): suggested workers + per-worker default roles, adapters, and policies.
    5. Default auto-dispatch policy presented as editable templates before activation.
  - If skipped, ADE creates minimal `.ade/cto/` scaffold and keeps onboarding as a persistent in-chat task in the CTO tab (`needsSetup` state) until confirmed.

### Exit Criteria

**Completed (W1-W4, W5a, W6):**
- ✅ CTO tab provides persistent project-aware agent interface with three-tier memory model and org chart sidebar.
- ✅ CTO agent has access to all ADE MCP tools.
- ✅ Worker agents can be created, configured, and managed under the CTO in an org hierarchy.
- ✅ Each worker has its own identity, memory tiers, adapter config, heartbeat policy, and budget.
- ✅ Heartbeat system activates agents on schedule or demand, with coalescing, deferred promotion, and orphan reaping.
- ✅ Bidirectional Linear sync: CTO polls Linear for issues, auto-dispatches missions via templates, and posts results back.
- ✅ Reconciliation validates running missions against Linear state on every heartbeat.
- ✅ Per-agent monthly budgets with auto-pause enforcement and CTO notification.
- ✅ Agent config versioning with rollback support.
- ✅ Multi-adapter pattern supports claude-local, codex-local, openclaw-webhook, and process backends.
- ✅ Unified memory system with lexical/composite scoring, write gate dedup, tier lifecycle, and hard limits.

**W6½ — Memory Engine Hardening:**
- Pre-compaction flush prevents memory loss during context compaction.
- Lifecycle sweeps enforce temporal decay, tier demotions, candidate promotion, and hard limit enforcement on schedule.
- Batch consolidation merges near-duplicate entries via LLM, preventing unbounded memory growth.
- Context snapshots captured per worker run for debugging and retrospective analysis.

**W-UX — CTO + Org Experience Overhaul:**
- First-run CTO onboarding wizard: identity setup, project context scan, integration connection.
- CTO and workers have configurable identities (`identity.yaml`) with personality, capabilities, constraints, and communication style.
- Identity files on disk are source of truth (file-as-truth sync with DB).
- Linear connection has guided setup flow with token validation, project discovery, and status indicators.
- CTO ↔ Automations Linear boundary is clearly separated in UI.
- Consistent theming across all agent-system surfaces (status badges, cards, timeline entries, dark mode).
- Worker management consolidated into discoverable Team panel with creation wizard, activity feed, and detail slide-out.
- Fat/thin context delivery: mission workers get full context, heartbeat checks get minimal context.

**W7a — Embeddings Pipeline:**
- sqlite-vec loaded as native SQLite extension with `vec0` virtual tables.
- all-MiniLM-L6-v2 GGUF model runs locally for embedding inference (< 100ms per entry).
- Background embedding job processes new entries and backfills existing ones without blocking.
- Hybrid retrieval: BM25 (30%) + cosine similarity (70%) with MMR re-ranking replaces lexical-only scoring.
- Graceful degradation: embedding pipeline disabled → lexical fallback, identical to shipped W6 behavior.

**W7b — Orchestrator ↔ Memory Integration:**
- Mission memory lifecycle: scope creation → accumulation → promotion on success / archival on failure.
- `orchestrator_shared_facts` migrated to mission-scoped `unified_memories` entries.
- Worker briefing assembly pulls from unified memory (L0/L1/L2/mission) instead of packs.
- Episodic summaries generated async on mission/session completion.
- Human work ingestion: change digests generated when repo diverges outside agent runs.
- Continuation vs failure retry memory: clean exit preserves context, crash injects gotcha.

**W7c — Skills + Learning Pipeline:**
- Procedural memory extracted from 3+ similar episodic summaries via LLM.
- Confidence evolution: success/failure tracking with auto-archive (< 0.3) and auto-promote (>= 0.8).
- Knowledge capture from mission failures, user interventions, and repeated errors.
- Skill materialization: confirmed procedures exported as `.claude/skills/<name>/SKILL.md`.
- Skill ingestion: existing skill files scanned, parsed, and indexed into project memory.

**W5b — Automations Full:**
- Automations tab provides trigger-driven workflows, template-driven setup, executor routing, and Night Shift scheduling.
- Morning Briefing provides a swipeable card interface for reviewing overnight results.
- Billing codes for cross-agent cost attribution in automation runs.
- Clear boundary between CTO-managed and automation-managed Linear interactions.

**W8 — External MCP Consumption:**
- ADE agents can consume external MCP servers declared in `local.secret.yaml`.
- Tool discovery with namespace prefixing, per-server and per-agent permission model.
- Dynamic config reload: hot-reload MCP server connections on config file change.
- Lifecycle management with health checks, reconnection, and graceful shutdown.

**W9 — OpenClaw Bridge:**
- Bidirectional communication between ADE CTO and OpenClaw agent gateway.
- Memory bridge: selective context sharing with configurable privacy policy.
- HTTP + WebSocket transport with idempotency and device pairing.
- Fallback skill-only mode for simpler setups.

**W10 — .ade/ Portable State:**
- `.ade/` directory provides portable state across machines — git tracks config, cr-sqlite syncs app state.
- Startup validation: directory structure, schema validation, secret detection, file-truth sync.
- Log integrity: SHA-256 hash chain on append-only JSONL files.
- Dynamic config reload for `local.yaml` changes without app restart.
- One-time migration from pre-Phase-4 storage.

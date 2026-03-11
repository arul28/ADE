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
| W5: Automations Platform + Night Shift | [W5.md](W5.md) | W5a ✅ / W5b mostly implemented |
| W6: Unified Memory System | [W6.md](W6.md) | ✅ Complete |
| W6½: Memory Engine Hardening | [W6-half.md](W6-half.md) | ✅ Complete |
| W-UX: CTO + Org Experience Overhaul | [W-UX.md](W-UX.md) | Partially implemented; onboarding/activity/polish remaining |
| W7a: Embeddings Pipeline | [W7a.md](W7a.md) | ✅ Complete |
| W7b: Orchestrator ↔ Memory Integration | [W7b.md](W7b.md) | ✅ Complete |
| W7c: Skills + Learning Pipeline | [W7c.md](W7c.md) | Largely implemented / advanced capture follow-through pending |
| W8: External MCP Consumption | [W8.md](W8.md) | Not started |
| W9: OpenClaw Bridge | [W9.md](W9.md) | Not started |
| W10: .ade/ Portable State | [W10.md](W10.md) | Partial foundation exists; portable git model pending |

### Audit Snapshot (2026-03-11)

- Complete: W1-W4, W6, W6½, W7a, W7b
- Mostly implemented: W5b, W7c
- Partially implemented: W-UX, W10
- Still genuinely pending: W8, W9
- Highest-value follow-through still open inside shipped work: onboarding/polish in CTO UX, advanced knowledge capture review, and a code-backed decision on how portable `.ade/` state should work before Phase 6

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

Workstreams are numbered by topic but executed in dependency order. W1-W4, W5a, W6, W6½, W7a, and W7b are complete. A 2026-03-11 code audit showed that W-UX and W7c are no longer greenfield workstreams: they have substantial implementation in the codebase and now need status-correct documentation plus targeted follow-through. The orchestrator is still evolving, so the remaining backlog is reordered around what is truly left rather than what was originally planned.

**Completed workstreams (locked):**
- W1: CTO Agent Core ✅
- W2: Worker Agents & Org Chart ✅
- W3: Heartbeat & Activation ✅
- W4: Bidirectional Linear Sync ✅
- W5a: Automations — Usage + Budget + UI ✅
- W6: Unified Memory System ✅ (lexical/composite scoring; no embeddings)
- W6½: Memory Engine Hardening ✅ (lifecycle sweeps, batch consolidation, pre-compaction flush)
- W7a: Embeddings Pipeline ✅ (local all-MiniLM-L6-v2, hybrid FTS+cosine retrieval, MMR re-ranking)
- W7b: Orchestrator ↔ Memory Integration ✅ (mission-memory SSoT, shared team knowledge projection, exact employee L2 injection)

**Known gaps in shipped work** (addressed by remaining workstreams):
- CTO still needs a cleaner onboarding/setup experience, stronger activity visibility, and broader visual/system polish
- Inconsistent theming and shared component treatment remain across CTO/Automations/Memory surfaces
- Advanced learning capture from user interventions, repeated errors, and PR feedback still needs end-to-end follow-through even though the procedural pipeline is already in code
- Portable `.ade/` policy is unresolved: file-backed CTO/worker state exists today, but the selective tracked/shareable model described for W10 is not yet implemented
- Export/storage consolidation is unresolved: durable learned artifacts should converge under `.ade/` rather than remaining split across other top-level folders

```
Wave 3 (partially shipped — UX polish still open):
  W6½: Memory Engine Hardening            ✅ Complete
  W-UX: CTO + Org Experience Overhaul     Partially implemented; onboarding/polish still open

Wave 4 (shipped):
  W7a: Embeddings Pipeline                ✅ Complete
  W7b: Orchestrator ↔ Memory Integration  ✅ Complete

Wave 5 (mostly shipped — advanced learning capture remains):
  W7c: Skills + Learning Pipeline         Largely implemented; advanced capture/review mining still open

Wave 6 (ecosystem — independent, can parallel):
  W8: External MCP Consumption            Pending
  W9: OpenClaw Bridge                     Pending; needs W1, W8
  W10: .ade/ Portable State               Partial foundation exists; portable git/share model still pending
```

Dependency graph:
```
W1-W4 ✅
     │
     ├──→ W6 ✅ ──→ W6½ ✅ ──→ W7a ✅ ──→ W7b ✅
     │                          └──────→ W7c (Skills; core shipped, advanced capture pending)
     │
     ├──→ W10 (.ade/ State; partial foundation, portability pending)
     │
     ├──→ W-UX (CTO + Org UX; partial)
     │
     └──→ W8 (External MCP; pending) ──→ W9 (OpenClaw Bridge; pending)
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
  - ADE generates a "project change digest" (git commits + working tree deltas) and writes it into shared project memory plus the CTO awareness path.
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
- ✅ CTO tab provides a persistent project-aware agent interface with layered memory (CTO core memory, employee core memory, shared project memory, subordinate activity feed) and org chart sidebar.
- ✅ CTO agent has access to all ADE MCP tools.
- ✅ Worker agents can be created, configured, and managed under the CTO in an org hierarchy.
- ✅ Each worker has its own identity, core memory, adapter config, heartbeat policy, and budget while sharing durable project memory with the CTO.
- ✅ Heartbeat system activates agents on schedule or demand, with coalescing, deferred promotion, and orphan reaping.
- ✅ Bidirectional Linear sync: CTO polls Linear for issues, auto-dispatches missions via templates, and posts results back.
- ✅ Reconciliation validates running missions against Linear state on every heartbeat.
- ✅ Per-agent monthly budgets with auto-pause enforcement and CTO notification.
- ✅ Agent config versioning with rollback support.
- ✅ Multi-adapter pattern supports claude-local, codex-local, openclaw-webhook, and process backends.
- ✅ Unified memory system with lexical/composite scoring, write gate dedup, tier lifecycle, and hard limits.

**W6½ — Memory Engine Hardening: ✅ Complete**
- ✅ Pre-compaction flush prevents memory loss during context compaction.
- ✅ Lifecycle sweeps enforce temporal decay (30-day half-life), tier demotions (Tier 2→3 at 90d, Tier 3→archived at 180d), candidate promotion (confidence ≥ 0.7 + observationCount ≥ 2), hard limit enforcement (project: 2K, agent: 500, mission: 200), and orphan cleanup on schedule.
- ✅ Batch consolidation merges near-duplicate entries via Jaccard trigram clustering + LLM merge, preventing unbounded memory growth.
- ✅ Memory Health dashboard in Settings > Memory shows entry counts, sweep/consolidation logs, hard limit usage, and manual action buttons.

**W-UX — CTO + Org Experience Overhaul: Partially implemented (2026-03-11 audit)**
- ✅ Current CTO shell, Team panel, worker settings flows, onboarding wizard, memory browser, and Linear sync panel are in place and usable.
- ✅ Identity files on disk are already the source of truth for CTO/worker state in the current implementation.
- ✅ CTO ↔ Automations Linear boundary exists in product direction and current UI structure.
- Remaining: polish the onboarding/setup path, strengthen connection validation/status UX, unify cards/badges/timelines, improve worker activity visibility, and finish broader theming consistency.

**W7a — Embeddings Pipeline: ✅ Complete**
- ✅ Local all-MiniLM-L6-v2 model runs via `@huggingface/transformers` for embedding inference.
- ✅ Background embedding worker service processes new entries and backfills existing ones without blocking.
- ✅ Hybrid retrieval: FTS4 BM25 (30%) + cosine similarity (70%) with MMR re-ranking replaces lexical-only scoring.
- ✅ Graceful degradation: embedding pipeline disabled → lexical fallback, identical to shipped W6 behavior.
- ✅ Memory Health dashboard shows embedding progress, model status, and cache stats.

**W7b — Orchestrator ↔ Memory Integration: ✅ Complete (2026-03-11 audit)**
- ✅ Mission memory lifecycle exists: scope creation, accumulation, promotion on success, archival on failure.
- ✅ Worker briefing assembly reads from unified memory for project and mission context.
- ✅ Episodic summaries are generated asynchronously on mission/session completion.
- ✅ Human work ingestion/change digest generation exists and is used as a freshness gate before mission work.
- ✅ Continuation vs failure retry memory exists: clean exit preserves mission state, failure injects gotchas.
- ✅ `orchestrator_shared_facts` is retired; mission-scoped unified memory is now the single coordination store.
- ✅ Persistent employee L2 agent memory is wired end to end through exact `employeeAgentId` mission launch metadata.

**W7c — Skills + Learning Pipeline: Largely implemented / advanced capture follow-through pending (2026-03-11 audit)**
- ✅ Procedural memory extraction from clusters of similar episodic summaries exists.
- ✅ Confidence evolution, success/failure history, and auto promote/archive behavior exist.
- ✅ Skill materialization/export to `.claude/skills/<name>/SKILL.md` exists.
- ✅ Skill ingestion/indexing for `.claude/skills/`, `.claude/commands/`, `CLAUDE.md`, and `agents.md` exists.
- ✅ Knowledge capture service exists for resolved interventions, recurring error clusters, and PR feedback, and is wired into current runtime flows.
- Remaining: validate coverage, fill end-to-end gaps, polish the review/inspection UX around these advanced capture sources, and move durable skill export/storage into the `.ade/` model.

**W5b — Automations Full: Mostly implemented (2026-03-11 audit)**
- ✅ Automations tab, rule builder/planner, run history, usage surfaces, and Night Shift scheduling/queue plumbing are present in the product.
- ✅ Automation briefing assembly and employee-memory mode exist in the runtime, using the same memory briefing service as other agent paths.
- ✅ CTO-owned Linear intake vs automation-trigger boundary is implemented in product docs and current UI direction.
- ✅ Webhook/GitHub ingress, tool allowlists, executor routing, and automation-to-mission dispatch are present in the current runtime.
- Remaining: tighten the overnight review/publish UX, finish external-MCP follow-through once W8 exists, and clean up any remaining executor/runtime edge cases.

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

**W10 — .ade/ Portable State: Partial foundation exists**
- ✅ CTO and worker identity/core-memory/session files already live under `.ade/cto/` and `.ade/agents/`, with file-vs-DB reconciliation behavior in code.
- ✅ Current config layering already uses `.ade/ade.yaml` + `.ade/local.yaml`.
- Remaining: decide and implement the selective git-tracked/shareable subset for `.ade/`, add startup validation/integrity tooling, add config reload where needed, consolidate durable exports under `.ade/`, and land the one-time migration/health surfaces.
- Current limitation: ADE still excludes the entire `.ade/` directory via `.git/info/exclude`, so the portable-shareable model described here is not the live behavior yet.

### Cross-Cutting: Orchestrator + Mission UX Hardening (2026-03-09)

While Phase 4 workstreams focus on CTO ecosystem features, the orchestrator baseline continues to be hardened independently. Recent changes (documented in `docs/ORCHESTRATOR_OVERHAUL.md`) include:

- Kernel hardening: forced finalize removal, phase gating tightened to require success not just termination, intervention keying by ID
- Mission UX: Workers/Ops tab removed (consolidated into chat threads + step detail), planning prompt preview added, chat signal filtering to suppress low-signal noise
- Worker delivery: durable retry pipeline with in-flight lease tracking, startup replay, recovery interventions on exhausted retries
- MCP: tool visibility scoping fix to prevent over-exposing internal tools

These changes improve the foundation that Phase 4 workstreams (especially W-UX, W7b) build on.

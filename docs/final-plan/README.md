# ADE Final Plan (Canonical Roadmap)

This plan has been split into individual phase files for maintainability. Each phase file contains the full detailed plan for that phase.

## Table of Contents

- [Phases 1-2: Foundation (Complete)](phases-1-2.md)
- [Phase 3: AI Orchestrator + Missions Overhaul](phase-3.md)
- [Phase 4: CTO + Ecosystem](phase-4.md)
- [Phase 5: Play Runtime Isolation](phase-5.md)
- [Phase 5.5: Compute Backend Abstraction](phase-5.5.md)
- [Phase 6: Integration Sandbox](phase-6.md)
- [Phase 7: Core Extraction](phase-7.md)
- [Phase 8: Relay + Machines](phase-8.md)
- [Phase 9: iOS Control App](phase-9.md)
- [Appendix: Rules, Risks, KPIs](appendix.md)

---

Last updated: 2026-03-04
Owner: ADE
Status: Active

---

## Orchestrator Rebased Track (2026-03-04)

For all remaining Phase 3 orchestrator work, see `docs/ORCHESTRATOR_OVERHAUL.md` (canonical source of truth). The `final-plan/phase-3.md` file is superseded.

---

## 1. Purpose

This file is the canonical implementation roadmap for future ADE work.

- `docs/PRD.md` remains the product behavior/scope reference.
- This plan defines execution order, dependencies, and delivery gates.
- Feature and architecture docs should align to this file for forward-looking sequencing.
- Phase 3 (`phase-3.md`) contains the complete orchestrator autonomy and missions overhaul plan.

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

- Lane/worktree lifecycle with stacks, rebase suggestions, auto-rebase status
- PTY sessions with transcripts, summaries, deltas, and lane-scoped quick launch profiles
- File explorer/editor with watch/search/quick-open and atomic writes
- Full git workflow coverage for day-to-day branch operations
- Conflict prediction, risk matrix, merge simulation, proposal apply/undo, external resolver runs
- PR workflows (including stacked and integration PR paths)
- Packs/checkpoints/version/event pipeline with bounded exports
- Context-doc pipeline: `.ade/context/PRD.ade.md` + `.ade/context/ARCHITECTURE.ade.md` generation (AI-assisted with deterministic digest fallback) and digest-ref-first orchestrator consumption
- Automations engine + natural-language planner
- Mission intake/tracking lifecycle (status lanes, steps, interventions, artifacts, events)
- Deterministic orchestrator runtime: DAG scheduling, claims, context snapshots, timeline, gate evaluator
- AI-driven planner/runtime adapters for Claude and Codex with mission-step schema validation and retry logic
- Coordinator-owned mission orchestration (persistent coordinator agent, runtime event routing, fail-hard startup semantics)
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
- **MCP Server Overhaul (shipped 2026-02-26):** MCP server expanded to 35 tools as full headless orchestration API — mission lifecycle (8), observation (8), evaluation (3), plus 16 existing tools. Enables external evaluators and Claude Code integration.
- **MCP Dual-Mode Architecture (shipped 2026-02-26):** Transport abstraction (WS8), headless AI integration (WS9), desktop socket embedding at `.ade/mcp.sock` (WS10), smart entry point auto-detection (WS11). Same 35 tools in headless (stdio) and embedded (socket) modes.
- **Project Hivemind features (shipped 2026-02-25):**
  - Slack-like mission chat with sidebar channels, global view, @mentions, real-time updates (`MissionChatV2.tsx`, `MentionInput.tsx`)
  - Inter-agent message delivery to PTY and SDK agents (`deliverMessageToAgent`, `teamMessageTool`)
  - Shared facts, project memories, and run narrative in agent prompts (`buildFullPrompt`, `appendRunNarrative`)
  - Smart fan-out via meta-reasoner: dynamic step injection, fan-out completion tracking, autopilot integration (`metaReasoner.ts`)
  - Context compaction engine: 70% threshold, pre-compaction writeback, transcript JSONL, attempt resume (`compactionEngine.ts`, `attempt_transcripts` table)
  - Memory architecture: agent identities table, promotion flow (candidate/promoted/archived), auto-promotion, Context Budget Panel
  - Activity narrative: Run Narrative section in Activity tab
  - UI bug fixes: removed `ExecutionPlanPreview`, fixed duplicate progress bar, fixed DAG SVG spinning animation, tab renames (usage->details, channels->chat)
- **Codebase Refactoring & Modularization (shipped 2026-03-02):** AI orchestrator decomposed (`aiOrchestratorService.ts` 13.2K -> 7.7K lines + 9 extracted modules). Pack service decomposed (`packService.ts` 5.7K -> 3.2K lines + 4 builder modules). Type system modernized (monolithic `types.ts` replaced by `src/shared/types/` with 17 domain modules). Frontend decomposed (`MissionsPage.tsx` 60% reduction, `WorkspaceGraphPage.tsx` 11 extracted files). Shared backend/frontend utilities consolidated. Net -14,370 lines, 0 TypeScript errors.

### 2.3 Architectural leverage and constraints

- Main process is already service-oriented and extraction-friendly.
- IPC surface is broad (`234` channels in `apps/desktop/src/shared/ipc.ts`).
- `registerIpc.ts` concentration remains a known extraction bottleneck (targeted for Phase 7).
- Core product behavior is local-first and fully operational without any cloud backend.
- Orchestrator runtime (deterministic kernel) is shipped infrastructure; AI orchestration sits on top.
- Runtime execution flow is single-path (`aiIntegrationService` -> executor/unified runtime); no legacy hosted/BYOK migration branch remains in call flow.
- Developer baseline assumes modern Git CLI semantics (worktrees, `restore`, `merge-tree --write-tree`, `--ignore-other-worktrees`).
- **Codebase modularized (2026-03-02)**: AI orchestrator decomposed into 9 domain modules (42% size reduction), pack service decomposed into 4 builder modules (45% reduction), type system split into 17 domain files, frontend components decomposed (MissionsPage 60% reduction). Shared utilities consolidated. This decomposition directly enables Phase 7 core extraction.

### 2.4 Confirmed gaps

Not implemented yet:

- Remaining Phase 3 work (subagent delegation, validation enforcement, UI observability, reflection protocol — see `docs/ORCHESTRATOR_OVERHAUL.md` Phases 4-7)
- CTO agent (persistent project-aware assistant, replaces Concierge)
- Night Shift mode in Automations (overnight execution with morning briefing)
- Play runtime isolation stack (ports/routing/preview/profile isolation)
- Compute backend abstraction (local/VPS/Daytona)
- Integration sandbox for lane-set verification
- `packages/core` extraction
- Relay and machine registry/routing
- iOS control app
- Mission Introspection (reflection protocol for system self-improvement)
- Provider usage telemetry parity (CLI/API/local) and budget UX refinements

### 2.5 Phase 3 Status Snapshot (2026-03-02 update)

Phase 3 encompasses both orchestrator autonomy and the missions overhaul. The codebase was significantly refactored in Wave 4 (2026-03-02), decomposing the orchestrator, pack service, type system, and frontend into modular architectures to improve maintainability and prepare for Phase 7 core extraction.

Implemented in baseline:

1. **Task 1: Orchestrator Autonomy Core** — team runtime schema/capability enforcement, structured reporting tools, autonomous `revise_plan` with supersede semantics, role tool profiles, `partially_completed` + recovery handoff
2. **Task 2: Validation & Lane Continuity** — validation contract/reporting primitives, open-obligation surfacing, lane continuity for replacement/rework, explicit lane transfer audit trail

Remaining execution tracks (see `ORCHESTRATOR_OVERHAUL.md` for current plan):

3. **Task 3: Mission Phases Engine & Profiles** — implemented (Task 3)
4. **Task 4: Mission UI Overhaul** — implemented (Task 4)
5. **Task 5: Pre-Flight, Intervention & HITL** — implemented (Task 5)
6. **Task 6: Budget & Usage Tracking** — implemented (Task 6)
7. **Tasks 7-8** — superseded by ORCHESTRATOR_OVERHAUL.md Phases 4-7 (subagent delegation, validation enforcement, UI observability, reflection protocol)

Tasks 1-6 are baseline. Remaining work is tracked in `docs/ORCHESTRATOR_OVERHAUL.md`.

---

## 3. North Star

ADE becomes the execution control plane for parallel agentic development:

1. Users execute AI tasks through configured providers (CLI subscriptions, API/OpenRouter, or local endpoints) without any ADE-hosted account/sign-up requirement.
2. ADE's `AgentExecutor` interface unifies agent SDKs -- `ai-sdk-provider-claude-code` for Claude and `@openai/codex-sdk` for Codex -- spawning CLIs against user subscriptions.
3. The AI orchestrator coordinates missions via MCP tools exposed by the ADE MCP server; the same server provides a full headless orchestration API for external agents, evaluators, and CI/CD integration.
4. Missions, lanes, packs, conflicts, and PRs share one coherent execution model.
5. Desktop, relay machines, and iOS share one mission/audit state model.
6. All core features work in `guest` mode (no AI) -- AI orchestration is additive, never mandatory.
7. ADE state (memory, agents, history) is portable across machines via `.ade/` in git -- no cloud backend needed for sync.
8. CTO agent provides persistent project-aware assistance with full memory and context; external agent systems connect via MCP server.

---

## 4. Feature Coverage Matrix

Every planned feature in this roadmap is assigned to exactly one primary build phase.

| Feature | Primary Phase | Depends On | Status |
|---|---|---|---|
| Agent SDK integration + AgentExecutor interface | Phase 1 | Current baseline | Complete |
| Agent Chat integration (Codex App Server, Claude SDK, unified API/local runtime) | Phase 1.5 | Phase 1 (partial — SDK wiring) | Complete |
| MCP server | Phase 2 | Phase 1 | Complete |
| AI orchestrator | Phase 3 | Phases 1 and 2 | In progress (Tasks 1-6 shipped; remaining work in `ORCHESTRATOR_OVERHAUL.md` Phases 4-7) |
| Mission team runtime model (roles/templates) | Phase 3 | Phases 1 and 2 | Implemented (Task 1 baseline) |
| Validation contracts + validator loop | Phase 3 | Phases 1 and 2 | Implemented (Task 2 baseline, coordinator-driven loop) |
| Mission policy flags + precedence | Phase 3 | Phases 1 and 2 | Implemented (Task 1 baseline) |
| Structured worker reporting + mission status read | Phase 3 | Phases 1 and 2 | Implemented (Task 1 baseline) |
| Lane-affinity rework continuity + partial completion | Phase 3 | Phases 1 and 2 | Implemented (Task 1/2 baseline) |
| Mission Phases Engine (configurable phase pipelines) | Phase 3 | Phase 3 | Implemented (Task 3) |
| Phase Profiles (settings-based mission templates) | Phase 3 | Phase 3 | Implemented (Task 3) |
| Mission Plan Tab (hierarchical task list, real-time) | Phase 3 | Phase 3 | Implemented (Task 4) |
| Mission Work Tab (follow-mode worker output) | Phase 3 | Phase 3 | Implemented (Task 4) |
| Pre-Mission Launch System (pre-flight checklist) | Phase 3 | Phase 3 | Implemented (Task 5) |
| Tiered Validation System (self/spot-check/gate) | Phase 3 | Phase 3 | Implemented (Task 5) |
| Intervention Granularity (per-worker pause) | Phase 3 | Phase 3 | Implemented (Task 5) |
| CTO Agent (persistent project-aware assistant) | Phase 4 | Phase 3 | Planned |
| Night Shift Mode (in Automations) | Phase 4 | Phase 3 | Planned |
| Budget Management (subscription + API key) | Phase 3 | Phase 3 | Implemented (Task 6) |
| Play runtime isolation | Phase 5 | Phase 3 | Planned |
| Compute backend abstraction | Phase 5.5 | Phase 5 | Planned |
| Computer Use (agent GUI interaction) | Phase 5.5 | Phase 5 | Planned |
| E2B compute backend | Phase 5.5 | Phase 5 | Planned |
| Learning Packs (auto-curated knowledge) | Phase 4 | Phase 3 | Planned |
| Integration sandbox + readiness gates | Phase 6 | Phase 5 | Planned |
| Core extraction (`packages/core`) | Phase 7 | Phases 3, 5, 6 | Planned |
| Relay + Machines | Phase 8 | Phase 7 | Planned |
| iOS app | Phase 9 | Phase 8 | Planned |
| Memory Architecture Upgrade (vector search, tiers) | Phase 4 | Phase 3 | Planned |
| Candidate Memory Triage Automation (auto-promote + stale archive sweep) | Phase 4 | Phase 3 memory lifecycle baseline | Planned (covered in Phase 4 W3) |
| Mem0 Sidecar Integration (optional semantic index) | Post-Phase 4 | Phase 4 memory foundation | Deferred (evaluate after native memory upgrade + CTO baseline) |
| Skill Library (recipe extraction + `.claude/skills/` materialization) | Phase 4 | Phase 4 Learning Packs + PROJ-039 viewer baseline | Planned (covered in Phase 4 W4) |
| .ade/ Portable State | Phase 4 | Phase 3 | Planned |
| External MCP Consumption | Phase 4 | Phase 3 | Planned |
| OpenClaw Bridge (External Agent Gateway) | Phase 4 | Phase 4 W1 (CTO) | Planned |
| Pre-compaction Memory Flush | Phase 4 | Phase 3 (HW6) | Planned |
| Memory Consolidation | Phase 4 | Phase 3 | Planned |
| Episodic + Procedural Memory | Phase 4 | Phase 3 | Planned |
| Mission Introspection (reflection protocol, retrospectives) | Phase 3 | Phase 3 | Planned (ORCHESTRATOR_OVERHAUL.md Phase 7) |
| Subscription Usage Tracking (local CLI data analysis) | Phase 3 | Phase 3 | Planned |
| Missions Home Dashboard (aggregate stats, history) | Phase 3 | Phase 3 | Implemented (Task 4) |

---

## 5. Delivery Rules (All Phases)

- No phase ships with undocumented safety bypass defaults.
- Every new execution path emits durable event/audit records.
- Every phase keeps runtime call flow migration-free (no legacy compatibility branching in active execution paths).
- Every phase includes automated test coverage additions.
- Every phase updates impacted docs in the same delivery window.

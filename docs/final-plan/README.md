# ADE Final Plan (Canonical Roadmap)

This plan has been split into individual phase files for maintainability. Each phase file contains the full detailed plan for that phase.

## Table of Contents

- [Phases 1-3: Foundation (Phase 3 Completion In Progress)](phases-1-3.md)
- [Phase 4: Agents Hub](phase-4.md)
- [Phase 5: Play Runtime Isolation](phase-5.md)
- [Phase 5.5: Compute Backend Abstraction](phase-5.5.md)
- [Phase 6: Integration Sandbox](phase-6.md)
- [Phase 7: Core Extraction](phase-7.md)
- [Phase 8: Relay + Machines](phase-8.md)
- [Phase 9: iOS Control App](phase-9.md)
- [Appendix: Rules, Risks, KPIs](appendix.md)

---

Last updated: 2026-02-27
Owner: ADE
Status: Active

---

## 1. Purpose

This file is the canonical implementation roadmap for future ADE work.

- `docs/PRD.md` remains the product behavior/scope reference.
- This plan defines execution order, dependencies, and delivery gates.
- Feature and architecture docs should align to this file for forward-looking sequencing.
- `docs/phase-3-gaps.md` is the active completion blueprint for remaining Phase 3 orchestrator autonomy work.

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

### 2.3 Architectural leverage and constraints

- Main process is already service-oriented and extraction-friendly.
- IPC surface is broad (`234` channels in `apps/desktop/src/shared/ipc.ts`).
- `registerIpc.ts` concentration remains a known extraction bottleneck.
- Core product behavior is local-first and fully operational without any cloud backend.
- Orchestrator runtime (deterministic kernel) is shipped infrastructure; AI orchestration sits on top.

### 2.4 Confirmed gaps

Not implemented yet:

- Phase 3 completion package for full autonomous orchestration (team runtime model, validator loop contracts, policy flags, structured worker reporting, lane-affinity rework continuity)
- Agents hub (unified autonomous agent system — automation, Night Shift, watcher, review agents)
- Agent identities as full persona/policy bundles (schema exists in `agent_identities` table from Hivemind WS7, but full Phase 4 identity system not yet built)
- Morning Briefing (swipeable card review for overnight results)
- Play runtime isolation stack (ports/routing/preview/profile isolation)
- Compute backend abstraction (local/VPS/Daytona)
- Integration sandbox for lane-set verification
- `packages/core` extraction
- Relay and machine registry/routing
- iOS control app

### 2.5 Phase 3 Completion Focus (2026-02-27 update)

To align with autonomy goals, the remaining Phase 3 work now explicitly includes:

1. Team runtime foundations (required roles + role-aware worker spawning)
2. Structured worker reporting (`report_status`, `report_result`, `read_mission_status`)
3. Autonomous re-planning (`revise_plan` with supersede semantics)
4. Validation contracts + validator loops at step/milestone/mission gates
5. Lane-affinity rework continuity and partial-completion outcomes
6. Budget-aware orchestration decisions and mission-level tool profile control

This keeps deterministic code as runtime/safety infrastructure while preserving AI-led execution strategy.

---

## 3. North Star

ADE becomes the execution control plane for parallel agentic development:

1. Users execute AI tasks via existing CLI subscriptions (Claude Pro/Max, ChatGPT Plus) -- no API keys, no sign-up.
2. ADE's `AgentExecutor` interface unifies agent SDKs -- `ai-sdk-provider-claude-code` for Claude and `@openai/codex-sdk` for Codex -- spawning CLIs against user subscriptions.
3. The AI orchestrator uses in-process Vercel AI SDK coordinator tools for mission coordination; the MCP server exposes ADE capabilities as a full headless orchestration API for external agents, evaluators, and CI/CD integration.
4. Missions, lanes, packs, conflicts, and PRs share one coherent execution model.
5. Desktop, relay machines, and iOS share one mission/audit state model.
6. All core features work in `guest` mode (no AI) -- AI orchestration is additive, never mandatory.
7. ADE state (memory, agents, history) is portable across machines via `.ade/` in git -- no cloud backend needed for sync.
8. External agent systems connect via MCP server; the Concierge Agent routes development requests.

---

## 4. Feature Coverage Matrix

Every planned feature in this roadmap is assigned to exactly one primary build phase.

| Feature | Primary Phase | Depends On | Status |
|---|---|---|---|
| Agent SDK integration + AgentExecutor interface | Phase 1 | Current baseline | Complete |
| Agent Chat integration (Codex App Server + Claude SDK) | Phase 1.5 | Phase 1 (partial — SDK wiring) | Complete |
| MCP server | Phase 2 | Phase 1 | Complete |
| AI orchestrator | Phase 3 | Phases 1 and 2 | In progress (Hivemind shipped; autonomy completion package W13-W22 remaining) |
| Mission team runtime model (roles/templates) | Phase 3 | Phases 1 and 2 | Planned (Phase 3 completion package) |
| Validation contracts + validator loop | Phase 3 | Phases 1 and 2 | Planned (Phase 3 completion package) |
| Mission policy flags + precedence | Phase 3 | Phases 1 and 2 | Planned (Phase 3 completion package) |
| Structured worker reporting + mission status read | Phase 3 | Phases 1 and 2 | Planned (Phase 3 completion package) |
| Lane-affinity rework continuity + partial completion | Phase 3 | Phases 1 and 2 | Planned (Phase 3 completion package) |
| Agents hub (Automations → Agents rebrand) | Phase 4 | Phase 3 | Planned |
| Agent identities | Phase 4 | Phase 3 | Planned |
| Night Shift agents | Phase 4 | Phase 3 | Planned |
| Watcher & Review agents | Phase 4 | Phase 3 | Planned |
| Morning Briefing UI | Phase 4 | Phase 3 | Planned |
| Play runtime isolation | Phase 5 | Phase 3 | Planned |
| Compute backend abstraction | Phase 5.5 | Phase 5 | Planned |
| Task Agents (one-off background agents) | Phase 4 | Phase 3 | Planned |
| Computer Use (agent GUI interaction) | Phase 5.5 | Phase 5 | Planned |
| E2B compute backend | Phase 5.5 | Phase 5 | Planned |
| Lane-level artifacts | Phase 4 | Phase 3 | Planned |
| Learning Packs (auto-curated knowledge) | Phase 4 | Phase 3 | Planned |
| Chat-to-mission escalation | Phase 4 | Phase 3 | Planned |
| Integration sandbox + readiness gates | Phase 6 | Phase 5 | Planned |
| Core extraction (`packages/core`) | Phase 7 | Phases 3, 5, 6 | Planned |
| Relay + Machines | Phase 8 | Phase 7 | Planned |
| iOS app | Phase 9 | Phase 8 | Planned |
| Concierge Agent | Phase 4 | Phase 3 | Planned |
| Memory Architecture Upgrade (vector search, tiers) | Phase 4 | Phase 3 | Planned |
| .ade/ Portable State | Phase 4 | Phase 3 | Planned |
| External MCP Consumption | Phase 4 | Phase 3 | Planned |
| Pre-compaction Memory Flush | Phase 4 | Phase 3 (HW6) | Planned |
| Memory Consolidation | Phase 4 | Phase 3 | Planned |
| Episodic + Procedural Memory | Phase 4 | Phase 3 | Planned |

---

## 5. Delivery Rules (All Phases)

- No phase ships with undocumented safety bypass defaults.
- Every new execution path emits durable event/audit records.
- Every phase includes migration notes for existing local state.
- Every phase includes automated test coverage additions.
- Every phase updates impacted docs in the same delivery window.

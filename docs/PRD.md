# ADE — Product Requirements

ADE is an Electron desktop app for AI-assisted software engineering. It orchestrates lanes of work (git-worktree isolation), multi-provider AI chat, multi-agent missions, a persistent CTO agent, pipeline automations, PR stacking, conflict simulation, computer-use proofs, a cross-scope memory system, and optional iOS companion sync.

This doc is the entry point. Every major feature and concept is linked to its detailed breakdown in [`features/`](./features/). For how the pieces fit together, read [ARCHITECTURE.md](./ARCHITECTURE.md) next.

---

## What ADE Is

ADE is a single-user, project-local workbench that runs AI agents against your codebase without them stepping on each other. The primary unit is a **lane**: an isolated git worktree + runtime + agent session. You can run many lanes concurrently — each with its own chat, its own processes, its own PR. Lanes compose into **stacks** (dependency chains) and graduate into **missions** (multi-agent, multi-step orchestrated runs) when the work is bigger than a single session.

Layered on top:
- **Agents** — chat, CTO operator, workers. Multi-provider (Anthropic, OpenAI, Claude Code CLI, Codex, OpenCode, Cursor). Tool-aware.
- **Memory** — persistent knowledge across sessions. Scoped to global/project/session/agent.
- **Automations** — rule-based background workflows triggered by events, cron, webhooks.
- **Computer use** — control plane that fans out to Ghost OS, agent-browser, or local fallback for UI automation proofs.
- **Linear** — first-class two-way integration owned by the CTO agent.
- **Multi-device sync** — cr-sqlite CRDT replication between desktop and iOS companion.

ADE is the control plane. It does not execute browser automation or computer-use itself — it dispatches to backends and normalizes their artifacts.

---

## Core Concepts

| Concept | Summary | Doc |
| --- | --- | --- |
| Lane | Isolated git worktree + runtime + agent session for one task. | [lanes/README.md](./features/lanes/README.md) |
| Stack | Dependency chain of lanes → stacked PRs. | [lanes/stacking.md](./features/lanes/stacking.md) |
| Mission | Multi-step orchestrated run with a coordinator agent, sub-workers, validation gates, and a result lane. | [missions/README.md](./features/missions/README.md) |
| Agent | Typed persona with identity, tool tier, budget, and session log. CTO + workers + chat agents. | [agents/README.md](./features/agents/README.md) |
| Worktree | Git clone dir under `.ade/worktrees/<lane-id>/`, one per lane. | [lanes/worktree-isolation.md](./features/lanes/worktree-isolation.md) |
| Runtime | Per-lane process pool + env + ports + proxy + diagnostics. | [lanes/runtime.md](./features/lanes/runtime.md) |
| Session | PTY-backed terminal session pinned to a lane. | [terminals-and-sessions/README.md](./features/terminals-and-sessions/README.md) |
| Context pack | Canonical `.ade/context/*.ade.md` docs generated from repo state. | [context-packs/README.md](./features/context-packs/README.md) |
| Memory | Structured, searchable, compaction-aware knowledge entries. | [memory/README.md](./features/memory/README.md) |
| Proof | Normalized computer-use artifact (screenshot, recording, network log). | [computer-use/artifact-broker.md](./features/computer-use/artifact-broker.md) |

---

## Feature Index

### Work execution

- [**Lanes**](./features/lanes/README.md) — Worktree isolation, stacking, runtime, OAuth redirect, diagnostics. Each lane is a sandbox. Stacks are dependency chains. Runtime covers ports, env, proxy, processes.
- [**Pull Requests**](./features/pull-requests/README.md) — Stacked PRs, merge queue, conflict simulation. Backed by lanes; dependencies rebase automatically.
- [**Conflicts**](./features/conflicts/README.md) — Pre-flight detection (full pairwise matrix up to 15 lanes, prefilter above), live simulation via `git merge-tree`, AI-assisted resolution, external CLI resolver flow.
- [**Workspace Graph**](./features/workspace-graph/README.md) — React Flow canvas projecting lanes/PRs/conflicts/sessions into a single view. Staged hydration (topology first, then activity/risk/sync).

### Agents and chat

- [**Agents**](./features/agents/README.md) — Three surfaces: chat, CTO operator, workers. Identity, capability modes, tool tiers, heartbeats.
- [**Chat**](./features/chat/README.md) — Multi-provider, streaming, tool-aware. Transcript and turns, tool system (universal/workflow/coordinator), agent routing, composer + derived panels.
- [**Memory**](./features/memory/README.md) — Unified SQLite + FTS + embeddings. Write gate, compaction, procedural learning, daily sweep, hybrid retrieval (BM25+cosine+MMR).
- [**History**](./features/history/README.md) — Operations timeline + chat transcripts + exports. Every service follows the same `runTrackedOperation` recording pattern.

### Orchestration

- [**Missions**](./features/missions/README.md) — Coordinator agent, delegation graph, validation gates (19 VAL-XXX assertions), result-lane closeout, worker fan-out.
- [**Automations**](./features/automations/README.md) — Rule triggers (time, action, webhook) → three execution surfaces (mission, agent-session, built-in). Confidence + verification + human review.
- [**CTO**](./features/cto/README.md) — Persistent project-level AI operator with four-layer prompt model. Owns Linear workflows, pipeline builder, worker team, identity/memory.

### Workspace surfaces

- [**Terminals and Sessions**](./features/terminals-and-sessions/README.md) — PTY, session, and managed-process services. Multi-run process lifecycle keyed by `runId`, AI-title pipeline, lazy resume-target hydration, stale reconciliation.
- [**Files and Editor**](./features/files-and-editor/README.md) — Atomic writes, ref-counted chokidar watcher, file search index, Monaco surfaces (edit/diff/conflict), preload trust boundary.
- [**Project Home**](./features/project-home/README.md) — Combined welcome + per-lane runtime dashboard. Loads lane-independent metadata vs lane runtime separately.
- [**Onboarding and Settings**](./features/onboarding-and-settings/README.md) — First-run wizard (stack detection, suggested config, import), 8-tab settings, configuration schema with trust model.

### Integrations

- [**Linear Integration**](./features/linear-integration/README.md) — Webhook + relay + reconciliation. Workflow presets, target types (mission/session/worker/PR), bidirectional sync.
- [**Computer Use**](./features/computer-use/README.md) — Control plane for Ghost OS, agent-browser, ADE local backends. Canonical artifact model, ownership-linked storage.
- [**Context Packs**](./features/context-packs/README.md) — Three notions: canonical docs, live exports, persisted packs. Event-driven regeneration with seven refresh events.
- [**Sync and Multi-Device**](./features/sync-and-multi-device/README.md) — cr-sqlite CRDT (desktop native ext, iOS pure-SQL emulation). Host/controller model. WebSocket envelope. Remote commands.

---

## Cross-Cutting Architecture

For the system-wide picture — apps, processes, data plane, IPC, security, build/test/deploy — read [**ARCHITECTURE.md**](./ARCHITECTURE.md).

Quick pointers:

- **Apps**: `apps/desktop/` (Electron main + preload + renderer), `apps/mcp-server/` (headless MCP tool server), `apps/web/` (marketing), `apps/ios/` (companion).
- **Main-process services**: `apps/desktop/src/main/services/<domain>/` — one directory per capability.
- **Renderer components**: `apps/desktop/src/renderer/components/<feature>/`.
- **Shared types + IPC contract**: `apps/desktop/src/shared/`.
- **Data**: SQLite + cr-sqlite. `.ade/` per project, `~/.ade/` global.

---

## For AI Agents Reading This

If you are an AI agent working on ADE, read in this order:

1. **This PRD** — product scope + feature index.
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the apps fit, where state lives, IPC contract, services catalog.
3. **Feature READMEs** — pick only the features relevant to your task. Each README has a "Source file map" at the top so you can go straight to code.
4. **Detail docs** — when you need depth on a specific area (e.g., `features/cto/pipeline-builder.md` for pipeline internals).

The source of truth is always the code. Docs may lag on specific code paths — cross-check `git log` and the referenced files when in doubt.

Fragile areas flagged across the docs (read docs before editing):
- CTO pipeline builder — recent work, custom flat/nested target-chain translation.
- PTY / sessions / processes services — rewritten this branch.
- OAuth redirect service — complex three-state machine with HMAC signing.
- Chat transcript render pipeline — two-layer event→state→render path.
- Mission coordinator delegation — 19 VAL-XXX behavioral invariants.

---

## Out of scope (deliberate non-goals)

- ADE does not run browser automation or accessibility-based UI control itself. It is a control plane; executors run elsewhere (Ghost OS, agent-browser CLI).
- ADE does not host remote git servers. It operates on local worktrees against a GitHub remote.
- ADE does not multiplex multiple users. Single-user, project-local.
- ADE does not ship a server-side web app. The `apps/web/` is marketing/docs-site only.

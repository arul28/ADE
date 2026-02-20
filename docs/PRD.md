# ADE (Agentic Development Environment) - Product Requirements Document

Last updated: 2026-02-20

Roadmap source of truth: `docs/final-plan.md` (this PRD captures product scope and core behavior; future sequencing lives in Final Plan).

---

## Table of Contents

1. [Product Overview](#1-product-overview)
2. [Vision and Problem Statement](#2-vision-and-problem-statement)
3. [Target Users](#3-target-users)
4. [Core Concepts and Glossary](#4-core-concepts-and-glossary)
5. [System Architecture](#5-system-architecture)
6. [Technology Stack](#6-technology-stack)
7. [Application Structure (Tabs)](#7-application-structure-tabs)
   - 7.1 [Run](#71-run-)
   - 7.2 [Lanes](#72-lanes)
   - 7.3 [Files](#73-files)
   - 7.4 [Terminals](#74-terminals)
   - 7.5 [Conflicts](#75-conflicts)
   - 7.6 [Context](#76-context)
   - 7.7 [Graph](#77-graph)
   - 7.8 [PRs](#78-prs)
   - 7.9 [History](#79-history)
   - 7.10 [Automations](#710-automations)
   - 7.11 [Missions](#711-missions)
   - 7.12 [Settings](#712-settings)
8. [Feature Documentation](#8-feature-documentation)
9. [Architecture Documentation](#9-architecture-documentation)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
    - 10.1 [Packs (Context and History System)](#101-packs-context-and-history-system)
    - 10.2 [Automations](#102-automations)
    - 10.3 [Workspace Graph](#103-workspace-graph)
    - 10.4 [Job Engine](#104-job-engine)
    - 10.5 [AI Integration](#105-ai-integration)
11. [Security and Privacy](#11-security-and-privacy)
12. [Configuration Model](#12-configuration-model)
13. [Non-Goals and Out of Scope](#13-non-goals-and-out-of-scope)
14. [Success Metrics](#14-success-metrics)
15. [Implementation Phases](#15-implementation-phases)
16. [Risks and Mitigations](#16-risks-and-mitigations)

---

## 1. Product Overview

ADE (Agentic Development Environment) is a desktop application that serves as a development operations cockpit for agentic coding workflows. It provides developers with a unified control plane to manage multiple parallel development lanes (git worktrees), terminal sessions, managed processes, test suites, and project configuration. ADE automates context tracking through its Packs system, predicts conflicts between parallel work streams, and orchestrates AI-powered multi-agent workflows through its AI Integration Layer -- native agent SDKs unified behind an AgentExecutor interface, a local MCP server, and an AI orchestrator that coordinates agents (Claude Code, Codex) using the developer's existing CLI subscriptions.

ADE is built with Electron and ships as a cross-platform desktop application for macOS, Windows, and Linux.

---

## 2. Vision and Problem Statement

### The Problem

Software teams increasingly use AI coding agents (Claude Code, Codex, Cursor, and others) that work in parallel across branches. This parallel agentic workflow creates compounding challenges:

- **Context fragmentation**: Developers lose track of what each agent session accomplished across multiple branches.
- **Integration risk**: Parallel work on overlapping files leads to merge conflicts discovered too late, at merge time.
- **Context-switching overhead**: Moving between branches, terminals, and tools requires mental reconstruction of each work stream's state and intent.
- **Lack of observability**: There is no single view showing what is happening across all active development surfaces simultaneously.
- **No unified orchestration**: Developers manually coordinate which agent works on what, in which branch, with what context. There is no system to plan, dispatch, and supervise multi-agent workflows end to end.

### The Vision

ADE is the orchestration layer for agentic development. It watches what each agent does, tracks context through immutable checkpoints and durable packs, predicts conflicts between parallel work, and surfaces integration risks before they become merge nightmares. Its AI orchestrator -- powered by native agent SDKs and a local MCP server -- can plan multi-step missions, spawn agents into isolated lanes, inject context packs into agent prompts, and route human interventions back through the ADE UI. All AI execution is subscription-powered: developers use their existing Claude Pro/Max or ChatGPT Plus subscriptions through CLI tools spawned as subprocesses, with no separate accounts or credentials required.

Think of ADE as "mission control for agentic development."

ADE does not replace the IDE or the git CLI. It integrates deeply with external agent CLIs via tracked sessions, automation flows, and first-class mission/orchestrator execution as defined in `docs/final-plan.md`.

---

## 3. Target Users

- **Solo developers running multiple AI coding agents in parallel**: The primary user. Manages 3-10+ concurrent agent sessions across different features, needs a single view to understand the state of all work and predict integration issues.
- **Small teams managing complex branching strategies**: Teams of 2-5 developers using stacked PRs, parallel feature branches, and shared base branches. ADE provides visibility into how each team member's work interacts.
- **Developers who want IDE-like git workflow without leaving a dedicated tool**: Users who prefer a purpose-built tool for git operations, worktree management, and development process control rather than scattering those concerns across IDE plugins and terminal windows.

---

## 4. Core Concepts and Glossary

### Lane

A lane is the fundamental unit of parallel work in ADE. Each lane wraps a git branch and a workspace directory, providing an isolated development surface with its own terminal sessions, status tracking, and pack context.

Lane types:

- **Primary**: Points to the main repository directory. Default for users who work in-place. Cannot be deleted (only hidden/deactivated).
- **Worktree**: A dedicated git worktree created under `.ade/worktrees/`. The default lane creation path, providing full file isolation.
- **Attached**: Imports a pre-existing external worktree path as a lane, allowing ADE to manage worktrees created outside of ADE.

### Stack

A layered arrangement of lanes where each child branch is based on its parent lane's branch rather than on the project's default base branch. Stacks enable stacked PR workflows where changes are reviewed incrementally. Restacking propagates parent changes to children in dependency order.

### Pack

Packs are ADE's durable context system. They are structured bundles of context and history, produced automatically and maintained through immutable versioning. Pack types:

- **Project Pack**: Global project context including architecture map, conventions, and cross-lane risk signals.
- **Lane Pack**: Per-lane execution context including intent, acceptance criteria, checkpoint timeline, and touched files.
- **Feature Pack**: Issue-scoped aggregate across one or more lanes, sessions, and issues.
- **Conflict Pack**: Resolution context for predicted or active conflicts, including root-cause analysis and resolution strategies.
- **Plan Pack**: Versioned coding plans with immutable revisions, rationale, and handoff prompts.
- **Mission Pack**: Mission-level deterministic context snapshot (steps, interventions, orchestrator runs, handoffs) used for resume and audit.

### Checkpoint

An immutable execution snapshot created at session boundaries and commit boundaries. Each checkpoint captures SHA anchors, deterministic deltas (files changed, insertions, deletions), tool/agent metadata, validation context (test outcomes), and transcript references. Checkpoints are the atomic unit of ADE's history system.

### Session

A terminal session within a lane, tracked with rich metadata including title, goal, tool/agent type, start/end timestamps, head SHAs at start and end, exit code, and a linked checkpoint. Sessions produce transcripts stored locally by default.

### AI Integration Layer

The AI Integration Layer replaces the former cloud-based agent model with a fully local architecture. It consists of three components:

- **Agent SDKs**: The execution layer uses native SDKs for each agent: `ai-sdk-provider-claude-code` (community Vercel AI SDK provider wrapping `@anthropic-ai/claude-agent-sdk`) for Claude and `@openai/codex-sdk` (official OpenAI SDK) for Codex. ADE's `AgentExecutor` interface unifies both behind a common `execute()` / `resume()` contract. Each SDK spawns its CLI as a subprocess, inheriting the user's existing subscription authentication -- no separate credentials are needed.
- **MCP Server**: A local JSON-RPC 2.0 server (`apps/mcp-server`) that exposes ADE's infrastructure as tools to the AI orchestrator. Tools include `spawn_agent`, `read_context`, `create_lane`, `check_conflicts`, `merge_lane`, `ask_user`, `run_tests`, and others.
- **AI Orchestrator**: A Claude session (via the AgentExecutor interface) connected to the MCP server. The orchestrator receives mission prompts and context packs, plans multi-step workflows, spawns agents in separate lanes, monitors progress, and routes interventions to the user through the ADE UI.

The AI Integration Layer never mutates the repository directly. All file changes, git operations, and test runs are performed by the agents it spawns or by the user through the existing local core.

### Per-Task-Type Model Routing

Users can configure which AI model and provider to use for each task type. Task types include planning, implementation, review, conflict resolution, narratives, and PR descriptions. For example, a user might configure Claude for planning and code review while using Codex for implementation tasks.

### Job Engine

An asynchronous task scheduler that triggers on events (session end, head change, staged set change) and runs idempotent, coalesced jobs. The job engine coordinates the refresh pipeline: status update, checkpoint creation, pack materialization, conflict prediction, and AI augmentation requests.

---

## 5. System Architecture

ADE follows a strict trust boundary model with three process layers plus an AI Integration Layer:

```
ADE Desktop (Electron)
+-- Renderer (React UI)
|   +-- Missions tab (AI orchestrator control center)
|   +-- Activity feed (real-time agent output)
|   +-- Intervention panel (human-in-the-loop)
|   +-- All other tabs unchanged
+-- Main Process (Node.js, trusted)
|   +-- AI Integration Service
|   |   +-- AgentExecutor Interface (execution abstraction)
|   |   |   +-- ClaudeExecutor (ai-sdk-provider-claude-code, subscription)
|   |   |   +-- CodexExecutor (@openai/codex-sdk, subscription)
|   |   +-- AI Orchestrator (Claude session + MCP tools)
|   |   +-- Per-task-type model routing
|   +-- MCP Server (exposes ADE tools to AI)
|   +-- Existing Services (unchanged)
|   +-- SQLite (sql.js)
+-- Preload Bridge (typed IPC)
```

### Main Process (Trusted)

The Electron main process is the only component with filesystem and process access. It is responsible for:

- File I/O and atomic writes
- Git CLI operations (worktree management, diff, merge, rebase, status)
- PTY sessions via node-pty
- Managed process lifecycle (spawn, stop, restart, kill)
- Job engine and pipeline execution
- Local database (SQLite via sql.js)
- Pack materialization and checkpoint capture
- AI Integration Service (AgentExecutor interface, MCP server, orchestrator)

### Renderer Process (Untrusted UI)

The React-based renderer handles all user interface rendering. It never directly accesses the filesystem, spawns processes, or runs git commands. All operations are performed through typed IPC calls to the main process via the preload bridge.

### Preload Bridge

The preload script exposes a narrow, typed API surface to the renderer via Electron's `contextBridge`. It enforces a strict IPC channel allowlist. Context isolation is enabled and Node integration is disabled in the renderer.

### AI Integration Layer

The AI Integration Layer runs within the main process and provides all AI capabilities. It consists of:

- **Agent SDK executors**: ADE's `AgentExecutor` interface unifies two native SDKs behind a common `execute()` / `resume()` contract. The `ClaudeExecutor` uses `ai-sdk-provider-claude-code` (a community Vercel AI SDK provider that wraps `@anthropic-ai/claude-agent-sdk`) to spawn the `claude` CLI as a subprocess, inheriting the user's Claude Pro/Max subscription. The `CodexExecutor` uses `@openai/codex-sdk` (the official OpenAI SDK) to spawn the `codex` CLI directly, inheriting the user's ChatGPT Plus subscription. Both executors support streaming output, session management, and tool interception.
- **MCP Server**: A local server (`apps/mcp-server`) exposing ADE tools via JSON-RPC 2.0 over stdio transport. This gives the AI orchestrator programmatic access to ADE's lane management, context packs, conflict detection, test execution, and user intervention infrastructure.
- **AI Orchestrator**: A long-running Claude session connected to the MCP server. The orchestrator receives mission prompts enriched with context packs, decomposes them into steps, spawns agents in isolated lanes, monitors execution through checkpoints and session events, and escalates decisions to the user via the intervention panel.

### Provider Model

AI capabilities are gated by the provider mode:

- **Guest**: No AI features. All local features work (lanes, terminals, git operations, processes, tests, packs, conflict prediction). No CLI tools required. This is the default state and users can remain in it indefinitely.
- **Subscription**: Uses existing CLI subscriptions (Claude Pro/Max via `claude` CLI, ChatGPT Plus via `codex` CLI) through their respective SDKs. Each SDK spawns its CLI tool as a subprocess that inherits the user's subscription authentication. No separate credentials, accounts, or configuration are required beyond having the CLI tools installed and authenticated.

The deterministic pack pipeline functions regardless of provider mode. Packs, checkpoints, conflict prediction, lane management, and all local features operate without any AI provider.

For detailed architecture, see [Architecture Documentation](#9-architecture-documentation).

---

## 6. Technology Stack

### Desktop Application

| Layer | Technology |
|-------|-----------|
| Framework | Electron 40.x |
| UI | React 18, TypeScript |
| Bundling | Vite (renderer), tsup (main/preload) |
| Styling | Tailwind CSS 4, CSS variables for theme tokens |
| UI Primitives | Radix UI (headless, accessible) |
| Icons | Lucide |
| State Management | Zustand (renderer) |
| Database | SQLite via sql.js (main process) |
| Terminal | xterm.js (renderer), node-pty (main process), agent chat (Codex App Server + Claude multi-turn) |
| Editor/Diff | Monaco Editor (lazy-loaded) |
| Graph/Canvas | React Flow |
| Routing | React Router |
| Layout | react-resizable-panels |
| AI Execution | AgentExecutor interface (ADE-owned abstraction) |
| AI Providers | `ai-sdk-provider-claude-code` (Claude), `@openai/codex-sdk` (Codex) |
| Agent Chat | `AgentChatService` interface — `CodexChatBackend` (Codex App Server JSON-RPC 2.0), `ClaudeChatBackend` (community provider multi-turn `streamText()`) |
| AI Tool Protocol | MCP Server (`apps/mcp-server`), JSON-RPC 2.0, stdio transport |
| GitHub Integration | `gh` CLI (local), personal access tokens |

---

## 7. Application Structure (Tabs)

ADE uses a 12-tab application shell with a slim icon rail (50px) on the left side. The selected lane persists across tabs, allowing Run, Terminals, Conflicts, PRs, Files, and Missions tabs to default-filter to the active lane context. All local features work without any AI provider configured; AI-powered features (narratives, orchestrator, conflict proposals) require a subscription provider.

Current tab routes:
- `/project` (Play)
- `/lanes`
- `/files`
- `/terminals`
- `/conflicts`
- `/context`
- `/graph`
- `/prs`
- `/history`
- `/automations`
- `/missions`
- `/settings`

The detailed ownership model for future additions (including Machines) is maintained in `docs/final-plan.md`.

### 7.1 Run (▶)

The Run tab (denoted by a play/pause icon) is the project-level command center for running everything in your development stack. It includes a lane selector (determining which worktree commands execute in), a stack button row for one-click startup of configured process subsets, individual managed process controls with live log streaming, test suite buttons with run history, and a configuration editor. New in the Run tab: AI-suggested run prompts that detect new test suites or services after merges and propose new buttons; CI/CD workflow sync that imports jobs from GitHub Actions / GitLab CI / etc. as local run buttons; and an Agent CLI Tools section that detects installed AI coding tools (Claude Code, Codex, Cursor, Aider, Continue), displays their commands and skills, and provides quick-launch into tracked terminals.

See: [features/PROJECT_HOME.md](features/PROJECT_HOME.md)

### 7.2 Lanes

The Lanes tab is the primary cockpit and the core surface of ADE. It uses a 3-pane resizable layout: a left pane with the lane list (filterable by active/ready/archived) and topology mode toggle (list, stack graph, workspace canvas); a center pane showing lane detail with diff views (working tree, staged, recent commits), file tree toggle, quick edit capability, and in-app git operations (stage/unstage, commit/amend, stash, push, branch management); and a right inspector pane with sub-tabs for Terminals, Packs, Conflicts, and PR. Each lane row displays high-density status including lane type, dirty/clean state, ahead/behind counts, conflict risk score, and last activity timestamp.

See: [features/LANES.md](features/LANES.md)

### 7.3 Files

The Files tab provides an IDE-style file explorer and editor workbench inspired by Zed's clean, minimal interface. It features a workspace scope selector (primary workspace, lane worktrees, attached worktrees), a compact Zed-style file tree with minimal chrome and keyboard-driven navigation, Monaco editor tabs with diff modes (working tree, staged, commit), and a context panel with git status, quick stage/unstage controls, and jump links to lane details and conflict panels. All save operations are atomic, workspace-scoped, and propagate status updates to lane and conflict views in near real time.

See: [features/FILES_AND_EDITOR.md](features/FILES_AND_EDITOR.md)

### 7.4 Terminals

The Terminals tab is a global session list optimized for high session volume. It displays all terminal sessions (PTY and agent chat) across lanes with filters (lane, status, tool type, has errors), pin support, and jump-to-lane navigation. Each row shows the lane name, session title/goal, status (running/exited/failure), last output preview, start time, and duration. A secondary grid view (V1) renders multiple sessions simultaneously with lightweight preview frames for unfocused sessions to avoid rendering too many live xterm instances. Agent chat sessions (backed by Codex App Server and Claude multi-turn) appear as first-class sessions alongside PTY sessions with unified session tracking, delta computation, and pack integration. When AI is available, sessions also receive AI-enhanced summaries providing intent detection, outcome assessment, and suggested next steps — displayed alongside the deterministic summary in session cards.

See: [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md)

### 7.5 Conflicts

The Conflicts tab is the project-wide conflict radar. It aggregates predicted and active conflicts across all lanes, displaying a left-side list of affected lanes with stack blocker highlights, and a right-side content area with the pairwise lane risk matrix, merge simulation panel (source lane to target lane/branch dry-run), conflict pack viewer, and AI proposal workflow (generate via the agent SDKs, review diff, apply, run tests). Conflict badges in the Lanes tab provide at-a-glance risk visibility, and real-time overlap indicators update within seconds of staged or dirty changes.

See: [features/CONFLICTS.md](features/CONFLICTS.md)

### 7.6 Context

The Context tab is the documentation and context-inventory surface. It shows project/lane context health, supports context docs generation workflows, and provides a real-time sectioned inventory of tracked context primitives (packs by type, checkpoints, tracked session deltas, mission handoffs, and orchestrator runtime state) so users can audit evolution as it happens.

See: [features/PACKS.md](features/PACKS.md)

### 7.7 Graph

The Graph tab visualizes lane topology, stack relationships, activity/risk overlays, and PR linkage on a canvas. It is optimized for quickly understanding cross-lane dependencies and integration risk across a large workspace.

See: [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md)

### 7.8 PRs

The PRs tab manages GitHub pull request workflows. It displays stacked PR chains aligned to the lane stack graph on the left, and parallel (non-stacked) PRs in a separate list. The right side shows selected PR detail including checks, review status, and description. Per-lane PR operations (create, link, push, update description from packs) are available in the lane inspector PR sub-tab. The tab supports the "land stack" guided flow for merging stacked PRs in dependency order with checks gating. GitHub integration uses the local `gh` CLI or personal access tokens.

See: [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md)

### 7.9 History

The History tab provides an ADE-native operations timeline (distinct from `git log`). It shows a chronological event stream covering terminal sessions ended, checkpoints created, lane sync operations, conflict predictions, plan version changes, proposal applications, orchestrator runs, and PR events. Events are filterable by lane, feature key, and event type. Each event detail panel shows links to affected lanes, packs, checkpoints, plan versions, and proposals, with "replay context" and "undo" actions where applicable. A feature history view aggregates all sessions, checkpoints, and plan revisions for a given issue or feature key.

See: [features/HISTORY.md](features/HISTORY.md)

### 7.10 Automations

The Automations tab manages trigger-action workflows, manual runs, execution history, and natural-language drafting of automation rules. It is the foundation for recurring/background workflows (including planned Night Shift behavior in `docs/final-plan.md`).

See: [features/AUTOMATIONS.md](features/AUTOMATIONS.md)

### 7.11 Missions

The Missions tab is the AI orchestrator control center. It provides quick mission launch (prompt, lane, priority, execution target), status-lane board views, intervention queues, mission step progress with DAG visualization, orchestrator run controls (start, pause, resume, cancel), attempt history, outcomes, artifacts (including PR links), and mission timeline events. The AI orchestrator (a Claude session via the AgentExecutor interface connected to the MCP server) decomposes missions into steps, spawns agents in isolated lanes, monitors progress through checkpoints and session events, and routes decisions to the user through the intervention panel.

Mission detail supports starting orchestrator runs from mission steps. Operators can tick/resume/cancel runs, start attempts, and complete running attempts. Step DAG state, attempt history, and timeline events are visible from mission detail. Mission intake applies a deterministic planner split pass (dependencies, join policy, done criteria metadata). Autopilot launch mode persists executor/run-mode metadata and can auto-advance after tracked session completion.

See: [features/MISSIONS.md](features/MISSIONS.md)

### 7.12 Settings

The Settings tab provides application preferences including AI provider configuration (guest mode or subscription-powered via installed CLI tools), per-task-type model routing (which model/provider handles planning, implementation, review, conflict resolution, narratives, and PR descriptions), per-feature AI toggles (enable/disable individual AI capabilities: narratives, conflict proposals, PR descriptions, terminal summaries, mission planning, orchestrator), AI usage dashboard (per-feature usage bars, subscription status with rate limits, budget controls with daily limits, usage history trends), detected CLI tools status and health, process/test configuration export/import, keyboard shortcuts reference, theme selection (Clean Paper light or Bloomberg Terminal dark), and automation enable/disable with last-run status. Budget controls defined here tie into Night Shift (Phase 4), which reuses the same per-feature limits and counters for unattended batch execution.

See: [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md)

---

## 8. Feature Documentation

Each feature area is specified in detail in the following documents. These are the authoritative references for functional requirements, UX surface, edge cases, and development checklists.

| # | Feature | Document | Summary |
|---|---------|----------|---------|
| 1 | Lanes | [features/LANES.md](features/LANES.md) | The primary cockpit for parallel work. Covers lane types (primary, worktree, attached), 3-pane layout, diff views, in-app git operations, stacked lane workflows, lane profiles, and overlay policies. |
| 2 | Run (Command Center) | [features/PROJECT_HOME.md](features/PROJECT_HOME.md) | Project command center with play/pause icon. Covers managed process lifecycle, stack buttons, test suites, lane-scoped command execution, AI-suggested run prompts, CI/CD workflow sync, agent CLI tools registry (Claude Code, Codex, Cursor, Aider, Continue), and project configuration editing. |
| 3 | Files and Editor | [features/FILES_AND_EDITOR.md](features/FILES_AND_EDITOR.md) | IDE-style file workbench. Covers workspace scope selection, file explorer tree, Monaco editor with diff modes, quick edit, conflict marker editing, and atomic save operations. |
| 4 | Terminals and Sessions | [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) | PTY-based embedded terminals and agent chat sessions. Covers lane-scoped sessions, transcript capture, session metadata tracking, checkpoint creation on session end, agent command shortcuts, the session end contract, and agent chat integration (Codex App Server + Claude multi-turn). |
| 5 | Conflicts | [features/CONFLICTS.md](features/CONFLICTS.md) | Conflict prediction and resolution radar. Covers per-lane conflict prediction, pairwise lane-lane risk matrix, merge simulation, near-real-time updates from staged/dirty changes, and AI-powered proposal workflows via the agent SDKs. |
| 6 | Pull Requests | [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md) | GitHub PR integration via local `gh` CLI and PATs. Covers PR creation and linking per lane, checks/review status display, description drafting from packs, stacked PR chain visualization, and the land stack guided merge flow. |
| 7 | History | [features/HISTORY.md](features/HISTORY.md) | ADE operations timeline. Covers chronological event stream, feature history aggregation, event detail with jump links, context replay from checkpoints, undo capabilities, and graph visualization (V1). |
| 8 | Packs | [features/PACKS.md](features/PACKS.md) | Durable context and history system. Covers immutable checkpoints, append-only pack events, pack versioning with head pointers, materialized current views, all six pack types, the update pipeline, and privacy/retention controls. |
| 9 | Workspace Graph | [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md) | Infinite-canvas topology overview. Covers primary/worktree/attached node rendering, stack and risk edge overlays, merge simulation interactions, and snapshot-based status overlays. |
| 10 | Missions | [features/MISSIONS.md](features/MISSIONS.md) | AI orchestrator control center for mission intake and execution. Covers mission lifecycle, orchestrator run management, step DAG visualization, intervention queues, artifacts (including PR links), timeline events, and per-task-type model routing. |
| 11 | Onboarding and Settings | [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) | Repository initialization and user preferences. Covers onboarding flow (repo selection, `.ade/` setup, CLI tool detection), trust surfaces, operation previews, escape hatches, AI provider and per-task-type routing configuration, and theme/keybinding settings. |
| 12 | Automations | [features/AUTOMATIONS.md](features/AUTOMATIONS.md) | Trigger-action workflows. Covers session-end and commit triggers, scheduled actions, pack updates, conflict prediction, test execution, and configuration via `.ade/actions.yaml`. |

---

## 9. Architecture Documentation

Each architecture area is specified in detail in the following documents. These define the system contracts, data models, and implementation patterns.

| # | Architecture Area | Document | Summary |
|---|-------------------|----------|---------|
| 1 | System Overview | [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) | Top-level component breakdown (desktop UI, local core engine, AI Integration Layer), the happy-path data flow from lane creation through PR landing, key contracts, and the subscription-based provider model. |
| 2 | Desktop App | [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) | Electron process model (main, renderer, preload), IPC contracts and typed channel allowlist, PTY hosting in the main process, and the recommended folder/repo layout. |
| 3 | Data Model | [architecture/DATA_MODEL.md](architecture/DATA_MODEL.md) | Local SQLite schema covering projects, workspaces, lanes, stacks, sessions, processes, tests, operations, checkpoints, pack events, pack versions, pack heads, missions (mission/step/event/artifact/intervention), planning threads, plan versions, conflict predictions, orchestrator timeline events, and orchestrator gate reports. |
| 4 | Git Engine | [architecture/GIT_ENGINE.md](architecture/GIT_ENGINE.md) | Git worktree management, drift status computation (ahead/behind/dirty), sync operations (merge and rebase with undo), dry-run conflict prediction, and stack-aware restack operations. |
| 5 | Job Engine | [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md) | Event-driven pipeline with coalescing rules. Covers all event types, idempotent job definitions, the lane refresh pipeline (checkpoint through AI augmentation), real-time conflict pass, re-plan pipeline, and failure handling. |
| 6 | AI Integration | [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) | Local AI integration architecture. Covers the AgentExecutor interface, native agent SDK executors, MCP server tool surface, AI orchestrator session management, per-task-type model routing, subscription authentication passthrough, and the safety contract for AI-generated proposals. |
| 7 | Configuration | [architecture/CONFIGURATION.md](architecture/CONFIGURATION.md) | `.ade/` folder structure, config layering (app defaults, `ade.yaml` shared baseline, `local.yaml` machine overrides), schemas for processes, stack buttons, test suites, lane profiles, overlay policies, validation rules, and trust/change confirmation. |
| 8 | Security and Privacy | [architecture/SECURITY_AND_PRIVACY.md](architecture/SECURITY_AND_PRIVACY.md) | Default security posture. Covers the trust boundary model, terminal transcript privacy, process/test command trust confirmation, and the safety contract for proposals (diff review before apply, undo points). |
| 9 | UI Framework | [architecture/UI_FRAMEWORK.md](architecture/UI_FRAMEWORK.md) | Locked UI technology decisions, visual direction (Clean Paper light and Bloomberg Terminal dark themes), app shell layout, typography system (serif headers, monospace data), and high-density console design principles. |

---

## 10. Cross-Cutting Concerns

### 10.1 Packs (Context and History System)

Packs are ADE's core differentiator for agentic workflows. They provide a durable, append-only context system that captures everything needed for lane handoffs, agent prompts, explainable planning, and feature history.

**Core primitives**:

- **Checkpoint**: Immutable execution snapshot with SHA anchors, deterministic deltas, tool metadata, and transcript references. Created on session end and commit boundaries.
- **Pack Event**: Append-only event for any change to pack state (checkpoint created, pack materialized, plan version created, narrative augmented).
- **Pack Version**: Immutable rendered version of a pack (markdown + metadata + source inputs). Never edited in place.
- **Pack Head**: Mutable pointer per pack key referencing the latest deterministic version, latest narrative version, and active version.

**Context hardening policy (Phase 1.5 gate)**:

- Orchestrator state transitions, scheduling, retries, claims, and gates are deterministic code/state-machine paths.
- AI is advisory-only (decomposition, strategy suggestions, patch proposals, summaries).
- Default orchestrator context profile excludes narrative text; narrative inclusion is explicit opt-in.
- Orchestrator context defaults to PRD/architecture digest refs and bounded exports; full doc bodies are included only when step policy requires it.

**Update pipeline**: On session end, the pipeline creates a checkpoint, appends events, materializes lane/project/feature packs, predicts conflicts, updates conflict packs if needed, and optionally requests AI narrative augmentation via the agent SDKs. This pipeline runs through the job engine with coalescing to avoid redundant work.

**Storage**: Packs are stored under `.ade/packs/` with immutable versions, head pointers, and materialized current views. History artifacts (checkpoints, events) are stored under `.ade/history/`. All storage is local-only.

See: [features/PACKS.md](features/PACKS.md)

### 10.2 Automations

Automations allow users to wire triggers to actions so that ADE stays synchronized without manual intervention. MVP triggers include terminal session end, commit created, and scheduled intervals. MVP actions include pack updates, conflict prediction, test runs, AI augmentation requests, and custom commands. Automations are configured in `.ade/actions.yaml` and can be enabled/disabled from the Settings tab.

See: [features/AUTOMATIONS.md](features/AUTOMATIONS.md)

### 10.3 Workspace Graph

The workspace graph is an infinite-canvas mindmap showing the entire development topology of a repository. The main branch sits at the center representing production; branches like `develop` or `staging` are positioned as intermediate environment nodes. Feature lanes, worktrees, and attached lanes radiate outward, connected by topology, stack, and risk edges. Environment badges (PROD, STAGING, DEV) are rendered on branches with configured environment mappings. PR status overlays show open PRs on edges alongside conflict risk indicators. Stack edges show parent-child relationships. Users can pan, zoom, click nodes to focus lane details, and click edges to open merge simulation panels. The result is a deployment-aware topology map that answers "what connects to what, where are the conflicts, and which PRs are open" at a glance.

See: [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md)

### 10.4 Job Engine

The job engine is the coordination backbone that keeps all ADE state synchronized. It processes events (session end, HEAD change, staged set change, branch switch, base update) and dispatches idempotent, coalesced jobs. Per-lane coalescing ensures only one refresh pipeline runs at a time with at most one pending follow-up. Pairwise conflict passes use short debounce for staged/dirty events. AI augmentation (narrative generation, conflict proposals) is triggered on session end and coalesced during active work. Failure handling is explicit: failed checkpoints mark lanes as stale, failed materializations preserve prior pack versions, and failed predictions mark risk as "unknown" rather than "clean."

See: [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md)

### 10.5 AI Integration

The AI Integration Layer provides narrative augmentation, conflict resolution proposals, mission orchestration, and PR description drafting -- all without ever directly mutating the repository.

**AgentExecutor Interface**: ADE's own thin abstraction that unifies both agent SDKs behind a common `execute()` / `resume()` contract. The orchestrator and all callers work against this interface, enabling provider-agnostic orchestration. Two executor implementations are used:

- `ClaudeExecutor` (via `ai-sdk-provider-claude-code`): A community Vercel AI SDK provider that wraps `@anthropic-ai/claude-agent-sdk` to spawn the `claude` CLI as a subprocess. Inherits the user's Claude Pro/Max subscription authentication. This is a subscription auth workaround while Anthropic's policy on third-party tool usage is in flux. Supports streaming, session persistence, tool interception via `canUseTool`, and message injection for context pack delivery.
- `CodexExecutor` (via `@openai/codex-sdk`): The official OpenAI SDK, used directly to spawn the `codex` CLI as a subprocess. Inherits the user's ChatGPT Plus subscription authentication. Subscription auth is natively supported.

- **Agent Chat Service**: Native interactive chat interface using the Codex App Server protocol (JSON-RPC 2.0) and Claude community provider (multi-turn `streamText()`). Provider-agnostic `AgentChatService` interface with `CodexChatBackend` and `ClaudeChatBackend`. Chat sessions integrate as first-class sessions with delta tracking, pack integration, and approval flows.

**MCP Server** (`apps/mcp-server`): A local JSON-RPC 2.0 server over stdio transport that exposes ADE's infrastructure as tools callable by the AI orchestrator. Tool surface includes:

- `spawn_agent` -- launch an agent in a specified lane
- `read_context` -- retrieve pack contents for a lane, feature, or project
- `create_lane` -- create a new worktree lane for isolated work
- `check_conflicts` -- run conflict prediction between lanes
- `merge_lane` -- merge a lane into its target branch
- `ask_user` -- route an intervention request to the ADE UI
- `run_tests` -- execute test suites in a lane's worktree

**AI Orchestrator**: A long-running Claude session (via the AgentExecutor interface) connected to the MCP server. The orchestrator:

1. Receives a mission prompt enriched with bounded context pack exports.
2. Decomposes the mission into a step DAG with dependencies, join policies, and done criteria.
3. Spawns agents (Claude Code, Codex) into isolated lanes via MCP tools.
4. Monitors agent progress through session events, checkpoints, and pack updates.
5. Routes human-in-the-loop decisions through the intervention panel.
6. Advances the step DAG deterministically based on session outcomes (success/failure/canceled).

**Per-task-type model routing**: Users configure which model/provider handles each task type in Settings. The AI Integration Layer routes requests accordingly, allowing mixed-provider workflows (e.g., Claude for planning, Codex for implementation).

**Cost controls**: Execution is tied to session boundaries, not keystrokes. Context pack exports are bounded by default. The orchestrator context profile excludes narrative text unless explicitly opted in. Content-hash caching avoids redundant work.

**Usage tracking**: Every AI call is logged to a local `ai_usage_log` table with feature type, provider, model, token counts, duration, and success status. The Settings tab surfaces this data as a usage dashboard with per-feature progress bars, subscription status, and configurable budget controls. Budget enforcement is the foundation for Night Shift (Phase 4) budget caps — the same per-feature limits and counters are reused for unattended batch execution.

---

## 11. Security and Privacy

ADE's security model is built on explicit trust boundaries and conservative defaults.

**Trust boundaries**:

- The local core (main process) is the only component that edits files, runs git operations, runs tests, and performs undo/rollback.
- The AI Integration Layer spawns agents as subprocesses but never directly mutates the repository. All agent outputs (patches, proposals, narratives) are mediated through ADE's local core.
- The renderer is untrusted and communicates exclusively through a typed IPC allowlist.
- Process and test commands execute only in the main process, never in the renderer.

**Secrets and privacy**:

- Terminal transcripts are stored locally and are never transmitted externally.
- Per-project privacy controls determine what context is included in AI prompts and pack exports.
- Default exclude patterns cover obvious secret files (`.env*`, `*.pem`, `*.key`, `*id_rsa*`), build outputs (`dist/`, `build/`, `.next/`, `coverage/`), and dependencies (`node_modules/`).

**Process/test command trust**:

- Shared config changes (`.ade/ade.yaml`) require explicit trust confirmation before command execution.
- Local overrides (`.ade/local.yaml`) are trusted for the local machine.
- Commands are represented as argv arrays to avoid shell injection.

**Proposal safety**:

- Patches from AI agents (conflict proposals, code suggestions) are always shown as diffs before application.
- Applying a patch creates an operation record and undo point.
- Auto-apply, if ever enabled, must be per-action opt-in and test-gated.

**Subscription authentication**:

- AI authentication is handled entirely by the CLI tools themselves (Claude Code, Codex). ADE does not store, manage, or transmit any AI service credentials.
- Each agent SDK spawns its CLI tool as a subprocess that inherits the user's existing authentication state (browser session, OS keychain, or CLI config file as managed by each tool).
- GitHub integration uses the local `gh` CLI (which manages its own OAuth flow) or user-provided personal access tokens stored in the OS keychain.

---

## 12. Configuration Model

ADE configuration lives in the `.ade/` folder at the project root, which is git-ignored via `.git/info/exclude` by default.

**File layout**:

| File | Purpose | Shareable |
|------|---------|-----------|
| `.ade/ade.yaml` | Shared baseline config (processes, stack buttons, test suites, lane profiles, overlay policies, AI task-type routing defaults) | Yes (opt-in) |
| `.ade/local.yaml` | Machine-specific overrides (including local AI provider preferences and CLI tool paths) | No |
| `.ade/actions.yaml` | Automation trigger-action definitions | Yes (opt-in) |
| `.ade/packs/` | Pack versions and materialized views | No |
| `.ade/history/` | Checkpoints and events | No |
| `.ade/transcripts/` | Terminal session transcripts | No |
| `.ade/logs/` | Process and test logs | No |
| `.ade/cache/` | Local cache | No |

**Config layering** (load order):

1. Application defaults
2. `.ade/ade.yaml` (shared baseline)
3. `.ade/local.yaml` (machine override)

Arrays of objects merge by stable `id`. Unresolved references (such as stack buttons referencing unknown process IDs) fail validation. Commands are never executed until config passes validation.

**AI task-type routing config**:

Per-task-type model routing is configured in `ade.yaml` (shareable defaults) and overridable in `local.yaml`. Each task type maps to a provider and optional model preference:

```yaml
ai:
  provider: subscription  # or "guest" to disable AI features
  routing:
    planning: { provider: claude-code }
    implementation: { provider: codex-cli }
    review: { provider: claude-code }
    conflict-resolution: { provider: claude-code }
    narratives: { provider: claude-code }
    pr-descriptions: { provider: claude-code }
```

When a configured CLI tool is not installed or not authenticated, ADE falls back gracefully: the task type is marked as unavailable and the user is prompted to install or authenticate the tool.

---

## 13. Non-Goals and Out of Scope

- **ADE is not an IDE replacement.** It does not provide code intelligence, language servers, autocompletion, or debugging. The Monaco editor is intentionally scoped to focused edits and diff review, not full development.
- **ADE does not replace the git CLI.** It provides a UI for common git workflows (stage, commit, push, branch, stash, sync) but does not aim to cover every git operation. Power users can always drop to an external terminal.
- **ADE is not a closed agent runtime.** ADE supports external agent CLIs and orchestration workflows but does not lock execution to a proprietary agent implementation.
- **ADE does not manage AI service accounts or billing directly.** Users bring their own CLI subscriptions (Claude Pro/Max, ChatGPT Plus). ADE tracks local usage (call counts, token estimates) and displays detected subscription tiers, but does not interact with billing systems or enforce provider-side limits.
- **Mobile/relay support is roadmap scope, not a non-goal.** Desktop is the current primary runtime, while relay + iOS capabilities are planned in `docs/final-plan.md`.
- **No multi-repo support in V1.** Each ADE instance manages a single git repository. Multi-repo orchestration may be considered post-V1.
- **No real-time collaboration.** ADE is a single-user tool per desktop instance. Team features are limited to shared config and stacked PR workflows.

---

## 14. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Parallel lane management | Developer can manage 5+ parallel lanes without context confusion | User can identify the state, intent, and recent activity of any lane within 5 seconds from the Lanes tab |
| Conflict prediction coverage | Integration issues surfaced before merge | Conflict badges appear in lane rows within 30 seconds of a conflicting change, without user action |
| Context-switching overhead | Pack narratives reduce context-switching overhead by 50%+ | Time to resume work on a lane after switching is halved compared to manual context reconstruction |
| Session-to-PR pipeline | Under 5 minutes for typical changes | Measured from session end to PR creation with pack-drafted description |
| Terminal reliability | Stable embedded terminals at scale | 10+ concurrent PTY sessions with no data loss, resize glitches, or cross-lane cwd leaks |
| Process management | One-click dev environment startup | All configured processes reachable and controllable from Projects (Home) tab without external tools |
| Checkpoint durability | Every session produces a durable checkpoint | 100% of completed sessions yield an immutable checkpoint with SHA anchors and deterministic deltas |
| Mission orchestration | End-to-end mission execution with minimal manual intervention | Multi-step missions complete with agent spawning, context injection, and conflict checking through the orchestrator |
| AI provider flexibility | Users can mix providers per task type | Per-task-type routing works correctly with at least two different CLI providers simultaneously |
| AI usage visibility | Users can see per-feature AI consumption at a glance | Usage dashboard loads in <1s, per-feature breakdown is accurate within 5% of actual token usage |

---

## 15. Implementation Phases

Implementation sequencing, future phases, and dependency ordering are now maintained in:

- `docs/final-plan.md`

Current status: Phase 1 (Agent SDK Integration) and Phase 1.5 (Agent Chat Integration) are complete. Phase 2 (MCP Server) is the next implementation target.

This PRD intentionally focuses on product scope and behavior, while roadmap execution detail is centralized in the Final Plan to avoid drift.

---

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **PTY stability across platforms** | Terminal sessions are the primary user interaction; instability blocks all workflows | Maintain a standing platform reliability gate (macOS/Windows/Linux smoke coverage) before advancing runtime-heavy roadmap phases. |
| **Conflict prediction accuracy** | False positives erode trust; false negatives defeat the purpose | Start with conservative git merge-tree analysis. Mark uncertain predictions as "unknown" rather than "clean." Iterate with user feedback. |
| **Pack system complexity** | Six pack types with immutable versioning and materialization could be over-engineered for MVP | Keep deterministic pack materialization incremental, with explicit rebuild/recovery commands and strict schema/version contracts. |
| **CLI tool availability** | Users must have `claude` and/or `codex` CLI installed and authenticated for AI features to work | Detect CLI tools at startup and surface clear status in Settings. Graceful degradation: all local features work without any CLI tools. Provide installation guidance in-app. |
| **Subscription authentication fragility** | CLI tools manage their own auth; ADE cannot fix auth failures | Surface CLI auth status prominently. Provide clear error messages when a CLI tool reports auth failure. Link to each tool's auth documentation. Never cache or proxy auth tokens. |
| **Context window limits** | AI orchestrator and agents have finite context windows; large projects may exceed them | Bounded pack exports by default. Context profiles exclude narrative text unless opted in. Incremental context delivery via MCP tools rather than single-prompt stuffing. |
| **Electron performance at scale** | Many concurrent terminals, file watchers, and git operations could degrade performance | Lazy xterm rendering (only focused sessions get full rendering). Coalesced event processing. Incremental materializers keyed by checkpoint IDs. Git-native operations preferred over filesystem walks. |
| **Scope creep toward IDE** | Pressure to add code intelligence, debugging, or full editing could dilute the product | Non-goals are explicitly documented. Monaco is scoped to focused edits and diff review. Users are expected to use their preferred IDE alongside ADE. |
| **Multi-agent coordination complexity** | Orchestrator managing multiple concurrent agents across lanes introduces scheduling, conflict, and resource contention challenges | Deterministic step DAG with explicit dependencies and join policies. Session-backed attempts with clear success/failure/canceled outcomes. Conservative concurrency defaults with user-configurable limits. |
| **Claude subscription auth policy uncertainty** | Anthropic may restrict subscription OAuth in third-party tools | Community Vercel provider workaround; AgentExecutor interface enables quick switch to official SDK if policy changes. |

---

*This document is the authoritative product requirements reference for ADE. For implementation details, consult the linked feature and architecture documents; roadmap sequencing is maintained in `docs/final-plan.md`.*

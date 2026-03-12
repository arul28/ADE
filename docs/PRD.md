# ADE (Agentic Development Environment) - Product Requirements Document

Last updated: 2026-03-12

Roadmap source of truth: `docs/final-plan/README.md` (this PRD captures product scope and core behavior; future sequencing lives in Final Plan).

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
   - 7.10 [CTO](#710-cto)
   - 7.11 [Missions](#711-missions)
   - 7.12 [Settings](#712-settings)
8. [Feature Documentation](#8-feature-documentation)
9. [Architecture Documentation](#9-architecture-documentation)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
    - 10.1 [Unified Memory (Context and History System)](#101-unified-memory-context-and-history-system)
    - 10.2 [Mission Workers](#102-mission-workers)
    - 10.3 [Workspace Graph](#103-workspace-graph)
    - 10.4 [Job Engine](#104-job-engine)
    - 10.5 [AI Integration](#105-ai-integration)
    - 10.6 [Compute Backends](#106-compute-backends)
    - 10.7 [Worker Computer Use](#107-worker-computer-use)
    - 10.8 [Artifacts](#108-artifacts)
    - 10.9 [Learning Packs](#109-learning-packs)
    - 10.10 [Development Modes](#1010-development-modes)
    - 10.11 [Cross-Machine Portability](#1011-cross-machine-portability)
    - 10.12 [External Agent Bridge](#1012-external-agent-bridge)
    - 10.13 [Worker and CTO Execution Model](#1013-worker-and-cto-execution-model)
11. [Security and Privacy](#11-security-and-privacy)
12. [Configuration Model](#12-configuration-model)
13. [Non-Goals and Out of Scope](#13-non-goals-and-out-of-scope)
14. [Success Metrics](#14-success-metrics)
15. [Implementation Phases](#15-implementation-phases)
16. [Risks and Mitigations](#16-risks-and-mitigations)

---

## 1. Product Overview

ADE (Agentic Development Environment) is a desktop application that serves as a development operations cockpit for agentic coding workflows. It provides developers with a unified control plane to manage multiple parallel development lanes (git worktrees), terminal sessions, managed processes, test suites, and project configuration. ADE automates context tracking through its unified memory system, predicts conflicts between parallel work streams, and orchestrates AI-powered multi-worker missions through its AI Integration Layer -- provider-native CLI/runtime paths, a local MCP server for ADE-owned tools, and an AI orchestrator that coordinates workers across configured providers (CLI subscriptions, API-key/OpenRouter, and local endpoints). Missions use a configurable phases model where users define the structure and constraints, and the orchestrator executes accordingly. The orchestrator features an AI meta-reasoner for intelligent fan-out, real-time inter-worker communication via @mentions, a context compaction engine for long-running missions, and a scoped memory architecture that enables knowledge sharing across workers and missions. An always-on CTO agent provides persistent project awareness and serves as the intelligent entry point for both users and external systems.

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

ADE is the orchestration layer for agentic development. It watches what each agent does, tracks context through immutable checkpoints and durable memory entries, predicts conflicts between parallel work, and surfaces integration risks before they become merge nightmares. Its AI orchestrator -- powered by native agent SDKs and a local MCP server -- can plan multi-step missions, spawn agents into isolated lanes, inject bounded memory context into agent prompts, and route human interventions back through the ADE UI. The orchestrator acts as a smart PM: an AI meta-reasoner selects optimal dispatch strategies (sequential, parallel, wave, or adaptive fan-out), agents communicate in real time through @mentions, a compaction engine prevents context overflow in long-running missions, and a scoped memory architecture enables knowledge to flow between agents and persist across missions. AI execution is local-first and provider-flexible: users can run via CLI subscriptions or configured API/local providers without any ADE-hosted account layer.

Think of ADE as "mission control for agentic development."

### ADE's Role in the Agent Ecosystem

ADE is a **development orchestration control plane** -- it does not try to be a general-purpose agent platform. Agents in ADE have a specific job: they write code, push to git, and open pull requests. Everything in ADE's architecture is optimized for that workflow.

ADE exposes its full infrastructure via the MCP server (35+ tools), enabling external agent systems to orchestrate development through ADE programmatically. An external agent platform like OpenClaw can connect to ADE's MCP server to launch missions, read memory/context resources, check for conflicts, and monitor progress -- all without touching ADE's UI. This makes ADE a first-class development backend for the broader agent ecosystem.

Users can build personal agent setups on top of ADE. For example, a **"Virtual Me" (V) agent** running on an external orchestration platform could serve as the user's single entry point for all tasks -- delegating development work to ADE via MCP, research to research agents, scheduling to calendar agents, and communication to messaging agents. V observes ADE's outputs the same way a human developer would: by reading the repo (git log, `.ade/` state files, PR results). ADE does not need to "report to V" -- the `.ade/` directory, MCP server, and CTO provide everything V needs to interact with ADE programmatically. This is a user-land concern: ADE provides the infrastructure and the MCP surface, but the composition of higher-level agent workflows is up to the user. See `final-plan/appendix.md` Section 11.3 for detailed V concept documentation.

The CTO is ADE's always-on project-aware agent and designated entry point for external systems. It receives development requests -- whether from a user, an external agent, or a webhook -- and routes them to the appropriate internal workflow: mission planning, agent spawning, context retrieval, or human-in-the-loop escalation.

ADE does not replace the IDE or the git CLI. It integrates deeply with external agent CLIs via tracked sessions, agent flows, and first-class mission/orchestrator execution as defined in `docs/final-plan/README.md`.

---

## 3. Target Users

- **Solo developers running multiple AI coding agents in parallel**: The primary user. Manages 3-10+ concurrent agent sessions across different features, needs a single view to understand the state of all work and predict integration issues.
- **Small teams managing complex branching strategies**: Teams of 2-5 developers using stacked PRs, parallel feature branches, and shared base branches. ADE provides visibility into how each team member's work interacts.
- **Developers who want IDE-like git workflow without leaving a dedicated tool**: Users who prefer a purpose-built tool for git operations, worktree management, and development process control rather than scattering those concerns across IDE plugins and terminal windows.

---

## 4. Core Concepts and Glossary

### Lane

A lane is the fundamental unit of parallel work in ADE. Each lane wraps a git branch and a workspace directory, providing an isolated development surface with its own terminal sessions, status tracking, and memory-aware context.

Lane types:

- **Primary**: Points to the main repository directory. Default for users who work in-place. Cannot be deleted (only hidden/deactivated).
- **Worktree**: A dedicated git worktree created under `.ade/worktrees/`. The default lane creation path, providing full file isolation.
- **Attached**: Imports a pre-existing external worktree path as a lane, allowing ADE to manage worktrees created outside of ADE.

### Stack

A layered arrangement of lanes where each child branch is based on its parent lane's branch rather than on the project's default base branch. Stacks enable stacked PR workflows where changes are reviewed incrementally. Rebasing propagates parent changes to children in dependency order.

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

- **Unified runtime + native SDKs**: The execution layer uses provider-native SDK/runtime paths for Claude CLI, Codex CLI, and API/OpenRouter/local endpoints, normalized behind ADE's unified runtime contracts.
- **MCP Server**: A local JSON-RPC 2.0 server (`apps/mcp-server`) that exposes ADE's infrastructure as tools to the AI orchestrator. Tools include `spawn_agent`, `read_context`, `create_lane`, `check_conflicts`, `merge_lane`, `ask_user`, `run_tests`, and others.
- **AI Orchestrator**: A phase-aware coordinator runtime constrained to ADE coordinator tools. It receives mission prompts and context packs, hands off planning work, spawns agents in separate lanes, monitors progress, and routes interventions to the user through the ADE UI.

The renderer never mutates the repository directly. File changes, git operations, and test runs happen through ADE's trusted local core services or through workers running inside ADE-managed worktrees under the selected permission model.

### Inter-Worker Communication

Workers within a mission can communicate with each other in real time using @mention syntax. Messages are routed through the orchestrator's message bus and delivered via dual-path delivery: PTY injection for CLI-based workers and SDK message API for SDK-managed workers. Inter-worker messages surface in the mission Chat tab: high-signal updates in Global and detailed records in the relevant worker/orchestrator thread.

### AI Meta-Reasoner

The orchestrator's intelligence layer that analyzes mission structure to select the optimal dispatch strategy before spawning workers. Four strategies are available: sequential, parallel, wave (phased groups), and adaptive (dynamically adjusted). The meta-reasoner considers mission complexity, inter-step dependencies, available resources, and budget constraints.

### Context Compaction

An automatic process that prevents context overflow in long-running worker sessions. When context usage reaches a configurable threshold (default 70%), the compaction engine persists critical state via pre-compaction writeback, then summarizes prior context. Sessions resume from compacted state without loss of essential knowledge.

### Memory Scopes

A scoped memory architecture organizes mission context into `runtime-thread`, `run`, `project`, `identity`, and `daily-log` namespaces. Context entries are promoted by policy and confidence, with provenance retained for auditability. Memory is further organized into three retrieval tiers -- Core (always in context), Hot (vector-retrieved on demand), and Cold (archival) -- and four ownership scopes: identity (CTO-owned), project (shared), mission (per-run), and session (ephemeral). See Section 10.5 for the full memory architecture.

### Per-Task-Type Model Routing

Users can configure which AI model and provider to use for each task type. Task types include planning, implementation, review, conflict resolution, narratives, and PR descriptions. For example, a user might configure Claude for planning and code review while using Codex for implementation tasks.

### CTO (Always-On Project Agent)

An always-on, project-aware agent that serves as ADE's intelligent entry point. The CTO has full memory and context about the project (using the three-tier memory model), can create missions, spin up lanes, check project state via MCP tools, and route external requests to the appropriate internal workflow (mission planning, agent spawning, context retrieval, or human escalation). The CTO replaces the former "Concierge Agent" concept with a richer, persistent agent that "knows" the entire project. See Section 7.10 and Section 10.12.

### External Agent Bridge

The MCP server's role as a bidirectional bridge between ADE and the broader agent ecosystem. External agents connect inbound to use ADE as a development backend; ADE workers and the CTO connect outbound to consume external tool ecosystems. See Section 10.12.

### Job Engine

An asynchronous task scheduler that triggers on events (session end, head change, staged set change) and runs idempotent, coalesced jobs. The job engine coordinates the refresh pipeline: status update, checkpoint creation, pack materialization, conflict prediction, and AI augmentation requests.

---

## 5. System Architecture

ADE follows a strict trust boundary model with three process layers plus an AI Integration Layer:

```
ADE Desktop (Electron)
+-- Renderer (React UI)
|   +-- Missions tab (AI orchestrator control center)
|   |   +-- MissionChatV2 (mission chat workspace with global summary + thread detail)
|   |   +-- PhaseProgressBar (single progress indicator)
|   |   +-- OrchestratorDAG (SVG animated step visualization)
|   |   +-- Context Budget Panel (scoped memory visibility)
|   +-- Intervention panel (human-in-the-loop)
|   +-- All other tabs unchanged
+-- Main Process (Node.js, trusted)
|   +-- AI Integration Service
|   |   +-- Unified runtime contracts (CLI subscriptions + API/OpenRouter/local)
|   |   |   +-- Claude CLI runtime path
|   |   |   +-- Codex CLI runtime path
|   |   |   +-- In-process runtime adapters (API/OpenRouter/local)
|   |   +-- AI Orchestrator (phase-aware coordinator + worker runtime)
|   |   |   +-- AI Meta-Reasoner (dispatch strategy selection)
|   |   |   +-- Inter-Worker Message Bus (@mention routing)
|   |   |   +-- Context Compaction Engine (threshold-based summarization)
|   |   |   +-- Scoped Memory (`runtime-thread` -> `run` -> `project`/`identity`)
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
- AI Integration Service (unified runtime contracts, MCP server, orchestrator)

### Renderer Process (Untrusted UI)

The React-based renderer handles all user interface rendering. It never directly accesses the filesystem, spawns processes, or runs git commands. All operations are performed through typed IPC calls to the main process via the preload bridge.

### Preload Bridge

The preload script exposes a narrow, typed API surface to the renderer via Electron's `contextBridge`. It enforces a strict IPC channel allowlist. Context isolation is enabled and Node integration is disabled in the renderer.

### AI Integration Layer

The AI Integration Layer runs within the main process and provides all AI capabilities. It consists of:

- **Unified runtime contracts**: ADE normalizes CLI-backed and non-CLI runtimes behind one runtime surface. Claude CLI and Codex CLI use provider-native execution paths; API-key/OpenRouter/local models use in-process runtime adapters. All paths support streaming output, session management, and tool interception for ADE-owned tools.
- **MCP Server**: A local server (`apps/mcp-server`) exposing ADE tools via JSON-RPC 2.0 over stdio transport. This gives the AI orchestrator programmatic access to ADE's lane management, context packs, conflict detection, test execution, and user intervention infrastructure.
- **AI Orchestrator**: A phase-aware coordinator runtime constrained to ADE coordinator tools. The orchestrator receives mission prompts enriched with context packs, uses an AI meta-reasoner to select optimal dispatch strategy, enters the planning phase, hands off read-only planning work when enabled, decomposes execution into steps, spawns agents in isolated lanes, facilitates inter-agent communication via @mentions, manages context lifecycle through compaction and scoped memory, monitors execution through checkpoints and session events, and escalates decisions to the user via the intervention panel.

### Provider Model

AI capabilities are gated by provider availability:

- **Guest**: No AI features. All local features work (lanes, terminals, git operations, processes, tests, packs, conflict prediction). This is the default state and users can remain in it indefinitely.
- **CLI subscription**: Uses existing `claude`/`codex` CLI auth through SDK-managed subprocesses.
- **API key / OpenRouter**: Uses configured provider keys through unified runtime adapters.
- **Local endpoint**: Uses configured OpenAI-compatible local providers (LM Studio/Ollama/vLLM).

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
| Terminal | xterm.js (renderer), node-pty (main process), agent chat (Codex App Server, Claude multi-turn, unified API/local runtime) |
| Editor/Diff | Monaco Editor (lazy-loaded) |
| Graph/Canvas | React Flow |
| Routing | React Router |
| Layout | react-resizable-panels |
| AI Execution | Unified executor (`modelId`-first routing, CLI subprocess + in-process SDK paths) |
| AI Providers | `ai-sdk-provider-claude-code` (Claude CLI), `@openai/codex-sdk` (Codex CLI), Vercel AI SDK providers (API/local) |
| Agent Chat | `AgentChatService` interface — provider-agnostic chat with Codex, Claude, and API/local models |
| AI Tool Protocol | MCP Server (`apps/mcp-server`), JSON-RPC 2.0, stdio transport |
| GitHub Integration | `gh` CLI (local), personal access tokens |

---

## 7. Application Structure (Tabs)

ADE uses an 11-tab application shell with a slim icon rail (50px) on the left side. The selected lane persists across tabs, allowing Run, Work, Graph, PRs, Files, and Missions tabs to default-filter to the active lane context. Conflict intelligence is no longer a standalone tab: lane-level summaries live in Lanes, the global risk matrix lives in Graph, and blocked rebase flows live in PRs. All local features work without any AI provider configured; AI-powered features (narratives, orchestrator, conflict proposals, chat) require at least one configured provider (CLI/API/local).

Current tab routes:
- `/project` (Play)
- `/lanes`
- `/files`
- `/work`
- `/graph`
- `/prs`
- `/history`
- `/automations`
- `/missions`
- `/cto`
- `/settings`

The detailed ownership model for future additions (including Machines) is maintained in `docs/final-plan/README.md`.

### 7.1 Run (▶)

The Run tab (denoted by a play/pause icon) is the project-level command center for running everything in your development stack. It includes a lane selector (determining which worktree commands execute in), a stack button row for one-click startup of configured process subsets, individual managed process controls with live log streaming, test suite buttons with run history, and a configuration editor. New in the Run tab: AI-suggested run prompts that detect new test suites or services after merges and propose new buttons; CI/CD workflow sync that imports jobs from GitHub Actions / GitLab CI / etc. as local run buttons; and an Agent CLI Tools section that detects installed AI coding tools (Claude Code, Codex, Cursor, Aider, Continue), displays their commands and skills, and provides quick-launch into tracked terminals.

See: [features/PROJECT_HOME.md](features/PROJECT_HOME.md)

### 7.2 Lanes

The Lanes tab is the primary cockpit and the core surface of ADE. It uses a 3-pane resizable layout: a left pane with the lane list (filterable by active/ready/archived) and topology mode toggle (list, stack graph, workspace canvas); a center pane showing lane detail with diff views (working tree, staged, recent commits), file tree toggle, quick edit capability, and in-app git operations (stage/unstage, commit/amend, stash, push, branch management); and a right inspector pane with sub-tabs for Terminals, Packs, Conflicts, and PR. Each lane row displays high-density status including lane type, dirty/clean state, ahead/behind counts, conflict risk score, and last activity timestamp. Phase 5 adds full runtime isolation: per-lane hostname routing via a reverse proxy (*.localhost), shareable preview URLs, OAuth redirect handling with state-parameter routing for multi-lane callback resolution, and runtime diagnostics with traffic-light health indicators and one-click fallback mode.

See: [features/LANES.md](features/LANES.md)

### 7.3 Files

The Files tab provides an IDE-style file explorer and editor workbench inspired by Zed's clean, minimal interface. It features a workspace scope selector (primary workspace, lane worktrees, attached worktrees), a compact Zed-style file tree with minimal chrome and keyboard-driven navigation, Monaco editor tabs with diff modes (working tree, staged, commit), and a context panel with git status, quick stage/unstage controls, and jump links to lane details and conflict panels. All save operations are atomic, workspace-scoped, and propagate status updates to lane and conflict views in near real time.

See: [features/FILES_AND_EDITOR.md](features/FILES_AND_EDITOR.md)

### 7.4 Terminals

The Terminals tab is a global session list optimized for high session volume. It displays all terminal sessions (PTY and agent chat) across lanes with filters (lane, status, tool type, has errors), pin support, and jump-to-lane navigation. Each row shows the lane name, session title/goal, status (running/exited/failure), last output preview, start time, and duration. A secondary grid view (V1) renders multiple sessions simultaneously with lightweight preview frames for unfocused sessions to avoid rendering too many live xterm instances. Agent chat sessions (Codex App Server, Claude multi-turn, and unified API/local runtimes) appear as first-class sessions alongside PTY sessions with unified session tracking, delta computation, and pack integration, using tool types `codex-chat`, `claude-chat`, and `ai-chat`.

See: [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md)

### 7.5 Graph & Conflict Intelligence

Conflict intelligence no longer lives in a dedicated tab. The global risk matrix, pairwise lane overlap view, merge simulation, and AI proposal workflow live in Graph; lane badges and overlap summaries live in Lanes; and blocked/manual rebase recovery lives in PRs. Conflict badges in the Lanes tab provide at-a-glance risk visibility, and real-time overlap indicators update within seconds of staged or dirty changes.

See: [features/CONFLICTS.md](features/CONFLICTS.md)

### 7.6 Context

The Context tab is the documentation and context-inventory surface. It shows project/lane context health, generates and installs `.ade/context/PRD.ade.md` + `.ade/context/ARCHITECTURE.ade.md` from ranked repository docs, and provides a real-time sectioned inventory of tracked context primitives (packs by type, checkpoints, tracked session deltas, mission handoffs, and orchestrator runtime state). Doc generation is AI-assisted when available and falls back to deterministic digests when AI output is unavailable or invalid.

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

### 7.10 CTO

The CTO tab is home to ADE's always-on, project-aware agent -- a persistent AI assistant that "knows" the entire project. The CTO replaces the former Concierge Agent concept with a richer, interactive agent that serves as both a conversational interface and an intelligent entry point for development workflows.

The CTO tab uses a five-sub-tab layout: **Chat** (persistent conversational interface), **Team** (worker org chart and management), **Memory** (operator-facing memory browser with procedures, skills, knowledge sync, and raw-memory provenance), **Linear** (bidirectional Linear sync with OAuth plus manual token connection, project discovery, and workflow management), and **Settings** (CTO identity, persona, and configuration). An onboarding wizard handles first-run setup including identity creation, project scanning/bootstrap, and integration handoff.

**Core Capabilities**: The CTO has full access to ADE's infrastructure via MCP tools. It can create missions, spin up lanes, check project state, read context packs, review conflict predictions, and route external requests to the appropriate internal workflow. Unlike mission workers (which are ephemeral and task-scoped), the CTO is persistent and project-scoped -- it accumulates knowledge about the project over time and can answer questions, suggest approaches, and take action based on deep project understanding.

**Three-Tier Memory Model**: The CTO uses the same three-tier memory architecture as mission workers (Core/Hot/Cold) with auto-compaction, but with a significantly larger core memory allocation. Its core memory includes project architecture, key conventions, recent mission outcomes, active lane states, and accumulated project knowledge. Hot memory retrieval surfaces relevant historical context (past decisions, learned patterns, known pitfalls) on demand. Cold memory provides access to the full project history when explicitly queried.

**Interaction Model**: The CTO tab's Chat sub-tab presents a persistent chat interface. Users can ask questions about the project ("what's the state of the auth module?"), request actions ("create a mission to refactor the payment service"), or delegate complex workflows ("review what happened overnight and summarize"). The CTO can also receive requests from external systems via the MCP server, making it the designated router for programmatic development requests from tools like OpenClaw or custom agent frameworks.

**Relationship to Missions**: The CTO can create and monitor missions but does not replace the orchestrator. The CTO operates at the project level (strategic), while the orchestrator operates at the mission level (tactical). The CTO might decide a mission is needed, configure its phases, and launch it, then monitor progress and intervene if the orchestrator escalates.

**Linear Integration**: The CTO owns bidirectional Linear sync. Inbound: issues matching configured workflow definitions are ingested, dispatched to missions or workers, and tracked through completion with closeout (state transitions, artifact links, comments). Outbound: mission outcomes, PR links, and proof artifacts are published back to Linear issues. The Linear connection flow supports OAuth with manual token fallback, project discovery, validation, and reconnect/retry states. CTO-owned Linear intake is separate from automation-trigger Linear follow-up actions.

**Memory Review Surface**: The CTO Memory sub-tab is an operator-facing review surface (not just a raw browser). It exposes raw-memory provenance for intervention-derived, PR-derived, and recurring-failure captures; learned procedures with confidence history and source episodes; indexed skills with reveal/re-index actions; and knowledge freshness via the human-work digest sync state.

See: [features/CTO.md](features/CTO.md)

### 7.11 Missions

The Missions tab is the AI orchestrator control center. Missions use a **configurable phases model** where users define the structure and constraints of a mission, and the AI orchestrator executes accordingly. The tab provides mission launch with phase configuration, status-lane board views, intervention queues, phase and task progress, orchestrator run controls (start, pause, resume, cancel), attempt history, outcomes, artifacts (including PR links), and mission timeline events.

#### Configurable Phases Model

Planning is a built-in mission phase (`planning`) and is enabled by default in built-in profiles. The coordinator performs planning inside the run, can ask clarification questions, and must transition explicitly into `development` before execution fan-out.

Missions ship with pre-built execution phases that cover the standard development lifecycle:

- **Development**: Code implementation across isolated lanes
- **Testing**: Test execution, coverage analysis, regression detection
- **Validation**: Output review, acceptance criteria verification
- **PR & Conflict Resolution**: Pull request creation, conflict detection and resolution

**Ordering Rules**: Phases follow hard and flexible ordering constraints:
- *Hard rules*: Development runs first among execution phases. Validation runs after Development.
- *Flexible rules*: Testing can be configured as TDD (before Development) or traditional (after Development, before Validation).

**Custom Phases**: Users can create custom phases for specialized workflows. Examples include "UI Planning" (design review before implementation), "Documentation Update" (auto-generate docs after code changes), "Security Audit" (run security scans at milestone boundaries), or any project-specific workflow step. Custom phases use the same template and card structure as built-in phases -- there is no distinction at the execution level. Custom phases are validated for structural correctness, semantic coherence, and ordering constraint compatibility.

**Phases as Guides, Not Hard-Coded Types**: Phases are guides for the orchestrator, not hard-coded types. There are no special behaviors tied to any phase name -- the orchestrator reads the phase card instructions and decides how to execute using any of its capabilities. A phase named "Testing" does not trigger different orchestrator code than a phase named "Security Audit"; the orchestrator interprets the instructions on the card and acts accordingly. Per-phase model selection determines what model the workers in that phase use; the orchestrator itself stays on one pre-selected model throughout the entire mission.

**Phase Cards**: Each phase is configured as a card with the following properties:
- **Name and description**: Human-readable phase identity and purpose
- **Instructions**: Natural language instructions for the orchestrator describing what this phase should accomplish
- **Model selection**: Which AI model workers use for this phase (e.g., Claude for testing, Codex for implementation). This is the worker model, not the orchestrator model -- the orchestrator runs on its own pre-selected model for the entire mission
- **Budget cap**: Maximum token/cost budget for this phase (enforced for API key users, informational for subscription users)
- **Position constraints**: Where this phase can appear in the sequence (before/after dependencies)
- **Ask-questions toggle**: Whether the orchestrator should pause for user input during this phase
- **Validation gate toggle**: Whether phase completion requires passing a validation check before proceeding

**Phase Profiles**: Phase configurations are managed at three levels:
- *Global defaults*: Configured in Settings, apply to all missions unless overridden
- *Profiles*: Named phase configurations for different mission types (e.g., "quick fix" with minimal phases, "full feature" with all phases, "TDD" with testing before development)
- *Per-mission overrides*: Custom phase configuration at mission launch time

The orchestrator reads phase configuration and executes accordingly -- it is AI-driven, not deterministic. The orchestrator understands phase context and scales complexity appropriately (a simple bug fix does not need the same phase rigor as a multi-service feature).

#### Pre-Mission Launch

Before a mission starts, a **pre-flight checklist** validates readiness:
- **Model detection**: Selected models for each phase are detected and authenticated
- **Permission/runtime compatibility**: Selected runtime modes must match the configured phases and providers (for example, read-only planning and mutating development when required)
- **Worktree availability**: Git worktrees are available for parallel lane creation
- **Phase configuration validity**: Phase cards pass structural validation (required fields, valid ordering constraints), semantic validation (instructions are coherent), and ordering validation (no circular dependencies, hard rules respected)
- **Budget estimation**: Best-effort cost estimation based on phase budgets and selected models
- **Phase profile selection**: User selects a phase profile or configures custom phases

Phase card validation for custom phases includes both structural checks (are all required fields present?) and semantic checks (do the instructions make sense for the phase position?).

#### Missions Home Dashboard

When no mission is selected, the Missions tab shows a home dashboard view. The dashboard displays: active missions at the top with live status indicators, recent missions with their status/duration/outcome, aggregate statistics (completion rate, total cost, common phases), and a quick-launch button for starting new missions. Completed missions can be opened to view their frozen final state -- the Plan, Chat, and Work sub-tabs display historical data as it was at mission completion, providing a full post-mortem view without any live elements.

#### Mission Detail View (Sub-tabs)

Mission detail uses a sub-tab layout for different views into the running mission:

- **Plan**: Hierarchical task list showing milestones, tasks, and subtasks with real-time status updates. Each item shows its current state (pending, in-progress, completed, failed), assigned worker, and dependencies. This is the primary view for understanding mission progress at a glance.
- **DAG**: Visual dependency graph showing task relationships, critical path, and execution flow. Uses SVG `animateTransform` for smooth node animations.
- **Chat**: Mission chat workspace (`MissionChatV2`) with channel-specific behavior. Global is the high-signal summary/broadcast thread for orchestrator decisions, system signals, and cross-agent updates. Worker and orchestrator channels provide detailed thread views, including structured tool/thinking/status rendering through the shared chat message renderer. Users can still send directed or broadcast messages with @mentions, but the UI no longer treats all mission activity as one mixed timeline.
- **Work**: "Follow mode" -- select a running worker and see its live terminal output, files being edited, and tools being called. This is the raw worker output view, separate from the chat timeline. Users can switch between workers to observe any worker's real-time execution.
- **Activity**: Timeline feed of orchestrator events including phase transitions, worker spawning, intervention requests, validation results, and milestone completions. Filterable by category.
- **Details**: Usage metrics, phase progress indicators, budget consumption, model usage breakdown, and mission configuration summary.

#### Validation During Development (Tiered)

Validation is structured as runtime-enforced contracts:

- **Tier 1 -- Self-validation** (free): Workers self-validate their output against embedded checklists derived from phase instructions and acceptance criteria. This runs automatically within each worker's context window at no additional cost.
- **Tier 2 -- Dedicated validator** (expensive, gates only): At milestone boundaries and phase transitions with required validation gates enabled, runtime auto-spawns a validator worker to perform thorough review.
- **Strict enforcement**: Required validation cannot be bypassed. Missing required validation blocks phase advancement and emits explicit runtime events.

#### Intervention and Permission Handling

- **Granular pausing**: Only the stuck worker pauses when an intervention is needed, not the entire mission (unless the stuck worker is blocking a dependency that other workers need).
- **Phase-aware permissions**: Pre-flight validates that the selected runtime/permission profile is compatible with the configured phases. Planning should remain read-only; mutating phases can use edit/full execution depending on the provider/runtime.
- **Escalation chain**: Worker attempts self-resolution first, then escalates to the orchestrator, which either resolves autonomously or escalates to the human via the intervention panel.
- **AI failure diagnostician**: When a worker fails, the orchestrator analyzes the failure and recommends one of: skip (mark task as non-blocking and continue), workaround (alternative approach), retry (with adjusted context or approach), or escalate (requires human input).

#### Orchestrator Intelligence

The orchestrator scales its approach based on mission complexity:
- **Simple missions** (1 worker, no parallelism): Straightforward sequential execution. No need for complex coordination.
- **Medium missions** (2-3 workers, limited parallelism): Wave-based execution with basic dependency tracking.
- **Large missions** (milestone-based, parallel workers): Full milestone decomposition, parallel worker pools using worktrees for isolation, inter-worker communication, and phased validation.

**Worktree advantage**: ADE uses git worktrees for worker isolation, enabling true parallel development on the same repository -- a structural advantage over competitors that rely on single-branch workflows.

**Milestone-based context management**: After each milestone, the orchestrator triggers context compaction -- saving important state to run-scoped memory and summarizing prior context. This prevents context overflow in long-running missions.

**Flat orchestrator model**: There are no sub-orchestrators. One orchestrator manages the entire mission. Workers can spawn sub-workers internally if needed, but orchestration authority is centralized.

**Smart prompting**: The orchestrator understands phase context and adjusts its approach accordingly. A development phase gets implementation-focused prompts with architectural context; a testing phase gets focused, execution-oriented prompts with test specifications.

#### Inter-Worker Communication

Workers within a mission communicate in real time via @mentions. Messages are routed through the orchestrator's message bus and delivered via dual-path delivery: PTY injection for CLI-based workers and SDK message API for SDK-managed workers. The orchestrator can broadcast messages to all workers or relay between specific pairs. High-signal coordination appears in the Global chat channel, while detailed worker/orchestrator activity lives in thread-specific channels.

#### Context Compaction Engine

Long-running missions benefit from automatic context compaction. When a worker's context reaches 70% of its window limit, the compaction engine triggers a pre-compaction writeback (persisting important state to memory) followed by context summarization. Sessions resume from compacted state, preventing context overflow during extended missions.

#### Scoped Memory Architecture

Mission context is organized into explicit scopes (`runtime-thread`, `run`, `project`, `identity`, `daily-log`). A Context Budget Panel in the UI provides visibility into retrieved/promoted context and allows manual promotion/archival workflows.

#### Budget Management

- **Subscription users**: Best-effort estimation of remaining budget. ADE tracks usage internally and displays it as informational -- never blocks mission launch over budget uncertainty in subscription mode. For subscription users, ADE reads local CLI session data from `~/.claude/` (session logs containing token counts, models, and timestamps) to compute accurate usage against known subscription limits. No API calls or authentication are required -- this is purely local file analysis. This enables accurate "X remaining of 5hr window" display in the pre-flight checklist, per-mission cost tracking, and per-phase/per-worker cost breakdown.
- **API key users**: Exact budget tracking with hard caps. Per-phase budgets are supported and enforced. When a phase exceeds its budget, the orchestrator pauses and escalates.
- **Rate limit handling**: When a rate limit is hit, the affected worker auto-pauses, waits for the rate limit window to reset, and retries automatically. Other workers continue unaffected.

#### Mission Introspection & Reflection Protocol

Every agent in the mission system (orchestrator, workers, validators) actively reflects on its own experience during execution. Agents write structured reflections to `.ade/reflections/<mission-id>.jsonl` noting capability gaps, workflow friction, improvement ideas, reusable patterns discovered, and limitations encountered. After each mission completes, a retrospective synthesis produces a summary of pain points, improvement suggestions, and patterns worth capturing. Each retrospective includes a changelog showing what previous pain points have been addressed and what remains open, enabling the system to track its own improvement trajectory. Reflection patterns that are codebase-specific get promoted to learning pack entries; system-level observations about orchestrator workflow stay in the reflection system for future self-improvement.

See: [features/MISSIONS.md](features/MISSIONS.md)

### 7.12 Settings

The Settings tab provides application preferences including AI provider configuration (guest mode plus CLI/API/OpenRouter/local provider setup), per-task-type model routing (which model/provider handles planning, implementation, review, conflict resolution, narratives, and PR descriptions), per-feature AI toggles (enable/disable individual AI capabilities: narratives, conflict proposals, PR descriptions, terminal summaries, mission planning, orchestrator), AI usage dashboard (per-feature usage bars, provider status with rate limits where available, budget controls with daily limits, usage history trends), detected provider/CLI health, process/test configuration export/import, keyboard shortcuts reference, theme selection (Clean Paper light or Bloomberg Terminal dark), and mission phase profile management. Budget controls defined here support both subscription (informational) and API key (hard cap) modes, with per-phase budget configuration available in phase profiles.

**Phase Profile Management**: Settings includes a dedicated section for managing mission phase profiles. Users can create, edit, and delete named phase profiles that define default phase configurations for different mission types. Each profile specifies which phases are included, their ordering, model selection, budget caps, validation gates, and custom instructions. Phase profiles configured here serve as the global defaults that can be overridden per-mission at launch time.

**Automations**: Automations is a first-class tab and the canonical surface for creating, simulating, running, and reviewing background workflows. Settings provides defaults and integration setup for Automations (models, budgets, connectors, shared templates, Night Shift defaults) but is not the main builder UI.

See: [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md)

---

## 8. Feature Documentation

Each feature area is specified in detail in the following documents. These are the authoritative references for functional requirements, UX surface, edge cases, and development checklists.

| # | Feature | Document | Summary |
|---|---------|----------|---------|
| 1 | Lanes | [features/LANES.md](features/LANES.md) | The primary cockpit for parallel work. Covers lane types (primary, worktree, attached), 3-pane layout, diff views, in-app git operations, stacked lane workflows, lane profiles, overlay policies, per-lane hostname isolation and preview URLs, OAuth redirect handling, and runtime diagnostics. |
| 2 | Run (Command Center) | [features/PROJECT_HOME.md](features/PROJECT_HOME.md) | Project command center with play/pause icon. Covers managed process lifecycle, stack buttons, test suites, lane-scoped command execution, AI-suggested run prompts, CI/CD workflow sync, agent CLI tools registry (Claude Code, Codex, Cursor, Aider, Continue), and project configuration editing. |
| 3 | Files and Editor | [features/FILES_AND_EDITOR.md](features/FILES_AND_EDITOR.md) | IDE-style file workbench. Covers workspace scope selection, file explorer tree, Monaco editor with diff modes, quick edit, conflict marker editing, and atomic save operations. |
| 4 | Terminals and Sessions | [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) | PTY-based embedded terminals and agent chat sessions. Covers lane-scoped sessions, transcript capture, session metadata tracking, checkpoint creation on session end, agent command shortcuts, the session end contract, and agent chat integration (Codex App Server, Claude multi-turn, and unified API/local runtime). |
| 5 | Conflicts | [features/CONFLICTS.md](features/CONFLICTS.md) | Conflict prediction and resolution radar. Covers per-lane conflict prediction, pairwise lane-lane risk matrix, merge simulation, near-real-time updates from staged/dirty changes, and AI-powered proposal workflows via the agent SDKs. |
| 6 | Pull Requests | [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md) | GitHub PR integration via local `gh` CLI and PATs. Covers PR creation and linking per lane, checks/review status display, description drafting from packs, stacked PR chain visualization, and the land stack guided merge flow. |
| 7 | History | [features/HISTORY.md](features/HISTORY.md) | ADE operations timeline. Covers chronological event stream, feature history aggregation, event detail with jump links, context replay from checkpoints, undo capabilities, and graph visualization (V1). |
| 8 | Packs | [features/PACKS.md](features/PACKS.md) | Durable context and history system. Covers immutable checkpoints, append-only pack events, pack versioning with head pointers, materialized current views, all six pack types, the update pipeline, and privacy/retention controls. |
| 9 | Workspace Graph | [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md) | Infinite-canvas topology overview. Covers primary/worktree/attached node rendering, stack and risk edge overlays, merge simulation interactions, and snapshot-based status overlays. |
| 10 | Missions | [features/MISSIONS.md](features/MISSIONS.md) | AI orchestrator control center for mission intake and execution. Covers mission lifecycle, orchestrator run management, step DAG visualization, intervention queues, artifacts (including PR links), timeline events, and per-task-type model routing. |
| 11 | Automations | [features/AUTOMATIONS.md](features/AUTOMATIONS.md) | First-class background execution surface. Covers trigger families (local + GitHub/webhook), executor routing (automation bots, employees, CTO-route, Night Shift), templates, tool palettes, automation-scoped memory, simulation, history, and overnight review. |
| 12 | Onboarding and Settings | [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) | Repository initialization and user preferences. Covers onboarding flow (repo selection, `.ade/` setup, CLI tool detection), trust surfaces, operation previews, escape hatches, AI provider and per-task-type routing configuration, automation defaults/integration setup, and theme/keybinding settings. |
| 13 | CTO | [features/CTO.md](features/CTO.md) | Always-on project-aware agent. Covers the CTO's persistent chat interface, three-tier memory model with project-scoped core memory, MCP tool access for mission creation and lane management, external request routing, and relationship to the mission orchestrator. Persistent employees can own and execute automations created in the Automations tab. |

---

## 9. Architecture Documentation

Each architecture area is specified in detail in the following documents. These define the system contracts, data models, and implementation patterns.

| # | Architecture Area | Document | Summary |
|---|-------------------|----------|---------|
| 1 | System Overview | [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) | Top-level component breakdown (desktop UI, local core engine, AI Integration Layer), the happy-path data flow from lane creation through PR landing, key contracts, and the multi-provider model (CLI/API/local). |
| 2 | Desktop App | [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) | Electron process model (main, renderer, preload), IPC contracts and typed channel allowlist, PTY hosting in the main process, and the recommended folder/repo layout. |
| 3 | Data Model | [architecture/DATA_MODEL.md](architecture/DATA_MODEL.md) | Local SQLite schema covering projects, workspaces, lanes, stacks, sessions, processes, tests, operations, checkpoints, pack events, pack versions, pack heads, missions (mission/step/event/artifact/intervention), planning threads, plan versions, conflict predictions, orchestrator timeline events, and orchestrator gate reports. |
| 4 | Git Engine | [architecture/GIT_ENGINE.md](architecture/GIT_ENGINE.md) | Git worktree management, drift status computation (ahead/behind/dirty), sync operations (merge and rebase with undo), dry-run conflict prediction, and stack-aware rebase operations. |
| 5 | Job Engine | [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md) | Event-driven pipeline with coalescing rules. Covers all event types, idempotent job definitions, the lane refresh pipeline (checkpoint through AI augmentation), real-time conflict pass, re-plan pipeline, and failure handling. |
| 6 | AI Integration | [architecture/AI_INTEGRATION.md](architecture/AI_INTEGRATION.md) | Local AI integration architecture. Covers unified runtime contracts, provider-native CLI paths, ADE MCP/coordinator tool surfaces, AI orchestrator session management, per-task-type model routing, CLI/API/local provider handling, and the safety contract for AI-generated proposals. |
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

**Context hardening policy (current baseline)**:

- Orchestrator state transitions, scheduling, retries, claims, and gates are deterministic code/state-machine paths.
- The coordinator AI owns strategy decisions (planning, delegation, replanning, completion) while runtime code enforces boundaries (permissions, budgets, state integrity, and auditability).
- Mission startup is fail-hard: if coordinator startup fails, ADE pauses with intervention instead of switching to non-autonomous fallback logic.
- Default orchestrator context profile uses bounded digest refs (prioritizing `.ade/context/PRD.ade.md` and `.ade/context/ARCHITECTURE.ade.md` plus discovered docs); full doc bodies are included only when step policy explicitly requires `includeFullDocs`.

**Update pipeline**: On session end, the pipeline creates a checkpoint, appends events, materializes lane/project/feature packs, predicts conflicts, updates conflict packs if needed, and optionally requests AI narrative augmentation via the agent SDKs. This pipeline runs through the job engine with coalescing to avoid redundant work.

**Storage**: Packs are stored under `.ade/artifacts/packs/` with immutable versions, head pointers, and materialized current views. History artifacts (checkpoints, events) are stored under `.ade/history/`. All storage is local-only.

See: [features/PACKS.md](features/PACKS.md)

### 10.2 Mission Workers

Mission workers are the agents that the orchestrator spawns to execute tasks within a mission. Workers are ephemeral -- they exist for the duration of their assigned task and are torn down when complete. There is no user-facing "create an agent" flow; workers are spawned automatically by the orchestrator based on mission phase configuration and task decomposition.

**Worker Execution Model**: Workers are NOT continuously running model processes. They are **ephemeral agent invocations** spawned by the orchestrator into isolated lanes (typically git worktrees). When the orchestrator spawns a worker, the worker's state is constructed from the mission's context: phase instructions, task description, relevant memory scopes, learning packs, and project context are assembled into the worker's initial prompt. When the task completes, the worker's outputs (code changes, test results, artifacts) are captured and the worker is terminated. Between invocations, workers consume zero resources.

**Worker Identity**: Workers do not have persistent identities like the CTO. Instead, they receive task-scoped identity from the mission: the phase they are executing, the model they are using, and the instructions they are following. The orchestrator assigns worker identities at spawn time based on phase configuration (e.g., a worker in the Development phase using Claude receives development-oriented instructions and the Claude model configuration from the phase card).

**Context Window Optimization**: ADE separates business context from code context in worker prompts, inspired by the ZOE/CODEX split pattern. Business context (mission intent, acceptance criteria, architectural constraints, phase instructions) is injected as a structured preamble. Code context (diffs, file contents, test results) is streamed on-demand via MCP tools. This separation allows the orchestrator to maximize the useful information density within each worker's context window. Additional techniques include observation masking (filtering out irrelevant tool output before it enters context) and importance classification (tagging context entries by criticality so that compaction preserves the most valuable information).

**Worker Autonomy**: Workers operate within their assigned lane under the permission mode appropriate to their phase and provider. Planning/read-only workers should stay non-mutating; implementation workers can read/write/run tools when their provider/runtime mode allows it. ADE separately scopes its own coordinator/MCP tools by role. If a worker encounters a situation it cannot resolve, it escalates to the orchestrator (not directly to the human).

**Background Automations**: Autonomous background behaviors live in the dedicated Automations tab. Rules can be created there, simulated before activation, assigned to automation bots or persistent employees, routed through the CTO, or queued for Night Shift. Settings only holds defaults and integration credentials.

### 10.3 Workspace Graph

The workspace graph is an infinite-canvas mindmap showing the entire development topology of a repository. The main branch sits at the center representing production; branches like `develop` or `staging` are positioned as intermediate environment nodes. Feature lanes, worktrees, and attached lanes radiate outward, connected by topology, stack, and risk edges. Environment badges (PROD, STAGING, DEV) are rendered on branches with configured environment mappings. PR status overlays show open PRs on edges alongside conflict risk indicators. Stack edges show parent-child relationships. Users can pan, zoom, click nodes to focus lane details, and click edges to open merge simulation panels. The result is a deployment-aware topology map that answers "what connects to what, where are the conflicts, and which PRs are open" at a glance.

See: [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md)

### 10.4 Job Engine

The job engine is the coordination backbone that keeps all ADE state synchronized. It processes events (session end, HEAD change, staged set change, branch switch, base update) and dispatches idempotent, coalesced jobs. Per-lane coalescing ensures only one refresh pipeline runs at a time with at most one pending follow-up. Pairwise conflict passes use short debounce for staged/dirty events. AI augmentation (narrative generation, conflict proposals) is triggered on session end and coalesced during active work. Failure handling is explicit: failed checkpoints mark lanes as stale, failed materializations preserve prior pack versions, and failed predictions mark risk as "unknown" rather than "clean."

See: [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md)

### 10.5 AI Integration

The AI Integration Layer provides narrative augmentation, conflict resolution proposals, mission orchestration, and PR description drafting, while keeping repository access inside ADE-managed runtime boundaries.

**Unified runtime contracts**: ADE routes work through provider-native Claude CLI / Codex CLI runtime paths plus in-process API/OpenRouter/local runtime adapters. The orchestrator and chat surfaces work against shared runtime contracts rather than keeping separate legacy executor classes as the primary architecture.

- **Agent Chat Service**: Native interactive chat interface using the Codex App Server protocol (JSON-RPC 2.0), Claude community provider (multi-turn `streamText()`), and unified API/local runtimes. Provider-agnostic `AgentChatService` interface persists chat as first-class sessions (`codex-chat`, `claude-chat`, `ai-chat`) with delta tracking, pack integration, and approval flows.

**MCP Server** (`apps/mcp-server`): A local JSON-RPC 2.0 server over stdio transport that exposes ADE's infrastructure as tools callable by the AI orchestrator. Tool surface includes:

- `spawn_agent` -- launch an agent in a specified lane
- `read_context` -- retrieve pack contents for a lane, feature, or project
- `create_lane` -- create a new worktree lane for isolated work
- `check_conflicts` -- run conflict prediction between lanes
- `merge_lane` -- merge a lane into its target branch
- `ask_user` -- route an intervention request to the ADE UI
- `run_tests` -- execute test suites in a lane's worktree

**AI Orchestrator**: A phase-aware coordinator runtime constrained to ADE coordinator tools. The orchestrator:

1. Receives a mission prompt enriched with bounded context pack exports.
2. Uses the AI meta-reasoner to determine optimal dispatch strategy (sequential, parallel, wave, or adaptive fan-out).
3. Enters the built-in planning phase and hands planning work to a read-only planner when enabled.
4. Decomposes the mission into a step DAG with dependencies, join policies, and done criteria.
5. Spawns workers (Claude Code, Codex, or in-process models) into isolated lanes via ADE-managed runtime tooling.
6. Monitors worker progress through session events, checkpoints, and pack updates.
7. Facilitates inter-worker communication via @mention routing and the mission message bus.
8. Manages context lifecycle through the compaction engine and scoped memory architecture.
9. Routes human-in-the-loop decisions through the intervention panel.
10. Advances the step DAG based on coordinator strategy plus runtime-enforced state/validation contracts.

**AI Meta-Reasoner**: Before dispatching workers, the orchestrator's meta-reasoner analyzes the mission to select the best fan-out strategy. The four dispatch strategies are: sequential (workers execute one at a time, suitable for dependent tasks), parallel (all workers launch simultaneously, suitable for independent tasks), wave (workers launch in phased groups, balancing parallelism with coordination), and adaptive (strategy adjusts dynamically based on real-time progress and resource pressure). The meta-reasoner considers mission complexity, inter-step dependencies, available compute resources, and budget constraints.

**Inter-Worker Communication**: Workers within a mission can communicate with each other in real time. Messages use @mention syntax and are routed through the orchestrator's message bus. Delivery is dual-path: PTY injection for CLI-based workers and SDK message API for SDK-managed workers. The orchestrator can also broadcast messages to all workers or relay messages between specific pairs. All inter-worker messages are logged in the mission timeline and surface through the mission chat workspace, with Global reserved for summary/broadcast traffic and per-thread views reserved for detailed worker/orchestrator activity.

**Context Compaction Engine**: Long-running worker sessions accumulate context that can exceed model window limits. The compaction engine monitors context usage and triggers at a configurable threshold (default 70%). Before compaction, a writeback phase persists critical state (decisions, partial results, key findings) to the memory layer. The compacted context retains a summary of prior work plus the most recent detailed context. Sessions can resume from compacted state, enabling arbitrarily long missions without context overflow.

**Scoped Memory Architecture**: Mission context flows through explicit namespaces:
- **`runtime-thread`**: Current runtime context window. Volatile, managed by compaction.
- **`run`**: Shared mission/run context across workers in the same run.
- **`project`**: Long-term cross-mission knowledge.
- **`identity`**: CTO-owned durable memory (workers use mission-scoped memory instead).
- **`daily-log`**: Bounded operational continuity snapshots for briefing/resume.

Candidate entries are promoted by relevance/confidence and policy. The Context Budget Panel in the mission UI shows real-time memory retrieval and promotion status.

**Three-Tier Memory Model**: Memory is organized into three tiers based on access frequency and context cost. The CTO uses all three tiers with a large core allocation; mission workers primarily use core and hot memory scoped to their task.

- **Core Memory** (~2-4K tokens): Always present in the context window. For the CTO, this contains project identity, architecture overview, active mission states, and accumulated project knowledge. For workers, this contains task description, phase instructions, and critical constraints. This tier is never evicted -- it defines the baseline context that every invocation starts with.
- **Hot Memory** (retrieved on demand): Stored in a local vector database and retrieved via semantic search when relevant to the current task. Includes recent mission outcomes, learned patterns, project conventions, and frequently-referenced architectural decisions. Retrieved entries are scored and injected into context only when their relevance exceeds a configurable threshold.
- **Cold Memory** (archival): Rarely accessed historical data including old mission transcripts, superseded decisions, and low-confidence observations. Cold memory is queryable but never automatically injected. It serves as a long-term knowledge base that can be surfaced on explicit request.

**Memory Scopes (Extended)**: Beyond the runtime namespaces above, memory is also scoped by ownership:
- **Identity scope**: CTO-owned memory that persists across all missions and sessions. Captures the CTO's learned preferences, project understanding, and accumulated expertise. Stored in `.ade/cto/memory/`.
- **Project scope**: Shared across the CTO and all workers on the same project. Captures architectural rules, coding conventions, known pitfalls, and team preferences. Stored in `.ade/memory/project/`.
- **Mission scope**: Per-mission-run memory that captures decisions, intermediate findings, and coordination state for workers within a single mission. Discarded or archived when the mission completes.
- **Session scope**: Ephemeral conversational memory that exists only for the duration of a single worker invocation. Used for short-term reasoning and working memory. Not persisted.

**Memory Innovations**:
- **Pre-compaction flush**: Before the compaction engine summarizes context, all in-flight memories are explicitly saved to their appropriate durable tier. This prevents knowledge loss at compaction boundaries -- the most common failure mode in long-running sessions.
- **Memory consolidation**: When new memories overlap with existing entries, a consolidation pass applies one of four operations: PASS (keep both), REPLACE (new supersedes old), APPEND (merge into richer entry), or DELETE (new evidence invalidates old). This prevents memory bloat from redundant observations.
- **Temporal decay**: Memory entries have a half-life (default 30 days). Relevance scores decay over time unless entries are reinforced by repeated access or explicit user confirmation. This ensures that stale knowledge gradually fades while actively-useful knowledge remains prominent.
- **Composite scoring for retrieval**: Hot memory retrieval uses a composite score combining semantic similarity, recency, access frequency, confidence level, and explicit importance tags. This multi-signal approach produces better retrieval quality than pure vector similarity.

**Vector Search**: Memory retrieval is powered by `sqlite-vec`, an embedded SQLite extension for vector similarity search. This keeps all memory infrastructure local -- no external vector databases or cloud services required. Embeddings are generated locally using lightweight models and stored alongside memory entries in the SQLite database.

**Episodic Memory**: Structured summaries of completed sessions and missions. Each episodic entry captures what happened (actions taken), why (decisions and rationale), what was learned (new knowledge or corrections), and the outcome (success, failure, or partial). Episodic memories enable the CTO and future workers to learn from past experience across missions.

**Procedural Memory**: Learned workflows and tool-usage patterns that improve worker efficiency over time. When a worker discovers an effective sequence of tool calls for a recurring task type (e.g., "run tests, check coverage, fix failures, re-run"), the pattern is captured as procedural memory and suggested in future similar contexts.

**Design Influences**: The memory architecture synthesizes patterns from several production systems and research projects — MemGPT/Letta (tiered memory with agent-managed read/write), Mem0 (PASS/REPLACE/APPEND/DELETE consolidation), CrewAI (composite scoring with multi-signal retrieval), OpenClaw (pre-compaction flush, hybrid BM25+vector search), LangMem/LangChain (episodic/procedural memory taxonomy), A-MEM (Zettelkasten-inspired linking), and JetBrains' NeurIPS 2025 research (observation masking outperforms LLM summarization). Detailed attribution is documented in `features/CTO.md` and `final-plan/phase-4.md`.

**Learning Pack Integration**: Learning packs (Section 10.9) feed into the memory system as high-confidence project-scope entries. Confirmed learning pack entries are promoted to core or hot memory based on their relevance to the current task. The memory system and learning packs share a unified confidence scoring model.

**Per-task-type model routing**: Users configure which model/provider handles each task type in Settings. The AI Integration Layer routes requests accordingly, allowing mixed-provider workflows (e.g., Claude for planning, Codex for implementation).

**Runtime call-flow contract**: Programmatic AI execution uses one modern call path (`aiIntegrationService` -> executor/unified runtime). Legacy hosted/BYOK compatibility branches are removed from runtime execution flow.

**Cost controls**: Execution is tied to session boundaries, not keystrokes. Context pack exports are bounded by default. The orchestrator context profile excludes narrative text unless explicitly opted in. Content-hash caching avoids redundant work.

**Usage tracking**: Every AI call is logged to a local `ai_usage_log` table with feature type, provider, model, token counts, duration, and success status. The Settings tab surfaces this data as a usage dashboard with per-feature progress bars, subscription status, and configurable budget controls. Budget enforcement supports both per-phase caps in missions and per-automation caps in the Automations system (Night Shift, scheduled tasks, etc.).

### 10.6 Compute Backends

Mission workers execute in ADE-managed local runtime boundaries today. The active roadmap keeps that model simple:

- **Local** (Default): Worker runs as a subprocess on the developer's machine, operating in a git worktree managed by ADE. Zero setup, zero cost, full access to local tools and credentials.
- **Future user-owned VPS brain** (Phase 6): ADE itself runs on a remote machine that the user controls, and other devices connect to that brain. This is not a pluggable managed compute backend layer.
- **Dropped / non-active direction**: Daytona, E2B, and the broader pluggable compute-backend abstraction are not part of the active ADE roadmap.

### 10.7 Worker Computer Use

Workers can interact with running applications visually through computer use capabilities. Three compute environment types support different levels of interaction:

- **Terminal-only**: Default. Worker operates via CLI commands in a worktree or sandbox.
- **Browser**: Headless browser (Playwright) for web app testing and verification. Worker can navigate, click, type, screenshot.
- **Desktop**: Full virtual desktop (Xvfb + window manager) for desktop apps, Electron apps, mobile emulators. Worker gets mouse/keyboard control, screenshot capture, and video recording.

Computer use is powered by provider-native APIs: Anthropic's Computer Use Tool for Claude workers and OpenAI's CUA for Codex workers. The active plan treats this as a runtime capability layered onto ADE's local execution model rather than a matrix of pluggable compute backends.

Target behavior: artifacts produced by computer use (screenshots, videos, test results) attach to the lane or mission and are included in closeout and PR workflows.

Current implementation note (2026-03-12): ADE already supports mission evidence requirements such as `screenshot`, `browser_verification`, and `video_recording`, and can publish artifact links in Linear closeout. Native computer-use runtime tooling and automatic PR proof embedding are not shipped end-to-end yet.

### 10.8 Artifacts

Artifacts are first-class objects that can attach to missions, lanes, or worker runs. Target types include: summary, pr, link, note, patch, screenshot, video, test-result.

Lane-level artifacts enable workers operating in a lane (via chat, mission phases, or automation tasks) to attach visual proof and outputs directly to the lane. The intended UX is for attached screenshots/videos to flow into PR descriptions and closeout summaries once the computer-use runtime and artifact unification work is fully shipped.

Artifact storage is local under `.ade/artifacts/`, organized by mission or lane. Artifacts are referenced by ID in the SQLite database and linked to their parent entity (mission, lane, or worker run).

### 10.9 Learning Packs

Learning packs are auto-curated project knowledge that accumulates from worker and CTO interactions. The system observes worker failures, user corrections, repeated issues, and PR review patterns to build a persistent memory bank that improves worker performance over time.

Knowledge entries have categories (mistake-pattern, preference, flaky-test, tool-usage, architecture-rule), scopes (global, directory, file-pattern), and confidence scores that increase with repeated observations. High-confidence entries are injected into worker and CTO context alongside project packs.

Users can review, edit, confirm, or delete entries in Settings > Memory and CTO > Memory. Confirmed procedural memories can be exported as skill files to `.ade/skills/`. The skill registry also ingests existing `.ade/skills/`, `.claude/skills/`, `.claude/commands/`, `CLAUDE.md`, and `agents.md` files for interoperability. Learning packs are local-only and never transmitted.

### 10.10 Development Modes

ADE supports three complementary modes of work:

**Active Development** (interactive, user-in-the-loop):
- Lane Chat: Direct conversation with Claude or Codex in a lane worktree
- Terminals: Interactive CLI sessions
- CTO: Persistent project-aware agent for strategic questions, mission planning, and project oversight

**Missions** (orchestrated, multi-worker):
- Configurable phase-based workflows with parallel workers in isolated lanes
- Real-time monitoring via Plan, DAG, Chat, Work, Activity, and Details sub-tabs
- Tiered validation (self-check and dedicated validator at gates, runtime-enforced)
- Orchestrator intelligence that scales from simple to complex missions

**Background Automations** (`/automations`, fire-and-forget or employee-backed):
- Automation rules: Builder-defined flows with local triggers plus GitHub and webhook triggers
- Executor routing: disposable automation bots, persistent employees, CTO-route, or Night Shift queue
- Night Shift mode: Scheduled unattended execution with morning digest
- Templates and tool palettes: reusable recipes with explicit allowed tools and verification requirements

Background automations are created and operated from the Automations tab. Each automation defines a trigger, executor, tool palette, memory mode, and guardrails (budget caps, stop conditions, verification rules). Settings supplies shared defaults and connector setup.

Development baseline: ADE assumes a modern Git CLI (worktrees, `git restore`, `git merge-tree --write-tree`, and `--ignore-other-worktrees` flows). There is no legacy-git compatibility mode in runtime call paths.

### 10.11 Cross-Machine Portability

ADE now ships a canonical `.ade` contract. The tracked/shareable subset is committed alongside the repo, while machine-local runtime state is ignored by the tracked `.ade/.gitignore`. Real-time multi-device replication is still Phase 6 work.

Current baseline:
- Git is the reliable cross-machine transport for code and tracked ADE state.
- `.ade` has a defined tracked/shareable subset plus ignored machine-local runtime buckets.
- Startup repair, validation, integrity normalization, and config reload are live.
- Machine-specific credentials remain local-only, either in ignored files or encrypted local storage.

Roadmap direction:
- Phase 6 adds cr-sqlite state sync, device registry, and the brain/viewer model.
- Phase 7 builds remote/mobile control on top of that sync foundation.

### 10.12 External Agent Bridge

ADE's MCP server is the bridge between ADE's internal infrastructure and the external agent ecosystem. Any agent system that speaks MCP (JSON-RPC 2.0 over stdio) can connect to ADE and use it as a development backend.

**Inbound: External Agents Using ADE**

External agent platforms (OpenClaw, Claude Code, Codex, custom agent frameworks) connect to ADE's MCP server to access 35+ tools spanning the full development lifecycle:
- **Mission management**: `create_mission`, `start_mission`, `get_mission`, `steer_mission`, `pause_mission`, `resume_mission`, `cancel_mission`
- **Agent orchestration**: `spawn_agent`, `get_worker_states`, `resolve_intervention`
- **Context and memory**: `read_context`, `get_timeline`, `get_step_output`
- **Lane management**: `create_lane`, `list_lanes`, `get_lane_status`, `merge_lane`, `rebase_lane`
- **Quality gates**: `run_tests`, `check_conflicts`, `simulate_integration`, `evaluate_run`
- **User interaction**: `ask_user`, `resolve_intervention`, `commit_changes`
- **Observability**: `get_run_graph`, `get_mission_metrics`, `get_pr_health`, `stream_events`

The CTO is ADE's designated router for incoming external requests. When an external agent connects and submits a development request, the CTO analyzes the request, determines the appropriate workflow (new mission, context query, conflict check, etc.), and routes it internally. This prevents external systems from needing to understand ADE's internal orchestration model.

**Outbound: ADE Workers Using External Tools**

Starting in Phase 4+, ADE workers and the CTO can also consume external MCP servers, letting them reach into external tool ecosystems. For example, a worker could connect to a design system MCP server to fetch component specs, or the CTO could connect to a project management MCP server to read ticket details and update status. This bidirectional MCP capability positions ADE as both a provider and consumer in the MCP ecosystem.

**Example Flow**: OpenClaw agent receives a user request ("implement the auth module") -> connects to ADE MCP -> CTO receives the request -> creates a mission -> orchestrator plans and spawns workers -> workers execute in isolated lanes -> mission completes -> PR is opened -> result flows back to OpenClaw via MCP.

### 10.13 Worker and CTO Execution Model

This section clarifies the runtime characteristics of ADE's AI agents (mission workers and the CTO), complementing the worker definitions in Section 10.2 and the CTO description in Section 7.10.

**Two Execution Patterns**: ADE has two distinct agent execution patterns:
- **CTO**: A persistent, project-scoped agent with durable identity and accumulated memory. The CTO is "always-on" -- always *available* to respond to requests, not always *thinking* or consuming compute. Between interactions, the CTO is inert but its full state (identity, memory, project context) persists in `.ade/cto/`.
- **Mission Workers**: Ephemeral, task-scoped agents spawned by the orchestrator. Workers exist only for the duration of their assigned task. Their state is constructed at spawn time from mission context and destroyed on completion.

**State Reconstruction**: When either the CTO or a worker is invoked, ADE constructs its state from durable storage:
1. **Identity**: For the CTO, loaded from `.ade/cto/identity.yaml`. For workers, constructed from phase configuration at spawn time.
2. **Core memory**: The CTO's core memory includes persistent project knowledge (~4-8K tokens). Worker core memory includes task description, phase instructions, and constraints (~2-4K tokens).
3. **Hot memory**: Retrieved via vector search based on the current task or query.
4. **Project context**: Loaded from project-scope packs and learning pack entries.
5. **Mission context**: For workers, loaded from the mission's shared run memory.

This reconstruction pattern means the CTO and mission infrastructure are file-backed under `.ade/` and compatible with the cross-machine portability model (Section 10.11). ADE ships a tracked `.ade/.gitignore` that selectively ignores machine-local runtime state (databases, caches, worktrees, transcripts, secrets) while allowing CTO/worker identity, memory artifacts, history, and shared config to be committed alongside the repo.

**Background Automations**: Scheduled and event-driven automations are event-driven. A rule defines its trigger, executor target, tool palette, memory policy, and output contract; when the trigger fires, ADE dispatches either a disposable automation bot, a persistent employee, a CTO-routed worker, or a Night Shift queue item. Between activations, automations consume no compute resources.

**Context Window Strategy**: ADE optimizes context windows for both the CTO and workers using several techniques inspired by the ZOE/CODEX separation pattern:
- **Business/code separation**: Business context (mission intent, acceptance criteria, architectural constraints) is structured as a compact preamble. Code context (diffs, file contents, test output) is streamed on-demand via MCP tools rather than pre-loaded.
- **Observation masking**: Tool outputs that are not relevant to the current reasoning step are filtered before entering context. For example, a successful test run returns only a pass/fail summary rather than the full test output.
- **Importance classification**: Every context entry is tagged with an importance level (critical, high, normal, low). During compaction, critical entries are always preserved, while low-importance entries are summarized or dropped first.
- **Incremental context delivery**: Rather than front-loading all context into the initial prompt, ADE delivers context incrementally via MCP tool calls as the worker progresses through its task. This keeps the active context window focused on what is needed right now.

---

## 11. Security and Privacy

ADE's security model is built on explicit trust boundaries and conservative defaults.

**Trust boundaries**:

- The local core (main process) is the trusted owner of filesystem access, git operations, tests, and undo/rollback.
- CLI-backed workers may mutate files inside ADE-managed worktrees when their provider/runtime permission mode allows it; ADE-owned tool access still stays behind ADE permission boundaries.
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

**Provider authentication**:

- CLI authentication is handled by the tools themselves (Claude Code, Codex) and inherited by subprocess SDK runtimes.
- API-key/OpenRouter/local endpoint credentials are configured locally by the user; ADE does not proxy credentials through a hosted service.
- GitHub integration uses the local `gh` CLI (which manages its own OAuth flow) or user-provided personal access tokens stored in the OS keychain.

---

## 12. Configuration Model

ADE configuration lives in the `.ade/` folder at the project root. The current repo uses a canonical tracked/shareable subset plus a tracked `.ade/.gitignore` that ignores machine-local runtime state. CTO/worker identity and memory are file-backed under `.ade/`, while caches, logs, databases, worktrees, and secret stores remain local-only.

**File layout**:

| File | Purpose | Shareable |
|------|---------|-----------|
| `.ade/ade.yaml` | Shared baseline config (processes, stack buttons, test suites, lane profiles, overlay policies, AI task-type routing defaults, phase profiles, automation definitions) | Yes |
| `.ade/local.yaml` | Machine-specific overrides (including local AI provider preferences and CLI tool paths) | No |
| `.ade/local.secret.yaml` | Machine-local secret config for external MCP and secret-backed integrations | No |
| `.ade/cto/` | CTO identity, memory, and configuration | Yes |
| `.ade/agents/` | Worker identity, memory, and configuration | Yes |
| `.ade/memory/` | Project-scope file-backed memory artifacts | Yes |
| `.ade/artifacts/packs/` | Pack versions and materialized views | No |
| `.ade/history/` | Mission records and tracked JSONL history | Yes |
| `.ade/artifacts/` | Screenshots, videos, test results attached to missions/lanes | No in current design |
| `.ade/transcripts/` | Terminal session transcripts | No |
| `.ade/transcripts/logs/` | Process and test logs | No |
| `.ade/cache/` | Local cache | No |

**Config layering** (load order):

1. Application defaults
2. `.ade/ade.yaml` (shared baseline)
3. `.ade/local.yaml` (machine override)

Arrays of objects merge by stable `id`. Unresolved references (such as stack buttons referencing unknown process IDs) fail validation. Commands are never executed until config passes validation. `local.secret.yaml` is a companion secret file for secret-backed integrations rather than part of the shared/local merge.

**AI task-type routing config**:

Per-task-type model routing is configured in `ade.yaml` (shareable defaults) and overridable in `local.yaml`. Each task type maps to a provider and optional model preference:

```yaml
ai:
  provider: subscription  # or "guest"; task routing may also target api-key/openrouter/local providers
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
- **ADE does not manage AI service accounts or billing directly.** Users bring their own providers (CLI subscriptions, API keys/OpenRouter, or local endpoints). ADE tracks local usage telemetry and displays provider status, but does not interact with billing systems or enforce provider-side limits.
- **Mobile/relay support is roadmap scope, not a non-goal.** Desktop is the current primary runtime, while relay + iOS capabilities are planned in `docs/final-plan/README.md`.
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
| Mission orchestration | End-to-end mission execution with minimal manual intervention | Multi-step missions complete with worker spawning, context injection, and conflict checking through the orchestrator |
| AI provider flexibility | Users can mix providers per task type | Per-task-type routing works correctly with at least two different CLI providers simultaneously |
| AI usage visibility | Users can see per-feature AI consumption at a glance | Usage dashboard loads in <1s, per-feature breakdown is accurate within 5% of actual token usage |
| Inter-worker coordination | Workers share relevant context without manual intervention | @mention messages are delivered within 2s; mission chat shows full worker communication history |
| Context longevity | Long-running missions do not lose critical context | Compaction triggers before overflow; sessions resume from compacted state with key findings preserved |
| Smart dispatch | Orchestrator selects appropriate fan-out strategy | Meta-reasoner correctly identifies parallelizable vs. sequential tasks in >80% of missions |

---

## 15. Implementation Phases

Implementation sequencing, future phases, and dependency ordering are now maintained in:

- `docs/final-plan/README.md`

Current status: Phases 1, 1.5, 2, 3, 4, and 5 are complete. Phase 4 is closed at baseline or better: `W1-W10` are shipped, including the W7c skills/learning follow-through, CTO memory review surfaces, and advanced knowledge capture validation.

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
| **Multi-worker coordination complexity** | Orchestrator managing multiple concurrent workers across lanes introduces scheduling, conflict, and resource contention challenges | Phase-based execution with explicit ordering constraints. Session-backed attempts with clear success/failure/canceled outcomes. Conservative concurrency defaults with user-configurable limits. |
| **Claude subscription auth policy uncertainty** | Anthropic may restrict subscription OAuth in third-party tools | Current Claude CLI/runtime integration keeps ADE flexible; runtime abstraction makes further provider-path changes survivable if policy changes. |
| **Inter-worker message delivery reliability** | Messages between workers could be lost or delayed, causing coordination failures | Dual-path delivery (PTY + SDK API) with message acknowledgment. All messages logged to mission timeline for audit. Orchestrator monitors delivery status. |
| **Context compaction information loss** | Aggressive compaction could discard critical context, causing workers to repeat work or make incorrect decisions | Pre-compaction writeback persists key state before summarization. Configurable threshold (default 70%). User can review and promote important context entries to higher memory layers. |
| **Memory scope promotion accuracy** | Automatic promotion of context entries could surface irrelevant information or miss important findings | Conservative default (manual promotion). Relevance scoring based on reference frequency and recency. Users can review, confirm, or delete promoted entries via the Context Budget Panel. |

---

*This document is the authoritative product requirements reference for ADE. For implementation details, consult the linked feature and architecture documents; roadmap sequencing is maintained in `docs/final-plan/README.md`.*

# ADE (Agentic Development Environment) - Product Requirements Document

Last updated: 2026-02-18

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
   - 7.1 [Run (▶)](#71-run-)
   - 7.2 [Lanes](#72-lanes)
   - 7.3 [Files](#73-files)
   - 7.4 [Terminals](#74-terminals)
   - 7.5 [Conflicts](#75-conflicts)
   - 7.6 [Context](#76-context)
   - 7.7 [Graph](#77-graph)
   - 7.8 [PRs](#78-prs)
   - 7.9 [History](#79-history)
   - 7.10 [Automations](#710-automations)
   - 7.11 [Settings](#711-settings)
8. [Feature Documentation](#8-feature-documentation)
9. [Architecture Documentation](#9-architecture-documentation)
10. [Cross-Cutting Concerns](#10-cross-cutting-concerns)
    - 10.1 [Packs (Context and History System)](#101-packs-context-and-history-system)
    - 10.2 [Automations](#102-automations)
    - 10.3 [Workspace Graph](#103-workspace-graph)
    - 10.4 [Job Engine](#104-job-engine)
    - 10.5 [Hosted Agent](#105-hosted-agent)
11. [Security and Privacy](#11-security-and-privacy)
12. [Configuration Model](#12-configuration-model)
13. [Non-Goals and Out of Scope](#13-non-goals-and-out-of-scope)
14. [Success Metrics](#14-success-metrics)
15. [Implementation Phases](#15-implementation-phases)
16. [Risks and Mitigations](#16-risks-and-mitigations)

---

## 1. Product Overview

ADE (Agentic Development Environment) is a desktop application that serves as a development operations cockpit for agentic coding workflows. It provides developers with a unified control plane to manage multiple parallel development lanes (git worktrees), terminal sessions, managed processes, test suites, and project configuration. ADE automates context tracking through its Packs system, predicts conflicts between parallel work streams, and integrates with a hosted cloud agent for narrative generation and conflict resolution proposals.

ADE is built with Electron and ships as a cross-platform desktop application for macOS, Windows, and Linux.

---

## 2. Vision and Problem Statement

### The Problem

Software teams increasingly use AI coding agents (Claude Code, Codex, Cursor, and others) that work in parallel across branches. This parallel agentic workflow creates compounding challenges:

- **Context fragmentation**: Developers lose track of what each agent session accomplished across multiple branches.
- **Integration risk**: Parallel work on overlapping files leads to merge conflicts discovered too late, at merge time.
- **Context-switching overhead**: Moving between branches, terminals, and tools requires mental reconstruction of each work stream's state and intent.
- **Lack of observability**: There is no single view showing what is happening across all active development surfaces simultaneously.

### The Vision

ADE is the orchestration layer for agentic development. It watches what each agent does, tracks context through immutable checkpoints and durable packs, predicts conflicts between parallel work, and surfaces integration risks before they become merge nightmares. Think of it as "mission control for agentic development."

ADE does not replace the IDE or the git CLI. ADE already integrates deeply with external agent CLIs via tracked sessions and automation flows, and is evolving toward first-class mission/orchestrator execution as defined in `docs/final-plan.md`.

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

### Checkpoint

An immutable execution snapshot created at session boundaries and commit boundaries. Each checkpoint captures SHA anchors, deterministic deltas (files changed, insertions, deletions), tool/agent metadata, validation context (test outcomes), and transcript references. Checkpoints are the atomic unit of ADE's history system.

### Session

A terminal session within a lane, tracked with rich metadata including title, goal, tool/agent type, start/end timestamps, head SHAs at start and end, exit code, and a linked checkpoint. Sessions produce transcripts stored locally by default.

### Hosted Agent

A read-only cloud mirror that uses LLMs to generate pack narratives (reasoning and summaries), propose conflict resolutions (unified diff patches), and draft PR descriptions. The hosted agent never mutates the repository. All patches are shown as diffs for user review before local application.

### Job Engine

An asynchronous task scheduler that triggers on events (session end, head change, staged set change) and runs idempotent, coalesced jobs. The job engine coordinates the refresh pipeline: status update, checkpoint creation, pack materialization, conflict prediction, and hosted sync.

### Guest Mode

ADE can be used without an account or LLM provider. In Guest Mode, all local features work (lanes, terminals, git operations, processes, tests) but context tracking (packs, narratives, LLM-powered conflict resolution) is disabled. Guest Mode is the default state before onboarding completes and users can remain in it indefinitely.

---

## 5. System Architecture

ADE follows a strict trust boundary model with three layers:

### Main Process (Trusted)

The Electron main process is the only component with filesystem and process access. It is responsible for:

- File I/O and atomic writes
- Git CLI operations (worktree management, diff, merge, rebase, status)
- PTY sessions via node-pty
- Managed process lifecycle (spawn, stop, restart, kill)
- Job engine and pipeline execution
- Local database (SQLite via sql.js)
- Pack materialization and checkpoint capture
- Hosted mirror sync

### Renderer Process (Untrusted UI)

The React-based renderer handles all user interface rendering. It never directly accesses the filesystem, spawns processes, or runs git commands. All operations are performed through typed IPC calls to the main process via the preload bridge.

### Preload Bridge

The preload script exposes a narrow, typed API surface to the renderer via Electron's `contextBridge`. It enforces a strict IPC channel allowlist. Context isolation is enabled and Node integration is disabled in the renderer.

### Hosted Agent (Read-Only Cloud)

The cloud backend maintains a content-addressed mirror of the repository (minus configurable excludes) and runs LLM-powered jobs to produce narrative augmentations and patch proposals. It never mutates the repo. The local core is the only component that applies patches, runs tests, or performs git operations.

### Provider Model

All LLM reasoning is abstracted behind a single internal provider interface (`ManagerProvider`) with three implementations:

- **Hosted** (default): Calls ADE Cloud backend.
- **BYOK** (Bring Your Own Key): Calls model APIs directly from the desktop, no mirror required.
- **CLI**: Runs local tools (Codex, Claude Code) interactively.

The deterministic pack pipeline functions even if the LLM provider is disabled.

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
| Terminal | xterm.js (renderer), node-pty (main process) |
| Editor/Diff | Monaco Editor (lazy-loaded) |
| Graph/Canvas | React Flow |
| Routing | React Router |
| Layout | react-resizable-panels |

### Cloud Backend (Hosted Agent)

| Layer | Technology |
|-------|-----------|
| Infrastructure as Code | SST (deploys to AWS) |
| Authentication | Clerk OAuth (GitHub), desktop PKCE loopback, API Gateway JWT authorizer |
| API | API Gateway (HTTP API) + AWS Lambda |
| Queue | Amazon SQS (job ingestion, retries, DLQ) |
| Workers | AWS Lambda (SQS-triggered) |
| Storage | Amazon S3 (mirror blobs, manifests, artifacts) |
| Metadata | Amazon DynamoDB |
| Secrets | AWS Secrets Manager |
| Observability | CloudWatch Logs/Metrics |

---

## 7. Application Structure (Tabs)

ADE currently uses an 11-tab application shell with a slim icon rail (50px) on the left side. The selected lane persists across tabs, allowing Run, Terminals, Conflicts, PRs, and Files tabs to default-filter to the active lane context. The app can be used in Guest Mode (no account required) with context tracking disabled.

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
- `/settings`

The detailed ownership model for future additions (including Missions and Machines) is maintained in `docs/final-plan.md`.

### 7.1 Run (▶)

The Run tab (denoted by a ▶ play/pause icon) is the project-level command center for running everything in your development stack. It includes a lane selector (determining which worktree commands execute in), a stack button row for one-click startup of configured process subsets, individual managed process controls with live log streaming, test suite buttons with run history, and a configuration editor. New in the Run tab: AI-suggested run prompts that detect new test suites or services after merges and propose new buttons; CI/CD workflow sync that imports jobs from GitHub Actions / GitLab CI / etc. as local run buttons; and an Agent CLI Tools section that detects installed AI coding tools (Claude Code, Codex, Cursor, Aider, Continue), displays their commands and skills, and provides quick-launch into tracked terminals.

See: [features/PROJECT_HOME.md](features/PROJECT_HOME.md)

### 7.2 Lanes

The Lanes tab is the primary cockpit and the core surface of ADE. It uses a 3-pane resizable layout: a left pane with the lane list (filterable by active/ready/archived) and topology mode toggle (list, stack graph, workspace canvas); a center pane showing lane detail with diff views (working tree, staged, recent commits), file tree toggle, quick edit capability, and in-app git operations (stage/unstage, commit/amend, stash, push, branch management); and a right inspector pane with sub-tabs for Terminals, Packs, Conflicts, and PR. Each lane row displays high-density status including lane type, dirty/clean state, ahead/behind counts, conflict risk score, and last activity timestamp.

See: [features/LANES.md](features/LANES.md)

### 7.3 Files

The Files tab provides an IDE-style file explorer and editor workbench inspired by Zed's clean, minimal interface. It features a workspace scope selector (primary workspace, lane worktrees, attached worktrees), a compact Zed-style file tree with minimal chrome and keyboard-driven navigation, Monaco editor tabs with diff modes (working tree, staged, commit), and a context panel with git status, quick stage/unstage controls, and jump links to lane details and conflict panels. All save operations are atomic, workspace-scoped, and propagate status updates to lane and conflict views in near real time.

See: [features/FILES_AND_EDITOR.md](features/FILES_AND_EDITOR.md)

### 7.4 Terminals

The Terminals tab is a global session list optimized for high session volume. It displays all terminal sessions across lanes with filters (lane, status, tool type, has errors), pin support, and jump-to-lane navigation. Each row shows the lane name, session title/goal, status (running/exited/failure), last output preview, start time, and duration. A secondary grid view (V1) renders multiple sessions simultaneously with lightweight preview frames for unfocused sessions to avoid rendering too many live xterm instances.

See: [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md)

### 7.5 Conflicts

The Conflicts tab is the project-wide conflict radar. It aggregates predicted and active conflicts across all lanes, displaying a left-side list of affected lanes with stack blocker highlights, and a right-side content area with the pairwise lane risk matrix, merge simulation panel (source lane to target lane/branch dry-run), conflict pack viewer, and hosted proposal workflow (generate, review diff, apply, run tests). Conflict badges in the Lanes tab provide at-a-glance risk visibility, and real-time overlap indicators update within seconds of staged or dirty changes.

See: [features/CONFLICTS.md](features/CONFLICTS.md)

### 7.6 Context

The Context tab is the documentation and pack context surface. It shows project/lane context health, supports context docs generation workflows, and provides access to pack-derived narrative and export artifacts that are used in handoffs and orchestration flows.

See: [features/PACKS.md](features/PACKS.md)

### 7.7 Graph

The Graph tab visualizes lane topology, stack relationships, activity/risk overlays, and PR linkage on a canvas. It is optimized for quickly understanding cross-lane dependencies and integration risk across a large workspace.

See: [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md)

### 7.8 PRs

The PRs tab manages GitHub pull request workflows. It displays stacked PR chains aligned to the lane stack graph on the left, and parallel (non-stacked) PRs in a separate list. The right side shows selected PR detail including checks, review status, and description. Per-lane PR operations (create, link, push, update description from packs) are available in the lane inspector PR sub-tab. The tab supports the "land stack" guided flow for merging stacked PRs in dependency order with checks gating.

See: [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md)

### 7.9 History

The History tab provides an ADE-native operations timeline (distinct from `git log`). It shows a chronological event stream covering terminal sessions ended, checkpoints created, lane sync operations, conflict predictions, plan version changes, proposal applications, and PR events. Events are filterable by lane, feature key, and event type. Each event detail panel shows links to affected lanes, packs, checkpoints, plan versions, and proposals, with "replay context" and "undo" actions where applicable. A feature history view aggregates all sessions, checkpoints, and plan revisions for a given issue or feature key.

See: [features/HISTORY.md](features/HISTORY.md)

### 7.10 Automations

The Automations tab manages trigger-action workflows, manual runs, execution history, and natural-language drafting of automation rules. It is the foundation for recurring/background workflows (including planned Night Shift behavior in `docs/final-plan.md`).

See: [features/AUTOMATIONS.md](features/AUTOMATIONS.md)

### 7.11 Settings

The Settings tab provides application preferences including hosted agent enable/disable, mirror exclude pattern editing, process/test configuration export/import, keyboard shortcuts reference, provider configuration (hosted/BYOK/CLI), theme selection (Clean Paper light or Bloomberg Terminal dark), and automation enable/disable with last-run status.

See: [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md)

---

## 8. Feature Documentation

Each feature area is specified in detail in the following documents. These are the authoritative references for functional requirements, UX surface, edge cases, and development checklists.

| # | Feature | Document | Summary |
|---|---------|----------|---------|
| 1 | Lanes | [features/LANES.md](features/LANES.md) | The primary cockpit for parallel work. Covers lane types (primary, worktree, attached), 3-pane layout, diff views, in-app git operations, stacked lane workflows, lane profiles, and overlay policies. |
| 2 | Run (Command Center) | [features/PROJECT_HOME.md](features/PROJECT_HOME.md) | Project command center with play/pause icon. Covers managed process lifecycle, stack buttons, test suites, lane-scoped command execution, AI-suggested run prompts, CI/CD workflow sync, agent CLI tools registry (Claude Code, Codex, Cursor, Aider, Continue), and project configuration editing. |
| 3 | Files and Editor | [features/FILES_AND_EDITOR.md](features/FILES_AND_EDITOR.md) | IDE-style file workbench. Covers workspace scope selection, file explorer tree, Monaco editor with diff modes, quick edit, conflict marker editing, and atomic save operations. |
| 4 | Terminals and Sessions | [features/TERMINALS_AND_SESSIONS.md](features/TERMINALS_AND_SESSIONS.md) | PTY-based embedded terminals. Covers lane-scoped sessions, transcript capture, session metadata tracking, checkpoint creation on session end, agent command shortcuts, and the session end contract. |
| 5 | Conflicts | [features/CONFLICTS.md](features/CONFLICTS.md) | Conflict prediction and resolution radar. Covers per-lane conflict prediction, pairwise lane-lane risk matrix, merge simulation, near-real-time updates from staged/dirty changes, and hosted proposal workflows. |
| 6 | Pull Requests | [features/PULL_REQUESTS.md](features/PULL_REQUESTS.md) | GitHub PR integration. Covers PR creation and linking per lane, checks/review status display, description drafting from packs, stacked PR chain visualization, and the land stack guided merge flow. |
| 7 | History | [features/HISTORY.md](features/HISTORY.md) | ADE operations timeline. Covers chronological event stream, feature history aggregation, event detail with jump links, context replay from checkpoints, undo capabilities, and graph visualization (V1). |
| 8 | Packs | [features/PACKS.md](features/PACKS.md) | Durable context and history system. Covers immutable checkpoints, append-only pack events, pack versioning with head pointers, materialized current views, all five pack types, the update pipeline, and privacy/retention controls. |
| 9 | Workspace Graph | [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md) | Infinite-canvas topology overview. Covers primary/worktree/attached node rendering, stack and risk edge overlays, merge simulation interactions, and snapshot-based status overlays. |
| 10 | Onboarding and Settings | [features/ONBOARDING_AND_SETTINGS.md](features/ONBOARDING_AND_SETTINGS.md) | Repository initialization and user preferences. Covers onboarding flow (repo selection, `.ade/` setup, hosted agent consent), trust surfaces, operation previews, escape hatches, and theme/keybinding configuration. |
| 11 | Automations | [features/AUTOMATIONS.md](features/AUTOMATIONS.md) | Trigger-action workflows. Covers session-end and commit triggers, scheduled actions, pack updates, conflict prediction, test execution, and configuration via `.ade/actions.yaml`. |

---

## 9. Architecture Documentation

Each architecture area is specified in detail in the following documents. These define the system contracts, data models, and implementation patterns.

| # | Architecture Area | Document | Summary |
|---|-------------------|----------|---------|
| 1 | System Overview | [architecture/SYSTEM_OVERVIEW.md](architecture/SYSTEM_OVERVIEW.md) | Top-level component breakdown (desktop UI, local core engine, hosted agent), the happy-path data flow from lane creation through PR landing, key contracts, and the swappable provider model. |
| 2 | Desktop App | [architecture/DESKTOP_APP.md](architecture/DESKTOP_APP.md) | Electron process model (main, renderer, preload), IPC contracts and typed channel allowlist, PTY hosting in the main process, and the recommended folder/repo layout. |
| 3 | Data Model | [architecture/DATA_MODEL.md](architecture/DATA_MODEL.md) | Local SQLite schema covering projects, workspaces, lanes, stacks, sessions, processes, tests, operations, checkpoints, pack events, pack versions, pack heads, planning threads, plan versions, and conflict predictions. |
| 4 | Git Engine | [architecture/GIT_ENGINE.md](architecture/GIT_ENGINE.md) | Git worktree management, drift status computation (ahead/behind/dirty), sync operations (merge and rebase with undo), dry-run conflict prediction, and stack-aware restack operations. |
| 5 | Job Engine | [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md) | Event-driven pipeline with coalescing rules. Covers all event types, idempotent job definitions, the lane refresh pipeline (checkpoint through hosted sync), real-time conflict pass, re-plan pipeline, and failure handling. |
| 6 | Hosted Agent | [architecture/HOSTED_AGENT.md](architecture/HOSTED_AGENT.md) | Read-only cloud mirror architecture. Covers the repo mirror model with sync policies, cloud job types (narrative augmentation, conflict proposals, PR descriptions), security/trust requirements, cost controls, and provider swappability. |
| 7 | Cloud Backend | [architecture/CLOUD_BACKEND.md](architecture/CLOUD_BACKEND.md) | Concrete AWS stack specification. Covers Clerk authentication (GitHub/Google social sign-in), API Gateway/Lambda endpoints, SQS job queuing, S3 mirror storage with content-addressed blobs, DynamoDB metadata, LLM gateway design, and SST deployment. |
| 8 | Configuration | [architecture/CONFIGURATION.md](architecture/CONFIGURATION.md) | `.ade/` folder structure, config layering (app defaults, `ade.yaml` shared baseline, `local.yaml` machine overrides), schemas for processes, stack buttons, test suites, lane profiles, overlay policies, validation rules, and trust/change confirmation. |
| 9 | Security and Privacy | [architecture/SECURITY_AND_PRIVACY.md](architecture/SECURITY_AND_PRIVACY.md) | Default security posture. Covers the trust boundary model, secret/exclude defaults for hosted mirrors, terminal transcript privacy, process/test command trust confirmation, and the safety contract for proposals (diff review before apply, undo points). |
| 10 | UI Framework | [architecture/UI_FRAMEWORK.md](architecture/UI_FRAMEWORK.md) | Locked UI technology decisions, visual direction (Clean Paper light and Bloomberg Terminal dark themes), app shell layout, typography system (serif headers, monospace data), and high-density console design principles. |

---

## 10. Cross-Cutting Concerns

### 10.1 Packs (Context and History System)

Packs are ADE's core differentiator for agentic workflows. They provide a durable, append-only context system that captures everything needed for lane handoffs, agent prompts, explainable planning, and feature history.

**Core primitives**:

- **Checkpoint**: Immutable execution snapshot with SHA anchors, deterministic deltas, tool metadata, and transcript references. Created on session end and commit boundaries.
- **Pack Event**: Append-only event for any change to pack state (checkpoint created, pack materialized, plan version created, narrative augmented).
- **Pack Version**: Immutable rendered version of a pack (markdown + metadata + source inputs). Never edited in place.
- **Pack Head**: Mutable pointer per pack key referencing the latest deterministic version, latest narrative version, and active version.

**Update pipeline**: On session end, the pipeline creates a checkpoint, appends events, materializes lane/project/feature packs, predicts conflicts, updates conflict packs if needed, syncs to the hosted mirror, and optionally requests narrative augmentation. This pipeline runs through the job engine with coalescing to avoid redundant work.

**Storage**: Packs are stored under `.ade/packs/` with immutable versions, head pointers, and materialized current views. History artifacts (checkpoints, events) are stored under `.ade/history/`. All storage is local-only by default.

See: [features/PACKS.md](features/PACKS.md)

### 10.2 Automations

Automations allow users to wire triggers to actions so that ADE stays synchronized without manual intervention. MVP triggers include terminal session end, commit created, and scheduled intervals. MVP actions include pack updates, hosted mirror sync, conflict prediction, test runs, and custom commands. Automations are configured in `.ade/actions.yaml` and can be enabled/disabled from the Settings tab.

See: [features/AUTOMATIONS.md](features/AUTOMATIONS.md)

### 10.3 Workspace Graph

The workspace graph is an infinite-canvas mindmap showing the entire development topology of a repository. The main branch sits at the center representing production; branches like `develop` or `staging` are positioned as intermediate environment nodes. Feature lanes, worktrees, and attached lanes radiate outward, connected by topology, stack, and risk edges. Environment badges (PROD, STAGING, DEV) are rendered on branches with configured environment mappings. PR status overlays show open PRs on edges alongside conflict risk indicators. Stack edges show parent-child relationships. Users can pan, zoom, click nodes to focus lane details, and click edges to open merge simulation panels. The result is a deployment-aware topology map that answers "what connects to what, where are the conflicts, and which PRs are open" at a glance.

See: [features/WORKSPACE_GRAPH.md](features/WORKSPACE_GRAPH.md)

### 10.4 Job Engine

The job engine is the coordination backbone that keeps all ADE state synchronized. It processes events (session end, HEAD change, staged set change, branch switch, base update) and dispatches idempotent, coalesced jobs. Per-lane coalescing ensures only one refresh pipeline runs at a time with at most one pending follow-up. Pairwise conflict passes use short debounce for staged/dirty events. Hosted mirror sync is forced on session end and coalesced during active work. Failure handling is explicit: failed checkpoints mark lanes as stale, failed materializations preserve prior pack versions, and failed predictions mark risk as "unknown" rather than "clean."

See: [architecture/JOB_ENGINE.md](architecture/JOB_ENGINE.md)

### 10.5 Hosted Agent

The hosted agent provides narrative augmentation and conflict resolution proposals without ever mutating the repository. It maintains a content-addressed mirror in S3 (file blobs keyed by SHA-256, per-lane manifests mapping paths to blob hashes). Sync is forced on session end and coalesced during active work. Cloud jobs include narrative pack augmentation, conflict proposal generation, and PR description drafting. All outputs are returned as markdown narratives or unified diff patches with confidence metadata. Cost controls include per-job token and file-read budgets, content-hash-keyed caching, and session-end-triggered execution (not keystroke-triggered).

See: [architecture/HOSTED_AGENT.md](architecture/HOSTED_AGENT.md) and [architecture/CLOUD_BACKEND.md](architecture/CLOUD_BACKEND.md)

---

## 11. Security and Privacy

ADE's security model is built on explicit trust boundaries and conservative defaults.

**Trust boundaries**:

- The local core (main process) is the only component that edits files, runs git operations, runs tests, and performs undo/rollback.
- The hosted agent is read-only and returns artifacts (narratives, patch proposals) only.
- The renderer is untrusted and communicates exclusively through a typed IPC allowlist.
- Process and test commands execute only in the main process, never in the renderer.

**Secrets and excludes**:

- Hosted mirror excludes obvious secret files by default (`.env*`, `*.pem`, `*.key`, `*id_rsa*`), build outputs (`dist/`, `build/`, `.next/`, `coverage/`), and dependencies (`node_modules/`).
- Per-project exclude overrides are supported.
- Terminal transcripts are stored locally by default and are never uploaded unless explicitly enabled with redaction.

**Process/test command trust**:

- Shared config changes (`.ade/ade.yaml`) require explicit trust confirmation before command execution.
- Local overrides (`.ade/local.yaml`) are trusted for the local machine.
- Commands are represented as argv arrays to avoid shell injection.

**Proposal safety**:

- Patches from the hosted agent are always shown as diffs before application.
- Applying a patch creates an operation record and undo point.
- Auto-apply, if ever enabled, must be per-action opt-in and test-gated.

**Authentication**:

- Clerk OAuth with GitHub/Google social sign-in for hosted agent access.
- Tokens stored in the OS keychain, never in plaintext.
- All mirror and job operations scoped to `(user, project)`.

---

## 12. Configuration Model

ADE configuration lives in the `.ade/` folder at the project root, which is git-ignored via `.git/info/exclude` by default.

**File layout**:

| File | Purpose | Shareable |
|------|---------|-----------|
| `.ade/ade.yaml` | Shared baseline config (processes, stack buttons, test suites, lane profiles, overlay policies, providers) | Yes (opt-in) |
| `.ade/local.yaml` | Machine-specific overrides | No |
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

---

## 13. Non-Goals and Out of Scope

- **ADE is not an IDE replacement.** It does not provide code intelligence, language servers, autocompletion, or debugging. The Monaco editor is intentionally scoped to focused edits and diff review, not full development.
- **ADE does not replace the git CLI.** It provides a UI for common git workflows (stage, commit, push, branch, stash, sync) but does not aim to cover every git operation. Power users can always drop to an external terminal.
- **ADE is not a closed agent runtime.** ADE supports external agent CLIs and orchestration workflows but does not lock execution to a proprietary agent implementation.
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

---

## 15. Implementation Phases

Implementation sequencing, future phases, and dependency ordering are now maintained in:

- `docs/final-plan.md`

This PRD intentionally focuses on product scope and behavior, while roadmap execution detail is centralized in the Final Plan to avoid drift.

---

## 16. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **PTY stability across platforms** | Terminal sessions are the primary user interaction; instability blocks all workflows | Phase 0 gates all subsequent work on stable PTY. Cross-platform testing required before advancing. |
| **Conflict prediction accuracy** | False positives erode trust; false negatives defeat the purpose | Start with conservative git merge-tree analysis. Mark uncertain predictions as "unknown" rather than "clean." Iterate with user feedback. |
| **Pack system complexity** | Five pack types with immutable versioning and materialization could be over-engineered for MVP | Implement all pack types in a single phase (Phase 3) to avoid partial systems. Keep materializers incremental and fast. Provide rebuild/recovery commands. |
| **Hosted mirror security** | Uploading repository content to the cloud carries inherent risk | Hosted sync is opt-in. Default exclude list covers secrets and build artifacts. Encryption at rest and in transit. Strict tenant isolation. Bounded retention with user controls. |
| **LLM cost control** | Narrative and proposal jobs could incur unexpected costs | Per-job token and file-read budgets. Content-hash caching. Execution tied to session boundaries, not keystrokes. Coalesced sync with configurable thresholds. |
| **Electron performance at scale** | Many concurrent terminals, file watchers, and git operations could degrade performance | Lazy xterm rendering (only focused sessions get full rendering). Coalesced event processing. Incremental materializers keyed by checkpoint IDs. Git-native operations preferred over filesystem walks. |
| **Scope creep toward IDE** | Pressure to add code intelligence, debugging, or full editing could dilute the product | Non-goals are explicitly documented. Monaco is scoped to focused edits and diff review. Users are expected to use their preferred IDE alongside ADE. |

---

*This document is the authoritative product requirements reference for ADE. For implementation details, consult the linked feature and architecture documents. For UI-specific decisions, the [UI Spec (Locked)](features/UI_SPEC_LOCKED.md) takes precedence in case of conflict.*

# ADE Implementation Plan

> Last updated: 2026-02-17

---

## Overview

This document is the master implementation plan for ADE (Agentic Development Environment). It ties together every feature specification and architecture document into a single phased development roadmap, providing traceability from high-level phases down to individual task IDs defined in the feature docs.

**There is no MVP.** ADE is a single, complete product. Every phase in this plan contributes to the finished application. All phases must be completed. Phases are ordered by dependency and priority -- earlier phases establish foundations that later phases build on -- but the goal is the full product, not a subset.

### Document References

**Feature Documentation** (in `docs/features/`):

| Document | Covers |
|----------|--------|
| `TERMINALS_AND_SESSIONS.md` | PTY service, session tracking, transcripts, deltas, tiling |
| `LANES.md` | Lane CRUD, 3-pane layout, diff viewer, git operations, stacks |
| `PROJECT_HOME.md` | Process management, test suites, config editor |
| `FILES_AND_EDITOR.md` | File explorer, Monaco editor, diff/conflict modes |
| `CONFLICTS.md` | Conflict prediction, risk matrix, merge simulation, resolution proposals |
| `PULL_REQUESTS.md` | GitHub integration, PR CRUD, stacked PRs, land flow |
| `PACKS.md` | Context packs, checkpoints, versioning, event logging, narratives |
| `WORKSPACE_GRAPH.md` | React Flow canvas, node/edge components, risk visualization |
| `AUTOMATIONS.md` | Trigger-action rules, action chaining, execution history |
| `ONBOARDING_AND_SETTINGS.md` | Setup wizard, trust model, provider config, settings |
| `HISTORY.md` | Operations timeline, checkpoints, replay, undo |

**Architecture Documentation** (in `docs/architecture/`):

| Document | Covers |
|----------|--------|
| `SYSTEM_OVERVIEW.md` | Three-layer architecture, design decisions, integration points |
| `DESKTOP_APP.md` | Electron process model, service factory pattern, AppContext |
| `DATA_MODEL.md` | SQLite (sql.js), dual persistence, migration system |
| `GIT_ENGINE.md` | Worktree model, git operations service, operation tracking |
| `JOB_ENGINE.md` | Event-driven queue, per-lane coalescing, lane refresh pipeline |
| `UI_FRAMEWORK.md` | React 18, Zustand, Tailwind CSS, theming, component inventory |
| `CONFIGURATION.md` | YAML config layering, trust model, lane profiles |
| `SECURITY_AND_PRIVACY.md` | Process isolation, IPC security, secret protection, audit trail |
| `CLOUD_BACKEND.md` | AWS serverless stack (SST, Clerk auth, S3, SQS, DynamoDB, Lambda) |
| `HOSTED_AGENT.md` | Mirror sync protocol, LLM gateway, job types, provider swapping |
| `CONTEXT_CONTRACT.md` | Pack contract schema, section markers, export tiers, machine-readable headers (`ade.context.v1`) |

---

## Phase Summary

| Phase | Name | Status | Key Deliverables |
|-------|------|--------|-----------------|
| -1 | Repo + Desktop Scaffold | DONE | Electron + React + Vite + SQLite + Tailwind + Zustand |
| 0 | Terminals + Session Tracking | DONE | PTY service, xterm.js, transcripts, session deltas |
| 1 | Lanes Cockpit + Diffs + Git Operations | DONE | Lane CRUD, 3-pane layout, diff viewer, git ops, stash, push |
| 2 | Project Home (Processes + Tests + Config) | DONE | Process manager, test runner, config editor, packs, job engine |
| 3 | Files Tab + UI Polish | DONE | File explorer (Zed-inspired), Monaco editor, diff modes, Run tab rename, lane selector, guest mode, untracked sessions |
| 4 | Stacks + Restack | DONE | Parent-child lanes, stack graph, restack operations, overlay policies, vertical connectors |
| 5 | Conflict Radar + Resolution | DONE | Conflict prediction, risk matrix, merge simulation, Monaco conflict diff, risk tooltips, status badges |
| 6 | Cloud Infrastructure + Auth + LLM Gateway | DONE | AWS SST stack, Clerk auth, LLM gateway, mirror sync, pack narratives, conflict proposals |
| 7 | GitHub Integration + Workspace Graph | DONE | GitHub PR CRUD + polling, React Flow canvas (stack/risk/activity/all), PR workflows from lanes + graph, BYOK provider, lane commit graph |
| 8 | Automations + Onboarding + Packs V2 | DONE | Automations engine + NL planner, onboarding wizard + CI import, pack versions/events/checkpoints, bounded exports, context contract, external resolver, tiling layout, web marketing site |
| 9 | Advanced Features + Polish + Runtime Isolation | NOT STARTED | History graph, terminal polish, advanced git, agent CLI tools, runtime isolation, auto-rebase |
| 10 | ADE Core Extraction + Relay Server | NOT STARTED | Standalone `@ade/core` package, WebSocket relay, auth, push notifications, machine heartbeat |
| 11 | iOS App MVP | NOT STARTED | SwiftUI app, terminal-first UX (chat-style + raw mode), lane management, pack viewer, push notifications |
| 12 | Machine Hub + Multi-Device | NOT STARTED | Machine registry, status dashboard, cross-machine sync, work routing, desktop thin-client mode |

---

## Completed Phases

### Phase -1: Repo + Desktop Scaffold

**Status**: DONE (2026-02-10)

**Goal**: Establish the foundational project structure, build toolchain, and application shell that all subsequent phases build upon.

**Delivered**:
- Electron 40 + React 18 + TypeScript + Vite (renderer) + tsup (main)
- Preload bridge with typed IPC allowlist (security boundary)
- App shell with TopBar, 50px left icon rail, 8-tab navigation
- React Router routing for all pages
- Resizable pane layouts via react-resizable-panels
- SQLite persistence via sql.js (WASM) with kv table for layout state
- Tailwind CSS 4.x with two themes: Clean Paper (light) and Bloomberg Terminal (dark)
- Zustand app store for renderer state management

**References**: `DESKTOP_APP.md`, `DATA_MODEL.md`, `UI_FRAMEWORK.md`, `SECURITY_AND_PRIVACY.md`

---

### Phase 0: Terminals + Session Tracking

**Status**: DONE (2026-02-11)

**Goal**: Deliver a fully functional terminal system with session lifecycle tracking, transcript capture, and delta computation that feeds into the pack system.

**Delivered**:
- PTY service via node-pty with xterm.js rendering
- Session lifecycle tracking (create, stream, exit)
- Transcript capture to .ade/transcripts/
- HEAD SHA tracking at session start and end
- Session delta computation (files changed, insertions, deletions, failure lines)
- Global Terminals page with filters (lane, status, search)
- Lane terminal panel (Terminals sub-tab in Lanes)
- Session end triggers pack refresh job via job engine

**Services**: `ptyService`, `sessionService`

**References**: `TERMINALS_AND_SESSIONS.md`, `DESKTOP_APP.md`, `JOB_ENGINE.md`, `DATA_MODEL.md`

**Task IDs**: TERM-001 through TERM-020: ALL DONE

---

### Phase 1: Lanes Cockpit + Diffs + Git Operations

**Status**: DONE (2026-02-11)

**Goal**: Build the primary development workspace with full git operations support, enabling developers to manage parallel worktrees, view diffs, and perform all common git actions from a single cockpit.

**Delivered**:
- Lane (worktree) CRUD: create, rename, archive, delete
- 3-pane resizable layout (lane list, detail area, inspector sidebar)
- Diff viewer with unstaged and staged sections and file change indicators
- Monaco side-by-side diff view with quick edit capability
- Full git operations: stage, unstage, discard, commit, stash (push/pop/apply/drop/list), fetch, sync (merge/rebase), push (with force-with-lease)
- Recent commits list, revert commit, cherry-pick commit
- Multi-lane tabs with simultaneous lane viewing
- Lane sub-tabs (Diff, Terminals, Packs, Conflicts, PR)
- Operation history tracking with SHA transitions

**Services**: `laneService`, `gitOperationsService`, `diffService`

**References**: `LANES.md`, `GIT_ENGINE.md`, `DATA_MODEL.md`, `UI_FRAMEWORK.md`

**Task IDs**: LANES-001 through LANES-023: ALL DONE

---

### Phase 2: Project Home (Processes + Tests + Config)

**Status**: DONE (2026-02-11)

**Goal**: Deliver the project control plane with managed processes, test suites, config editing, pack generation, and the job engine that ties them together.

**Delivered**:
- Process definitions from YAML config with spawning and lifecycle management
- Readiness checks (port probe, log regex) and stack buttons
- Test suite execution with status tracking and timeout enforcement
- Config editor with YAML syntax highlighting, inline validation, and save
- Shared/Local config split with trust confirmation dialog
- Pack service with deterministic content generation and template narrative
- Pack viewer with freshness indicator (green/yellow/red)
- Job engine with per-lane deduplication and coalescing
- History timeline with operation recording and filters

**Services**: `processService`, `testService`, `projectConfigService`, `packService`, `jobEngine`, `operationService`

**References**: `PROJECT_HOME.md`, `PACKS.md`, `HISTORY.md`, `JOB_ENGINE.md`, `CONFIGURATION.md`, `DATA_MODEL.md`

**Task IDs**: PROJ-001 through PROJ-025, PACK-001 through PACK-011, HIST-001 through HIST-010: ALL DONE

---

### Phase 3: Files Tab + UI Polish

**Status**: DONE (2026-02-11)

**Goal**: Provide an IDE-style file explorer and editor that allows developers to browse and edit code across workspaces without leaving ADE, plus refinements to terminal and lane navigation.

**Delivered**:
- File tree with .gitignore support, lazy loading, workspace scope selector, and git change indicators
- Monaco editor with syntax highlighting, multi-tab editor, edit/diff/conflict modes
- File breadcrumbs, right-click context menu (Open, Diff, Stage, Discard, Copy Path, New File, Rename, Delete)
- File watching via chokidar with debouncing and gitignore filtering
- Quick open (Ctrl+P) and cross-file search (Ctrl+Shift+F)
- Protected branch warnings, unsaved changes detection
- Zed-inspired compact styling with indentation guides and refined hover states
- Untracked terminal sessions (sessions that don't record to context/history)
- Run tab rename (Projects to Run with play/pause icon) and lane selector dropdown
- Guest mode (no-account usage with local features, template narratives, persistent banner)
- Renderer error boundary for graceful crash recovery

**Services**: `fileService` (expanded), `fileSearchIndexService`, `fileWatcherService`

**References**: `FILES_AND_EDITOR.md`, `TERMINALS_AND_SESSIONS.md`, `LANES.md`, `ONBOARDING_AND_SETTINGS.md`

**Task IDs**: FILES-001 through FILES-021, TERM-024/032, LANES-034/035, PROJ-033/034, ONBOARD-025/026, PACK-030: ALL DONE

---

### Phase 4: Stacks + Restack

**Status**: DONE (2026-02-11)

**Goal**: Enable stacked development workflows where child lanes build on parent lanes, with visualization and restack operations to propagate parent changes downstream.

**Delivered**:
- Stack model with parent-child lane relationships (parent_lane_id)
- Stack creation via "Create Child Lane" action based on parent HEAD
- Stack graph visualization in lane list sidebar with tree rendering and connector lines
- Restack operation: recursive rebase of children onto updated parent, stops on conflict
- Stack-aware status indicators showing ahead/behind relative to parent
- Stack DB queries with recursive CTE for chain traversal
- Lane overlay policies for per-lane behavior overrides

**References**: `LANES.md`, `GIT_ENGINE.md`, `CONFIGURATION.md`, `DATA_MODEL.md`

**Task IDs**: LANES-026 through LANES-029, LANES-033: ALL DONE

---

### Phase 5: Conflict Radar + Resolution

**Status**: DONE (2026-02-11)

**Goal**: Surface integration risk proactively by predicting merge conflicts before they happen, displaying risk across all lanes, and enabling merge simulation between any pair of lanes.

**Delivered**:
- Conflict prediction engine using git merge-tree for dry-merge simulation
- Lane conflict status computation and caching (merge-ready, behind-base, conflict-predicted, conflict-active)
- Periodic conflict prediction job via job engine with session-end and timer triggers
- Realtime conflict pass using file-list intersection fast path
- Conflict status badges in lane rows with color-coded indicators
- Conflicts tab with 3-panel layout (lane list, summary/risk matrix, merge simulation)
- Pairwise risk matrix with color-coded cells and interactive cell clicks
- Merge simulation service and UI with lane pair selection and result preview
- Conflict file diff viewer with Monaco
- Conflict pack generation for hosted agent context
- Batch conflict assessment across all lanes

**Services**: `conflictService`

**References**: `CONFLICTS.md`, `GIT_ENGINE.md`, `JOB_ENGINE.md`, `DATA_MODEL.md`

**Task IDs**: CONF-001 through CONF-016, CONF-023: ALL DONE

---

### Phase 6: Cloud Infrastructure + Auth + LLM Gateway

**Status**: DONE (2026-02-12)

**Goal**: Stand up the AWS cloud infrastructure and desktop integration that enables authenticated access, persistent cloud storage, and LLM-powered features.

**Delivered**:
- AWS infrastructure via SST: API Gateway, S3, SQS (with DLQ), DynamoDB, Lambda
- Clerk OAuth authentication (GitHub/Google social sign-in, PKCE) with desktop loopback redirect
- Repo mirror sync with content-addressed blobs and per-lane manifests
- Cloud job processing: NarrativeGeneration, ProposeConflictResolution, DraftPrDescription
- LLM gateway with multi-provider routing (Anthropic, OpenAI, Gemini, Mock) and token budgets
- Rate limiting (per-minute, daily jobs, daily tokens) via DynamoDB
- Pack narrative augmentation and conflict resolution proposals via LLM
- Proposal review workflow (preview diff, apply with git apply --3way, undo with git apply -R)
- Secret redaction rules for API keys, tokens, PEM keys, GitHub PATs
- Provider configuration UI (Hosted / BYOK / CLI) with API key management
- Transcript upload opt-in toggle, startup auth page, OS secure storage for tokens

**Services**: `hostedAgentService`, `llmGateway` (cloud), Lambda API handlers, Lambda job worker

**References**: `CLOUD_BACKEND.md`, `HOSTED_AGENT.md`, `SECURITY_AND_PRIVACY.md`, `CONFLICTS.md`, `PACKS.md`, `ONBOARDING_AND_SETTINGS.md`

**Task IDs**: CONF-017 through CONF-021, PACK-021/023/025, ONBOARD-012/014/015, TERM-028: ALL DONE

---

### Phase 7: GitHub Integration + Workspace Graph

**Status**: DONE (2026-02-14)

**Goal**: Connect ADE to GitHub for PR lifecycle management, extend the workspace canvas into an interactive PR orchestration surface, add an inline commit timeline to lane details, and polish the conflict resolution pipeline end-to-end.

This phase was structured as four sub-phases (7A-7D), all completed:

**7A - GitHub Integration**: GitHub service layer with OS keychain token storage, PR CRUD from lanes, PR status polling, pack-generated PR descriptions via LLM, stacked PR chain visualization with base retargeting, land single PR and land stack flow, PR checks and review status integration, PR template support.

**7B - Canvas PR Workflow**: PR edge overlays with state-based coloring (open/draft/changes-requested/failing), drag-to-open-PR workflow, merge-from-graph panel with method selection, conflict resolution from edge clicks with AI proposals, integration lane creation from multi-select, real-time edge re-evaluation after merge, merge-in-progress pulse animations, enhanced edge hover tooltips.

**7C - Conflict Resolution Polish**: BYOK provider implementation (direct LLM calls for OpenAI, Anthropic, Gemini without AWS round-trip), pack retention and cleanup policy, lane-to-lane conflict resolution for arbitrary pairs, apply resolution with staging choice (unstaged/staged/commit), post-apply conflict re-prediction trigger.

**7D - Lane Commit Graph**: CommitTimeline component with vertical timeline, commit nodes with hover details, click-to-diff in Monaco, merge commit branching visuals, lazy-load older commits. Lane detail reworked to 3-column layout (unstaged/staged/commit timeline) with dual-mode diff viewer. Live Conflicts and PR inspector sub-tabs.

**Services**: `githubService`, `prService`, `byokLlmService`

**References**: `PULL_REQUESTS.md`, `WORKSPACE_GRAPH.md`, `CONFLICTS.md`, `LANES.md`

**Task IDs**: PR-001 through PR-020, GRAPH-001 through GRAPH-038, CANVAS-001 through CANVAS-011, COMMIT-001 through COMMIT-005, LANE-UI-001 through LANE-UI-004, CONF-022, PACK-024, BYOK-001, RESOLVE-001 through RESOLVE-003, LANES-024/025/031: ALL DONE

---

### Phase 8: Automations + Onboarding + Packs V2

**Status**: DONE (2026-02-16)

**Goal**: Add user-configurable automation workflows, a guided onboarding experience with intelligent project detection, and evolve the pack system to support versioning, checkpoints, bounded exports, and new pack types. This phase delivered well beyond original scope.

**Delivered (Automations)**:
- Automation rule schema definition and validation in YAML config
- Triggers: session-end, commit, schedule (cron via node-cron), manual
- Actions: update-packs, predict-conflicts, sync-to-mirror, run-tests, run-command
- Action chaining with sequential execution, conditional evaluation, and failure handling
- Automation management UI with list, toggles, detail views, and execution history
- Natural language automation creation via automationPlannerService (codex/claude providers)
- Draft validation pipeline with ambiguity resolution and simulation
- Real-time event streaming for automation execution updates

**Delivered (Onboarding)**:
- Project defaults detection (package.json, Makefile, docker-compose.yml, Cargo.toml, go.mod, pyproject.toml, .github/workflows/)
- Onboarding wizard UI with step-by-step modal and progress tracking
- CI/CD workflow scan and import (GitHub Actions, GitLab CI, CircleCI, Jenkins) with safety classification
- CI/CD sync mode with fingerprint-based diff detection and incremental re-import
- Project switching with recent projects list
- Keybindings viewer and customization with scope-based definitions and overrides
- Data management (clear local data, export config bundle, delete hosted mirror data)
- Terminal launch profiles with custom profiles for tracked/untracked sessions
- Agent CLI tools detection (Claude Code, Codex, Cursor, Aider, Continue with install paths and versions)

**Delivered (Packs V2)**:
- Checkpoint creation at session boundaries with immutable snapshots
- Pack event logging with importance scoring and category tagging
- Pack version snapshots with immutable rendered markdown and content hashes
- Feature, conflict, and plan pack types
- Narrative editing and pack diff (compare two versions)
- Bounded exports with token-budgeted tiers (Lite ~800 / Standard ~2800 / Deep ~8000 tokens)
- Pack sections with marker-based manipulation for safe updates
- Auto-narrative pipeline (AI narratives after every deterministic pack refresh)
- Pack delta digest service with section change tracking and handoff summaries

**Delivered (Additional)**:
- Context Contract (ade.context.v1 headers, stable section markers, export tiers) documented in CONTEXT_CONTRACT.md
- External conflict resolver invoking codex/claude CLI tools with context gap detection and patch output
- Restack suggestions service with automated parent-behind detection and dismiss/defer/PR-awareness
- Hosted context policy with delivery mode selection and staleness detection
- Hosted mirror cleanup with orphan blob detection and policy-bounded scanning
- Context docs generation via codex/claude CLI tools
- Git conflict state detection (active merge/rebase) with continue/abort support
- TilingLayout for terminals, floating panes, resize gutters, dock layout state, command palette
- Web marketing site with feature gallery, download page, privacy/terms pages

**Services**: `automationService`, `automationPlannerService`, `onboardingService`, `ciService`, `keybindingsService`, `terminalProfilesService`, `agentToolsService`, `restackSuggestionService`

**References**: `AUTOMATIONS.md`, `ONBOARDING_AND_SETTINGS.md`, `PACKS.md`, `CONTEXT_CONTRACT.md`, `DESKTOP_APP.md`, `HISTORY.md`, `CONFLICTS.md`, `TERMINALS_AND_SESSIONS.md`

**Task IDs**: AUTO-003 through AUTO-020, ONBOARD-007 through ONBOARD-024, PACK-012 through PACK-022, PACK-027 through PACK-029, PROJ-036/037, PROJ-028/029, HIST-011 through HIST-014, TERM-021/022/025 through TERM-027/029/030: ALL DONE

---

## Upcoming Phases

### Phase 9: Advanced Features + Polish + Runtime Isolation

**Status**: NOT STARTED

**Goal**: Complete the product with advanced history features, terminal polish, agent tooling, performance optimization, auto-rebase across lanes, and per-lane runtime isolation for parallel development.

Phase 9 is organized into five sub-phases. 9A and 9B have no mutual dependency and can be developed in parallel. 9C can begin after 9A/9B. 9D and 9E are independent.

---

#### Phase 9A: History Visualization + Terminal Polish

**Goal**: Deliver the advanced History timeline UI and finish terminal refinements.

**Remaining work**:
- HIST-015: Feature history (filtered by feature/issue tag across lanes)
- HIST-016: History graph view (visual timeline with parallel lane tracks)
- HIST-017: Checkpoint browser (navigate to past repo state, read-only file browser)
- HIST-018: Undo operation (reverse git action via history)
- HIST-019: Replay operation sequence (dry-run re-execution)
- HIST-020: Plan version history
- HIST-023: Export history as CSV/JSON
- TERM-023: Full drag-to-rearrange tiles (split panes exist, need drag reorder)
- TERM-027: Transcript search UI widget (types exist from Phase 8)
- TERM-031: Grid view (multi-terminal overview)
- TERM-033: Transcript cleanup/retention policy (automated pruning by age/size)

---

#### Phase 9B: Advanced Git + Run Tab + Settings Polish

**Goal**: Complete git power-user features, agent tooling in the Run tab, and finish onboarding/settings refinements.

**Remaining work**:
- LANES-032: Lane profiles (preset configs per lane type)
- LANES-036: Amend commit
- LANES-037: Branch create/delete/rename from lane
- LANES-038: Reset (soft/mixed/hard) with confirmation dialog
- PROJ-028: Process env var editor
- PROJ-030: Test result diff
- PROJ-035: AI-suggested run prompts (detect new suites/services)
- PROJ-039 through PROJ-042: Agent command editing, quick-launch, run prompt cards
- ONBOARD-013: Generic pre-execution dialogs (partial completion)
- ONBOARD-017: Interactive key capture (text override done, interactive capture remaining)
- CLI-001: CLI provider wiring (ollama/llama.cpp)
- SETTINGS-001: Editor state persistence

---

#### Phase 9C: Cross-Surface UX + Performance

**Goal**: Deliver cross-tab navigation, attention-driven workflows, and performance hardening.

**Remaining work**:
- CONF-024: Conflict notifications/alerts (in-app and system)
- UX-001: Global identity bar (project, lane, branch, cwd, environment)
- UX-002: PR attention queue ("needs human action")
- UX-003: Mission-control overview for project switching
- PERF-001: Virtual scrolling for large lists
- PERF-002: Error handling hardening and graceful degradation
- PERF-003: Cross-platform testing and fixes (macOS, Windows, Linux)
- Automation planner UI polish (guided follow-up for ambiguities)
- External resolver UI improvements (richer diff preview, multi-lane orchestration)
- Context docs staleness indicators (more granular freshness tracking)
- Pack export caching (content-hash invalidation)
- Web app CI/CD deployment pipeline

---

#### Phase 9D: Local Runtime Isolation

**Goal**: Enable per-lane runtime isolation so multiple lanes can run dev servers simultaneously without port conflicts.

**Scope**:
- Lane runtime identity model (stable hostname, deterministic ports)
- Deterministic port allocation service with lane/process leases
- Local host orchestration layer (reverse proxy)
- Preview launcher (correct lane URL from ADE)
- Optional per-lane browser profile integration
- Per-lane runtime diagnostics and fallback mode

**New Services Required**:
- `laneRuntimeService`: lane runtime identity, port leasing, diagnostics
- `laneProxyService`: local reverse proxy and host-to-port routing
- `browserProfileService`: per-lane browser profile lifecycle
- `previewLaunchService`: lane-aware URL and browser launch

---

#### Phase 9E: Auto-Rebase Across Lanes

**Goal**: Automatically rebase dependent lanes when a branch advances, using existing conflict prediction as a safety gate.

**Mechanism**:
- Branch advances (lane merges to main, parent gets new commits, external push)
- Job engine fires headChanged event
- For each dependent lane, run git merge-tree simulation
- Clean result: auto-rebase silently
- Conflict result: don't touch, mark lane with "rebase available, conflicts expected" badge

**Scenarios**:
1. Lane merges to main: sibling lanes auto-rebase (if clean)
2. Parent lane in stack advances: children auto-restack (if clean)
3. Main advances from external push: clean lanes auto-rebase
4. Cascade rebase in deep stacks (sequential, stop at first conflict)
5. Multiple simultaneous merges: job engine coalesces, rebase once onto final state

**UX**:
- Lane badges: "Rebased automatically" (green) or "Rebase available -- N conflicts" (yellow)
- Notification when manual intervention needed
- Project-level setting: auto-rebase on/off

**Implementation**:
- New job type: autoRebase triggered by headChanged
- Gate on existing conflictService.simulateMerge()
- Sequential cascade with stop-on-conflict
- New lane statuses: autoRebased, rebasePending, rebaseConflict

**Task References**:
- REBASE-001: autoRebase job type in job engine
- REBASE-002: Merge-tree gate (only rebase if clean)
- REBASE-003: Cascade logic with stop-on-conflict
- REBASE-004: Lane status updates (autoRebased/rebasePending/rebaseConflict)
- REBASE-005: Notification for manual intervention needed
- REBASE-006: Project setting: auto-rebase on/off
- REBASE-007: Lane badges for auto-rebase status

---

#### Phase 9 -- Cross-Cutting Notes

**Feature Doc References**: `HISTORY.md`, `TERMINALS_AND_SESSIONS.md`, `LANES.md`, `PROJECT_HOME.md`, `ONBOARDING_AND_SETTINGS.md`, `FILES_AND_EDITOR.md`

**Architecture References**: `UI_FRAMEWORK.md`, `GIT_ENGINE.md`, `DESKTOP_APP.md`

**Dependencies**: All prior phases

**Exit Criteria**: All task IDs across all feature docs are marked DONE. History graph view renders parallel tracks. Checkpoint browser works. Terminal drag-to-rearrange and grid view work. Agent CLI tools detected and launchable. Editor state persists across sessions. CLI provider wires to local LLM tools. Performance smooth with large repos. Cross-platform verified. Runtime isolation enables 3+ active lanes without port conflicts. Auto-rebase silently rebases clean lanes and flags conflicting ones.

---

### Phase 10: ADE Core Extraction + Relay Server

**Status**: NOT STARTED

**Goal**: Extract the Electron main process services into a standalone Node.js package (`@ade/core`) and build a relay server that exposes ADE's functionality over WebSocket. This is the foundational infrastructure that enables the iOS app (Phase 11) and machine hub (Phase 12).

**Why this works**: ADE's main process is already cleanly separated from the renderer via 208 typed IPC channels. The renderer never touches git, files, or terminals directly -- it always sends a message to the main process and gets a response. The relay server swaps Electron IPC for WebSocket messages. Same messages, different transport.

Phase 10 is organized into three sub-phases. 10A and 10B can be partially parallelized (10A must deliver the core package before 10B can build the relay on top of it). 10C depends on 10B.

---

#### Phase 10A: Core Package Extraction

**Goal**: Extract all main process services into `packages/core/` -- a standalone Node.js package with zero Electron dependencies.

**Scope**:
- New `packages/core/` directory in the monorepo with all services extracted
- Service factory pattern preserved via `createServiceContext()` function
- SQLite persistence layer (sql.js) works identically outside Electron
- Filesystem operations use Node.js fs directly (no Electron app.getPath() calls)
- Electron-specific code (BrowserWindow, dialog, shell, app lifecycle) stays in `apps/desktop/` as a thin adapter
- Shared types moved to `packages/core/src/shared/` -- no type duplication
- Desktop app works identically after extraction -- no user-visible changes

**Task References**:
- CORE-001: Create `packages/core/` with build config (tsup, TypeScript)
- CORE-002: Extract all services from `apps/desktop/src/main/services/` into `packages/core/src/services/`
- CORE-003: Replace Electron-specific APIs with injectable abstractions
- CORE-004: Move shared types and IPC channel definitions to `packages/core/src/shared/`
- CORE-005: Create `createServiceContext()` factory
- CORE-006: Rewrite `apps/desktop/src/main/` as thin Electron adapter importing `@ade/core`
- CORE-007: Verify desktop app works identically after extraction

---

#### Phase 10B: Relay Server

**Goal**: Build a standalone Node.js server that hosts `@ade/core` services and exposes them over authenticated WebSocket connections.

**Scope**:
- New `apps/relay/` directory with WebSocket transport layer
- Request/response pattern: client sends `{ id, channel, args }`, server responds `{ id, result }` or `{ id, error }`
- Event streaming for terminal output, pack events, automation events, conflict events, restack suggestions
- Binary WebSocket frames for PTY data
- Token-based auth: relay generates secret token, saved to `~/.ade/relay-token`
- Optional TLS and Tailscale integration for LAN use
- PTY processes run on relay; terminal sessions survive client disconnects with scrollback buffer
- Multiple clients can observe the same terminal session
- APNs push notification integration for iOS clients
- Notification triggers: agent session completes, agent needs input, conflict detected, PR status change, automation run completes/fails
- Machine heartbeat protocol (periodic status broadcast)
- Configuration via `~/.ade/relay.yaml`, CLI via `ade-relay start/stop/status/token`
- Docker deployment option

**Task References**:
- RELAY-001: Create `apps/relay/` with Node.js server scaffold
- RELAY-002: Implement WebSocket transport layer (request/response + event streaming)
- RELAY-003: Map all 208 IPC channels to WebSocket message handlers
- RELAY-004: Token-based authentication (generate, store, validate)
- RELAY-005: PTY streaming over WebSocket (binary frames, resize, scrollback on reconnect)
- RELAY-006: APNs push notification integration (register device, send notifications)
- RELAY-007: Notification triggers (session complete, input needed, conflict, PR update, automation)
- RELAY-008: Machine heartbeat protocol (periodic status broadcast)
- RELAY-009: Relay CLI (`ade-relay start/stop/status/token`)
- RELAY-010: Configuration file (`relay.yaml`) and documentation
- RELAY-011: Docker deployment option (Dockerfile + compose file)

---

#### Phase 10C: Desktop Thin-Client Mode

**Goal**: Allow the desktop app to connect to a remote relay server instead of running services locally. Same UI, but the "brain" is on another machine.

**Scope**:
- "Connect to Relay" option in the app (settings or project switcher)
- All IPC calls routed through WebSocket instead of local Electron IPC
- UI is identical -- user can't tell the difference between local and remote mode
- Connection status indicator in the top bar (local / connected to relay / disconnected)
- Seamless switching between local mode and remote mode per project
- Project list shows both local projects and projects available on connected relays

**Task References**:
- THIN-001: WebSocket client in renderer (mirrors IPC bridge interface)
- THIN-002: Connection manager UI (add relay, enter URL/token, connect/disconnect)
- THIN-003: IPC routing layer (local vs remote based on connection state)
- THIN-004: Connection status indicator in TopBar
- THIN-005: Project list shows local + remote projects

---

#### Phase 10 -- Cross-Cutting Notes

**Key architectural insight**: The extraction is a refactor, not a rewrite. ADE's existing IPC contract IS the relay API. Every `ipcMain.handle(channel, handler)` becomes `ws.on(channel, handler)`. The service layer doesn't change at all.

**Feature Doc References**: New doc `docs/architecture/RELAY_SERVER.md` to be created covering WebSocket protocol, auth, PTY streaming, and push notification architecture.

**Architecture References**: `DESKTOP_APP.md`, `DATA_MODEL.md`, `SECURITY_AND_PRIVACY.md`

**New Services Required**:
- `relayTransport`: WebSocket server managing connections, auth, and message routing
- `pushNotificationService`: APNs/FCM integration for mobile push
- `machineHeartbeatService`: Periodic status broadcasting

**Dependencies**: Phase 0 (PTY service), Phase 1-8 (all services to extract). Can begin during Phase 9 since it's a refactoring task, not new feature work.

**Exit Criteria**: Desktop app works identically after core extraction (no regressions). Relay server starts, accepts authenticated WebSocket connections, and handles all 208 IPC channels. Terminal sessions stream over WebSocket with <50ms added latency. Push notifications arrive on registered iOS devices within 5 seconds of trigger event. Desktop app can connect to a remote relay and operate in thin-client mode. Machine heartbeat reports status every 30 seconds.

---

### Phase 11: iOS App MVP

**Status**: NOT STARTED

**Goal**: Build a native iOS app that connects to an ADE relay server, providing lane management, a terminal experience designed for phones, pack viewing, and push notifications. The terminal UX is the top priority -- it must work well for interacting with AI agents from a phone.

Phase 11 is organized into three sub-phases. 11A must be completed first (app shell + connection). 11B and 11C can be developed in parallel after 11A.

---

#### Phase 11A: App Shell + Relay Connection

**Goal**: SwiftUI app that connects to a relay server and displays basic project state.

**Scope**:
- SwiftUI app targeting iOS 17+ in new `apps/ios/` directory
- WebSocket client matching relay protocol (request/response + event streaming)
- Token-based auth flow: enter relay URL + paste token to connect
- Persistent connection with automatic reconnect on network change
- Home screen: connected relay name, project info, lane list with status badges
- Lane detail screen: name, branch, parent info, status, active sessions, quick actions

**Task References**:
- IOS-001: Create `apps/ios/` Xcode project with SwiftUI
- IOS-002: WebSocket client (connect, auth, request/response, event subscription)
- IOS-003: Auto-reconnect with exponential backoff
- IOS-004: Home screen (relay status, project info, lane list)
- IOS-005: Lane detail screen (status, sessions, quick actions)
- IOS-006: Lane CRUD from mobile (create, rename, archive)

---

#### Phase 11B: Terminal View

**Goal**: A terminal experience built for phones. Not a port of xterm.js -- a purpose-built UI for interacting with AI agents and shell sessions from a touchscreen. This is the most important screen in the app.

**Scope**:

**Conversation mode (default for agent sessions)**:
- Terminal output rendered as scrollable feed of blocks (chat bubbles), not a character grid
- Agent prompts rendered with emphasis (larger text, colored border)
- Text input bar at bottom with send button, multi-line expand, keyboard avoidance
- Quick-reply chips for common responses (yes, no, skip, continue) detected from context
- Voice input (iOS speech-to-text), copy output blocks with long-press
- Native iOS scroll physics, virtualized list for large sessions

**Raw terminal mode (toggle for shell sessions)**:
- Monospace font rendering with ANSI color support
- Touch-optimized input: special key bar above keyboard (Tab, Ctrl, Esc, arrows, pipe, dash)
- Pinch-to-zoom, scrollback buffer from relay

**Session management**:
- Active sessions list (running / waiting for input / exited)
- New Session button: spawn Claude Code, Codex, or shell in lane worktree
- Status badges: running (green pulse), waiting for input (yellow), exited (gray)

**Task References**:
- TERM-IOS-001: Conversation mode view (block-based output feed, chat-style layout)
- TERM-IOS-002: Output block parsing (split terminal stream into command/output blocks)
- TERM-IOS-003: Agent prompt detection and emphasis rendering
- TERM-IOS-004: Text input bar with send button, multi-line expand, keyboard avoidance
- TERM-IOS-005: Quick-reply chips (context-detected common responses)
- TERM-IOS-006: Voice input (iOS speech-to-text)
- TERM-IOS-007: Raw terminal mode (monospace rendering, ANSI colors, special key bar)
- TERM-IOS-008: Session list (active/waiting/exited, spawn new session)
- TERM-IOS-009: Scrollback buffer loading from relay (paginated, virtualized)
- TERM-IOS-010: Output block copy (long-press)

---

#### Phase 11C: Packs, Conflicts, PRs + Notifications

**Goal**: Read-only views for packs, conflicts, and PRs, plus push notification integration.

**Scope**:
- Pack viewer: lane pack narrative (rendered markdown), pack event timeline, project pack summary, pull-to-refresh
- Conflict overview: risk summary, per-lane conflict detail with overlapping files and risk level
- PR management: list of open PRs, PR detail (status, checks, reviews, merge readiness), create PR from lane, open in GitHub
- Push notifications: APNs registration, notification categories (input needed, session complete, conflict detected, PR update) with tap-to-navigate, per-category toggles, badge count for sessions waiting for input

**Task References**:
- IOS-PACK-001: Pack narrative viewer (rendered markdown)
- IOS-PACK-002: Pack event timeline
- IOS-PACK-003: Project pack summary
- IOS-CONF-001: Conflict risk summary screen
- IOS-CONF-002: Per-lane conflict detail
- IOS-PR-001: PR list screen
- IOS-PR-002: PR detail screen (status, checks, reviews)
- IOS-PR-003: Create PR from lane
- IOS-NOTIF-001: APNs registration and device token handshake with relay
- IOS-NOTIF-002: Notification categories and tap-to-navigate actions
- IOS-NOTIF-003: Notification settings (per-category toggles)
- IOS-NOTIF-004: Badge count (sessions waiting for input)

---

#### Phase 11 -- Cross-Cutting Notes

**Tech stack**: SwiftUI, Swift Concurrency (async/await), URLSessionWebSocketTask (native WebSocket), `swift-markdown` for rendering pack narratives.

**No React Native**: SwiftUI is the right call for a personal MVP. Native scroll physics, native text input, native keyboard handling -- these are the things that make Termius feel broken.

**Feature Doc References**: New doc `docs/features/IOS_APP.md` to be created.

**Dependencies**: Phase 10 (relay server must exist for the iOS app to connect to).

**Exit Criteria**: iOS app connects to relay server via WebSocket with token auth. Lane list displays with real-time status updates. Terminal conversation mode renders agent output as scrollable blocks with chat-style input. Raw terminal mode provides basic shell access with special key bar. Sessions can be spawned from the app. Push notifications arrive for input-needed, session-complete, conflict-detected, and PR-update events. Tapping a notification navigates to the relevant screen. Pack narratives render as formatted markdown.

---

### Phase 12: Machine Hub + Multi-Device

**Status**: NOT STARTED

**Goal**: Build a machine registry that lets you connect, monitor, and sync multiple development machines from any client (desktop or iOS). Route work to whichever machine is available.

Phase 12 builds on the relay infrastructure from Phase 10. Each machine runs a relay server; the hub aggregates their status into a unified view.

---

#### Phase 12A: Machine Registry + Status Dashboard

**Goal**: A "machines" panel (available on desktop and iOS) showing all connected machines with their git status, active lanes, and sync state.

**Scope**:
- Machine registration via hosted backend or peer-to-peer discovery on local network
- Machine list tied to user identity via Clerk auth
- Add machine flow: scan QR code or manual entry
- Status dashboard (desktop Machines tab + iOS home screen section) showing: online/offline, current project, git branch + HEAD SHA, active lanes, running sessions, last heartbeat, resource indicators
- Sync indicators: in-sync, behind (with one-tap sync), or diverged

**Task References**:
- HUB-001: Machine registration protocol (relay to hosted backend or peer discovery)
- HUB-002: Machine list API (query registered machines for current user)
- HUB-003: Desktop Machines panel (status dashboard)
- HUB-004: iOS Machines section on home screen
- HUB-005: Per-machine detail view (lanes, sessions, activity)
- HUB-006: Sync status indicators (in-sync / behind / diverged)
- HUB-007: QR code machine pairing flow

---

#### Phase 12B: Cross-Machine Sync

**Goal**: One-tap sync between machines. Keep repos in sync without manually SSH-ing in to run git pull.

**Scope**:
- "Sync to machine" button: triggers fetch + pull --rebase on target machine via relay
- "Sync all" button: sync all machines for the current project
- Sync operates on main/primary branch and all lane branches
- Conflict detection before sync (uncommitted changes warning)
- Sync progress shown in real-time
- Optional auto-sync on push (fast-forward only)

**Task References**:
- SYNC-001: Remote sync command (trigger git pull on target machine via relay)
- SYNC-002: Sync all machines for a project
- SYNC-003: Pre-sync conflict detection (uncommitted changes warning)
- SYNC-004: Sync progress streaming to client
- SYNC-005: Auto-sync on push (optional, fast-forward only)

---

#### Phase 12C: Work Routing

**Goal**: Choose which machine runs a task. "Run Claude Code on my VPS" while your laptop is closed.

**Scope**:
- Machine selector when spawning new terminal sessions (name, status, load, available tools)
- Lane-machine affinity tracking (lane worktree exists on a specific machine)
- "Move lane to machine" operation (clone worktree via git push/fetch)
- Cross-machine lane view: lane list aggregates lanes across all connected machines with machine filter

**Task References**:
- ROUTE-001: Machine selector when spawning sessions
- ROUTE-002: Lane-machine affinity tracking
- ROUTE-003: Move lane to another machine (worktree migration)
- ROUTE-004: Cross-machine lane aggregation in lane list
- ROUTE-005: Machine filter in lane list

---

#### Phase 12 -- Cross-Cutting Notes

**Feature Doc References**: New doc `docs/features/MACHINE_HUB.md` to be created.

**Architecture References**: `CLOUD_BACKEND.md`, `RELAY_SERVER.md`, `SECURITY_AND_PRIVACY.md`

**Dependencies**: Phase 10 (relay server), Phase 11 (iOS app for mobile hub view). Phase 12A can begin as soon as Phase 10B is done. Phase 12B/12C can be developed in parallel after 12A.

**Exit Criteria**: Machines register with the hosted backend and appear in the dashboard (desktop and iOS). Online/offline status updates within 30 seconds of state change. Sync status correctly shows in-sync/behind/diverged for shared projects. One-tap sync triggers git pull on target machine. Work can be routed to a specific machine when spawning sessions. Lanes can be migrated between machines.

---

#### Phases 10-12: Risk Notes

See Risk Register (R-14 through R-19) for risks specific to the relay server, iOS app, and multi-device architecture.

---

## Cross-Cutting Concerns

### Testing Strategy

Testing is applied incrementally as each phase is built, not deferred to a final testing phase.

| Layer | Approach | Scope |
|-------|----------|-------|
| **Unit tests** | Vitest for all service logic in the main process | Git operations parsing, delta computation, pack generation, conflict prediction algorithms, config validation |
| **Integration tests** | Vitest with real SQLite and filesystem | Service-to-service interactions, IPC round-trips, job engine pipeline, operation recording |
| **Component tests** | React Testing Library + Vitest | Individual React components (lane row, session card, diff viewer, file tree node) |
| **E2E tests** | Playwright or Spectron | Full application flows (create lane, open terminal, commit, view diff, create PR) |

Each phase's exit criteria implicitly include tests for all new services and critical UI paths. Tests are written alongside implementation, not after.

### Performance Requirements

| Metric | Target | Affected Phases |
|--------|--------|----------------|
| App startup to interactive | < 2 seconds | All phases (regression monitoring) |
| PTY output latency (main to renderer) | < 16ms (one frame) | Phase 0 |
| File tree render (1000 files) | < 200ms | Phase 3 |
| Diff view render (large file) | < 500ms | Phase 1, Phase 3 |
| Conflict prediction (10 lanes) | < 5 seconds | Phase 5 |
| Pack generation (single lane) | < 3 seconds | Phase 2 |
| Graph canvas render (50 nodes) | < 100ms | Phase 7 |
| SQLite query (any single query) | < 50ms | All phases |

### Security Considerations

Security is not a separate phase; it is enforced at every layer from Phase -1 onward.

| Concern | Implementation | Enforced From |
|---------|---------------|---------------|
| **Process isolation** | Renderer has zero Node.js access; all system calls go through typed IPC allowlist | Phase -1 |
| **Secret protection** | API keys in `local.yaml` (gitignored); GitHub tokens in OS keychain only; never in SQLite or config files | Phase 6, Phase 7 |
| **Configuration trust** | SHA-based trust model for shared config; user approval before executing any commands from `ade.yaml` | Phase 2 |
| **Hosted mirror redaction** | Secret redaction rules strip `.env`, credentials, API keys before upload; user-configurable exclude patterns | Phase 6 |
| **Transcript privacy** | Terminal output may contain secrets; transcripts are local-only unless user explicitly opts in to hosted upload | Phase 0, Phase 6 |
| **Proposal safety** | LLM-generated diffs are previewed before application; all applications create operation records for undo | Phase 6 |
| **Git safety** | Destructive operations (force push, hard reset) require confirmation dialog; all operations tracked with pre/post SHA | Phase 1 |
| **IPC allowlist** | Only explicitly registered IPC channels are accessible from the renderer; no wildcard patterns | Phase -1 |

### Accessibility

- All interactive elements are keyboard-navigable (enforced per phase)
- ARIA labels on custom components (lane rows, session cards, tree nodes)
- High contrast mode compatibility (both themes meet WCAG AA for text contrast)
- Focus management for modals and dialogs
- Screen reader compatibility for critical workflows (lane selection, git operations, PR creation)

### Error Handling Philosophy

Every phase follows a consistent error handling pattern:

1. **Service layer**: Operations return structured results rather than throwing
2. **IPC layer**: Errors are serialized and transmitted to the renderer with user-friendly messages
3. **UI layer**: Toast notifications for transient errors; inline error displays for form validation; modal dialogs for destructive operation failures
4. **Recovery**: Failed operations are recorded in the history timeline with error context, enabling debugging without log diving

---

## Risk Register

| ID | Risk | Likelihood | Impact | Mitigation | Affected Phases |
|----|------|-----------|--------|------------|----------------|
| R-01 | `node-pty` native module compatibility across Electron versions | Medium | High | Pin Electron and node-pty versions together; test upgrades in isolation; maintain fallback to basic shell spawn | Phase 0 |
| R-02 | Monaco Editor bundle size impacts startup time | Medium | Medium | Lazy-load Monaco only when Files or Diff tabs are activated; use code splitting; monitor startup metrics | Phase 3 |
| R-03 | `git merge-tree` behavior varies across git versions | Medium | Medium | Require git >= 2.38 (when merge-tree gained the 3-way merge mode); document minimum version; fall back to temp-index approach for older git | Phase 5 |
| R-04 | GitHub API rate limiting impacts PR status polling | High | Low | Implement exponential backoff; cache responses; use conditional requests (ETag/If-Modified-Since); allow user-configurable poll interval | Phase 7 |
| R-05 | LLM output quality varies unpredictably for narrative generation | High | Medium | Always pair LLM narratives with deterministic data; show confidence scores; allow user override/editing; implement human-in-the-loop review | Phase 6 |
| R-06 | Large repositories (100K+ files) cause file tree performance issues | Medium | Medium | Lazy loading with depth limiting; virtual scrolling; gitignore filtering; debounced file watching; avoid full-tree loads | Phase 3 |
| R-07 | Stacked rebase operations can fail in complex merge scenarios | Medium | High | Validate stack integrity before restack; provide clear error messages with recovery instructions; record all SHA transitions for manual recovery | Phase 4 |
| R-08 | AWS cold start latency for Lambda workers impacts job response time | Medium | Low | Use provisioned concurrency for critical job types; implement client-side polling with exponential backoff; show progress indicators | Phase 6 |
| R-09 | Cross-platform differences in PTY behavior (Windows vs macOS vs Linux) | Medium | Medium | Test on all three platforms per release; use platform-specific shell detection; handle signal differences (SIGTERM vs TerminateProcess) | Phase 0, Phase 9 |
| R-10 | sql.js (WASM) write performance under heavy operation recording | Low | Medium | Debounced flush strategy (125ms); batch writes during rapid operations; monitor flush frequency; fall back to native SQLite if needed | All phases |
| R-11 | React Flow performance degrades with many nodes and edges (50+ lanes) | Low | Medium | Virtualize off-screen nodes; throttle edge recomputation; limit risk overlay edges to top-N risks; implement level-of-detail rendering | Phase 7 |
| R-12 | Secret leakage via terminal transcripts uploaded to hosted mirror | Medium | High | Transcript upload is opt-in only; apply redaction rules before upload; scan for common secret patterns; provide audit log of uploaded content | Phase 6 |
| R-13 | Concurrent worktree operations cause git lock contention | Medium | Medium | Serialize git operations per-worktree via job engine; implement lock file detection with retry; provide clear "repository locked" error messages | Phase 1, Phase 4 |
| R-14 | WebSocket latency adds perceptible delay to terminal interaction | Medium | High | Binary frames for PTY data; target <50ms added RTT; local network via Tailscale avoids public internet where possible | Phase 10, 11 |
| R-15 | iOS terminal rendering performance with large output buffers | Medium | Medium | Virtualized list; paginated scrollback; cap in-memory buffer at 10K lines with on-demand loading from relay | Phase 11 |
| R-16 | APNs push notification reliability (token expiry, delivery delays) | Medium | Low | Token refresh on app launch; fallback to in-app polling; test with APNs sandbox before production | Phase 10, 11 |
| R-17 | Core extraction breaks Electron-specific codepaths | Medium | High | Comprehensive test suite before extraction; regression tests after every step; feature-flag for embedded vs imported core | Phase 10 |
| R-18 | Cross-machine git sync causes data loss (overwrite uncommitted work) | Low | Very High | Never auto-sync with uncommitted changes; warn always; fast-forward only by default; stash before pull | Phase 12 |
| R-19 | Multiple WebSocket clients cause race conditions in service state | Medium | Medium | Single-writer model (one client writes, others observe); or optimistic concurrency with conflict detection | Phase 10 |

---

*This document is the authoritative implementation plan for ADE. It is maintained alongside the feature and architecture documentation and updated as phases are completed.*

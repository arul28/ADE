# ADE system architecture overview

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-24

ADE is a local-first development control plane built around a trusted Electron main process, an untrusted renderer, and a provider-flexible AI/runtime layer. The current architecture is designed around three goals:

- keep project open and tab switches responsive
- preserve strict trust boundaries around repo mutation and execution
- let background systems exist without silently destabilizing the app

---

## Architectural summary

ADE is made of three cooperating layers:

1. **Desktop UI** — Electron + React surfaces for lanes, files, terminals, CTO, missions, graph, PRs, settings, and history
2. **Local core engine** — main-process services for git, PTYs, SQLite, lane state, memory, PRs, missions, and integrations
3. **AI and integration layer** — provider-native runtimes, ADE-owned tools over MCP, worker orchestration, and external bridges such as Linear and OpenClaw

The renderer never mutates the repository directly. All privileged operations run through main-process services or worker runtimes operating inside ADE-managed boundaries.

---

## Current system model

### 1. Renderer surfaces

The renderer is now deliberately **cheap first, rich later**.

Key current behaviors:

- project open loads lanes without expensive status first
- provider mode and full lane status hydrate later
- terminal attention only polls on `/work` and `/lanes`
- Run loads config and process/test definitions independently from lane runtime
- graph activity uses session-only live refresh during PTY churn and reserves history-backed recompute for slower timers and visibility/focus return
- history uses silent visibility-aware polling only while running operations exist
- shared session-list caching deduplicates repeated `ade.sessions.list` calls
- feature pages stage heavy data instead of hydrating everything on mount

This change turned the renderer from a frequent source of tab-switch stalls into a better-behaved leaf in the overall system.

### 2. Main-process service graph

The main process owns:

- project bootstrap and switching
- `.ade` health and repair
- git, worktrees, and lane state
- files, PTYs, transcripts, and process management
- conflict prediction and rebase helpers
- PR/GitHub services
- mission and orchestrator services
- consolidated unified memory system (SQLite-backed with local embeddings), digests, and embedding services
- CTO state, Linear sync/dispatch/ingress, and OpenClaw bridge
- dev tools detection (git, gh CLI availability checks)
- multi-device sync (cr-sqlite CRDT replication, WebSocket host/peer, device registry, host/controller model with legacy `brain*` wire/storage naming)

Background startup is routed through one helper in `main.ts`, which gives every task an explicit label, delay, env gate, and timing log.

### 3. AI and worker runtime

ADE remains provider-flexible:

- CLI subscriptions
- API-key/OpenRouter providers
- local OpenAI-compatible endpoints

The orchestrator, agent chat, and CTO all use those provider paths through ADE's runtime contracts rather than a hosted ADE backend. MCP server connectivity is resolved through a centralized launch module (`adeMcpLaunch.ts`) that selects between a bundled proxy (packaged builds), a pre-built headless server, or TypeScript source execution depending on the runtime environment.

### 4. Memory architecture

Two memory systems coexist, managed from **Settings > Memory**:

- **Unified memory** (`unifiedMemoryService.ts`): The primary AI knowledge backbone. A SQLite-backed store in `.ade/ade.db` with three scopes (`project`, `agent`, `mission`), three tiers (Tier 1 pinned, Tier 2 active, Tier 3 aging), hybrid retrieval (FTS4 BM25 + cosine similarity via local Xenova/all-MiniLM-L6-v2 embeddings + MMR re-ranking), lifecycle sweeps, batch consolidation, and pre-compaction flush with quality criteria. All agent runtimes read from and write to this store.
- **CTO core memory files** (`.ade/cto/`): File-backed identity and project context for the CTO agent. Managed separately from unified memory tables but both surfaces are accessible from the Settings Memory tab.

Memory UI is consolidated in **Settings > Memory** (Health tab for entry counts, embedding progress, sweep/consolidation stats, and manual actions). There are no other memory surfaces in the renderer.

### 5. Orchestrator and coordinator

The orchestrator now emits structured lifecycle status updates at each coordinator stage (booting, analyzing prompt, fetching project context, launching planner, waiting, failure, stopped). A planning-startup guard prevents tool drift during the prep phase. Planner launch failures are categorized (transient vs. permanent) with automatic retry on transient errors.

Worker root propagation ensures tools resolve DB state from the canonical repo root while file operations stay in the lane workspace, for both desktop and headless workers.

The coordinator has finalization awareness: a `check_finalization_status` tool reads the mission state doc, and queue landing completion events are routed to the coordinator event loop. This gives the coordinator informed decision-making about mission completion without bypassing runtime validation gates.

### 6. Agent tool tiers

Agent tools are organized into three tiers:

- **universalTools** — available to all agents (memory search/add/pin, context reading)
- **workflowTools** — available to chat agents (lane creation, PR creation, screenshot capture, completion reporting, PR issue resolution tools)
- **coordinatorTools** — restricted to the mission orchestrator (spawn_worker, skip_step, complete_mission, check_finalization_status, etc.)

This tiering ensures appropriate capability boundaries between agent roles.

---

## Responsiveness architecture

The app now follows a stability-first contract that is part of the architecture, not just a debug trick.

### Quiet-first project open

Initial project open does the minimum necessary to make the app usable:

- `refreshLanes({ includeStatus: false })`
- keybindings
- later lane status hydration
- later provider-mode hydration

This keeps startup work from being dominated by lane status, PR state, or integration checks.

### Controlled background startup

Background services are no longer lumped into a single opaque deferred block. Each one is scheduled explicitly and emits structured startup logs.

That includes:

- config reload
- usage tracking
- automation ingress
- external MCP
- OpenClaw bridge
- mission queue bootstrap
- team runtime recovery
- port allocation recovery
- Linear sync and ingress
- memory lifecycle tasks
- skill registry
- head watcher

### Dormant-until-configured integrations

Integrations that depend on external configuration now stay dormant instead of spinning:

- Linear sync skips idle cycles when no workflows or credentials exist
- Linear ingress only auto-starts when realtime ingress is configured
- onboarding does not require Linear
- OpenClaw is excluded from first-run setup

### Staged feature hydration

Heavy surfaces now load in phases:

- **Run**: config/process definitions first, selected-lane runtime second
- **CTO**: summary first, team/settings/chat-specific work later
- **Missions**: list first, dashboard/settings/model capabilities later, with selected-mission live refresh coalesced instead of dashboard-wide reloads on every orchestrator event
- **Graph**: topology first, then risk/activity/sync/PR overlays
- **PRs**: workflow state and merge contexts only when needed

### Shared renderer caches

High-frequency renderer calls now use cache layers or scoped polling:

- shared session-list cache for attention, work, graph, and lane surfaces
- GitHub snapshot caching in both renderer and main process
- lane terminal polling only while live sessions exist

---

## Observability architecture

ADE now emits enough structured telemetry to isolate regressions without attaching a debugger first.

### Main-process logs

Key event families:

- `project.init_stage`
- `project.startup_task_enabled`
- `project.startup_task_skipped`
- `project.startup_task_begin`
- `project.startup_task_done`
- `ipc.invoke.begin`
- `ipc.invoke.done`
- `ipc.invoke.failed`

### Renderer logs

Key event families:

- `renderer.route_change`
- `renderer.tab_change`
- `renderer.window_error`
- `renderer.unhandled_rejection`
- `renderer.event_loop_stall`

This logging model is now essential to the architecture because it exposes whether a regression is caused by:

- main-process startup
- integration churn
- renderer over-hydration
- duplicate polling/fetch loops
- AI/background jobs

---

## Feature-specific current state

### CTO

The CTO is now a chat-first, persistent project operator with optional Linear and OpenClaw integrations. First-run setup focuses on model selection, personality selection, project context, and optional Linear setup; it no longer front-loads OpenClaw or blocks completion on disconnected integrations.

The CTO prompt architecture is now explicit:

- immutable ADE doctrine
- user-selected personality overlay
- memory/continuity model

Project-specific summary, conventions, active focus, and recent continuity are memory layers, not part of the immutable doctrine. Post-compaction identity re-injection ensures the CTO does not lose its doctrine or personality overlay after context compaction.

The CTO chat runtime also has a curated ADE operator tool surface for lanes, work chats, missions, workers, and Linear workflow supervision. This is intentionally separate from mission-coordinator tooling; the CTO gets stable supervisor operations rather than the raw internal orchestrator surface.

### Missions

Missions remain ADE's structured multi-worker execution system, but the mission launcher and mission page no longer front-load every supporting query. Cached phase profiles/items, delayed model metadata, and lazy budget telemetry make the page feel materially lighter.

### PRs and GitHub

The PR system still supports local simulation, stacked workflows, and integration proposals, but GitHub snapshot loading is now cached and integration simulation is manually triggered instead of auto-running on tab entry. PR issue resolution is available: agents can be launched from the PR detail surface to fix failing CI checks and address unresolved review threads, with dedicated workflow tools for refreshing issue state, rerunning checks, and managing review threads. PR polling now runs on a 60-second default interval (up from 25s) and uses fingerprint-based change detection to avoid cascading re-renders when nothing changed. Rebase suggestions are queue-aware: the conflict service fetches queue target tracking branches and resolves rebase overrides so that queued PRs rebase against the correct comparison ref rather than always using the lane's base branch. The PR detail pane supports merge bypass for blocked PRs (opt-in checkbox when branch protection prevents merge but the user may have bypass permissions), a CI running indicator for in-progress checks, and PR notification toasts with tone-aware styling and structured metadata.

### Workspace Graph

The graph still provides topology, risk, PR, and activity overlays, but it now stages those layers instead of mounting everything at once. During active PTY output, the graph refreshes session-derived activity without pulling full history-backed activity on every chunk.

### Memory

The memory system has been consolidated into a unified SQLite-backed store with three scopes and three tiers, replacing the earlier multi-surface approach. All agent types receive improved memory instructions with concrete examples and quality criteria. The pre-compaction flush prompt now includes explicit SAVE/DO-NOT-SAVE guidance so agents produce fewer, higher-quality memories. CTO core memory files coexist as a separate persistence layer. The only memory UI surface is Settings > Memory.

The memory pipeline now includes quality filters at multiple stages. PR feedback capture filters out low-signal content (generic deployment previews, link-only comments, short URL-heavy messages, and content without durable guidance signals like "always", "never", "must", etc.) before creating memory candidates. Episodic memories are stored in a human-readable format with structured JSON preserved in an HTML comment for downstream parsing. The procedural learning service skips PR-feedback-sourced episodes and low-signal episodes to avoid polluting the procedural knowledge base. Memory candidate promotion now also accepts system-sourced entries at a lower confidence threshold (0.6 with any observation count) alongside the existing 0.7/2-observation gate for other sources.

---

## Performance best practices

The prescriptive rules for maintaining ADE's responsiveness live in `docs/architecture/DESKTOP_APP.md` under **Performance best practices**. That section covers mandatory patterns for background services, feature page hydration, renderer polling, caching, IPC telemetry, and general stability rules. All new code must follow those rules to avoid reintroducing the startup and tab-switch regressions the stability work eliminated.

---

## Current status

Phases 1-5 are complete for single-device operation. ADE's architecture has explicit control points for startup, bounded integration behavior, scoped renderer hydration, and enough tracing to explain failures quickly.

The v1 closeout completed the final integration gaps:

- Memory pipeline fully wired (compaction flush -> episodic -> procedural -> skill export, human work digest connected to head watcher, failure knowledge capture connected to error handlers)
- Linear dispatcher hardened (snapshot refresh, employee fallback, PR null-check, closure notifications, outbound comment error handling, review wait timeout)
- Coordinator finalization awareness (check_finalization_status tool + queue landing events)
- Chat agents have workflow tools (lane/PR/screenshot/completion)
- Embedding health monitoring with structured logging; embedding worker queues items when model unavailable
- UI error states, IDE deep-linking, and GitHub token decryption error surfacing
- Runtime hardening: PR merge 3-tier fallback, stagnation detection, turn-level and autopilot timeouts, IPC handler timeouts, DB flush ordering, mission step bidirectional sync, cascade cleanup of team resources

Current architecture work:

- **Multi-device sync (Phase 6 W1-W4 foundation in place)**: desktop host/controller sync, pairing, and device registry are implemented on desktop. iOS shell and local-first contracts exist, but the current vendored `crsqlite.xcframework` still blocks replicated DB boot on iOS. See [MULTI_DEVICE_SYNC.md](./MULTI_DEVICE_SYNC.md) for the canonical architecture and current blocker.

Future architecture work focuses on:

- Phase 6 W4+: device pairing (QR/keychain), Tailscale integration, iOS companion app
- Mobile polish and advanced remote workflows (Phase 7)
- Full computer-use MCP tool loop
- Provider usage telemetry refinements

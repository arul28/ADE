# ADE — Product Requirements

ADE is a **per-machine local-first development system** for AI-assisted software engineering. Its center is the **brain**: the always-on, machine-owned ADE process for a channel. The brain owns projects, git-worktree lanes of work, multi-provider agent chat, work sessions, a persistent CTO agent, worker delegation, pipeline automations, PR stacking, conflict simulation, computer-use proofs, the sync websocket, and the project catalog. Three first-party clients attach to it: the **Electron desktop app** (multi-window, one window per project, optionally bound to a remote runtime over SSH), the **`ade code` terminal client**, and the **iOS app**. The same `ade` CLI is also used directly from any shell.

This doc is the entry point. Every major feature and concept is linked to its detailed breakdown in [`features/`](./features/). For how the pieces fit together, read [ARCHITECTURE.md](./ARCHITECTURE.md) next.

---

## What ADE Is

ADE is a single-user development control plane that runs one **ADE brain per machine per channel** (`apps/ade-cli/`, listening on the channel's local RPC endpoint, installable as a login service via launchd / systemd / Windows). The brain hosts **multiple projects** through a project registry; project-scoped operations dispatch through the multi-project JSON-RPC surface (`projects.*`, `sync.*`, `ade/actions/call` with a `projectId`).

The clients of that brain are equal:

- **Electron desktop** (`apps/desktop/`) — multi-window UI. Local windows attach to the local brain through `LocalRuntimeConnectionPool`. Windows can also be bound to a remote machine over SSH; that path runs `ade rpc --stdio` on the remote and routes runtime-backed APIs through `RemoteConnectionPool`. Runtime-bound windows do not retry project work against desktop-local handlers; the remaining in-process services are for pre-binding desktop flows, Electron-only side effects, diagnostics, and tests.
- **ADE Code (`ade code`)** — terminal-native Work chat (Ink + React) in `apps/ade-cli/src/tuiClient/`. Defaults to attaching to the machine brain; starts the brain if missing. `--embedded` keeps the in-process runtime fallback explicit.
- **iOS app** (`apps/ios/`) — SwiftUI controller; pairs with an ADE machine over WebSocket. The phone never runs agents.
- **SSH-attached desktop** — a desktop window pointed at a remote machine is the same client as a local window; the remote machine's brain is authoritative for its projects.

The primary unit of work inside any project is a **lane**: an isolated git worktree + per-lane process pool + agent session. Many lanes run concurrently — each with its own chat, its own processes, its own PR. Lanes compose into **stacks** (dependency chains) and can be delegated to CTO workers or automation rules when the work needs durable routing.

Layered on top, all owned by the brain:
- **Agents** — chat, CTO operator, workers. Multi-provider (Anthropic, OpenAI, Claude Code CLI, Codex, OpenCode, Cursor). Tool-aware. CTO worker adapter types: `claude-local`, `codex-local`, `process`.
- **Automations** — rule-based background workflows triggered by events, cron, webhooks.
- **Computer use** — control plane that fans out to Computer Use, agent-browser, or local fallback for UI automation proofs.
- **ADE browser** — project-scoped built-in browser with persistent project profiles, tab/session ownership, hidden-tab agent actions, diagnostics, traces, and explicit proof promotion.
- **Linear** — first-class two-way integration owned by the CTO agent.
- **Multi-device sync** — cr-sqlite CRDT replication, owned by the sync service inside the brain. The iOS app and any controller desktops connect through the same sync service.
- **Remote runtime** — the desktop ships per-platform `ade-<platform-arch>` binaries plus native deps under `apps/desktop/resources/runtime/`; `bootstrapRemoteRuntime` uploads them on first SSH connect. Headless installs use `curl … install.sh | sh`.

ADE is the control plane. It owns ADE Browser automation for its built-in project browser, while OS-level computer-use still runs through dedicated backends and ADE normalizes their artifacts.

---

## Core Concepts

| Concept | Summary | Doc |
| --- | --- | --- |
| Brain | The always-on, machine-owned ADE process for one channel. Hosts every project; desktop, `ade code`, and iOS attach as clients. Installable as a launchd / systemd / Windows login service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role; manual/headless runtimes can exist for isolated commands and tests. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off; used for dev/test work instead of the automated stable/beta/alpha brain service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Project | One repo entry in the brain's project registry. Identified by stable hash of root path; addressed in the multi-project RPC by `projectId`. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Lane | Isolated git worktree + per-lane process pool + agent session for one task. | [lanes/README.md](./features/lanes/README.md) |
| Stack | Dependency chain of lanes → stacked PRs. | [lanes/stacking.md](./features/lanes/stacking.md) |
| Agent | Typed persona with identity, tool tier, budget, and session log. CTO + workers + chat agents. | [agents/README.md](./features/agents/README.md) |
| Worktree | Git clone dir under `.ade/worktrees/<lane-id>/`, one per lane. | [lanes/worktree-isolation.md](./features/lanes/worktree-isolation.md) |
| Lane runtime | Per-lane process pool + env + ports + proxy + diagnostics. | [lanes/runtime.md](./features/lanes/runtime.md) |
| Session | PTY-backed terminal session pinned to a lane. | [terminals-and-sessions/README.md](./features/terminals-and-sessions/README.md) |
| Proof | Normalized computer-use artifact (screenshot, recording, network log). | [computer-use/artifact-broker.md](./features/computer-use/artifact-broker.md) |

## Glossary

| Term | Meaning |
| --- | --- |
| Brain | The always-on, machine-owned ADE process for one channel. It carries the local RPC endpoint, sync websocket, project catalog, pairing authority, and executor authority. Some existing code/protocol fields still say `host` or `brain_*`. |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role, but "brain" names authority/lifecycle, not a category of launchable runtimes. |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off so it cannot claim brain authority; use a separate `ADE_HOME` when you also want full machine-state isolation. |
| Machine | A physical computer with a stable per-channel ADE identity and project catalog. |
| Channel | A release lane: stable, beta, alpha, or dev. Each channel isolates state under its own ADE home. |
| ADE home | The machine state root for a channel (`~/.ade`, `~/.ade-beta`, `~/.ade-alpha`, or a dev override). Holds project catalog, secrets, runtime resources, and endpoints. |
| Remote runtime | A runtime reached over SSH by a desktop window through `ade rpc --stdio`; the remote machine's brain is authoritative for its projects. |
| Desktop bridge | Narrow Electron-main side channel for services that require real Electron UI APIs, such as ADE Browser. |
| Sync service | Brain-owned WebSocket + cr-sqlite service that pairs controllers, replicates ADE DB state, routes mobile commands, and manages phone PIN pairing. |
| Client | A UI or CLI surface attached to an ADE brain or runtime transport: desktop, `ade code`, iOS, or an SSH-attached desktop window. |
| Controller | A client that reads runtime state and sends commands without running agents itself; the iOS app is always a controller. |
| Catalog | The machine-level list of projects the brain serves to clients and ADE Mobile. |
| Project | A registered repository root known to a machine brain and addressed by `projectId`. |
| Lane | A task-scoped git worktree with its own process pool, agent chat, work sessions, and PR flow. |
| Worktree | The filesystem checkout backing a lane, usually under `.ade/worktrees/<lane-id>/`. |
| Stack | A dependency chain of lanes that maps to stacked PRs. |
| Work session | A tracked chat, agent CLI, shell, or PTY session associated with a lane or project surface. |
| Agent chat | A structured multi-provider chat session that can call ADE tools, stream events, and attach to a lane. |
| Terminal session | A PTY-backed work session with transcript, runtime state, and optional chat ownership. |
| Agent | A model-backed operator with persona, provider/model, tool tier, budget, and session log. |
| CTO | The persistent project-level agent that coordinates workers, Linear workflows, and plans. |
| Worker | A delegated agent launched by the CTO or automation rules for scoped execution. |
| Proof | A normalized artifact proving UI or workflow execution: screenshot, recording, trace, or log. |
| Remote target | A saved SSH-reachable machine that can host a remote runtime. |
| Remote project | A project registered with the remote target's brain. |
| CRDT / CRR | The cr-sqlite replication model used for synced ADE database tables. |
| Project registry | The machine catalog at `$ADE_HOME/projects.json` that maps root paths to stable `projectId`s. |

---

## Feature Index

### Brain, runtime, and clients

- [**Remote Runtime**](./features/remote-runtime/README.md) — Remote access to an ADE runtime. Multi-project registry, machine endpoint, login-service install, SSH bootstrap of the cross-platform `ade-<platform-arch>` runtime binaries shipped under `apps/desktop/resources/runtime/`. A remote machine's brain is authoritative for its projects.
- [**ADE Code**](./features/ade-code/README.md) — Terminal-native Work chat (Ink + React) inside `apps/ade-cli`. Default attaches to the machine brain and starts it if missing. Same JSON-RPC surface as the desktop app and the iOS controller.

### Work execution

- [**Lanes**](./features/lanes/README.md) — Worktree isolation, stacking, lane runtime, OAuth redirect, diagnostics. Each lane is a sandbox. Stacks are dependency chains. Lane runtime covers ports, env, proxy, processes.
- [**Pull Requests**](./features/pull-requests/README.md) — Stacked PRs, merge queue, conflict simulation, integration merge plans, and merge-into-lane workflows. Backed by lanes; dependencies rebase automatically.
- [**Conflicts**](./features/conflicts/README.md) — Pre-flight detection (full pairwise matrix up to 15 lanes, prefilter above), live simulation via `git merge-tree`, AI-assisted resolution, external CLI resolver flow.
- [**Workspace Graph**](./features/workspace-graph/README.md) — React Flow canvas projecting lanes/PRs/conflicts/sessions into a single view. Staged hydration (topology first, then activity/risk/sync).

### Agents and chat

- [**Agents**](./features/agents/README.md) — Three surfaces: chat, CTO operator, workers. Identity, capability modes, tool tiers, heartbeats.
- [**Chat**](./features/chat/README.md) — Multi-provider, streaming, tool-aware. Transcript and turns, tool system (universal/workflow/coordinator), agent routing, composer + derived panels, and parallel multi-model lane launch. Terminal client: [ADE Code](./features/ade-code/README.md).
- [**History**](./features/history/README.md) — Two surfaces sharing one page: a GitKraken-style commit graph for the focused lane (per-commit branch/lane/tag/cherry-pick/revert/reset and lane-level head-change undo+redo), and a unified activity feed that merges operations with chat sessions, CTO sessions, and worker runs. Every recorded service follows the same `runTrackedOperation` pattern.

### Automation and CTO

- [**Automations**](./features/automations/README.md) — Rule triggers (time, action, webhook) → agent-session and built-in execution surfaces. Confidence + verification + human review.
- [**CTO**](./features/cto/README.md) — Persistent project-level AI operator with identity, context continuity, Linear workflows, pipeline builder, and worker team.

### Workspace surfaces

- [**Terminals and Sessions**](./features/terminals-and-sessions/README.md) — PTY, session, managed-process, and lane-tied macOS VM services. Process lifecycle tracking, AI-title pipeline, lazy resume-target hydration, stale reconciliation, VM-backed GUI validation.
- [**Files and Editor**](./features/files-and-editor/README.md) — Atomic writes, ref-counted chokidar watcher, file search index, Monaco surfaces (edit/diff/conflict), preload trust boundary.
- [**Project Home**](./features/project-home/README.md) — Combined welcome + per-lane runtime dashboard. Loads lane-independent metadata vs lane runtime separately.
- [**Onboarding and Settings**](./features/onboarding-and-settings/README.md) — First-run wizard (stack detection, suggested config, import), 9-tab settings, configuration schema with trust model.

### Integrations

- [**Linear Integration**](./features/linear-integration/README.md) — Webhook + relay + reconciliation. Workflow presets, target types (session/worker/PR), bidirectional sync.
- [**Computer Use**](./features/computer-use/README.md) — Intentional proof capture plus active App Control and macOS VM bridges. Canonical artifact model, ownership-linked storage.
- [**iOS Simulator**](./features/ios-simulator/README.md) — Chat-side macOS-only drawer that builds, launches, mirrors, inspects, and controls a booted iOS Simulator. ADEInspector publishes per-frame SwiftUI element metadata so taps become source-anchored chat context.
- [**Sync and Multi-Device**](./features/sync-and-multi-device/README.md) — cr-sqlite CRDT (desktop native ext, iOS pure-SQL emulation). Host/controller model. WebSocket envelope. Remote commands.

---

## Cross-Cutting Architecture

For the system-wide picture — brain role, runtime machinery, clients, processes, data plane, IPC, security, build/test/deploy — read [**ARCHITECTURE.md**](./ARCHITECTURE.md).

Quick pointers:

- **ADE brain and execution machinery**: `apps/ade-cli/` — the brain is the per-machine source of truth for projects, lanes, agent chats, work sessions, processes, sync, and proof. Execution services inside that process do the work. Endpoint: `$ADE_HOME/sock/ade.sock`. Login-service installers: `apps/ade-cli/src/serviceManager/installLaunchd.ts` (macOS), `installSystemd.ts` (Linux), `installWindows.ts` (Windows). Multi-project RPC: `apps/ade-cli/src/multiProjectRpcServer.ts`. Project registry/scope: `apps/ade-cli/src/services/projects/`. Sync service: `apps/ade-cli/src/services/sync/`. Credentials, agent registry, service surfaces: `apps/ade-cli/src/services/`.
- **Desktop client**: `apps/desktop/` — Electron main + preload + renderer. Multi-window. `LocalRuntimeConnectionPool` (`apps/desktop/src/main/services/localRuntime/`) speaks to the local runtime; `RemoteConnectionPool` (`apps/desktop/src/main/services/remoteRuntime/`) speaks to a runtime over SSH after `bootstrapRemoteRuntime` uploads the bundled `ade-<platform-arch>` binary. `preload.ts` routes runtime-backed APIs through those pools. In-process desktop services remain only for flows that have no runtime binding yet, Electron-only side effects, diagnostics, and tests.
- **Terminal client**: `apps/ade-cli/src/tuiClient/` — `ade code` Ink + React Work chat.
- **iOS client**: `apps/ios/` — SwiftUI controller over WebSocket to the ADE brain's sync service.
- **Renderer components**: `apps/desktop/src/renderer/components/<feature>/`.
- **Shared types + IPC contract**: `apps/desktop/src/shared/` (consumed by the desktop client and re-imported by the ADE CLI runtime). New runtime-facing types: `apps/desktop/src/shared/types/remoteRuntime.ts`, `core.ts`.
- **Data**: SQLite + cr-sqlite. `.ade/` per project (the runtime owns these files regardless of which client is attached), `~/.ade/` global.

---

## For AI Agents Reading This

If you are an AI agent working on ADE, read in this order:

1. **This PRD** — product scope + feature index.
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the apps fit, where state lives, IPC contract, services catalog.
3. **Feature READMEs** — pick only the features relevant to your task. Each README has a "Source file map" at the top so you can go straight to code.
4. **Detail docs** — when you need depth on a specific area (e.g., `features/cto/pipeline-builder.md` for pipeline internals).

The source of truth is always the code. Docs may lag on specific code paths — cross-check `git log` and the referenced files when in doubt.

Fragile areas flagged across the docs (read docs before editing):
- Multi-project RPC + project scope/registry (`apps/ade-cli/src/multiProjectRpcServer.ts`, `services/projects/`) — every runtime call lives or dies here; getting `projectId` routing wrong silently corrupts cross-project state.
- Local vs. remote runtime pools (`apps/desktop/src/main/services/localRuntime/`, `remoteRuntime/`) — desktop binding switching, SSH bootstrap upload, version negotiation against bundled `ade-<platform-arch>` binaries.
- Sync service inside the ADE runtime (`apps/ade-cli/src/services/sync/`) — desktop's old in-process sync host is disabled by default and only re-enabled with `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics; do not assume desktop owns sync.
- Multi-window shell + `app/navigate` JSON-RPC handoff (desktop main `main.ts`, runtime side in `apps/ade-cli/src/adeRpcServer.ts`) — TUI/external controllers can drive desktop window navigation.
- CTO pipeline builder — recent work, custom flat/nested target-chain translation.
- PTY / sessions / processes services — rewritten this branch.
- OAuth redirect service — complex three-state machine with HMAC signing.
- Chat transcript render pipeline — two-layer event→state→render path.

---

## Out of scope (deliberate non-goals)

- ADE does not run OS-level accessibility UI control itself. It is a control plane for those executors; ADE Browser automation is limited to ADE's built-in project browser.
- ADE does not host remote git servers. It operates on local worktrees against a GitHub remote.
- ADE does not multiplex multiple users. Single-user, per-machine.
- ADE does not ship a server-side web app. The `apps/web/` is marketing/docs-site only.

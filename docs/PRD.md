# ADE — Product Requirements

ADE is a **per-machine local-first runtime daemon** for AI-assisted software engineering. The runtime owns projects, git-worktree lanes of work, multi-provider AI chat, multi-agent missions, a persistent CTO agent, pipeline automations, PR stacking, conflict simulation, computer-use proofs, and multi-device sync. Three first-party clients attach to it as peers: the **Electron desktop app** (multi-window, one window per project, optionally bound to a remote runtime over SSH), the **`ade code` terminal client**, and the **iOS app**. The same `ade` CLI is also used directly from any shell.

This doc is the entry point. Every major feature and concept is linked to its detailed breakdown in [`features/`](./features/). For how the pieces fit together, read [ARCHITECTURE.md](./ARCHITECTURE.md) next.

---

## What ADE Is

ADE is a single-user development control plane that runs as a **runtime daemon on each machine** (`apps/ade-cli/`, started with `ade serve`, listening on `~/.ade/sock/ade.sock`, installable as a login service via launchd / systemd / Windows). The daemon hosts **multiple projects** through a project registry; project-scoped operations dispatch through the multi-project JSON-RPC surface (`projects.*`, `sync.*`, `ade/actions/call` with a `projectId`).

The clients of that runtime are equal:

- **Electron desktop** (`apps/desktop/`) — multi-window UI. Local windows attach to the local runtime through `LocalRuntimeConnectionPool`. Windows can also be bound to a remote machine over SSH; that path runs `ade rpc --stdio` on the remote and routes runtime-backed APIs through `RemoteConnectionPool`. Some legacy in-process services remain as fallbacks.
- **ADE Code (`ade code`)** — terminal-native Work chat (Ink + React) in `apps/ade-cli/src/tuiClient/`. Defaults to attaching to the machine socket; starts `ade serve` if missing. `--embedded` keeps the legacy in-process fallback explicit.
- **iOS app** (`apps/ios/`) — SwiftUI controller; connects to the runtime over WebSocket. The phone never runs agents.
- **SSH-attached desktop** — a desktop window pointed at a remote runtime is the same client as a local window; the runtime daemon is what differs.

The primary unit of work inside any project is a **lane**: an isolated git worktree + per-lane process pool + agent session. Many lanes run concurrently — each with its own chat, its own processes, its own PR. Lanes compose into **stacks** (dependency chains) and graduate into **missions** (multi-agent, multi-step orchestrated runs) when the work is bigger than a single session.

Layered on top, all owned by the runtime:
- **Agents** — chat, CTO operator, workers. Multi-provider (Anthropic, OpenAI, Claude Code CLI, Codex, OpenCode, Cursor). Tool-aware. CTO worker adapter types: `claude-local`, `codex-local`, `process`.
- **Automations** — rule-based background workflows triggered by events, cron, webhooks.
- **Computer use** — control plane that fans out to Ghost OS, agent-browser, or local fallback for UI automation proofs.
- **Linear** — first-class two-way integration owned by the CTO agent.
- **Multi-device sync** — cr-sqlite CRDT replication, owned by the runtime daemon. The iOS app and any controller desktops connect through the same sync host.
- **Remote runtime** — the desktop ships per-platform `ade-<platform-arch>` binaries plus native deps under `apps/desktop/resources/runtime/`; `bootstrapRemoteRuntime` uploads them on first SSH connect. Headless installs use `curl … install.sh | sh`.

ADE is the control plane. It does not execute browser automation or computer-use itself — it dispatches to backends and normalizes their artifacts.

---

## Core Concepts

| Concept | Summary | Doc |
| --- | --- | --- |
| Runtime | The per-machine ADE daemon (`ade serve`, `~/.ade/sock/ade.sock`). Hosts every project; desktop, `ade code`, and iOS attach as clients. Installable as a launchd / systemd / Windows login service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Project | One repo entry in the runtime's project registry. Identified by stable hash of root path; addressed in the multi-project RPC by `projectId`. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Lane | Isolated git worktree + per-lane process pool + agent session for one task. | [lanes/README.md](./features/lanes/README.md) |
| Stack | Dependency chain of lanes → stacked PRs. | [lanes/stacking.md](./features/lanes/stacking.md) |
| Mission | Multi-step orchestrated run with a coordinator agent, sub-workers, validation gates, and a result lane. | [missions/README.md](./features/missions/README.md) |
| Agent | Typed persona with identity, tool tier, budget, and session log. CTO + workers + chat agents. | [agents/README.md](./features/agents/README.md) |
| Worktree | Git clone dir under `.ade/worktrees/<lane-id>/`, one per lane. | [lanes/worktree-isolation.md](./features/lanes/worktree-isolation.md) |
| Lane runtime | Per-lane process pool + env + ports + proxy + diagnostics. | [lanes/runtime.md](./features/lanes/runtime.md) |
| Session | PTY-backed terminal session pinned to a lane. | [terminals-and-sessions/README.md](./features/terminals-and-sessions/README.md) |
| Proof | Normalized computer-use artifact (screenshot, recording, network log). | [computer-use/artifact-broker.md](./features/computer-use/artifact-broker.md) |

---

## Feature Index

### Runtime and clients

- [**Remote Runtime**](./features/remote-runtime/README.md) — The per-machine ADE daemon. Multi-project registry, machine socket, login-service install, SSH bootstrap of the cross-platform `ade-<platform-arch>` runtime binaries shipped under `apps/desktop/resources/runtime/`. Owns sync.
- [**ADE Code**](./features/ade-code/README.md) — Terminal-native Work chat (Ink + React) inside `apps/ade-cli`. Default attaches to the machine socket and starts `ade serve` if missing. Same JSON-RPC surface as the desktop app and the iOS controller.

### Work execution

- [**Lanes**](./features/lanes/README.md) — Worktree isolation, stacking, lane runtime, OAuth redirect, diagnostics. Each lane is a sandbox. Stacks are dependency chains. Lane runtime covers ports, env, proxy, processes.
- [**Pull Requests**](./features/pull-requests/README.md) — Stacked PRs, merge queue, conflict simulation, integration merge plans, and merge-into-lane workflows. Backed by lanes; dependencies rebase automatically.
- [**Conflicts**](./features/conflicts/README.md) — Pre-flight detection (full pairwise matrix up to 15 lanes, prefilter above), live simulation via `git merge-tree`, AI-assisted resolution, external CLI resolver flow.
- [**Workspace Graph**](./features/workspace-graph/README.md) — React Flow canvas projecting lanes/PRs/conflicts/sessions into a single view. Staged hydration (topology first, then activity/risk/sync).

### Agents and chat

- [**Agents**](./features/agents/README.md) — Three surfaces: chat, CTO operator, workers. Identity, capability modes, tool tiers, heartbeats.
- [**Chat**](./features/chat/README.md) — Multi-provider, streaming, tool-aware. Transcript and turns, tool system (universal/workflow/coordinator), agent routing, composer + derived panels, and parallel multi-model lane launch. Terminal client: [ADE Code](./features/ade-code/README.md).
- [**History**](./features/history/README.md) — Operations timeline + chat transcripts + exports. Every service follows the same `runTrackedOperation` recording pattern.

### Orchestration

- [**Missions**](./features/missions/README.md) — Coordinator agent, delegation graph, validation gates (19 VAL-XXX assertions), result-lane closeout, worker fan-out.
- [**Automations**](./features/automations/README.md) — Rule triggers (time, action, webhook) → three execution surfaces (mission, agent-session, built-in). Confidence + verification + human review.
- [**CTO**](./features/cto/README.md) — Persistent project-level AI operator with identity, context continuity, Linear workflows, pipeline builder, and worker team.

### Workspace surfaces

- [**Terminals and Sessions**](./features/terminals-and-sessions/README.md) — PTY, session, managed-process, and lane-tied macOS VM services. Multi-run process lifecycle keyed by `runId`, AI-title pipeline, lazy resume-target hydration, stale reconciliation, VM-backed GUI validation.
- [**Files and Editor**](./features/files-and-editor/README.md) — Atomic writes, ref-counted chokidar watcher, file search index, Monaco surfaces (edit/diff/conflict), preload trust boundary.
- [**Project Home**](./features/project-home/README.md) — Combined welcome + per-lane runtime dashboard. Loads lane-independent metadata vs lane runtime separately.
- [**Onboarding and Settings**](./features/onboarding-and-settings/README.md) — First-run wizard (stack detection, suggested config, import), 9-tab settings, configuration schema with trust model.

### Integrations

- [**Linear Integration**](./features/linear-integration/README.md) — Webhook + relay + reconciliation. Workflow presets, target types (mission/session/worker/PR), bidirectional sync.
- [**Computer Use**](./features/computer-use/README.md) — Intentional proof capture plus active App Control and macOS VM bridges. Canonical artifact model, ownership-linked storage.
- [**iOS Simulator**](./features/ios-simulator/README.md) — Chat-side macOS-only drawer that builds, launches, mirrors, inspects, and controls a booted iOS Simulator. ADEInspector publishes per-frame SwiftUI element metadata so taps become source-anchored chat context.
- [**Sync and Multi-Device**](./features/sync-and-multi-device/README.md) — cr-sqlite CRDT (desktop native ext, iOS pure-SQL emulation). Host/controller model. WebSocket envelope. Remote commands.

---

## Cross-Cutting Architecture

For the system-wide picture — runtime + clients, processes, data plane, IPC, security, build/test/deploy — read [**ARCHITECTURE.md**](./ARCHITECTURE.md).

Quick pointers:

- **Runtime daemon**: `apps/ade-cli/` — `ade serve` is the per-machine source of truth for projects, lanes, chats, processes, sync, and proof. Socket: `~/.ade/sock/ade.sock`. Login-service installers: `apps/ade-cli/src/serviceManager/installLaunchd.ts` (macOS), `installSystemd.ts` (Linux), `installWindows.ts` (Windows). Multi-project RPC: `apps/ade-cli/src/multiProjectRpcServer.ts`. Project registry/scope: `apps/ade-cli/src/services/projects/`. Sync host: `apps/ade-cli/src/services/sync/`. Credentials, agent registry, runtime-side service surfaces: `apps/ade-cli/src/services/`.
- **Desktop client**: `apps/desktop/` — Electron main + preload + renderer. Multi-window. `LocalRuntimeConnectionPool` (`apps/desktop/src/main/services/localRuntime/`) speaks to the local runtime; `RemoteConnectionPool` (`apps/desktop/src/main/services/remoteRuntime/`) speaks to a runtime over SSH after `bootstrapRemoteRuntime` uploads the bundled `ade-<platform-arch>` binary. `preload.ts` routes runtime-backed APIs through those pools. Some legacy in-process services remain as fallback.
- **Terminal client**: `apps/ade-cli/src/tuiClient/` — `ade code` Ink + React Work chat.
- **iOS client**: `apps/ios/` — SwiftUI controller over WebSocket to the runtime daemon.
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
- Sync host inside the runtime daemon (`apps/ade-cli/src/services/sync/`) — desktop's old in-process sync host is disabled by default and only re-enabled with `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics; do not assume desktop owns sync.
- Multi-window shell + `app/navigate` JSON-RPC handoff (desktop main `main.ts`, runtime side in `apps/ade-cli/src/adeRpcServer.ts`) — TUI/external controllers can drive desktop window navigation.
- CTO pipeline builder — recent work, custom flat/nested target-chain translation.
- PTY / sessions / processes services — rewritten this branch.
- OAuth redirect service — complex three-state machine with HMAC signing.
- Chat transcript render pipeline — two-layer event→state→render path.
- Mission coordinator delegation — 19 VAL-XXX behavioral invariants.

---

## Out of scope (deliberate non-goals)

- ADE does not run browser automation or accessibility-based UI control itself. It is a control plane; executors run elsewhere (Ghost OS, agent-browser CLI).
- ADE does not host remote git servers. It operates on local worktrees against a GitHub remote.
- ADE does not multiplex multiple users. Single-user, per-machine.
- ADE does not ship a server-side web app. The `apps/web/` is marketing/docs-site only.

# ADE — Product Requirements

ADE is a **per-machine local-first development system** for AI-assisted software engineering. Its center is the **brain**: the always-on, machine-owned ADE process for a channel. The brain owns projects, git-worktree lanes of work, projectless personal chats, multi-provider agent chat, work sessions, a persistent CTO agent, rule-based automations, PR stacking, conflict simulation, computer-use proofs, the sync websocket, and the project catalog. Five first-party clients attach to it: the **Electron desktop app** (multi-window, one window per project or a machine-level personal-chat tab, optionally bound to a remote runtime over SSH), the **hosted web client**, the **`ade code` terminal client**, the **iOS app**, and the **Android app**. The same `ade` CLI is also used directly from any shell.

This doc is the entry point. Every major feature and concept is linked to its detailed breakdown in [`features/`](./features/). For how the pieces fit together, read [ARCHITECTURE.md](./ARCHITECTURE.md) next.

---

## What ADE Is

ADE is a single-user development control plane that runs one **ADE brain per machine per channel** (`apps/ade-cli/`, listening on the channel's local RPC endpoint, installable as a login service via launchd / systemd / Windows). The brain hosts **multiple projects** through a project registry; project-scoped operations dispatch through the multi-project JSON-RPC surface (`projects.*`, `sync.*`, `ade/actions/call` with a `projectId`). A separate hidden machine scope owns personal chats through `personalChats.*` and is never registered as a project.

The clients of that brain are equal:

- **Electron desktop** (`apps/desktop/`) — multi-window UI. Local windows attach to the local brain through `LocalRuntimeConnectionPool`. Windows can also be bound to a remote machine over SSH; that path runs `ade rpc --stdio` on the remote and routes runtime-backed APIs through `RemoteConnectionPool`. Runtime-bound windows do not retry project work against desktop-local handlers; the remaining in-process services are for pre-binding desktop flows, Electron-only side effects, diagnostics, and tests.
- **Hosted web client** (`apps/desktop/src/renderer/webclient/`) — static browser controller over the paired machine's sync WebSocket. It keeps no project database locally and reaches projectless Chats through runtime-scoped commands.
- **ADE Code (`ade code`)** — terminal-native Work chat (Ink + React) in `apps/ade-cli/src/tuiClient/`. Defaults to attaching to the machine brain; starts the brain if missing. `--embedded` keeps the in-process runtime fallback explicit.
- **iOS app** (`apps/ios/`) — SwiftUI controller; pairs with an ADE machine over WebSocket. The phone never runs agents.
- **Android app** (`apps/android/`) — native Compose controller; races LAN, tailnet, and Relay routes, uses invalidation-only thin sync, and never runs agents.
- **SSH-attached desktop** — a desktop window pointed at a remote machine is the same client as a local window; the remote machine's brain is authoritative for its projects.

The primary unit of work inside any project is a **lane**: an isolated git worktree with its own agent and terminal sessions. Many lanes run concurrently — each with its own chat, sessions, and PR. Lanes compose into **stacks** (dependency chains) and can be driven by automation rules when the work needs durable routing.

Layered on top, all owned by the brain:
- **Agents** — lane-bound chat, machine-owned personal chat, plus the persistent CTO operator. Multi-provider (Anthropic, OpenAI, Claude Code CLI, Codex, OpenCode, Cursor). Tool-aware; Codex defaults to GPT-5.6 Sol with Terra/Luna beside it.
- **Automations** — rule-based background workflows triggered by events, cron, webhooks.
- **Computer use** — direct, signed Codex Computer Use MCP wiring on macOS plus the provider-neutral proof broker for intentional screenshots, videos, traces, and verification artifacts.
- **ADE browser** — built-in browser with one persistent human-authenticated profile per ADE installation/channel; independent project/window/personal tab collections; durable tab URLs, permissions, and normal Chromium site state; human-gated origin access; capability-bound tab/session ownership; hidden-tab agent actions; diagnostics, traces, and explicit proof promotion.
- **Linear** — issue read/search plus a developer lane/PR flow and an optional live-status round-trip.
- **Multi-device sync** — brain-owned WebSocket sync. Replica-capable clients use cr-sqlite CRDT replication; Android and hosted web use invalidation-only thin sync and refetch through remote commands and live streams. Work chats can also continue on another connected ADE desktop through an explicit clean/published Git handoff and bounded portable context capsule rather than transcript or provider-session replication.
- **Remote runtime** — the desktop ships per-platform `ade-<platform-arch>` binaries plus native deps under `apps/desktop/resources/runtime/`; `bootstrapRemoteRuntime` uploads them on first SSH connect. Headless installs use `curl … install.sh | sh`.

ADE is the control plane. It owns ADE Browser automation for its built-in project browser, while OS-level computer-use still runs through dedicated backends and ADE normalizes their artifacts.

---

## Core Concepts

| Concept | Summary | Doc |
| --- | --- | --- |
| Brain | The always-on, machine-owned ADE process for one channel. Hosts every project; desktop, web, `ade code`, iOS, and Android attach as clients. Installable as a launchd / systemd / Windows login service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role; manual/headless runtimes can exist for isolated commands and tests. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off; used for dev/test work instead of the automated stable/beta/alpha brain service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Project | One repo entry in the brain's project registry. Identified by stable hash of root path; addressed in the multi-project RPC by `projectId`. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Personal chat | Machine-owned general-purpose agent conversation with no project, lane, repository, or PR binding. Stored outside the project registry and reached through runtime-scoped RPC/sync actions. | [personal-chats/README.md](./features/personal-chats/README.md) |
| Lane | Isolated git worktree with agent and terminal sessions for one task. | [lanes/README.md](./features/lanes/README.md) |
| Stack | Dependency chain of lanes → stacked PRs. | [lanes/stacking.md](./features/lanes/stacking.md) |
| Agent | Model-backed operator. The persistent CTO plus ephemeral lane-bound and personal chat agents. | [agents/README.md](./features/agents/README.md) |
| Worktree | Git clone dir under `.ade/worktrees/<lane-id>/`, one per lane. | [lanes/worktree-isolation.md](./features/lanes/worktree-isolation.md) |
| Lane runtime | Per-lane env initialization, ports, proxy, OAuth routing, and diagnostics. | [lanes/runtime.md](./features/lanes/runtime.md) |
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
| Client | A UI or CLI surface attached to an ADE brain or runtime transport: desktop, hosted web, `ade code`, iOS, Android, or an SSH-attached desktop window. |
| Controller | A client that reads runtime state and sends commands without running agents itself; the iOS and Android apps are always controllers. |
| Catalog | The machine-level list of projects the brain serves to clients and ADE Mobile. |
| Project | A registered repository root known to a machine brain and addressed by `projectId`. |
| Lane | A task-scoped git worktree with its own agent chat, work sessions, and PR flow. |
| Worktree | The filesystem checkout backing a lane, usually under `.ade/worktrees/<lane-id>/`. |
| Stack | A dependency chain of lanes that maps to stacked PRs. |
| Work session | A tracked chat, agent CLI, shell, or PTY session associated with a lane or project surface. Its canonical lifecycle distinguishes active work, quiet “your move,” loud “Needs you,” failed/stale, ended, and settled states; settled sessions remain openable and are not archived. |
| Agent chat | A structured multi-provider chat session that can call ADE tools, stream events, and attach to a lane. |
| Personal chat | An `AgentChatSession` with `surface: "personal"`, owned by the machine brain and intentionally detached from the project catalog, lane UI, and Git/PR context. |
| Terminal session | A PTY-backed work session with transcript, runtime state, and optional chat ownership. |
| Agent | A model-backed operator with persona, provider/model, tool tier, budget, and session log. |
| CTO | The persistent project-level chat agent with durable memory that plans and reasons across the whole project. |
| Proof | A normalized artifact proving UI or workflow execution: screenshot, recording, trace, or log. |
| Remote target | A saved SSH-reachable machine that can host a remote runtime. |
| Remote project | A project registered with the remote target's brain. |
| CRDT / CRR | The cr-sqlite replication model used for synced ADE database tables. |
| Project registry | The machine catalog at `$ADE_HOME/projects.json` that maps root paths to stable `projectId`s. |

---

## Feature Index

### Brain, runtime, and clients

- [**Remote Runtime**](./features/remote-runtime/README.md) — Remote access to an ADE runtime. Multi-project registry, machine endpoint, login-service install, SSH bootstrap of the cross-platform `ade-<platform-arch>` runtime binaries shipped under `apps/desktop/resources/runtime/`. A remote machine's brain is authoritative for its projects.
- [**ADE Code**](./features/ade-code/README.md) — Terminal-native Work chat (Ink + React) inside `apps/ade-cli`. Default attaches to the machine brain and starts it if missing. Same JSON-RPC surface as the desktop app and the iOS controller, including session ask/note/settle lifecycle controls and the account-wide `/attention` pane.
- [**Web Client**](./features/web-client/README.md) — Owner-only hosted browser controller. Static Cloudflare Pages SPA, ADE account sign-in, account-directory machine selection, DPoP-bound sync WebSocket transport, no local DB, and account Attention that remains independent of the selected project.
- [**Android Companion**](./features/android-companion/README.md) — Native Kotlin/Compose thin client. Hub, Lanes, Work, Settings, LAN/tailnet/Relay pairing and adoption, account Attention, FCM, and Play build/release boundaries.

### Work execution

- [**Lanes**](./features/lanes/README.md) — Worktree isolation, stacking, lane runtime, OAuth redirect, diagnostics. Each lane is a sandbox. Stacks are dependency chains. Lane runtime covers ports, env initialization, proxy routing, and health checks.
- [**Pull Requests**](./features/pull-requests/README.md) — Stacked PRs, merge queue, conflict simulation, integration merge plans, and merge-into-lane workflows. Backed by lanes; dependencies rebase automatically.
- [**Conflicts**](./features/conflicts/README.md) — Pre-flight detection (full pairwise matrix up to 15 lanes, prefilter above), live simulation via `git merge-tree`, AI-assisted resolution, external CLI resolver flow.
- [**Workspace Graph**](./features/workspace-graph/README.md) — React Flow canvas projecting lanes/PRs/conflicts/sessions into a single view. Staged hydration (topology first, then activity/risk/sync).

### Agents and chat

- [**Agents**](./features/agents/README.md) — Two surfaces: lane-bound chat and the persistent CTO operator. Identity, capability modes, tool tiers, and the CTO memory system.
- [**Chat**](./features/chat/README.md) — Multi-provider, streaming, tool-aware. Transcript and turns, compact web/MCP/image/subagent activity, Codex Sources and stalled-turn recovery, tool system (universal/workflow/coordinator), agent routing, composer + derived panels, parallel multi-model lane launch, and [cross-machine Work chat handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md). Terminal client: [ADE Code](./features/ade-code/README.md).
- [**Personal Chats**](./features/personal-chats/README.md) — General-purpose, machine-owned AI conversations with the same model catalog but no project, lane, Git, or PR binding. Available from desktop, hosted web, mobile Hub, and the ADE CLI.
- [**History**](./features/history/README.md) — Two surfaces sharing one page: a GitKraken-style commit graph for the focused lane (per-commit branch/lane/tag/cherry-pick/revert/reset and lane-level head-change undo+redo), and a unified activity feed that merges operations with chat sessions and CTO sessions. Every recorded service follows the same `runTrackedOperation` pattern.

### Automation and CTO

- [**Automations**](./features/automations/README.md) — Rule triggers (time, action, webhook) → agent-session and built-in execution surfaces. Confidence + verification + human review.
- [**CTO**](./features/cto/README.md) — Persistent project-level AI operator: one chat thread with a smart memory system, first-class mid-thread model switching, and a light Linear read/write surface.

### Workspace surfaces

- [**Terminals and Sessions**](./features/terminals-and-sessions/README.md) — PTY and session services. Canonical cross-client session lifecycle, two-tier attention, the quiet settled tier, agent-authored status notes, AI titles, lazy resume-target hydration, and stale reconciliation.
- [**Files and Editor**](./features/files-and-editor/README.md) — Atomic writes, ref-counted chokidar watcher, file search index, Monaco surfaces (edit/diff/conflict), preload trust boundary.
- [**Universal Search**](./features/search/README.md) — One deterministic FTS5 index (disposable `.ade/cache/search-index.db`) over chat/terminal/PR/commit/branch text, unioned at query time with delegated lanes/files/artifacts/Linear. Debounced off-hot-path ingestion, deterministic ranking tiers, one `search` action domain behind ⌘K, the TUI palette, and `ade search`.
- [**Onboarding and Settings**](./features/onboarding-and-settings/README.md) — First-run wizard (stack detection, suggested config, import), 9-tab settings, configuration schema with trust model.

### Integrations

- [**Linear Integration**](./features/linear-integration/README.md) — Issue read/search, lane/commit/PR attachment flow, batch launch, session-scoped attachment, and an optional live-status round-trip.
- [**Computer Use**](./features/computer-use/README.md) — Direct signed Codex Computer Use, intentional proof capture, and active App Control. Canonical artifact model, ownership-linked storage.
- [**iOS Simulator**](./features/ios-simulator/README.md) — Chat-side macOS-only drawer that builds, launches, mirrors, inspects, and controls a booted iOS Simulator. ADEInspector publishes per-frame SwiftUI element metadata so taps become source-anchored chat context.
- [**Sync and Multi-Device**](./features/sync-and-multi-device/README.md) — cr-sqlite CRDT (desktop native ext, iOS pure-SQL emulation), invalidation-only web/Android clients, brain/controller model, WebSocket envelope, remote commands, the [cross-machine session handoff contract](./features/sync-and-multi-device/cross-machine-session-handoff.md), and [ADE Attention](./features/sync-and-multi-device/push-notifications.md): one account-wide source of truth across desktop, web, ADE Code, iOS, Android, APNs/FCM, widgets, Live Activities, and the native Mac presentation.

---

## Cross-Cutting Architecture

For the system-wide picture — brain role, runtime machinery, clients, data plane, IPC, security, build/test/deploy — read [**ARCHITECTURE.md**](./ARCHITECTURE.md).

Quick pointers:

- **ADE brain and execution machinery**: `apps/ade-cli/` — the brain is the per-machine source of truth for projects, lanes, agent chats, work sessions, sync, and proof. Execution services inside that process do the work. Endpoint: `$ADE_HOME/sock/ade.sock`. Login-service installers: `apps/ade-cli/src/serviceManager/installLaunchd.ts` (macOS), `installSystemd.ts` (Linux), `installWindows.ts` (Windows). Multi-project RPC: `apps/ade-cli/src/multiProjectRpcServer.ts`. Project registry/scope: `apps/ade-cli/src/services/projects/`. Sync service: `apps/ade-cli/src/services/sync/`. Credentials, agent registry, service surfaces: `apps/ade-cli/src/services/`.
- **Desktop client**: `apps/desktop/` — Electron main + preload + renderer. Multi-window. `LocalRuntimeConnectionPool` (`apps/desktop/src/main/services/localRuntime/`) speaks to the local runtime; `RemoteConnectionPool` (`apps/desktop/src/main/services/remoteRuntime/`) speaks to a runtime over SSH after `bootstrapRemoteRuntime` uploads the bundled `ade-<platform-arch>` binary. `preload.ts` routes runtime-backed APIs through those pools. In-process desktop services remain only for flows that have no runtime binding yet, Electron-only side effects, diagnostics, and tests.
- **Terminal client**: `apps/ade-cli/src/tuiClient/` — `ade code` Ink + React Work chat.
- **iOS client**: `apps/ios/` — SwiftUI controller over WebSocket to the ADE brain's sync service.
- **Android client**: `apps/android/` — Kotlin/Compose controller using the pure-JVM `:sync` module and invalidation-only WebSocket mode.
- **Renderer components**: `apps/desktop/src/renderer/components/<feature>/`.
- **Shared types + IPC contract**: `apps/desktop/src/shared/` (consumed by the desktop client and re-imported by the ADE CLI runtime). New runtime-facing types: `apps/desktop/src/shared/types/remoteRuntime.ts`, `core.ts`.
- **Data**: SQLite + cr-sqlite. `.ade/` per project (the runtime owns these files regardless of which client is attached), `~/.ade/` global.

---

## For AI Agents Reading This

If you are an AI agent working on ADE, read in this order:

1. **This PRD** — product scope + feature index.
2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — how the apps fit, where state lives, IPC contract, services catalog.
3. **Feature READMEs** — pick only the features relevant to your task. Each README has a "Source file map" at the top so you can go straight to code.
4. **Detail docs** — when you need depth on a specific area (e.g., `features/cto/README.md` for the CTO memory system internals).

The source of truth is always the code. Docs may lag on specific code paths — cross-check `git log` and the referenced files when in doubt.

Fragile areas flagged across the docs (read docs before editing):
- Multi-project RPC + project scope/registry (`apps/ade-cli/src/multiProjectRpcServer.ts`, `services/projects/`) — every runtime call lives or dies here; getting `projectId` routing wrong silently corrupts cross-project state.
- Local vs. remote runtime pools (`apps/desktop/src/main/services/localRuntime/`, `remoteRuntime/`) — desktop binding switching, SSH bootstrap upload, version negotiation against bundled `ade-<platform-arch>` binaries.
- Sync service inside the ADE runtime (`apps/ade-cli/src/services/sync/`) — desktop's old in-process sync host is disabled by default and only re-enabled with `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics; do not assume desktop owns sync.
- Multi-window shell + `app/navigate` JSON-RPC handoff (desktop main `main.ts`, runtime side in `apps/ade-cli/src/adeRpcServer.ts`) — TUI/external controllers can drive desktop window navigation.
- CTO smart-memory system — recent work: deterministic pre-compaction / pre-model-switch flush, file-backed durable memory, memory-rich reconstruction injection.
- PTY / session services — rewritten this branch.
- OAuth redirect service — complex three-state machine with HMAC signing.
- Chat transcript render pipeline — two-layer event→state→render path.

---

## Out of scope (deliberate non-goals)

- ADE does not run OS-level accessibility UI control itself. It is a control plane for those executors; ADE Browser automation is limited to ADE's built-in project browser.
- ADE does not host remote git servers. It operates on local worktrees against a GitHub remote.
- ADE does not multiplex multiple users. Single-user, per-machine.
- ADE does not ship a server-side web app. The `apps/web/` is marketing/docs-site only.

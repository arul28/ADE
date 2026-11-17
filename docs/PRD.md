# ADE — Product Requirements

ADE is a development system for AI-assisted software engineering. It runs 13 coding-agent providers against parallel git worktrees ("lanes"), with chat, terminals, Git, pull requests, a persistent CTO agent, automations and proof in one app. The desktop app, the hosted web client (`app.ade-app.dev`), the iPhone app and the `ade` CLI are its clients.

**ADE works fully with no computer of your own.** Every signed-in account always has one machine, **ADE Cloud**. ADE Cloud shows in every machine list and every "Run on" menu, on the web, the iPhone and the desktop, next to the person's own computers. The cloud is always a first option, not the only one: like Cursor, a person signs up, connects GitHub, picks a repository and works, with or without a Mac of their own. A person with no computer gets every tab and every flow, in the same UI as a person with three Macs.

This doc is the entry point. Every major feature links to its detailed doc in [`features/`](./features/). For how the pieces fit together, read [ARCHITECTURE.md](./ARCHITECTURE.md) next.

---

## What ADE Is

ADE has three layers:

1. **Machines.** A machine is a computer with an ADE **brain**: the always-on ADE process for one channel (`apps/ade-cli/`). The brain owns projects, lanes, agent chats, work sessions, the CTO, automations, PR actions, proof and the sync service. A machine is one of the person's own computers (macOS, Windows, Linux), or a cloud computer behind ADE Cloud.
2. **The account.** ADE's account servers (Cloudflare Workers: `apps/account-directory/`, `apps/push-relay/`, `apps/tunnel-relay/`, `apps/webhook-relay/`) hold what must be readable when no computer is awake: the machine list, ADE Cloud, saved copies of cloud work, account settings, the encrypted vault, Activity, and the account's GitHub, Linear and Jira sign-ins.
3. **Clients.** The clients show the account and every connected machine at once. They run no agents.

The clients:

- **Electron desktop** (`apps/desktop/`). Multi-window. A window attaches to this computer's brain through `LocalRuntimeConnectionPool`, or to another machine through the paired runtime channel (LAN, then tailnet, then ADE Relay) or SSH (`RemoteConnectionPool`, `ade rpc --stdio`).
- **Hosted web client** (`apps/desktop/src/renderer/webclient/`). A static page built from the desktop renderer. It signs in to the account, reads the account, and talks to connected machines over ADE Relay. It keeps no project database.
- **iOS app** (`apps/ios/`). A SwiftUI client that reads the account and talks to connected machines over the sync WebSocket.
- **`ade` CLI**. Typed commands for people and agents, against the same brain.

The primary unit of work is a **lane**: an isolated git worktree with its own chats, sessions and PR. A lane belongs to one machine, and its chats and terminals run there and only there.

## ADE with no computer of your own

ADE Cloud is one machine that every account always has. Underneath, each cloud lane has its own Linux computer that sleeps and wakes. The person never sees these computers: no "Cloud · <lane>" machines and no instance ids, on any surface. See [ADE Cloud](./features/ade-cloud/README.md).

The rules for every tab:

- Every tab shows the person's **connected** computers **plus ADE Cloud, always**. ADE Cloud shows also before the server answers. When the account is out of hours or blocked, it shows read-only with the server's reason.
- An own computer that is **offline is hidden** in Work, Lanes and the welcome page. An **asleep** cloud computer is not offline: its lanes and work stay listed and readable.
- **Reading never wakes a computer.** Everything a person can look at comes from the account or from GitHub:
  - saved chats, CLI sessions, shells (the last 5,000 lines) and subagents of cloud lanes;
  - a Git summary saved when the computer goes to sleep (branch, ahead/behind, changed files);
  - files and history from GitHub at the lane's branch;
  - PRs, issues, branches and checks from GitHub through the account;
  - the CTO account copy, automations, Linear and Jira through the account server, account settings, and usage.
- **Doing wakes the computer** and never blocks the UI. Send, run, open a changed file, a Git action and continue all wake it. The person can leave the screen; the action completes when the computer is up.
- A message to an asleep or deleted cloud chat or CLI goes to a **server queue** (`POST /cloud/chats/:m/:c/messages`, claim and report, `clientSendId`). Closing the tab never loses it.
- When idle cleanup deletes an unused computer, ADE first pushes its work and saves each chat's fork capsule. The next message continues the chat on a new computer **in the same chat row**. Claude, Codex and OpenCode restore their native sessions from the capsule; the other 10 providers replay the saved transcript.
- A lane's chats show a "deleting soon" notice with **Keep it** before idle cleanup. A refused wake (out of hours, too many awake, blocked, deleting, over the plan's disk) shows the server's sentence. A blocked account can still read and export its saved chats.
- Linear events and webhooks wake an asleep computer that has work for them.
- Moving a lane or a chat onto ADE Cloud is not built yet. There is no web push.

**What the account syncs** (to every machine, ADE Cloud included):

- One API key store (`provider_api_key`), shown the same on "This computer" and "ADE Cloud" in Settings › Providers. Qwen on ADE Cloud uses a DashScope API key.
- Passwords and secrets (the vault). Any agent on any computer can use them. A browser can never read a secret value: the push relay allows a browser only the routes that return no secret. Web Passwords says: "Open ADE desktop or the iPhone to see and change Passwords. Agents on every computer, ADE Cloud too, still use them."
- Provider sign-ins, and ADE proxy logins as access-only copies.
- Launch defaults and quick slots.
- Agent limits for ADE Cloud.
- A small account lane index (name, branch, machine, PR number), used only where something else names a lane (PR rows, notifications, CTO messages, search).
- A tip that offers to import a lane's `.env` into ADE secrets.

Personal (no-project) chats stay on their machine. Proof (screenshots, recordings) is never uploaded.

On a cloud computer, Git commits use the account's GitHub noreply identity, else `ADE Cloud <cloud@users.noreply.ade-app.dev>`. ADE never writes over an identity a person set.

---

## Core Concepts

| Concept | Summary | Doc |
| --- | --- | --- |
| ADE account | The person's sign-in. It links every machine, holds ADE Cloud, the vault, account settings and saved cloud work, and lets every client read with no computer awake. | [sync-and-multi-device/README.md](./features/sync-and-multi-device/README.md) |
| ADE Cloud | One machine that every account always has, shown next to the person's own computers. Each cloud lane has its own computer underneath, which the person never sees. | [ade-cloud/README.md](./features/ade-cloud/README.md) |
| Brain | The always-on, machine-owned ADE process for one channel. Hosts every project on its machine; desktop, hosted web, and iOS attach as clients. Installable as a launchd / systemd / Windows login service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role; manual/headless runtimes can exist for isolated commands and tests. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off; used for dev/test work instead of the automated stable/alpha brain service. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Project | A repository. The account keeps the person's projects (`apps/account-directory/src/accountProjects/`), so a project opens with no computer. On a machine, a project is one entry in the brain's project registry, identified by a stable hash of its root path and addressed in the multi-project RPC by `projectId`. | [remote-runtime/README.md](./features/remote-runtime/README.md) |
| Personal chat | Machine-owned general-purpose agent conversation with no project, lane, repository, or PR binding. Stored outside the project registry and reached through runtime-scoped RPC/sync actions. | [personal-chats/README.md](./features/personal-chats/README.md) |
| Passwords | Logins, authenticator codes, passkeys and secrets that agents use but never see: sealed per item, synced to every machine of the account (ADE Cloud too), filled by ADE into the page (`ade browser signin` / `signup`), and given to commands by `ade secrets exec`. A browser never reads a value. | [passwords/README.md](./features/passwords/README.md) |
| Lane | Isolated git worktree with agent and terminal sessions for one task. | [lanes/README.md](./features/lanes/README.md) |
| Stack | GitHub pull requests targeting each other’s branches. | [Pull requests](./features/pull-requests/README.md) |
| Agent | Model-backed operator. The persistent CTO plus ephemeral lane-bound and personal chat agents. | [agents/README.md](./features/agents/README.md) |
| Worktree | Git clone dir under `.ade/worktrees/<lane-id>/`, one per lane. | [lanes/worktree-isolation.md](./features/lanes/worktree-isolation.md) |
| Lane runtime | Per-lane env initialization, ports, proxy, OAuth routing, and diagnostics. | [lanes/runtime.md](./features/lanes/runtime.md) |
| Lane share | Limited access to one lane for another ADE account, enforced by the machine that holds the lane. | [lanes/lane-sharing.md](./features/lanes/lane-sharing.md) |
| Session | PTY-backed terminal session pinned to a lane. | [terminals-and-sessions/README.md](./features/terminals-and-sessions/README.md) |
| Proof | Normalized computer-use artifact (screenshot, recording, network log). | [computer-use/artifact-broker.md](./features/computer-use/artifact-broker.md) |

## Glossary

| Term | Meaning |
| --- | --- |
| Brain | The always-on, machine-owned ADE process for one channel. It carries the local RPC endpoint, sync websocket, project catalog, pairing authority, and executor authority. Some existing code/protocol fields still say `host` or `brain_*`. |
| Runtime | ADE execution machinery: processes/services that open DBs and run agents, PTYs, git, and orchestration. A runtime process can host the brain role, but "brain" names authority/lifecycle, not a category of launchable runtimes. |
| Manual runtime | A foreground runtime process started explicitly with `ade runtime run --socket <path>`. Sync is always off so it cannot claim brain authority; use a separate `ADE_HOME` when you also want full machine-state isolation. |
| Machine | A computer with a stable per-channel ADE identity and project catalog: one of the person's own computers, or ADE Cloud (one machine in every list, with one computer per cloud lane underneath). |
| ADE Cloud | The machine every account always has (id `__ade_cloud__`, `apps/desktop/src/shared/adeCloudMachine.ts`). Picking it in "Run on" starts a new cloud lane. |
| Cloud lane computer | The Linux computer behind one cloud lane. It sleeps when idle, wakes to do work, and idle cleanup deletes it after a warning. The person never sees it as a machine. |
| Asleep | A cloud computer that is not running. It is not offline: its lanes and saved work stay listed and readable. |
| Wake | Starting an asleep cloud computer to do work (send, run, open a changed file, a Git action). Reading never wakes. |
| Server queue | The account server's store of messages for an asleep or deleted cloud chat or CLI. The computer claims each message once when it wakes. |
| Account lane index | Name, branch, machine and PR number of each lane, kept in the account so mentions of a lane show its real name. It does not fill the Lanes tab. |
| Channel | A build lane: stable, alpha, or dev. Each channel isolates state under its own ADE home. Beta is an update track of stable, not a channel; it shares `~/.ade`. |
| ADE home | The machine state root for a channel (`~/.ade`, `~/.ade-alpha`, or a dev override). Holds project catalog, secrets, runtime resources, and endpoints. |
| Remote runtime | A runtime reached over SSH by a desktop window through `ade rpc --stdio`; the remote machine's brain is authoritative for its projects. |
| Desktop bridge | Narrow Electron-main side channel for services that require real Electron UI APIs, such as ADE Browser. |
| Sync service | Brain-owned WebSocket + cr-sqlite service that pairs controllers, replicates ADE DB state, routes mobile commands, and manages phone PIN pairing. |
| Client | A UI or CLI surface that reads the account and attaches to ADE brains: desktop, hosted web, iOS, the `ade` CLI, or an SSH-attached desktop window. |
| Controller | A client that reads state and sends commands without running agents itself; the web client and the iOS app are always controllers. |
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

- [**ADE Cloud**](./features/ade-cloud/README.md) — The one machine every account always has. One computer per cloud lane underneath, sleep and wake, saved copies at rest, the server message queue, fork-continue after idle cleanup, plans and hours, and the server routes.
- [**Remote Runtime**](./features/remote-runtime/README.md) — Remote access to an ADE runtime. Multi-project registry, machine endpoint, login-service install, SSH bootstrap of the cross-platform `ade-<platform-arch>` runtime binaries shipped under `apps/desktop/resources/runtime/`. A remote machine's brain is authoritative for its projects.
- [**ADE MCP**](./features/ade-mcp/README.md) — Each computer as an MCP server for AI apps the person picks (claude.ai, ChatGPT, Cursor, Claude Code, Grok), reached through ADE Relay. One `ade` tool that runs the real CLI; off by default; per-app read-only or full access; sign-in with the ADE account or a bearer token; Settings → App → ADE MCP and `ade mcp`.
- [**Web Client**](./features/web-client/README.md) — The full ADE in a browser, with or without a computer of your own. Static Cloudflare Pages SPA, ADE account sign-in, every connected machine plus ADE Cloud, reads from the account and GitHub, DPoP-bound relay transport to connected machines, no local DB.

### Work execution

- [**Lanes**](./features/lanes/README.md) — Worktree isolation, where new lanes start, catching up with the base, lane runtime, OAuth redirect, diagnostics. Each lane is a sandbox on its own branch. Lane runtime covers ports, env initialization, proxy routing, and health checks. [Lane sharing](./features/lanes/lane-sharing.md) gives another ADE account limited access to one lane.
- [**Pull Requests**](./features/pull-requests/README.md) — GitHub PRs for lanes: list, detail, checks, reviews, GitHub stacks, and merging. Backed by lanes.
- [**Conflicts**](./features/conflicts/README.md) — Pre-flight detection (full pairwise matrix up to 15 lanes, prefilter above), live simulation via `git merge-tree`, AI-assisted resolution proposals.
### Agents and chat

- [**Agents**](./features/agents/README.md) — Two surfaces: lane-bound chat and the persistent CTO operator. Identity, capability modes, tool tiers, and the CTO memory system.
- [**Chat**](./features/chat/README.md) — Multi-provider, streaming, tool-aware. Transcript and turns, compact web/MCP/image/subagent activity, Codex Sources and stalled-turn recovery, scenes (agent-authored generated UI, sandboxed to its own origin and frozen to a picture when its turn ends), tool system (universal/workflow/coordinator), agent routing, composer + derived panels, parallel multi-model lane launch, and [cross-machine Work chat handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md).
- [**Personal Chats**](./features/personal-chats/README.md) — General-purpose, machine-owned AI conversations with the same model catalog but no project, lane, Git, or PR binding. Available from desktop, hosted web, mobile Hub, and the ADE CLI.
- [**ADE SDK**](./features/sdk/README.md) — Embeddable chat sidecar (`@ade-dev/sdk`, `@ade-dev/chat-ui`) that spawns an isolated ADE runtime as a guest of a third-party app. Strict MCP isolation is Claude-only as a guarantee; `mcpCapability` is the honesty report. Public docs: [ade-app.dev/docs/sdk](https://ade-app.dev/docs/sdk/overview).
- [**History**](./features/history/README.md) — Two surfaces sharing one page: a GitKraken-style commit graph for the focused lane (per-commit branch/lane/tag/cherry-pick/revert/reset and lane-level head-change undo+redo), and a unified activity feed that merges operations with chat sessions. Every recorded service follows the same `runTrackedOperation` pattern.

### Automation and CTO

- [**Automations**](./features/automations/README.md) — Rule triggers (time, action, webhook) → agent-session and built-in execution surfaces. Confidence + verification + human review.
- [**CTO**](./features/cto/README.md) — Persistent project-level AI operator: one chat session that never rotates, a small memory of project notes, notes about the person and open work, a disposable provider thread that ADE refreshes instead of rotating, fallback models, a character you can shape, a page built around a profile panel, and a light Linear read/write surface. Voice starts from the doctrine; the personality setting only adjusts tone.
- [**Capture gesture**](./features/capture-gesture/README.md) — Both ⌘ keys on macOS, both Ctrl keys on Windows, anywhere on the OS: the window in front is captured by a supervised native helper and handed to the CTO, staged on the CTO composer. Over ADE's own window the shot travels with a note describing what ADE was showing. Desktop-only by construction; Linux ships nothing.

### Workspace surfaces

- [**Terminals and Sessions**](./features/terminals-and-sessions/README.md) — PTY and session services. Canonical cross-client session lifecycle, two-tier attention, the quiet settled tier, agent-authored status notes, AI titles, lazy resume-target hydration, and stale reconciliation.
- [**Files and Editor**](./features/files-and-editor/README.md) — Atomic writes, ref-counted file watcher, file search index, Monaco surfaces (edit/diff/conflict), preload trust boundary.
- [**Universal Search**](./features/search/README.md) — One deterministic FTS5 index per project (disposable `.ade/cache/search-index.db`) over chat/terminal/PR/commit/branch text, unioned at query time with delegated lanes/files/artifacts/Linear. The machine router keeps non-chat kinds in the active project and aggregates bounded, explicitly truncated chat hits across every registered project. Debounced off-hot-path ingestion, deterministic ranking tiers, one `search` action domain behind ⌘K and `ade search`.
- [**Onboarding and Settings**](./features/onboarding-and-settings/README.md) — Required account access, project open/create landing on Work, 10-tab settings, and the machine-local configuration schema with no repository trust gate.

### Integrations

- [**Issues**](./features/issues/README.md) — Linear and GitHub issues opened where you are (the Work tools pane's Issues tab or a floating sheet), edited in place, and created from one composer; a GitHub Issues top-bar pane; lanes and agents started from an issue; `ade linear` and `ade github issue` for agents.
- [**Linear Integration**](./features/linear-integration/README.md) — Issue read/search, lane/commit/PR attachment flow, batch launch, session-scoped attachment, and an optional live-status round-trip.
- [**Computer Use**](./features/computer-use/README.md) — Direct signed Codex Computer Use, intentional proof capture, and active App Control. Canonical artifact model, ownership-linked storage.
- [**Mac Desktop**](./features/mac-desktop/README.md) — A private macOS screen per lane. ADE creates a virtual display, parks the lane's windows on it, and drives them through the Accessibility API, so the user's real display and pointer stay untouched. macOS-only on the runtime host; Windows, web, and phone clients still see it for a Mac-hosted lane, and can watch, take the input lease, and (from the phone's Off card, or from the web client) start the display. Driven by `ade mac-desktop` (`ade desktop` remains the app launcher) and a bundled native driver; global pointer/keyboard input sits behind a per-chat lease, and screenshots/recordings reach the proof drawer through the existing computer-use broker as the `ade-mac-desktop` backend.
- [**Windows Desktop**](./features/windows-desktop/README.md) — The same per-lane screen on a Windows runtime host, sharing the Mac Desktop service, lease, proof and streaming. The default seat is a private Remote Desktop child session of the user's own account (its own pointer and keyboard; one lane holds it at a time, after a one-time setup the user does). The shared seat is the user's main desktop, started only when the user taps Allow on a card in the chat. Driven by `ade screen` (`ade windows-desktop` and `ade mac-desktop` are aliases) and the bundled `ade-desktop-driver.exe`.
- [**Apple Development**](./features/apple-device/README.md) — macOS-only control of a per-lane Apple simulator from `ade apple` and the Work tab's Apple Development tool. A vendored helper streams the device framebuffer (no Screen Recording grant, no Simulator window). Agents launch in the background from the lane worktree. Beyond launching: clone-or-attach devices, `simctl`-backed device tools, recordings with an auto-record contract, element queries, proof bundles, and ADEInspector source-anchored chat context.
- [**Android Development**](./features/android-device/README.md) — A per-lane Android emulator from `ade android` and the Work tab's Android Development tool, on macOS, Windows or Linux with the Android SDK. Emulators only, stock Android. The brain boots the AVD headless and streams it through a bundled scrcpy server; agents create, attach, start, stop, tap, swipe, type, rotate and screenshot, on this machine or on another one with `--machine`. P0 is built; the [plan](./plans/android-emulator.md) has the later phases.
- [**Sync and Multi-Device**](./features/sync-and-multi-device/README.md) — cr-sqlite CRDT (desktop native ext, iOS pure-SQL emulation), host/controller model, WebSocket envelope, remote commands, the [cross-machine session handoff contract](./features/sync-and-multi-device/cross-machine-session-handoff.md), and [Activity](./features/sync-and-multi-device/push-notifications.md): one account-wide source of truth across desktop, web, iOS, notifications, widgets, Live Activities, and the native Mac presentation.

---

## Cross-Cutting Architecture

For the system-wide picture — brain role, runtime machinery, clients, data plane, IPC, security, build/test/deploy — read [**ARCHITECTURE.md**](./ARCHITECTURE.md).

Quick pointers:

- **ADE brain and execution machinery**: `apps/ade-cli/` — the brain is the per-machine source of truth for projects, lanes, agent chats, work sessions, sync, and proof. Execution services inside that process do the work. Endpoint: `$ADE_HOME/sock/ade.sock`. Login-service installers: `apps/ade-cli/src/serviceManager/installLaunchd.ts` (macOS), `installSystemd.ts` (Linux), `installWindows.ts` (Windows). Multi-project RPC: `apps/ade-cli/src/multiProjectRpcServer.ts`. Project registry/scope: `apps/ade-cli/src/services/projects/`. Sync service: `apps/ade-cli/src/services/sync/`. Credentials, agent registry, service surfaces: `apps/ade-cli/src/services/`.
- **Desktop client**: `apps/desktop/` — Electron main + preload + renderer. Multi-window. `LocalRuntimeConnectionPool` (`apps/desktop/src/main/services/localRuntime/`) speaks to the local runtime; `RemoteConnectionPool` (`apps/desktop/src/main/services/remoteRuntime/`) speaks to a runtime over SSH after `bootstrapRemoteRuntime` uploads the bundled `ade-<platform-arch>` binary. `preload.ts` routes runtime-backed APIs through those pools. In-process desktop services remain only for flows that have no runtime binding yet, Electron-only side effects, diagnostics, and tests.
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
4. **Detail docs** — when you need depth on a specific area (e.g., `features/cto/README.md` for the CTO memory system internals).

The source of truth is always the code. Docs may lag on specific code paths — cross-check `git log` and the referenced files when in doubt.

Fragile areas flagged across the docs (read docs before editing):
- Multi-project RPC + project scope/registry (`apps/ade-cli/src/multiProjectRpcServer.ts`, `services/projects/`) — every runtime call lives or dies here; getting `projectId` routing wrong silently corrupts cross-project state.
- Local vs. remote runtime pools (`apps/desktop/src/main/services/localRuntime/`, `remoteRuntime/`) — desktop binding switching, SSH bootstrap upload, version negotiation against bundled `ade-<platform-arch>` binaries.
- Sync service inside the ADE runtime (`apps/ade-cli/src/services/sync/`) — desktop's old in-process sync host is disabled by default and only re-enabled with `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics; do not assume desktop owns sync.
- Multi-window shell + `app/navigate` JSON-RPC handoff (desktop main `main.ts`, runtime side in `apps/ade-cli/src/adeRpcServer.ts`) — external controllers can drive desktop window navigation.
- CTO continuity — one ADE session forever with a disposable provider thread. The refresh is `refreshCtoProviderThread` (occupancy, compaction, overflow, model fallback, manual); notes, open work and live state are injected every turn; older CTO sessions are read back with `readHistory`.
- PTY / session services.
- ADE Cloud reads and wakes (`apps/desktop/src/renderer/state/adeCloudRestingReads.ts`, `apps/desktop/src/main/services/adeCloud/cloudSleep.ts`, `apps/account-directory/src/cloud/`) — a read that wakes a computer costs the person hours; keep reads on the account.
- OAuth redirect service — complex three-state machine with HMAC signing.
- Chat transcript render pipeline — two-layer event→state→render path.

---

## Out of scope (deliberate non-goals)

- ADE does not run OS-level accessibility UI control itself. It is a control plane for those executors; ADE Browser automation is limited to ADE's built-in project browser.
- ADE does not host remote git servers. It operates on local worktrees against a GitHub remote.
- ADE does not multiplex multiple users. One account is one person; [lane sharing](./features/lanes/lane-sharing.md) gives another account limited access to one lane.
- ADE's servers do not run agents. They hold account data and saved copies; agents run on the person's computers and on cloud lane computers. `apps/web/` is the marketing and docs site.
- ADE Cloud lanes support GitHub repositories only. Other Git hosts work on your own computers.

# ADE — Product Requirements

ADE is a development system for AI-assisted software engineering. It runs 13 coding-agent providers against parallel git worktrees ("lanes"), with chat, terminals, Git, pull requests, a persistent CTO agent, automations and proof in one app. The desktop app, the hosted web client (`app.ade-app.dev`), the iPhone app and the `ade` CLI are its clients.

**ADE works fully with no computer of your own.** Every signed-in account always has one machine, **ADE Cloud**. It shows in every machine list and every "Run on" menu, on the web, the iPhone and the desktop, next to the person's own computers. Like Cursor, a person signs up, connects GitHub, picks a repository and works, with or without a Mac of their own. A person with no computer gets every tab and every flow, in the same UI as a person with three Macs.

This doc is the entry point. Every feature links to its doc in [`features/`](./features/). Read [ARCHITECTURE.md](./ARCHITECTURE.md) next for how the pieces fit.

## What ADE Is

ADE has three layers:

1. **Machines.** A machine is a computer with an ADE **brain**: the always-on ADE process for one channel (`apps/ade-cli/`). The brain owns projects, lanes, agent chats, work sessions, the CTO, automations, PR actions, proof and the sync service. A machine is one of the person's own computers (macOS, Windows, Linux), or ADE Cloud.
2. **The account.** ADE's account servers (Cloudflare Workers: `apps/account-directory/`, `apps/push-relay/`, `apps/tunnel-relay/`, `apps/webhook-relay/`) hold what must be readable when no computer is awake: the machine list, ADE Cloud, saved copies of cloud work, account settings, the encrypted vault, Activity, and the GitHub, Linear and Jira sign-ins.
3. **Clients.** The clients show the account and every connected machine at once. They run no agents.
   - **Electron desktop** (`apps/desktop/`): multi-window. A window attaches to this computer's brain (`LocalRuntimeConnectionPool`) or to another machine over the paired channel (LAN, then tailnet, then ADE Relay) or SSH (`RemoteConnectionPool`, `ade rpc --stdio`).
   - **Hosted web client** (`apps/desktop/src/renderer/webclient/`): a static page built from the desktop renderer. It reads the account and talks to connected machines over ADE Relay. It keeps no project database.
   - **iOS app** (`apps/ios/`): a SwiftUI client that reads the account and talks to connected machines over the sync WebSocket.
   - **`ade` CLI**: typed commands for people and agents, against the same brain.

The unit of work is a **lane**: an isolated git worktree with its own chats, sessions and PR. A lane belongs to one machine, and its chats and terminals run there and only there.

## ADE with no computer of your own

ADE Cloud is one machine that every account always has. Underneath, each cloud lane has its own Linux computer that sleeps and wakes. The person never sees these computers: no "Cloud · <lane>" machines and no instance ids, on any surface. See [ADE Cloud](./features/ade-cloud/README.md).

The rules for every tab:

- Every tab shows the person's **connected** computers **plus ADE Cloud, always**, also before the server answers. When the account is out of hours or blocked, ADE Cloud shows read-only with the server's reason.
- An own computer that is **offline is hidden** in Work, Lanes and the welcome page. An **asleep** cloud computer is not offline: its lanes and work stay listed and readable.
- **Reading never wakes a computer.** Everything a person can look at comes from the account or from GitHub:
  - saved chats, CLI sessions, shells (the last 5,000 lines) and subagents of cloud lanes;
  - a Git summary saved when the computer goes to sleep (branch, ahead/behind, changed files);
  - files, history, PRs, issues, branches and checks from GitHub;
  - the CTO account copy, automations, Linear and Jira through the account server, account settings, and usage.
- **Doing wakes the computer** and never blocks the UI: send, run, open a changed file, a Git action, continue. The action completes when the computer is up, also if the person leaves the screen.
- A message to an asleep or deleted cloud chat or CLI goes to a **server queue** (`POST /cloud/chats/:m/:c/messages`, claim and report, `clientSendId`). Closing the tab never loses it.
- Before idle cleanup deletes an unused computer, ADE pushes its work and saves each chat's fork capsule. The next message continues the chat on a new computer **in the same chat row**. Claude, Codex and OpenCode restore their native sessions; the other 10 providers replay the saved transcript.
- A lane's chats show a "deleting soon" notice with **Keep it**. A refused wake (out of hours, too many awake, blocked, deleting, over the disk of the plan) shows the server's sentence. A blocked account can still read and export its saved chats.
- Linear events and webhooks wake an asleep computer that has work for them.
- Moving a lane or a chat onto ADE Cloud is not built yet. There is no web push.

**What the account syncs** (to every machine, ADE Cloud included):

- One API key store (`provider_api_key`), shown the same for "This computer" and "ADE Cloud" in Settings › Providers. Qwen on ADE Cloud uses a DashScope API key.
- Passwords and secrets (the vault). Any agent on any computer can use them. A browser never reads a secret value. Web Passwords says: "Open ADE desktop or the iPhone to see and change Passwords. Agents on every computer, ADE Cloud too, still use them."
- Provider sign-ins, and ADE proxy logins as access-only copies.
- Launch defaults, quick slots and the agent limits for ADE Cloud.
- A small account lane index (name, branch, machine, PR number), used only where something else names a lane (PR rows, notifications, CTO messages, search).
- A tip that offers to import a lane's `.env` into ADE secrets.

Personal (no-project) chats stay on their machine. Proof (screenshots, recordings) is never uploaded. On a cloud computer, Git commits use the account's GitHub noreply identity, else `ADE Cloud <cloud@users.noreply.ade-app.dev>`; ADE never writes over an identity a person set.

## Concepts

| Term | Meaning | Doc |
| --- | --- | --- |
| ADE account | The person's sign-in. It links every machine, holds ADE Cloud, the vault, account settings and saved cloud work, and lets every client read with no computer awake. | [sync-and-multi-device](./features/sync-and-multi-device/README.md) |
| ADE Cloud | The machine every account always has (id `__ade_cloud__`, `shared/adeCloudMachine.ts`). Picking it in "Run on" starts a new cloud lane. | [ade-cloud](./features/ade-cloud/README.md) |
| Cloud lane computer | The Linux computer behind one cloud lane. It sleeps when idle, wakes to do work, and idle cleanup deletes it after a warning. The person never sees it as a machine. | [ade-cloud](./features/ade-cloud/README.md) |
| Asleep / wake | An asleep cloud computer is not running but is not offline. Doing (send, run, open a changed file, Git) wakes it; reading never does. | [ade-cloud](./features/ade-cloud/README.md) |
| Server queue | The account server's store of messages for an asleep or deleted cloud chat or CLI. The computer claims each message once when it wakes. | [ade-cloud](./features/ade-cloud/README.md) |
| Account lane index | Name, branch, machine and PR number of each lane, so mentions of a lane show its real name. It does not fill the Lanes tab. | [ade-cloud](./features/ade-cloud/README.md) |
| Machine | A computer with a stable per-channel ADE identity and project catalog: an own computer, or ADE Cloud. | [sync-and-multi-device](./features/sync-and-multi-device/README.md) |
| Brain | The always-on ADE process of a machine for one channel: the RPC endpoint, sync WebSocket, project catalog, pairing and executor authority. A launchd / systemd / Windows login service. Some fields still say `host` or `brain_*`. | [remote-runtime](./features/remote-runtime/README.md) |
| Runtime | The machinery that opens DBs and runs agents, PTYs and git. A runtime process can hold the brain role. A manual runtime (`ade runtime run --socket <path>`) has sync off, so it never claims brain authority. | [remote-runtime](./features/remote-runtime/README.md) |
| Channel / ADE home | A build channel (stable, alpha, dev) with its own state root (`~/.ade`, `~/.ade-alpha`, or a dev override). Beta is an update track of stable and shares `~/.ade`. | [remote-runtime](./features/remote-runtime/README.md) |
| Client / controller | A surface that reads the account and attaches to brains. The web client and the iOS app are always controllers: they send commands and run no agents. | [sync-and-multi-device](./features/sync-and-multi-device/README.md) |
| Sync service | The brain's WebSocket + cr-sqlite service: pairing, DB replication (CRR), remote commands, phone PIN pairing. | [sync-and-multi-device](./features/sync-and-multi-device/README.md) |
| Remote target | A saved SSH machine that hosts a remote runtime; its brain is authoritative for its projects. | [remote-runtime](./features/remote-runtime/README.md) |
| Desktop bridge | The narrow Electron-main channel for services that need Electron UI APIs, such as ADE Browser. | [ARCHITECTURE §2.1](./ARCHITECTURE.md) |
| Project | A repository. The account keeps the person's projects (`apps/account-directory/src/accountProjects/`), so a project opens with no computer. On a machine, the registry (`$ADE_HOME/projects.json`) maps its root to a stable `projectId`. | [remote-runtime](./features/remote-runtime/README.md) |
| Lane / worktree | A task-scoped git worktree (under `.ade/worktrees/<lane-id>/`) with its own chats, sessions and PR. | [lanes](./features/lanes/README.md) |
| Lane runtime | Per-lane env, ports, proxy, OAuth routing and diagnostics. | [lanes/runtime.md](./features/lanes/runtime.md) |
| Lane share | Limited access to one lane for another ADE account, enforced by the machine that holds the lane. | [lanes/lane-sharing.md](./features/lanes/lane-sharing.md) |
| Stack | GitHub pull requests that target each other's branches. | [pull-requests](./features/pull-requests/README.md) |
| Work session | A tracked chat, agent CLI, shell or PTY session. Its lifecycle tells apart working, "your move", "Needs you", failed, ended and settled; settled sessions stay openable. | [terminals-and-sessions](./features/terminals-and-sessions/README.md) |
| Agent chat | A structured chat with any of the 13 providers that calls ADE tools, streams events and attaches to a lane. | [chat](./features/chat/README.md) |
| Personal chat | An agent chat with `surface: "personal"`: owned by the machine, with no project, lane, Git or PR. | [personal-chats](./features/personal-chats/README.md) |
| CTO | The persistent project-level agent with durable memory. | [cto](./features/cto/README.md) |
| Passwords | Logins, authenticator codes, passkeys and secrets that agents use but never see: sealed per item, synced to every machine of the account, filled by ADE into the page, given to commands by `ade secrets exec`. | [passwords](./features/passwords/README.md) |
| Proof | A normalized artifact that proves UI or workflow execution: screenshot, recording, trace or log. | [computer-use/artifact-broker.md](./features/computer-use/artifact-broker.md) |

## Feature Index

### Brain, runtime, and clients

- [**ADE Cloud**](./features/ade-cloud/README.md) — The one machine every account always has: a computer per cloud lane, sleep and wake, saved copies at rest, the server queue, fork-continue after idle cleanup, plans and hours, server routes.
- [**Remote Runtime**](./features/remote-runtime/README.md) — The multi-project brain, the machine endpoint, login-service install, and SSH bootstrap of the `ade-<platform-arch>` runtime binaries.
- [**ADE MCP**](./features/ade-mcp/README.md) — Each computer as an MCP server for AI apps the person picks, through ADE Relay. One `ade` tool; off by default; read-only or full access per app.
- [**Web Client**](./features/web-client/README.md) — The full ADE in a browser, with or without a computer of your own. Account sign-in, every connected machine plus ADE Cloud, reads from the account and GitHub, DPoP-bound relay transport, no local DB.

### Work execution

- [**Lanes**](./features/lanes/README.md) — Worktree isolation, where new lanes start, catching up with the base, lane runtime, OAuth redirect, diagnostics, and [lane sharing](./features/lanes/lane-sharing.md).
- [**Pull Requests**](./features/pull-requests/README.md) — GitHub PRs for lanes: list, detail, checks, reviews, stacks and merging.
- [**Conflicts**](./features/conflicts/README.md) — Pairwise pre-flight detection, `git merge-tree` simulation, AI-assisted resolution proposals.

### Agents and chat

- [**Agents**](./features/agents/README.md) — Lane-bound chat agents and the CTO: identity, capability modes, tool tiers, memory.
- [**Chat**](./features/chat/README.md) — Multi-provider streaming chat: transcript and turns, tool activity, stalled-turn recovery, scenes, agent routing, the composer, parallel multi-model launch, and [cross-machine handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md).
- [**Personal Chats**](./features/personal-chats/README.md) — Machine-owned chats with no project, lane, Git or PR, on desktop, web, phone and the CLI.
- [**ADE SDK**](./features/sdk/README.md) — An embeddable chat sidecar (`@ade-dev/sdk`, `@ade-dev/chat-ui`) that runs an isolated ADE runtime inside another app. Public docs: [ade-app.dev/docs/sdk](https://ade-app.dev/docs/sdk/overview).
- [**History**](./features/history/README.md) — The commit graph of the focused lane with undo and redo, and an activity feed of operations and chat sessions (`runTrackedOperation`).

### Automation and CTO

- [**Automations**](./features/automations/README.md) — Rule triggers (time, action, webhook) that start agent sessions or built-in actions, with verification and human review.
- [**CTO**](./features/cto/README.md) — The persistent project-level operator: one session that never rotates, a disposable provider thread, notes, open work, fallback models, a shapeable character, and a light Linear surface.
- [**Capture gesture**](./features/capture-gesture/README.md) — Both ⌘ keys (macOS) or both Ctrl keys (Windows) capture the window in front and stage it on the CTO composer. Desktop only.

### Workspace surfaces

- [**Terminals and Sessions**](./features/terminals-and-sessions/README.md) — PTY and session services, the shared session lifecycle, attention tiers, status notes, AI titles.
- [**Files and Editor**](./features/files-and-editor/README.md) — Atomic writes, the ref-counted file watcher, the file search index, Monaco edit/diff/conflict views.
- [**Universal Search**](./features/search/README.md) — One FTS5 index per project over chat, terminal, PR, commit and branch text, joined at query time with lanes, files, artifacts and Linear; chat hits from every project. Behind ⌘K and `ade search`.
- [**Onboarding and Settings**](./features/onboarding-and-settings/README.md) — Required account access, project open and create, the settings tabs, and the machine-local configuration with no repository trust gate.

### Integrations

- [**Issues**](./features/issues/README.md) — Linear and GitHub issues opened, edited and created where you are; lanes and agents started from an issue; `ade linear` and `ade github issue`.
- [**Linear Integration**](./features/linear-integration/README.md) — Issue read and search, lane/commit/PR attachment, batch launch, live status.
- [**Computer Use**](./features/computer-use/README.md) — Signed Codex Computer Use, intentional proof capture, App Control, and the artifact model.
- [**Mac Desktop**](./features/mac-desktop/README.md) — A private macOS virtual display per lane, driven through the Accessibility API behind a per-chat input lease (`ade mac-desktop`). Other clients can watch a Mac-hosted lane's screen.
- [**Windows Desktop**](./features/windows-desktop/README.md) — The same per-lane screen on a Windows host: a private Remote Desktop child session, or the main desktop after the user taps Allow (`ade screen`).
- [**Apple Development**](./features/apple-device/README.md) — A per-lane Apple simulator on macOS from `ade apple` and the Work tab, streamed by a vendored helper; device tools, recordings, element queries, proof.
- [**Android Development**](./features/android-device/README.md) — A per-lane Android emulator on macOS, Windows or Linux from `ade android` and the Work tab, streamed through scrcpy. The [plan](./plans/android-emulator.md) holds the open items.
- [**Sync and Multi-Device**](./features/sync-and-multi-device/README.md) — cr-sqlite CRDT, the host/controller model, the WebSocket envelope, remote commands, [cross-machine handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md), and [Activity](./features/sync-and-multi-device/push-notifications.md) across desktop, web, iOS, notifications and widgets.

## For AI Agents Reading This

Read in this order:

1. This PRD: product scope and the feature index.
2. [ARCHITECTURE.md](./ARCHITECTURE.md): how the apps fit, where state lives, the IPC contract, the services catalog.
3. The feature READMEs for your task. Each one starts with a source file map.

The code is the source of truth. When a doc and the code disagree, the code wins.

Fragile areas (read the docs before you edit):

- Multi-project RPC and the project registry (`apps/ade-cli/src/multiProjectRpcServer.ts`, `services/projects/`). Wrong `projectId` routing corrupts cross-project state with no error.
- Local and remote runtime pools (`apps/desktop/src/main/services/localRuntime/`, `remoteRuntime/`): binding switches, SSH bootstrap, version negotiation.
- The sync service lives in the brain (`apps/ade-cli/src/services/sync/`). The desktop's in-process sync host is off unless `ADE_ENABLE_DESKTOP_SYNC_HOST=1`.
- The multi-window shell and the `app/navigate` handoff (`main.ts`, `apps/ade-cli/src/adeRpcServer.ts`): external controllers can drive desktop navigation.
- CTO continuity: one ADE session with a disposable provider thread (`refreshCtoProviderThread`); older sessions come back through `readHistory`.
- ADE Cloud reads and wakes (`renderer/state/adeCloudRestingReads.ts`, `main/services/adeCloud/cloudSleep.ts`, `apps/account-directory/src/cloud/`). A read that wakes a computer costs the person hours; keep reads on the account.
- PTY and session services, the OAuth redirect service (a three-state machine with HMAC signing), and the chat transcript render pipeline (event → state → render).

## Out of scope (deliberate non-goals)

- ADE does not host git servers. It works on local worktrees against a GitHub remote.
- ADE does not multiplex users. One account is one person; [lane sharing](./features/lanes/lane-sharing.md) gives another account limited access to one lane.
- ADE's servers do not run agents. They hold account data and saved copies; agents run on the person's computers and on cloud lane computers. `apps/web/` is the marketing and docs site.
- ADE Cloud lanes support GitHub repositories only. Other Git hosts work on your own computers.

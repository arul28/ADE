# ADE Architecture Reference

Consolidated technical reference for the ADE (Agentic Development Environment) system. This document is the entry point for engineers and AI agents who need to understand the shape of the system before reading feature-specific docs. Deeper subsystem docs live under `docs/features/`.

---

## 1. System at a Glance

ADE is a local-first development control plane that orchestrates AI-assisted software engineering across parallel worktrees and also hosts projectless personal chats. The center of the system is the **ADE brain**: the always-on, machine-owned ADE process for one channel. The brain hosts every project on that machine through a project registry, owns a separate machine-level personal-chat scope, exposes both through one JSON-RPC surface on the channel's local endpoint, serves the sync websocket for ADE Mobile, and carries executor authority. Desktop, the terminal `ade code` client, the iOS app, hosted web, and SSH-attached desktop windows are all **clients** that attach to a local brain or remote runtime transport and invoke runtime-owned actions through that one surface.

The brain owns everything that needs to survive a client closing: worktree-per-lane git isolation, project and personal multi-provider agent chat, work-session orchestration, a persistent CTO agent with durable memory and a Linear read/write surface, rule-based automations, stacked pull requests with conflict simulation, computer-use proofs, the sync service that replicates projects to other devices, and the per-machine credential store and agent registry. Nothing leaves the user's machine by default: AI work runs through user-authenticated CLIs (Claude Code, Codex), local API-key routes (OpenCode server), or local model endpoints (Ollama, LM Studio, vLLM).

ADE ships as one computer install, ADE Mobile, and the marketing site:

### Brain and runtime topology

```mermaid
flowchart TB
  subgraph LocalMachine["One ADE computer install, one channel"]
    Desktop["Electron desktop app<br/>apps/desktop"]
    Code["ADE Code TUI<br/>ade code"]
    Shell["ade CLI<br/>typed commands"]
    Brain["ADE brain<br/>always-on runtime process<br/>$ADE_HOME/sock/ade.sock"]
    Bridge["Desktop bridge<br/>~/.ade/sock/desktop-bridge.sock"]
  end

  Desktop -->|"local RPC attach"| Brain
  Code -->|"local RPC attach"| Brain
  Shell -->|"local RPC attach"| Brain
  Brain -->|"Electron-only actions"| Bridge
  Bridge -->|"WebContentsView, screenshots, browser state"| Desktop

  subgraph ProjectState["Project .ade state"]
    Database[".ade/ade.db<br/>SQLite + cr-sqlite"]
    Lanes[".ade/worktrees/*<br/>lane worktrees"]
    Artifacts[".ade/artifacts + cache<br/>proof, transcripts, packs"]
  end

  Personal["$ADE_HOME/personal-chats<br/>hidden state + scratch workspace"]

  Brain --> Database
  Brain --> Lanes
  Brain --> Artifacts
  Brain --> Personal

  IOS["ADE Mobile<br/>controller client"] <-->|"machine pairing + sync WebSocket<br/>catalog, changesets, commands"| Brain

  DesktopRemote["Desktop / ADE Code<br/>paired or SSH client"] <-->|"paired RPC WebSocket<br/>or ade rpc --stdio"| RemoteRuntime["Remote ADE brain / runtime<br/>machine project registry"]
  RemoteRuntime --> RemoteProject["Remote project .ade state"]
```

```
                              ┌───────────────────────────────┐
                              │ apps/web (marketing + DL page)│
                              └───────────────────────────────┘

                ┌───────────────────────────────────────────────┐
                │        apps/ade-cli (BRAIN + RUNTIME)         │
                │  ─────────────────────────────────────────────│
                │  ADE brain process                             │
                │   - always-on runtime for one channel          │
                │   - listens on $ADE_HOME/sock/ade.sock         │
                │   - login service (launchd / systemd / Win)    │
                │   - machine RPC + project registry             │
                │   - hidden projectless personal-chat scope     │
                │   - sync service (cr-sqlite over WebSocket)    │
                │   - credential store, agent registry           │
                │   - dispatches CLI runtimes:                   │
                │       claude · codex · opencode · cursor       │
                │   - SQLite + cr-sqlite per project (.ade/ade.db)│
                │  ─────────────────────────────────────────────│
                │  Also exposes:                                 │
                │   - `ade rpc --stdio` single-session over SSH  │
                │   - `ade <command>` typed CLI surface          │
                │   - `ade code` terminal Work client (Ink+React)│
                └───────────────────────────────────────────────┘
                  ▲              ▲              ▲             ▲
                  │ local        │ local        │ WebSocket   │ paired WS
                  │ local RPC    │ local RPC    │             │ or SSH stdio
                  │              │              │             │
        ┌──────────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
        │ apps/desktop     │ │ ade code TUI │ │ apps/ios │ │ apps/desktop     │
        │ (Electron, multi-│ │ (apps/ade-cli│ │ SwiftUI  │ │ window bound to a│
        │ window — project │ │  /tuiClient) │ │ controller│ │ remote brain     │
        │ or machine chat) │ │              │ │ (never   │ │ (RemoteConnection│
        │ LocalRuntime-    │ │ defaults to  │ │ runs     │ │ Pool, bootstrap- │
        │ ConnectionPool   │ │ machine brain│ │ agents)  │ │ uploads bundled  │
        │                  │ │              │ │          │ │ runtime binary)  │
        └──────────────────┘ └──────────────┘ └──────────┘ └──────────────────┘
                              All clients share the brain's view of
                                projects, lanes, project/personal chats, work sessions,
                                sessions, sync.
                                            │
                                            ▼
                                ┌─────────────────────────┐
                                │ User code: git worktrees│
                                │ under .ade/worktrees/   │
                                └─────────────────────────┘
```

Live runtime state is replicated between paired devices through cr-sqlite changesets carried over WebSocket; the **sync service runs inside the ADE brain**, not in the desktop app. ADE Mobile pairs with a machine — typically the user's primary desktop-class machine — and receives that machine's project catalog from the brain. The sync WebSocket is one brain-level listener on a stable port (default 8787, with preferred-port retry before any scan); when the hosted project switches, the new project's host service adopts the connected phones instead of dropping them. A second desktop on the same network is also a client of that brain, not a peer host. A desktop window or `ade code remote` can bind to a remote brain through the paired DPoP runtime channel (LAN → tailnet → relay) or, for an explicitly eligible target, through SSH `ade rpc --stdio`. The binding is per-window/client, and both transports route actions through the same multi-project JSON-RPC surface. See [features/remote-runtime/README.md](./features/remote-runtime/README.md).

Source code crosses machines through plain git. ADE does not own a git server.

Product positioning and workflows live in [`docs/PRD.md`](../docs/PRD.md). This document is strictly technical.

---

## 2. Apps & Processes

### 2.1 ADE brain and runtime (`apps/ade-cli/`)

`apps/ade-cli/` contains the brain process, manual runtime entry points, the `ade` CLI surface, and the `ade code` terminal client. It ships as one Node binary that runs in several modes.

**Run modes:**

- **Brain** — the normal mode. Boots the multi-project JSON-RPC server, hosts the per-project services on demand, serves sync, and listens on the channel's local endpoint (POSIX: `$ADE_HOME/sock/ade.sock`; Windows: a named pipe under `\\.\pipe\ade-<hash>`, with the hash derived in `apps/desktop/src/shared/adeRuntimeIpc.ts`). On POSIX the headless RPC socket directory is created `0700` and the socket itself chmodded `0600` so only the owning user can connect (named pipes skip the chmod). Installable / removable as a login service with `ade brain start` / `ade brain stop` (per-platform installers in `apps/ade-cli/src/serviceManager/`).
- **Manual runtime (`ade runtime run`)** — starts a foreground runtime process on an explicit endpoint. Sync is always off so it cannot claim brain authority; use a separate `ADE_HOME` when you also want full machine-state isolation.
- **Single-session CLI** — `ade <command>` connects to the local brain over the machine endpoint, dispatches one project-scoped action, and exits. With `--headless`, the CLI bootstraps a project's services directly from the repository instead of going through the machine brain — used in CI and for one-off scripts.
- **SSH stdio bridge (`ade rpc --stdio`)** — runs a single-session JSON-RPC runtime over stdin/stdout. This is what desktop's `RemoteConnectionPool` execs over SSH after `bootstrapRemoteRuntime` has uploaded a matching `ade-<platform-arch>` binary. Exits when the SSH channel closes.
- **Terminal client (`ade code`)** — launches the Ink + React Work chat (`apps/ade-cli/src/tuiClient/`). Defaults to attaching to the machine brain and will start it if the endpoint is missing. `ade --socket /path code` requires a specific endpoint; `ade code --embedded` keeps the in-process runtime fallback explicit.

**Brain startup ordering.** `ade serve` claims its RPC endpoint *before* entering the sync-host startup loop. The order matters: that loop retries forever by design (so mobile sync auto-recovers the moment a rival owner exits), so a brain whose socket was already owned never reached the bind check and simply lived on as a zombie — signed in, dialing the relay, and fighting the legitimate brain for the machine's relay slot. A brain that cannot own its socket has no reason to exist, so both the pre-loop claim and the later bind share one `assertBrainSocketUnowned` contract (message, cause, and the `socket_owned_by_other` code project recovery keys on) and fail fast. Symmetrically, `apps/ade-cli/src/services/runtime/runtimeSpawnRecord.ts` stops the CLI from stacking up detached brains: every `ade` command that cannot reach the brain spawns one detached-and-unref'd and forgets it, so a burst of failures used to leave a burst of immortal brains. The record (under the ADE-owned `runtime/spawns` dir, keyed by a hash of the socket path, `0600`) suppresses a duplicate spawn while a previously spawned brain is still alive and within `RUNTIME_SPAWN_RECORD_GRACE_MS` (30 s), reports success so the caller proceeds to its connect-with-retry, expires so a genuinely wedged brain never blocks recovery, and is cleared explicitly on the deliberate-shutdown path whose whole purpose is to make room for a replacement.

**Machine and multi-project RPC.** The runtime exposes runtime-scoped methods (`projects.list/add/remove/touch`, `sync.*`, `runtime/info`, `machineInfo.get`, `runtimeEvents.subscribe/unsubscribe`) directly. Project-scoped operations dispatch through `ade/actions/call` with a `projectId`. Personal chats use the separate machine methods `personalChats.call` and `personalChats.streamEvents`; they never enter project dispatch and their capability/version is advertised by `runtime/info`. Per-project services are spun up lazily by `ProjectScopeRegistry` (`apps/ade-cli/src/services/projects/projectScope.ts`) which calls `createAdeRuntime({ projectRoot, ... })` the first time a project is touched. `PersonalChatScope` (`apps/ade-cli/src/services/personalChats/personalChatScope.ts`) lazily boots a chat-only runtime under `$ADE_HOME/personal-chats`, with distinct state and scratch roots and no project-registry entry. The project registry (`projectRegistry.ts`) is the durable list of known projects; `machineLayout.ts` resolves machine-wide paths under `$ADE_HOME`. Wire formats live in `apps/ade-cli/src/multiProjectRpcServer.ts`. Runtime-event replay is backed by `apps/ade-cli/src/eventBuffer.ts`, a bounded buffer (10k events, 16 MB total, 1 MB per retained event by default) that returns `eventEpoch`, `gap`, and `oldestCursor` so clients can detect daemon restarts or evicted history. `projects.list` resolves at most 24 host-side project icons within 750 ms, with 128 KiB per-icon and 512 KiB aggregate wire caps; records outside those budgets get a null icon instead of blocking connection setup.

**Runtime-side services** (under `apps/ade-cli/src/services/`):

| Directory | Role |
|-----------|------|
| `projects/` | Project registry, project scope (per-project runtime), machine layout. |
| `personalChats/` | Lazy machine-owned personal-chat runtime, allowlisted action/terminal/attachment ingress, and durable transcript/event access outside the project registry. |
| `sync/` | Sync service, peer client, device registry, pairing store, PIN store, sync protocol, remote command service, Tailscale CLI resolver. The sync service now lives here; desktop's old in-process sync host is disabled by default (env-gated `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics only). |
| `account/` | Optional ADE account authentication. The machine brain owns loopback OAuth, the account-directory device-code bridge for SSH/display-less hosts, `account.session.v1` refresh storage, and in-memory `ADE_ACCOUNT_TOKEN` credentials for agents and CI. Interactive and token-provisioning actions are CTO-only. |
| `credentials/` | Per-machine credential store. |
| `agentRegistry.ts` | Per-machine agent registry. |

**Service managers.** `apps/ade-cli/src/serviceManager/installLaunchd.ts` (macOS), `installSystemd.ts` (Linux), `installWindows.ts` (Windows) register the brain as a login-time service. `index.ts` is the platform router; `common.ts` carries shared types (`ServiceManagerResult`, `ServiceManagerStatusResult`).
On macOS, an unchanged loaded launch agent is retained only after a bounded
runtime initialize probe succeeds. A failed probe takes the full unload,
predecessor termination, stale-process reap, and load path; the install result
is successful only after the old pid is gone, launchd reports a distinct new
pid, and the replacement initializes over the machine socket. The running brain
also stats its own CLI entrypoint every five minutes (configurable with
`ADE_BRAIN_FRESHNESS_INTERVAL_MS`, disabled by
`ADE_DISABLE_BRAIN_FRESHNESS=1`), hashes only after the stat changes, and uses
the brain-update service restart path after an idle grace period when the disk
hash no longer matches its baked runtime hash (`brainFreshnessMonitor.ts`).

**Event-loop watchdog.** `apps/ade-cli/src/services/runtime/brainLoopWatchdog.ts`
runs a small unref'd worker thread that the main thread heartbeats every second
with the name of the currently running command
(`trackBrainLoopWatchdogCommand`). If the heartbeat stalls past the threshold
(`ADE_LOOP_WATCHDOG_MS`, default 15 s) without a matching sleep/suspend signal,
the worker atomically writes an `event-loop-wedge.json` breadcrumb (the wedged
command, blocked duration, timestamp) under the runtime dir and `SIGKILL`s the
brain so launchd can restart it. On the next boot the watchdog promotes any
breadcrumb to `last-wedge.json`, logs `brain.recovered_from_wedge`, and emits a
deduped `ade_brain_recovered` analytics event; the recovered wedge is surfaced
to clients through `runtimeInfo.lastWedge` (and the desktop `BrainRecoveryNotice`
banner). Disabled with `ADE_DISABLE_LOOP_WATCHDOG=1` and off under vitest unless
forced. The brain's own log stream is written by
`apps/ade-cli/src/services/runtime/brainLogger.ts` (see §15.1).

**Session identity.** The runtime resolves caller role from ADE context env vars and command flags. Role vocabulary: `cto`, `orchestrator`, `agent`, `external`, `evaluator`. `ADE_DEFAULT_ROLE` is an authority ceiling, not an identity grant: `resolveSessionBoundRole` clamps a chat-bound caller that would otherwise inherit a daemon-wide `cto` role to `agent`, preserves an explicitly declared `orchestrator`, and never accepts a requested role above the runtime ceiling. SDK-backed chats receive `ADE_CHAT_SESSION_ID` plus `ADE_DEFAULT_ROLE=agent` (or `orchestrator` for a lead), and tracked provider CLI launch/resume does the same. Persistent SDK guidance names the concrete `--session <id>` for lifecycle commands so shared provider servers do not depend on process-global env inheritance. Browser automation adds a separate bearer capability: ADE-launched chat and owned-terminal environments receive an opaque `ADE_BROWSER_ACTOR_TOKEN` bound in Electron memory to that chat's trusted lane/project or personal tab collection. The runtime requires the token, strips caller-supplied routing, and carries it only over the authenticated desktop bridge. Electron validates it in the same process that issued it before restoring the bound scope; role alone never grants access to a human-authenticated browser profile.

**Optional ADE account auth.** `ade login` preserves the local-browser loopback OAuth path, but selects the account-directory device authorization bridge for explicit `--headless`, SSH, display-less hosts, or a failed browser launch. The brain generates and retains the device redemption secret, polls the bridge, and persists the resulting refresh-capable session under `account.session.v1`. For a JWT access token, its decoded `exp` claim is authoritative over the OAuth `expires_in` bookkeeping: status reports that expiry, and `getAccessToken()` refreshes inside the two-minute skew even when an older stored session record claims a later expiry. Tokens without a usable JWT expiry retain the stored `expiresAt` fallback. The desktop and brain share the encrypted session file and may race a rotating refresh credential; after an OAuth `invalid_grant`, the loser re-reads persistence and retries once only when another process has written a different refresh token. Other refresh failures are not replayed, and raw tokens are never logged. `ADE_ACCOUNT_TOKEN` takes precedence without starting a login flow: JWT access credentials are used through their declared expiry, while refresh credentials are exchanged and rotated only in memory. `ade account token create` wraps the current interactive refresh credential with its public issuer/client context in a versioned secret envelope, so a newly provisioned agent or CI host needs no local Clerk configuration. Legacy raw opaque refresh tokens retain local-config compatibility and return migration guidance when that config is absent. Distributed CLI/brain binaries and packaged Electron set `ADE_RUNTIME_PACKAGED=1` before account services start. In that mode, a Clerk issuer or JWKS URL under `*.clerk.accounts.dev`, plus the exact ADE development directory override, is rejected atomically in favor of the complete built-in production OAuth, attestation, and directory configuration; a non-development custom issuer remains valid, and source checkouts retain their existing override behavior. Persisted sessions pinned to a development issuer/client, sessions carrying a development `iss` access-token claim, and equivalent `ADE_ACCOUNT_TOKEN` credentials are rejected before token return, refresh, userinfo, or directory use. A rejected environment credential is treated as absent by status, access-token resolution, interactive login, device login, and durable-token provisioning, so it cannot block a new production sign-in. When the credential store supports atomic updates, a persisted development session is compare-and-deleted, then persistence is re-read exactly once: a peer-written acceptable production replacement is returned in the same status call. Without compare-and-delete support, ADE leaves the stored value untouched to avoid erasing a peer write but continues to report that development session as signed out. `ADE_ALLOW_DEVELOPMENT_CLERK=1` is the explicit packaged-build escape hatch for controlled development testing. The desktop Account page exposes one honest browser continuation because the bridge opens the generic hosted account flow rather than selecting a provider; the browser presents whichever methods are enabled. Native iOS uses ClerkKit's transferable OAuth result to distinguish new accounts from returning users. Its identifier-first email path starts sign-in, falls back to sign-up only for Clerk's precise account-not-found codes, sends the sign-up email verification code, and verifies against the matching sign-in or sign-up attempt. Account status exposes `loopback`, `device`, or `env-token`; signed-out state never gates local projects, `ade code`, local pairing, or PIN workflows. When product analytics is enabled, a known signed-in account produces one quota-counted PostHog `$identify` using only a one-way account hash plus plan, platform, and app version; explicit sign-out rotates the analytics anonymous identity.

**Action surface.** First-class command families cover lanes (including `ade lanes link-linear-issue` / `detach-linear-issue` for post-creation Linear issue linking, and `ade lanes create-from-linear` / `batch-create-from-linear` to spin up one or many issue lanes — optionally launching an agent chat with `--start-chat`), git, diffs, files, PRs, shells, chats (including `ade chat create --prompt` for a persistent Work chat followed by an initial chat message, `ade chat send` / `message` / `steer` / `wait` for peer chat delivery and status polling, silent bounded `ade chat read <session>` / `--page --cursor <offset>` reads for any project-backed chat registered with the machine brain, `ade chat note` / `ask` for the current Work row (settling is not agent-reachable — see below), `ade chat scheduled-work create --cron "<expr>" --prompt "<text>" [--once]` for durable provider-neutral scheduling, `ade chat create --from-linear-issue <id>`, `ade chat attach-linear-issue` / `detach-linear-issue` / `linear-issues` for session-scoped issue attachment, and `--parent <sessionId>` / `--no-parent` to control child-chat lineage — a chat or agent-provider CLI created inside a tracked agent shell defaults its parent to `$ADE_CHAT_SESSION_ID`; every parented launch must declare `--type subagent|peer`, where `subagent` is the coordinated/default choice for work the parent will join or review and `peer` is fire-and-forget; `--no-parent` deliberately creates an independent top-level session), agents, CTO, Linear (the write bridge an attached CLI agent uses: `ade linear attach` / `detach` / `issues` / `issue` / `comment` / `set-state` / `assign` / `label`, with `--this-session` resolving the issue id from `$ADE_LINEAR_ISSUE_IDS` so a launched agent needs no Linear token — see [features/linear-integration/README.md](./features/linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection)), tests, proof, settings, the iOS Simulator (`ade ios-sim` / `ade ios` / `ade simulator` — see [features/ios-simulator/README.md](./features/ios-simulator/README.md)), the Cursor Cloud bridge (`ade cursor cloud agents | runs | artifacts | repos | models | me` — talks directly to `@cursor/sdk` without going through the ADE runtime endpoint), the App Control bridge for Electron apps (`ade app-control` / `ade app` / `ade electron` — `launch`, `connect`, `stop`, `status`, `screenshot`, `snapshot`, `inspect`, `select`, `click`, `type`, `scroll`, `key`, `targets`, `attach`, `logs`, `terminal write`, `terminal signal` — see [features/computer-use/app-control.md](./features/computer-use/app-control.md)), the chat-scoped terminal (`ade terminal list` / `read` / `write` / `signal` / `active`), universal search (`ade search "<query>"` over chats, terminals, PRs, commits, branches, lanes, files, and Linear — see [features/search/README.md](./features/search/README.md)), and a generic `ade actions run <domain.action>` escape hatch for every registered ADE service action. The chat action surface includes `chat.createSession`, `chat.sendMessage` (low-level normal-turn send), `chat.messageSession` (normalized peer delivery: auto, queue, wake, interrupt-replace), `chat.readTranscript`, `chat.readTranscriptPage`, `chat.createScheduledWork`, `chat.listScheduledWork`, `chat.getScheduledWorkState`, `chat.cancelScheduledWork`, `chat.setScheduledWorkPaused`, and model-catalog actions; the session action surface includes caller-scoped `requestSessionAttention` and `setSessionStatusNote`, the agent-reachable snooze family (`snoozeSession`, `snoozeSessions`, `wakeSession`, `wakeSessions`, `clearWokeMarker`), and a CTO-only settle family (`settleSession`, `unsettleSession`, `settleSessions`, `unsettleSessions`, `setSettleOverride`). The caller-scoped `settleSelfSession` / `unsettleSelfSession` pair was removed in 2026-07: deciding that work is finished is a subjective judgment agents are unreliable at, so the only settle writers left are user surfaces (the desktop renderer's remote-runtime client and `ade code`, both of which authenticate at cto role) and the deterministic PR-merge policy, which calls `sessionService` directly. A bound agent may target only its own eligible session for still-scoped lifecycle and mutation actions, and an omitted lifecycle target is injected from that binding. `chat.messageSession` remains the reviewed primitive for deliberately messaging another ADE chat through routing semantics. The action allow-list adds three domains for these surfaces: `app_control` (every public method on `AppControlService`), `terminal` (`list`, `read`, `write`, `signal`, `activeForChat` against `ptyService`), named iOS Simulator actions for launch, live view, inspection, input, and Preview Lab workflows, and `search` (`query`, `indexStatus`, and the CTO-only `rebuildIndex` against `searchService`; the machine router searches the active project normally and aggregates bounded chat hits from every registered project for session-bound and unbound callers alike).

Fresh-chat kickoff uses `chat.messageSession(kind: "auto")` after creation.
For mixed versions, the runtime recognizes the ADE ≤1.2.41 shape that sends
`chat.sendMessage` across sessions, but normalizes it only when the destination
is provably the caller's still-blank direct child. All sibling, unrelated,
nonblank, or unreadable targets retain the structured session-scope denial.
Clients that cannot find either compatible action surface the owning host's
update/restart requirement instead of leaving the created session blank.

Scheduled work is part of that typed chat family. `ade chat scheduled-work create` requires exactly one of `--in <duration>`, `--at <ISO-with-offset-or-Z>`, or `--cron "<expr>"`; the generic `chat.createScheduledWork` action uses the equivalent `delaySeconds`, `runAt`, or `cron` field. Relative and absolute forms are one-shot, while cron uses the ADE brain machine's local timezone and defaults recurring (`--once` / `recurring: false` selects one occurrence). Creation returns the brain's IANA timezone plus the scheduled item's absolute `nextRunAt`, and both typed and generic CLI text output show brain-local and ISO values for verification. List/cancel call `chat.listScheduledWork` / `chat.cancelScheduledWork`; `ade chat schedules <session> --pause|--resume` calls `chat.setScheduledWorkPaused`, and omitting the flag calls `chat.getScheduledWorkState` for pause, next-wake, and active-job state. Create writes a durable provider-neutral row for any chat runtime or ADE-tracked provider CLI. A due chat row stays armed while a foreground turn is active, then starts a wake turn at the next safe boundary; live CLIs wait for a provider-specific visible composer boundary, and ended CLIs resume before delivery. For a session-bound agent, the daemon defaults an omitted target to the caller's own eligible session and denies cross-session, untracked-shell, or unbound-external scheduling. Management reads come from the KV-backed scheduler snapshot rather than reconstructed transcript events; provider-owned cancellation is reported as requested vs confirmed instead of being hidden optimistically.

`ade session` is the sibling family for *filing* a session rather than talking to it: `ade session show <id> --text` prints settle/snooze state and the wake reason, `ade session snooze <id> --for 1h` (or `--until <iso>`) parks a row, `ade session wake <id> [--reason timer|needs_you|error|turn_complete|manual]` brings it back, and `ade session clear-woke <id>` drops the "woke early" marker after visiting the row. There is no `ade session settle` / `unsettle` (or `ade chat settle` / `unsettle`): those were removed in 2026-07 and now fail with an explanation pointing at the two remaining paths — the user settling the row in ADE, and the `autoSettleLaneSessionsOnPrMerge` policy. Nothing derives a settle either; a clean process exit leaves a row `ended`, never `settled`. Every subcommand takes the session id as a positional, accepts `--session <id>`, and falls back to `$ADE_CHAT_SESSION_ID`, so a bound agent can file itself. Duration grammar and the 30-day cap live in `apps/ade-cli/src/sessionSnoozeDuration.ts` and are shared verbatim with `ade code`'s `/session …` commands.

Personal chat is an explicit machine-only variant of the typed chat family: `ade chat list|create|show|read|send|interrupt|archive|unarchive|delete --personal`. It connects to the running brain, invokes `personalChats.call`, and rejects lane/Linear project flags rather than falling back to `--headless` project dispatch. ADE Code remains a project Work TUI and intentionally has no personal-chat UI in this release.

**Proof subcommands** — `ade proof capture` (alias of `screenshot`), `ade proof attach <path>`, `ade proof record`, `ade proof launch`, `ade proof interact`, `ade proof list/status/environment/ingest`, `ade proof rm <artifact-id>…`, `ade proof broken`, `ade proof prune [--broken]`, and `ade proof recover <artifact-id>`. `attach` resolves relative paths from the caller's lane worktree, infers the artifact kind from the file extension, and routes through `ingest_computer_use_artifacts` with `backendStyle: "manual"`; the broker rejects non-evidence extensions and denied/escaped sources before inserting any row. Bare `proof prune` lists broken records, while `--broken` deletes them. Capture-style commands set `preferHeadless: true` on the plan so the connection layer drops to headless mode unless `--socket` is explicitly requested. Owner-aware proof subcommands accept `--owner-kind` / `--owner-id` (with `chat` and `pr` aliases) to layer an explicit owner on top of the inferred session identity.

**Bundled runtime artifacts.** Per-platform `ade-<platform-arch>` binaries plus their native dep tarballs live under `apps/desktop/resources/runtime/`, with packaged ADE CLI resources providing the `ptyHostWorker.cjs` used by remote terminals. `release-core.yml` builds the cross-platform set, validates that every darwin/linux arm64/x64 runtime binary and native archive is present, and publishes those runtime assets plus `install.sh` and `SHA256SUMS` on the GitHub release. `bootstrapRemoteRuntime` uploads missing or hash-mismatched artifacts on first SSH connect from the desktop client.

**Headless install + update.** A standalone runtime can be installed on a headless machine without going through the desktop installer. Remote machines reached over SSH don't need this path: `bootstrapRemoteRuntime` uploads the desktop app's bundled runtime artifacts.

```bash
curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
ade brain update --text
ade brain update status --text
```

Use `ADE_VERSION=vX.Y.Z` for a pinned release or `ADE_INSTALL_DIR` to choose the destination directory. The installer defaults to `$ADE_HOME/bin/ade`; both install and `ade brain update` verify downloaded runtime assets against `SHA256SUMS`. `ade brain update` stages the next release under `$ADE_HOME/runtime/updates/`, verifies the staged binary against the staged native deps, promotes the binary/deps into place, and restarts the per-user brain service.

**Health check (`ade doctor [--online] [--text]`).** `apps/ade-cli/src/commands/doctor.ts` connects to the machine brain over the local socket (bounded ~2 s) and prints one status row (`ok` / `warn` / `fail`) per subsystem: **App** (installed desktop version from the `.app` `Info.plist` vs the latest known version — read from disk, or from GitHub with `--online`), **Brain** (running version/pid/uptime plus any build-hash or role mismatch), **Wedge history** (the most recent recovered event-loop wedge, if any), **Sync port** (whether the shared listener bound the default `8787`, and the holders of the base ports when it drifted — with no visible holder reported as exactly that, since a root-owned holder such as `tailscaled` is invisible to a user-level probe and must be checked with `tailscale serve status` / `netstat -an -p tcp`), **Publish health** (the account-directory publisher's last-leg durations and slowest leg), **Relay** (end-to-end verified vs a classified failure — with a deliberate suppression, i.e. another ADE process on this machine owning the relay slot, outranking every other reason, since nothing downstream can succeed while it holds and no other reason tells the user what to do), and **Account** (signed-in state and source). The command exits non-zero when any row is `fail`. The row-evaluation logic (`evaluateDoctorRows`) is pure and dependency-injected so the desktop connection-doctor card and the CLI share one verdict.

**Install + PATH wiring (when the desktop ships `ade`).** On macOS / Linux the desktop installer drops the launcher at `$HOME/.local/bin/ade`; on Windows it lands at `%LOCALAPPDATA%\ADE\bin\ade.cmd`. After a successful install on Windows, the packaged `.cmd` installer adds the target directory to HKCU `Environment\Path` when needed and broadcasts an environment-change notification. After a successful install on POSIX, `ensureUserBinOnShellPath` appends a marked `export PATH="$HOME/.local/bin:$PATH"` block to the user's shell rc (`.zshrc` for zsh, `.bashrc` for bash, `.profile` otherwise) iff (a) the install dir isn't already on the inherited `PATH` and (b) the file doesn't already contain the marker / line / target dir. The install IPC reply tells the renderer which profile was edited so the Settings/Onboarding UI can prompt the user to open a new terminal or `source` it.

**Windows packaging.** The installer lays down `ade-cli-windows-wrapper.cmd` plus an `ade-cli-install-path.cmd` helper alongside the bundled Electron Node runtime. The helper installs `%LOCALAPPDATA%\ADE\bin\ade.cmd`, updates the user PATH when needed, and then `ade` works from a new normal Windows shell without a global Node install. See §14.4 for the packaging flow.

**Desktop bridge endpoint.** The ADE runtime runs `apps/ade-cli/dist/cli.cjs` under `ELECTRON_RUN_AS_NODE=1`, so it has no access to renderer-side Electron APIs (`WebContentsView`, `nativeImage`, `session`, …). A small set of services own real desktop UI and therefore cannot live in the runtime — most notably `BuiltInBrowserService`, which drives the Browser pane's `WebContentsView`. The desktop main process hosts those services and exposes them to the runtime over a side-channel JSON-RPC Unix-domain socket / named pipe.

The endpoint path is resolved by `apps/ade-cli/src/services/projects/machineLayout.ts`: `<adeHome>/sock/desktop-bridge.sock` on macOS / Linux (e.g. `~/.ade/sock/desktop-bridge.sock` stable, `~/.ade-beta/sock/desktop-bridge.sock` beta), and `\\.\pipe\ade-desktop-bridge[-<channel-suffix>]` on Windows. `ADE_DESKTOP_BRIDGE_SOCKET_PATH` overrides it for dev launches against a non-default ADE home. The server lives in `apps/desktop/src/main/services/builtInBrowser/desktopBridgeServer.ts`, wired up from `main.ts` right after `builtInBrowserService` is constructed and torn down with it on app shutdown. The runtime-side proxy is `apps/ade-cli/src/services/builtInBrowser/desktopBridgeClient.ts`; `createAdeRuntime` in `bootstrap.ts` assigns it to `runtime.builtInBrowserService` so the existing action registry slot resolves transparently (skipped when `runtimeProfile === "chat"`). Both sides share the same method allowlist: `getStatus, requestOriginAccess, claim, startSession, listSessions, endSession, showPanel, setBounds, navigate, createTab, switchTab, closeTab, reload, goBack, goForward, stop, observe, getTrace, click, typeText, dispatchKey, scroll, fill, clear, wait, startInspect, stopInspect, captureScreenshot, selectPoint, selectCurrent, clearSelection`. Profile diagnostics and permission administration are deliberately absent.

The socket is not an authority by itself. Electron mints a rotating 256-bit bridge token in memory for each desktop launch, sends it only through the trusted local desktop client's `ade/initialize` request, and requires it on every bridge request using a timing-safe comparison. The token is held by the runtime proxy and is not placed in agent environments. Independently, `builtInBrowserActorCapabilities.ts` issues each opaque per-chat actor capability in Electron. `adeRpcServer.ts` requires the connecting CLI's token, strips caller-supplied lane/project/personal routing, and carries it through the authenticated bridge. `desktopBridgeServer.ts` validates the token against Electron's issuer-owned in-memory registry, replaces routing with the capability's bound chat/lane/project or personal scope, and forces `force: false`; revoked or cross-process-fabricated tokens fail closed. This two-token boundary prevents a raw local socket caller, an unbound CLI, or an agent that forges action arguments from inheriting the human browser session.

Today only the `built_in_browser` domain rides this bridge; the pattern is generic and other Electron-only domains can be added the same way. The client lazy-connects on first call and reconnects on the next call after any failure. When no desktop is running, each call surfaces a clear `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` error and every other runtime domain stays functional. This is distinct from the retired renderer-hosted RPC mode used before the multi-project runtime: the ADE runtime still owns the full action surface, and the bridge is narrowly scoped to services that physically require an Electron renderer host.

### 2.2 Electron desktop client (`apps/desktop/`)

The desktop app is a **client of the runtime**. It owns a trusted main process, a narrow typed preload bridge, the React renderer, and the shared TypeScript contracts that the whole monorepo (including the ADE CLI runtime) consumes — but the data plane it operates on lives in the ADE runtime.

| Directory | Role |
|-----------|------|
| `apps/desktop/src/main/` | Node process with full OS access. Hosts windows, registers IPC handlers, routes runtime-backed APIs through local/remote runtime pools, spawns the local ADE runtime when needed, and owns Electron-only services that cannot run inside the runtime. Entry: `main.ts`. |
| `apps/desktop/src/preload/` | Typed bridge. Entry: `preload.ts`. Uses `contextBridge.exposeInMainWorld("ade", { ... })`. Runtime-backed APIs route through `LocalRuntimeConnectionPool` (local) or `RemoteConnectionPool` (paired/SSH-bound window); file APIs are strict once a local/remote runtime is bound, while usage/budget reads only route to runtime for remote-bound windows. Usage push delivery follows the active binding too: unbound windows accept main-process usage events, while bound windows accept only the runtime event stream, so a dormant local tracker cannot overwrite the active project's snapshot. During project switches, mutating runtime/sync calls that target the ambiguous active binding are blocked, read-only calls avoid refreshing stale bindings, active remote opens can be awaited before retrying reads, and remote lane preview URLs are localized through desktop-owned TCP forwards. Chat history reads are the exception to the local-IPC fallback: `isRemoteProjectRuntimeContext()` gives a synchronous, transition-safe answer to "is this window's runtime remote?" (live binding → in-flight remote open → the kind snapshotted by `detachProjectBindingForTransition()`), and a remote context returns `unavailable: true` rather than letting the local chat service answer a remote session id with a false `sessionFound: false` that would wipe the transcript. History runtime actions use one object envelope (`sessionId` plus caps/cursor) across preload and ADE Code; the action registry still normalizes the legacy positional form for packaged-client compatibility. If a packaged local window is temporarily bound to an isolated runtime whose sync service is disabled, only the exact machine-level sync-unavailable/register-project failures retry through main-process sync IPC; remote-bound failures never fall back locally. Explicitly targeted work can pass an `OpenProjectBinding` pin through `callPinnedRuntimeAction` to route to the captured project during a switch, used by detached draft launches and rollback. The same pin is the per-chat and detached-draft runtime routing mechanism: chat/session calls plus machine-owned supporting APIs (AI discovery, slash commands, file search, attachments, lane management, parallel launch state, session deltas, and computer-use snapshots) accept an optional `OpenProjectBinding` so foreign work stays on its owning machine without rebinding the window's tab. Pinned event subscriptions poll the selected runtime when Electron's bound event stream cannot represent a foreign machine. Required foreign ownership fails closed; `callPinnedOrBoundRuntimeActionOr` retains the unchanged bound path only when no pin is required. |
| `apps/desktop/src/renderer/` | React 18 SPA. No Node access, no filesystem access, no direct process/network. Everything goes through `window.ade`. Entry: `main.tsx`. |
| `apps/desktop/src/shared/` | Types, IPC channel constants (`ipc.ts`), model registry (`modelRegistry.ts`), keybindings, and cross-client derivations such as `chatScheduledWork.ts` and `externalSessionAffordances.ts` (the desktop/ADE Code Continue/Copy policy for provider-native imports). The project/machine model lives here too: `projectIdentity.ts` is the single definition of a binding key (`local:<root>` / `remote:<targetId>:<projectId>`) that every per-project cache and the repo tab join are keyed by, `machineIdentity.ts` is the single definition of "the machine ADE is running on" (`THIS_MACHINE_ID` / `THIS_MACHINE_NAME` / `isThisMachineId` / `machineDisplayName`, with machines named absolutely and "remote" never used as a machine name), and `laneDivergence.ts` is the pure push-time guard against stranding another machine's unpushed commits. Imported by desktop, `apps/ade-cli`, and mobile contract generation paths. New runtime-facing types live in `shared/types/remoteRuntime.ts` and `shared/types/core.ts`. |
| `apps/desktop/src/generated/` | Build-time generated code (e.g., bootstrap SQL snapshots). |
| `apps/desktop/src/test/` | Shared vitest setup and fixtures. |
| `apps/desktop/src/types/` | Ambient type declarations. |

**Multi-window shell.** `main.ts` hosts multiple `BrowserWindow` instances; opening another project opens it in a dedicated window. Each window has its own runtime binding (local pool or a specific remote target). The global `/chats` route surfaces through a real machine-level **Chats** top tab (its existence tracked in session-only `personalChatsTabOpen` app state, active-ness derived from the route) that coexists with project tabs and survives project open/switch/close, or runs inside the current project tab without clearing that binding. Personal-chat IPC therefore targets the local brain from local/no-project windows and the remote brain from an SSH-bound project window. External controllers — for example a `ade code` TUI — can drive desktop window navigation via the `app/navigate` JSON-RPC method against the runtime; the desktop's IPC tracing carries window ID so logs distinguish which renderer surface invoked a channel.

**Account Attention is outside the project binding.**
`attentionAccountCoordinator.ts` is the desktop main-process boundary for
snapshot, acknowledgment, presence, and preference calls. Signed-in reads go
directly to the account push relay and therefore remain available when the
window selects an old, disconnected, or differently authenticated remote
brain. A relay failure may degrade only to this Mac's local
`getMachineSnapshot`; signed-out mode uses that same explicitly labeled local
scope. The loaded account owner and, for machine fallback, every item's exact
source revision fence later mutations. The renderer keeps this source warm in
`AppShell`, presents it first through the global-header Attention drawer, and
uses `/attention` only as the secondary full-history route.

**Runtime binding pools.**

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` — desktop-side client for the local brain endpoint. Spawns or attaches to the machine endpoint, registers local projects with `projects.add`, dispatches local runtime actions, applies short per-call timeouts for project registration / file actions / event polling, emits a `local_runtime.action_slow` warning log when an action call exceeds 500 ms or throws (the log breaks the total into `ensureProjectMs` / `connectMs` / `daemonCallMs` so a stalled renderer call is debuggable before the IPC timeout fires) and records that call into a bounded (age + 5,000-sample) rolling 24 h window surfaced as `getRuntimeHealth()` (count + nearest-rank p95) behind the `ade.app.getRuntimeHealth` IPC, and best-effort installs the background service in packaged builds. Local project windows use this binding consistently outside unit tests.
- `apps/desktop/src/main/services/remoteRuntime/` — paired/SSH runtime pool. `remoteTargetRegistry.ts` stores saved machines under `~/.ade/secrets/remote-machines.json` (manual host plus an optional `routes[]` of Tailscale / Bonjour / manual addresses with per-route `lastSucceededAt` and manual-disconnect state); `sshTransport.ts` handles ssh-agent / key based transport with bounded connect/exec timeouts, normalized handshake errors, disabled SSH keepalives, and alternate routes ranked by most-recent success; `remoteBootstrap.ts` does first-connect runtime upload + version/hash negotiation against the bundled `ade-<platform-arch>` binary, native deps, and PTY host worker, and walks alternate ADE channel homes (`.ade` / `.ade-alpha` / `.ade-beta`) when the preferred runtime is missing **or fails validated initialization** (including a just-uploaded Beta), retaining the winning home for follow-up commands such as the JSON-stdin SSH-to-paired upgrade; version / channel / capability skew becomes `compatibilityWarnings`; `remoteConnectionPool.ts` keeps the per-window remote runtime binding alive, gates `projects.*` runtime calls against the connection's `capabilities.machineProjects` flags (missing capabilities reject the call with a self-describing error), reconnects safely on read-only actions (`get*/list*/read*/search*/diagnosticsGet*` and a small allowlist) after genuine connection failures, owns local TCP forwards for remote preview ports, memoizes optional-action fallbacks, and emits eviction notifications when the paired/SSH transport or JSON-RPC client closes; `remoteConnectionService.ts` listens for those evictions, marks targets as `error`, preserves explicit manual disconnects, pauses automatic reconnect after repeated implicit failures, surfaces the capabilities + compatibility warnings on every `RemoteRuntimeConnectionStatus`, and re-probes saved connections on `powerMonitor.resume` / `unlock-screen`; `runtimeRpcClient.ts` is the JSON-RPC client (per-call timeouts expire only the matching request without replay, while transport close/error or malformed JSON framing rejects every pending call; bounded oversized responses reject only the matching request, and remote errors preserve the original method plus the JSON-RPC `code` / `message` / `data`); `runtimeDiscovery.ts` runs Bonjour + Tailscale in parallel and returns `{ machines, diagnostics }` so a missing or stuck `tailscale` CLI does not silently swallow LAN discovery.

Build outputs (configured in `apps/desktop/tsup.config.ts`):

| Entry | Source | Purpose |
|-------|--------|---------|
| `main/main.cjs` | `src/main/main.ts` | Electron main process |
| `main/packagedRuntimeSmoke.cjs` | `src/main/packagedRuntimeSmoke.ts` | Post-package smoke test for PTY spawn, Claude SDK init, Codex availability, and ADE CLI readiness. |
| `preload/preload.cjs` | `src/preload/preload.ts` | Renderer bridge. |

### 2.3 ADE Code terminal client (`ade code`)

Terminal-native **Work** chat client (Ink 7 + React 19) for agents and power users who live in a shell, built into `apps/ade-cli/src/tuiClient/`. Its UI dependencies live under `apps/ade-cli` and are intentionally independent of the desktop renderer's React stack. It is a peer of the desktop client, not a wrapper around it: it speaks the same multi-project JSON-RPC surface and binds to an ADE runtime the same way.

- **Attached mode** (default): connects to `$ADE_HOME/sock/ade.sock`, or to an explicit endpoint passed on the parent `ade` invocation. Starts the brain if the endpoint is missing.
- **Remote mode**: `ade code remote` reads the desktop's saved remote-target registry, picks a target/project/session, and uses the target's declared transport. Interactive launches always show the machine chooser, even with one saved target; non-interactive launches auto-select only when that choice is unambiguous. Paired targets use the DPoP-bound sync runtime bridge and try LAN → tailnet → Relay unless `--route lan|tailscale|relay` pins one class; SSH targets start `ade rpc --stdio` over a validated route, and an explicit paired-route choice never falls back to SSH. `remoteLauncher.ts` coordinates selection, `pairedRemoteConnector.ts` owns paired route/auth/health policy, `remoteLaunchBudget.ts` bounds connection work, and `remoteBridge.ts` exposes the local socket consumed by the normal TUI. Before mounting the TUI, the launcher closes the discovery client and verifies the long-lived paired connection; the bridge consumes that connection for its first local client instead of redialing during handoff. Later TUI retries leave the bridge listener alive, reload the saved target, and redial the eligible paths. Account-created targets are paired-only: a directory row with a signed host identity can be adopted over LAN or tailnet through the sealed `ade-adopt-v1` handshake; unsigned legacy rows remain Relay-only. Later direct LAN/tailnet connections use the stored paired secret plus pinned DPoP and survive account sign-out; every Relay connection additionally fetches and attaches a fresh in-memory account proof that the host accepts only for its currently signed-in owner. The launcher recognizes the exact legacy account-machine shape that older desktop builds saved as credentialless SSH, adopts it into the paired store, and fails closed if account verification or pairing is unavailable; an explicitly configured SSH user/key continues to mean SSH. For true SSH targets, the saved hostname remains the OpenSSH `Host` selector while `-o HostName=<route>` dials each concrete route, preserving alias-scoped credentials, agent/proxy settings, and strict host-key verification. Account resolution, paired dialing, and the SSH route × channel-home × binary probe matrix share one 45-second cancellable startup budget and return aggregated attempt diagnostics with one correlation id, bounded endpoint metadata, and coarse failure classes. Compatibility checks that only make sense for local processes (entrypoint build hash and project-root equality) are skipped.
- **Embedded mode**: `--embedded` / `--headless` runs the shared `apps/ade-cli` services in-process without going through a machine brain. Used when no brain endpoint or manual runtime endpoint is reachable.

Shared DTOs and cross-client policies are imported from `apps/desktop/src/shared/*` (never the renderer barrel) so `npm run typecheck` in `apps/ade-cli` covers both typed commands and the TUI. This includes `externalSessionAffordances.ts`, which keeps ADE Code's provider-native Continue/Copy choices aligned with desktop while `externalSessionBrowser.ts` owns TUI-only navigation and the Open-existing action. Entry: `apps/ade-cli/src/tuiClient/cli.tsx` → `apps/ade-cli/dist/tuiClient/cli.mjs`, loaded by `ade code`. The built TUI bundle is intended to run in isolation: tsup bundles its Ink/xterm/highlight dependencies and injects ESM shims for `__dirname` / `__filename`; both `apps/ade-cli/scripts/verify-built-cli.mjs` and the desktop artifact validators smoke-import it and run `runAdeCodeCli(["--help"])`. Provider/model/interface setup is kept in pure helpers (`modelState.ts`, `providerMetadata.ts`, `modelPickerController.ts`) so Chat-vs-CLI availability, Cursor SDK-vs-CLI model filtering, permission presets, Fast Mode, and setup rows stay testable outside the Ink root. Chat Info uses shared derivations for subagents, tasks, and scheduled work, so Claude wakeups/cron/background activity rendered in desktop also appears in ADE Code; `AgentChatSessionSummary.nextWakeAt` adds the runtime scheduler's earliest armed fire as an alarm countdown in the Schedule block. The TUI can hand off to a desktop window via the `app/navigate` JSON-RPC method when a desktop client is attached to the same runtime.

`/attention` is also machine-global rather than project-scoped. It reads the
consolidated account stream through `attention.call`, groups the shared
Attention item contract in the right pane, and opens an item's exact ADE
destination before acknowledging it. Signed-out or degraded operation may show
the connected host's real machine snapshot. A host without the capability stays
connected and reports host-specific update/restart guidance instead of a blank
pane.

Model setup shares the desktop registry: GPT-5.6 Sol/Terra/Luna lead the Codex
list, Sol is the default, and host-advertised reasoning defaults and effort
ladders are honored, including Max before Sol/Terra's Ultra. Transcript aggregation also
preserves MCP app/action labels and collapses web/image lifecycle updates. In
CLI interface mode, attached and embedded runtime actions use the same signed,
explicit-opt-in `computer_use` MCP resolver as desktop when launching or
resuming Codex.

### 2.4 iOS client (`apps/ios/`)

Native SwiftUI app acting as a controller. It pairs with an ADE machine over WebSocket and reads live state from a local cr-sqlite-backed SQLite database that mirrors the project's `ade.db`. The phone never runs agents.

- Stack: native SwiftUI + `SQLite3` C API + iOS system SQLite.
- CRDT: pure-SQL CRR emulation layer (trigger-based change tracking) since iOS blocks `sqlite3_load_extension()`/`sqlite3_auto_extension()`. Changesets are wire-compatible with desktop cr-sqlite.
- Core services: `Database.swift`, `SyncService.swift`, `KeychainService.swift`, `DpopKeyService.swift` (Secure Enclave P-256 pairing proof), `PushNotificationService.swift`, `LiveActivityService.swift`, and `ProductAnalytics.swift` (default-on, content-free native analytics with an independent identity and 20-event daily ceiling).
- Shipped project tabs: Lanes, Files, Work, PRs, CTO, Settings (including a Push delivery panel). The projectless Chats surface is entered only from the Hub, outside the project tab bar. It uses runtime-scoped commands and the same chat event union/Work transcript renderer while suppressing lane/project actions. The Work chat decodes the same chat event union as desktop for live transcripts, including scheduled-work updates and transcript retractions; scheduled work appears in a native Chat Info popup/sheet while the phone remains a controller only. Durable active rows expose Cancel and the Schedule header exposes per-chat Pause/Resume when the host advertises those actions. Project chats use `chat.cancelScheduledWork` / `chat.setScheduledWorkPaused`; Hub personal chats map the same UI to runtime-scoped `personalChats.*` actions. The host also advertises non-queueable schedule creation, but iOS does not render a create control. Native clients gate every implemented control on its descriptor, so transport availability does not make an older brain accept unsupported mutations.
- Shipped attention surfaces: a global account-wide Attention Center, project-scoped lenses over the same model, a Lock Screen widget, and one account-wide ActivityKit Live Activity + Dynamic Island prioritized across signed-in machines/projects (`ADEWidgets/ADEAgentActivityWidget.swift`).
- Push: signed-in clients exchange account Attention snapshots/ACKs/presence/preferences and register APNs/Live-Activity tokens directly with the Cloudflare push relay (§2.7). Account device PUT/DELETE mutations carry a persisted monotonic `ownershipEpoch`; direct account switches commit old → unowned → new epochs, and the relay retains deletion tombstones so delayed requests cannot reclaim an installation. The same non-PII epoch is stamped into account-wide Live Activity attributes/content: the app ends an owner-mismatched activity, while the widget extension renders only a neutral Updating ADE state before cleanup. Legacy paired-machine registration remains for older clients. Alert pushes and every widget/Live-Activity row carry exact destinations with the source `accountMachineKey`; remote account items select/adopt that machine before navigation and never execute current-host-only intents.
- Connection: ADE account sign-in is the primary PIN-less path; direct pairing uses a user-set 6-digit PIN after scanning the v3 smart-URL QR or choosing a Nearby machine. Both paths produce device-bound DPoP trust and reconnect with a LAN → Tailscale → Relay preference; the phone races every eligible candidate in one happy-eyeballs wave rather than exhausting direct routes before trying Relay. Sign-out disables account discovery and Relay but retains direct machine trust until the user explicitly forgets that machine.
- Planned: Automations, Graph, History tabs; iPad layout; Spotlight.
- Target: iOS 26+, iPhone + iPad.

### 2.5 Hosted web client (`apps/desktop/src/renderer/webclient/`)

Static Cloudflare Pages controller built from the desktop renderer package. New
connections start with ADE account sign-in and adopt a machine from the
account directory; the resulting credential is DPoP-bound. Endpoint ranking is
still LAN → Tailscale → Relay, but a production HTTPS page cannot dial insecure
`ws://` LAN/tailnet endpoints, so Relay is normally the only browser-eligible
route. The client keeps no local ADE DB and installs a sync-backed subset of
`window.ade`.
Its static HTML paints the loading shell before React, while account bootstrap,
directory loading, and transactional IndexedDB privacy cleanup do not serialize
ordinary first paint. Vite preserves lazy feature boundaries, and the build
fails when the generated entry graph exceeds 1000 KB or eagerly references a
guarded heavy renderer chunk. Fingerprinted assets are immutable; the HTML
entry remains uncached. Connected visible tabs enforce separate transport-open
and authenticated-hello deadlines plus an inbound-traffic watchdog, then map
Relay application close codes into stable retry/offline UI.

The permanent `/hub` route merges account-directory machines with
browser-saved environments, exposes account-scoped rename/removal separately
from browser-local trust deletion, and opens machine project catalogs without
repeating a picker flow for every project. `WebMachineSessionManager` bounds the
browser to four live `AdeSyncClient` objects; a fifth connection parks the
least-recently-used non-active machine, retains its catalog/tab metadata, and
reuses the released client slot when that machine resumes. A federated
`window.ade` adapter persists Hub/project/Chats state per account and pins
project calls to the exact machine + project binding. The shared top bar keeps
Hub permanent and groups same-origin checkouts into one repository tab with a
compact machine selector inside it. Hosted mode mounts only the active project
surface so an inactive subscription cannot dispatch through another machine's
adapter.

Project routes use remote commands plus file/chat/terminal sub-protocols;
machine-scoped `/chats` uses runtime-scoped `personalChats.*` commands without
selecting a project. The chat adapter implements the shared
`agentChat.promptStashes` contract with an always-array list fallback and
required create/delete mutations, so malformed or unsupported host results do
not reach composer code as `null`. Account Attention is a separate direct push-relay read:
the global header/full-center snapshot does not follow the selected sync
machine or project. Signed-out compatibility environments can instead ask only
their explicitly paired host for a real machine snapshot; older hosts surface
an update state. Product analytics requires an affirmative browser-local
choice; the adapter reasserts that peer-scoped choice on every sync connection
and sends accepted events through the machine runtime rather than owning a
browser PostHog transport. See [Web client](./features/web-client/README.md).

### 2.6 Web app (`apps/web/`)

A Vite/React SPA that serves the public marketing site, download page, the internal smart-QR/App Clip pairing handoff, deeplink landing page, privacy/terms pages, and not-found route. Independent package (`ade-web`), deployed via Vercel (`apps/web/vercel.json`). Not a runtime dependency of the desktop app. Shared-origin with the Mintlify docs site (`docs.json` at repo root).

Public-site product analytics is separately consented and uses the `ade_marketing_*` namespace. `marketingAnalytics.ts` owns its closed taxonomy and durable 40-event browser/day budget; `marketingAnalyticsBrowser.ts` sends directly from the browser to PostHog's US Capture API with credentials and referrers omitted. It does not route through `apps/web/api/`, add a Vercel Function or Edge Function, enable Vercel Web Analytics, or create a log drain. The only Vercel impact is the small static JavaScript added to the normally cached site bundle. Production receives the public `VITE_POSTHOG_*` values; Preview and Development remain analytics-inert.

The `/open` route is the HTTPS half of the ADE deeplink scheme (`https://ade-app.dev/open?type=...&...`). `apps/web/api/open.ts` is a Vercel serverless function that self-fetches `index.html`, rewrites OpenGraph + Twitter meta tags from the query params so chat-app unfurlers (Slack, Discord, iMessage, Gmail, Linear) show a rich card without executing JavaScript, then hands the SPA over to `OpenPage` which attempts the `ade://` upgrade in the browser and falls back to an install/marketing card if no handler is registered. Supported targets include lanes, Work sessions, repo branches, PRs, and Linear issues. See [features/deeplinks/README.md](./features/deeplinks/README.md).

### 2.7 Cloudflare relay workers (`apps/push-relay/`, `apps/tunnel-relay/`, `apps/account-directory/`, `apps/webhook-relay/`)

Four independent Cloudflare Workers, each its own npm package / lockfile / `wrangler.jsonc` with its own trust model. None is a runtime dependency of the desktop app; the brain talks to them over HTTPS/WebSocket.

- **`apps/push-relay/`** — merges the bounded ADE Attention snapshots published by every signed-in brain, exposes an incremental account snapshot/ACK/presence/preferences/device API to desktop, hosted web, ADE Code, and iOS, and fans policy-selected events out as APNs alerts plus one prioritized account-wide Live Activity (Worker + one D1 database; free-plan compatible, no Durable Objects). A machine publish requires both its existing HMAC signature and a verified Clerk account token; account routes require a verified Clerk bearer token. Primary and secondary identity domains are complete, distinct issuer/JWKS/OAuth-client triples selected by exact `iss`; OAuth audience metadata must match through `aud` or `azp`, and the D1 user key is namespaced by verified issuer. `npm run deploy` separates schema/trigger health from account-auth health: it requires both binding triples and short-lived issuer-specific smoke tokens, then checks `/health` and calls a real account snapshot with each token after deployment. The relay stores bounded attention previews/destinations/acknowledgments in addition to device tokens and delivery receipts; it does not store chat transcripts or diff contents. APNs auth is an ES256 provider JWT from the `.p8` (wrangler secrets `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID`). Brain-side publisher lives at `apps/ade-cli/src/services/push/`; desktop also launches a native AppKit/SwiftUI ADE Notch helper which consumes the renderer's account snapshot through typed IPC instead of polling the relay independently. Physical-notch Macs merge the surface with the hardware cutout; other Macs keep the real ADE icon in the menu bar and open an anchored transient panel instead of a permanent imitation notch. See [features/sync-and-multi-device/push-notifications.md](./features/sync-and-multi-device/push-notifications.md).
- **`apps/tunnel-relay/`** — pipes ADE **sync** WebSocket frames between a controller and a brain when there is no direct LAN/Tailscale path (Worker + Durable Object with SQLite storage, one instance per `machineKey`, WebSocket Hibernation API). The brain holds a persistent HMAC-signed outbound control socket while the machine has a valid ADE account session; a controller dials `/connect/:machineKey`; the DO pairs it with a dedicated brain-side pipe socket and passes bytes through 1:1 with no frame wrapping, so the normal ADE hello / pairing / DPoP handshake is unchanged. Native 30-second ping / 10-second pong transport liveness is the primary keepalive; because a hibernated or wedged DO can leave the edge answering those transport pings after the machine's control registration is dead, the brain adds a low-frequency application-level `{t:"ping"}`/`{t:"pong"}` keepalive (180 s interval, 30 s deadline) to catch such "zombie" controls, and verifies the path end-to-end with a self-probe (`syncRelaySelfProbe`) that dials `/connect/:machineKey?ready=2` like a real controller. The account directory advertises a `relay` endpoint only after that self-probe round-trips (honest relay publication); an at-capacity `4503` close is treated as liveness proof, not failure. Failed bridge opens are rejected explicitly; application close codes and bounded sanitized reasons survive the phone/pipe/local boundaries. Early controller frames are bounded by both 64 frames and 256 KiB, and idle-sweep alarms run only while a client or pipe exists. Brain-side client is `apps/ade-cli/src/services/sync/syncTunnelClientService.ts`, shared one-per-machine and handed the shared sync listener by `attachHostListener()` from whichever runtime actually owns that listener (which is often not the runtime that constructed the client). Because the DO keeps exactly one host control socket per `machineKey` and evicts the previous holder with close code `4505`, dialing it is gated on holding the machine-wide sync host lease (`relayTunnelAuthorityGate` + `syncHostSingleton`, §3.4) — not on merely having a listener. A `4505` close is treated as a machine-local ownership conflict rather than a network fault: the client retries on a 60 s floor at most three times, then stops and reports `routeHealth.relay.relayControlSuppressed` with an actionable reason, re-arming once after 10 minutes or immediately when it (re)acquires the lease. Ordinary reconnect backoff uses decorrelated jitter with a 1 s floor and 60 s cap, so two clients that collide once do not keep colliding. There is no user relay toggle: sign-in starts and advertises Relay, while sign-out closes it. It remains the lowest-priority `relay` address candidate after LAN and Tailscale. TLS terminates at the Worker, so this is a trusted-operator plaintext path rather than end-to-end encryption; relay payload E2E encryption is planned security work.
- **`apps/account-directory/`** — Clerk-authenticated machine directory and OAuth device-authorization bridge (Worker + D1). The machine brain publishes a health-filtered registration through `accountMachinePublisherService.ts`: a 30-second heartbeat keeps the row inside the Worker's 90-second online window, while sign-in and publish-relevant relay-route changes trigger coalesced immediate writes and reset the heartbeat deadline. The Worker scopes rows by Clerk `sub`, selects at most the 500 most recently seen machines, then returns online-first order. Its additive `custom_name` column is owned by the account user rather than the publisher: authenticated `PATCH /account/machines/:machineKey` sets or clears the bounded display override, while registration continues updating the reported hostname without clobbering it. Machine-list responses expose separate auth and D1 durations through `Server-Timing`, including auth failures. Authentication failures return only fixed classifications such as `token expired`, `invalid issuer`, and `invalid audience`; directory clients consume at most 512 response bytes before exposing the short reason in machine-list results and publisher health. Clients attach `X-ADE-Correlation-ID`; the Worker reflects and CORS-exposes it and logs it with route, method, status, and duration so a connection attempt can be followed without recording account tokens or full endpoint URLs. Desktop, ADE Code, hosted web, and iOS use the compiled HTTPS Worker origin by default. Headless login binds each short-lived device code to a daemon secret, uses Clerk OAuth + PKCE in any browser, and atomically burns the approved token pair on redemption. Each published row also carries the machine's long-lived Ed25519 identity as `pubkey`; a same-account desktop/iOS client verifies that key during the sealed `ade-adopt-v1` handshake to adopt a machine over a direct LAN/Tailscale route (LAN → Tailscale → Relay fallback) without exposing the account bearer in plaintext — see [features/sync-and-multi-device/README.md](./features/sync-and-multi-device/README.md).
- **`apps/webhook-relay/`** — the pre-existing GitHub webhook relay (different trust model and lifecycle again). See its own docs.

---

## 3. Data Plane

### 3.1 SQLite + cr-sqlite CRDT layer

ADE uses Node's native `node:sqlite` driver (no better-sqlite3 dependency) with a vendored cr-sqlite loadable extension:

- **Engine source**: `apps/desktop/src/main/services/state/kvDb.ts` (schema bootstrap, CRR enablement, sync API) and `crsqliteExtension.ts` (extension loader). Both the desktop main process and the ADE CLI runtime import the same engine module from here; they do not maintain parallel schemas. The database is owned by whichever process opened it first for a given project; in normal desktop operation that owner is the ADE runtime, while desktop in-process users are limited to pre-binding flows, diagnostics, tests, and Electron-only work.
- **Database file**: `<project_root>/.ade/ade.db`.
- **WAL mode**: `openRawDatabase` sets `PRAGMA journal_mode = WAL` + `PRAGMA synchronous = NORMAL` at open. `flushNow()` forces pending WAL frames onto the main file with a `wal_checkpoint(TRUNCATE)` (used before shutdown and after a vacuum).
- **CRRs**: eligible tables are marked via `SELECT crsql_as_crr('table_name')` at startup. Virtual/internal tables (`sqlite_%`, `crsql_%`) are excluded. Marking is dynamic — new tables are picked up automatically unless excluded.
- **Sync API** (`AdeDb.sync`): `getSiteId()`, `getDbVersion()`, `exportChangesSince(version, { maxRows?, throughDbVersion?, excludeTables?, rejectOversizedVersionGroup? })`, `applyChanges(changes)`. Used by the sync transport.
- **Merge semantics**: last-writer-wins per column with Lamport timestamps; each device has a site ID at `.ade/secrets/sync-site-id`.
- **Engineering rule under CRR retrofit**: app-level `ON CONFLICT(...)` upserts must target PK only; secondary UNIQUE constraints do not survive CRR marking.
- **Restart-safe recovery**: table rebuilds are transactional, and
  `recoverInterruptedTableRebuilds()` classifies legacy staging tables before
  schema migration. `rebuildTableInTransaction` drops any leftover
  `__ade_crr_repair_<name>` staging table (and its cr-sqlite siblings) before its
  bare `CREATE`, and `sweepOrphanedRepairStagingTables()` runs at open to clear
  orphans recovery could not reconcile — without these, a staging table left by a
  killed/aborted rebuild makes every retrofit throw "table already exists" and
  wedges the sync host in an infinite repair loop. Durable JSON uses atomic
  replace plus one `.lkg`; typed open failures flow through `lastFailureStore`
  and the brain-independent `projectRecoveryService`. See
  [Storage and recovery](./features/storage-and-recovery/README.md) and
  [CRDT model](./features/sync-and-multi-device/crdt-model.md).
- **Maintenance hooks**: `openKvDb` attaches an optional `maintenance`
  (`DbMaintenanceApi`, from `state/dbMaintenanceApi.ts`) handle — retention
  prunes for `automation_ingress_events` / `review_run_artifacts` /
  `pull_request_snapshots`, a zero-peers-only cr-sqlite tombstone compaction, and
  a fragmentation-gated vacuum that activates `auto_vacuum = INCREMENTAL` so later
  sweeps stay bounded. `automation_ingress_events` pruning is two-tier: an
  active-row cap (newest 2,000 non-dispatched rows) plus a hard cap on TOTAL rows
  (10,000 per project, any status) so an always-on brain dispatching high webhook
  volume cannot bloat the table inside the 7-day window and abort the cr-sqlite
  rebuild. The shared `pruneIngressEventRowsForProject` helper is the single
  source of truth for that SQL, called by both the ingress writer and the
  storage-doctor mirror so the caps can't drift. The storage doctor in
  `storageInsightsService` invokes these on a schedule; the retention constants
  are imported by the ingress writer and the storage ledger alike.

### 3.2 Schema highlights

Schema bootstrap in `kvDb.ts` creates ~104 tables. Anchor tables for agents reading this doc:

| Table | Purpose |
|-------|---------|
| `projects` | One row per opened repo. Keyed by `root_path`. |
| `lanes` | Worktree-backed units of work. Types: `primary`, `worktree`, `attached`. Supports parent/child stacks, color/icon/tags. |
| `local_worktree_residual_cleanups` | Machine-local lane-delete cleanup debt for residual managed worktree directories. Stores absolute paths and is excluded from CRR replication because only the runtime on that machine can safely retry removal. |
| `terminal_sessions` | Tracked PTY sessions per lane with transcript path and head SHAs. The `chat_session_id` column (indexed) marks terminals owned by a chat (chat terminal drawer, App Control launch terminal); `ptyService` exposes them through the `ade.terminal.*` IPC and the `terminal` ADE action domain. The `owner_pid` column (indexed) identifies the ADE OS process that owns the live runtime for the row — cross-process reconcile/dispose paths check it before sweeping so concurrent surfaces don't mark each other's live sessions dead. See §3.5. Lifecycle lives in five nullable text columns: `settle_override` (tri-state `settled` / `active` / null, consulted before the derived exit-0 settle) and the snooze visibility overlay `snoozed_until` / `snoozed_at` with its `woke_at` / `woke_reason` marker. None of them carry a unique index — the table replicates to iOS through cr-sqlite, and `crsql_as_crr` rejects any non-primary-key unique index — and all five are mirrored in both iOS schema halves (`DatabaseBootstrap.sql` and `Database.swift`'s `ensureColumn` migrations). |
| `runtime_processes` | Machine-local process-liveness registry. Every ADE process (desktop main, brain process, TUI runtime) inserts a row on boot keyed by the process incarnation (`pid`, `started_at`) and refreshes `last_seen` on a 5 s heartbeat. The table is excluded from CRR replication because PIDs are only meaningful on the current OS; reconcile / dispose paths cross-reference `terminal_sessions.owner_pid` and `owner_process_started_at` against locally known and live rows to tell "row whose local owner crashed" from "row a sibling process is actively managing" without detaching sessions owned by another synced machine. See §3.5. |
| `session_deltas` | Post-session diff stats + touched files + failure lines. Input to pack generation. |
| `operations` | Audit log of every significant mutation (git, pack updates). Pre/post HEAD SHAs enable undo. |
| `usage_events` | Low-volume local ledger of successful user mutations, attributed to `desktop`, `mobile`, `tui`, `web`, or `api`. It is excluded from CRR replication; controllers read its aggregates through `usage.getAdeStats` instead of syncing raw events. |
| `test_suites` / `test_runs` | Declared test suites and their execution history. |
| `pull_requests` / `pr_review_threads` / `pr_checks` | GitHub PR projections with queue and stack metadata. |
| `integration_proposals` | PR merge-plan simulations. Stores source lanes, pairwise results, sequential resolution state, optional adopted merge target (`preferred_integration_lane_id`), and merge-target drift snapshot (`merge_into_head_sha`). |
| `computer_use_artifacts` + `computer_use_artifact_links` | Canonical proof-artifact records and cross-domain ownership. |
| `prompt_stashes` | Project-scoped desktop composer stashes. The runtime owns create/list/delete, caps the shared set at 20, and CRR replication makes entries available to connected desktops without storing machine-bound attachments. |
| `devices` + `sync_cluster_state` | Device registry and singleton host-authority row (host is `brain_device_id` internally; legacy naming). |
| `local_crr_change_suppressions` | Local-only (excluded from CRR replication) high-water marks per `(table_name, site_id)`. `AdeDb.sync.exportChangesSince` filters local-site rows for any listed table at or below `through_db_version` so a viewer-join wipe of `devices` / `sync_cluster_state` cannot leak DELETE rows back to the host. See §13.1. |
| `kv` | Generic key-value store for UI layout, config trust hashes, misc settings, short-lived recovery records such as `agent-chat-parallel-launch:<projectRoot>:<laneId>`, and versioned durable chat schedule state at `agent-chat:scheduled-work:v1`. The schedule value contains ADE action rows plus Claude-owned armed/terminal records, optional exact Claude SDK-session ownership and provider ids, expiry and terminal timestamps, and paused session ids; Electron-main and headless runtimes restore the same state. Every successful Claude `CronCreate` is mirrored here with ADE durability even when the tool omits `durable`; `durable: true` separately persists Claude's advisory provider copy. `chat.createScheduledWork` writes a provider-neutral row that wakes a chat through `messageSession(kind: "wake")` or a tracked provider CLI through its verified composer boundary. Provider snapshots reconcile only rows owned by that exact SDK session, so an empty snapshot from a fresh session cannot cancel a prior owner's active rows. Startup drops legacy `cron-tool:` intent placeholders, quarantines older provider rows without ownership metadata as paused, and prunes terminal history after seven days or 200 rows. |

Types for these tables are split into domain modules under `apps/desktop/src/shared/types/`. The barrel `index.ts` re-exports `core`, `models`, `git`, `lanes`, `conflicts`, `prs`, `files`, `sessions`, `chat`, `config`, `automations`, `packs`, `budget`, `usage`, and more. Feature docs under `docs/features/` call out the table subsets that are load-bearing for each surface.

### 3.3 Filesystem state

```
<project-root>/
├── .ade/
│   ├── .gitignore               # Tracked; ignores machine-local ADE state
│   ├── ade.yaml                 # Shared (tracked): tests, overlays, automations, templates
│   ├── local.yaml               # Personal overrides (ignored)
│   ├── local.secret.yaml        # Secret integration config (ignored)
│   ├── ade.db                   # SQLite + cr-sqlite (runtime, ignored)
│   ├── worktrees/<slug>-<uuid>/ # Lane worktrees (ignored)
│   ├── transcripts/             # PTY transcripts (ignored)
│   ├── cache/                   # Runtime scratch (ignored)
│   ├── artifacts/               # Pack exports, history artifacts (ignored)
│   ├── cto/
│   │   ├── identity.yaml        # Local CTO identity (ignored)
│   │   ├── CURRENT.md           # Running status markdown (ignored)
│   │   ├── MEMORY.md            # Curated durable facts (ignored)
│   │   ├── thread-state.md      # Rolling thread summary (ignored)
│   │   └── daily/<YYYY-MM-DD>.md # Per-turn journal
│   ├── templates/               # Lane and automation templates (tracked when human-authored)
│   ├── skills/                  # Exported skill markdown (tracked when human-authored)
│   ├── workflows/linear/        # Reserved scaffold dir; the legacy Linear workflow-config subsystem was removed and nothing writes here anymore
│   ├── project-icons/           # Imported project icon overrides (tracked when ade.yaml.iconPath points at one)
│   ├── ade.sock                 # Unix socket for ADE RPC (runtime)
│   └── secrets/                 # Machine-local secret material (ignored)
│       ├── github/*.bin         # safeStorage-encrypted tokens
│       ├── project-secrets.v1.enc # encrypted ADE project secrets for agents/CLI/UI
│       ├── sync-site-id
│       ├── sync-device-id
│       └── sync-bootstrap-token
└── ~/.ade/                      # Stable-channel ADE home (beta/alpha use their own homes)
    ├── global-state.json        # Recent projects list
    ├── projects.json            # Machine project registry
    ├── personal-chats/
    │   ├── state/               # Hidden chat runtime DB, transcripts, attachments
    │   └── workspaces/          # Separate provider cwd + personal terminal scratch
    └── logs/                    # Main-process structured logs
```

**Portability buckets** (intentionally distinct):

1. **Git-tracked shared scaffold** — `.ade/.gitignore`, `ade.yaml`, human-authored `templates/**`, `skills/**`, `workflows/linear/**`, `project-icons/**`. This is the only `.ade/` subset that flows through normal clone/pull. The shared `.ade/.gitignore` is now `*` with explicit allowlist entries for those scaffold files (so the next time someone touches `.ade/` from a fresh tool the runtime state stays out of git automatically).
2. **ADE sync state** — the replicated `ade.db` tables that flow through cr-sqlite over WebSocket when devices join the same host.
3. **Machine-local runtime** — worktrees, caches, transcripts, artifacts, secrets, sockets, generated context markdown, and the channel-local personal-chat state/scratch roots. Never leaves the device. Personal chats can still be controlled from another client connected to that machine brain; they are not CRR rows in an active project's database.

The storage domain lives under
`apps/desktop/src/main/services/storage/`: `diskPressure` gates new
write-producing work, `storageInsightsService` provides categorized and
preview-confirmed cleanup without following links plus the scheduled **storage
doctor** maintenance sweep (`runMaintenanceNow` + post-boot/daily timers), and
`historyCompression` compresses inactive history only after byte-for-byte
verification. `storageLedger` declares the bounding policy for every table and
directory (with a CI coverage cross-check against `ADE_LAYOUT_DEFINITIONS`) and
the doctor journals each run to `.ade/cache/storage-doctor-journal.json`.
Renderer surfaces are `StoragePressureIndicator`, `StorageSection` (with its
diagnostics strip + maintenance journal), and `ProjectRecoveryScreen`. See
[Storage and recovery](./features/storage-and-recovery/README.md).

**Project scaffold modes.** `initializeOrRepairAdeProject(projectRoot, { mode })` controls whether a project gets the full shared scaffold or stays local-only:

- `mode: "shared"` always materializes the canonical files (`.ade/.gitignore`, `ade.yaml`, the tracked placeholder `.gitkeep`s, plus local-only CTO identity state) and scrubs any leftover `.ade/` ignore lines from `.gitignore` / `.git/info/exclude`. Triggered automatically from `createLocalProject`, every shared-config save, and any helper that calls `ensureSharedAdeProjectScaffold(projectRoot)` (e.g. `setProjectIconOverrideFromSelection`).
- `mode: "auto"` (the default for `openProject`) keeps the project local-only when no shared scaffold files exist yet — it ensures `.git/info/exclude` has a `.ade/` entry so a brand-new clone or a personal-only setup never accidentally promotes runtime state into git, and only flips to the shared layout when shared scaffold files are already present (or after a save call promotes them).
- `mode: "local"` is reserved for force-local repair flows.

### 3.4 Cross-process ownership

ADE is a multi-process system on a single machine: the desktop main process, the brain process, and any number of manual/TUI runtimes can all be live against the same project DB simultaneously. To prevent one process from disposing or reconciling another's live PTYs and SDK sessions, every long-lived row gets an `owner_pid` / `owner_process_started_at` identity and every process maintains a heartbeat in the machine-local `runtime_processes` table.

`apps/desktop/src/main/services/runtime/processRegistryService.ts` is the per-process registrar.

- On `start()` it inserts/refreshes its own process-incarnation row in `runtime_processes` (`pid`, `role`, optional `projectRoot`, `startedAt`, `lastSeen`) and runs an idempotent `pruneStale()` over rows older than 10× the liveness window.
- A 5 s heartbeat (`heartbeatIntervalMs`, configurable) writes `last_seen` so siblings can see this process is alive. The interval `unref()`s so it never blocks shutdown.
- Liveness checks (`isPidLive(pid)`, `listLivePids()`, `listLiveProcessIdentities()`) consider a row live when `last_seen` is within `livenessWindowMs` (default 15 s = 3× heartbeat) so a single missed heartbeat doesn't false-positive a sibling as dead. `listKnownPids()` and `listKnownProcessIdentities()` expose all locally recorded owners regardless of heartbeat age. The registrar's own pid is always reported as live and known.
- `stop()` clears its row outright on graceful shutdown so siblings don't have to wait the liveness window to free up ownership.

`ptyService.create()` records `processRegistry.pid` and `processRegistry.startedAt` on the new `terminal_sessions` row's owner columns. `sessionService.reconcileStaleRunningSessions()` accepts both live owners and known local owners: rows with live local owners are left alone, rows with known but no-longer-live local owners can be swept to `detached`, and rows with unknown owner identity are preserved because they may have been synced from another machine. Dispose paths run the same ownership check before tearing down runtimes a sibling still manages.

**Machine-exclusive subsystems** use a separate mechanism, because "which process owns the machine's phone sync" is a single-winner question rather than a per-row one. `apps/ade-cli/src/services/sync/syncHostSingleton.ts` holds an advisory lock file at `$TMPDIR/ade-sync-host-<uid>.json` (override `ADE_SYNC_HOST_LOCK_PATH`) naming the owning pid, channel, project root, and bound sync port, and pairs it with a process-wide authority registry: `holdsSyncHostSingleton()` answers "is it me", and `onSyncHostSingletonAuthorityChanged()` publishes none-held → held and held → none-held transitions. The relay tunnel (`relayTunnelAuthorityGate` → `syncTunnelClientService`) and the account-directory publisher both gate on that registry, because relay registration is one control socket per `machineKey` at the Durable Object and directory publication advertises "reach me here". Merely binding a sync listener is not authority — a dev `ade serve`, a headless one-shot, or an embedded fallback can bind one without ever winning the lease. Loss of authority is honored only after `SYNC_HOST_AUTHORITY_RELEASE_GRACE_MS` (5 s), since `ProjectScopeRegistry.performSyncHostSwitch` deactivates the outgoing sync host before activating the target and authority legitimately reads false for the width of a project switch. See [Sync and multi-device](./features/sync-and-multi-device/README.md).

Roles are open-ended strings; today's vocabulary is `desktop-main`, `ade-serve-daemon` for the brain process role, and `tui-runtime`. The desktop main process constructs the registry in `main.ts` and threads it into `ptyService`, `sessionService`, and reconcile callers via the per-project context. The `ade-serve-daemon` literal is retained in live `runtime_processes` rows until the internal role vocabulary is migrated.

### 3.5 Migration strategy

- Schema is defined idempotently — `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
- One-time schema-compat migration at startup: retrofits `NOT NULL` on PKs and strips UNIQUE/FK constraints incompatible with cr-sqlite CRRs. A pre-cr-sqlite backup (`<db>.pre-crsqlite-w1.bak`) is written on first CRR enablement.
- Feature migrations add columns via `ALTER TABLE ADD COLUMN`, wrapped by `crsql_begin_alter`/`crsql_commit_alter` to stay CRR-safe.
- Targeted per-domain migrations live in `kvDb.migrations.test.ts`, which covers the consolidated upgrade path for orchestration/worker tables plus later CRR-safe schema cleanups.
- The canonical iOS bootstrap schema is exported from desktop `kvDb.ts` to `apps/ios/ADE/Resources/DatabaseBootstrap.sql` so iOS stays schema-compatible.

---

## 4. AI Integration Layer

Service entry points live under `apps/desktop/src/main/services/ai/`. The subsystem has three parts: provider-routed execution, permission profiles, and ADE CLI-backed tool surfaces.

### 4.1 Provider routing

- **Router** — `aiIntegrationService.ts` resolves a task → model → provider class and dispatches.
- **Model registry** — `apps/desktop/src/shared/modelRegistry.ts` is the single source of truth. Each `ModelDescriptor` carries identity (`id`, `shortId`, `providerRoute`, `providerModelId`), capabilities, pricing, context sizing, auth type (`cli-subscription`, `api-key`, `openrouter`, `local`), optional reasoning tiers plus `defaultReasoningEffort`, and optional `harnessProfile`/`discoverySource` for safety metadata.
- **Classes**:
  - **CLI-wrapped** (Claude via `@anthropic-ai/claude-agent-sdk`, Codex via the pinned `@openai/codex` package) — spawned as subprocesses; Claude uses the SDK `query()` stream with ADE's async input pump and bundled Claude Code binary, while Codex uses its app-server JSON-RPC bridge. Desktop and runtime packages pin Codex `0.144.5`, including the matching native app-server binary. Authentication inherits from the user's own CLI login. ADE context is exposed through environment variables, and agents can call back into ADE with the `ade` CLI.
  - **API-key / OpenRouter** (Anthropic, OpenAI, Google, Mistral, DeepSeek, xAI, Groq, Together AI, OpenRouter) — routed through the **OpenCode server** (`opencode` binary, user-installed or bundled). Discovery via `openCodeInventory.ts`; replaces dynamic portion of the registry.
  - **Local** (Ollama, LM Studio, vLLM) — OpenAI-compatible local endpoints through OpenCode. Discovery via `localModelDiscovery.ts`.
- **Detection pipeline**:
  - `authDetector.ts` — detects subscriptions, API keys, OpenRouter, local endpoints.
  - `providerCredentialSources.ts` — reads Claude OAuth credentials, Codex tokens, macOS Keychain.
  - `providerConnectionStatus.ts` — builds the `AiProviderConnections` snapshot surfaced to the renderer.
  - `providerRuntimeHealth.ts` — per-provider health (`ready`, `auth-failed`, `runtime-failed`).
  - `claudeRuntimeProbe.ts` — lightweight SDK probe on force-refresh to distinguish bundled Claude binary readiness from authentication readiness.
  - `modelsDevService.ts` — non-blocking 6-hour refresh that enriches pricing and context-window metadata in the registry from `models.dev`.
- **ADE action status surface**: `ai.getStatus`, `ai.listApiKeys`, and
  `ai.getOpenCodeRuntimeDiagnostics` expose the same provider readiness,
  stored-key, and OpenCode runtime health data to renderer settings and
  `ade code` model setup through the shared ADE action registry.

Agent-chat adapters publish a provider-neutral delivery and health contract:
accepted user messages retain processed/unprocessed resolution state;
`turn_health`, `turn_recovery`, and `turn_diagnostics` describe stalls,
recovery, and aggregated diagnostics; `chat.recoverTurn` and
`chat.resolveUnprocessedMessage` are the shared action surfaces. Provider-native
events remain compatibility inputs, not client UI contracts. Repeated raw
moderation checks are collapsed into one quiet per-turn diagnostics summary.
- **Fallback**: if no usable provider is present, ADE runs in **guest mode** — deterministic features (packs, diffs, conflicts) continue; AI surfaces are disabled with explanatory UI.

### 4.2 Permission modes (provider-native + ADE)

Permission configuration is class-based, not provider-bucketed:

- `permissionConfig.cli` — for CLI-wrapped models. Claude uses `claudePermissionMode` (`default`, `auto`, `acceptEdits`, `bypassPermissions`, `plan`); Codex uses `approvalMode` (`untrusted`, `on-request`, `on-failure`, `never`) + `sandboxPermissions` (`read-only`, `workspace-write`, `danger-full-access`).
- `permissionConfig.inProcess` — for API/local models. ADE-defined planning/coding tool profiles constitute the full tool surface.
- **ADE-owned tools** (repo mutation, context export, proof registration) always enforce ADE's own permission and policy layers regardless of provider mode — preserving the audit boundary.
- **Sandbox budgets**: `maxBudgetUsd` per-session cap for Claude; per-task daily budgets for narratives, PR descriptions, and terminal summaries.

### 4.3 Tool system

Agent tools are split by domain:

| File | Domain |
|------|--------|
| `ai/tools/universalTools.ts` | Mutating tools (`bash`, `writeFile`, `editFile`), read/search tools, web tools, todos, and ask-user. |
| `ai/tools/workflowTools.ts` | Workflow interaction tools. |
| `ai/tools/ctoOperatorTools.ts` | CTO-only operator tools. Registered on the live session via `createCtoRuntimeToolMap` through the per-provider transports (`ade-cto` SDK MCP server for Claude, the `ade_cto` dynamic-tool namespace for Codex, a dedicated HTTP MCP lease for Cursor/Droid/OpenCode). Git mutations require an explicit `laneId` because the CTO session is pinned to the primary lane. |
| `ai/tools/linearTools.ts` | Linear integration tool surface. |
| `ai/tools/webFetch.ts` / `webSearch.ts` | Outbound web access. |
| `ai/tools/readFileRange.ts` / `globSearch.ts` / `grepSearch.ts` | Read-only file tools shared across all roles. |
| `ai/tools/editFile.ts` | Edit-path tool wired to ADE-controlled write flow. |
| `ai/tools/systemPrompt.ts` | Base system prompt; adapts wording based on exposed tool names. |

**ADE CLI is the cross-process action surface.** Workers spawned as CLI children inherit ADE context env vars and can call the `ade` command to invoke ADE-owned actions layered on top of their native provider tools.

### 4.4 Model registry specifics

`apps/desktop/src/shared/modelRegistry.ts` + `apps/desktop/src/shared/modelProfiles.ts`:

- `MODEL_REGISTRY` — static CLI-wrapped entries + dynamically populated API-key/local entries. The OpenAI/Codex block is ordered GPT-5.6 Sol, Terra, Luna, then the retained GPT-5.5 and older rows; `pickDefaultCodexModel` chooses the newest Sol row, so new Codex sessions default to GPT-5.6 Sol. All three GPT-5.6 descriptors have a 372k context window and advertise Fast. Sol and Terra expose `low | medium | high | xhigh | max | ultra`; Luna exposes `low | medium | high | xhigh | max`. The product labels those tiers Light, Medium, High, Extra High, Max, and (for Sol/Terra) Ultra. Runtime app-server ladders pass through in their advertised order, including Max. `defaultReasoningEffort` is `low` for Sol and `medium` for Terra/Luna and is honored by desktop, TUI, iOS, CTO, review, and handoff pickers. The Claude block is ordered for every picker as Fable 5, Opus 5, Sonnet 5, Haiku 4.5, Opus 4.8 1M, then Opus 4.7 1M. Opus 5 uses provider model `claude-opus-5` (1,000,000 context / 128,000 max output), defaults to `high` effort, and advertises Fast. Sonnet 5 uses provider model `claude-sonnet-5` (1,000,000 context / 128,000 max output); removed Sonnet 4.6 and basic Opus 4.7 ids resolve forward as compatibility aliases but do not appear as selectable rows. The generic `opus` alias resolves to Opus 5. Opus 4.8 remains selectable after Haiku, while Opus 4.7 1M remains available as `anthropic/claude-opus-4-7-1m` with aliases `opus[1m]` / `claude-opus-4-7[1m]`. `ModelDescriptor.serviceTiers?: string[]` advertises optional service tiers (today: `"fast"`, set on Fable/Opus, GPT-5.6 and older fast-capable Codex entries, and dynamic Cursor SDK/CLI rows) that the UI's Fast Mode toggle keys off. Codex maps it to the JSON-RPC `serviceTier` argument; Cursor SDK maps it through discovered model parameters, and Cursor CLI launches use the matching fast model alias when present.
- `ModelProviderGroup` = `"claude" | "codex" | "opencode" | "cursor" | "droid"`. Cursor and Droid each have their own top-level provider group used by the model picker, identity routing, and tracked CLI provider catalog.
- Helpers: `getModelById`, `getModelPricing`, `updateModelPricingInRegistry`, `replaceDynamicOpenCodeModelDescriptors`, `resolveProviderGroupForModel`, `resolveModelDescriptorForProvider`, `getRuntimeModelRefForDescriptor`, `modelSupportsServiceTier(descriptor, tier)` / `modelSupportsFastMode(descriptor)`.
- Reasoning tier passthrough (`providerOptions.ts`) maps tier strings directly to each provider's native config (`thinking.type`, `reasoningEffort`, `thinkingConfig.thinkingLevel`, etc.) — no arbitrary token budgets. Claude Opus 5 and Opus 4.7 advertise `low | medium | high | xhigh | max`; Fable and Opus 4.8 advertise `low | medium | high | xhigh | max | ultracode`; Sonnet 5 advertises `low | medium | high | max`.
Interactive chat (Terminals, Work), CTO delegation, and automation-launched agent sessions flow through the unified executor with the same permission plumbing.

Related feature docs: [Chat](./features/chat/README.md), [Agents](./features/agents/README.md), [CTO](./features/cto/README.md), and [Automations](./features/automations/README.md).

---

## 5. IPC Contract (the glue)

### 5.1 Typed preload

`apps/desktop/src/preload/preload.ts` (~8,545 lines) exposes ~550 methods on `window.ade`:

- `contextBridge.exposeInMainWorld("ade", { ... })` — the only cross-isolated-world surface.
- Methods are typed via TypeScript imports from `apps/desktop/src/shared/types/`.
- Two categories: **invoke methods** (`ipcRenderer.invoke(channel, args)` returning `Promise<T>`) and **event subscriptions** (`ipcRenderer.on(channel, handler)`).
- Runtime-backed event subscriptions can merge local Electron IPC and the runtime event stream behind one renderer API. For example, `window.ade.lanes.onLifecycleEvent` listens to `ade.lanes.lifecycle.event` for desktop-local fallback paths and to runtime `lane_lifecycle_event` payloads for local-brain or SSH-bound windows. Runtime stream results (`RemoteRuntimeStreamEventsResult` in `apps/desktop/src/shared/types/remoteRuntime.ts`) carry `eventEpoch`, `gap`, and `oldestCursor`; preload resets cursors/dedupe on epoch changes and notifies project-binding refresh paths when a gap means replay history was evicted.
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (required for preload functionality).
- Global window type: `apps/desktop/src/preload/global.d.ts`.
- `window.ade.sessions.settle(sessionId, { outcome?,
  dismissPendingInput? })` routes through the same
  `settleTerminalSession` transaction for local fallback and runtime-bound
  projects. Pending-input dismissal completes before `settled_at` is written;
  it is not a renderer-side pair of mutations.
- `window.ade.sessions.snooze` / `.snoozeMany` / `.wake` / `.wakeMany` /
  `.setSettleOverride` / `.clearWokeMarker` are the desktop half of the session
  lifecycle surface. `setSettleOverride` takes the tri-state
  `"settled" | "active" | null` pin consulted before the derived exit-0 settle;
  snooze/wake write the `snoozed_until` / `snoozed_at` visibility overlay and
  its `woke_at` / `woke_reason` marker. The overlay is deliberately outside
  `canonicalSessionState()` — it changes only where a surface files a row. The
  same operations are exposed to every other client as the `session` ADE action
  domain and the `session.*` sync remote commands. See
  [Terminals and sessions](./features/terminals-and-sessions/README.md#session-lifecycle).
- `window.ade.project.getDroppedPath(file)` wraps Electron's `webUtils.getPathForFile()` so renderer drag-drop handlers can resolve the absolute path of a `File` payload without the renderer needing Node APIs. Used by the Command Palette project browser to accept dropped folders.
- `window.ade.updateGetPreferences()` /
  `window.ade.updateSetPreferences(preferences)` expose the machine-local
  automatic-install policy. The main process normalizes the two booleans,
  persists them in the Electron user-data `ade-state.json`, and returns the
  stored contract; the renderer never writes that file directly.

### 5.2 Channel design

`apps/desktop/src/shared/ipc.ts` defines the single `IPC` const with ~550 named channel strings in a `ade.<domain>.<action>` namespace:

```
ade.app.*                    # app lifecycle, clipboard text and image (writeClipboardText, writeClipboardImage, saveClipboardImageAttachment), paths, image data-URL preview (getImageDataUrl), the deeplink navigation push channel ade.app.navigate (AppNavigationRequest payloads from the ade:// protocol handler, the ade code app/navigate JSON-RPC, and the iOS deeplinks.open sync command — see features/deeplinks/README.md), the one-way zoom push channel ade.app.zoomCommand (AppZoomCommand "in"/"out"/"reset" sent from the native View menu to the renderer's window.ade.zoom.onCommand so menu/keyboard zoom shares the in-app zoom path — display %, persistence, and the macOS traffic-light inset), and the resource-pressure snapshot ade.app.getResourceUsage (async, coalesced `AppResourceUsageSnapshot` backing the TopBar pressure indicator: one bounded/timeout-guarded `ps` sample shared across windows behind a 900 ms cache + in-flight coalescing, with disjoint per-role attribution built in `services/pty/resourceUsageSampling.ts` — see features/terminals-and-sessions/pty-and-sessions.md), and the machine-level daemon-health snapshot ade.app.getRuntimeHealth (async `RuntimeHealthSnapshot` — a rolling 24 h count + p95 of slow/errored local-runtime action calls, read directly off `localRuntimeConnectionPool` with no action-domain routing, feeding the Storage > Diagnostics "slow responses" tile)
ade.project.*                # project open/close/switch/state, unified local+remote recents (listRecent, key-based forget/reorder, setRecentPinned), in-app directory browser (browseDirectories, getDetail), git path inspection (inspectPath — ProjectPathInspection behind the renderer's worktree-open gate; promise-cached in services/projects/projectPathInspector.ts with a `fresh` bypass and invalidated on lane attach/adopt from both the in-process handler and the runtime-bridge action path), favicon resolver/override (resolveIcon, chooseIcon, removeIcon) with local-only filesystem allowlists. openRepo/switchToPath surface AdeRecoveryErrorCode-coded failures (via surfaceCodedError) so the renderer can route a failed open into the recovery screen
ade.recovery.*               # brain-independent project-open recovery: diagnose / repair
                             # (projectRecoveryService against projectRecoveryConnectionPool).
                             # See features/storage-and-recovery/README.md
ade.storage.*                # disk-pressure snapshot (getPressure) + storage dashboard:
                             # getSnapshot / compressNow / runMaintenanceNow / cleanupPreview /
                             # cleanup, backed by diskPressureMonitor + storageInsightsService
                             # (runMaintenanceNow triggers the storage-doctor sweep) and the
                             # `storage` ADE action domain (cleanup + runMaintenanceNow are CTO-only)
ade.onboarding.*
ade.lanes.*                  # lane list/create/delete/stack/template/env/port/proxy/rebase
                             # delete pipeline: ade.lanes.delete + ade.lanes.delete.cancel
                             # + ade.lanes.delete.risk preflight + ade.lanes.delete.event push
                             # branch drift (worktree HEAD off lanes.branch_ref):
                             # ade.lanes.getBranchDrift (fresh symbolic-ref read)
                             # + ade.lanes.resolveBranchDrift (switch-back |
                             # keep-head); see features/lanes/README.md#branch-drift
                             # one-shot create/archive/delete notifications:
                             # ade.lanes.lifecycle.event push, mirrored from
                             # runtime event type lane_lifecycle_event
                             # Linear linkage: ade.lanes.linkLinearIssues / unlinkLinearIssues
                             # (lane-scoped) + attachLinearIssueToSession /
                             # detachLinearIssueFromSession / listLinearIssuesForSession /
                             # listLinearIssuesForLaneSessions (session-scoped, backed by
                             # session_linear_issues; see features/linear-integration/README.md)
ade.files.*                  # file tree, read, write, search, watch
ade.diff.*                   # lane-scoped change list + per-file diff / patch (diffService)
ade.pty.*                    # PTY spawn/write/kill, data/exit events
ade.git.*                    # stage/commit/push/sync/revert/cherry-pick/stash
ade.github.*                 # PR list, review, merge, checks. Also exposes
                             # repo-scoped helpers used by the Linear setup flow:
                             # listRepoAutolinks / createRepoAutolink (autolink
                             # references like ADE-* -> Linear), listRepoLabels,
                             # listRepoCollaborators, listRepoIssues. Plus the
                             # ADE-GitHub-App user authorization device flow that
                             # backs hosted webhook-relay reads:
                             # getAppUserAuthStatus / startAppUserDeviceAuth /
                             # pollAppUserDeviceAuth / clearAppUserAuth (start/poll/
                             # clear are CTO-only actions in the ADE Actions registry).
ade.prs.*                    # stacked PR queue, integration, rebase/issue
                             # resolver sessions, and merge readiness
ade.conflicts.*              # risk matrix, simulation, proposals
ade.cto.*                    # identity, agent roster, Linear, and the read-only
                             # `ctoGetAttention` probe (the CTO thread is hidden
                             # from every session roster, so it needs its own
                             # "needs you" signal)
ade.sessions.*               # terminal session CRUD
ade.files.*                  # runtime-routed file workspace/tree/read/write/watch/search actions,
                             # including paginated children, Git decorations, range reads,
                             # blame, and local-only explicit external opens; fallback IPC handlers
                             # run the same fileService code.
ade.agentChat.*              # agent chat sessions, model inventory, parallel launch state.
                             # Includes ade.agentChat.modelCatalog (provider-grouped catalog
                             # used by desktop + TUI + iOS ModelPickers; accepts
                             # `{ mode: "cached"|"refresh-stale"|"force", refreshProvider?: "opencode"|"cursor"|"droid"|"lmstudio"|"ollama" }`)
                             # and ade.agentChat.codex.* goal controls backed by
                             # Codex app-server thread/goal RPCs, plus
                             # provider-neutral recoverTurn and
                             # resolveUnprocessedMessage controls (plus the
                             # legacy recoverCodexTurn compatibility action), and
                             # recoverContinuity (retry_original / recover_from_history /
                             # start_new_chat) for a chat whose provider thread could not be
                             # resumed — see features/storage-and-recovery/README.md. Also includes the typed
                             # createScheduledWork, listScheduledWork, cancelScheduledWork, and
                             # setScheduledWorkPaused mutations; list/get session summaries
                             # project durable nextWakeAt, scheduledWorkPaused, and the
                             # optional KV-backed scheduledWork management snapshot.
ade.personalChats.*          # preload namespace over machine RPC: allowlisted personal-chat
                             # call + cursor event stream. Local/no-project windows target the
                             # local brain; a remote-bound project window targets that remote brain.
                             # The allowlist includes scheduled-work create/cancel/pause so Hub
                             # chat controllers can reuse the shared schedule controls.
modelPicker.*                # cross-surface model favorites/recents backed by
                             # per-project CRR tables (`model_picker_favorites`,
                             # `model_picker_recents`) and shared by desktop,
                             # TUI, and iOS sync commands.
ade.ai.*                     # AI integration status + provider auth (storeApiKey/deleteApiKey/getStatus/updateConfig/...).
                             # ade.ai.isOpenCodeInstalled is a cheap probe (no runtime spin-up)
                             # used to gate the ModelPicker OpenCode rail + Settings install CTA.
                             # OpenCode subscription auth + catalog: opencodeAuthMethods, opencodeOAuthStart /
                             # opencodeOAuthCancel / opencodeOAuthStatus (push), setOpencodeProviderKey, refreshModelsDev.
                             # See features/chat/README.md for the channel table + fan-out wiring.
ade.ai.cursorCloud.*         # Cursor background-agents bridge: listRepositories, listAgents, listRuns, getAgent, createRun, followUp, streamRun, cancelRun, archiveAgent / unarchiveAgent / deleteAgent, listArtifacts / downloadArtifact, openChat (mirror an existing cloud agent into an ADE chat session)
ade.automations.*
ade.orchestration.*          # work-tab orchestration: runCreate, bundleRead, manifestReadSection,
                             # manifestPatch, planAppend, planWrite, spawnAgent, agentInject,
                             # assetRegister, claimTask, subscribe (push). Lead-only planning
                             # and validation transitions are service methods exposed through
                             # orchestration runtime tools, not raw renderer IPC patches.
                             # Preload bridge in
                             # preload/orchestrationBridge.ts; renderer consumes via
                             # components/orchestration/orchestrationDataSource.ts.
ade.tests.*
ade.config.*                 # project config get/save/trust
ade.keybindings.*
ade.sync.*                   # device registry, PIN pairing (getPin/setPin/clearPin), QR payload, lane presence announce (setActiveLanePresence), host transfer
ade.usage.*                  # cached live provider quota reads, explicit quota-only refresh,
                             # adaptive-demand registration, budgets, and a separate
                             # retrospective history/activity refresh path
ade.layout.* / ade.graph.*
ade.computerUse.*
ade.iosSimulator.*           # macOS-only iOS Simulator drawer + Preview Lab: getStatus/launch/shutdown/screenshot/getScreenSnapshot/getInspectorSnapshot/inspectPoint/getPreviewCapability/listPreviewTargets/resolvePreviewMatch/ensurePreviewWorkspace/renderCurrentPreview/renderPreview/openPreviewWorkspace/startStream/stopStream/getStreamStatus/getWindowState/listWindowSources/tap/typeText/drag/swipe/selectPoint, plus the ade.iosSimulator.event push channel
ade.appControl.*             # Electron app control bridge over Chrome DevTools Protocol: getStatus/launch/launchInTerminal/connect/stop/screenshot/getSnapshot/inspectPoint/selectPoint/click/typeText/scroll/dispatchKey/listTargets/attachToTarget, plus the ade.appControl.event push channel (session-started/updated/stopped, selection, screencast frame)
ade.builtInBrowser.*         # in-app web browser owned by `builtInBrowserService`: getStatus/requestOriginAccess/getProfileDiagnostics/listPermissions/clearPermissions/showPanel/setBounds/attachWebview/navigate/createTab/switchTab/closeTab/reload/goBack/goForward/stop/startSession/listSessions/endSession/observe/getTrace/click/typeText/dispatchKey/scroll/fill/clear/wait/startInspect/stopInspect/captureScreenshot/selectPoint/selectCurrent/clearSelection/claim, plus the ade.builtInBrowser.event push channel (status / open-request / selection / selection-cleared / error). Backs the Work sidebar's Browser tab, personal chat's independent tab collection on the global profile, and the renderer-wide `openUrlInAdeBrowser()` link router. Profile diagnostics and permission administration are trusted-renderer-only and rejected on CLI/runtime bridge paths.
ade.terminal.*               # chat-owned terminal control: list/read/write/signal/activeForChat. Resolves a chat's active terminal via chatSessionId so in-chat agents and the App Control panel can drive the visible launch terminal.
ade.update.*                 # check/snapshot/install/cancel plus
                             # machine-local getPreferences/setPreferences
```

### 5.3 Main-process handlers

`apps/desktop/src/main/services/ipc/registerIpc.ts` (~6,400 lines) is the single registration point:

- `ipcMain.handle(IPC.channelName, async (event, args) => { ... })` for invoke channels.
- Every handler is wrapped with a timeout — 30 seconds by default, with explicit longer budgets for known long operations such as direct lane delete, iOS Simulator launch/control, App Control, and built-in browser actions. Runtime-dispatched actions use the runtime-call channel budget; the timeout wrapper no longer inspects the action payload to give `lane.delete` a special runtime-dispatch override.
- Every handler emits structured tracing: `ipc.invoke.begin`, `ipc.invoke.done`, `ipc.invoke.failed` with call ID, channel, window ID, duration, and summarized args/results.
- `AppContext` indirection: handlers close over a context pointer that swaps atomically on project switch, so IPC channels remain registered across project transitions.
- Lane branch-drift handlers (`ade.lanes.getBranchDrift`, `ade.lanes.resolveBranchDrift`) are registered here with the rest of `ade.lanes.*` and delegate to `laneService`. Preload prefers the `lane` runtime action of the same name, so a remote-bound window resolves drift on the machine that owns the worktree and falls back to these handlers only when no runtime is bound.
- **Multi-window shell** — the app can host multiple `BrowserWindow` instances (for example when opening another project in a dedicated window). Handler tracing already carries **window ID** so logs and diagnostics distinguish which renderer surface invoked a channel; `main.ts` ties each window to its **set** of open project roots before routing into services. Two maps in `main.ts` drive this: `windowProjectRoots` tracks the active foreground project per window, and `windowProjectTabRoots` tracks every project root that window currently has open as a tab. Project-scoped event broadcasts (`emitToProjectWindows`) deliver to any window whose active **or** open-tab set contains the project, so background tabs keep receiving live updates. `ade.app.getWindowSession` returns `{ project, binding, openProjectTabs }` for the requesting window; the renderer mirrors its open-tab list back to main with `ade.app.setWindowProjectTabs({ rootPaths })` so the main process can keep those project contexts warm and clean up on window close. Renderer tab switches use cached project/lane snapshots for warm activation, retain caches for every open tab root even if a project is absent from recents, keep Work and Lanes mounted after first visit, and cover cold switches with a project-transition veil.
- **Project context retention.** `MAX_WARM_IDLE_PROJECT_CONTEXTS = 100` is a soft cap for project contexts with no user work. `hasActiveProjectWorkloads(ctx)` protects any context that has live chat sessions (via `agentChatService.hasRetainableSessions()` — any session the user hasn't explicitly closed or deleted, not just mid-turn ones), live PTYs (`ptyService.hasLiveSessions()`), or queued tests. Eviction is best-effort and never tears down a context with work; the cap exists only as a safety valve against opening hundreds of empty projects in a long session.

### 5.4 Event subscriptions (push, not poll)

High-frequency events flow from main → renderer via `webContents.send(channel, payload)`. Partial list:

| Event | Producer | Consumer |
|-------|----------|----------|
| `ade.pty.data` / `ade.pty.exit` | ptyService | TerminalView, Work tab |
| `ade.files.change` | fileWatcherService | Files tree, diff views |
| `ade.tests.event` | testService | Test panel |
| `ade.conflicts.event` | conflictService | Conflicts page, Graph overlay |
| `ade.prs.event` | prPollingService | PRs page, stacked queue |
| `ade.agents.event` | CTO service | CTO tab feed |
| `ade.lanes.lifecycle.event` | laneService / runtime `lane_lifecycle_event` | AppShell toast stack |
| `ade.lanes.rebaseSuggestions.event` / `ade.lanes.autoRebase.event` / `ade.lanes.rebase.event` | rebase services | Lanes + Graph; automated terminal-state rebase outcomes also feed AppShell toasts |
| `ade.project.missing` | projectService | Shell banner |
| `ade.project.state.event` | projectState | Startup flow |
| `ade.sync.*` events | syncService | Top-bar Connections panel |

Renderer telemetry events flow back to main: `renderer.route_change`, `renderer.tab_change`, `renderer.window_error`, `renderer.unhandled_rejection`, `renderer.event_loop_stall`.

---

## 6. Services Catalog (Desktop Client Main Process)

Most services described here live under `apps/desktop/src/main/services/<domain>/` in the desktop client's main process. Some are runtime delegations: they front a runtime-owned subsystem (project registry, sync service, agent registry, credential store, multi-project RPC) through a thin local or remote pool. The runtime-side equivalents live under `apps/ade-cli/src/services/`. Summary:

| Domain | Key files | Role |
|--------|-----------|------|
| `ai/` | `aiIntegrationService.ts`, `authDetector.ts`, `providerConnectionStatus.ts`, `claudeRuntimeProbe.ts`, `modelsDevService.ts`, `compactionEngine.ts`, `tools/*` | Provider routing, detection, tool definitions, compaction. |
| `agentTools/` | `agentToolsService.ts` | Agent tool registry metadata surfaced to the renderer. |
| `analytics/` | `productAnalyticsService.ts`, `productAnalyticsPolicy.ts`, `usageProductAnalyticsExporter.ts`, `dailyUsageAnalytics.ts`, `agentTurnProductAnalytics.ts` | Machine-scoped privacy-bounded product analytics: direct PostHog capture transport, consent/kill switches, closed sanitizer, salted identifier hashing, once-only install/activation milestones, pseudonymous account identification, durable quotas/deduplication, usage-ledger export, and coarse aggregate/work-session producers. See [logging.md](./logging.md). |
| `attention/` | `attentionAccountCoordinator.ts`, `attentionNotchHelper.ts`, `attentionNotchRouter.ts` | Account-first desktop Attention boundary plus the native macOS helper lifecycle. The coordinator reads the relay independently of the selected project/remote binding, permits only an explicit local-machine fallback, and fences mutations by loaded account owner/source revision. The helper consumes the renderer snapshot, reports physical-notch vs menu-bar surface state, preserves empty/error availability, and routes native open/refresh/settings/acknowledgment requests back through typed IPC. Its refresh cadence is keyed off what is actually on screen: 15 s while it has a reported surface and the display is awake, 60 s while it has none or the screen is locked/suspended. `main.ts` feeds that through `setScreenAwake`, tracking `powerMonitor` lock and suspend as independent facts so a resume after a sleep that did not lock cannot declare a locked screen awake. Changing the interval rebuilds the timer, and a respawned child starts with no surface rather than inheriting the previous one's. |
| `appControl/` | `appControlService.ts`, `appControlLaunchCommand.ts` | Chrome DevTools Protocol bridge for developer-owned Electron apps. Launches a chat-owned PTY running the user's dev command (or connects to an existing `--remote-debugging-port`), polls `/json` for ready CDP targets, attaches a long-lived `CdpClient` WebSocket, and exposes screenshot / DOM snapshot / hit-test / click / type / scroll / key dispatch / screencast frames. `appControlLaunchCommand.ts` owns the shell-command detection and debug-flag injection helpers for direct Electron and package-script launches. `inspectPoint` and `selectPoint` produce `AppControlContextItem`s for the chat composer (DOM packet + screenshot + source-file candidates resolved by `findSourceMatches` over an indexed tree of project source files). See [features/computer-use/app-control.md](./features/computer-use/app-control.md). |
| `builtInBrowser/` | `builtInBrowserService.ts`, `builtInBrowserAgentAccess.ts`, `builtInBrowserActorCapabilities.ts`, `builtInBrowserAuthentication.ts`, `builtInBrowserProfileMigration.ts`, `builtInBrowserStateStore.ts`, `builtInBrowserNavigation.ts`, `builtInBrowserPermissions.ts`, `builtInBrowserWebAuthn.ts`, `desktopBridgeServer.ts` | In-app web browser owned by the main process. Every remote-content `WebContentsView` uses the single persistent `persist:ade-browser` storage profile (`storageProfileKey: "global"`), while service keys combine the ADE window id with a project/window/personal tab-collection key so visible tabs stay independent. Project roots route project commands and scratch observations; validated personal commands retain the personal tab collection and use the channel-specific machine-local browser-observation scratch root. Neither route partitions cookies or site storage. On first use, a bounded, idempotent migration copies unexpired persistent cookies from this channel's legacy project-derived partitions into the global profile without overwriting global cookies or copying session cookies; it preserves the old partition directories because Chromium DOM storage, IndexedDB, service-worker state, and WebAuthn credentials cannot be safely merged across partitions. The bounded machine-local state store restores HTTP(S)/blank tab URLs and the active tab for each collection, but never restores agent leases, lightweight browser sessions, or synthetic session cookies. The service caps each collection at 10 tabs, routes global-session network events back to their owning collection, drives OAuth popups and downloads, and emits targeted events. HTTP/proxy authentication uses a sandboxed, local credential prompt and passes values directly to Chromium without persisting or logging them; client-certificate requests use an explicit native chooser and only accept a certificate Electron offered. Permission requests are deny-by-default, limited to managed browser web contents and secure origins, and use persisted per-origin/embedding-origin decisions with a native human prompt; only Google's `storage-access` and `top-level-storage-access` requests retain a narrow accounts-domain compatibility exception. The Browser toolbar's trusted-renderer Profile panel exposes non-secret cookie/cache/flush diagnostics and list/remove/clear controls for remembered permission decisions; these operations are not bridged to agents or unbound CLI callers. A separate non-persistent agent-access controller requires a per-chat/lane native human grant for every non-local origin and for local origins with allowed privileged permissions; cross-origin navigations and redirects are intercepted, and sensitive popups are blocked until explicitly approved. The grant follows the agent-owned tab without a timer and clears only when an explicit trusted-renderer navigation reclaims the tab. Tabs carry owner/lease metadata. ADE-launched chats receive opaque in-memory browser actor capabilities bound to their trusted chat/lane/project or personal collection. The runtime requires the token and strips caller routing; Electron validates it in the issuing process, restores only the bound scope, forces `force: false`, and separately authenticates the bridge with the desktop launch's rotating token. Agents cannot force or impersonate a takeover, read another agent's tab status, inspect global cookie-domain diagnostics, or administer permissions. Browser sessions bind one workflow to one tab. Project observations live under `.ade/cache/browser-observations/`; personal observations live under the channel user-data `browser-observations/personal/` root, which is narrowly allowlisted for proof promotion. The issuer-restored scope selects the matching independent tab collection. Navigation/protocol policy lives in `builtInBrowserNavigation.ts`; WebAuthn account selection lives in `builtInBrowserWebAuthn.ts`. |
| `automations/` | `automationService.ts`, `automationPlannerService.ts`, `automationIngressService.ts`, `automationSecretService.ts` | Rule lifecycle, NL → rule planner, inbound triggers, per-rule secrets. |
| `chat/` | `agentChatService.ts`, `promptStashService.ts`, `chatScheduledWorkScheduler.ts`, `runtimeEvents.ts`, `claudeStructuredActivity.ts`, `openCodeStructuredActivity.ts`, `codexMcpElicitation.ts`, `buildClaudeV2Message.ts`, `markdownSlashCommandDiscovery.ts`, `claudeSlashCommandDiscovery.ts`, `codexSlashCommandDiscovery.ts`, `cursorSlashCommandDiscovery.ts`, `projectSlashCommandDiscovery.ts`, `slashCommandPromptExpansion.ts`, `cursorSdk*` (`cursorSdkPool.ts`, `cursorSdkWorker.ts`, `cursorSdkProtocol.ts`, `cursorSdkPolicy.ts`, `cursorSdkSystemPrompt.ts`, `cursorSdkEventMapper.ts`, `cursorSdkErrors.ts`), `droidSdkEventMapper.ts`, `sessionRecovery.ts` | Agent chat sessions (lane-scoped + orchestration worker/coordinator). Builds Claude messages, hosts the Cursor SDK in a Node worker pool with official local-store persistence, formalizes the cross-runtime event vocabulary, normalizes provider-native web/MCP/image activity into compact shared events, persists accepted/processed/unprocessed message delivery, owns the runtime-backed 20-entry desktop prompt stash, emits provider-neutral turn health/recovery/diagnostics, aggregates moderation checks quietly, handles Codex app-server MCP elicitations, recovers sessions on restart, derives prompt-based lane names for parallel model launches, keeps Claude Agent SDK streams alive for scheduled wake/cron/background work after visible turns, emits transcript retractions for provider-superseded assistant rows, and manages Codex app-server goals with persisted, unlimited-budget session state. Spawned-subagent completion is live parent context rather than scheduled work: active Claude parents receive SDK `priority: "next"` and active Codex parents receive `turn/steer`, including while awaiting input; other active providers use the existing provider-normalized steer fallback, while idle parents use the normal message path. Scheduled work stays distinct and boundary-delivered. `chat.createScheduledWork` validates a five-field cron plus a bounded prompt and writes an ADE-owned recurring or one-shot row for any chat provider runtime or ADE-tracked provider CLI. Claude remains authoritative for provider schedule tool success and canonical ids, while ADE's store is authoritative for delivery: successful `PostToolUse` mirrors `ScheduleWakeup`, every successful `CronCreate`, and `/loop` records in `kv`, and scopes Stop/SubagentStop reconciliation to the exact provider-session owner so a new session's empty snapshot preserves prior-owner rows. `durable: true` persists Claude's provider copy, but the SDK's schedule view remains advisory; ADE state wins. The SDK gets the native fire opportunity at `fireAt`; ADE's timer waits through a 90-second grace window before backstopping a skipped or unavailable provider. A native claim requires an explicit SDK cron-task start; an exact provider id wins when present, while older ambiguous task events may claim only the earliest due CronCreate-owned row and can never consume a `ScheduleWakeup` or loop. Every managed chat row that becomes due during a foreground Claude, Codex, Cursor, Droid, or OpenCode turn stays armed and retries after 20 seconds rather than entering that turn's disposable input queue; only an actual delivery advances a cron, and expiry still wins. At an idle chat boundary the scheduler sends `messageSession(kind: "wake")`. Tracked CLI rows wait for a provider-specific visible composer boundary, resume ended sessions, and retry proven pre-delivery failures without consuming the occurrence. The scheduler restores timers, coalesces missed occurrences to one late fire, applies session/global pause state, cold-starts idle chats when necessary, expires recurring crons after seven days, and emits lifecycle rows while summaries and `chat.getScheduledWorkState` expose management state. Cancellation of Claude-owned jobs routes through `CronDelete` and remains visible until provider confirmation; ADE-owned rows cancel directly. There is no scheduled-work-specific spend cap. |
| `computerUse/` | `computerUseArtifactBrokerService.ts`, `controlPlane.ts`, `localComputerUse.ts`, `syntheticToolResult.ts` | Proof-artifact broker (batch-safe ingest, owner/lane attribution, availability, deletion/recovery, compatibility review state, and artifact-root-confined preview reads capped at 10 MiB), control-plane snapshot helpers, macOS capture capability descriptor, and the synthetic-tool-result helper used by the Claude compaction path. `proofObserver.ts` and the agent-browser manifest adapter were removed — there is no passive auto-ingest or payload-shape parser. Direct Codex Computer Use executable resolution lives outside this folder in `main/utils/codexComputerUse.ts` because it configures provider runtimes rather than ingesting proof. |
| `config/` | `projectConfigService.ts`, `laneOverlayMatcher.ts` | Load/save `.ade/ade.yaml` + `local.yaml`; trust enforcement; lane overlays. |
| `conflicts/` | `conflictService.ts` | Pairwise dry-merge simulation, risk matrix, proposal generation. |
| `cto/` | `ctoStateService.ts`, `ctoMemoryService.ts`, `ctoPromptContent.ts`, `linearClient.ts`, `linearIssueTracker.ts`, `linearCredentialService.ts`, `linearOAuthService.ts`, `linearTokenRefresh.ts`, `linearLaneCardService.ts`, `linearLiveStatusService.ts` | CTO identity, the smart-memory file store, session logs, and the Linear read/credential/OAuth surface. `linearLaneCardService` posts the Linear attachment card and builds the cross-machine ADE deeplink that backs the card's URL; `linearLiveStatusService` is the optional launch/PR/merge status round-trip. |
| `deeplinks/` | `protocolHandler.ts` | Registers the `ade://` OS protocol handler for the packaged Stable desktop build, owns the single-instance lock, buffers cold-start URLs until `app.whenReady()`, and dispatches parsed URLs through `IPC.appNavigate` to the focused window. Beta, Alpha, and source builds can receive explicitly delivered links but do not claim the OS-default handler. Re-used by the iOS Send-to-Mac sync command (`syncRemoteCommandService.deeplinks.open`). Shared parser + builder live in `apps/desktop/src/shared/deeplinks.ts`; the PR "Open in ADE" footer is in `apps/desktop/src/shared/adeDeeplinkFooter.ts`. See [features/deeplinks/README.md](./features/deeplinks/README.md). |
| `devTools/` | `devToolsService.ts` | Probe for git + `gh` CLI availability. |
| `diffs/` | `diffService.ts` | Diff computation for file panes. |
| `feedback/` | `feedbackReporterService.ts` | In-app feedback reporting. Two-stage: `prepareDraft` generates a structured issue title + labels (AI-assisted when a model is selected, deterministic fallback otherwise) so the user can review before posting; `submitPreparedDraft` files the GitHub issue. Each submission records `generationMode` and a `generationWarning` so the UI can flag deterministic drafts. |
| `files/` | `fileService.ts`, `fileWatcherService.ts`, `fileSearchIndexService.ts` | Workspace file tree, read/write, watch, index. |
| `git/` | `git.ts`, `gitOperationsService.ts`, `gitConflictState.ts` | Low-level git runner, high-level lane-scoped ops, conflict state queries. |
| `github/` | `githubService.ts` | GitHub REST/GraphQL access; PR CRUD; checks; reviewers. |
| `history/` | `operationService.ts` | Operation audit records (one row per mutation). |
| `ios/` | `iosSimulatorService.ts` | macOS-only iOS Simulator backend: tool readiness probes, simctl device + app discovery, build/install/launch with progress events (hardened with `simctl bootstatus` and `simctl install` timeouts), screenshot + ADEInspector + accessibility hit-test, Simulator.app window live-view status, idb-backed input, and single-owner chat session locking. The macOS Simulator window placement / capture state probe (`getSimulatorWindowState`, `prepareSimulatorWindowForCapture`) lives next to the IPC handlers in `ipc/registerIpc.ts` because it depends on the active `BrowserWindow`. See [features/ios-simulator/README.md](./features/ios-simulator/README.md). |
| `ipc/` | `registerIpc.ts`, `runtimeBridge.ts`, `ipcTimeouts.ts` | Single registration point for all IPC handlers. `runtimeBridge.ts` owns the runtime-facing channels (remote target registry, remote-runtime connect / project list / project-open / action dispatch / sync dispatch / event stream, per-target `listActionRegistry` lookup against the remote daemon, LAN + Tailscale discovery with diagnostics) and routes runtime calls through `LocalRuntimeConnectionPool` or `RemoteConnectionPool` based on the active window binding. The explicit `ade.sync.getLocalStatus` handler is the exception: it calls machine-level `sync.getStatus` on `LocalRuntimeConnectionPool` (with only the local in-process diagnostics service as fallback) so a remote-bound Connections panel can still identify the physical Mac (its This Mac card, pairing code, and local Phone/Web device lists). Device and pairing *mutations* still follow the window binding, so the panel presents them read-only while remote-bound rather than routing them to the remote machine. Event-stream subscription init/results preserve replay-gap metadata (`gap`, `oldestCursor`, `eventEpoch`) for both local and remote bindings. Remote project opens are generation-guarded per window/webContents before main persists the binding. It also subscribes `powerMonitor` `resume` and `unlock-screen` to `remoteConnectionService.probeSavedConnections()` so a laptop waking up cycles dead SSH sessions before the renderer pokes them. Machine-level sync fallback recognizes only the canonical unavailable-service predicates in `shared/runtimeErrors.ts`, shared with preload and renderer recovery guidance. `ipcTimeouts.ts` carries the default 30-second handler timeout plus named channel-level overrides for long direct IPC operations; it does not inspect runtime action payloads. |
| `jobs/` | `jobEngine.ts` | Event-driven background scheduler for lane refresh + conflict prediction. Coalesced, debounced. |
| `keybindings/` | `keybindingsService.ts` | User keybindings read/write. |
| `lanes/` | `laneService.ts`, `laneEnvironmentService.ts`, `laneTemplateService.ts`, `laneProxyService.ts`, `portAllocationService.ts`, `autoRebaseService.ts`, `rebaseSuggestionService.ts`, `laneLaunchContext.ts`, `oauthRedirectService.ts`, `runtimeDiagnosticsService.ts` | Worktree lifecycle, env bootstrap, templates, reverse proxy, port leases, auto-rebase, suggestions, OAuth redirect, diagnostics. |
| `logging/` | `logger.ts` | File-backed structured logger. |
| `localRuntime/` | `localRuntimeConnectionPool.ts` | Desktop-side client for the local brain endpoint. Spawns or attaches to the machine endpoint, registers local projects with `projects.add`, dispatches local runtime actions with per-call timeouts where needed, emits `local_runtime.action_slow` warn logs (with `ensureProjectMs` / `connectMs` / `daemonCallMs` breakdown) whenever a call exceeds 500 ms or throws and aggregates those calls into a bounded rolling 24 h window exposed as `getRuntimeHealth()` (count + p95) for the `ade.app.getRuntimeHealth` IPC / Storage diagnostics tile, polls/subscribes to runtime events while preserving `eventEpoch`/gap metadata, and installs the background service best-effort in packaged builds. `callSync` takes a per-call `timeoutMs` so a caller standing in for a live stream can opt out of the long default; `callAttention` uses it to run every Attention poll under the 30 s sync-domain timeout, because a snapshot poll inheriting the ten-minute action budget pins the renderer on syncing long after the account stream has wedged. |
| `onboarding/` | `onboardingService.ts`, `onboardingSuggestedConfig.ts` | First-run flow, defaults detection, existing lane discovery. `onboardingSuggestedConfig.ts` contains pure workflow parsing and suggested `.ade/ade.yaml` generation. |
| `opencode/` | `openCodeRuntime.ts`, `openCodeServerManager.ts`, `openCodeBinaryManager.ts`, `openCodeInventory.ts`, `openCodeModelCatalog.ts` | OpenCode server spawn, binary resolution, model discovery. |
| `orchestration/` | `orchestrationService.ts`, `applyPatches.ts`, `patchPolicy.ts`, `manifestNormalization.ts`, `runtimeProfile.ts` | Work-tab orchestration for multi-phase plans. `orchestrationService` manages run lifecycle, manifest persistence, the `leadState.planning` state machine, `plan.md`, validation strategy/findings, asset bundles, the `lineage` delegation ledger (lead→worker/validator spawn + result edges), and two service-owned durability records: a `receipts` idempotency ledger and a transactional `outbox` chat-delivery queue. Receipts key on a per-request idempotency key so a retried `spawnAgent`/`messageAgent` replays its original result instead of double-spawning; the outbox holds `brief`/`ping`/`lead_status`/`cancel_interrupt`/`completion` deliveries that are written atomically with the state transition that produced them (a worker/validator reaching a terminal state enqueues a `completion` entry in the same transaction) and drained event-driven with bounded backoff, so the lead can never miss a completion. Worker/validator completion is event-driven (no transcript polling), heartbeats coalesce and a stall sweep flips `agent.stalled` for silent-but-`running` workers with a single plain-language lead notification, and cancellation reaches native worker processes. Runs also carry a per-run `finishing` decision (`worktree` vs. push-PR-and-update-Linear), a `goalSource`, `scheduledFollowups`, a declared `capabilities` policy, and evidence asset kinds (`proof_artifact`/`computer_use`/`video`/`pr_link`/`linear_issue`/`deeplink`) with `externalRef` + `registeredBySessionId`. `patchPolicy` keeps privileged fields (`leadState.planning`, `planSpec`, the `/lineage` ledger, and the `/receipts` + `/outbox` records) behind service methods so the lead cannot forge intake, planning rounds, model routing, approval readiness, delegation edges, or delivery/idempotency state with a raw patch. `runtimeProfile` resolves the active orchestration profile per session and gates model selection / plan approval on planning readiness. The renderer surfaces live in `renderer/components/orchestration/` (see §7.3). The former `orchestrator/` and `missions/` directories were consolidated into this service. |
| `projects/` | `adeProjectService.ts`, `configReloadService.ts`, `projectService.ts`, `logIntegrityService.ts`, `recentProjectSummary.ts`, `projectBrowserService.ts`, `projectDetailService.ts` | Project detection + `.ade` repair/bootstrap, reload on config change, recent-project metadata. `recentProjectSummary.ts` emits local and remote recent summaries without disk-inspecting remote paths, and attaches each local checkout's `origin` URL — read straight from git config rather than by spawning `git` per recent, undecorated the way git parses config values, resolved through a linked worktree's metadata dir back to the main repo's config, and cached per root on the config file's mtime. That URL is the key the renderer's top bar joins local and remote checkouts of one repository on. `projectBrowserService` is the in-app directory autocomplete used by the Command Palette project browser (typed-path completion, `.git` detection, home expansion, system-picker fallback); `projectDetailService` returns repo metadata (branch, dirty count plus staged/unstaged/untracked breakdown, ahead/behind, last commit, README excerpt inputs, language mix, lane count, last-opened) for the palette's preview pane. |
| `prs/` | `prService.ts`, `prPollingService.ts`, `prSummaryService.ts`, `githubPrStackService.ts`, `prIssueResolver.ts`, `prRebaseResolver.ts`, `integrationPlanning.ts`, `integrationValidation.ts` | PR CRUD, polling (with per-PR `last_polled_at` cursor), AI summary cache keyed by `(prId, head_sha)`, native GitHub stack reconciliation, AI-assisted issue resolution, rebase resolution, integration planning, and merge-into-existing-lane proposal adoption. |
| `pty/` | `ptyService.ts` | `node-pty` spawn, PTY I/O bridging, transcript writing. |
| `remoteRuntime/` | `remoteTargetRegistry.ts`, `sshTransport.ts`, `remoteBootstrap.ts`, `remoteConnectionPool.ts`, `remoteConnectionService.ts`, `runtimeRpcClient.ts`, `runtimeDiscovery.ts` | Saved SSH machines (manual host + alternate `routes[]` with `lastSucceededAt` and manual-disconnect state), ssh-agent/key transport with bounded connect/exec timeouts and multi-route fallback, first-connect runtime upload/version/SHA verification with channel-home fallback (`.ade` / `.ade-alpha` / `.ade-beta`) and capability/version skew demoted from fatal errors to `RemoteRuntimeConnectResult.compatibilityWarnings`, remote project catalog, action dispatch (with a `projects.*` capability gate against `RemoteRuntimeCapabilities.machineProjects`), handoff storage/Git preflight, route-pinned sensitive calls, local TCP forwards for remote preview ports, reconnect/eviction with pool eviction listeners and implicit reconnect backoff, `powerMonitor` resume probe, and LAN + Tailscale discovery that returns diagnostics alongside machines. The JSON-RPC client formats remote errors with the original method name plus the JSON-RPC `code` / `message` / `data` for clearer diagnostics. See [Cross-machine session handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md). |
| `runtime/` | `tempCleanupService.ts`, `processRegistryService.ts`, `machineStateMigration.ts`, `packagedNodePath.ts`, `lastFailureStore.ts`, `projectRecoveryService.ts` | Runtime temp cleanup. `processRegistryService` is the per-process heartbeat registrar against machine-local `runtime_processes` (see §3.4); reconcile/dispose paths in `sessionService` and `ptyService` consult live and known owner sets before sweeping `terminal_sessions` rows so sibling processes and synced remote-machine owners are preserved. `machineStateMigration` carries one-shot migrations of the per-machine state files under `~/.ade/`. `packagedNodePath.ts` centralizes the `Resources/app*.asar(.unpacked)/node_modules` search path used by packaged runtime children. `lastFailureStore` records bounded typed project/machine failure reports and crash-loop backoff; `projectRecoveryService` runs the brain-independent diagnose/repair sequence behind `ade.recovery.*` (see [features/storage-and-recovery/README.md](./features/storage-and-recovery/README.md)). |
| `search/` | `searchService.ts`, `searchIndexDb.ts`, `searchQueryParser.ts`, `searchRanking.ts`, `terminalChunking.ts`, `searchServiceWiring.ts` | Universal search over chat/terminal/PR/commit/branch text via a disposable FTS5 index (`.ade/cache/search-index.db`, never inside `ade.db`, never synced), unioned at query time with delegated lanes/files/artifacts/Linear. Accepted chat messages own the searchable document while processed/unprocessed events remain lifecycle-only; an exact `session:<id>` query reads live ownership state, overrides stale same-document FTS metadata, and deduplicates totals. Debounced off-hot-path ingestion with cursor-based incremental reads, deterministic ranking tiers, and the `search` ADE action domain (`query`/`indexStatus`/`rebuildIndex`). `searchServiceWiring.ts` is shared with the `ade` runtime so wiring can't drift. See [features/search/README.md](./features/search/README.md). |
| `sessions/` | `sessionService.ts`, `sessionDeltaService.ts`, `chatSessionProjection.ts`, `settleTerminalSession.ts` | Terminal session CRUD, post-session delta computation, provider-chat runtime projection onto resumable terminal rows, and the atomic settle/dismiss-pending-input boundary shared by IPC and ADE actions. |
| `shared/` | `utils.ts`, `imageDimensions.ts`, `remoteTrackingBranch.ts`, `packLegacyUtils.ts`, `transcriptInsights.ts` | Cross-domain utilities, including shared record guards, remote tracking-branch refresh, and PNG/JPEG dimension parsing used by App Control and iOS Simulator capture paths. |
| `state/` | `kvDb.ts`, `crsqliteExtension.ts`, `dbMaintenanceApi.ts`, `globalState.ts`, `projectState.ts`, `onConflictAudit.ts` | SQLite schema + open (WAL + `synchronous = NORMAL`), CRR extension loader, global state file, per-project state init. The desktop's Electron user-data `ade-state.json` holds machine-local shell state, including `AutoUpdatePreferences`; missing or malformed preference fields normalize to automatic installation off and idle-only safety on. `kvDb` also attaches the optional `maintenance` (`DbMaintenanceApi`) handle — retention prunes, zero-peers-only cr-sqlite compaction, and fragmentation-gated vacuum — whose interface and shared retention constants live in `dbMaintenanceApi.ts` and are invoked by the storage doctor. `globalState.upsertRecentProject` accepts `preserveRecentOrder` so reactivating an already-known project (by app focus, deep link, etc.) refreshes its `lastOpenedAt` in place instead of jumping it to the front of the recents list. Recent projects use stable keys: local rows are keyed by absolute root path, remote rows by `remote:<targetId>:<projectId>`, so a remote path string never collides with a local project. Pinned rows are retained above normal recency ordering and survive beyond the cap. `model_picker_favorites` and `model_picker_recents` are per-project CRR tables shared by desktop, TUI, and iOS; they are primary-key-only so CRR can convert them, with the recents cap enforced in `modelPickerStore.ts`. `AdeDb.sync.discardUnpublishedChangesForTables(tableNames)` lets a service clear local CRR state for specific tables without leaking those clears to sync peers — it records the cleared tables and `through_db_version` in the local-only `local_crr_change_suppressions` table, and `exportChangesSince` filters local-site rows for those tables at or below that version on the way out. The local-only excluded set (still kept out of replication) includes that suppression table itself, the snapshot caches, `local_worktree_residual_cleanups`, `pr_auto_link_ignores`, `pull_request_ai_summaries`, and `runtime_processes`. `crsql_changes` DELETE statements run through a helper that swallows the read-only-table error the cr-sqlite extension raises when a CRR-managed table is wiped, with a `db.crr_changes_cleanup_skipped` warn log instead of failing the migration. |
| `sync/` | `syncService.ts`, `syncHostService.ts`, `syncPeerService.ts`, `syncRemoteCommandService.ts`, `syncProtocol.ts`, `deviceRegistryService.ts`, `syncPairingStore.ts` | **Thin delegation to the ADE runtime's sync service.** The authoritative sync service now lives in `apps/ade-cli/src/services/sync/`; the desktop main-process instances default to a non-host viewer role for legacy state and tests. The old in-process host is disabled unless `ADE_ENABLE_DESKTOP_SYNC_HOST=1` (diagnostics only). Wire formats — WebSocket envelope, remote command routing, device registry, pairing secrets — are the same across both implementations. Viewer joins clear the local `devices` + `sync_cluster_state` rows and then call `db.sync.discardUnpublishedChangesForTables(["devices", "sync_cluster_state"])` so the resulting DELETE rows do not leak back to other peers; the peer client follows up with `syncPeerService.acknowledgeLocalDbVersion()` to advance the outbound cursor past the suppressed range. |
| `tests/` | `testService.ts` | Test-suite execution + run history. |
| `updates/` | `autoUpdateService.ts`, `autoUpdateVersions.ts` | Electron auto-update wrapper around `electron-updater`. Owns the renderer-visible `AutoUpdateSnapshot` (`idle \| checking \| downloading \| ready \| installing \| error`, plus `currentVersion` / `latestKnownVersion` for the truthful-version surfaces), uses `compareUpdateVersions` (the SemVer-aware comparator in `autoUpdateVersions.ts`) to dedupe / supersede staged installers and to reconcile `pendingInstallUpdate` against the running version on next boot. Packaged builds schedule startup/periodic checks and downloads; source/dev launches construct the service without auto-check timers so missing `app-update.yml` never surfaces as a renderer error. ADE manually starts downloads after a cache-volume capacity preflight, checks the installed-app volume again before staging, classifies disk/quota/network/verification/permission/installer failures in the shared snapshot, preserves verified downloads when safe, and bounds the native installer handoff with a watchdog. The install is transactional: `quitAndInstall()` re-checks the staged version, and a consent that aborts before the native updater takes over lands in `snapshot.parked` (a typed `AutoUpdateInstallAbortReason`) so the exceptional shell banner offers a retry instead of silently losing the update; ordinary ready state remains in the top-right control. Restarting automatically is a separate machine-local `AutoUpdatePreferences` policy and defaults off. When enabled, its default-on idle safety waits for no active agent turns or work sessions (`RuntimeActivitySummary.idle`) before the grace period and renderer-visible countdown (`autoApplyPending`); users can opt into starting the countdown immediately instead. Cancel suppresses the next countdown (`autoApplySuppressedUntil`), disabling the preference clears it, and `ADE_DISABLE_AUTO_UPDATE_APPLY=1` is the process-level kill switch. `autoUpdateVersions.ts` also builds the changelog (`buildReleaseNotesUrl`) and GitHub release (`buildGithubReleaseUrl`) links. See [desktop auto-update disk-space behavior](./features/onboarding-and-settings/desktop-auto-update.md). |
| `storage/` | `diskPressure.ts`, `volume.ts`, `storageInsightsService.ts`, `historyCompression.ts`, `storageLedger.ts`, `storageDbBreakdown.ts`, `storageMaintenanceJournal.ts` | Disk-full/recovery hardening + the storage doctor. `diskPressure` samples all ADE storage roots, classifies pressure with recovery hysteresis, and gates write-producing operation classes via `canPerform(kind)` (enforced at each start boundary in `agentChatService` / `ptyService` and the compressor). `storageInsightsService` builds the categorized Settings > Storage snapshot and preview-confirmed, link-safe cleanup, and runs the scheduled **storage doctor** maintenance sweep (`runMaintenanceNow` + post-boot/daily timers) that compresses history, reaps safe staging/backups/iOS build data, and invokes the kvDb DB-maintenance hooks. `storageLedger` is the declared bounding policy for every table/directory (with a CI coverage cross-check against `ADE_LAYOUT_DEFINITIONS`); `storageDbBreakdown` maps `dbstat` rows into the project-database breakdown; `storageMaintenanceJournal` reads/writes the 30-run doctor journal. `historyCompression` losslessly gzip-compresses inactive old transcripts/logs after byte-identity verification and exposes the transparent `.gz` read/reinflate helpers. Constructed in both `main.ts` and the `ade` runtime `bootstrap.ts`. See [features/storage-and-recovery/README.md](./features/storage-and-recovery/README.md). |
| `usage/` | `usageTrackingService.ts`, `providerQuotaParsers.ts`, `usageStatsStore.ts`, `usageLedgerWorkerClient.ts`, `budgetCapService.ts`, `ledgers/localUsageLedgers.ts` | Live provider quota/cost accounting, budget enforcement, and retrospective activity stats. `usageTrackingService.ts` owns polling, pacing, provider/GitHub cache orchestration, and `getAdeUsageStats`; `providerQuotaParsers.ts` normalizes Claude and Codex quota payload variants and classifies Codex windows by advertised duration rather than assuming the provider's primary/secondary positions. The stats read returns cached expensive sources plus live project-DB aggregates immediately, marks the result `refreshing` when stale, and revalidates provider ledgers / GitHub in the background. Expensive local-ledger aggregation runs through `usageLedgerWorkerClient.ts` in a separate process so it cannot block terminal input, project switching, or sync; packaged desktop/CLI builds ship a sidecar while the static runtime uses the equivalent embedded entrypoint. `usageStatsStore.ts` aggregates AI calls, sessions, lanes, code movement, artifacts, automations, workers, streaks, and the local-only cross-client `usage_events` ledger. Local provider scanners live under `usage/ledgers/`. Budget caps can match a rule scope while `usd-per-run` evaluates usage records keyed to the active run id. For runtime-backed projects, the machine brain is the sole quota poller and the renderer consumes its pushed snapshot; `main.ts` does not start a competing project-context tracker. Threshold state remains shared at module level for the unbound/local contexts, and `main.ts` adds a final IPC-level dedup gate with a 10-minute TTL per `provider:threshold:resetCycle` key. |
| `perf/` | `perfLog.ts`, `perfIpc.ts`, `metricsSampler.ts`, `aggregator.ts` | Opt-in local performance harness. `ADE_PERF_RUN_ID` opens a JSONL event log, samples Electron process metrics, records IPC durations, accepts renderer perf marks/web-vitals, and aggregates each run into `summary.json`. |

**Cross-cutting personal-chat paths.** Personal chat reuses `chat/agentChatService.ts` with `surface: "personal"`, a light session profile, a neutral general-assistant prompt, project/lane environment variables removed, and project slash-command/ADE-guidance injection disabled. The hidden runtime also disables project push publication. Desktop Browser calls from that surface pass `tabCollection: "personal"`; `builtInBrowserService.ts` uses it only to select an independent visible tab collection. The persistent authentication partition remains global. See [Personal chats](./features/personal-chats/README.md) for the complete source map and invariants.

Startup sequencing: every background service goes through `scheduleBackgroundProjectTask()` in `main.ts`, which provides explicit labels, `ADE_ENABLE_*` env gates, `project.startup_task_begin`/`_done`/`_enabled`/`_skipped` telemetry, and per-task delays. Integrations stay **dormant-until-configured**.

Project-init step timing goes through `measureProjectInitStep(step, task)` — a wrapper that logs `project.init_step { projectRoot, step, durationMs }` around each hot-path operation (`db_open`, `lane.ensure_primary`, `ade_rpc.socket_server_start`, `sync.initialize`, etc.) so cold-start latency shows up in the logs by phase. Sync-service initialization is scheduled through `scheduleBackgroundProjectTask` rather than awaited inline, gated by `ADE_ENABLE_SYNC_INIT`.

Shutdown pipeline: `main.ts` owns a single `requestAppShutdown({ reason, exitCode, fastKillFirst?, forceAfterMs? })` path driving a central state machine (`shutdownRequested` → `shutdownPromise` → `shutdownFinalized`). Hooks into `before-quit`, `window close`, `SIGINT`, `SIGTERM`, `process.exit`, `will-quit`, and `uncaughtException` all funnel through it. Before browser webContents are disposed, shutdown awaits the tab-state/permission write chains, `cookies.flushStore()`, and `session.flushStorageData()` for `persist:ade-browser`; failures are logged without credential values and cleanup continues. `runImmediateProcessCleanup()` disposes automations, tests, PTYs, agent chat runtimes, DB flush, and then calls `shutdownOpenCodeServers()`. A `forceAfterMs` timer (default 8 s, 5 s for signals/uncaught) hard-exits if cleanup hangs. User-initiated quit (main window close or `before-quit`) routes through `confirmQuitWarning()` — a modal dialog that explains that quitting will end agents and background processes owned by the desktop session, including OpenCode servers, terminal sessions, and test runs.

Crash-resistance at the process boundary: `main.ts` installs an `error` listener on `process.stdout` and `process.stderr` before any other module loads, and adds `EPIPE` / `ERR_STREAM_DESTROYED` to the set of `uncaughtException` codes that are swallowed (alongside the `EMFILE` / `ENFILE` file-limit codes). When ADE is launched from a terminal and that terminal goes away, the next write to stdout or stderr raises `EPIPE`; without a listener Node surfaces it as an `uncaughtException`, which funnels into `requestAppShutdown` and tears the whole app down. A dead logging pipe must never kill the app. Any other stream error is still re-thrown.

On startup the main process also invokes `recoverManagedOpenCodeOrphans({ force: true })` (see `services/opencode/openCodeServerManager.ts`) to reap previous-run OpenCode processes left behind after a crash. Orphan detection matches processes by the managed marker env (`ADE_OPENCODE_MANAGED=1`) and/or the shared XDG config root, and confirms orphaning either by dead owner PID (`ADE_OPENCODE_OWNER_PID`) or reparent-to-init. Each acquire of a shared OpenCode server also invokes `pruneIdleSharedEntries()` which compacts idle entries from older configs (`pool_compaction` reason).

---

## 7. UI Framework

### 7.1 Stack

| Layer | Tech |
|-------|------|
| Framework | React 18 |
| Language | TypeScript |
| Router | React Router |
| State | Zustand (global + per-domain) |
| Styling | Tailwind CSS 4 + CSS custom properties |
| Primitives | Radix UI |
| Icons | Lucide React |
| Terminal | xterm.js |
| Editor/Diff | Monaco Editor |
| Graph canvas | React Flow |
| Pane layouts | `react-resizable-panels`, in-house `PaneTilingLayout` |
| Virtualization | `@tanstack/react-virtual` |

Electron renderer runtime does **not** wrap the app in `React.StrictMode`. Browser-mock development (outside Electron) still uses Strict Mode. The app uses `BrowserRouter` on normal `http(s)` origins and `HashRouter` inside Electron/file-like contexts; `App.tsx` also bridges legacy `#/route` fragments into BrowserRouter paths so old ADE deep links keep working in the browser-hosted dev shell.

### 7.2 Global store

`apps/desktop/src/renderer/state/appStore.ts` — Zustand store holding project, lanes, selected lane, theme, provider mode, keybindings, per-project work-view state. Built as a `createStore<AppState>()(createAppState)` factory so multiple stores can be instantiated; the module exposes a default `rootAppStore` plus a per-project factory and React context:

- `createProjectAppStore(project, projectBinding?)` returns a fresh per-surface store pre-hydrated with the local or remote project binding, any binding-scoped Work/lane/session snapshot, and a copy of root-store user preferences. It re-reads that project's persisted Work/lane scopes directly from storage rather than trusting the root store's older copied maps. Setters for theme/terminal/chat preferences point at the root store so user preferences mutate in one place and are then mirrored into every project store via `hydrateProjectAppStore` whenever `rootPrefs` change in `ProjectTabHost`. This is what lets two open project tabs share a theme even though they have independent lane/chat state.
- `AppStoreProvider` + `AppStoreContext` scope the active store to a `ProjectSurface` subtree. The `useAppStore` hook reads from `useContext(AppStoreContext) ?? rootAppStore`, and `useAppStoreApi()` returns the bare `StoreApi` for components that want imperative `getState()` access without subscribing. `useAppStore.getState / setState / subscribe` still point at the root store so code that needs cross-window globals (recent projects, user preferences, the root binding) can continue to call it directly.
- Narrow selectors on components to minimize re-renders.
- `refreshLanes` accepts independent lane-status and lane-snapshot flags. Callers can refresh cheap runtime snapshot decorations without recomputing git status, or update git status without rebuilding conflict/rebase/auto-rebase overlays; statusless refreshes preserve the previous `LaneStatus`/`parentStatus` in store so the UI does not flicker to unknown git state.
- Per-project work-view state keyed by project identity (`WorkProjectViewState`): local bindings use their root path, while remote bindings use `OpenProjectBinding.key` (`remote:<targetId>:<projectId>`). Alongside Work filters, collapsed section ids, and right-sidebar state, version 3 includes the Lanes tab's filter, pinned lane ids, and expanded lane id. Version 4 adds the Work-sidebar-only `workPinnedLaneIds`, lane sort mode, sparse manual lane order, and structured session chips; normalization is additive, so a v3 blob retains the former Created order with no Work pins or chips. It keeps Settled reachable as a quiet collapsed tail: Status/Time mode use `status:settled`, Lane mode uses explicit `settled-open:<laneId>` markers, and a fully quiet lane uses the inverted `lane-open:<laneId>` marker. There is no independent Tiers/Show settled filter. The one-time status-collapse migration is gated against its own version-2 threshold, so later additive schema bumps do not re-collapse a section the user expanded. Persistence under `ade.workViewState.v1` is a scoped delta read-modify-write: every mounted project store upserts or deletes only the project/lane keys it owns instead of flushing its stale copy of the whole map. `refreshLanes` prunes lane scopes only from a non-empty lane inventory and only inside that store's project scope. `registerProjectSurfaceStore` / `workViewStoreForProject` route project-specific writes made by `AppShell` and `TopBar`, which render above `AppStoreProvider`, to the owning surface store. Lane/status deeplinks are transient view overrides and user filter, grouping, chip, pin, or ordering changes return to and then update the saved base. The right-edge fields are `workSidebarOpen`, `workSidebarTab` (`"git" | "files" | "ios" | "app-control" | "browser"`), and `workSidebarWidthPct` (clamped 26–55). The sidebar consolidates lane-scoped tools that were previously split across separate floating panes; per-chat iOS / App Control drawers still exist on `AgentChatPane` but are suppressed when the chat is mounted as a Work tile so the sidebar owns those surfaces at lane scope. Remote-bound Work sidebars expose only the runtime-backed Git and Files tabs; local-only iOS Simulator, App Control, and Browser panes stay hidden. The `browser` tab is not lane-scoped on local bindings: each ADE window/project keeps its own tab collection and inspect state, while browser authentication storage is global to the installation/channel through `persist:ade-browser`.
- Cross-machine Work union. `crossMachineLanesByMachineId` + `crossMachineLaneScopeKey` (fed by `renderer/state/crossMachineLanes.ts`) hold every *other* connected machine's lanes and sessions for the repository the active tab is showing, so the Work sidebar can list chats in flight anywhere without changing the tab's binding. Keyed by machine because a lane owns its machine (`lanes.worktree_path` is an absolute path on exactly one machine) and chats inherit theirs through `laneId` — there is no per-chat machine field. `mergeCrossMachineLanes` retains omitted `lanes`/`sessions` so a failed read leaves the machine's rows on screen, and `setCrossMachineMachinesOnline` flags rather than deletes an entry that goes offline — the sidebar renders it dimmed, collapsed, and inert, and the retained slice also backs the push-divergence guard. Presence is decided in one place, `applyReachability`, from connection state alone: a drop is believed only after a reconnect attempt has completed and failed (`connecting` observed, then a non-connected state) plus a 45 s floor, with a 120 s ceiling for a dial that never finishes. Two states have no attempt left to wait for and dim on the floor alone: `idle`, which will not redial on its own, and `connected` but unable to re-prove this repository, which answers yet is never read for it. The floor and the ceiling are one deadline, not two rules. The `connecting`/`error` states a redial or sleep/wake publishes therefore do not reflow the sidebar, and reconnecting is applied instantly. The verdict belongs to the store rather than the tick: a machine that is already dimmed stays dimmed until it is eligible again, so a Work-tab remount — which tears down the shared runtime and its drop records while the store slice survives — cannot re-brighten it for another floor; the retention deadline is re-anchored to that machine's last successful read instead. Only `dropCrossMachineLanes` deletes, and only for a target gone from the snapshot, a connected machine that positively reports the repository missing *and* has a resolvable origin to prove it by (`repoMatchFor` will say "missing" off a folder-name mismatch alone, and the scope's origin is transiently null while the bound machine blips), or 24 hours unreachable. The scope key is per repository, so a project-tab switch invalidates the union wholesale. A detached chat launch whose runtime pin differs from the active binding seeds an optimistic summary directly into the owning machine slice; the binding/session-keyed pending record survives stale in-flight list responses and is replaced by the authoritative row with the same stable session id (or pruned on delete/expiry). This keeps the active binding free of foreign UUID-lane placeholders while avoiding a blank interval before the next remote list arrives. Foreign lanes use the same `sessionFilingBucket` active/snoozed/settled partition, fully quiet collapsed header, and quiet-tail renderer as local lanes, with composite machine/lane persistence keys. Their **Manage lane** dialog and mutations carry the same owning binding. Sessions whose referenced lane is absent render as explicit warning-tinted **Orphaned sessions** groups with a refresh-only recovery action; ADE preserves the sessions and never interprets unknown ownership as permission to mutate the active machine. Refreshes ride the connection-snapshot subscription plus existing lane-lifecycle/session-changed events (coalesced, bounded, timed out, capped in parallelism) and a fallback loop for machines with no renderer change feed; that loop is paused entirely while the window is hidden, re-reads chats every 10 s, and re-reads lanes on a 30 s cadence, because `lane.list` with `includeStatus` costs a git status per lane on the other machine. A chat naming a lane that machine has never reported forces the lane read immediately, but only once: lane ids a completed read did not explain are remembered until the next one, because `session.list` does not filter on lane status while `lane.list` excludes archived lanes, so a chat on an archived lane is permanently unresolvable and would otherwise demand the expensive read on every tick forever. Foreign reads never gate the local list. `selectOtherMachineBranchStates` is the memoized selector the push-divergence guard reads at click time.
- Project tab bookkeeping. `openProjectTabRoots: string[]` tracks local roots open in the window (mirrored to the main process via `ade.app.setWindowProjectTabs` so background services keep those projects warm); `openRemoteProjectTabs` tracks full remote bindings so inactive remote tabs remain first-class retained surfaces. `ProjectTabHost` applies one shared eight-surface LRU across local and remote tabs: inactive mounted surfaces are hidden, inert, and animation-paused, while an open surface that falls outside the bound snapshots its scoped state back into the root caches before unmounting. `projectInfoByRoot: Record<string, ProjectInfo>` caches local `ProjectInfo` payloads for tab favicons and offline tab rendering.
- Stale-while-revalidate switch caches. `laneSelectionByProject` remembers the `{ laneId, sessionId }` selection per project identity so switching tabs lands on the lane/chat the user last had open instead of "first lane". `laneCacheByProject` mirrors the last good `{ lanes, laneSnapshots }`; local and remote switches apply it immediately (no spinner, no chat-pane unmount) and refresh silently in the background. `sessionsCacheByProject` does the same for `useWorkSessions` so chat tabs and terminal grids do not blank during a tab swap. `projectRouteStorage.ts` persists the last route under the binding key, independent of whether the surface is currently mounted. Cache pruning retains every open local root and remote binding key; tab close and target disconnect deliberately evict only their affected remote state. The two eviction paths are distinct: `evictProjectState(key)` + `removeStoredProjectRoute(key)` is the full "forget this surface" wipe used by an explicit tab close and by removing a machine, while `evictProjectDataCaches(key)` is the disconnect-only sibling that drops just the snapshots that can go stale while a remote is unreachable (`laneCacheByProject`, `laneSelectionByProject`, `sessionsCacheByProject`, and the persisted lane cache) and preserves `workViewByProject` / `laneWorkViewByScope` plus the stored route so reconnecting restores the chat or tile that was open. `closeProject({ preserveRemoteViewState: true })` applies the same narrower rule when a disconnect closes the last remaining tab.
- `projectRevision` is a monotonically incrementing counter bumped inside `setProject` whenever the active project root actually changes. Long-lived renderer-side caches (most notably the module-level xterm runtime cache in `TerminalView.tsx`) combine it with the project identity key, so identical paths on different remote targets cannot share PTY runtimes. All project-transition paths (`refreshProject`, `openRepo`, `switchProjectToPath`, `closeProject`) go through `setProject` to keep the counter honest.

Domain stores co-located with their pages follow the same factory + context pattern when they need per-page isolation:

- `chatDraftStore.ts` — draft messages per chat session.

### 7.3 Component organization

Feature-grouped under `apps/desktop/src/renderer/components/`:

```
app/            # shell, App.tsx, TopBar, TabNav, LinearIssueBrowser (multi-select + batch actions), LinearIssueResolveModals (single + batch), LinearQuickViewButton, startup, splash
project/        # Play tab, run/test/process controls
lanes/          # list/detail/inspector, stacks, laneDesignTokens.ts
files/          # tree, editor, diffs
terminals/      # TerminalView, WorkViewArea (PaneTilingLayout-backed grid), WorkSidebar, workSessionTiling, LaneCombobox
conflicts/      # risk matrix, simulation, resolution
graph/          # WorkspaceGraphPage (decomposed into nodes/edges/dialogs)
prs/            # PR list/detail, stacked queue, shared/
history/        # operation timeline
automations/    # rule list, action editor, templates
cto/            # single-thread CTO page, settings/memory/prompt panels, onboarding card, identity editor, shared/designTokens.ts
orchestration/  # OrchestrationPanel, TaskCard, PlanMarkdown, PhaseAccordion, PlanningTimeline, ValidationFindings, EvidenceSection (evidence chips + run-level roll-up, orchestrationEvidence.ts helpers)
onboarding/     # first-run flows
settings/       # keybindings, agents, data, context, sync
chat/           # AgentChatPane + composer + subpanels
personalChats/  # global projectless chat list/transcript/composer + personal PTY panel
shared/         # MentionInput, shared interactive bits
ui/             # pure presentation primitives
```

Design tokens have been intentionally trimmed. The CTO design tokens at `apps/desktop/src/renderer/components/cto/shared/designTokens.ts` are the example style: a small set of Tailwind class constants (`cardCls`, `surfaceCardCls`, `shellBodyCls`, `inputCls`, `labelCls`, etc.) and a constrained accent palette (`ACCENT.purple/blue/green/pink/amber`). Lane design tokens live at `lanes/laneDesignTokens.ts` and are imported across lanes/PRs/settings.

### 7.4 Layout patterns

- `PaneTilingLayout` — recursive pane trees for high-density workspaces, backed by pure ops in `paneTreeOps.ts` (`reconcilePaneTree`, `splitPaneAtEdge`, `swapPanes`, `detectDropEdge`). Trees persist per `layoutId` via `window.ade.tilingTree`; panel sizes persist separately via `DockLayoutState` and are reset whenever the tree mutates.
- `SplitPane` / resizable panels — structured 2/3-pane views.
- Work view's grid mode is `PaneTilingLayout` seeded by `buildWorkSessionTilingTree(sessionIds)` (in `renderer/components/terminals/workSessionTiling.ts`); every session becomes a `FloatingPane` leaf with `grid-tile` chrome.
- Project tab hosting: `App.tsx`'s `ProjectTabHost` mounts one persistent `ProjectSurface` per open project tab inside a single window, keyed by the runtime binding (`local:<root>` or the remote binding key) so a local and remote view of the same path cannot share renderer state accidentally. Each `ProjectSurface` owns its own zustand store instance (`createProjectAppStore(project, projectBinding)`), pre-hydrated with the project binding plus a copy of root-store user preferences (theme, terminal preferences, chat font, sound, density, etc.). User-preference setters point at the **root** store, so changes flow to one place and are then mirrored into every project store on the next `rootPrefs` change. A LRU sorts mounted surfaces and caps the warm-mounted set at `WARM_PROJECT_SURFACE_LIMIT = 8`; surfaces beyond that limit are dropped from the React tree (their store entry is GC'd) but the persisted lane/chat caches in the root store keep their data live so a re-mount is cheap.
- Global personal-chat routing: `/chats` sits outside the project route set. On desktop, a selected project renders it against that surface's retained runtime binding; from the welcome surface it renders under a real machine-level **Chats** top tab whose existence is tracked in session-only `personalChatsTabOpen` app state. In hosted web, the Hub chooses the machine explicitly and the federated adapter persists that Chats target per account. The Chats tab's active state is derived from the route, and project-only tabs remain disabled while it is active.
- Per-surface routing: each surface remembers its own route (`/work`, `/lanes`, `/files`, `/prs`, `/cto`, `/automations`, `/settings`, …) under `ade:project-route:<bindingKey>` in `localStorage`. `ProjectTabHost` swaps which surface is `active` based on the foreground project tab, stashing the outgoing route and replaying the incoming surface's last route via `navigate(..., { replace: true })`. Inactive surfaces stay in the tree (`aria-hidden`, `inert`, absolutely positioned at `z-index: -1`, opacity 0, pointer-events none) so chats / terminals / live polling don't tear down on tab swap. The host also marks parked project, Work, and Lanes surfaces with `data-ade-animation-state="paused"`; the global renderer stylesheet pauses descendant CSS animations (including pseudo-elements) until the surface becomes active again, avoiding hidden compositor work without discarding UI state.
- Work-surface reveal: `ProjectRouteContent` keeps the `/work` route mounted lazily inside each project surface. When the surface itself becomes active **and** the route is a work route, it dispatches the `WORK_SURFACE_REVEALED_EVENT` window event so terminal tiles can clear their texture atlas, force-fit, and refocus.
- Page-level active gating: lazy feature pages (`LanesPage`, `FilesTab`, `WorkspaceGraphPage`, `PRsPage`, `ReviewPage`, `HistoryPage`, `AutomationsPage`, `AutomationsTemplatesPage`, `CtoPage`, `SettingsPage`) accept an `active?: boolean` prop and gate every `useEffect` that fires IPC polling, event subscriptions, or initial data fetches behind it. Desktop inactive surfaces render their last state but do not poll. Hosted web is stricter: only the active project surface mounts, because an inactive renderer subscription must never outlive the federated machine/project adapter it was created against.
- The desktop TopBar project tab strip resolves a per-project favicon via `window.ade.project.resolveIcon(rootPath)` and caches the result in a module-local `Map`. Tabs without an icon (or a missing project root) fall back to the `Folder` Phosphor glyph; the same component drives the loading-pulse animation when a tab is being switched into or closed.
- Layout state persists to SQLite (`layout`, `tilingTree`, `graphState` domains via the `kv` table).

### 7.5 Performance contract

Enforced rules (from the stability overhaul):

1. All background services go through `scheduleBackgroundProjectTask()` — no raw `setTimeout` for service startup.
2. New integrations are dormant-until-configured.
3. Feature pages stage data: cheapest (list/summary/topology) first, heavy (dashboard/settings/model metadata/overlays) on delay.
4. Never mount expensive trees eagerly — settings dialogs, advanced launcher sections unmount when closed.
5. Renderer polling is route-scoped except application-wide session attention. `useAppWideSessionAttention` stays mounted in `AppShell` across Work, Files, PRs, and other project routes; it refreshes on PTY/chat/session events, focus, and a visible-window 15-second recovery interval so a `Needs you` transition can update the global highlight and Dock badge off the Work route. `useCtoAttention` sits beside it on the same cadence for the roster-hidden CTO thread, and debounces its probe behind `shouldRefreshSessionListForChatEvent` so a streaming turn does not re-run a full identity-session scan in main per delta. Project-switch/close cleanup generation-guards stale async results. Lane panels still poll only while live sessions exist. The plain PR list does not fire a GitHub refresh on mount, renders active-repository PR snapshots only, skips conflict analysis, and defers rebase-needs / auto-rebase polling until the user opens a workflow tab or selects a PR. Selected PR detail reads apply progressively so slow comments or action-run hydration do not block status/checks/files from painting. Workflow PR views batch merge contexts and conflict analysis against metadata-only lane rows instead of running per-PR git/status work. The Lanes page reuses the `LaneSummary.autoRebaseStatus` snapshot already in the lane list instead of probing per-lane on `LaneGitActionsPane` mount; a fallback probe runs only when the snapshot is missing and after a visibility-gated 3.5 s delay. Run's `LaneRuntimeBar` keeps health/process refreshes separate from preview routing / port / OAuth refreshes so process events do not reread routing state. The Work top-bar sync chip refreshes on focus and on `sync-status` events instead of a 5 s interval. The chat composer's Cursor model inventory is fetched lazily — `ProviderModelSelector` calls `onOpen` on first open of the model catalog, and `AgentChatPane.refreshCursorModelInventory` is the only entry point that hits `cursor` with `activateRuntime: true`.
6. Shared caches for high-frequency calls (`sessionListCache`, GitHub fingerprint-based snapshots, and the renderer's project-scoped `aiDiscoveryCache`). ModelPicker provider-auth reads join the cache's single in-flight `ade.ai.getStatus` request and react to cache update/invalidation events; picker instances do not poll, and call sites that already supply auth status skip the full-status read.
7. Memoize expensive renderer computations (`useMemo`, `React.memo`); isolate frequently-refreshing subtrees (e.g., budget footers).
8. `Promise.allSettled` over `Promise.all` for parallel startup — one failing service must not block others.
9. Usage surfaces never block first paint on provider-ledger or GitHub scans. The quota popup reads `ade.usage.getSnapshot` before an explicit refresh; retrospective Stats calls `ade.usage.getAdeStats`, which returns cached expensive sources plus live DB aggregates and refreshes stale sources in the background. An explicit Refresh remains available for a forced recompute.
10. Persistence callbacks dedupe against the last-saved value: the workspace-graph view-mode persister tracks the last-loaded preference root and skips the immediate write that the load handler's `setViewMode` would otherwise fire.

CLI-launcher and shell-quoting helpers (`cliLaunch.ts`, `shell.ts`) live under
`apps/desktop/src/shared/` so the desktop renderer, chat launch helpers, ADE CLI
action surface, and sync remote-command service share one provider launch
contract. Resume builders preserve provider-native model/permission state when
an import supplies no explicit override. `externalSessionAffordances.ts`
similarly centralizes provider capability-to-action policy for desktop and ADE
Code. Renderer imports go through thin re-export shims under
`apps/desktop/src/renderer/`. The mobile launcher path
(`work.startCliSession`) uses the shared launch helpers on the host side, while
iOS mirrors the external-import action policy natively in
`WorkExternalSessionAffordances.swift`.

Themes: six shipped themes (`e-paper`, `bloomberg`, `github`, `rainbow`, `sky`, `pats`), persisted in `localStorage.ade.theme`, applied via `data-theme` on root. Token-based palettes in `apps/desktop/src/renderer/index.css`.

### 7.6 Renderer primitives

- `renderer/lib/dialogBus.ts` — tiny pub/sub that lets shared UI open/close dialogs by a stable id (`lanes.create`, `settings.ai`, etc.) without prop-drilling. Dialogs subscribe by id; a `subscribeAll` channel exists for devtools. Default singleton export `dialogBus`.
- `renderer/components/app/toast/` - shared renderer-only toast primitive. `toastStore.ts` owns stack order, timers, hover pause/resume, sticky toasts, and in-place replacement; `ToastStack.tsx` renders inside AppShell's existing bottom-right notice container. Lane lifecycle and automated rebase terminal events subscribe through `useLaneEventToasts.ts`.
- `renderer/components/shared/Banner.tsx` + `renderer/components/app/IntegrationBannerHost.tsx` — the shared connection/health banner system. `Banner` is the one severity-tinted row every integration banner renders through (error/warning/info accent, normal UI font, never monospace). `IntegrationBannerHost` (mounted once by `AppShell`) computes and renders the whole family — GitHub App account authorization, per-repo App install, gh-CLI/token, missing-AI-provider, mock-provider, and ADE Relay outage — as one severity-ranked list capped at two visible (`MAX_VISIBLE_BANNERS`) with a collapse-the-rest control, in place of the hand-ordered `? :` conditionals that used to live inline in `AppShell` (feature-local one-off banners such as the provider-settings and rebase-tab notices are unaffected). Dismissal is durable and fingerprint-aware via `renderer/lib/bannerDismiss.ts` (localStorage-backed, so a dismissal survives restart and project reopen; a dismissed banner auto-resurfaces after ~2 weeks or the moment its underlying state changes/regresses to a different fingerprint). GitHub App health is derived in `renderer/lib/githubIntegrationStatus.ts` (see [Onboarding and settings](./features/onboarding-and-settings/README.md)), so the banner and Settings never disagree. The relay banner reads `routeHealth.relay` from `AppShell`'s `sync-status` subscription seeded by `sync.getLocalStatus` (relay belongs to the physical machine, not to whichever runtime a remote-bound project routes to): a deliberate suppression is reported immediately, while a plain outage waits out `RELAY_OUTAGE_GRACE_MS` (2 minutes) of uninterrupted failure on a single armed timer rather than a poll. See [Sync and multi-device](./features/sync-and-multi-device/README.md).
- `renderer/onboarding/docsLinks.ts` — typed registry of internal/public doc URLs (`docs.lanes`, `docs.cto`, …) used by `DidYouKnow`, glossary/help surfaces, and the `HelpMenu`.
- `renderer/components/onboarding/LaunchGate.tsx` — fresh-process account-choice gate. New installs see the welcome card first; returning signed-out launches go directly to sign-in or **Continue without an account**. Resolving it is process-local so extra windows and renderer reloads do not repeat it.
- `renderer/components/onboarding/WelcomeVideoGate.tsx` — app-level one-time welcome card using the website's canonical desktop/mobile/terminal hero assets, a privacy-enhanced YouTube embed with its real thumbnail/player, and the ADE Mobile TestFlight QR/download/copy panel. Seen/dismissed state is stored in the global app state file, separate from per-project setup onboarding.

Related UI docs: [Terminals UI surfaces](./features/terminals-and-sessions/ui-surfaces.md), [Files and editor](./features/files-and-editor/README.md), and [Onboarding and settings](./features/onboarding-and-settings/README.md).

---

## 8. Security & Trust Boundaries

### 8.1 Electron safeStorage for secrets

| Secret | Location | Protection |
|--------|----------|-----------|
| GitHub PAT | `.ade/secrets/github/*.bin` | `safeStorage.encryptString` (OS-backed) |
| API provider keys | `.ade/secrets/api-keys.json` | Plaintext `0600` |
| ADE project secrets | `.ade/secrets/project-secrets.v1.enc` | AES-GCM encrypted file store, OS-bound on supported hosts |
| Claude OAuth creds | Claude's own store | Inherited |
| Codex auth tokens | Codex's own store | Inherited |
| macOS Keychain entries | OS Keychain | OS-backed |
| Sync site ID | `.ade/secrets/sync-site-id` | Plaintext, never syncs |
| Sync device ID | `.ade/secrets/sync-device-id` | Plaintext, never syncs |
| Sync bootstrap token | `.ade/secrets/sync-bootstrap-token` | Plaintext, never syncs |
| External-ADE CLI secrets | `.ade/local.secret.yaml` | Plaintext, never syncs |

ADE project-secret dotenv imports are explicit transfers, not background
sync: the desktop reads a user-selected local file (1 MB cap) and sends its
content to the active project runtime for parsing and atomic import. Exports are
also runtime-owned and create a mode-`0600` plaintext file in that runtime
machine's Downloads folder. The review modal intentionally displays imported
values before save; the encrypted store remains the normal at-rest location.

### 8.2 Preload as only cross-boundary surface

```
┌──────────────── Main process (trusted) ──────────────┐
│  Full Node access: git, fs, PTY, sqlite, process     │
│  ┌────────────────────────────────────────────────┐  │
│  │ Preload bridge (contextBridge)                 │  │
│  │ window.ade = { /* ~550 typed methods */ }      │  │
│  └────────────────────────────────────────────────┘  │
├──────────────── Renderer (untrusted) ────────────────┤
│  React app · no require() · no node · no net         │
│  Only path: window.ade.*  + CSP                      │
└──────────────────────────────────────────────────────┘
```

`BrowserWindow` hardening:

```typescript
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: false,        // required for preload functionality
  preload: "preload.cjs",
}
```

**CSP** (`rendererCsp.ts`): `default-src 'self'`; `script-src 'self'` (no eval, no inline scripts); `style-src 'self' 'unsafe-inline'` (required for Tailwind); `connect-src 'self'`; `img-src 'self' data:` plus a host-scoped allowlist (no blanket `https:`) for the image origins PR/README surfaces actually load — the GitHub avatar/asset hosts (`*.githubusercontent.com`, `github.githubassets.com`, …) and `www.gravatar.com` / `secure.gravatar.com` (commit-author identicon fallback). `frame-src` stays local/about by default with a narrow external exception for the ADE welcome video hosts (`www.youtube-nocookie.com` and `www.youtube.com`). The Electron header hook applies this policy only to ADE renderer main-frame documents; external subframes keep their own response CSP so embedded players can execute their host-provided scripts.

Every IPC handler **validates** its arguments; invalid args return structured errors, never crash. Every handler has a **30s timeout** by default; `ipcTimeouts.ts` carries per-channel overrides for long-running operations and inspects the payload of `localRuntime.callAction` / `remoteRuntime.callAction` so action-specific timeouts (e.g. `lane.create` / `lane.delete` → 4 min; `ios_simulator.launch` → 10 min) apply even when the channel itself is generic. Every handler emits structured tracing.

Most `window.ade.sync.*` preload methods follow the active project binding and
therefore target a remote brain when the window is remote-bound.
`window.ade.sync.getLocalStatus(args?: SyncGetStatusArgs):
Promise<SyncRoleSnapshot>` intentionally bypasses that binding through the
`ade.sync.getLocalStatus` IPC channel and reads the machine-level local brain.
It is the local source the Connections panel can use for the This Mac identity,
pairing code, and local Phone/Web device lists.

`window.ade.attention.*` intentionally does not follow that binding. Electron
main sends signed-in calls to the account relay through
`AttentionAccountCoordinator`; only its explicitly labeled local-machine
fallback calls the local runtime. The hosted web adapter implements the same
renderer contract with a direct account-relay client and a separately labeled
paired-host fallback.

Application-wide shell state also crosses this boundary.
`useAppWideSessionAttention` derives the loud session-attention count from
canonical projected session rows on every project route and calls
`window.ade.app.setDockBadgeCount`; the main process validates and normalizes
that count before forwarding it to Electron's `app.setBadgeCount`. Project
switch/close cancels the old refresh and clears its count. Quiet ready, idle,
stale, ended, and settled rows never contribute to the Dock badge.

The CTO thread is the one exception to "canonical projected session rows are the
whole picture": it is filtered out of every roster, so it never appears in those
rows. `useCtoAttention` reads it separately through the read-only
`window.ade.cto.getAttention()` probe into `appStore.ctoAttention`, `TabNav`
draws the dot on `/cto`, and `useAppWideSessionAttention` folds that one flag
into its badge count so it remains the single writer of `setDockBadgeCount`. iOS
reaches the same `agentChatService.getCtoAttention()` implementation through the
optional `cto.getAttention` sync command and badges its CTO tab. The probe must
stay side-effect-free on every transport — creating the CTO session to draw a
badge would materialize a primary lane. See
[features/cto/README.md](./features/cto/README.md#hidden-from-rosters-but-never-silent).

### 8.3 ADE CLI auth + API-key storage

- ADE CLI session identity is resolved from env vars and the `initialize` handshake.
- Role validation: only `cto`, `orchestrator`, `agent`, `external`, `evaluator` accepted.
- A session binding cannot elevate authority. The runtime default role is a
  ceiling; a bound caller that would otherwise resolve to `cto` is clamped to
  `agent` unless it explicitly declares the lower `orchestrator` role.
- API keys for provider-routed (non-CLI) models are stored via `apiKeyStore.ts`.

### 8.4 Sensitive-data handling

- **Redaction** (`shared/utils.ts` `redactSecrets()`) scrubs Bearer tokens, OpenAI/Anthropic API keys (`sk-`), GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), Slack tokens (`xox*`), AWS access keys (`AKIA`/`ASIA`), and JSON-embedded sensitive key-value pairs before any log write or AI-context serialization.
- **Sanitization** (`sanitizeStructuredData()`) enforces depth limits, redacts sensitive keys, and truncates oversized arrays/strings.
- **Bounded AI payloads** — narrative/proposal/PR description calls use `LaneExportStandard` or `LaneExportLite` + `ConflictExportStandard` (token-budgeted), not raw pack dumps or transcript slabs.
- **Path validation** (`resolvePathWithinRoot()`) resolves symlinks via `realpathSync` before containment checks. Applied to lane env init, coordinator tools, process working dirs, sync artifact paths, ADE CLI context file resolution, computer-use artifact ingestion.
- **Config trust**: process/test commands from `ade.yaml` require SHA-256 hash approval before execution. Commands in `local.yaml` are always trusted. Trust stored in `kv` with the config hash as key.

Related trust-boundary docs: [Computer-use artifact broker](./features/computer-use/artifact-broker.md), [Computer-use backends](./features/computer-use/backends.md), and [Configuration schema](./features/onboarding-and-settings/configuration-schema.md).

---

## 9. Git Engine

### 9.1 Strategy

- ADE **shells out** to the system `git` binary (not isomorphic-git). Rationale: full feature parity, hook compatibility, native credential handling, performance.
- All commands go through `runGit` / `runGitOrThrow` in `apps/desktop/src/main/services/git/git.ts` (timeout support, structured output parsing).
- Executable discovery reuses `ai/cliExecutableResolver.ts` to inspect PATH and known installation directories. On macOS, ADE prefers an independently installed Git over Apple's `/usr/bin/git` and probes the login shell before accepting `/usr/bin/git`; this keeps project opening usable when Apple's Git is blocked by an unaccepted Xcode license. If Apple's Git is the only available option, the surfaced error explains that accepting the license is a Git prerequisite, not an iOS Simulator or code-signing requirement, and points to installing Git separately as the alternative.
- High-level ops in `gitOperationsService.ts` — wrap every mutation in `runLaneOperation()`: resolve lane, capture pre-HEAD, record operation, execute, capture post-HEAD, finalize record, fire `onHeadChanged` if needed.

### 9.2 Worktree-per-lane isolation

Each non-primary lane maps to a dedicated worktree:

```bash
git worktree add -b ade/<slug>-<uuid8> .ade/worktrees/<slug>-<uuid8> <base_ref>
```

Lane types (per `lanes.lane_type`):

| Type | Worktree location | Notes |
|------|-------------------|-------|
| `primary` | Project root | The main repo checkout (e.g., `main`). |
| `worktree` | `.ade/worktrees/<slug>-<uuid8>` | Standard ADE lane. |
| `attached` | User-specified path | Pre-existing worktree linked to ADE (`attached_root_path` column). |

Worktree lifecycle: create (60s timeout), archive (DB status only, worktree remains on disk), delete (`git worktree remove` + optional `git branch -D`), cascade-delete dependent rows (deltas, sessions, operations, pack index).

### 9.3 Stack graph

- Lanes have `parent_lane_id` (self-FK on `lanes`). Stacks are parent/child chains.
- Stack operations: rebase propagation, base-ref resolution (`shared/laneBaseResolution.ts`).
- `autoRebaseService.ts` + `rebaseSuggestionService.ts` — automatic rebase proposals when parent moves; user can accept/defer/dismiss.
- `computeLaneStatus()` returns `{ dirty, ahead, behind }` on demand, no caching. Status derivation uses `git status --porcelain=v2 --branch` and `git rev-list --left-right --count`. The `--branch` header (`# branch.head`) carries the branch HEAD is actually on, so the same call that computes dirty state also yields `headBranchRef` — which is what makes HEAD-vs-`lanes.branch_ref` drift detection (`services/lanes/laneBranchDrift.ts`) cost no extra process spawn and need no timer of its own. Ignored files are still not listed (no `--ignored`), so dirty semantics are identical to the porcelain v1 form this replaced. See [Lanes › Branch drift](./features/lanes/README.md#branch-drift).

### 9.4 Queue + conflict simulation

- **GitHub stacked PRs** (`githubPrStackService.ts`) — repository-scoped stack reconciliation and membership snapshots.
- **Conflict prediction** — `conflictService.ts` uses `runGitMergeTree()`:
  ```bash
  git merge-tree --write-tree --messages --merge-base <base> <branchA> <branchB>
  ```
- Pairwise dry-merge simulation across all active lanes; output parsed into structured `ConflictOverlap` entries.
- Triggered on debounced lane/head changes via the job engine; periodic prediction is off by default in dev stability mode.
- Result: risk matrix surfaced on Graph + Conflicts pages, confidence-scored proposals (`high`/`medium`/`low`) with apply/discard UI.

### 9.5 Safety

- `ensureRelativeRepoPath()` rejects empty, null-byte, absolute, and traversal paths.
- Force push uses `--force-with-lease`, never `--force`.
- Branch-protection support on primary lane.
- Destructive ops (discard, hard reset) require UI confirmation.

### 9.6 Open-PR lookup for a lane branch

`gh pr list --head <branch>` matches on branch **name only**, across every fork of the repository. A PR opened from somebody else's fork that happens to use the same branch name is returned by that query and, unfiltered, attaches itself to the lane. Filtering the result by head repository is therefore a correctness invariant, not an optimization.

- `services/git/ghOpenPrLookup.ts` is the single lookup: `lookupOpenPrForBranch({ worktreePath, branch })` resolves the `origin` owner from `git remote get-url origin` + `parseGithubRemoteUrl`, spawns `gh pr list --head <branch> --state open --json <fields> --limit 10` with an 8 s timeout, and picks the row whose head-repo owner matches. Because `--head` matches across forks the wanted row is not necessarily first, hence a small page rather than `--limit 1`. Both `gitOperationsService.ts` (`getOpenPrForBranch`, behind `ade.git.getOpenPrForBranch`) and the ADE action registry call it instead of open-coding the `gh` invocation.
- `services/git/ghPrHeadRepo.ts` holds the pure parsing/selection: `GH_PR_LIST_JSON_FIELDS`, `parseGhPrListEntry`, `ghPrHeadRepoMatchesLane`, `selectOwnRepoOpenPr`, `EMPTY_GH_OPEN_PR_SUMMARY`.
- **Decode leniently, and fall back for old `gh`.** `headRepositoryOwner` / `headRepository` are only emitted by `gh >= 2.47`, and `gh` renders them as objects (`{"login":"acme"}` / `{"name":"widgets"}`) though a bare string is also accepted. An **absent** field means "cannot verify — accept", never "reject"; a strict decode would silently drop every PR for anyone on an older CLI. `gh` also rejects an unknown `--json` field with a non-zero exit rather than omitting it, so requesting the newer fields against an old CLI fails the *entire* lookup — hence `GH_PR_LIST_LEGACY_JSON_FIELDS` (`url,number,title,headRefName`, present for as long as `pr list --json` has existed) as a one-shot retry. The runner distinguishes three outcomes so the caller knows whether that retry can help: JSON on success, `""` when `gh` ran and exited non-zero (bad flag, not authenticated, not a repo), and `null` when `gh` could not be run at all or timed out.

Related Git docs: [Lanes](./features/lanes/README.md), [Lane runtime isolation](./features/lanes/runtime.md), and [Pull requests](./features/pull-requests/README.md).

---

## 10. Context Continuity

ADE carries continuity through the records owned by each runtime surface:
chat transcripts, CTO session logs, CTO durable memory, daily logs, and explicit
context documents. These are read directly by the services that need them;
there is no separate retrieval layer in between.

---

## 11. Runtime context

ADE does not generate PRD or architecture bootstrap documents. Agent prompts tell models to inspect the repository directly when they need product or architecture context, starting with `AGENTS.md`, `README.md`, `docs/`, package manifests, and relevant source files.

### 11.1 What gets shipped to each AI call

| Call type | Payload |
|-----------|---------|
| Narrative generation | `LaneExportStandard` (lane, bounded) |
| Conflict proposal | `LaneExportLite` (lane) + `LaneExportLite` (peer, optional) + `ConflictExportStandard` |
| PR description | `LaneExportStandard` with commit history |
| Initial context (repo scan) | Targeted file/commit digests |

---

## 12. Proof (Computer-Use Artifacts)

### 12.1 Principle

Proof is **intentional**. Agents run computer use through their provider tool — including direct Codex Computer Use, Claude's `computer_use`, a scripted browser, a headless Playwright run, or a local screenshot. ADE may provision the provider tool, but it does not passively promote every tool result into proof. When the agent reaches a checkpoint worth showing, it files an artifact through the broker (directly or via `ade proof capture` / `attach`), optionally with a caption. That record is what the drawer UI renders and what reviewers see.

The previous control-plane model — `ComputerUsePolicy` (`off`/`auto`/`enabled`, `allowLocalFallback`, `retainProof`, `preferredBackend`), passive `proofObserver` ingestion from chat `tool_result` events, and the Settings > Computer Use panel — was removed. There is **one path** now: intentional ingest via the broker.

### 12.2 Broker and backends

`apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` is the ingest boundary. It accepts `ComputerUseArtifactInput[]` (path, remote URI, inline text, inline JSON), materializes on-disk sources into the project artifacts dir via `secureCopyFromDescriptor` (uses `O_NOFOLLOW` + atomic rename to resist symlink tricks), writes the canonical `computer_use_artifacts` row, and links to one or more owners (`lane`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`).

Allowed import roots include `.ade/artifacts`, `.ade/cache`, `.ade/tmp`,
managed lane worktrees, the project root, `os.tmpdir()`, `~/.agent-browser`,
and narrowly injected runtime-owned scratch roots. `.ade/secrets` is always
denied, both allow and deny checks use real paths, and an extension allow-list
rejects project-local secrets/database/key material even though the project root
itself is trusted. Relative paths resolve from the caller's lane worktree before
the project root. Every input in a batch resolves before any row is inserted.

Supporting files in the same directory:

- `controlPlane.ts` — builds `ComputerUseOwnerSnapshot` (recent artifacts + activity) and `ComputerUseSettingsSnapshot` (backend readiness, capabilities) over the broker.
- `localComputerUse.ts` — exports `getLocalProofCaptureCapabilities()`, a macOS-only descriptor reporting whether `screencapture`, app launch, and GUI-interaction commands are available.
Direct Codex Computer Use is a separate execution path. On macOS,
`apps/desktop/src/main/utils/codexComputerUse.ts` requires an explicit
`computer-use@openai-bundled` plugin or `mcp_servers.computer_use` opt-in,
finds the standalone `SkyComputerUseClient`, verifies the full code signature
plus OpenAI team/bundle identifiers, and injects it as the canonical
`computer_use` MCP server into native Work chats and tracked Codex CLI
start/resume commands. It does not replace the proof broker or bypass MCP
elicitation prompts.

### 12.3 Artifact record

Canonical proof kinds: `screenshot`, `video_recording`, `browser_trace`, `browser_verification`, `console_logs`.

Canonical tables:

- `computer_use_artifacts` — proof kind, backend name/style, source tool metadata, title/description, URI, storage kind, MIME type, optional lane id, compatibility review/workflow state, timestamps.
- `computer_use_artifact_links` — cross-domain ownership supplied at ingest. The removed `routeArtifact` mutation no longer appends owners later.

File-backed views derive `available`, `missing_file`, or `unimported`
availability. Broker deletion is idempotent and can remove selected artifacts,
all broken records, lane-attributed proof during destructive lane teardown, all
project proof during local-data reset, or rows below a Settings storage-cleanup
path. Files are unlinked only after realpath confinement to the artifact store;
archive remains non-destructive.

### 12.4 IPC + UI

Channels (under `ade.proof.*`, renamed from `ade.computerUse.*`):

- `ade.proof.listArtifacts`, `ade.proof.getOwnerSnapshot`, `ade.proof.deleteArtifacts`, `ade.proof.listBrokenArtifacts`, `ade.proof.pruneBrokenArtifacts`, `ade.proof.recoverArtifact`, `ade.proof.updateArtifactReview`, `ade.proof.readArtifactPreview`, plus a `ade.proof.event` push channel.
- `ade proof capture` / `attach` / `list` / `rm` / `broken` / `prune` /
  `recover` in the ADE CLI are the cross-process surface; they call into the
  broker.

Renderer surfaces:

- `AgentChatMessageList` buckets artifacts by capture time into the completed
  turn that produced them. The turn rule exposes a collapsed proof count and
  expands `ChatProofFilmstrip` in chronology; proof is never a thread-tail
  footer.
- `ChatComputerUsePanel` supplies the in-app image lightbox and complete chat
  drawer, including availability states and irreversible deletion. Local media
  uses the range-capable artifact protocol; remote-runtime media uses bounded
  `readArtifactPreview` responses.
- Chat and iOS proof surfaces are collection views, not review workflows.
  Broker review/workflow fields remain available for compatibility with
  downstream integrations but are not user-facing controls.
- Computer-use readiness moved into `IntegrationsSettingsSection` — the standalone `ComputerUseSection.tsx` is gone.

---

## 13. Multi-Device Sync

The sync subsystem is **owned by the ADE runtime** (`apps/ade-cli/src/services/sync/`). When a project is opened, its scope creates a sync service inside the runtime; that runtime is the sync authority. The desktop client and iOS client both connect to the same service. Desktop's old in-process host code path is disabled by default and only re-enabled with `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics.

### 13.1 cr-sqlite CRDT + WebSocket

- **Runtime / desktop**: native cr-sqlite loadable extension (`.dylib` / `.dll`) loaded via `openKvDb(...)` in `kvDb.ts`.
- **iOS**: pure-SQL CRR emulation in `apps/ios/ADE/Services/Database.swift` — `crsql_master`, `crsql_site_id`, `crsql_changes`, per-table `<table>__crsql_clock` tables replicated as plain SQLite, with INSERT/UPDATE/DELETE triggers writing Lamport-versioned rows to `crsql_changes`. Custom SQLite functions (`ade_next_db_version()`, `ade_local_site_id()`, `ade_capture_local_changes()`) provide trigger context. Changesets are wire-compatible with the runtime's cr-sqlite.
- **Merge**: last-writer-wins per column. Each device has a unique site ID; Lamport timestamps per column.
- **Sync API** (`AdeDb.sync`): `getSiteId`, `getDbVersion`, `exportChangesSince(version, { maxRows?, throughDbVersion?, excludeTables?, rejectOversizedVersionGroup? })`, `applyChanges(changes)`, `discardUnpublishedChangesForTables(tableNames)`.
- **Bounded, snapshot-isolated exports**: `exportChangesSince` scans bounded `db_version` windows (the sync pump walks 250k-version windows per poll) inside a read transaction that pins the WAL snapshot — the `crsql_changes` vtab aborts on concurrent commits and a bare `LIMIT` cannot bound a vtab scan. Callers can exclude tables in SQL before limiting and reject a single oversized version group with `crsql_export_version_group_too_large` rather than materializing it. Startup self-heals orphaned `__crsql_clock`/`__crsql_pks` shadow tables (base table dropped, shadows left behind), which otherwise abort every `crsql_changes` scan.
- **Fair, acknowledged delivery**: host/desktop-peer batches normally target 250 rows / 256 KB; active chat peers get a 64 KB target and at most 2 seconds of background deferral above the 512 KB socket watermark. The sender advances only after `changeset_ack`. Six failed sends abandon the encoded batch but keep its `fromDbVersion`, then re-export progressively smaller windows (down to 16 rows / 16 KB) after bounded backoff. An iOS replica with ACK + chunk support and a gap strictly over 5,000 versions receives one ACK-gated compact current-state reseed, built at most 1,000 rows per poll and capped at 10,000 rows / 4 MiB; oversized state falls back to incremental replay. iOS persists its last-acked cursor/pending batch and performs the same no-skip recovery from 64 rows / 64 KB down to one row / 4 KB.
- **Suppression**: `discardUnpublishedChangesForTables` writes a per-table, per-site high-water mark into the local-only `local_crr_change_suppressions` table. Subsequent `exportChangesSince` calls drop local-site rows for those tables at or below that mark, so a local wipe (e.g. clearing `devices` and `sync_cluster_state` when joining another host as a viewer) cannot leak back as DELETE rows. The viewer-join path follows the wipe with `syncPeerService.acknowledgeLocalDbVersion()` to advance the outbound cursor past the suppressed range.
- **Transport**: one brain-level WebSocket listener on port 8787 by default (preferred-port retry for ~3 s before falling back to a port scan, so restarts do not drift the port phones saved; each tailnet publish also retires ADE's own leftover `tailscale serve` entries, which otherwise hold the low ports through `tailscaled` and ratchet the listener upward on every restart); JSON-framed changesets + zlib compression for large batches; encoded envelopes >720 KB are sliced into `envelope_chunk` frames for peers declaring the `chunkedEnvelopes` capability; 60s ping/pong. Controllers adopt the host-advertised interval and postpone their fallback heartbeat whenever any inbound envelope proves the socket is alive, avoiding redundant application frames on relay-backed connections. Relay controllers use ready-v2 (`accepted` then `ready`) and send no ADE hello before the machine pipe/local listener exists; a non-v2 Worker is retried on a fresh legacy socket, never downgraded in place. iOS races up to three authenticated candidates and shares monotonic `connectionAttempt` metadata so the host rejects late losing routes; `hello_ok.connectionTransport` is the host-observed direct/relay truth. The same envelope channel carries project catalog, project-switch, and runtime-scoped project-action messages (browse/open/create/clone/list GitHub repos/default parent directory); on a hosted-project switch the new host service adopts the open sockets, so connected phones survive the swap. A machine-wide fallback handler serves catalog/project actions when no project host owns the listener, while handoff-time reconnects still park for adoption by the next host. Phones keep per-host-DB sync cursors keyed by the `serverDbSiteId` from `hello_ok`, and the host filters high-churn tables the phone never reads (transcripts, operations, usage logs, automation runs) from phone changesets.

### 13.2 Device model

- **Sync authority**: a runtime on one reachable machine owns live execution side effects (agents and PTYs) for a given project. Stored in the synced `sync_cluster_state` singleton row (`brain_device_id` is the legacy internal column name). Transfer requires a clean preflight with no running turns or live PTYs. CTO history and idle chats are durable and survive handoff.
- **Controllers**: other connected devices (phones always; a second desktop optionally). Controllers read synced state and send commands to the authority runtime.
- **Independent desktops**: a second Mac can run its own ADE runtime and work independently through git without joining an ADE sync session. The tracked `.ade/` scaffold/config layer makes a clone look like an ADE project immediately.

### 13.3 iOS companion sync model

- Account-machine directory presence is a 90-second discovery lease, not a
  transport verdict: a row with a directory-verified secure endpoint remains
  dialable after `online` expires. Directory calls retry one 401 with a forced
  refresh; only a repeated 401/403 is credential expiry. Adoption checks the
  account owner/session generation around persistence so sign-out/account
  switch cannot race trust back into storage.
- Every fresh signed-out app launch starts at the account choice. Sign-in is
  the primary, PIN-less path through the account directory and Relay;
  **Continue without an account** keeps QR + PIN, Nearby + PIN, and the
  advanced SSH bootstrap available. There is no pairing-link paste or manual
  address + PIN surface. Signed-in launches enter directly.
- App launch reads pairing secret from iOS Keychain after that choice.
- Opens authenticated WebSocket candidates in two phases: direct LAN then
  Tailscale routes first, followed by Relay only when direct routes do not win.
  Each phase uses a 250 ms stagger, bounded candidate count and connection
  budget, and only `hello_ok` can win. Attempts share one correlation id and
  retain only bounded host/port plus coarse failure classes. Sends local
  `db_version` plus the per-host-DB cursor map (`remoteDbVersionBySite`); host
  replies with its `serverDbSiteId` and sends incremental catch-up changesets
  or, for an eligible gap over 5,000 versions, one compact ACK-gated catch-up
  batch through the existing chunked envelope transport.
- `hello_ok` can include the host's mobile project catalog and project-action feature flag. The iOS app shows a native project hub until an active project is selected, can browse/open/create/clone projects on the paired machine when project actions are available, then drives `project_switch_request` / `project_switch_result`; the port stays stable across switches.
- Bidirectional sync continues; inbound processing (envelope parse, gunzip, chunk reassembly, changeset decode + apply) runs off the main actor. On disconnect: a fast exponential-backoff burst, then an indefinite ~30 s slow-heartbeat retry — the phone never permanently gives up. `reconnectIfPossible` is guarded against overlapping runs.
- Chat streaming resumes by sequence: each `chat_event` carries a host-assigned per-session `seq` backed by a replay buffer; `chat_subscribe` passes `sinceSeq` so reconnects replay only the missed events. `seq` is a resume cursor, not an event identity — it is unique only within one runtime lifetime, while the transcript it numbers is durable and keeps being appended across restarts, so a client that keys identity or dedupe on `sessionId + seq` alone will silently drop real events as phantom replays (see [features/chat/composer-and-ui.md](./features/chat/composer-and-ui.md#fragile-and-tricky-wiring)). Rehydrated sessions seed their counter from the transcript's maximum so numbering stays strictly increasing, and clients pair `seq` with the event timestamp (or, for blocking gates, the host-assigned `itemId`). A per-session hydration barrier holds the live broadcaster and transcript pump until the snapshot ack, then resumes from the pre-capture logical byte offset so concurrent appends cannot overtake or fall between snapshot and stream. The subscribe ack also carries `turnActive` (live turn state from the agent chat service) plus `cursorKind: "byte"`, `tailStartOffset`, and `hasOlderHistory`. Hosts advertising `chatHistoryPaging` accept 256 KiB `chat_history` pages only for the already-authorized subscription and matching project/personal/foreign scope, so mobile scrollback never needs a project switch or runtime boot and preserves its cursor across transient `unavailable` responses. `chat.getTranscript` remains the legacy opaque-cursor fallback; full runtimes advertise append-stable `cursorKind: "byte"` offsets and the minimal headless fallback advertises `cursorKind: "index"`. When the host advertises the `crossProjectChat` feature flag, `chat_subscribe` can also name a foreign (non-active) project via `projectId`/`projectRootPath`; the host streams that project's transcript read-only straight off its `.ade` transcript files, so the all-projects Hub can open any project's chat without a project switch or runtime boot. Personal subscriptions instead send `chatScope: "personal"`; the host resolves the durable transcript and active-turn state through `PersonalChatScope` with no project id.
- User-message delivery is durable across that stream: accepted messages retain
  processed/unprocessed state, and unprocessed rows expose Run next / Edit /
  Dismiss through idempotent `chat.resolveUnprocessedMessage`. Turn stalls and
  recovery use provider-neutral `turn_health`, `turn_recovery`, and
  `chat.recoverTurn`; raw moderation activity is summarized once in
  `turn_diagnostics` instead of rendered as repeated cards.
- Session lifecycle columns (`settled_at`, `status_note`,
  `attention_requested_at`, `attention_message`, `last_turn_failed_at`) replicate
  with `terminal_sessions`. The all-project roster carries the same additive
  fields plus `exitCode`; old project databases are read with null fallbacks.
  Desktop, ADE Code, and iOS therefore derive Work grouping and loud attention
  from the same persisted facts instead of inventing client-local lifecycle
  state.
- All reads are local and scoped to the active project id — the iOS tab is instant and offline-capable after the selected project's row has hydrated.
- Writes from user actions: write locally, replicate to host. Execution commands (create PR, run command) are routed to the host via the `command`/`command_ack`/`command_result` message flow.
- Sub-protocols: changeset sync, project catalog/switch, file access,
  subscribed terminal stream/control, chat stream (live `chat_event`
  push from host, including read-only cross-project quick look and explicit
  personal-chat scope), the
  all-projects chat roster feed backing the Hub, command routing, and
  lane presence announce/release.
  Command routing includes the Work CLI launcher
  (`work.startCliSession`), whose provider command construction is
  shared with the desktop Work tab through
  `apps/desktop/src/shared/cliLaunch.ts`.
  Runtime-scoped `personalChats.*` descriptors let the Hub list/create/manage
  personal chats without switching projects. The iOS cache is keyed by paired
  host; creates require a live host, while sends are the only personal action
  allowed into the offline command queue.
- Terminal streaming uses lifetime logical UTF-8 offsets over a rolling
  16 MiB physical transcript. The host snapshot barrier queues live output
  during capture; iOS drops replay/overlap and resubscribes once on a gap,
  appending deltas or replacing from an authoritative full snapshot. Terminal
  input is one-at-a-time and ACK/dedupe protected by stable input ids; timeout
  and reconnect reuse the same id, while legacy hosts get one-shot input.
- Pairing is a **user-set 6-digit PIN** stored at `.ade/secrets/sync-pin.json` on the host. The phone sends the PIN once after scanning the QR or choosing a Nearby machine; the host returns a durable per-device secret. The QR payload is a **v3 smart URL** (`https://ade-app.dev/pair#<base64url(JSON)>` — host identity + port + address candidates + optional cloud-relay URL, no pairing code) used only as the internal system-camera/App Clip wire encoding; there is no user-facing pairing link. Pairing is hardened with **device-bound DPoP**: iOS keeps a Secure Enclave P-256 key and every paired hello carries a signed proof (`requireDpop` / `ADE_SYNC_REQUIRE_DPOP` on the host, enforced on both the project host and the brain ingress path).
- Off-LAN transport: an account-gated **cloud tunnel relay** (`apps/tunnel-relay`, §2.7) advertised as the lowest-priority `relay` address candidate. Direct LAN/Tailscale routes remain preferred and work without an account. Relay is active whenever the host is signed in and has a current account lease; there is no separate user toggle or CLI kill-switch. Control connection/reconnection is single-flight, and a transient account-token refresh exception keeps the control route only through the last known lease expiry. Every Relay connection carries a fresh in-memory account token, and the host accepts it only when both clients are signed in to the same account; sign-out closes Relay immediately. Capable paired peers renew that authorization in place with DPoP-bound `relayReauthorizeV1`; terminal identity/proof failures close, while token-expired/verifier-unavailable failures may retry within a short grace. A claim endpoint response with exact status `409` permits one serialized machine-key/secret rotation and re-claim; other failures never rotate identity. Signed account-directory adoption creates device-bound direct trust equivalent to QR/Nearby/SSH pairing: sign-out removes directory and Relay access but keeps that direct trust until explicit Forget. Control-route health preserves open and bridge-validation timestamps independently and exposes its specific skip/error reason; structured lifecycle logs retain claim status, HTTP upgrade status plus a bounded response body, and close code/reason/opened state. Relay TLS terminates at the operator, so payloads are not end-to-end encrypted; adding relay E2E encryption remains planned security work.
- Push: APNs alert pushes (deep-linked) and Live Activity updates via
  `apps/push-relay` (§2.7). Signed-in iOS registers account APNs and
  push-to-start tokens directly with the authenticated Attention relay;
  runtime-scoped `push.*` commands over the paired WebSocket remain the
  legacy/machine-scoped compatibility path.
- Widgets: `ADELockScreenWidget` reads from a shared `WorkspaceSnapshot` in the App Group container. `ADEAgentActivityWidget` registers an ActivityKit Live Activity + Dynamic Island for active agent runs. Home Screen and Control Center surfaces are not registered.
- Tabs: Lanes, Files, Work, PRs, CTO, Settings.

### 13.4 Conflict resolution semantics

- LWW per column via Lamport timestamps is the default merge.
- `ON CONFLICT(...)` upserts must target PK only (non-PK UNIQUE does not survive CRR retrofit).
- Non-PK merge cases use explicit select-then-update.

### 13.5 Secret isolation

- `.ade/local.secret.yaml` (API keys, ADE CLI configs), sync site ID, sync device ID, sync bootstrap token: **never sync**.
- Each device stores its own pairing secret in OS Keychain.
- Device-bound direct pairing secrets survive account sign-out and are removed
  only by explicit machine forget or the versioned trust-reset policy; Relay
  authorization always requires a fresh matching account proof.
- A pairing made by hand at the machine (QR/Nearby-PIN/SSH) can be adopted into
  an account when the same device presents a DPoP proof against the key already
  pinned on that record plus a verified same-account attestation; a keyless
  record or one owned by another account is refused. Adoption records
  `localTrustOrigin`, so signing out or switching accounts demotes the record
  back to purely local trust rather than deleting it. Signing in never makes a
  hand-paired machine destructible.
- Linear creds, GitHub tokens, provider API keys stay on the host.
- Commands from non-host devices validated and executed by the host only.
- The release's versioned trust reset clears only saved connection grants:
  packaged desktop target/pairing files, iOS connection tokens and
  machine-scoped profile/cursor/queue state, and hosted-web IndexedDB
  environments/selection. It preserves account sessions, stable machine/device
  and DPoP identities, PINs, projects, SSH files, analytics preferences, and
  unrelated browser state. Each surface writes a one-time marker; desktop waits
  for the forced background-service restart before committing its marker.

Related sync docs: [Sync and multi-device](./features/sync-and-multi-device/README.md), [iOS companion](./features/sync-and-multi-device/ios-companion.md), and [Remote commands](./features/sync-and-multi-device/remote-commands.md).

---

## 14. Build, Test, Deploy

### 14.1 Monorepo layout

```
ADE/
├── apps/
│   ├── ade-cli/        # ADE brain, manual runtime entry points, `ade` CLI, `ade code`
│   ├── desktop/        # Electron client (multi-window; local + SSH-bound runtime bindings)
│   ├── ios/            # Native SwiftUI controller (WebSocket to ADE machine)
│   ├── web/            # Marketing + download landing (Vite + React)
│   ├── push-relay/     # Cloudflare Worker + D1: APNs push + Live Activity relay
│   ├── tunnel-relay/   # Cloudflare Worker + Durable Object: off-LAN sync tunnel
│   ├── account-directory/ # Cloudflare Worker + D1: account machines + device login
│   └── webhook-relay/  # Cloudflare Worker: GitHub webhook relay
├── docs/
│   ├── PRD.md
│   ├── features/
│   ├── perf/
│   ├── plans/
│   └── playbooks/
├── scripts/            # Release, validate, notarize, after-pack (per-platform)
│                       # Platform-specific: validate-mac-artifacts.mjs,
│                       # validate-win-artifacts.mjs, ade-cli-windows-wrapper.cmd, etc.
├── apps/desktop/vendor/crsqlite/
│   ├── darwin-arm64/
│   ├── darwin-x64/
│   └── win32-x64/      # Prebuilt cr-sqlite native binaries per platform
├── .github/workflows/
│   ├── ci.yml
│   ├── prepare-release.yml
│   ├── release.yml
│   └── release-core.yml
├── docs.json           # Mintlify public docs config (separate site)
├── package.json        # Root test aggregator
└── .ade/               # Self-hosted ADE project state (ignored subset)
```

Root `package.json` is a thin aggregator: `npm test` and `npm run test:ci` run the desktop suite in CI-style shards plus the ade-cli suite. `npm run test:coverage` runs desktop coverage plus the ade-cli suite.

Per-app scripts:

| App | Key scripts |
|-----|-------------|
| `apps/desktop` | `dev`, `build` (tsup + vite), `typecheck`, `test` (vitest), `lint` (ESLint), `dist:mac`, `dist:mac:universal:signed:zip`, `notarize:mac:dmg`, `validate:mac:artifacts`, `rebuild:native`, `version:ci`, `version:release`, `ade:dev`, `ade:build`, `ade:test`. |
| `apps/ade-cli` | `dev`, `build`, `typecheck`, `test` (typed CLI commands, headless runtime, and Ink Work chat TUI). |
| `apps/web` | `dev`, `build`, `preview`, `typecheck`. |
| `apps/ios` | Xcode project; tests via `xcodebuild test` / Xcode. |
| `apps/push-relay`, `apps/tunnel-relay`, `apps/account-directory`, `apps/webhook-relay` | Cloudflare Workers: `typecheck`, `test` (vitest), `deploy` (wrangler). |

### 14.2 CI (`.github/workflows/ci.yml`)

Stages:

1. **Install** (`install` job) — checkout, setup Node 22, parallel `npm ci` across desktop, ade-cli, web, webhook-relay, and push-relay with a shared cache keyed on those lockfiles. (`apps/tunnel-relay` and `apps/account-directory` have independent Worker jobs that run `npm ci` inline.)
2. **Parallel checks**:
   - `secret-scan` — gitleaks on full history.
   - `typecheck-desktop` — `cd apps/desktop && npm run typecheck`.
   - `typecheck-ade-cli` — `cd apps/ade-cli && npm run typecheck`.
   - `typecheck-web` — `cd apps/web && npm run typecheck`.
   - `typecheck-webhook-relay`, `typecheck-push-relay`, `typecheck-tunnel-relay`, `typecheck-account-directory` — the four Cloudflare Workers; account-directory also runs a Wrangler dry-run build.
   - `lint-desktop` — ESLint on `src/**/*.{ts,tsx}`.
   - `test-desktop` — **8-way shard matrix**: `npx vitest run --shard=${{ matrix.shard }}/8` across shards 1–8.
   - `test-ade-cli` — full ade-cli vitest (covers the brain push publisher and tunnel client under `services/push/` + `services/sync/`).
   - `test-webhook-relay`, `test-push-relay`, `test-tunnel-relay`, `test-account-directory` — the four Cloudflare Workers.
   - `build` — desktop, ade-cli, and web built sequentially after install.
   - `validate-docs` — `node scripts/validate-docs.mjs`.
3. **Gate** (`ci-pass`) — all required jobs must pass (`if: always()` with failure/cancelled detection).

Sharding is required because the desktop suite is large enough to be slow in a single process.

### 14.3 Test organization

- **Tooling**: Vitest with `node` environment, `pool: "forks"`, `maxForks: 4`, 20s test/hook timeouts.
- **Config**: `apps/desktop/vitest.workspace.ts` defines the `unit-main`, `unit-renderer`, and `unit-shared` projects. The pinned Vitest version does not support CLI `--project`, so `test:unit` is plain `vitest run`, `test:integration` filters `*.integration.test.*`, and `test:component` filters `src/renderer/**/*.test.*`. Root desktop sharding uses `scripts/run-desktop-test-shards.mjs`, which runs `vitest run --shard=N/8` for shards 1-8.
- **Test locations**: colocated with source (`*.test.ts` / `*.test.tsx`) under `src/**`.
- **Setup**: `apps/desktop/src/test/setup.ts` (browser/DOM mocks via `browserMock.ts`).
- **Philosophy**: keep tests that carry real value; aggressively remove brittle UI/render tests; keep mutation + integration coverage solid.
- **Smoke tests**: `packagedRuntimeSmoke.test.ts` for packaged runtime.

### 14.4 Packaging (Electron Builder)

macOS:

- `npm run dist:mac` — notarized .dmg for local distribution.
- `npm run dist:mac:universal:signed` — universal x64+arm64 signed builds.
- `npm run dist:mac:universal:signed:zip` — zip archive variant.

Windows:

- `npm run dist:win` — x64 installer via `electron-builder --win --x64`, wrapped with `validate:win:artifacts` (preflight) and `validate:win:release` (post-build) checks in `apps/desktop/scripts/validate-win-artifacts.mjs`.
- Windows-only wrappers for the bundled `ade` CLI ship in `apps/desktop/scripts/`: `ade-cli-windows-wrapper.cmd` (launcher) and `ade-cli-install-path.cmd` (idempotent PATH install helper). The platform-agnostic `.sh` wrapper covers macOS/Linux.
- The Windows installer bundles the prebuilt `cr-sqlite` native binary from `apps/desktop/vendor/crsqlite/win32-x64/` and a Windows node-pty ConPTY worker. `validate-win-artifacts.mjs` asserts each one is unpacked.
- GitHub Actions `release-core.yml` builds and validates Windows artifacts. The release job picks up `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` (or legacy `WIN_CSC_*`) from secrets and forwards them as electron-builder's `CSC_LINK` / `CSC_KEY_PASSWORD` to sign the installer and `app.exe`; the desktop config sets SHA-256 hashing and the DigiCert RFC3161 timestamp server. When the secrets are absent, the workflow still produces unsigned Windows artifacts.
- Ongoing Windows integration lane (rebase with `main`, smoke tests, backlog): `docs/development/windows-port-lane.md`.

Post-packaging hardening (`apps/desktop/scripts/`):

- `runtimeBinaryPermissions.cjs` — restores exec bits on `node-pty` spawn helpers, Codex vendor binaries, Claude SDK ripgrep helpers; patches `node-pty` `unixTerminal.js` for ASAR-unpacked paths.
- `after-pack-runtime-fixes.cjs` — electron-builder after-pack hook. Covers both platforms: runs the permissions pass on macOS and stages CLI wrappers + runtime shims on Windows.
- `validate-mac-artifacts.mjs` / `validate-win-artifacts.mjs` — per-platform artifact validators; confirm expected binaries, release signing state, bundled ADE CLI help, isolated ADE Code TUI help, and every required bundled ADE Agent Skill `SKILL.md`. They also fail if the bundled TUI references `__dirname` / `__filename` without ESM shims. Windows signing verification is opt-in with `--require-signed` or `ADE_REQUIRE_WIN_SIGNING=1`.
- `notarize-mac-dmg.mjs` — Apple notarization.

### 14.5 Documentation

- **Internal docs** (this directory + `docs/`) — for engineers and agents. Not published.
- **Public docs site** — Mintlify, configured in `docs.json` at repo root. Content lives alongside the repo (`introduction.mdx`, `quickstart.mdx`, `welcome.mdx`, `key-concepts.mdx`, plus subdirs `getting-started/`, `guides/`, `lanes/`, `chat/`, `cto/`, `pull-requests/`, `configuration/`, `tools/`, `computer-use/`, `automations/`, `ai-tools/`). Theme `maple`, brand primary `#7C3AED`.
- **Doc validation**: `scripts/validate-docs.mjs` runs in CI to catch broken links / structure drift.

---

## 15. Cross-Cutting Concerns

### 15.1 Logging

- **Main-process logger** — `apps/desktop/src/main/services/logging/logger.ts` (`createFileLogger`). Writes structured JSONL to `~/.ade/logs/<project>/ade-main.log`. Categories: `ipc.*`, `project.startup_task_*`, `renderer.*`, per-service telemetry.
- **Machine-brain logger** — the headless runtime reuses `createFileLogger` through `apps/ade-cli/src/services/runtime/brainLogger.ts`, writes `~/.ade/runtime/brain.jsonl` with 10 MiB `.1` rotation, and mirrors timestamped warnings/errors to stderr.
- **Redaction** — all log writes pass through `redactSecrets()` / `sanitizeStructuredData()`.
- **Retention** — local, indefinite until user clears.

### 15.2 Telemetry

The normative privacy, consent, taxonomy, quota, configuration, and instrumentation rules are in [logging.md](./logging.md). This section is only the architecture summary.

- **IPC tracing** — every handler emits `ipc.invoke.begin` / `ipc.invoke.done` / `ipc.invoke.failed` with call ID, channel, window ID, duration, summarized args. Mandatory for new handlers.
- **Renderer lifecycle** — `renderer.route_change`, `renderer.tab_change`, `renderer.window_error`, `renderer.unhandled_rejection`, `renderer.event_loop_stall`. Mandatory for new surfaces that introduce novel lifecycle transitions.
- **Startup tasks** — `project.startup_task_enabled`, `project.startup_task_skipped`, `project.startup_task_begin`, `project.startup_task_done` with durations.
- **Usage tracking** — `usageTrackingService.ts` + `usageStatsStore.ts` + `usage/ledgers/*` + `budgetCapService.ts` account for provider quotas/cost and retrospective ADE activity. The top-bar Usage popup (`HeaderUsageControl` → `UsageQuotaPanel` + collapsible `BudgetCapEditor`) shows live quota windows; Settings > Stats and the empty Work composer use the cached cross-client activity projection. After a successful meaningful mutation, desktop IPC, ADE action RPC, and paired sync-command ingress record one local `usage_events` row with client attribution; reads, polling, background work, and failed calls do not count. `main.ts` keeps a dormant usage tracker available while no runtime project is bound so the main menu can show machine-level Claude/Codex usage. Once a project runtime is bound, the machine brain is the only poller; preload forwards only that binding's runtime events, and the compact header and open panel reject older same-binding snapshots and reset their snapshot/provider state when the binding changes.
- **Local perf runs** — `scripts/perf-launch.mjs` / `scripts/run-perf-scenario.mjs` launch ADE with a run id, feed renderer scenarios, and collect JSONL events plus `summary.json` under `~/.ade/perf-runs/<runId>/`. This is local-only diagnostics, not external telemetry.
- **Privacy-bounded product analytics** — configured builds manually capture a strict allowlist of PostHog events for a once-only install milestone, app opens, activation, key normalized screen arrivals, successful feature actions, truthful persisted work-session completions, update-prompt decisions, coarse error categories, daily aggregate usage, and analytics-budget health. Canonical desktop/runtime/hosted-client events, direct native-mobile UI events (`ade_mobile_*`), and public-site events (`ade_marketing_*`) use separate namespaces so marketing visits and the phone's own installation identity cannot inflate product activation or retention. Ordinary events salt/hash project and session identifiers, disable GeoIP and person profiles, and reject arbitrary properties. Once ADE knows a signed-in account, the shared service may send one quota-counted `$identify` that links anonymous history to a one-way account hash and sets only plan, platform, and app version; explicit sign-out rotates the anonymous identity. It never sends prompts, code, file or terminal content, repository names or paths, command arguments, URLs, branch names, raw account IDs, email addresses, error messages, stack traces, or recordings. Session replay, autocapture, automatic pageviews, surveys, and feature flags are disabled or absent.
- **Quota controls** — analytics is lazy and batched, with a hard 200-event installation-wide UTC-day budget, tighter per-event and per-minute caps, deduplication windows, bounded queues, and a summarized budget event. Persisted `usage_events` are exported only after successful user mutations; reads, render loops, polling, streams, terminal bytes, and retries do not generate product events. Native mobile and public-web clients apply still-lower local ceilings. Budget `sent_count` is the legacy wire name for attempts accepted/enqueued locally, not confirmed PostHog delivery.
- **Choice and configuration** — product analytics remains inert when no valid public `phc_` PostHog project token is configured. Desktop/runtime and native iOS surfaces are default-on; desktop/runtime exposes a durable opt-out, while native iOS has no in-app preference. Hosted web and the public marketing site require an affirmative first-run choice before collection. `ADE_DISABLE_PRODUCT_ANALYTICS=1` is the runtime kill-switch, and development builds require explicit `ADE_ENABLE_PRODUCT_ANALYTICS_IN_DEVELOPMENT=1`. Release builds inject only the public project token and ingestion host. The personal `phx_` provisioning key is never bundled and is accepted only by `scripts/posthog/provision.mjs`; dashboard definitions and the credential-safe provisioner live under `scripts/posthog/`.

### 15.3 Error surfaces

- Every cleanup step is `try/catch` isolated — one failing service must not block shutdown.
- IPC handlers return structured errors, never crash the renderer.
- CTO and AI UI components use try/catch around async loads with `isLoading`/`error` state and retry actions.
- Graceful degradation: when no provider is configured, AI surfaces show explanatory disabled state rather than spinning.
- Explicit fallbacks: Linear sync skips when no credentials/workflows; Linear ingress stays dormant without config; trivial session summaries skip AI entirely.

### 15.4 Observability / dev tools

- **Dev tools probe** — `devToolsService.ts` checks for `git` and `gh` CLI availability at startup, surfacing warnings in UI.
- **Port allocation** — `portAllocationService.ts` manages per-lane port leases with orphan recovery.
- **Runtime diagnostics** — `runtimeDiagnosticsService.ts` surfaces lane launch context and runtime state.
- **Sync telemetry** — `sync_cluster_state` + device registry surfaced in the
  top-bar Connections panel.
- **Operation timeline** — `operationService.ts` + History page provide full audit trail for debugging and undo.
- **Shutdown sequence**:
  1. Stop head watcher + background timers.
  2. Dispose pollers and ingress services.
  3. Stop file watchers and tests.
  4. Dispose PTYs and agent chat sessions.
  5. Dispose sync service (stop host, disconnect peer).
  6. **Flush SQLite before service disposal begins** (durable writes first).
  7. Per-service `try/catch`-isolated dispose.
  8. Final SQLite flush + close.

---

## Cross-reference index

- Product spec · [PRD.md](./PRD.md)
- Runtime and remote bindings · [Remote runtime](./features/remote-runtime/README.md)
- Terminal client · [ADE Code](./features/ade-code/README.md)
- Lanes and Git isolation · [Lanes](./features/lanes/README.md)
- Agent chat · [Chat](./features/chat/README.md)
- Projectless AI conversations · [Personal chats](./features/personal-chats/README.md)
- Pull requests and queues · [Pull Requests](./features/pull-requests/README.md)
- Multi-device sync and iOS · [Sync and Multi-device](./features/sync-and-multi-device/README.md)
- Cross-machine Work chat continuation · [Cross-machine session handoff](./features/sync-and-multi-device/cross-machine-session-handoff.md)
- Terminal sessions and Work · [Terminals and Sessions](./features/terminals-and-sessions/README.md)
- Computer-use proof · [Computer Use](./features/computer-use/README.md)
- Deeplinks · [Deeplinks](./features/deeplinks/README.md)
- Settings and onboarding · [Onboarding and Settings](./features/onboarding-and-settings/README.md)
- Feature index · [features/](./features/)

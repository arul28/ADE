# ADE Brain / Runtime Architecture Overhaul — Ground Truth & Implementation Plan

> **Status:** Locked plan, ready to execute. **Decision: Layer 1** — make the
> brain an always-on, machine-owned, singleton service that clients *attach* to,
> without changing what the brain does (no execution split, no changeset-engine
> rewrite). Every claim below is verified against code (file:line) by a read-only
> multi-agent sweep; nothing was run.
>
> **For the executing agent:** This is the single source of truth. Read it top to
> bottom, then implement Section 7 (phased plan) using the file:line anchors.
> Honor the guardrails in Section 0. When code disagrees with this doc, trust the
> code and note the drift here.

---

## 0. Guardrails (read first)

- **NEVER spawn a second `ade serve` / runtime on this machine while developing.**
  The user runs a live **ADE Beta** whose brain is on this machine; a second
  sync-enabled runtime on the same project DB triggers a brain-war that kills
  Beta's sessions. Build and unit-test in isolation; do not launch runtimes.
- **Edit only in this worktree** (`.ade/worktrees/mobile-chat-ui-parity-0c4bcd0a/...`),
  never the project-root checkout.
- **No git worktrees for sub-agents.** Work in the main working directory.
- **Two nouns only, going forward: `brain` and `runtime`.** Drop user-facing
  "daemon" and "socket."

---

## 1. Glossary (locked)

| Term | Meaning |
|---|---|
| **Machine** | A physical computer. Shown to users by OS ComputerName (`scutil --get ComputerName`). In the DB it's a `devices` row (`device_type: desktop`), identified by a per-machine `deviceId` at `$ADE_HOME/secrets/sync-device-id`. |
| **Runtime** | An `ade serve` process. The thing that opens project DBs and executes work (agents, PTYs, git, orchestrator). |
| **Brain** | The **role**: the always-on, machine-owned runtime that carries the websocket + project catalog + executor-authority for a channel. **One per channel.** Normally the only runtime. (Legacy code/DB name: "host" / `brain_*` / `sync_cluster_state`.) |
| **Client** | Desktop renderer, ADE Code TUI, iOS app. They **attach** to the brain; they don't host. iOS is controller-only, always. |
| **Channel** | A release lane: stable (no suffix), **beta**, **alpha**, plus dev. Each isolates everything under its own `ADE_HOME` (`~/.ade`, `~/.ade-beta`, `~/.ade-alpha`). |
| **`ADE_HOME`** | The machine state root for a channel. Holds `projects.json`, `secrets/`, `sock/`, `runtime/`, `bin/`. Default `~/.ade`; channel builds set `~/.ade-<channel>`. |
| **Project** | A repo opened in ADE. Exactly **one DB** at `<project>/.ade/ade.db`. One brain hosts many projects. |
| **DB** | `<project>/.ade/ade.db` (SQLite WAL + cr-sqlite CRR). Per project. Local processes share the file; remote devices (phone) keep a **replica** synced via changesets. |
| **Lane** | A worktree under `.ade/worktrees/`. **Shares the project DB**; no DB or runtime of its own. "Lane runtime isolation" = ports/hostname/OAuth/env, run inside the active runtime. |
| **RPC socket** | Unix-domain socket (`$ADE_HOME/sock/ade.sock`), how local clients (desktop, TUI) attach. Per runtime process. Multiplexes all the runtime's projects. |
| **Sync websocket** | TCP 8787 (configurable), how the iOS app connects. Bound to one active project's host today (per-project port). |
| **Catalog** | The machine-level list of projects a brain hosts; sent to the phone in `hello_ok`; phone picks one. |
| **Replica (iOS)** | The phone's own SQLite copy (`Application Support/ADE/ade.db`) that converges with the host via cr-sqlite changesets. The phone never opens the host's DB file. |
| **Pairing** | Phone↔brain auth via a user-set 6-digit PIN → durable per-device secret (phone Keychain). PIN at `$ADE_HOME/secrets/sync-pin.json`, machine-global. |

---

## 2. Context — what ADE is, and the surfaces involved

ADE is a local-first, per-machine system. The engine is **`ade serve`** (in
`apps/ade-cli/`), which opens project DBs and runs all execution. Three client
surfaces attach to it:

- **ADE Desktop** (`apps/desktop`, Electron) — spawns/attaches to `ade serve` via
  `localRuntimeConnectionPool`; the renderer is a client over the RPC socket.
- **ADE Code / TUI** (`apps/ade-cli` `ade code`) — attaches to `ade serve` over
  the RPC socket, or spawns one if absent.
- **ADE Mobile** (`apps/ios`) — connects over the **sync websocket**; controller-only.

Everything is **channel-scoped** via `ADE_HOME`. Stable, beta, and alpha each get
their own `~/.ade[-channel]` tree (own socket, registry, secrets, DBs-of-record).

---

## 3. Current architecture (verified)

### 3.1 The brain is `ade serve`, fused runtime+brain, one per channel, already machine-scoped
- A single `ade serve` per channel owns the machine project registry
  `$ADE_HOME/projects.json` (`machineLayout.ts:55`, `projectRegistry.ts:106-234`),
  deterministic `projectId = project_<sha256(rootPath)[:24]>` (`projectRegistry.ts:45-52`).
- It lazily opens **every** project's DB: `ProjectScopeRegistry.get` →
  `createAdeRuntime({projectRoot})` → `openKvDb(<projectRoot>/.ade/ade.db)`
  (`projectScope.ts:63-81`, `bootstrap.ts:461`, `adeLayout.ts:110`). One DB handle
  per project per process; the daemon holds many at once.
- It builds the mobile **catalog** from that registry
  (`cli.ts:12865, 12913-12918`, `toMobileProjectSummary`).
- It runs the **websocket** host (`syncHostService.ts:1222`, `new WebSocketServer`).
- It **executes everything** — the host service borrows ~30 in-process services
  (`syncHostService.ts:316-383`): `ptyService`, `agentChatService`, `laneService`,
  `gitService`, CTO/worker stack, etc., constructed in `bootstrap.ts` against the
  single `db`. **Brain and runtime are the same process.**

### 3.2 How clients attach/spawn + lifecycle (who dies when)
- **Default machine socket** = `$ADE_HOME/sock/ade.sock` (`machineLayout.ts:47-49`),
  channel-aware via `ADE_HOME`.
- **Desktop**: `tryConnect(socketPath)` first; on failure `spawnRuntime` →
  `[cli, "serve", "--socket", socketPath]` (`localRuntimeConnectionPool.ts:112,
  1122-1133, 1284`). Desktop-spawned daemon gets `ADE_RUNTIME_PARENT_PID`
  (`:1289`) → `monitorRuntimeParentProcess` kills it when the desktop dies
  (`cli.ts:13172-13198`). **Dies with the desktop.**
- **TUI** (`ade code`): attaches first; else `spawnDaemon` **detached + unref'd,
  NO parent-PID** (`connection.ts:451-475, 650-816`). **Survives the TUI forever**
  (no idle-exit on the machine socket).
- **Idle-exit** (`monitorRuntimeIdleExit`, `cli.ts:13212-13237`) arms ONLY for
  ephemeral `/tmp/ade-*` sockets, never the machine socket
  (`isEphemeralRuntimeSocketPath`, `cli.ts:12255-12270`).
- **Background service** exists (launchd `KeepAlive=true` `installLaunchd.ts:68-71`
  / systemd `Restart=always` `installSystemd.ts:46-52`) via `ade serve
  --install-service`, channel-aware label `com.ade.runtime.<channel>`
  (`common.ts:29-38`) — **but disabled for packaged beta/alpha** (see 3.6).
- **Attach-don't-own already works**: a fresh `tryConnect` returns `child: null`
  (`localRuntimeConnectionPool.ts:1141-1146`); `dispose()` →
  `disposeOwnedRuntimeChild(null)` early-returns (`:459, 1062`). An attached brain
  is never killed by the desktop. ✅

### 3.3 The TWO brain surfaces + `forceHostRole` + cluster election
There are **two** places that claim the brain role on a project DB:
1. **`ade serve`** passes `forceHostRole: true` (`cli.ts:12908`).
2. **The desktop in-process syncService** also passes `forceHostRole: true`
   (`main.ts:3540`) and calls `initialize()`→`refreshRoleState()` for **every**
   project it opens (`main.ts:3589-3590`), seizing the cluster row even though its
   host never starts (host startup is off by default there).
3. The default in `bootstrap.ts:1269` is `forceHostRole: … ?? true` — so even
   without (1), every `createAdeRuntime` re-seizes.

Election (`syncService.ts:733-793`): the brain is a single replicated row
`sync_cluster_state` (`deviceRegistryService.ts:46-52`) with `brain_device_id` +
`brain_epoch`. With `forceHostRole`, a process **unconditionally overwrites**
`brain_device_id` to itself and bumps the epoch (`syncService.ts:747-754`). Two
sync-enabled processes on one DB therefore flip the row back and forth → the war.
Without force, the non-brain path takes `stopHostIfRunning()` + viewer-peer
(`:767-786`) — cooperative, no seize.

### 3.4 Projects / DBs / catalog ownership (machine-level)
- Registry + catalog are machine-level (`projects.json`), shared by all runtimes.
  Confirmed: a machine-level brain can own the registry, catalog, and all
  per-project DBs — the `ade serve` daemon already does.
- Multi-process access to one DB is designed-for: `PRAGMA busy_timeout=5000`
  (`kvDb.ts:96-99`), `runtime_processes` heartbeat (`kvDb.ts:1531-1540`,
  `processRegistryService.ts:62-309`), session `owner_pid`/`owner_process_started_at`
  (`kvDb.ts:1516-1524`). Live PTYs/processes are owned by the spawning process and
  reconciled to `detached` when it dies (`bootstrap.ts:567-584`).
- Sole hard machine-local exception: the Electron `built_in_browser` pane (needs
  `WebContentsView`), proxied over `desktop-bridge.sock` (`machineLayout.ts:10-17`).

### 3.5 Mobile connection + per-project-socket serving (VERIFIED — important)
- **The phone connects to a MACHINE conceptually, but project switching reconnects
  it to a different per-project host PORT.** `prepareProjectConnection` returns a
  **non-null** `connection` carrying that project scope's own host `port`
  (`cli.ts:2985-2996`, sourced from `scope.runtime.syncService.getStatus()
  .pairingConnectInfo`). The phone tears down and reconnects to that port
  (`SyncService.swift:1605-1641`). The desktop path is identical on the wire
  (`main.ts:4999-5028`).
- **The sync host is bound to ONE active project DB at a time.** It's constructed
  with a single `db`/`projectId` (`syncService.ts:620-624`) and **rejects
  changesets for any other project** (`resolveSyncHostInboundProjectScope`,
  `syncHostService.ts:489-548`). `projectScope.switchSyncHost` deactivates the
  previous host (`projectScope.ts:143-173`); steady state = exactly one host.
- **What already works for a machine-centric phone UX:** the **catalog is
  machine-level** and is served over the existing connection without reconnect
  (`hello_ok` inline + `project_catalog[_chunk]`, `syncHostService.ts:1972-2005,
  2915-2929`). Pairing secret is **machine-global** (`sync-pin.json` +
  `paired_devices` under machine secrets). So: phone connects to the machine's
  active sync host (8787), browses all projects, picks one, reconnects to that
  project's port **using the same machine pairing token**.
- **Prior-session bug (must fix):** the iOS list + saved profiles + keychain tokens
  were re-keyed on `siteId` (per-runtime/per-DB), declared "PRIMARY identity"
  (`RemoteModels.swift:13-20, 147-153`; `SyncService.swift:6032-6037, 1989-2005`;
  `SettingsPairingSection.swift:269-302`). This makes two project hosts on one
  machine show as two rows — the **opposite** of machine-centric. Machine identity
  (`deviceId`/`hostName`) is already plumbed through the model and the mDNS TXT, so
  re-keying on it is contained (but touches the keychain token scheme → migration).

### 3.6 Channels / `ADE_HOME` / service-install — why beta/alpha have no standing brain
- Channel resolved from `ADE_PACKAGE_CHANNEL` (Info.plist `LSEnvironment`) /
  bundled `package.json` `adePackageChannel` / productName regex
  (`main.ts:222-245`; `scripts/package-channel.mjs:13-30, 353-358`).
- `ADE_HOME=~/.ade-<channel>` set by Info.plist + desktop fallback (`main.ts:253`)
  + CLI wrapper (`ade-cli-macos-wrapper.sh:25,31`).
- **`applyPackagedChannelDefaults()` forces `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1`
  for packaged beta/alpha** (`main.ts:254`) → `shouldAttemptRuntimeServiceInstall`
  false (`main.ts:1061-1065`) → **no launchd/systemd service** → the brain is only
  the desktop-pool-owned daemon that **dies with the desktop**. THIS is why
  beta/alpha have no always-on brain.
- Two channel-collision bugs in the installers: systemd unit filename is hardcoded
  `ade-runtime.service` (`installSystemd.ts:23,73`) — channels clobber each other;
  launchd log paths hardcoded `~/.ade/runtime/launchd.*.log` (`installLaunchd.ts:73-75`)
  — all channels share them. (`ADE_HOME`/`ADE_PACKAGE_CHANNEL` are already in the
  service env passthrough, `common.ts:54-59`.)

### 3.7 Terminology sprawl
- User-facing "**socket**": 50+ occurrences (global `--socket` flag, `ade serve
  --socket`, `ade code --socket`, doctor output, 40+ `ade --socket …` examples,
  in-chat agent guidance in `ChatWorkLogBlock.tsx:207`, `ChatIosSimulatorPanel.tsx`).
- User-facing "**daemon**": ~17 (help banners `cli.ts:424-438, 989-1022`, status
  messages `cli.ts:12492, 12626-12684`, iOS `SettingsPairingSection.swift:427-428`).
- "**runtime**": ~1000+ (command `ade runtime`, lane runtime, UI labels) — keep.
- "**brain**": 0 user-facing today (only icons/role enums).
- Confusing interplay: `ade runtime` vs `ade serve` vs `--headless` vs `--socket`
  all blur "the process I attach to."

---

## 4. Why it's wrong / broken

1. **Brain-war (the crash).** `forceHostRole` makes any sync-enabled process on a
   shared project DB seize `sync_cluster_state` (3.3). A second `ade serve` — or
   even the desktop opening the same project — flips the brain row, churning host
   start/stop and killing live sessions. Root cause of the repeated ADE Beta crashes.
2. **No always-on brain for channels.** The brain dies with whatever client spawned
   it (3.2), and the standing-service path is force-disabled for beta/alpha (3.6).
   You can't reliably reach your machine from the phone if the brain isn't running.
3. **Brain is hostage to a client.** Desktop-spawned brain is tied to the desktop's
   lifetime; TUI-spawned brain leaks forever. Ownership is incoherent.
4. **Mobile is keyed per-runtime, not per-machine** (3.5) — contradicts "connect to
   a machine." Two project hosts = two phone rows.
5. **Service installers collide across channels** (3.6).
6. **Terminology confuses users** (3.7) — three words for one process; "socket" is
   a transport leak.

---

## 5. Target architecture (Layer 1) — keep behavior, change ownership/lifecycle

**The brain keeps doing exactly what `ade serve` does today** (owns registry +
all DBs + catalog + websocket + executes everything). We change only WHERE it
lives and WHO owns it:

### 5.1 Brain = always-on machine service per channel
- One standing `ade serve` per channel, installed as a launchd/systemd service,
  surviving client quits, explicitly started/stopped by the user.
- Clients (desktop, TUI) **attach** to it; if it's not up, they may start it, but
  they never *own* or *claim* it.

### 5.2 No claim, no war
- Remove `forceHostRole` so the standing brain bootstraps the cluster row once and
  everyone else cooperatively reads it. A second/dev runtime becomes a viewer, not
  a second brain.

### 5.3 Mobile = machine-centric (keep per-project sockets behind a machine pairing)
- Phone lists **machines** (keyed on `deviceId`/ComputerName), pairs once per
  machine (PIN, already machine-global), connects → machine catalog → pick project
  → reconnect to that project's host port **under the same machine token**
  (internal plumbing; the user only sees "machine → projects").
- **Out of scope (future / Layer 2):** collapsing per-project sockets into one
  multiplexed websocket. That requires per-project-multiplexed changeset streaming
  over one connection (the host changeset engine + the phone CRDT store are both
  single-active-project today; `syncHostService.ts:489-548`, the phone's
  `resetOutboundCursorStateForActiveProject`). Documented, not done now.

### 5.4 Terminology = brain + runtime
- Add `ade brain start|stop|status` and `ade brain pin set|generate|clear`.
- Replace user-facing "daemon" → "brain", "socket" → "brain"/"endpoint".

### 5.5 Explicitly OUT of scope (do NOT do in this overhaul)
- **No execution split** (separate worker runtimes streaming PTY/chat to a thin
  brain over IPC). Execution stays in the brain process. The `transferReadiness`
  "stop terminals before transfer" gate (`syncService.ts:1148-1151`) proves
  execution + brain must co-reside; moving it needs a PTY/chat IPC protocol —
  a separate, much larger project.
- **No single multiplexed mobile websocket** (5.3).

---

## 6. What this means per surface

- **CLI / brain (`apps/ade-cli`):** `ade serve` becomes the brain; gains a friendly
  `ade brain` front-door. Stops force-claiming. Standing-service install enabled
  per channel. `ade code` keeps attaching (already does).
- **Desktop (`apps/desktop`):** stops seizing the cluster row (`main.ts:3540`
  `forceHostRole:false`); keeps attaching to the standing brain (already safe);
  isolated/dev runtimes spawn with `--no-sync`. Settings "Pair a phone" surfaces
  the brain + its websocket details (already mostly there in `SyncDevicesSection.tsx`).
- **TUI (`ade code`):** benefits from the always-on brain (attaches, no spawn churn).
  Dev loops (`ade code --socket` / dev build) use a separate `ADE_HOME` or
  `--no-sync` to stay off the brain.
- **Mobile (`apps/ios`):** re-keyed to machines; one row per machine; per-machine
  PIN; project switching is internal. No more per-runtime rows.

---

## 7. Implementation plan (phased, file-level)

Phases are independently shippable. Order: **P1 → P4 → P2 → P3** (lifecycle first
to kill the crash; installer fixes ride with it; then naming; then mobile). Each
edit cites current file:line.

### Phase 1 — Brain lifecycle: always-on + drop the war + dev isolation
**Goal:** standing brain per channel; no client owns/claims it; dev runtimes can't disrupt it.

1. **Enable the standing service for channels.**
   `apps/desktop/src/main/main.ts:254` — remove (or dev-only-gate) the forced
   `ADE_DISABLE_RUNTIME_SERVICE_INSTALL = "1"` for packaged beta/alpha. Gating at
   `main.ts:1061-1065` then installs the launchd/systemd service correctly.
2. **Drop `forceHostRole` at ALL THREE source sites** (removing one is insufficient
   — `bootstrap.ts` re-defaults to true):
   - `apps/ade-cli/src/cli.ts:12908` — remove `forceHostRole: true`.
   - `apps/ade-cli/src/bootstrap.ts:1269` — `forceHostRole: … ?? true` → `?? false`.
   - `apps/desktop/src/main/main.ts:3540` — set `forceHostRole: false`.
   - Read-sites need no edits (relax automatically): `syncService.ts:457, 488, 528,
     715, 747-758, 940`; `projectScope.ts:200`.
   - **High blast radius:** the `bootstrap.ts:1269` default flip affects EVERY
     `createAdeRuntime` caller. Sweep all callers with `syncRuntime.enabled` that
     relied on the implicit `true` before landing.
3. **Isolate dev runtimes from the brain.**
   `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` —
   in `startIsolatedRuntime`/`spawnRuntime` (`:1173-1207, 1284-1287`) force
   `--no-sync` (via `buildLocalRuntimeServeArgs(..., {disableSync:true})`,
   `:107-115`) for build-mismatch isolated daemons so they never touch
   `sync_cluster_state` or bind the host port (`cli.ts:12864, 13107-13116`).
   Document `ADE_HOME` as the manual escape for `ade code --socket` dev loops.
4. **Attach-don't-own:** verify only (already correct, 3.2). Keep the desktop
   fallback spawn parent-PID-bound (`:1289`) — do NOT make it persistent; the
   always-on guarantee comes from the service, and an orphan fallback would block
   the service's socket bind.
5. **Tests:** rewrite fixtures asserting `forceHostRole:true`/seize semantics to
   cooperative election — `projectScope.test.ts:55,122,168,220,264`, desktop
   `syncService.test.ts:526,856-953`. Add a test: two runtimes on one DB → second
   becomes viewer, no epoch flip.

### Phase 2 — Service-installer channel fixes (ride with P1)
1. `apps/ade-cli/src/serviceManager/installSystemd.ts:23,73,87,101,102` — derive the
   unit filename from the channel (mirror `ADE_RUNTIME_SERVICE_NAME`,
   `common.ts:29-38`) instead of hardcoded `ade-runtime.service`.
2. `apps/ade-cli/src/serviceManager/installLaunchd.ts:73-75` — root
   `launchd.out.log`/`launchd.err.log` under `ADE_HOME`, not hardcoded `~/.ade`.

### Phase 3 — `ade brain` command + terminology pass
1. **Add `ade brain` subcommand** (`cli.ts` dispatch near `primary === "serve"`):
   - `ade brain start|stop|status` (wraps the service-managed runtime; reuse
     `runtime`/service-manager handlers).
   - `ade brain pin set|generate|clear` (alias of `ade sync pin …`,
     `cli.ts:11892-11926`).
   - Optional `ade brain show` — print websocket connect details (port + address
     candidates + ComputerName) for phone pairing.
   - Keep `ade serve` as the foreground brain process (rename help to "brain").
2. **Rename user-facing strings** (term-audit list; ~70-80 strings). Highest-value:
   - `cli.ts` help banners + status: `:424-438, 973, 989, 1002-1040, 1056-1058,
     12492, 12626-12684, 14910-14911`. "daemon"→"brain"; "runtime daemon socket"→
     "brain connection".
   - Flags: keep `--socket` working internally but hide from help / alias a
     friendlier form; update `ade code --socket`/`--require-socket` help text.
   - `apps/desktop/src/renderer/components/chat/ChatWorkLogBlock.tsx:207` and
     `ChatIosSimulatorPanel.tsx:1986-2030` — drop "socket" from agent guidance.
   - iOS `SettingsPairingSection.swift:427-428` — "Background ADE" label
     (internal; optional).
   - Docs: `docs/README.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md` "daemon"→"brain".
   - Leave internal identifiers (`socketPath`, `brain_device_id`, etc.) as-is.

### Phase 4 — Mobile: machine-centric hosts + pairing/PIN (revert prior siteId work)
**Goal:** the phone connects to a **machine** (never a "runtime"/"socket"), pairs
once with a PIN, then reaches that machine over LAN/Tailscale. Much of the
pairing/PIN UI already EXISTS from prior work; the change is re-keying to machine
identity and keeping the copy machine-centric.

**A. Code re-key + migration**
1. **Re-key discovery/saved/token storage on machine identity** (`deviceId`/
   `hostName`), reverting the prior-session `siteId` keying:
   - `RemoteModels.swift:13-20, 147-153` — machine identity primary; `siteId`
     demoted to an internal per-connection detail.
   - `SyncService.swift:6032-6037` (`syncRuntimeIdentityKey`), `1989-2005`
     (`profileStorageKey`), `6046-6091` (`applyDiscoveredHosts`) — key on `deviceId`,
     collapsing per-project hosts into ONE machine row.
   - `SettingsPairingSection.swift:269-302` — machine merge key; one row per machine.
2. **Keychain token migration:** tokens are saved under the per-`siteId`
   `profileStorageKey`; add a one-time migration re-homing them to the machine
   (`deviceId`) key so paired machines stay paired. Host secret is already
   machine-global → one token works across that machine's project ports.
3. **Project switching stays internal:** phone keeps reconnecting to per-project
   ports on `project_switch_result`, all under the one machine pairing — no UX
   change beyond "machine → catalog → project."

**B. Mobile connection + pairing UX (per-machine)**
4. **Machine list / discovery:** the phone shows a list of **machines** by
   ComputerName (e.g. "Arul's Mac Studio"), discovered via mDNS/Bonjour + Tailscale,
   plus manual host/port entry. One row per machine (subtitle = optional brain
   name). No runtime/socket/IP jargon. (UI exists — `DiscoverHostsSheet`, "Nearby
   machines" — just ensure rows are machine-keyed after step 1.)
5. **One-time PIN pairing → durable token:** first connect over wifi, user enters
   the machine's 6-digit PIN (`SettingsPinSheet` keypad); the host mints a durable
   per-device secret saved in the phone Keychain. Later connects use that token over
   LAN or Tailscale — no PIN re-entry. (Flow exists; keep it.)
6. **Setting the PIN (machine-global) — two surfaces, both already wired:**
   - **Desktop:** the "Pair a phone" panel shows the **machine's brain + its
     websocket connect details** + a PIN editor (generate/set/clear),
     `SyncDevicesSection.tsx:613-660`. Reframe copy to brain/machine.
   - **CLI:** `ade brain pin set|generate|clear` (alias of `ade sync pin …`).
7. **Friendly "no PIN set" path:** when a machine has no PIN, the phone shows the
   "Set a PIN" screen with the exact command (`ade brain pin generate`) + the
   desktop Settings path, instead of a cryptic error. (Exists: `SettingsPinSetupSheet`
   + reactive `pin_not_set` routing — keep, reword to brain.)
8. **Cancelable connect:** keep the Cancel-during-connecting affordance + terminal
   "unreachable" state from prior work so the phone never gets stuck in a loop.

**C. After connecting**
9. Phone gets the machine's **project catalog** over the connection, picks a
   project, reads its replica (per-project reconnect is internal). No "desktop vs
   CLI" notion on the phone — just **machine → projects**.

### Phase 5 — Remote runtime: preserve hardening + confirm safe
**VERIFIED: the overhaul does NOT break remote runtimes.** The desktop SSHes in and
runs **`ade rpc --stdio`** (a thin stdio proxy), not `ade serve` — so the REMOTE
machine's own `ade serve` is the brain for its projects; its `sync_cluster_state`
lives in the remote DB; the local desktop is a pure RPC controller that never
writes the remote cluster row (`bindRemoteProject` touches no syncService;
in-process sync is gated off + local-only). Per-change: (a) forceHostRole removal
SAFE, (b) always-on service SAFE/redundant (remote daemon already detached/
always-on), (c) `--no-sync` SAFE (remote bootstrap never uses the isolated path).
Evidence: `remoteBootstrap.ts` (`rpc --stdio` cmd ~1350-1352; env prefix 230-263),
`cli.ts` (rpc-stdio proxy 12757-12822; daemon spawn 12445-12484; forceHostRole 12908).
1. **PRESERVE the recent hardening — DO NOT REGRESS.** Commit `203afab3a "Harden ADE
   remote runtime connections"` is ALREADY in this branch's base (merge-base = main
   tip `97589d7e6`); it is NOT stale. The only local touches are TINY:
   `runtimeBridge.ts` (+3 lines) and `remoteConnectionPool.ts` (+1). Reconcile those
   4 lines against the hardened baseline; keep all hardening behavior intact
   (multi-route fallback, bounded timeouts, host-key trust, compatibility warnings,
   open-generation guards).
2. **Edge test — stale remote cluster row.** Cooperative election only bootstraps
   the brain when `!cluster` (`syncService.ts:755-756`); `forceHostRole` masks a
   STALE `sync_cluster_state` row (pointing at a departed brain device) by always
   re-seizing. Add handling + a test so a remote DB carrying a stale brain row still
   elects the live remote daemon as host.
3. **Keep `--no-sync` OUT of the remote compatibility-restart path** (`cli.ts`
   ~12516-12551 must keep sync ON); scope `--no-sync` strictly to the desktop's
   `startIsolatedRuntime` (`localRuntimeConnectionPool.ts:1159-1202`).
4. **Per-channel remote homes keep `ADE_DISABLE_RUNTIME_SERVICE_INSTALL=1`** on the
   remote (`remoteBootstrap.ts:248-250`, README "Per-channel layout") so a channel
   daemon doesn't fight the stable login service for the socket — unchanged here.
5. **Mobile↔remote:** the phone reaches a remote machine's daemon **directly** over
   LAN/Tailscale (not via SSH/desktop). Machine-centric re-key (Phase 4) keys on
   `deviceId` which is **per-channel** ADE-home-stable — works for remote machines,
   but a box running stable+beta+alpha shows 3 rows (one per channel). Acceptable;
   note it. The keychain-token migration (Phase 4.2) covers remote pairings too.

### Phase 6 — Docs & public-site terminology overhaul (full restructure)
Reconcile ALL documentation + user-facing lingo to the new model. **Drop "daemon"
and "socket" as user-facing terms everywhere; standardize on `brain` + `runtime`.**
1. **README glossary.** Add a glossary section to the top-level `README.md` defining
   the new canonical vocabulary (brain, runtime, machine, project, DB, lane, client,
   catalog, channel, ADE Mobile) — mirror §1 of this doc. This becomes the single
   source of truth other docs link to.
2. **Internal docs (`docs/`):** rewrite to the new model and fix EVERY grievance in
   §11 — `ARCHITECTURE.md`, `PRD.md`, `README.md`, `features/sync-and-multi-device/*`,
   `features/remote-runtime/*`, `features/ade-code/*`, `apps/ade-cli/README.md`.
   "daemon"→"brain"/"runtime"; remove "project-specific sync host" overstatement
   (G2); fix "one daemon per machine" hard claim (G5); document per-project-port
   mobile reality (G7) + channel-aware service identity (G8); brain==host==cluster
   owner glossary (G3). **Add a user-facing "Connect your phone" guide** in
   `sync-and-multi-device/ios-companion.md`: connect to a **machine** (ComputerName),
   set the PIN via the desktop "Pair a phone" panel or `ade brain pin generate`,
   pair once → reconnect over LAN/Tailscale — no runtime/socket jargon.
3. **Public docs site (Netlify / `apps/web`):** update all marketing + docs copy +
   the `DownloadPage` to the new install model — **"ADE for computers"** (one install
   = app + `ade code` TUI + `ade` CLI + brain) + **ADE Mobile** (separate). Remove
   the "desktop app vs CLI" framing; drop daemon/socket lingo.
   NOTE (memory `feedback_marketing_copy`): public/marketing pages use **recognized
   external terms** (e.g. "worktrees" not the internal "lanes"); keep the
   ADE-internal vocabulary to the docs/CLI, not the marketing site.
4. **CLI help/output:** the Phase-3 term-audit rename covers `ade` strings; ensure
   they match the docs vocabulary exactly (no drift between CLI text and docs).
5. **Cross-link, don't redefine:** README glossary + this doc's §1 are canonical;
   every other doc links to them instead of re-defining terms.

---

## 8. Risks, edge cases, open decisions

- **Device-id sharing is load-bearing.** "Attach reads self as brain without
  re-seizing" depends on the standing service and the desktop sharing the same
  `sync-device-id` under one `ADE_HOME`. Confirmed they resolve the same layout;
  if a service ever runs under a different `ADE_HOME`, a war returns. Guard this.
- **`bootstrap.ts:1269` default flip** is the highest-blast-radius edit — audit
  every `createAdeRuntime` caller before landing.
- **Dev-runtime on the SAME project DB** (different build / `ade code --socket`):
  even without `forceHostRole`, two processes on one DB with the same `deviceId`
  both read as brain and could contend on the host port. Mitigation: `--no-sync`
  for isolated/dev runtimes (P1.3); `ADE_HOME` for fully-isolated dev loops.
- **Migration:** flipping the service on for channels means existing beta/alpha
  users get a standing service on next launch — ensure clean install/idempotency
  and that uninstalling ADE removes the service.
- **Mobile token migration** must be lossless or users must re-pair.

---

## 9. Test strategy

- **Unit:** cluster election without `forceHostRole` (first→brain, second→viewer,
  no epoch flip); `--no-sync` isolated runtime never writes `sync_cluster_state`;
  channel-aware systemd unit name / launchd log path; `ade brain` command surface.
- **Integration (isolated, NOT on this machine's live brain):** standing service
  survives a simulated client quit; desktop attach yields `child:null` and dispose
  doesn't kill; phone discovery collapses two project hosts to one machine row.
- **Manual (on a separate machine or after build):** phone pairs once to a machine,
  switches projects without re-pairing; brain survives desktop quit.
- Honor memory: shard test runs; run only related files; real-value tests only.

### Release-update simulation (FINAL validation gate — run when implementation is done)
Before calling the overhaul done, simulate a REAL electron auto-update against the
user's installed release build, WITHOUT publishing a release. The user runs this
with **ALL ADE shut down** (no app, no brain, no sockets) — a clean-slate baseline,
which is also what makes it safe to do on their primary machine.
1. **Build + notarize** the channel DMG exactly as the GitHub release workflow does
   (same electron-builder config: code-sign + Apple notarize + staple).
2. **Replace the installed app in place** the way electron-updater would (atomic
   swap of `/Applications/ADE[ Beta].app` with the freshly-built build).
3. **Launch and verify the full upgrade path a real user's electron update produces:**
   - app launches → installs/starts the standing brain service (Phase 1);
   - brain is always-on, no `forceHostRole` war, single brain per channel;
   - `ade brain restart` ran post-update → new build-hash matches (no isolated-runtime
     fallback);
   - `ade` / `ade code` resolve on PATH;
   - phone pairs to the machine (machine-centric) + browses/opens projects;
   - remote targets still connect (hardening preserved);
   - the "open the app to update" nudge + Settings "Update ADE" button work.
4. Confirm internal workings (brain lifecycle, sockets, DB, sync) are exactly as
   expected post-upgrade. **This is the go/no-go gate for the migration.**

---

## 10. Distribution & Updates (discussion + decisions)

The brain-as-a-standing-service changes how ADE ships and updates. This must be
designed in, not bolted on.

### Current state (verified)
- **Desktop:** DMG/ZIP from GitHub Releases (`apps/web/.../DownloadPage.tsx:54-57`),
  auto-updates via **electron-updater** (`apps/desktop/src/main/services/updates/
  autoUpdateService.ts` — `checkForUpdates`, `quitAndInstall`). Full pipeline exists.
- **CLI is bundled inside the desktop app**, NOT a standalone download. It ships as
  `Resources/ade-cli/cli.cjs` + wrapper scripts (electron-builder `extraResources`).
  `apps/ade-cli/package.json` is `version: 0.0.0`, `bin: { ade: dist/cli.cjs }`, **not
  published to npm**. No `ade`-on-PATH installer found — so "download just the CLI"
  is NEW work.
- **The desktop already installs the brain service** (`installServiceBestEffort` →
  launchd/systemd, user-level, no sudo). Just force-disabled for beta/alpha (3.6).
- **Mobile:** TestFlight → App Store; installed separately on the phone.

### Migration: can a plain Electron auto-update do the reorg? YES (with care)
Ship a desktop build with the new code (Phase 1) + service-install flag flipped.
electron-updater delivers it → user restarts → new launch installs the standing
brain service. Existing beta users migrate transparently. Must handle on upgrade:
- **Retire the old/orphaned daemons** (old forceHostRole brain, detached TUI
  daemons). Reuse stale-socket shutdown + orphan cleanup
  (`parseNativeLanDiscoveryProcessList`, build-hash mismatch retire).
- **Communicate** the new login-item brain + provide an off switch
  (`ade brain stop` + a Settings toggle).

### Install model — ONE computer install + Mobile (decision)
**Two install paths only**, framed honestly:
1. **ADE (for computers)** — ONE install that bundles **everything**: the ADE app
   (GUI) + **`ade code` (TUI)** + the **`ade` CLI** + the **brain**. Stop calling it
   "the desktop app"; it's "ADE." The CLI/TUI already live inside the app bundle
   (`Resources/ade-cli/cli.cjs`), so this is one artifact, not a bundle of separate
   downloads.
2. **ADE Mobile** — the iOS app, installed separately on the phone.

A standalone CLI download is **dropped for v1** (see "Deferred" below).

### Required net-new piece: put `ade` / `ade code` on PATH
For "you also get the CLI/TUI" to be real, the install must drop an `ade` shim on
the user's PATH (the VS Code "Install 'code' in PATH" pattern). **None exists
today** (no symlink/shim mechanism found). Build it into the install — e.g. symlink
`$ADE_HOME/bin/ade` → the app-bundle CLI wrapper and offer to add it to PATH.
Without this, the bundled CLI is unreachable from a terminal.

### Updates — ONE path (the app updates everything)
- The app's **electron-updater** updates the GUI **and** the bundled CLI/TUI **and**
  (via `ade brain restart`) the brain — **in one go**. Surfaces: the existing
  top-right auto-update prompt + a **Settings "Update ADE" button** that does
  check→download→install→`brain restart`.
- **Build-hash sync wrinkle (must handle):** after the app updates in place
  (electron-updater replaces `/Applications/ADE.app` atomically, same path), the
  standing brain still runs the **old** binary → new-app ↔ old-brain build-hash
  mismatch → it would spin up an isolated runtime and lose the always-on brain.
  Fix: the brain service `ExecStart` points at the app-bundle CLI path; on update
  completion the app fires **`ade brain restart`** so the brain re-execs the new
  binary and the hash matches.

### Update nudge for terminal-only users (open the app to update)
The app is the **only** updater, and that's fine — terminal users who never open
the GUI just get nudged to it:
- Let the **always-on brain do ONE periodic version check** (against GitHub
  Releases) and cache an "update available" flag. Every client reads it — no
  per-command network calls.
- Surface it: the **`ade code` splash screen** ("New ADE version available — open
  the ADE app to update"), a **desktop banner**, optionally the **mobile app**.
- Never block; just point them at the app.

### Deferred (NOT in v1): standalone CLI download
A real standalone CLI (curl / Homebrew / npm + a self-updating bundled binary) is
**deferred** to a later phase for headless servers / terminal-first users. This
does **not** affect **remote VPS runtimes** — those are bootstrapped over SSH by the
app (`remoteBootstrap`), not a CLI download — so dropping the standalone CLI now is
a deferral, not a regression.

### Why the service is disabled for beta/alpha today (context)
No code comment states it (added in commit `3be658856`); inferred from placement
(`main.ts:254`, grouped with the channel `ADE_HOME` isolation defaults). Rationale:
a `KeepAlive` service auto-relaunches forever — undesirable for frequently-updated
pre-release channels — AND the installers are channel-blind today (systemd unit
`ade-runtime.service`, launchd logs `~/.ade/...`), so enabling it for beta/alpha
would have **collided with a co-installed stable service**. I.e., the disable
exists largely because of the very collision bugs Phase 2 fixes. Once service
identity is channel-aware (Phase 2), enabling per channel is safe — each channel
runs its own isolated brain (own `ADE_HOME`, own port, own service label).

### Decisions (confirmed with user)
- [x] **Install model: ONE computer install ("ADE") bundling app + `ade code` TUI +
  `ade` CLI + brain, plus ADE Mobile.** Standalone CLI dropped for v1. ✅
- [x] **Brain auto-starts at login** (launchd `RunAtLoad` + `KeepAlive`), always up
  once installed, until logout/shutdown/explicit stop. Phone can connect anytime. ✅
- [x] **One update path: the app (electron-updater) updates everything** + a Settings
  "Update ADE" button; terminal-only users get a nudge to open the app. Standalone
  CLI + self-updater deferred. ✅
- [x] **Install puts `ade`/`ade code` on PATH** (net-new shim; required for the
  bundled CLI/TUI to be usable). ✅

### Brain enable/disable/update lifecycle (user-facing — build these)
- **Comes up when:** auto-installed + started on the **first app launch**
  (`installServiceBestEffort`). After that it's always-on.
- **Always-on once enabled:** login service (launchd `RunAtLoad` + `KeepAlive`);
  survives app/terminal close; relaunches on crash; restarts at login.
- **Control surface (the bundled `ade` provides these in the terminal):**
  - `ade brain start` — enable + run (loads the channel service).
  - `ade brain stop` — disable + stop (unloads it; stays off across logins until
    `start`). Must `launchctl bootout`/unload, not just kill (KeepAlive relaunches).
  - `ade brain status` — running? port? paired devices?
  - `ade brain restart` — re-exec with the current on-disk binary (apply updates).
  - Desktop Settings: a "Run ADE in the background" toggle calling start/stop.
- **One brain per channel per machine.** Different channels (stable/beta) = separate
  brains by design. The service `ExecStart` points at the app-bundle CLI path
  (single canonical binary per channel — simpler now that only the app installs it).
- **Update rule:** updating the app updates the brain's CODE on disk; the running
  brain keeps old code until **`ade brain restart`**, which the app fires
  automatically post-update.
- [x] **Migration UX:** one-time notice on upgrade — "ADE now runs a lightweight
  background service so your phone can connect anytime; turn it off in Settings" —
  plus an off-switch (`ade brain stop` / Settings toggle). Light (pre-launch).

---

## 11. Doc grievances to reconcile (docs are stale — fix at the end)

- **G1 — "daemon" vs "runtime/brain".** Normalize to brain + runtime everywhere
  user-facing; reserve `ade serve`/process-level mentions.
- **G2 — "project-specific sync host" overstated.** `ARCHITECTURE.md` §13.1
  (line 837) / §13.3 (line 849) read as if each project has its own host/socket.
  Reality: one machine brain, machine-level catalog, per-project host **ports**
  behind it; a true cross-machine reconnect only when a project lives on another
  machine. Clarify.
- **G3 — `brain_*` legacy naming.** DB/protocol still say `brain_device_id`; docs
  say "host". Glossary: brain == host == cluster owner.
- **G4 — §3.4 "any number of TUI runtimes" vs "desktop is just a client".** Both
  true; clarify "processes that open the DB" vs "clients that attach."
- **G5 — "one daemon per machine" stated as hard fact.** The real invariant is
  "one **brain** per machine per project DB"; extra runtimes are allowed. The crash
  came from violating the brain singleton, not from extra runtimes.
- **G6 — (assistant's earlier error, recorded)** "one sync socket per project" /
  "per-project sync host required" was wrong; the brain is per-machine.
- **NEW G7 — mobile is per-project-socket today**, not one websocket; docs imply a
  single mobile websocket. Document the per-project-port reality + the future
  single-multiplexed-websocket option.
- **NEW G8 — service installers are channel-colliding** (systemd unit name, launchd
  logs); docs don't mention per-channel service identity.

---

## Appendix — superseded analysis (history)

The earlier "one DB per lane" tangent and the A/B/C ("per-machine vs per-runtime
websocket") framing were assistant explorations, not the chosen design. Superseded
by Sections 5–7 (Layer 1). Kept only so the reasoning trail is legible.

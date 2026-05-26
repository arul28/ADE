# ADE Architecture Reference

Consolidated technical reference for the ADE (Agentic Development Environment) system. This document is the entry point for engineers and AI agents who need to understand the shape of the system before reading feature-specific docs. Deeper subsystem docs live under `docs/features/`.

---

## 1. System at a Glance

ADE is a local-first development control plane that orchestrates AI-assisted software engineering across parallel worktrees. The center of the system is a **per-machine ADE runtime daemon** (`apps/ade-cli/`, started with `ade serve`). The daemon hosts every project on that machine through a project registry and exposes a multi-project JSON-RPC surface on a Unix socket / Windows named pipe at `~/.ade/sock/ade.sock`. Desktop, the terminal `ade code` client, the iOS app, and SSH-attached desktop windows are all peer **clients** that bind to a runtime — local or remote — and invoke runtime-owned actions through that one surface.

The runtime owns everything that needs to survive a client closing: worktree-per-lane git isolation, a multi-provider AI runtime, a Linear-integrated CTO agent acting as a team lead, worker delegation, a pipeline builder for visual automations, stacked pull requests with conflict simulation, computer-use proofs, the sync host that replicates projects to other devices, and the per-machine credential store and agent registry. Nothing leaves the user's machine by default: AI work runs through user-authenticated CLIs (Claude Code, Codex), local API-key routes (OpenCode server), or local model endpoints (Ollama, LM Studio, vLLM).

ADE ships as four runtime/client packages plus the marketing site:

```
                              ┌───────────────────────────────┐
                              │ apps/web (marketing + DL page)│
                              └───────────────────────────────┘

                ┌───────────────────────────────────────────────┐
                │            apps/ade-cli (RUNTIME)             │
                │  ─────────────────────────────────────────────│
                │  `ade serve` daemon                            │
                │   - listens on ~/.ade/sock/ade.sock            │
                │   - login service (launchd / systemd / Win)    │
                │   - multi-project RPC + project registry       │
                │   - sync host (cr-sqlite over WebSocket)       │
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
                  │ local        │ local        │ WebSocket   │ stdio over
                  │ socket       │ socket       │             │ SSH
                  │              │              │             │
        ┌──────────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────────┐
        │ apps/desktop     │ │ ade code TUI │ │ apps/ios │ │ apps/desktop     │
        │ (Electron, multi-│ │ (apps/ade-cli│ │ SwiftUI  │ │ window bound to a│
        │ window — one     │ │  /tuiClient) │ │ controller│ │ remote runtime   │
        │ window/project)  │ │              │ │ (never   │ │ (RemoteConnection│
        │ LocalRuntime-    │ │ defaults to  │ │ runs     │ │ Pool, bootstrap- │
        │ ConnectionPool   │ │ machine sock │ │ agents)  │ │ uploads bundled  │
        │                  │ │              │ │          │ │ runtime binary)  │
        └──────────────────┘ └──────────────┘ └──────────┘ └──────────────────┘
                              All clients share the runtime's view of
                                projects, lanes, chats, processes, sync.
                                            │
                                            ▼
                                ┌─────────────────────────┐
                                │ User code: git worktrees│
                                │ under .ade/worktrees/   │
                                └─────────────────────────┘
```

Live runtime state is replicated between paired devices through cr-sqlite changesets carried over WebSocket; the **sync host runs inside the runtime daemon**, not in the desktop app. The iOS app pairs with a runtime — typically the user's primary desktop-class machine. A second desktop on the same network is also a client of that runtime, not a peer host. A desktop window can be re-pointed at a runtime on a remote machine over SSH; the binding is per-window, so the same Electron process can drive a local project in one window and an SSH-bound project in another. The remote path starts `ade rpc --stdio` on the remote and routes runtime actions through the same multi-project JSON-RPC surface. See [features/remote-runtime/README.md](./features/remote-runtime/README.md).

Source code crosses machines through plain git. ADE does not own a git server.

Product positioning and workflows live in [`docs/PRD.md`](../docs/PRD.md). This document is strictly technical.

---

## 2. Apps & Processes

### 2.1 ADE runtime daemon (`apps/ade-cli/`)

`apps/ade-cli/` is the runtime — the per-machine source of truth — and the `ade` CLI surface. It ships as one Node binary that runs in several modes.

**Run modes:**

- **Daemon (`ade serve`)** — the normal mode. Boots the multi-project JSON-RPC server, hosts the per-project services on demand, and listens on `~/.ade/sock/ade.sock` (Windows: a named pipe under `\\.\pipe\ade-<hash>`, with the hash derived in `apps/desktop/src/shared/adeRuntimeIpc.ts`). Installable / removable as a login service with `ade serve --install-service` / `--uninstall-service` (per-platform installers in `apps/ade-cli/src/serviceManager/`).
- **Single-session CLI** — `ade <command>` connects to the local daemon over the machine socket, dispatches one project-scoped action, and exits. With `--headless`, the CLI bootstraps a project's services directly from the repository instead of going through a daemon — used in CI and for one-off scripts.
- **SSH stdio bridge (`ade rpc --stdio`)** — runs a single-session JSON-RPC runtime over stdin/stdout. This is what desktop's `RemoteConnectionPool` execs over SSH after `bootstrapRemoteRuntime` has uploaded a matching `ade-<platform-arch>` binary. Exits when the SSH channel closes.
- **Terminal client (`ade code`)** — launches the Ink + React Work chat (`apps/ade-cli/src/tuiClient/`). Defaults to attaching to `~/.ade/sock/ade.sock` and will start `ade serve` if the socket is missing. `ade --socket /path code` requires a specific socket; `ade code --embedded` keeps the legacy in-process fallback explicit.

**Multi-project RPC.** The daemon exposes runtime-scoped methods (`projects.list/add/remove/touch`, `sync.*`, `runtime/info`, `machineInfo.get`, `runtimeEvents.subscribe/unsubscribe`) directly. Project-scoped operations dispatch through `ade/actions/call` with a `projectId`. Per-project services are spun up lazily by `ProjectScopeRegistry` (`apps/ade-cli/src/services/projects/projectScope.ts`) which calls `createAdeRuntime({ projectRoot, ... })` the first time a project is touched. The project registry (`projectRegistry.ts`) is the durable list of known projects; `machineLayout.ts` resolves machine-wide paths under `~/.ade/`. Wire formats live in `apps/ade-cli/src/multiProjectRpcServer.ts`.

**Runtime-side services** (under `apps/ade-cli/src/services/`):

| Directory | Role |
|-----------|------|
| `projects/` | Project registry, project scope (per-project runtime), machine layout. |
| `sync/` | Sync host, peer client, device registry, pairing store, PIN store, sync protocol, remote command service, Tailscale CLI resolver. The sync host now lives here; desktop's old in-process host is disabled by default (env-gated `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics only). |
| `credentials/` | Per-machine credential store. |
| `agentRegistry.ts` | Per-machine agent registry. |

**Service managers.** `apps/ade-cli/src/serviceManager/installLaunchd.ts` (macOS), `installSystemd.ts` (Linux), `installWindows.ts` (Windows) register `ade serve` as a login-time service. `index.ts` is the platform router; `common.ts` carries shared types (`ServiceManagerResult`, `ServiceManagerStatusResult`).

**Session identity.** The runtime resolves caller role from ADE context env vars and command flags. Role vocabulary: `cto`, `orchestrator`, `agent`, `external`, `evaluator`.

**Action surface.** First-class command families cover lanes (including `ade lanes link-linear-issue` for post-creation Linear issue linking), git, diffs, files, PRs, path-to-merge, runs, shells, chats, agents, CTO, Linear, tests, proof, settings, the iOS Simulator (`ade ios-sim` / `ade ios` / `ade simulator` — see [features/ios-simulator/README.md](./features/ios-simulator/README.md)), the Cursor Cloud bridge (`ade cursor cloud agents | runs | artifacts | repos | models | me` — talks directly to `@cursor/sdk` without going through the ADE socket), the App Control bridge for Electron apps (`ade app-control` / `ade app` / `ade electron` — `launch`, `connect`, `stop`, `status`, `screenshot`, `snapshot`, `inspect`, `select`, `click`, `type`, `scroll`, `key`, `targets`, `attach`, `logs`, `terminal write`, `terminal signal` — see [features/computer-use/app-control.md](./features/computer-use/app-control.md)), the chat-scoped terminal (`ade terminal list` / `read` / `write` / `signal` / `active`), and a generic `ade actions run <domain.action>` escape hatch for every registered ADE service action. The action allow-list adds two domains for these surfaces: `app_control` (every public method on `AppControlService`) and `terminal` (`list`, `read`, `write`, `signal`, `activeForChat` against `ptyService`).

**Proof subcommands** — `ade proof capture` (alias of `screenshot`), `ade proof attach <path>`, `ade proof record`, `ade proof launch`, `ade proof interact`, `ade proof list/status/environment/ingest`. `attach` infers the artifact kind from the file extension and routes through `ingest_computer_use_artifacts` with `backendStyle: "manual"`. Capture-style commands set `preferHeadless: true` on the plan so the connection layer drops to headless mode unless `--socket` is explicitly requested. All proof subcommands accept `--owner-kind` / `--owner-id` (with `chat` and `pr` aliases) to layer an explicit owner on top of the inferred session identity.

**Bundled runtime artifacts.** Per-platform `ade-<platform-arch>` binaries plus their native dep tarballs live under `apps/desktop/resources/runtime/`. `release-core.yml` builds the cross-platform set; `bootstrapRemoteRuntime` uploads them on first SSH connect from the desktop client.

**Headless install.** A standalone runtime can be installed on a headless machine without going through the desktop installer:

```bash
curl -fsSL https://github.com/arul28/ADE/releases/latest/download/install.sh | sh
```

Use `ADE_VERSION=vX.Y.Z` for a pinned release or `ADE_INSTALL_DIR` to choose the destination directory.

**Install + PATH wiring (when the desktop ships `ade`).** On macOS / Linux the desktop installer drops the launcher at `$HOME/.local/bin/ade`; on Windows it lands at `%LOCALAPPDATA%\ADE\bin\ade.cmd`. After a successful install on Windows, the packaged `.cmd` installer adds the target directory to HKCU `Environment\Path` when needed and broadcasts an environment-change notification. After a successful install on POSIX, `ensureUserBinOnShellPath` appends a marked `export PATH="$HOME/.local/bin:$PATH"` block to the user's shell rc (`.zshrc` for zsh, `.bashrc` for bash, `.profile` otherwise) iff (a) the install dir isn't already on the inherited `PATH` and (b) the file doesn't already contain the marker / line / target dir. The install IPC reply tells the renderer which profile was edited so the Settings/Onboarding UI can prompt the user to open a new terminal or `source` it.

**Windows packaging.** The installer lays down `ade-cli-windows-wrapper.cmd` plus an `ade-cli-install-path.cmd` helper alongside the bundled Electron Node runtime. The helper installs `%LOCALAPPDATA%\ADE\bin\ade.cmd`, updates the user PATH when needed, and then `ade` works from a new normal Windows shell without a global Node install. See §14.4 for the packaging flow.

**Desktop bridge socket.** The runtime daemon runs `apps/ade-cli/dist/cli.cjs` under `ELECTRON_RUN_AS_NODE=1`, so it has no access to renderer-side Electron APIs (`WebContentsView`, `nativeImage`, `session`, …). A small set of services own real desktop UI and therefore cannot live in the daemon — most notably `BuiltInBrowserService`, which drives the Browser pane's `WebContentsView`. The desktop main process hosts those services and exposes them to the daemon over a side-channel JSON-RPC Unix-domain socket / named pipe.

The socket path is resolved by `apps/ade-cli/src/services/projects/machineLayout.ts`: `<adeHome>/sock/desktop-bridge.sock` on macOS / Linux (e.g. `~/.ade/sock/desktop-bridge.sock` stable, `~/.ade-beta/sock/desktop-bridge.sock` beta), and `\\.\pipe\ade-desktop-bridge[-<channel-suffix>]` on Windows. `ADE_DESKTOP_BRIDGE_SOCKET_PATH` overrides it for dev launches against a non-default ADE home. The server lives in `apps/desktop/src/main/services/builtInBrowser/desktopBridgeServer.ts`, wired up from `main.ts` right after `builtInBrowserService` is constructed and torn down with it on app shutdown. The daemon-side proxy is `apps/ade-cli/src/services/builtInBrowser/desktopBridgeClient.ts`; `createAdeRuntime` in `bootstrap.ts` assigns it to `runtime.builtInBrowserService` so the existing action registry slot resolves transparently (skipped when `runtimeProfile === "chat"`). Both sides share the same method allowlist: `getStatus, showPanel, setBounds, navigate, createTab, switchTab, closeTab, reload, goBack, goForward, stop, startInspect, stopInspect, captureScreenshot, selectPoint, selectCurrent, clearSelection`.

Today only the `built_in_browser` domain rides this bridge; the pattern is generic and other Electron-only domains can be added the same way. The client lazy-connects on first call and reconnects on the next call after any failure. When no desktop is running, each call surfaces a clear `Desktop browser bridge not running at <path>. Open ADE Desktop with a project to enable \`ade browser\` commands.` error and every other runtime domain stays functional. This is distinct from the legacy desktop-socket mode (a pre-multi-project pattern where the desktop renderer hosted RPC and the CLI dialed in): the daemon still owns the full action surface — the bridge is narrowly scoped to services that physically require an Electron renderer host.

### 2.2 Electron desktop client (`apps/desktop/`)

The desktop app is a **client of the runtime**. It owns a trusted main process, a narrow typed preload bridge, the React renderer, and the shared TypeScript contracts that the whole monorepo (including the ADE CLI runtime) consumes — but the data plane it operates on lives in the runtime daemon.

| Directory | Role |
|-----------|------|
| `apps/desktop/src/main/` | Node process with full OS access. Hosts windows, registers IPC handlers, routes runtime-backed APIs through local/remote runtime pools, spawns the local runtime daemon when needed, and runs the legacy in-process services that have not yet been migrated to the runtime. Entry: `main.ts`. |
| `apps/desktop/src/preload/` | Typed bridge. Entry: `preload.ts`. Uses `contextBridge.exposeInMainWorld("ade", { ... })`. Runtime-backed APIs route through `LocalRuntimeConnectionPool` (local) or `RemoteConnectionPool` (SSH-bound window); file APIs are strict once a local/remote runtime is bound, while usage/budget reads only route to runtime for remote-bound windows. When `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1`, local-bound windows skip the daemon/event pump and use guarded in-process IPC fallbacks. |
| `apps/desktop/src/renderer/` | React 18 SPA. No Node access, no filesystem access, no direct process/network. Everything goes through `window.ade`. Entry: `main.tsx`. |
| `apps/desktop/src/shared/` | Types, IPC channel constants (`ipc.ts`), model registry (`modelRegistry.ts`), keybindings, and other DTOs. Imported by both desktop and `apps/ade-cli`. New runtime-facing types live in `shared/types/remoteRuntime.ts` and `shared/types/core.ts`. |
| `apps/desktop/src/generated/` | Build-time generated code (e.g., bootstrap SQL snapshots). |
| `apps/desktop/src/test/` | Shared vitest setup and fixtures. |
| `apps/desktop/src/types/` | Ambient type declarations. |

**Multi-window shell.** `main.ts` hosts multiple `BrowserWindow` instances; opening another project opens it in a dedicated window. Each window has its own runtime binding (local pool or a specific remote target). External controllers — for example a `ade code` TUI — can drive desktop window navigation via the `app/navigate` JSON-RPC method against the runtime; the desktop's IPC tracing carries window ID so logs distinguish which renderer surface invoked a channel.

**Runtime binding pools.**

- `apps/desktop/src/main/services/localRuntime/localRuntimeConnectionPool.ts` — desktop-side client for the local `ade serve` daemon. Spawns or attaches to the machine socket, registers local projects with `projects.add`, dispatches local runtime actions, applies short per-call timeouts for project registration / file actions / event polling, and best-effort installs the background service in packaged builds. `ADE_DISABLE_LOCAL_RUNTIME_DAEMON=1` is a development/diagnostic escape hatch: preload does not pump local runtime events or issue local runtime actions, and main-process sync IPC returns a standalone unavailable snapshot or no-ops lane-presence updates instead of spawning the daemon.
- `apps/desktop/src/main/services/remoteRuntime/` — SSH-bound runtime pool. `remoteTargetRegistry.ts` stores saved machines under `~/.ade/secrets/remote-machines.json` (manual host plus an optional `routes[]` of Tailscale / Bonjour / manual addresses with per-route `lastSucceededAt`); `sshTransport.ts` handles ssh-agent / key based transport with ssh2 keepalive (15 s × 3) and walks alternate routes ranked by most-recent success; `remoteBootstrap.ts` does first-connect runtime upload + version negotiation against the bundled `ade-<platform-arch>` binary and records which route succeeded; `remoteConnectionPool.ts` keeps the per-window remote runtime binding alive, reconnects safely on read-only actions (`get*/list*/read*/search*/diagnosticsGet*` and a small allowlist), and emits eviction notifications when SSH or the JSON-RPC client closes; `remoteConnectionService.ts` listens for those evictions, marks targets as `error`, and re-probes saved connections on `powerMonitor.resume` / `unlock-screen`; `runtimeRpcClient.ts` is the JSON-RPC client (per-call timeouts now tear the connection down so the pool reconnects rather than dangling the request); `runtimeDiscovery.ts` runs Bonjour + Tailscale in parallel and returns `{ machines, diagnostics }` so a missing or stuck `tailscale` CLI does not silently swallow LAN discovery.

Build outputs (configured in `apps/desktop/tsup.config.ts`):

| Entry | Source | Purpose |
|-------|--------|---------|
| `main/main.cjs` | `src/main/main.ts` | Electron main process |
| `main/packagedRuntimeSmoke.cjs` | `src/main/packagedRuntimeSmoke.ts` | Post-package smoke test for PTY spawn, Claude SDK init, Codex availability, and ADE CLI readiness. |
| `preload/preload.cjs` | `src/preload/preload.ts` | Renderer bridge. |

### 2.3 ADE Code terminal client (`ade code`)

Terminal-native **Work** chat client (Ink + React) for agents and power users who live in a shell, built into `apps/ade-cli/src/tuiClient/`. It is a peer of the desktop client, not a wrapper around it: it speaks the same multi-project JSON-RPC surface and binds to a runtime daemon the same way.

- **Attached mode** (default): connects to `~/.ade/sock/ade.sock`, or to an explicit socket passed on the parent `ade` invocation. Starts `ade serve` if the socket is missing.
- **Embedded mode**: `--embedded` / `--headless` runs the shared `apps/ade-cli` services in-process without going through a daemon. Used when no daemon is reachable.

Shared chat DTOs are imported from `apps/desktop/src/shared/types/*` (never the renderer barrel) so `npm run typecheck` in `apps/ade-cli` covers both typed commands and the TUI. Entry: `apps/ade-cli/src/tuiClient/cli.tsx` → `apps/ade-cli/dist/tuiClient/cli.mjs`, loaded by `ade code`. The built TUI bundle is intended to run in isolation: tsup bundles its Ink/xterm/highlight dependencies and injects ESM shims for `__dirname` / `__filename`; both `apps/ade-cli/scripts/verify-built-cli.mjs` and the desktop artifact validators smoke-import it and run `runAdeCodeCli(["--help"])`. The TUI can hand off to a desktop window via the `app/navigate` JSON-RPC method when a desktop client is attached to the same runtime.

### 2.4 iOS client (`apps/ios/`)

Native SwiftUI app acting as a controller. It pairs with a runtime daemon over WebSocket and reads live state from a local cr-sqlite-backed SQLite database that mirrors the project's `ade.db`. The phone never runs agents.

- Stack: native SwiftUI + `SQLite3` C API + iOS system SQLite.
- CRDT: pure-SQL CRR emulation layer (trigger-based change tracking) since iOS blocks `sqlite3_load_extension()`/`sqlite3_auto_extension()`. Changesets are wire-compatible with desktop cr-sqlite.
- Core services: `Database.swift`, `SyncService.swift`, `KeychainService.swift`, `LiveActivityCoordinator.swift`.
- Shipped tabs: Lanes, Files, Work, PRs, CTO, Settings.
- Shipped: APNs push pipeline (runtime-side `apnsService` + `notificationEventBus` → iOS `AppDelegate` + `NotificationCategories` + Notification Service Extension), workspace Live Activity (Lock Screen + Dynamic Island), Home Screen / Lock Screen / Control Center widgets.
- Planned: Automations, Graph, History tabs; iPad layout; Spotlight.
- Target: iOS 26+, iPhone + iPad.

### 2.5 Web app (`apps/web/`)

A Vite/React SPA that serves the public marketing site, download page, and the deeplink landing page. Five pages: `HomePage`, `DownloadPage`, `OpenPage`, `PrivacyPage`, `TermsPage`. Independent package (`ade-web`), deployed via Vercel (`apps/web/vercel.json`). Not a runtime dependency of the desktop app. Shared-origin with the Mintlify docs site (`docs.json` at repo root).

The `/open` route is the HTTPS half of the ADE deeplink scheme (`https://ade.app/open?type=...&...`). `apps/web/api/open.ts` is a Vercel serverless function that self-fetches `index.html`, rewrites OpenGraph + Twitter meta tags from the query params so chat-app unfurlers (Slack, Discord, iMessage, Gmail, Linear) show a rich card without executing JavaScript, then hands the SPA over to `OpenPage` which attempts the `ade://` upgrade in the browser and falls back to an install/marketing card if no handler is registered. See [features/deeplinks/README.md](./features/deeplinks/README.md).

---

## 3. Data Plane

### 3.1 SQLite + cr-sqlite CRDT layer

ADE uses Node's native `node:sqlite` driver (no better-sqlite3 dependency) with a vendored cr-sqlite loadable extension:

- **Engine source**: `apps/desktop/src/main/services/state/kvDb.ts` (schema bootstrap, CRR enablement, sync API) and `crsqliteExtension.ts` (extension loader). Both the desktop main process and the ADE CLI runtime import the same engine module from here; they do not maintain parallel schemas. The database is owned by whichever process opened it first for a given project — in normal operation that is the runtime daemon, with desktop's in-process services acting as legacy fallbacks.
- **Database file**: `<project_root>/.ade/ade.db`.
- **WAL mode** handles durability; `flushNow()` is a no-op.
- **CRRs**: eligible tables are marked via `SELECT crsql_as_crr('table_name')` at startup. Virtual/internal tables (`sqlite_%`, `crsql_%`) are excluded. Marking is dynamic — new tables are picked up automatically unless excluded.
- **Sync API** (`AdeDb.sync`): `getSiteId()`, `getDbVersion()`, `exportChangesSince(version)`, `applyChanges(changes)`. Used by the sync transport.
- **Merge semantics**: last-writer-wins per column with Lamport timestamps; each device has a site ID at `.ade/secrets/sync-site-id`.
- **Engineering rule under CRR retrofit**: app-level `ON CONFLICT(...)` upserts must target PK only; secondary UNIQUE constraints do not survive CRR marking.

### 3.2 Schema highlights

Schema bootstrap in `kvDb.ts` creates ~103 tables. Anchor tables for agents reading this doc:

| Table | Purpose |
|-------|---------|
| `projects` | One row per opened repo. Keyed by `root_path`. |
| `lanes` | Worktree-backed units of work. Types: `primary`, `worktree`, `attached`. Supports parent/child stacks, run binding, color/icon/tags. |
| `terminal_sessions` | Tracked PTY sessions per lane with transcript path and head SHAs. The `chat_session_id` column (indexed) marks terminals owned by a chat (chat terminal drawer, App Control launch terminal); `ptyService` exposes them through the `ade.terminal.*` IPC and the `terminal` ADE action domain. The `owner_pid` column (indexed) identifies the ADE OS process that owns the live runtime for the row — cross-process reconcile/dispose paths check it before sweeping so concurrent surfaces don't mark each other's live sessions dead. See §3.5. |
| `runtime_processes` | Process-liveness registry. Every ADE process (desktop main, TUI runtime, `ade serve` daemon) inserts a row on boot keyed by `pid` and refreshes `last_seen` on a 5 s heartbeat. Reconcile / dispose paths cross-reference `terminal_sessions.owner_pid` against the live rows in this table to tell "row whose owner crashed" from "row a sibling process is actively managing." See §3.5. |
| `session_deltas` | Post-session diff stats + touched files + failure lines. Input to pack generation. |
| `operations` | Audit log of every significant mutation (git, pack updates). Pre/post HEAD SHAs enable undo. |
| `process_definitions` / `process_runtime` / `process_runs` | Managed-process lifecycle (derived from `ade.yaml`). |
| `test_suites` / `test_runs` | Declared test suites and their execution history. |
| `pull_requests` / `pr_review_threads` / `pr_checks` | GitHub PR projections with queue and stack metadata. |
| `integration_proposals` | PR merge-plan simulations. Stores source lanes, pairwise results, sequential resolution state, optional adopted merge target (`preferred_integration_lane_id`), and merge-target drift snapshot (`merge_into_head_sha`). |
| `computer_use_artifacts` + `computer_use_artifact_links` | Canonical proof-artifact records and cross-domain ownership. |
| `devices` + `sync_cluster_state` | Device registry and singleton host-authority row (host is `brain_device_id` internally; legacy naming). |
| `kv` | Generic key-value store for UI layout, config trust hashes, misc settings, and short-lived recovery records such as `agent-chat-parallel-launch:<projectRoot>:<laneId>`. |

Types for these tables are split into domain modules under `apps/desktop/src/shared/types/`. The barrel `index.ts` re-exports `core`, `models`, `git`, `lanes`, `conflicts`, `prs`, `files`, `sessions`, `chat`, `config`, `automations`, `packs`, `budget`, `usage`, and more. Feature docs under `docs/features/` call out the table subsets that are load-bearing for each surface.

### 3.3 Filesystem state

```
<project-root>/
├── .ade/
│   ├── .gitignore               # Tracked; ignores machine-local ADE state
│   ├── ade.yaml                 # Shared (tracked): processes, stacks, tests, templates
│   ├── local.yaml               # Personal overrides (ignored)
│   ├── local.secret.yaml        # Secret integration config (ignored)
│   ├── ade.db                   # SQLite + cr-sqlite (runtime, ignored)
│   ├── worktrees/<slug>-<uuid>/ # Lane worktrees (ignored)
│   ├── transcripts/             # PTY transcripts (ignored)
│   ├── cache/                   # Runtime scratch (ignored)
│   ├── artifacts/               # Pack exports, history artifacts (ignored)
│   ├── cto/
│   │   ├── identity.yaml        # Shared CTO identity (tracked)
│   │   ├── CURRENT.md           # Running status markdown (ignored)
│   │   └── daily/<YYYY-MM-DD>.md
│   ├── agents/<slug>/           # Per-worker identity and daily logs (runtime, ignored)
│   ├── templates/               # Lane and automation templates (tracked when human-authored)
│   ├── skills/                  # Exported skill markdown (tracked when human-authored)
│   ├── workflows/linear/        # Linear workflow config (tracked when present)
│   ├── project-icons/           # Imported project icon overrides (tracked when ade.yaml.iconPath points at one)
│   ├── ade.sock                 # Unix socket for ADE RPC (runtime)
│   └── secrets/                 # Machine-local secret material (ignored)
│       ├── github/*.bin         # safeStorage-encrypted tokens
│       ├── sync-site-id
│       ├── sync-device-id
│       └── sync-bootstrap-token
└── ~/.ade/                      # Global state (user profile directory)
    ├── global-state.json        # Recent projects list
    └── logs/                    # Main-process structured logs
```

**Portability buckets** (intentionally distinct):

1. **Git-tracked shared scaffold** — `.ade/.gitignore`, `ade.yaml`, `cto/identity.yaml`, human-authored `templates/**`, `skills/**`, `workflows/linear/**`, `project-icons/**`. This is the only `.ade/` subset that flows through normal clone/pull. The shared `.ade/.gitignore` is now `*` with explicit allowlist entries for those scaffold files (so the next time someone touches `.ade/` from a fresh tool the runtime state stays out of git automatically).
2. **ADE sync state** — the replicated `ade.db` tables that flow through cr-sqlite over WebSocket when devices join the same host.
3. **Machine-local runtime** — worktrees, caches, transcripts, artifacts, secrets, sockets, and generated context markdown. Never leaves the device.

**Project scaffold modes.** `initializeOrRepairAdeProject(projectRoot, { mode })` controls whether a project gets the full shared scaffold or stays local-only:

- `mode: "shared"` always materializes the canonical files (`.ade/.gitignore`, `ade.yaml`, `cto/identity.yaml`, the tracked placeholder `.gitkeep`s) and scrubs any leftover `.ade/` ignore lines from `.gitignore` / `.git/info/exclude`. Triggered automatically from `createLocalProject`, every shared-config save, and any helper that calls `ensureSharedAdeProjectScaffold(projectRoot)` (e.g. `setProjectIconOverrideFromSelection`, `linearWorkflowFileService.save`).
- `mode: "auto"` (the default for `openProject`) keeps the project local-only when no shared scaffold files exist yet — it ensures `.git/info/exclude` has a `.ade/` entry so a brand-new clone or a personal-only setup never accidentally promotes runtime state into git, and only flips to the shared layout when shared scaffold files are already present (or after a save call promotes them).
- `mode: "local"` is reserved for force-local repair flows.

### 3.4 Cross-process ownership

ADE is a multi-process system on a single machine: the desktop main process, the `ade serve` daemon, and any number of TUI runtimes can all be live against the same project DB simultaneously. To prevent one process from disposing or reconciling another's live PTYs and SDK sessions, every long-lived row gets an `owner_pid` and every process maintains a heartbeat in `runtime_processes`.

`apps/desktop/src/main/services/runtime/processRegistryService.ts` is the per-process registrar.

- On `start()` it inserts/refreshes its own row in `runtime_processes` (`pid`, `role`, optional `projectRoot`, `startedAt`, `lastSeen`) and runs an idempotent `pruneStale()` over rows older than 10× the liveness window.
- A 5 s heartbeat (`heartbeatIntervalMs`, configurable) writes `last_seen` so siblings can see this process is alive. The interval `unref()`s so it never blocks shutdown.
- Liveness checks (`isPidLive(pid)`, `listLivePids()`) consider a row live when `last_seen` is within `livenessWindowMs` (default 15 s = 3× heartbeat) so a single missed heartbeat doesn't false-positive a sibling as dead. The registrar's own pid is always reported as live.
- `stop()` clears its row outright on graceful shutdown so siblings don't have to wait the liveness window to free up ownership.

`ptyService.create()` records `processRegistry.pid` on the new `terminal_sessions` row's `owner_pid`. `sessionService.reconcileStaleRunningSessions()` accepts the registry's `listLivePids()` set and skips any row whose `owner_pid` is in it — only orphaned rows whose owner crashed or exited get swept to `disposed`. Dispose paths run the same check before tearing down runtimes a sibling still manages.

Roles are open-ended strings; today's vocabulary is `desktop-main`, `ade-serve-daemon`, and `tui-runtime`. The desktop main process constructs the registry in `main.ts` and threads it into `ptyService`, `sessionService`, and reconcile callers via the per-project context.

### 3.5 Migration strategy

- Schema is defined idempotently — `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
- One-time schema-compat migration at startup: retrofits `NOT NULL` on PKs and strips UNIQUE/FK constraints incompatible with cr-sqlite CRRs. A pre-cr-sqlite backup (`<db>.pre-crsqlite-w1.bak`) is written on first CRR enablement.
- Feature migrations add columns via `ALTER TABLE ADD COLUMN`, wrapped by `crsql_begin_alter`/`crsql_commit_alter` to stay CRR-safe.
- Targeted per-domain migrations live alongside their domain tests, for example `kvDb.workerAgentsMigration.test.ts`.
- The canonical iOS bootstrap schema is exported from desktop `kvDb.ts` to `apps/ios/ADE/Resources/DatabaseBootstrap.sql` so iOS stays schema-compatible.

---

## 4. AI Integration Layer

Service entry points live under `apps/desktop/src/main/services/ai/`. The subsystem has three parts: provider-routed execution, permission profiles, and ADE CLI-backed tool surfaces.

### 4.1 Provider routing

- **Router** — `aiIntegrationService.ts` resolves a task → model → provider class and dispatches.
- **Model registry** — `apps/desktop/src/shared/modelRegistry.ts` is the single source of truth. Each `ModelDescriptor` carries identity (`id`, `shortId`, `providerRoute`, `providerModelId`), capabilities, pricing, context sizing, auth type (`cli-subscription`, `api-key`, `openrouter`, `local`), and optional `harnessProfile`/`discoverySource` for safety metadata.
- **Classes**:
  - **CLI-wrapped** (Claude via `@anthropic-ai/claude-agent-sdk`, Codex CLI via `@openai/codex-sdk`) — spawned as subprocesses; Claude uses the SDK `query()` stream with ADE's async input pump and bundled Claude Code binary, while Codex uses its app-server JSON-RPC bridge. Authentication inherits from the user's own CLI login. ADE context is exposed through environment variables, and agents can call back into ADE with the `ade` CLI.
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
| `ai/tools/ctoOperatorTools.ts` | CTO-only operator tools. |
| `ai/tools/linearTools.ts` | Linear integration tool surface. |
| `ai/tools/webFetch.ts` / `webSearch.ts` | Outbound web access. |
| `ai/tools/readFileRange.ts` / `globSearch.ts` / `grepSearch.ts` | Read-only file tools shared across all roles. |
| `ai/tools/editFile.ts` | Edit-path tool wired to ADE-controlled write flow. |
| `ai/tools/systemPrompt.ts` | Base system prompt; adapts wording based on exposed tool names. |

**ADE CLI is the cross-process action surface.** Workers spawned as CLI children inherit ADE context env vars and can call the `ade` command to invoke ADE-owned actions layered on top of their native provider tools.

### 4.4 Model registry specifics

`apps/desktop/src/shared/modelRegistry.ts` + `apps/desktop/src/shared/modelProfiles.ts`:

- `MODEL_REGISTRY` — static CLI-wrapped entries + dynamically populated API-key/local entries. Includes the Claude Opus 4.7 1M-context entry (`anthropic/claude-opus-4-7-1m`, aliases `opus[1m]` / `claude-opus-4-7[1m]`, 1,000,000 context / 128,000 max output, `costTier: "very_high"`, full `low|medium|high|max` reasoning tiers). `ModelDescriptor.serviceTiers?: string[]` advertises optional service tiers (today: `"fast"`, set on the Codex CLI GPT 5.4 / 5.5 entries) that the UI's Codex Fast Mode toggle and the Codex JSON-RPC `serviceTier` argument key off.
- `ModelProviderGroup` = `"claude" | "codex" | "opencode" | "cursor" | "droid"`. Cursor and Droid each have their own top-level provider group used by the model picker, identity routing, and tracked CLI provider catalog.
- Helpers: `getModelById`, `getModelPricing`, `updateModelPricingInRegistry`, `replaceDynamicOpenCodeModelDescriptors`, `resolveProviderGroupForModel`, `resolveModelDescriptorForProvider`, `getRuntimeModelRefForDescriptor`, `modelSupportsServiceTier(descriptor, tier)` / `modelSupportsFastMode(descriptor)`.
- Reasoning tier passthrough (`providerOptions.ts`) maps tier strings directly to each provider's native config (`thinking.type`, `reasoningEffort`, `thinkingConfig.thinkingLevel`, etc.) — no arbitrary token budgets. The Claude vocabulary is `low | medium | high | max`.
Interactive chat (Terminals, Work), CTO delegation, and automation-launched agent sessions flow through the unified executor with the same permission plumbing.

Related feature docs: [Chat](./features/chat/README.md), [Agents](./features/agents/README.md), [CTO](./features/cto/README.md), and [Automations](./features/automations/README.md).

---

## 5. IPC Contract (the glue)

### 5.1 Typed preload

`apps/desktop/src/preload/preload.ts` (~8,545 lines) exposes ~550 methods on `window.ade`:

- `contextBridge.exposeInMainWorld("ade", { ... })` — the only cross-isolated-world surface.
- Methods are typed via TypeScript imports from `apps/desktop/src/shared/types/`.
- Two categories: **invoke methods** (`ipcRenderer.invoke(channel, args)` returning `Promise<T>`) and **event subscriptions** (`ipcRenderer.on(channel, handler)`).
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (required for preload functionality).
- Global window type: `apps/desktop/src/preload/global.d.ts`.
- `window.ade.project.getDroppedPath(file)` wraps Electron's `webUtils.getPathForFile()` so renderer drag-drop handlers can resolve the absolute path of a `File` payload without the renderer needing Node APIs. Used by the Command Palette project browser to accept dropped folders.

### 5.2 Channel design

`apps/desktop/src/shared/ipc.ts` defines the single `IPC` const with ~550 named channel strings in a `ade.<domain>.<action>` namespace:

```
ade.app.*                    # app lifecycle, clipboard text and image (writeClipboardText, writeClipboardImage, saveClipboardImageAttachment), paths, image data-URL preview (getImageDataUrl), and the deeplink navigation push channel ade.app.navigate (AppNavigationRequest payloads from the ade:// protocol handler, the ade code app/navigate JSON-RPC, and the iOS deeplinks.open sync command — see features/deeplinks/README.md)
ade.project.*                # project open/close/switch/state, in-app directory browser (browseDirectories, getDetail), favicon resolver (resolveIcon)
ade.onboarding.*
ade.lanes.*                  # lane list/create/delete/stack/template/env/port/proxy/rebase
                             # delete pipeline: ade.lanes.delete + ade.lanes.delete.cancel
                             # + ade.lanes.delete.risk preflight + ade.lanes.delete.event push
ade.files.*                  # file tree, read, write, search, watch
ade.diff.*                   # lane-scoped change list + per-file diff / patch (diffService)
ade.pty.*                    # PTY spawn/write/kill, data/exit events
ade.git.*                    # stage/commit/push/sync/revert/cherry-pick/stash
ade.github.*                 # PR list, review, merge, checks. Also exposes
                             # repo-scoped helpers used by the Linear setup flow:
                             # listRepoAutolinks / createRepoAutolink (autolink
                             # references like ADE-* -> Linear), listRepoLabels,
                             # listRepoCollaborators, listRepoIssues.
ade.prs.*                    # stacked PR queue, integration, issue inventory,
                             # Path-to-Merge orchestrator (ade.prs.pathToMerge.start /
                             # ade.prs.pathToMerge.stop) and ade.prs.retargetBase used
                             # by the queue Automate Merging modal
ade.conflicts.*              # risk matrix, simulation, proposals
ade.cto.*                    # identity, agent roster, Linear
ade.sessions.*               # terminal session CRUD
ade.agentChat.*              # agent chat sessions, model inventory, parallel launch state.
                             # Includes ade.agentChat.modelCatalog (provider-grouped catalog
                             # used by desktop + TUI + iOS ModelPickers; accepts
                             # `{ mode: "cached"|"refresh-stale"|"force", refreshProvider?: "opencode"|"cursor"|"droid"|"lmstudio"|"ollama" }`).
ade.ai.*                     # AI integration status + provider auth (storeApiKey/deleteApiKey/getStatus/...).
                             # ade.ai.isOpenCodeInstalled is a cheap probe (no runtime spin-up)
                             # used to gate the ModelPicker OpenCode rail + Settings install CTA.
ade.ai.cursorCloud.*         # Cursor background-agents bridge: listRepositories, listAgents, listRuns, getAgent, createRun, followUp, streamRun, cancelRun, archiveAgent / unarchiveAgent / deleteAgent, listArtifacts / downloadArtifact, openChat (mirror an existing cloud agent into an ADE chat session)
ade.automations.*
ade.processes.* / ade.tests.* # processes also expose group bulk ops:
                             # ade.processes.startGroup / stopGroup / restartGroup
ade.config.*                 # project config get/save/trust
ade.keybindings.*
ade.sync.*                   # device registry, PIN pairing (getPin/setPin/clearPin), QR payload, lane presence announce (setActiveLanePresence), host transfer
ade.usage.*                  # token/cost accounting
ade.layout.* / ade.graph.*
ade.computerUse.*
ade.iosSimulator.*           # macOS-only iOS Simulator drawer + Preview Lab: getStatus/launch/shutdown/screenshot/getScreenSnapshot/getInspectorSnapshot/inspectPoint/getPreviewCapability/listPreviewTargets/renderPreview/openPreviewWorkspace/startStream/stopStream/getStreamStatus/getWindowState/listWindowSources/tap/typeText/drag/swipe/selectPoint, plus the ade.iosSimulator.event push channel
ade.appControl.*             # Electron app control bridge over Chrome DevTools Protocol: getStatus/launch/launchInTerminal/connect/stop/screenshot/getSnapshot/inspectPoint/selectPoint/click/typeText/scroll/dispatchKey/listTargets/attachToTarget, plus the ade.appControl.event push channel (session-started/updated/stopped, selection, screencast frame)
ade.builtInBrowser.*         # in-app web browser owned by `builtInBrowserService`: getStatus/showPanel/setBounds/attachWebview/navigate/createTab/switchTab/closeTab/reload/goBack/goForward/stop/startInspect/stopInspect/captureScreenshot/selectPoint/selectCurrent/clearSelection, plus the ade.builtInBrowser.event push channel (status / open-request / selection / selection-cleared / error). Backs the Work sidebar's Browser tab and the renderer-wide `openUrlInAdeBrowser()` link router.
ade.terminal.*               # chat-owned terminal control: list/read/write/signal/activeForChat. Resolves a chat's active terminal via chatSessionId so in-chat agents and the App Control panel can drive the visible launch terminal.
ade.macosVm.*                # lane-tied macOS VM lifecycle and GUI control: getStatus/provision/start/stop/restart/delete/wipe/installRuntime/setCredentials/getCredentials/detachLane/getStorageInfo/getAgentGuide/focusWindow/getDisplaySession/captureScreenshot/selectPoint/click/typeText, plus the ade.macosVm.event push channel. Uses Lume first, direct/headless VNC when ADE has managed credentials, and sanitized mirrors for lane roots that contain ADE local state. `setCredentials`/`getCredentials` are Keychain-backed (`security`-shelled service `ade-macos-vm-<vmName>` / account `ade-cli`); `installRuntime` drives the in-guest ade-runtime bootstrap over SSH+SCP through `runtimeBootstrap.ts`.
ade.updates.*
```

### 5.3 Main-process handlers

`apps/desktop/src/main/services/ipc/registerIpc.ts` (~6,400 lines) is the single registration point:

- `ipcMain.handle(IPC.channelName, async (event, args) => { ... })` for invoke channels.
- Every handler is wrapped with a timeout — 30 seconds by default, with explicit longer budgets for known long operations such as direct lane delete, iOS Simulator launch/control, macOS VM provisioning/control, App Control, and built-in browser actions. Runtime-dispatched actions use the runtime-call channel budget; the timeout wrapper no longer inspects the action payload to give `lane.delete` a special runtime-dispatch override.
- Every handler emits structured tracing: `ipc.invoke.begin`, `ipc.invoke.done`, `ipc.invoke.failed` with call ID, channel, window ID, duration, and summarized args/results.
- `AppContext` indirection: handlers close over a context pointer that swaps atomically on project switch, so IPC channels remain registered across project transitions.
- **Multi-window shell** — the app can host multiple `BrowserWindow` instances (for example when opening another project in a dedicated window). Handler tracing already carries **window ID** so logs and diagnostics distinguish which renderer surface invoked a channel; `main.ts` ties each window to its **set** of open project roots before routing into services. Two maps in `main.ts` drive this: `windowProjectRoots` tracks the active foreground project per window, and `windowProjectTabRoots` tracks every project root that window currently has open as a tab. Project-scoped event broadcasts (`emitToProjectWindows`) deliver to any window whose active **or** open-tab set contains the project, so background tabs keep receiving live updates. `ade.app.getWindowSession` returns `{ project, binding, openProjectTabs }` for the requesting window; the renderer mirrors its open-tab list back to main with `ade.app.setWindowProjectTabs({ rootPaths })` so the main process can keep those project contexts warm and clean up on window close. Renderer tab switches use cached project/lane snapshots for warm activation, retain caches for every open tab root even if a project is absent from recents, keep Work and Lanes mounted after first visit, and cover cold switches with a project-transition veil.
- **Project context retention.** `MAX_WARM_IDLE_PROJECT_CONTEXTS = 100` is a soft cap for project contexts with no user work. `hasActiveProjectWorkloads(ctx)` protects any context that has live chat sessions (via `agentChatService.hasRetainableSessions()` — any session the user hasn't explicitly closed or deleted, not just mid-turn ones), live PTYs (`ptyService.hasLiveSessions()`), active managed processes, or queued tests. Eviction is best-effort and never tears down a context with work; the cap exists only as a safety valve against opening hundreds of empty projects in a long session.

### 5.4 Event subscriptions (push, not poll)

High-frequency events flow from main → renderer via `webContents.send(channel, payload)`. Partial list:

| Event | Producer | Consumer |
|-------|----------|----------|
| `ade.pty.data` / `ade.pty.exit` | ptyService | TerminalView, Work tab |
| `ade.files.change` | fileWatcherService | Files tree, diff views |
| `ade.processes.event` | processService | Run tab, stack buttons |
| `ade.tests.event` | testService | Test panel |
| `ade.conflicts.event` | conflictService | Conflicts page, Graph overlay |
| `ade.prs.event` | prPollingService | PRs page, stacked queue |
| `ade.agents.event` | CTO/worker services | CTO tab feed |
| `ade.lanes.rebaseSuggestions.event` / `ade.lanes.autoRebase.event` / `ade.lanes.rebase.event` | rebase services | Lanes + Graph |
| `ade.project.missing` | projectService | Shell banner |
| `ade.project.state.event` | projectState | Startup flow |
| `ade.sync.*` events | syncService | Settings → Sync |

Renderer telemetry events flow back to main: `renderer.route_change`, `renderer.tab_change`, `renderer.window_error`, `renderer.unhandled_rejection`, `renderer.event_loop_stall`.

---

## 6. Services Catalog (Desktop Client Main Process)

Most services described here live under `apps/desktop/src/main/services/<domain>/` in the desktop client's main process. Some are runtime delegations: they front a runtime-owned subsystem (project registry, sync host, agent registry, credential store, multi-project RPC) through a thin local pool plus, where applicable, a legacy in-process fallback. The runtime-side equivalents live under `apps/ade-cli/src/services/`. Summary:

| Domain | Key files | Role |
|--------|-----------|------|
| `ai/` | `aiIntegrationService.ts`, `authDetector.ts`, `providerConnectionStatus.ts`, `claudeRuntimeProbe.ts`, `modelsDevService.ts`, `compactionEngine.ts`, `tools/*` | Provider routing, detection, tool definitions, compaction. |
| `agentTools/` | `agentToolsService.ts` | Agent tool registry metadata surfaced to the renderer. |
| `appControl/` | `appControlService.ts` | Chrome DevTools Protocol bridge for developer-owned Electron apps. Launches a chat-owned PTY running the user's dev command (or connects to an existing `--remote-debugging-port`), polls `/json` for ready CDP targets, attaches a long-lived `CdpClient` WebSocket, and exposes screenshot / DOM snapshot / hit-test / click / type / scroll / key dispatch / screencast frames. `inspectPoint` and `selectPoint` produce `AppControlContextItem`s for the chat composer (DOM packet + screenshot + source-file candidates resolved by `findSourceMatches` over an indexed tree of project source files). See [features/computer-use/app-control.md](./features/computer-use/app-control.md). |
| `builtInBrowser/` | `builtInBrowserService.ts` | In-app web browser owned by the main process. Allocates `WebContentsView` tabs against the shared `persist:ade-browser` partition (cap 10), positions them over a renderer-supplied bounds rect, drives navigation / tabs / reload / back / forward, attaches the Chrome DevTools Protocol debugger for inspect-mode hit tests, captures screenshots, and emits `BuiltInBrowserEventPayload`s to subscribers. Consumed by `ChatBuiltInBrowserPanel` (Work sidebar Browser tab) and by `openUrlInAdeBrowser()` in the renderer so renderer-side link clicks open inside ADE rather than the system browser. |
| `automations/` | `automationService.ts`, `automationPlannerService.ts`, `automationIngressService.ts`, `automationSecretService.ts` | Rule lifecycle, NL → rule planner, inbound triggers, per-rule secrets. |
| `chat/` | `agentChatService.ts`, `runtimeEvents.ts`, `buildClaudeV2Message.ts`, `markdownSlashCommandDiscovery.ts`, `claudeSlashCommandDiscovery.ts`, `codexSlashCommandDiscovery.ts`, `cursorSlashCommandDiscovery.ts`, `projectSlashCommandDiscovery.ts`, `slashCommandPromptExpansion.ts`, `cursorSdk*` (`cursorSdkPool.ts`, `cursorSdkWorker.ts`, `cursorSdkProtocol.ts`, `cursorSdkPolicy.ts`, `cursorSdkSystemPrompt.ts`, `cursorSdkEventMapper.ts`), `sessionRecovery.ts` | Agent chat sessions (lane-scoped + mission worker/coordinator). Builds Claude messages, hosts the Cursor SDK in a Node worker pool, formalizes the cross-runtime event vocabulary, discovers and resolves provider-specific slash commands through a shared markdown engine, recovers sessions on restart, and derives prompt-based lane names for parallel model launches. |
| `computerUse/` | `computerUseArtifactBrokerService.ts`, `controlPlane.ts`, `localComputerUse.ts`, `agentBrowserArtifactAdapter.ts`, `syntheticToolResult.ts` | Proof-artifact broker (ingests, owner links, review state, routing), control-plane snapshot helpers, macOS capture capability descriptor, agent-browser payload parser, and the synthetic-tool-result helper used by the Claude compaction path. `proofObserver.ts` was removed in the rebuild — there is no passive auto-ingest. |
| `config/` | `projectConfigService.ts`, `laneOverlayMatcher.ts` | Load/save `.ade/ade.yaml` + `local.yaml`; trust enforcement; lane overlays. |
| `conflicts/` | `conflictService.ts` | Pairwise dry-merge simulation, risk matrix, proposal generation. |
| `cto/` | `ctoStateService.ts`, `workerAgentService.ts`, `workerBudgetService.ts`, `workerHeartbeatService.ts`, `linearSyncService.ts`, `linearIngressService.ts`, `linearOAuthService.ts`, `linearRoutingService.ts`, `linearDispatcherService.ts`, `linearCloseoutService.ts`, `flowPolicyService.ts`, `linearLaneCardService.ts` | CTO identity, worker agents, session logs, and Linear sync/ingress/OAuth/routing/dispatcher/closeout. `linearLaneCardService` posts the Linear attachment card and builds the cross-machine ADE deeplink that backs the card's URL. |
| `deeplinks/` | `protocolHandler.ts` | Registers the `ade://` OS protocol handler, owns the single-instance lock, buffers cold-start URLs until `app.whenReady()`, and dispatches parsed URLs through `IPC.appNavigate` to the focused window. Re-used by the iOS Send-to-Mac sync command (`syncRemoteCommandService.deeplinks.open`). Shared parser + builder live in `apps/desktop/src/shared/deeplinks.ts`; the PR "Open in ADE" footer is in `apps/desktop/src/shared/adeDeeplinkFooter.ts`. See [features/deeplinks/README.md](./features/deeplinks/README.md). |
| `devTools/` | `devToolsService.ts` | Probe for git + `gh` CLI availability. |
| `diffs/` | `diffService.ts` | Diff computation for file panes. |
| `feedback/` | `feedbackReporterService.ts` | In-app feedback reporting. Two-stage: `prepareDraft` generates a structured issue title + labels (AI-assisted when a model is selected, deterministic fallback otherwise) so the user can review before posting; `submitPreparedDraft` files the GitHub issue. Each submission records `generationMode` and a `generationWarning` so the UI can flag deterministic drafts. |
| `files/` | `fileService.ts`, `fileWatcherService.ts`, `fileSearchIndexService.ts` | Workspace file tree, read/write, watch, index. |
| `git/` | `git.ts`, `gitOperationsService.ts`, `gitConflictState.ts` | Low-level git runner, high-level lane-scoped ops, conflict state queries. |
| `github/` | `githubService.ts` | GitHub REST/GraphQL access; PR CRUD; checks; reviewers. |
| `history/` | `operationService.ts` | Operation audit records (one row per mutation). |
| `ios/` | `iosSimulatorService.ts` | macOS-only iOS Simulator backend: tool readiness probes, simctl device + app discovery, build/install/launch with progress events (hardened with `simctl bootstatus` and `simctl install` timeouts), screenshot + ADEInspector + accessibility hit-test, IOSurface/Indigo primary streaming and input with idb/simctl/window-capture fallbacks, recovery-only H.264+ffmpeg after idb MJPEG failure, and single-owner chat session locking. The macOS Simulator window placement / capture state probe (`getSimulatorWindowState`, `prepareSimulatorWindowForCapture`) lives next to the IPC handlers in `ipc/registerIpc.ts` because it depends on the active `BrowserWindow`. See [features/ios-simulator/README.md](./features/ios-simulator/README.md). |
| `ipc/` | `registerIpc.ts`, `runtimeBridge.ts`, `ipcTimeouts.ts` | Single registration point for all IPC handlers. `runtimeBridge.ts` owns the runtime-facing channels (remote target registry, remote-runtime connect / project list / action dispatch / event stream, per-target `listActionRegistry` lookup against the remote daemon, local-work checks, LAN + Tailscale discovery with diagnostics) and routes runtime calls through `LocalRuntimeConnectionPool` or `RemoteConnectionPool` based on the active window binding. It also subscribes `powerMonitor` `resume` and `unlock-screen` to `remoteConnectionService.probeSavedConnections()` so a laptop waking up cycles dead SSH sessions before the renderer pokes them. `ipcTimeouts.ts` carries the default 30-second handler timeout plus named channel-level overrides for long direct IPC operations; it does not inspect runtime action payloads. |
| `jobs/` | `jobEngine.ts` | Event-driven background scheduler for lane refresh + conflict prediction. Coalesced, debounced. |
| `keybindings/` | `keybindingsService.ts` | User keybindings read/write. |
| `lanes/` | `laneService.ts`, `laneEnvironmentService.ts`, `laneTemplateService.ts`, `laneProxyService.ts`, `portAllocationService.ts`, `autoRebaseService.ts`, `rebaseSuggestionService.ts`, `laneLaunchContext.ts`, `oauthRedirectService.ts`, `runtimeDiagnosticsService.ts` | Worktree lifecycle, env bootstrap, templates, reverse proxy, port leases, auto-rebase, suggestions, OAuth redirect, diagnostics. |
| `logging/` | `logger.ts` | File-backed structured logger. |
| `localRuntime/` | `localRuntimeConnectionPool.ts` | Desktop-side client for the local `ade serve` daemon. Spawns or attaches to the machine socket, registers local projects with `projects.add`, dispatches local runtime actions with per-call timeouts where needed, polls runtime events, and installs the background service best-effort in packaged builds. |
| `macosVm/` | `macosVmService.ts`, `rfbDirectClient.ts`, `credentialsStore.ts`, `runtimeBootstrap.ts`, `macosVmRecovery.ts` | Lane-tied macOS VM lifecycle and GUI control. `macosVmService.ts` uses Lume, stores VM records in `.ade/cache`, mounts direct lane roots when safe (otherwise a sanitized rsync mirror), and exposes screenshot/click/type/select through headless VNC or visible-window fallbacks. `credentialsStore.ts` keeps guest user credentials in the macOS Keychain (`/usr/bin/security`, service `ade-macos-vm-<vmName>` / account `ade-cli`); renderers only see a summary. `runtimeBootstrap.ts` installs the in-guest ade-runtime over SSH+SCP with a five-phase progress signal (`ssh-probe`, `write-script`, `scp-script`, `run-script`, `verify-marker`). `macosVmRecovery.ts` is a standalone CLI cleanup path for stale records / lease / VNC credentials when the desktop surface cannot reach them. |
| `onboarding/` | `onboardingService.ts` | First-run flow, defaults detection, existing lane discovery. |
| `opencode/` | `openCodeRuntime.ts`, `openCodeServerManager.ts`, `openCodeBinaryManager.ts`, `openCodeInventory.ts`, `openCodeModelCatalog.ts` | OpenCode server spawn, binary resolution, model discovery. |
| `processes/` | `processService.ts` | Managed-process lifecycle per lane, readiness probes, restart policies. |
| `projects/` | `adeProjectService.ts`, `configReloadService.ts`, `projectService.ts`, `logIntegrityService.ts`, `recentProjectSummary.ts`, `projectBrowserService.ts`, `projectDetailService.ts` | Project detection + `.ade` repair/bootstrap, reload on config change, recent-project metadata. `projectBrowserService` is the in-app directory autocomplete used by the Command Palette project browser (typed-path completion, `.git` detection, home expansion, system-picker fallback); `projectDetailService` returns repo metadata (branch, dirty count, ahead/behind, last commit, README excerpt, language mix, lane count, last-opened) for the palette's preview pane. |
| `prs/` | `prService.ts`, `prPollingService.ts`, `prSummaryService.ts`, `queueLandingService.ts`, `issueInventoryService.ts`, `prIssueResolver.ts`, `prRebaseResolver.ts`, `integrationPlanning.ts`, `integrationValidation.ts` | PR CRUD, polling (with per-PR `last_polled_at` cursor), AI summary cache keyed by `(prId, head_sha)`, stacked-queue landing, issue inventory, AI-assisted resolution, integration planning, and merge-into-existing-lane proposal adoption. |
| `pty/` | `ptyService.ts` | `node-pty` spawn, PTY I/O bridging, transcript writing. |
| `remoteRuntime/` | `remoteTargetRegistry.ts`, `sshTransport.ts`, `remoteBootstrap.ts`, `remoteConnectionPool.ts`, `remoteConnectionService.ts`, `runtimeRpcClient.ts`, `runtimeDiscovery.ts` | Saved SSH machines (manual host + alternate `routes[]` with `lastSucceededAt`), ssh-agent/key transport with ssh2 keepalive and multi-route fallback, first-connect runtime upload/version verification, remote project catalog, action dispatch, reconnect/eviction with pool eviction listeners, `powerMonitor` resume probe, and LAN + Tailscale discovery that returns diagnostics alongside machines. |
| `runtime/` | `tempCleanupService.ts`, `processRegistryService.ts`, `machineStateMigration.ts` | Runtime temp cleanup. `processRegistryService` is the per-process heartbeat registrar against `runtime_processes` (see §3.4); reconcile/dispose paths in `sessionService` and `ptyService` consult it via `listLivePids()` / `isPidLive()` before sweeping `terminal_sessions` rows owned by sibling processes. `machineStateMigration` carries one-shot migrations of the per-machine state files under `~/.ade/`. |
| `sessions/` | `sessionService.ts`, `sessionDeltaService.ts` | Terminal session CRUD, post-session delta computation. |
| `shared/` | `utils.ts`, `queueRebase.ts`, `packLegacyUtils.ts`, `transcriptInsights.ts` | Cross-domain utilities. |
| `state/` | `kvDb.ts`, `crsqliteExtension.ts`, `globalState.ts`, `projectState.ts`, `onConflictAudit.ts` | SQLite schema + open, CRR extension loader, global state file, per-project state init. `globalState.upsertRecentProject` accepts `preserveRecentOrder` so reactivating an already-known project (by app focus, deep link, etc.) refreshes its `lastOpenedAt` in place instead of jumping it to the front of the recents list. |
| `sync/` | `syncService.ts`, `syncHostService.ts`, `syncPeerService.ts`, `syncRemoteCommandService.ts`, `syncProtocol.ts`, `deviceRegistryService.ts`, `syncPairingStore.ts` | **Thin delegation to the runtime daemon's sync host plus a legacy in-process fallback.** The authoritative sync host now lives in `apps/ade-cli/src/services/sync/`; the desktop main-process instances default to a non-host viewer role for legacy state. The old in-process host is disabled unless `ADE_ENABLE_DESKTOP_SYNC_HOST=1` (diagnostics only). Wire formats — WebSocket envelope, remote command routing, device registry, pairing secrets — are the same across both implementations. |
| `notifications/` | `apnsService.ts`, `apnsBridgeService.ts`, `notificationMapper.ts`, `notificationEventBus.ts` | APNs HTTP/2 client (ES256 JWT, key persisted via Electron `safeStorage` on the desktop or `EncryptedFileCredentialStore` under `.ade/secrets/` in the headless daemon), pure domain-event → `MappedNotification` mapping (13 categories / 4 families), event bus routing to APNs alert pushes + Live Activity update pushes + in-app WS delivery, filtered by per-device `NotificationPreferences`. `apnsBridgeService.ts` is the `notifications_apns` ADE action domain (`getStatus`, `saveConfig`, `uploadKey`, `clearKey`, `sendTestPush`) so the same Settings flow works whether the active project is local-bound or SSH-bound. |
| `tests/` | `testService.ts` | Test-suite execution + run history. |
| `updates/` | `autoUpdateService.ts` | Electron auto-update wrapper around `electron-updater`. Owns the renderer-visible `AutoUpdateSnapshot` (`idle \| checking \| downloading \| ready \| installing \| error`), uses `compareUpdateVersions` (SemVer-aware) to dedupe / supersede staged installers and to reconcile `pendingInstallUpdate` against the running version on next boot. `quitAndInstall()` is async: it re-runs `checkForUpdates({ allowReady: true })` to confirm the staged build is still latest, and only then flips to `installing` and calls `updater.quitAndInstall(false, true)`. |
| `usage/` | `usageTrackingService.ts`, `budgetCapService.ts` | Token/cost accounting, budget enforcement. Local cost scans stream bounded recent Claude/Codex JSONL files instead of loading the whole history into memory. |
| `perf/` | `perfLog.ts`, `perfIpc.ts`, `metricsSampler.ts`, `aggregator.ts` | Opt-in local performance harness. `ADE_PERF_RUN_ID` opens a JSONL event log, samples Electron process metrics, records IPC durations, accepts renderer perf marks/web-vitals, and aggregates each run into `summary.json`. |

Startup sequencing: every background service goes through `scheduleBackgroundProjectTask()` in `main.ts`, which provides explicit labels, `ADE_ENABLE_*` env gates, `project.startup_task_begin`/`_done`/`_enabled`/`_skipped` telemetry, and per-task delays. Integrations stay **dormant-until-configured**.

Project-init step timing goes through `measureProjectInitStep(step, task)` — a wrapper that logs `project.init_step { projectRoot, step, durationMs }` around each hot-path operation (`db_open`, `lane.ensure_primary`, `ade_rpc.socket_server_start`, `sync.initialize`, etc.) so cold-start latency shows up in the logs by phase. Sync-service initialization is scheduled through `scheduleBackgroundProjectTask` rather than awaited inline, gated by `ADE_ENABLE_SYNC_INIT`.

Shutdown pipeline: `main.ts` owns a single `requestAppShutdown({ reason, exitCode, fastKillFirst?, forceAfterMs? })` path driving a central state machine (`shutdownRequested` → `shutdownPromise` → `shutdownFinalized`). Hooks into `before-quit`, `window close`, `SIGINT`, `SIGTERM`, `process.exit`, `will-quit`, and `uncaughtException` all funnel through it. `runImmediateProcessCleanup()` disposes automations, tests, processes, PTYs, agent chat runtimes, DB flush, and then calls `shutdownOpenCodeServers()`. A `forceAfterMs` timer (default 8 s, 5 s for signals/uncaught) hard-exits if cleanup hangs. User-initiated quit (main window close or `before-quit`) routes through `confirmQuitWarning()` — a modal dialog that explains that quitting will end agents and background processes owned by the desktop session, including OpenCode servers, terminal sessions, and test runs.

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

- `createProjectAppStore(project)` returns a fresh per-project store pre-hydrated with the project binding + a copy of root-store user preferences. Setters for theme/terminal/chat preferences point at the root store so user preferences mutate in one place and are then mirrored into every project store via `hydrateProjectAppStore` whenever `rootPrefs` change in `ProjectTabHost`. This is what lets two open project tabs share a theme even though they have independent lane/chat state.
- `AppStoreProvider` + `AppStoreContext` scope the active store to a `ProjectSurface` subtree. The `useAppStore` hook reads from `useContext(AppStoreContext) ?? rootAppStore`, and `useAppStoreApi()` returns the bare `StoreApi` for components that want imperative `getState()` access without subscribing. `useAppStore.getState / setState / subscribe` still point at the root store so code that needs cross-window globals (recent projects, user preferences, the root binding) can continue to call it directly.
- Narrow selectors on components to minimize re-renders.
- `refreshLanes` accepts independent lane-status and lane-snapshot flags. Callers can refresh cheap runtime snapshot decorations without recomputing git status, or update git status without rebuilding conflict/rebase/auto-rebase overlays; statusless refreshes preserve the previous `LaneStatus`/`parentStatus` in store so the UI does not flicker to unknown git state.
- Per-project work-view state keyed by project root (`WorkProjectViewState`). Includes the right-edge Work sidebar fields `workSidebarOpen`, `workSidebarTab` (`"git" | "files" | "ios" | "app-control" | "browser"`), and `workSidebarWidthPct` (clamped 26–55) — persisted alongside the rest of the work-view state under `ade.workViewState.v1`. The sidebar consolidates lane-scoped tools that were previously split across separate floating panes; per-chat iOS / App Control drawers still exist on `AgentChatPane` but are suppressed when the chat is mounted as a Work tile so the sidebar owns those surfaces at lane scope. The `browser` tab is the only sidebar tab that is not lane-scoped — the built-in browser is one shared instance per app.
- Project tab bookkeeping. `openProjectTabRoots: string[]` is the LRU-ordered list of project roots open in the window (mirrored to the main process via `ade.app.setWindowProjectTabs` so background services keep those projects warm); `projectInfoByRoot: Record<string, ProjectInfo>` caches the `ProjectInfo` payload for tab favicons and offline tab rendering. `setProject` is the only path that mutates either map.
- Stale-while-revalidate switch caches. `laneSelectionByProject` remembers the `{ laneId, sessionId }` selection per project root so switching tabs lands on the lane/chat the user last had open instead of "first lane". `laneCacheByProject` mirrors the last good `{ lanes, laneSnapshots }` per root; `switchProjectToPath` applies the cached entry immediately on switch (no spinner, no chat-pane unmount) and refreshes silently in the background. `sessionsCacheByProject` does the same for `useWorkSessions` so the chat tabs / terminal grid don't blank during a tab swap. All three caches are pruned to active + recent-projects when a project actually changes.
- `projectRevision` is a monotonically incrementing counter bumped inside `setProject` whenever the active project root actually changes. Long-lived renderer-side caches (most notably the module-level xterm runtime cache in `TerminalView.tsx`) subscribe to it and tear down any entries whose `projectRoot`/`projectRevision` no longer match, so PTYs never bleed between projects. All project-transition paths (`refreshProject`, `openRepo`, `switchProjectToPath`, `closeProject`) go through `setProject` to keep the counter honest.

Domain stores co-located with their pages follow the same factory + context pattern when they need per-page isolation:

- `chatDraftStore.ts` — draft messages per chat session.

### 7.3 Component organization

Feature-grouped under `apps/desktop/src/renderer/components/`:

```
app/            # shell, App.tsx, TopBar, TabNav, startup, splash
project/        # Play tab, run/test/process controls
lanes/          # list/detail/inspector, stacks, laneDesignTokens.ts
files/          # tree, editor, diffs
terminals/      # TerminalView, WorkViewArea (PaneTilingLayout-backed grid), WorkSidebar, workSessionTiling, LaneCombobox
vm/             # MacVmPage dedicated lane-tied macOS VM surface
conflicts/      # risk matrix, simulation, resolution
graph/          # WorkspaceGraphPage (decomposed into nodes/edges/dialogs)
prs/            # PR list/detail, stacked queue, shared/
history/        # operation timeline
automations/    # rule list, pipeline builder
cto/            # CTO page, identity editor, team panel, pipeline, shared/designTokens.ts
onboarding/     # first-run flows
settings/       # keybindings, agents, data, context, sync
chat/           # AgentChatPane + composer + subpanels
shared/         # MentionInput, shared interactive bits
ui/             # pure presentation primitives
```

Design tokens have been intentionally trimmed. The CTO design tokens at `apps/desktop/src/renderer/components/cto/shared/designTokens.ts` are the example style: a small set of Tailwind class constants (`cardCls`, `surfaceCardCls`, `shellBodyCls`, `inputCls`, `labelCls`, etc.) and a constrained accent palette (`ACCENT.purple/blue/green/pink/amber`). Lane design tokens live at `lanes/laneDesignTokens.ts` and are imported across lanes/PRs/settings.

### 7.4 Layout patterns

- `PaneTilingLayout` — recursive pane trees for high-density workspaces, backed by pure ops in `paneTreeOps.ts` (`reconcilePaneTree`, `splitPaneAtEdge`, `swapPanes`, `detectDropEdge`). Trees persist per `layoutId` via `window.ade.tilingTree`; panel sizes persist separately via `DockLayoutState` and are reset whenever the tree mutates.
- `SplitPane` / resizable panels — structured 2/3-pane views.
- Work view's grid mode is `PaneTilingLayout` seeded by `buildWorkSessionTilingTree(sessionIds)` (in `renderer/components/terminals/workSessionTiling.ts`); every session becomes a `FloatingPane` leaf with `grid-tile` chrome.
- Project tab hosting: `App.tsx`'s `ProjectTabHost` mounts one persistent `ProjectSurface` per open project tab inside a single window. Each `ProjectSurface` owns its own zustand store instance (`createProjectAppStore(project)`), pre-hydrated with the project binding plus a copy of root-store user preferences (theme, terminal preferences, chat font, sound, density, etc.). User-preference setters point at the **root** store, so changes flow to one place and are then mirrored into every project store on the next `rootPrefs` change. A LRU sorts mounted surfaces and caps the warm-mounted set at `WARM_PROJECT_SURFACE_LIMIT = 8`; surfaces beyond that limit are dropped from the React tree (their store entry is GC'd) but the persisted lane/chat caches in the root store keep their data live so a re-mount is cheap.
- Per-project routing: each surface remembers its own route (`/work`, `/lanes`, `/files`, `/prs`, `/cto`, `/automations`, `/settings`, …) under `ade:project-route:<projectRoot>` in `localStorage`. `ProjectTabHost` swaps which surface is `active` based on the foreground project tab, stashing the outgoing route and replaying the incoming surface's last route via `navigate(..., { replace: true })`. Inactive surfaces stay in the tree (`aria-hidden`, `inert`, absolutely positioned at `z-index: -1`, opacity 0, pointer-events none) so chats / terminals / live polling don't tear down on tab swap.
- Work-surface reveal: `ProjectRouteContent` keeps the `/work` route mounted lazily inside each project surface. When the surface itself becomes active **and** the route is a work route, it dispatches the `WORK_SURFACE_REVEALED_EVENT` window event so terminal tiles can clear their texture atlas, force-fit, and refocus.
- Page-level active gating: lazy feature pages (`LanesPage`, `FilesPage`, `WorkspaceGraphPage`, `PRsPage`, `ReviewPage`, `HistoryPage`, `AutomationsPage`, `AutomationsTemplatesPage`, `CtoPage`, `SettingsPage`) accept an `active?: boolean` prop and gate every `useEffect` that fires IPC polling, event subscriptions, or initial data fetches behind it. Inactive surfaces in background project tabs render their last state but don't poll — the project's runtime is still alive, so the freshness is restored on the next refresh when the user returns.
- The desktop TopBar project tab strip resolves a per-project favicon via `window.ade.project.resolveIcon(rootPath)` and caches the result in a module-local `Map`. Tabs without an icon (or a missing project root) fall back to the `Folder` Phosphor glyph; the same component drives the loading-pulse animation when a tab is being switched into or closed.
- Layout state persists to SQLite (`layout`, `tilingTree`, `graphState` domains via the `kv` table).

### 7.5 Performance contract

Enforced rules (from the stability overhaul):

1. All background services go through `scheduleBackgroundProjectTask()` — no raw `setTimeout` for service startup.
2. New integrations are dormant-until-configured.
3. Feature pages stage data: cheapest (list/summary/topology) first, heavy (dashboard/settings/model metadata/overlays) on delay.
4. Never mount expensive trees eagerly — settings dialogs, advanced launcher sections unmount when closed.
5. Renderer polling is route-scoped; terminal attention only polls on terminal routes; lane panels only poll while live sessions exist. The plain PR list does not fire a GitHub refresh on mount, renders active-repository PR snapshots only, skips conflict analysis, and defers rebase-needs / auto-rebase polling until the user opens a workflow tab or selects a PR. Selected PR detail reads apply progressively so slow comments or action-run hydration do not block status/checks/files from painting. Workflow PR views batch merge contexts and conflict analysis against metadata-only lane rows instead of running per-PR git/status work. The Lanes page reuses the `LaneSummary.autoRebaseStatus` snapshot already in the lane list instead of probing per-lane on `LaneGitActionsPane` mount; a fallback probe runs only when the snapshot is missing and after a visibility-gated 3.5 s delay. Run's `LaneRuntimeBar` keeps health/process refreshes separate from preview routing / port / OAuth refreshes so process events do not reread routing state. The Work top-bar sync chip refreshes on focus and on `sync-status` events instead of a 5 s interval. The chat composer's Cursor model inventory is fetched lazily — `ProviderModelSelector` calls `onOpen` on first open of the model catalog, and `AgentChatPane.refreshCursorModelInventory` is the only entry point that hits `cursor` with `activateRuntime: true`.
6. Shared caches for high-frequency calls (`sessionListCache`, GitHub fingerprint-based snapshots).
7. Memoize expensive renderer computations (`useMemo`, `React.memo`); isolate frequently-refreshing subtrees (e.g., budget footers).
8. `Promise.allSettled` over `Promise.all` for parallel startup — one failing service must not block others.
9. Settings sections that surface a snapshot read the cached snapshot on mount (`ade.usage.getSnapshot`) instead of forcing a refresh; an explicit Refresh button drives recompute.
10. Persistence callbacks dedupe against the last-saved value: the workspace-graph view-mode persister tracks the last-loaded preference root and skips the immediate write that the load handler's `setViewMode` would otherwise fire.

CLI-launcher and shell-quoting helpers (`cliLaunch.ts`, `shell.ts`) live under `apps/desktop/src/renderer/` only — the prior `apps/desktop/src/shared/` copies were renderer-only in practice and have been removed. The mobile-launcher path (`work.startCliSession`) was retired with them; iOS launches CLI sessions through host-side actions that don't share renderer modules.

Themes: six shipped themes (`e-paper`, `bloomberg`, `github`, `rainbow`, `sky`, `pats`), persisted in `localStorage.ade.theme`, applied via `data-theme` on root. Token-based palettes in `apps/desktop/src/renderer/index.css`.

### 7.6 Renderer primitives

- `renderer/lib/dialogBus.ts` — tiny pub/sub that lets the onboarding tour engine (and anyone else) open/close dialogs by a stable id (`lanes.create`, `settings.ai`, etc.) without prop-drilling. Dialogs subscribe by id; a `subscribeAll` channel exists for devtools. Default singleton export `dialogBus`.
- `renderer/onboarding/waitForTarget.ts` — polls for a DOM target (ref or `data-onboarding-target`) with a visibility check so tour steps anchor reliably to async-mounted UI.
- `renderer/onboarding/TourController.ts` — imperative driver for the onboarding tour state machine.
- `renderer/onboarding/docsLinks.ts` — typed registry of internal/public doc URLs (`docs.lanes`, `docs.cto`, …) that tour steps and the `HelpMenu` link to.
- `renderer/components/onboarding/fx/*` — shared motion-FX primitives (`ActIntro`, `AnimatedField`, `Confetti`, `GhostCursor`, `MorphingTree`, `Spotlight`, `StaggeredText`, `TourIllustration`) with a `useReducedMotion` hook. Used by the 13-act first-session tutorial and per-tab tours.

Related UI docs: [Terminals UI surfaces](./features/terminals-and-sessions/ui-surfaces.md), [Files and editor](./features/files-and-editor/README.md), and [Onboarding and settings](./features/onboarding-and-settings/README.md).

---

## 8. Security & Trust Boundaries

### 8.1 Electron safeStorage for secrets

| Secret | Location | Protection |
|--------|----------|-----------|
| GitHub PAT | `.ade/secrets/github/*.bin` | `safeStorage.encryptString` (OS-backed) |
| API provider keys | `.ade/secrets/api-keys.json` | Plaintext `0600` |
| Claude OAuth creds | Claude's own store | Inherited |
| Codex auth tokens | Codex's own store | Inherited |
| macOS Keychain entries | OS Keychain | OS-backed |
| Sync site ID | `.ade/secrets/sync-site-id` | Plaintext, never syncs |
| Sync device ID | `.ade/secrets/sync-device-id` | Plaintext, never syncs |
| Sync bootstrap token | `.ade/secrets/sync-bootstrap-token` | Plaintext, never syncs |
| External-ADE CLI secrets | `.ade/local.secret.yaml` | Plaintext, never syncs |

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

**CSP**: `default-src 'self'`; `script-src 'self'` (no eval, no inline scripts); `style-src 'self' 'unsafe-inline'` (required for Tailwind); `connect-src 'self'`; `img-src 'self' data:`.

Every IPC handler **validates** its arguments; invalid args return structured errors, never crash. Every handler has a **30s timeout** by default; `ipcTimeouts.ts` carries per-channel overrides for long-running operations and inspects the payload of `localRuntime.callAction` / `remoteRuntime.callAction` so action-specific timeouts (e.g. `macos_vm.provision`, `macos_vm.start` → 2 h; `lane.create` / `lane.delete` → 4 min; `ios_simulator.launch` → 10 min) apply even when the channel itself is generic. Every handler emits structured tracing.

### 8.3 ADE CLI auth + API-key storage

- ADE CLI session identity is resolved from env vars and the `initialize` handshake.
- Role validation: only `cto`, `orchestrator`, `agent`, `external`, `evaluator` accepted.
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
- `computeLaneStatus()` returns `{ dirty, ahead, behind }` on demand, no caching. Status derivation uses `git status --porcelain=v1` and `git rev-list --left-right --count`.

### 9.4 Queue + conflict simulation

- **Queue landing** (`queueLandingService.ts`) — ordered PR landing with rebase propagation.
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

Related Git docs: [Lanes](./features/lanes/README.md), [Lane runtime isolation](./features/lanes/runtime.md), and [Pull requests](./features/pull-requests/README.md).

---

## 10. Context Continuity

ADE carries continuity through the records owned by each runtime surface:
chat transcripts, CTO and worker session logs, daily logs, and explicit
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

Proof is **intentional**. Agents run computer use through whatever tool they already have — Claude's `computer_use`, Codex shell, a scripted browser, a headless Playwright run, a local screenshot. ADE stays out of that loop. When the agent reaches a checkpoint worth showing, it files an artifact through the broker (directly or via `ade proof capture` / `attach`), optionally with a caption. That record is what the drawer UI renders and what reviewers see.

The previous control-plane model — `ComputerUsePolicy` (`off`/`auto`/`enabled`, `allowLocalFallback`, `retainProof`, `preferredBackend`), passive `proofObserver` ingestion from chat `tool_result` events, and the Settings > Computer Use panel — was removed. There is **one path** now: intentional ingest via the broker.

### 12.2 Broker and backends

`apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` is the ingest boundary. It accepts `ComputerUseArtifactInput[]` (path, remote URI, inline text, inline JSON), materializes on-disk sources into the project artifacts dir via `secureCopyFromDescriptor` (uses `O_NOFOLLOW` + atomic rename to resist symlink tricks), writes the canonical `computer_use_artifacts` row, and links to one or more owners (`lane`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`).

Allowed import roots (trust boundary): `.ade/artifacts`, `.ade/tmp`, `os.tmpdir()`, `~/.agent-browser`. Other paths are rejected.

Supporting files in the same directory:

- `controlPlane.ts` — builds `ComputerUseOwnerSnapshot` (recent artifacts + activity) and `ComputerUseSettingsSnapshot` (backend readiness, capabilities) over the broker.
- `localComputerUse.ts` — exports `getLocalProofCaptureCapabilities()`, a macOS-only descriptor reporting whether `screencapture`, app launch, and GUI-interaction commands are available.
- `agentBrowserArtifactAdapter.ts` — parses agent-browser payloads into `ComputerUseArtifactInput[]`.
- `syntheticToolResult.ts` — produces tool-result stubs during Claude compaction so a previously-executed tool response can be re-surfaced without re-running the tool.

### 12.3 Artifact record

Canonical proof kinds: `screenshot`, `video_recording`, `browser_trace`, `browser_verification`, `console_logs`.

Canonical tables:

- `computer_use_artifacts` — proof kind, backend name/style, source tool metadata, title/description, URI, storage kind, MIME type, review/workflow state, timestamps.
- `computer_use_artifact_links` — cross-domain ownership, so the same artifact can graduate from exploratory chat evidence to a PR comment without losing provenance.

### 12.4 IPC + UI

Channels (under `ade.proof.*`, renamed from `ade.computerUse.*`):

- `ade.proof.listArtifacts`, `ade.proof.getOwnerSnapshot`, `ade.proof.routeArtifact`, `ade.proof.updateArtifactReview`, `ade.proof.readArtifactPreview`, plus a `ade.proof.event` push channel.
- `ade proof capture` / `attach` / `list` in the ADE CLI are the cross-process surface; they call into the broker.

Renderer surfaces:

- `ChatComputerUsePanel` (drawer under the chat composer) and PR/automation proof surfaces.
- Review actions (`accepted` / `needs_more` / `dismissed` / `published`) remain as first-class per-artifact actions.
- Computer-use readiness moved into `IntegrationsSettingsSection` — the standalone `ComputerUseSection.tsx` is gone.

---

## 13. Multi-Device Sync

The sync subsystem is **owned by the ADE runtime daemon** (`apps/ade-cli/src/services/sync/`). When a project is opened, its scope creates a sync service inside the runtime; that runtime is the host. The desktop client and iOS client both connect to the same host. Desktop's old in-process host code path is disabled by default and only re-enabled with `ADE_ENABLE_DESKTOP_SYNC_HOST=1` for diagnostics.

### 13.1 cr-sqlite CRDT + WebSocket

- **Runtime / desktop**: native cr-sqlite loadable extension (`.dylib` / `.dll`) loaded via `openKvDb(...)` in `kvDb.ts`.
- **iOS**: pure-SQL CRR emulation in `apps/ios/ADE/Services/Database.swift` — `crsql_master`, `crsql_site_id`, `crsql_changes`, per-table `<table>__crsql_clock` tables replicated as plain SQLite, with INSERT/UPDATE/DELETE triggers writing Lamport-versioned rows to `crsql_changes`. Custom SQLite functions (`ade_next_db_version()`, `ade_local_site_id()`, `ade_capture_local_changes()`) provide trigger context. Changesets are wire-compatible with the runtime's cr-sqlite.
- **Merge**: last-writer-wins per column. Each device has a unique site ID; Lamport timestamps per column.
- **Sync API** (`AdeDb.sync`): `getSiteId`, `getDbVersion`, `exportChangesSince(version)`, `applyChanges(changes)`.
- **Transport**: WebSocket on port 8787 (configurable); JSON-framed changesets + zlib compression for large batches; 30s ping/pong. The same envelope channel carries project catalog and project-switch handoff messages before the phone reconnects to a project-specific sync host.

### 13.2 Device model

- **Host**: a runtime daemon on one reachable machine owns live execution side effects (agents, PTYs, processes) for a given project. Stored in the synced `sync_cluster_state` singleton row (`brain_device_id` is the legacy internal column name; user-facing language is "host"). Transfer requires a clean preflight (no running turns, live PTYs, running processes). CTO history and idle chats are durable and survive handoff.
- **Controllers**: other connected devices (phones always; a second desktop optionally). Controllers read synced state and send commands to the host runtime.
- **Independent desktops**: a second Mac can run its own runtime daemon and work independently through git without joining an ADE sync session. The tracked `.ade/` scaffold/config layer makes a clone look like an ADE project immediately.

### 13.3 iOS companion sync model

- App launch reads pairing secret from iOS Keychain.
- Opens WebSocket to host; sends local `db_version`; host sends catch-up changesets.
- `hello_ok` can include the host's mobile project catalog. The iOS app shows a native project home until an active project is selected, then requests a `project_switch_result` containing a project-specific bootstrap token and address candidates.
- Bidirectional sync continues; on disconnect, exponential-backoff reconnect with version catch-up. `reconnectIfPossible` is guarded against overlapping runs.
- All reads are local and scoped to the active project id — the iOS tab is instant and offline-capable after the selected project's row has hydrated.
- Writes from user actions: write locally, replicate to host. Execution commands (create PR, run command) are routed to the host via the `command`/`command_ack`/`command_result` message flow.
- Sub-protocols: changeset sync, project catalog/switch, file access,
  subscribed terminal stream/control, chat stream (live `chat_event`
  push from host), command routing, and lane presence announce/release.
  Command routing includes the Work CLI launcher
  (`work.startCliSession`), whose provider command construction is
  shared with the desktop Work tab through
  `apps/desktop/src/shared/cliLaunch.ts`.
- Pairing is a **user-set 6-digit PIN** stored at `.ade/secrets/sync-pin.json` on the host. The phone sends the PIN once; the host returns a durable per-device secret. QR payload is v2 (host identity + port + address candidates, no pairing code).
- APNs pipeline: iOS registers device tokens (alert + push-to-start + per-activity update) via `SyncService.registerPushToken`. The host's `notificationEventBus` routes domain events (chat, PR, CTO, system) to `apnsService` for alert pushes and Live Activity update pushes, filtered by per-device `NotificationPreferences` stored in the iOS App Group `UserDefaults`.
- Widgets: `ADEWorkspaceWidget` (Home Screen), `ADELockScreenWidget`, `ADEControlWidget` (Control Center, iOS 18+) read from a shared `WorkspaceSnapshot` in the App Group container. `LiveActivityCoordinator` manages the single workspace Live Activity.
- Tabs: Lanes, Files, Work, PRs, CTO, Settings.

### 13.4 Conflict resolution semantics

- LWW per column via Lamport timestamps is the default merge.
- `ON CONFLICT(...)` upserts must target PK only (non-PK UNIQUE does not survive CRR retrofit).
- Non-PK merge cases use explicit select-then-update.

### 13.5 Secret isolation

- `.ade/local.secret.yaml` (API keys, ADE CLI configs), sync site ID, sync device ID, sync bootstrap token: **never sync**.
- Each device stores its own pairing secret in OS Keychain.
- Linear creds, GitHub tokens, provider API keys stay on the host.
- Commands from non-host devices validated and executed by the host only.

Related sync docs: [Sync and multi-device](./features/sync-and-multi-device/README.md), [iOS companion](./features/sync-and-multi-device/ios-companion.md), and [Remote commands](./features/sync-and-multi-device/remote-commands.md).

---

## 14. Build, Test, Deploy

### 14.1 Monorepo layout

```
ADE/
├── apps/
│   ├── ade-cli/        # ADE runtime daemon (`ade serve`), `ade` CLI, `ade code` terminal client
│   ├── desktop/        # Electron client (multi-window; local + SSH-bound runtime bindings)
│   ├── ios/            # Native SwiftUI controller (WebSocket to runtime daemon)
│   └── web/            # Marketing + download landing (Vite + React)
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

### 14.2 CI (`.github/workflows/ci.yml`)

Stages:

1. **Install** (`install` job) — checkout, setup Node 22, parallel `npm ci` across desktop, ade-cli, and web with a shared cache keyed on those lockfiles.
2. **Parallel checks**:
   - `secret-scan` — gitleaks on full history.
   - `typecheck-desktop` — `cd apps/desktop && npm run typecheck`.
   - `typecheck-ade-cli` — `cd apps/ade-cli && npm run typecheck`.
   - `typecheck-web` — `cd apps/web && npm run typecheck`.
   - `lint-desktop` — ESLint on `src/**/*.{ts,tsx}`.
   - `test-desktop` — **8-way shard matrix**: `npx vitest run --shard=${{ matrix.shard }}/8` across shards 1–8.
   - `test-ade-cli` — full ade-cli vitest.
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
- **Redaction** — all log writes pass through `redactSecrets()` / `sanitizeStructuredData()`.
- **Retention** — local, indefinite until user clears.

### 15.2 Telemetry

- **IPC tracing** — every handler emits `ipc.invoke.begin` / `ipc.invoke.done` / `ipc.invoke.failed` with call ID, channel, window ID, duration, summarized args. Mandatory for new handlers.
- **Renderer lifecycle** — `renderer.route_change`, `renderer.tab_change`, `renderer.window_error`, `renderer.unhandled_rejection`, `renderer.event_loop_stall`. Mandatory for new surfaces that introduce novel lifecycle transitions.
- **Startup tasks** — `project.startup_task_enabled`, `project.startup_task_skipped`, `project.startup_task_begin`, `project.startup_task_done` with durations.
- **Usage tracking** — `usageTrackingService.ts` + `budgetCapService.ts` account for tokens and cost per provider/model/call-type; surfaced in the top-bar Usage popup (`HeaderUsageControl` → `UsageQuotaPanel` + collapsible `BudgetCapEditor`).
- **Local perf runs** — `scripts/perf-launch.mjs` / `scripts/run-perf-scenario.mjs` launch ADE with a run id, feed renderer scenarios, and collect JSONL events plus `summary.json` under `~/.ade/perf-runs/<runId>/`. This is local-only diagnostics, not external telemetry.
- **No external telemetry** — ADE does not ship analytics to any cloud service. All telemetry is local.

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
- **Sync telemetry** — `sync_cluster_state` + device registry surfaced in Settings → Sync.
- **Operation timeline** — `operationService.ts` + History page provide full audit trail for debugging and undo.
- **Shutdown sequence**:
  1. Stop head watcher + background timers.
  2. Dispose pollers and ingress services.
  3. Stop file watchers, tests, managed processes.
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
- Project dashboard / Run tab · [Project Home](./features/project-home/README.md)
- Lanes and Git isolation · [Lanes](./features/lanes/README.md)
- Agent chat · [Chat](./features/chat/README.md)
- Pull requests and queues · [Pull Requests](./features/pull-requests/README.md)
- Multi-device sync and iOS · [Sync and Multi-device](./features/sync-and-multi-device/README.md)
- Terminal sessions and Work · [Terminals and Sessions](./features/terminals-and-sessions/README.md)
- Computer-use proof · [Computer Use](./features/computer-use/README.md)
- Deeplinks · [Deeplinks](./features/deeplinks/README.md)
- Settings and onboarding · [Onboarding and Settings](./features/onboarding-and-settings/README.md)
- Feature index · [features/](./features/)

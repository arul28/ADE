# ADE Remote Runtime Architecture — Implementation Specification

## 0. Purpose of This Document

This is the engineering spec for the next major architecture shift in ADE: extracting the runtime from the desktop process, making it multi-project, and adding remote-machine support over SSH. It captures every decision we have made, the rationale behind each, the audit findings of the current codebase that the decisions are grounded in, and a concrete phased implementation plan with file-level detail.

It is intended to be sufficient for a dev team to execute without further architectural debate. Where decisions were made, they are stated as decisions, not options. Where decisions were deferred, they are explicitly listed in the Non-Goals section.

No timelines are included; sequencing is captured as phase ordering and parallelization tracks.

---

## 1. Executive Summary

### What we are building

A unified, always-on ADE runtime ("ade") that:
- Runs as a single per-machine background daemon, managing N projects on that machine.
- Can run on the user's local machine, a Mac Studio, an AWS VPS, a Cloudflare VM, or any always-on Unix host accessible via SSH.
- Is connected to by all three UI surfaces (Desktop, Mobile, TUI), each treated as a thin client.
- Allows the desktop and TUI to address remote runtimes via SSH-tunneled JSON-RPC, with the runtime binary auto-uploaded to the remote on first connect (the "Cursor Server" / VS Code Remote-SSH model).

### Why

Three motivations:

1. **Always-on agents.** Long-running agent runs should not die because the user closed their laptop or the desktop app crashed.
2. **Heterogeneous compute.** Users want to run agents on a beefy Mac Studio at home or a cloud VPS while controlling them from a thin laptop client. Cursor's Background Agents demonstrate the demand.
3. **Mobile parity.** The mobile app today is conceptually tied to "the desktop app." Once the runtime is a separable thing, mobile becomes a peer client of any runtime — local or remote — without architectural change.

### The three big shifts

1. **Runtime extraction.** The Electron desktop app no longer hosts the runtime in-process. The runtime is `apps/ade-cli`, run as a separate process. Desktop becomes a thin client of its own local runtime.
2. **Multi-project unified runtime.** A single runtime instance manages all projects on its host machine. The protocol envelope carries a `projectId`. The user mental model becomes "I have one machine, on which I have many projects," not "I have many runtimes, one per project."
3. **SSH-tunneled remote runtime.** Desktop (and TUI) can connect to a runtime running on a different machine over SSH stdio, using the same JSON-RPC protocol as for the local runtime. Static binaries are auto-uploaded to remotes on first connect.

---

## 2. Current State (Audit Findings)

These are the facts about today's codebase that the design is grounded in. They were established by three parallel investigation agents and are referenced throughout the rest of this spec.

### 2.1 Repo structure

`/home/user/ADE/apps/`:
- `apps/desktop` — Electron app. Main process currently *is* the runtime. Renderer is a normal React app.
- `apps/ade-cli` — Standalone Node.js runtime + JSON-RPC server (~550 KB compiled). No Electron deps.
- `apps/ade-code` — React Ink TUI. Separate package today; connects to a desktop's RPC socket OR embeds ade-cli in-process.
- `apps/ios` — Swift/iOS app. Connects to desktop's WebSocket sync server over mDNS+QR pairing.
- `apps/web` — Minimal Vite/React surface. Limited integration.

No top-level monorepo manager (no `pnpm-workspace.yaml`). Cross-package imports use relative paths.

### 2.2 What's already in place that helps us

- **`apps/ade-cli/src/bootstrap.ts` exposes `createAdeRuntime()`** that instantiates ~40 of the ~88 services the desktop has. This is the existing "core" we are formalizing.
- **`apps/ade-cli/src/jsonrpc.ts` defines `JsonRpcTransport`** as a 3-method interface (`onData`, `write`, `close`). Already pluggable — works with Unix socket, TCP, and is trivial to extend to stdio for SSH.
- **`apps/desktop/src/renderer/` is fully Electron-agnostic.** Zero `ipcRenderer` or `window.electron` references. Talks through a typed `window.ade` bridge that is wired by preload script in Electron and stubbed by `browserMock.ts` outside it. Renderer requires zero changes when we move the backend.
- **Sync layer (`apps/desktop/src/main/services/sync/*`) has zero `electron` imports.** Already headless-compatible. Can move to `ade-cli` mechanically.
- **Bonjour/mDNS uses `bonjour-service` (pure Node).** Works in headless processes. Tailscale `serve` fallback already exists.
- **Mobile pairing protocol is host-agnostic.** Multiple runtimes coexist on a network as distinct mDNS instances distinguished by `deviceId` in TXT records.
- **Desktop already bundles `ade-cli` via electron-builder `extraResources`.** Wrapper scripts (`apps/desktop/scripts/ade-cli-{macos,windows}-wrapper.{sh,cmd}`) put `ade` on the user's PATH.

### 2.3 What's tangled today

- The desktop main process instantiates ~88 services; ade-cli's `bootstrap.ts` instantiates ~40. The 40-45 service gap is the runtime services that haven't yet been pulled into the shared runtime.
- Only **2-3 services use Electron APIs directly** — `linearCredentialService` and `apiKeyStore` use `safeStorage`; `feedbackReporterService` uses `BrowserWindow`; `builtInBrowserService` is wholly Electron. Everything else uses plain Node.
- **IPC surface is 687 channels** in `apps/desktop/src/main/services/ipc/registerIpc.ts` (~10,240 LOC). The JSON-RPC surface is ~60-80 methods. **They are not isomorphic.** IPC includes window management, clipboard, dialogs, keybindings, progress event subscriptions — UI concerns that have no place on a wire protocol. RPC is a strict subset focused on runtime operations.
- Today every ade-cli is bound to one `projectRoot` at construction time. `.ade/` directories are project-scoped. Services hold `projectRoot` for their lifetime. Multi-project support requires reorganizing service ownership inside the runtime.

### 2.4 Native dependencies in ade-cli

- `node-pty` ^1.1.0 (native, prebuilds for darwin-{arm64,x64}, linux-{arm64,x64})
- `sql.js` ^1.13.0 (pure JS + WASM)
- `@cursor/sdk` ^1.0.9 (has platform-specific variants — see desktop's electron-builder `asarUnpack`)
- `node-cron`, `yaml` (pure JS)

`onnxruntime-node` is desktop-only (used for embeddings). It is **not** in `ade-cli/package.json` and will **not** be bundled into the static remote binary in v1. See Non-Goals.

### 2.5 Sync layer specifics

- `apps/desktop/src/main/services/sync/syncHostService.ts` (~3,000 LOC): WebSocket on `0.0.0.0:8787` (auto-bumps to 8788, 8789 on collision). Raw WS, max 25 MB payload.
- `syncRemoteCommandService.ts` (~2,500 LOC): registry of 181 remote command actions across categories (lanes, work/chat, git, prs, cto, files/processes).
- Pairing: bootstrap token (`.ade/secrets/sync-bootstrap-token`), QR + PIN flow, paired device registry (`sync-paired-devices.json`).
- Message envelope: JSON wrapper, gzip when payload ≥ 4 KB.
- CRDT changesets streamed via cr-sqlite `db.sync.exportChangesSince()` polling at ~400 ms.

---

## 3. Target Architecture

### 3.1 Conceptual model

> **Every UI is a thin client. The only thing that holds state is the runtime. The runtime can live on your laptop, your Mac Studio, or a VPS — the same binary, the same protocol.**

A "remote target" in the desktop UI is just a registered location where a runtime lives. Lanes, worktrees, agent processes, sync servers all live where the runtime lives. The desktop / TUI / mobile UI is a *view* over that runtime's state.

### 3.2 Process model on a single machine

Per host:

```
                  ┌───────────────────────────┐
                  │   ade (runtime daemon)    │
                  │   — managed by launchd /  │
                  │     systemd user unit     │
                  │   — listens on Unix sock  │
                  │   — listens on WS 8787    │
                  │   — broadcasts mDNS       │
                  │   — manages N projects    │
                  └─────────────┬─────────────┘
                                │
        ┌───────────────┬───────┴───────┬────────────────┐
        │               │               │                │
   ┌────▼────┐    ┌─────▼────┐    ┌─────▼────┐    ┌──────▼─────┐
   │ Desktop │    │  TUI     │    │  Mobile  │    │ External   │
   │ (UNIX   │    │ (UNIX    │    │ (WS over │    │ JSON-RPC   │
   │  sock)  │    │  sock)   │    │  LAN /   │    │ clients    │
   │         │    │          │    │  Tailsc.)│    │            │
   └─────────┘    └──────────┘    └──────────┘    └────────────┘
```

### 3.3 Process model with a remote target

When the desktop targets a remote runtime:

```
   Local machine                       Remote machine (Mac Studio / VPS)
   ┌───────────────┐                   ┌──────────────────────────────┐
   │ Desktop UI    │                   │ ade (runtime daemon)         │
   │               │   SSH stdio       │ — spawned by SSH on demand   │
   │ JSON-RPC ─────┼───────────────────┼─→ JSON-RPC handler           │
   │ client        │                   │ — same protocol, same code   │
   └───────────────┘                   └──────────────────────────────┘
```

The local runtime daemon and the remote runtime daemon are the **same binary running with different invocations**:
- Local: `ade serve` (managed by launchd/systemd, Unix socket + WS)
- Remote: `ade rpc --stdio` (spawned over SSH, stdio JSON-RPC only)

### 3.4 Project model

A runtime maintains a **project registry**: a list of `(projectId, projectRoot)` pairs known to that runtime. Each project has its own `.ade/` directory inside its root. Service trees are instantiated lazily per-project on first reference.

Every JSON-RPC request and every sync WS message carries a `projectId` (or omits it for runtime-level operations like "list projects"). Clients pick which project they are operating on; the runtime routes accordingly.

### 3.5 Tab / window model on the desktop

Each desktop window or tab holds a single `(runtime, projectId)` binding established at the moment the user opens or connects. Switching projects or runtimes within an existing tab is **not supported**; the user opens a new tab. Multiple tabs can independently target the same project on different runtimes (e.g. local + Mac Studio copies of `myapp`). They are unrelated from ADE's perspective; reconciliation happens via normal git.

---

## 4. Architectural Decisions (Numbered, with Rationale)

These are the decisions made during design. They are not up for re-debate during implementation; if a constraint surfaces that requires revisiting one, escalate.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Unified per-machine runtime managing multiple projects.** Single ade-cli process per host. Project-id in protocol envelope. Lazy per-project service trees. | Matches user mental model ("I have one Mac Studio, not five"). One pairing per machine for mobile. Lower process overhead. |
| D2 | **Desktop becomes a thin client.** Electron main process spawns or attaches to a local runtime daemon via Unix socket. Renderer unchanged. | Renderer is already Electron-agnostic. The IPC façade can route runtime calls to the daemon transparently. Avoids future divergence between local and remote behaviour. |
| D3 | **SSH-tunneled JSON-RPC for remote runtime.** Desktop opens an `ssh user@host ade rpc --stdio` channel; speaks existing JSON-RPC over the SSH stdio. | Reuses pluggable transport. No new server. Auth piggy-backs on SSH. Works for any always-on host accepting SSH. Cursor / VS Code Remote-SSH model. |
| D4 | **Static binary, auto-uploaded on first connect.** Per-platform `ade` binaries built via Node SEA. Desktop detects remote arch via `uname -sm`, scp's the matching binary to `~/.ade/bin/` on first connect. | "Cursor Server" UX. User installs nothing on the remote. We pin the runtime version. Upgrade = replace one file. |
| D5 | **Run-as-SSH-user identity model.** Agent on the remote runs as the user that SSH'd in. No dedicated `ade` user, no sandboxing in v1. | Same authority as if the user SSH'd in by hand. Predictable blast radius. Sandboxing delegated to standard Unix permissions. |
| D6 | **Auto-start runtime on user login as a system service** (launchd user agent / systemd user unit / Windows equivalent). Setting to disable, default ON. | Required for "phone connects any time without desktop open" and "agents survive desktop crashes." Standard pattern (Docker Desktop, Tailscale). |
| D7 | **Any UI spawns a runtime if none is running.** Desktop, TUI, etc. detect missing daemon and start one transparently. | Robustness when the user has disabled auto-start or killed the daemon. No user-facing "runtime offline" errors. |
| D8 | **One installer ships everything.** Desktop installer registers the launchd/systemd service and puts `ade` on PATH. Standalone CLI installer (`brew`, `curl \| sh`) ships the same `ade` binary for headless / VPS users. | Same binary, two install paths. Required for SSH bootstrap (we need standalone binaries to upload). |
| D9 | **Single CLI surface — `ade` with subcommands.** `ade code` launches TUI; `ade serve` runs daemon foreground; `ade rpc --stdio` is SSH transport mode; existing `ade lanes`/`ade prs` etc. unchanged. The `ade-code` package is merged into `ade-cli`. | One command surface, less user confusion. Mirrors `git`, `cargo`, `gh`, OpenCode. Lazy-load Ink/React only when `ade code` runs. |
| D10 | **Silent runtime updates.** Desktop update brings a newer bundled binary. On launch, desktop signals running daemon to shut down, daemon exits, desktop spawns new daemon. No user prompt. Same for remote: on connect, if remote binary < bundled, upload + restart silently with a small status pill in connection UI. | User updates the app expecting everything to update. No "do you want to update?" interruptions during deep work. |
| D11 | **Multi-project: project-id in protocol envelope from day one.** Don't ship per-project runtime first and migrate later. | Migrating mid-flight breaks mobile clients. The protocol decision is foundational, not optional. |
| D12 | **Model A only in v1: project lives where the runtime lives.** Remote target = project lives on the remote machine. No "send this chat to remote, run on my exact local state" flow. | Per-chat dispatch (Cursor Background Agents) requires either ephemeral branches (which the user explicitly rejected) or real-time file sync (huge feature). Out of scope for this spec. |
| D13 | **Detect-and-surface for agent CLI auth.** Don't proxy OAuth. When `claude` / `codex` / etc. is missing or unauthenticated on a remote, render an inline error card with "Install" and "Authenticate" buttons. Auth opens a terminal pane that runs the CLI's own login command over SSH; user completes the device-code flow in their local browser. | Agent CLI auth is the CLI's problem, not ours. Trying to proxy OAuth is an indefinite project. v1 surfaces the error well; that's enough. |
| D14 | **Mobile sees only network-reachable runtimes (LAN + Tailscale-extended).** No SSH transport on mobile. NAT traversal is a documentation problem (Tailscale recommendation), not infrastructure we operate. | SSH from a phone is bad UX. The actual underlying need is reachability, which Tailscale solves. |
| D15 | **Branch-name collision: not our problem.** Two runtimes pushing lanes targeting the same upstream branch is treated like two devs collaborating on the same branch — git handles it. | Avoids inventing a new naming convention or coordination protocol. |
| D16 | **No memory/embedding features on remote runtimes in v1.** `onnxruntime-node` not bundled in the static remote binary. Memory tab features unavailable when the active runtime is remote. | onnxruntime is ~100 MB and the largest single packaging cost. v1 ships smaller, faster. Reintroduce later if demand justifies. |
| D17 | **Local-vs-remote uncommitted work warning.** When opening a project on a remote runtime, if the local runtime has the same project (matched by `git remote get-url origin`) with uncommitted changes, show a small dialog: *"Your local copy has uncommitted work. Push first, or your remote work will be on different code."* | Cheap to implement, real value, prevents confusion. |
| D18 | **One-time migration on the next release.** No backwards-compat shims for old behaviour beyond that. The first release after this lands installs the daemon, migrates state, and from then on the new architecture is the only architecture. | We have few enough users that we don't need long-tail compatibility. Subsequent releases are normal updates. |

---

## 5. Implementation Phases

Phases are ordered by dependency. Within a phase, tasks can be parallelized along the tracks listed in section 13.

### Phase 1 — Runtime extraction + multi-project foundation

**Goal:** A single `ade-cli` process can serve multiple projects and exposes the full runtime feature surface. The desktop continues to embed it for now (the process split happens in Phase 2).

### Phase 2 — Desktop and sync become clients of the runtime

**Goal:** The desktop runs `ade serve` as a child or attached daemon and routes runtime IPC through JSON-RPC. The sync WebSocket lives in the runtime, not the Electron process. The launchd/systemd service is registered. Mobile sees runtimes regardless of whether the desktop is open.

### Phase 3 — SSH transport + remote machine support

**Goal:** Users can register remote machines, the desktop auto-uploads the runtime binary on first connect, and lanes can be opened on remote runtimes.

### Phase 4 — Mobile UI updates for remote runtimes

**Goal:** Mobile UX reflects the multi-runtime, machine-first model. (Most of the protocol work is already in place from Phase 1+2; this is mostly UI/copy.)

---

## 6. Phase Details

### Phase 1 — Runtime extraction + multi-project

#### 1.1 Move the missing services into ade-cli

**Files to move (or import into ade-cli's bootstrap):**

The 40-45 services currently in `apps/desktop/src/main/services/` that are not yet in `apps/ade-cli/src/bootstrap.ts`. Notable ones:

- `services/lanes/laneEnvironmentService.ts`, `laneTemplateService.ts`, `laneWorktreeLockService.ts` (last is partially shared)
- `services/lanes/portAllocationService.ts`, `laneProxyService.ts`, `oauthRedirectService.ts`, `runtimeDiagnosticsService.ts`
- `services/git/rebaseSuggestionService.ts`, `autoRebaseService.ts`
- `services/prs/prPollingService.ts`, `pathToMergeOrchestrator.ts` (consolidate; both ade-cli and desktop have versions)
- `services/automation/*` (automationSecretService, automationIngressService — bring into ade-cli)
- `services/missions/missionPreflightService.ts`, `sessionDeltaService.ts`
- `services/memory/embeddingService.ts`, `embeddingWorkerService.ts`, `hybridSearchService.ts`, `memoryLifecycleService.ts`, `memoryBriefingService.ts`, `missionMemoryLifecycleService.ts`, `episodicSummaryService.ts`, `humanWorkDigestService.ts`, `proceduralLearningService.ts`, `knowledgeCaptureService.ts`, `skillRegistryService.ts` — desktop-only in v1 (see D16); not moved, but their interfaces should be defined so the desktop can keep them while remote runtimes simply don't expose memory RPC methods.
- `services/cto/openclawBridgeService.ts`
- `services/github/githubPollingService.ts`
- `services/usage/usageTrackingService.ts`, `services/budget/budgetCapService.ts`
- `services/agents/agentToolsService.ts`
- `services/projects/projectScaffoldService.ts`
- `services/feedback/feedbackReporterService.ts` — split into runtime-side "submit feedback" and desktop-side "focus window after submit"

For each: move the file (or, if the file imports anything Electron-only, refactor to remove the import and inject the dependency from the desktop shell instead), update `apps/ade-cli/src/bootstrap.ts` to instantiate it, expose the relevant RPC methods in `apps/ade-cli/src/adeRpcServer.ts`.

**Services that stay in `apps/desktop/src/main/`:**
- `services/updates/autoUpdateService.ts`
- `services/builtInBrowser/*`
- `services/onboarding/onboardingService.ts`
- `services/keybindings/keybindingsService.ts`
- `services/devtools/devToolsService.ts`
- `services/notifications/apnsService.ts`, `apnsKeyStore.ts`, `notificationEventBus.ts` (mostly — runtime side handled by sync; APNs key management stays desktop-side)
- Native menu / tray / deep-link handlers in `apps/desktop/src/main/main.ts`

#### 1.2 Abstract Electron API usage

Three known sites:

- `apps/desktop/src/main/services/cto/linearCredentialService.ts:4` and `apps/desktop/src/main/services/ai/apiKeyStore.ts` use Electron `safeStorage`.
- `apps/desktop/src/main/services/feedback/feedbackReporterService.ts:2` imports `BrowserWindow`.
- `apps/desktop/src/main/services/builtInBrowser/*` — wholly Electron, stays.

Introduce a credential-store interface in `apps/ade-cli/src/services/credentials/`:

```
interface CredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

Implementations:
- `KeytarCredentialStore` — uses `keytar` package; works on macOS/Windows/Linux with a keyring daemon present.
- `EncryptedFileCredentialStore` — `~/.ade/secrets/credentials.json.enc`, AES-GCM with a per-machine key stored mode-600 in `~/.ade/secrets/.machine-key`. Used on headless Linux servers / VPSes without a keyring.
- `ElectronSafeStorageCredentialStore` — desktop-only wrapper around Electron `safeStorage`. Constructed from inside the Electron main process and either passed into the local runtime via IPC or replaced once the runtime is split out.

The credential interface is owned by the runtime. The desktop hands it the `safeStorage` impl while embedded; after Phase 2 the runtime picks keytar or encrypted-file based on platform detection.

`feedbackReporterService` is split: the runtime exposes a `feedback.submit` RPC method; the desktop adds a small wrapper that calls it and then handles the post-submit Electron focus.

#### 1.3 Project registry inside the runtime

New module: `apps/ade-cli/src/services/projects/projectRegistry.ts`.

Schema:

```
type ProjectId = string; // stable, derived from absolute path hash

interface ProjectRecord {
  projectId: ProjectId;
  rootPath: string;
  displayName: string;        // last path segment, editable
  addedAt: number;
  lastOpenedAt: number;
  gitOriginUrl: string | null; // for D17 matching
}
```

Persistence: `~/.ade/projects.json` (machine-scoped, NOT per-project). Atomic writes.

Operations exposed via JSON-RPC:
- `projects.list()` → `ProjectRecord[]`
- `projects.add({ rootPath })` → creates `.ade/` if missing, registers, returns record.
- `projects.remove({ projectId })` — does NOT delete `.ade/` from disk; just deregisters.
- `projects.touch({ projectId })` — updates `lastOpenedAt`.

#### 1.4 Per-project service-tree caching

New module: `apps/ade-cli/src/services/projects/projectScope.ts`.

Pattern:

```
class ProjectScope {
  // lazy-init per project
  readonly laneService: LaneService;
  readonly prService: PrService;
  readonly orchestratorService: OrchestratorService;
  readonly chatService: AgentChatService;
  // ... etc
}

class ProjectScopeRegistry {
  private scopes = new Map<ProjectId, ProjectScope>();
  get(projectId: ProjectId): ProjectScope { /* lazy create */ }
  async dispose(projectId: ProjectId): Promise<void> { /* drain + close */ }
}
```

Service constructors that currently take `projectRoot` get refactored to take it from the `ProjectScope` they belong to. Truly cross-project services (credential store, project registry, GitHub client, sync host, machine identity) live at runtime scope, not project scope.

#### 1.5 JSON-RPC envelope change

Add `projectId?: string` to the JSON-RPC request envelope. Update:

- `apps/ade-cli/src/jsonrpc.ts` — pass `projectId` through to handler.
- `apps/ade-cli/src/adeRpcServer.ts` — handler checks: if method is project-scoped, look up the scope from `ProjectScopeRegistry`; if runtime-scoped (e.g. `projects.list`), no scope lookup.
- `apps/ade-code/src/jsonRpcClient.ts` and any other client — accept `projectId` in `call()` options.

Method classification (every method gets one of these tags in the registry):
- `runtime` — e.g. `projects.*`, `auth.*`, `machineInfo.*`. No projectId required.
- `project` — e.g. `lanes.*`, `prs.*`, `chat.*`. ProjectId required; error if missing.

#### 1.6 CLI surface unification

Merge `apps/ade-code` into `apps/ade-cli`:

- Move `apps/ade-code/src/*` to `apps/ade-cli/src/tuiClient/`.
- Update `apps/ade-cli/package.json` to add `ink`, `ink-text-input`, `react`, `@types/react` as dependencies.
- Add CLI subcommand routing in `apps/ade-cli/src/cli.ts`:
  - `ade` (no args) → `ade code` in current dir
  - `ade code` → launch TUI (lazy-import `./tuiClient/`)
  - `ade serve [--port N] [--socket PATH]` → run runtime daemon foreground
  - `ade rpc --stdio` → SSH transport mode (read RPC on stdin, write on stdout, exit when stdin closes)
  - `ade init [path]` → register a project with the local runtime
  - `ade doctor` → diagnostics (already exists)
  - existing scripting subcommands (`ade lanes`, `ade prs`, etc.) remain
- Update `apps/ade-cli/package.json` `bin` to expose only `ade`. Drop `ade-code` from the desktop wrapper scripts.
- Update `apps/desktop/scripts/ade-cli-{macos,windows}-wrapper.{sh,cmd}` to be aware of subcommands (no functional change — wrappers just exec the binary with whatever args came in).

#### 1.7 Phase 1 acceptance criteria

- [ ] `ade serve` launches a standalone daemon that exposes the full RPC method set on a Unix socket.
- [ ] `ade code` connects to it (or auto-spawns one if not running) and works the same as `ade-code` does today.
- [ ] `projects.list` returns a registry with at least one project (after `ade init`).
- [ ] All RPC methods either route by `projectId` or are explicitly runtime-scoped.
- [ ] No service in `apps/ade-cli/` imports `electron`.
- [ ] All existing tests pass.

---

### Phase 2 — Desktop becomes a client + sync moves to runtime

#### 2.1 Spawn the daemon from desktop

In `apps/desktop/src/main/main.ts`:
- On startup, attempt to connect to the runtime via `~/.ade/sock/ade.sock` (path resolved by `apps/desktop/src/shared/adeLayout.ts`).
- If connection fails (no daemon running): spawn `ade serve` as a child process, wait for the socket, then connect.
- If the launchd/systemd service is registered and running, `ade serve` is already running and connect succeeds immediately.

Clean up the existing in-process service instantiation in `main.ts`. Replace with a `RuntimeRpcClient` that wraps `JsonRpcClient` and exposes typed methods to the rest of the desktop main process.

#### 2.2 IPC façade rewrite

`apps/desktop/src/main/services/ipc/registerIpc.ts` (10,240 LOC) needs systematic rewriting:

- Each `ipcMain.handle("foo", ...)` channel that maps to a runtime operation becomes:
  ```
  ipcMain.handle("foo", async (event, args) => {
    return runtimeClient.call("foo_rpc_method", { projectId: getCurrentProject(event), ...args });
  });
  ```
- Pub/sub event subscriptions (where main pushes events to renderer): the renderer subscribes via a new `runtimeEvents.subscribe(...)` RPC that streams via JSON-RPC notifications back through the IPC bridge.
- UI-only channels (clipboard, keybindings, dialogs, window management) stay as-is — they never round-trip through the runtime.

Suggested file structure after refactor:
- `apps/desktop/src/main/ipc/runtimeBridge.ts` — handles RPC-bound channels (auto-generated where possible from a method registry)
- `apps/desktop/src/main/ipc/uiBridge.ts` — handles UI-only Electron-native channels
- `apps/desktop/src/main/ipc/registerIpc.ts` — orchestrator that wires both

#### 2.3 Sync server moves into the runtime

Move `apps/desktop/src/main/services/sync/` to `apps/ade-cli/src/services/sync/`. The whole directory has zero Electron imports per audit; this is a file move.

Adjustments:
- `syncRemoteCommandService.ts` constructor receives runtime services from the runtime's bootstrap, not the desktop's `AppContext`. Wiring change in `apps/ade-cli/src/bootstrap.ts`.
- `syncHostService.ts` mDNS publishing now identifies the *runtime* as the host. TXT records add a `projects` field listing project IDs the runtime can serve (for mobile UI to enumerate). Keep `deviceId` as the stable host identity.
- Pairing secrets (`sync-paired-devices.json`) move from per-project `.ade/secrets/` to per-machine `~/.ade/secrets/`. Pairing is now machine-scoped, not project-scoped. **This is a migration path** — see Section 7.
- The 181-action command registry needs project-scoped routing: each command in `syncRemoteCommandService.ts` declares whether it's `runtime` or `project` scope; project-scoped commands require the message envelope to carry `projectId`.

#### 2.4 Daemon registration on first run

New module: `apps/ade-cli/src/serviceManager/`:
- `installLaunchd.ts` (macOS): writes `~/Library/LaunchAgents/com.ade.runtime.plist`, runs `launchctl load`.
- `installSystemd.ts` (Linux): writes `~/.config/systemd/user/ade-runtime.service`, runs `systemctl --user enable --now`.
- `installWindows.ts`: registers a Scheduled Task with `OnLogon` trigger.

Triggered on:
- Desktop first launch after upgrade (idempotent — checks if already installed).
- `ade serve --install-service` invoked manually.

Uninstall handler (called from desktop uninstaller, where supported by platform).

#### 2.5 Local-vs-remote uncommitted warning (D17)

Implement in `apps/desktop/src/renderer/components/projects/RemoteProjectOpenDialog.tsx` (new file). Logic:
- When user picks "Open project on Mac Studio," desktop queries:
  - Local runtime: `projects.list()`, find any with matching `gitOriginUrl`.
  - For each match: `git.status({ projectId })` to detect uncommitted/unstaged work.
- If matches with dirty state exist, show a non-blocking dialog: *"Your local copy has uncommitted changes. Anything you do on Mac Studio will be on different code. Push first?"* with Continue / Cancel buttons.

#### 2.6 Phase 2 acceptance criteria

- [ ] Closing the desktop app does not stop the runtime daemon.
- [ ] Mobile can pair with a runtime that has no desktop app open.
- [ ] All 687 IPC channels behave identically to before (functional parity).
- [ ] launchd / systemd unit is registered on first launch and survives reboot.
- [ ] mDNS broadcasts include project list in TXT records.

---

### Phase 3 — SSH transport + remote machine support

#### 3.1 `ade rpc --stdio` mode

In `apps/ade-cli/src/cli.ts` — add the subcommand. Implementation in `apps/ade-cli/src/transports/stdioTransport.ts`:

```
const stdioTransport: JsonRpcTransport = {
  onData(callback) {
    process.stdin.on("data", chunk => callback(Buffer.from(chunk)));
  },
  write(data) { process.stdout.write(data); },
  close() { process.exit(0); },
};
startJsonRpcServer(handler, stdioTransport);
```

Plus a single-runtime constraint: `ade rpc --stdio` boots a runtime in-process for this session (no daemon, no service install). Disconnects → process exits. This is correct because each SSH connection wants its own runtime instance.

#### 3.2 SSH transport on the desktop side

New package or module: `apps/desktop/src/main/services/remoteRuntime/`.

Files:
- `sshTransport.ts` — uses `ssh2` package. Implements `JsonRpcTransport` interface, opens an exec channel running `ade rpc --stdio` on the remote, pipes data both ways.
- `remoteTargetRegistry.ts` — `~/.ade/secrets/remote-machines.json`: `{ name, hostname, sshUser, port, sshKeyPath, lastSeenArch, runtimeBinaryVersion, lastConnectedAt }`.
- `remoteBootstrap.ts` — first-connect flow:
  1. `ssh user@host uname -sm` → detect platform/arch.
  2. Check if `~/.ade/bin/ade` exists on remote and version-match it via `ade --version`.
  3. If missing or stale: `scp` the matching static binary from `apps/desktop/resources/runtime/ade-{platform}-{arch}` to `~/.ade/bin/ade`, `chmod +x`, retry version check.
  4. Spawn `ade rpc --stdio` over SSH, attach `JsonRpcClient`.
- `remoteConnectionPool.ts` — caches SSH connections, handles reconnect on transient failures.

Add `ssh2` to `apps/desktop/package.json` dependencies.

#### 3.3 Static binary build pipeline

New scripts under `apps/ade-cli/scripts/`:
- `build-static.mjs` — builds via Node SEA. Per-platform: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`.
- `package-native-deps.mjs` — bundles `node-pty` prebuilds and `@cursor/sdk` platform variants alongside the SEA binary.

CI changes:
- Add a job that builds all four platforms on each release tag.
- Upload artifacts named `ade-{platform}-{arch}` to GitHub Releases.
- Desktop's `electron-builder.yml` `extraResources` includes the four binaries from a `runtime/` folder; desktop's `prebuild` step downloads the matching release artifacts.

#### 3.4 Agent CLI auth UX (D13)

In renderer:
- New component: `apps/desktop/src/renderer/components/chat/AgentCliAuthCard.tsx`.
- Triggered when an agent run fails with the specific error patterns: `command not found`, `ENOENT`, `not authenticated`, `unauthorized`, etc. (Pattern matching in `apps/ade-cli/src/services/chat/agentChatService.ts` — return a structured error type instead of opaque string.)
- Card shows: agent name (`claude` / `codex`), error category (missing / unauthenticated), and one or two buttons:
  - **Install** → calls `remoteRuntime.runShell({ command: <official install command> })` and streams output to a terminal pane.
  - **Authenticate** → opens a terminal pane connected to the remote via SSH, runs the CLI's auth command (`claude /login` or equivalent), streams stdout/stderr. The user copies the device-code URL from that terminal and completes auth in their local browser.
- For **local** runtime, "Install" and "Authenticate" run via the local runtime's shell tool, not SSH.

A small registry in `apps/ade-cli/src/services/agentRegistry.ts`:

```
{
  claude: {
    installCommand: "curl -fsSL https://claude.ai/install.sh | sh",
    authCommand: "claude /login",
    notAuthErrorPatterns: [/not logged in/, /unauthorized/i],
  },
  codex: { ... },
}
```

#### 3.5 Desktop UI for remote targets

New screens:
- `apps/desktop/src/renderer/components/projects/HomePage.tsx` (existing, modify): adds "Connect to remote machine" button alongside "Open project."
- `apps/desktop/src/renderer/components/remoteTargets/RemoteTargetForm.tsx`: hostname, SSH user, optional port, optional key path. On submit triggers `remoteRuntime.connect()` which runs the bootstrap flow.
- `apps/desktop/src/renderer/components/remoteTargets/RemoteTargetList.tsx`: shows registered remotes + LAN-discovered runtimes (mDNS). Combined picker.
- Tab labels (existing tab system from #273) updated to show `<projectName> · <runtimeName>` where runtimeName is `local` or the remote's display name.

#### 3.6 Phase 3 acceptance criteria

- [ ] Adding a remote target with valid SSH credentials succeeds, uploads binary if needed, and reaches `projects.list()`.
- [ ] Opening a project on a remote runtime works end-to-end: lane creation, agent chat, git ops, PR creation.
- [ ] Disconnecting and reconnecting reattaches transparently (long-running missions resumed via existing checkpoint mechanism).
- [ ] Agent CLI missing-or-unauthenticated errors render the auth card; install + auth flows complete successfully on the remote.
- [ ] Static binaries are present in CI release artifacts for all four platforms.

---

### Phase 4 — Mobile UI updates

#### 4.1 Discovery list

`apps/ios/ADE/Services/SyncService.swift` already does the mDNS work and supports multiple runtimes. UI changes:
- The "available hosts" list label changes from "Desktops" to "Machines."
- Each entry displays: machine name, project list (now sourced from mDNS TXT record `projects` added in Phase 2.3, or from `projects.list` after pairing).
- A device's pairing entry persists per-machine (already does, via `deviceId`-keyed Keychain storage).

#### 4.2 Project picker after machine selection

New screen: after picking a machine, list its projects. User taps a project; that establishes the `(machine, projectId)` binding for the session.

#### 4.3 Copy/labels

Search-and-replace "desktop" → "machine" in user-visible strings. The presence indicator on the desktop app stays as a phone icon (showing "phone connected") — the user-facing copy reads "Phone connected to [machine name]" rather than referencing runtimes or sockets.

#### 4.4 Tailscale guidance

Add a Help screen entry: *"To use ADE Mobile away from your home network, install Tailscale on both your phone and your machine. Once both are on the Tailscale network, your machine will show up here just like it does at home."* No code change.

#### 4.5 Phase 4 acceptance criteria

- [ ] Mobile lists all reachable runtimes on the network with machine name + project count.
- [ ] Pairing flow per-machine, not per-desktop, works against a headless `ade serve`.
- [ ] All user-visible copy uses "machine," not "desktop" or "runtime."

---

## 7. Migration & Upgrade Path

### 7.1 One-time upgrade detection (D18)

When the desktop app launches the first version of itself that includes Phase 2:

1. Check for `~/.ade/secrets/` existence.
   - If absent: fresh install. Initialize state and register the daemon. Done.
   - If present: existing user. Run migration steps below.
2. Migrate paired devices: if `<projectRoot>/.ade/secrets/sync-paired-devices.json` exists for any project in the legacy registry, merge entries into `~/.ade/secrets/sync-paired-devices.json`. Each entry is keyed by `deviceId`, so deduplication is natural.
3. Migrate bootstrap token similarly: if any project has a `sync-bootstrap-token`, copy the first one found to `~/.ade/secrets/sync-bootstrap-token`. Subsequent project tokens become obsolete.
4. Build the project registry: walk legacy `recentProjects` from desktop config, register each path that still has a valid `.ade/` directory in `~/.ade/projects.json`.
5. Install the launchd/systemd service.
6. Show one-time onboarding: *"ADE now runs in the background. Your phone can connect any time, agents survive app restarts. (Disable in Settings.)"*
7. Write a marker file `~/.ade/.migrated-v2` so subsequent launches skip migration.

Subsequent updates: no migration logic runs, just normal app upgrades + silent runtime restart per D10.

### 7.2 Existing user state preservation

- `~/.ade/` per-user state — preserved.
- `<project>/.ade/` per-project state — preserved.
- `<project>/.ade/secrets/` — values migrated to `~/.ade/secrets/` then orphaned (legacy files left in place; not deleted, in case of rollback). On a subsequent release we can clean up.
- SQLite database (`~/.ade/ade.db`) — schema unchanged in this work; migration concerns are minimal.

### 7.3 If a user rolls back

Rollback to the prior desktop version: the legacy app reads its old config locations, which are still intact. The daemon may keep running (orphan process); a Settings option in the new version lets the user uninstall it manually if needed. Document this in release notes.

---

## 8. Installation Story

### 8.1 Desktop installer (mac/win/linux)

Same one-installer model as today. Adds:
- First-run hook registers the launchd/systemd/Task Scheduler entry (D6).
- One-time migration logic per Section 7 if upgrading from a pre-v2 ADE.
- The installer continues to bundle `ade` on PATH via existing wrapper scripts.

### 8.2 Standalone runtime installer

For headless users who don't want the desktop GUI:
- macOS/Linux: `brew install ade` (formula in a tap repo; ships the same `ade` binary built by CI).
- Linux: `curl -fsSL https://ade.dev/install.sh | sh` script; downloads platform-matched binary from GitHub Releases, places it in `/usr/local/bin/ade` (or `~/.local/bin/ade` if no root), registers systemd user unit if appropriate.
- Windows: Scoop bucket + manual installer.

This installer is also what the desktop's remote-bootstrap flow (Phase 3.2) effectively does over SSH, just non-interactive.

### 8.3 Per-platform notes

- **macOS notarization**: the static `ade` binary needs to be code-signed for distribution. Add notarization to the existing `apps/desktop/scripts/notarize-mac-dmg.mjs` flow, and a parallel pipeline for the standalone binary.
- **Linux**: prebuilt binaries should be statically linked against musl where possible to avoid glibc version drift on older distros.
- **Windows**: may require additional setup for `node-pty` ConPTY usage. Verify in CI.

---

## 9. CLI Surface (D9)

```
ade                          # Default: launch TUI in current directory (= ade code)
ade code [path]              # Launch TUI explicitly
ade serve [--port N]         # Run runtime daemon in foreground
                             #   --install-service registers launchd/systemd entry
                             #   --uninstall-service removes it
ade rpc --stdio              # SSH transport mode (read RPC on stdin, write on stdout)

ade init [path]              # Register project with local runtime; create .ade/ if missing
ade doctor                   # Diagnostics (existing)

ade lanes <subcmd>           # Existing scripting commands, unchanged
ade prs <subcmd>
ade missions <subcmd>
ade actions run <action>     # Existing escape hatch
ade mcp                      # Existing MCP stdio server

# Project-scoped commands accept --project <id-or-path> or auto-detect from cwd
```

The TUI (`ade code`) lazy-imports React and Ink; baseline `ade` invocation does not pay the load cost.

---

## 10. Protocol Changes

### 10.1 JSON-RPC envelope

Existing fields: `jsonrpc`, `id`, `method`, `params`.

Added field: `params.projectId?: string`. Methods declare in their registration whether they require it. The handler in `apps/ade-cli/src/adeRpcServer.ts` looks up the appropriate `ProjectScope` if required.

### 10.2 mDNS TXT records

Existing records (per audit): `version`, `deviceId`, `siteId`, `deviceName`, `port`, `host`, `addresses`, `tailscaleIp`, `tailscaleDnsName`.

Added: `projects` (CSV of project IDs known to the runtime), `runtimeVersion` (binary version), `runtimeKind` (`desktop-embedded`, `headless`, `remote-stdio` — for diagnostics only).

### 10.3 Sync WS message envelope

Existing envelope: `{ version, type, requestId, compression, payloadEncoding, payload, ... }`.

Added: `projectId` field (required for project-scoped command types, omitted for runtime-scoped). `syncRemoteCommandService.ts` routes by this field.

### 10.4 Pairing payload

QR pairing payload `SyncPairingQrPayload` already includes `hostIdentity`, `port`, `addressCandidates`. No change required; pairing is now machine-scoped, but the protocol payload is unchanged.

---

## 11. Authentication & Security

### 11.1 Local socket

`~/.ade/sock/ade.sock` permissions mode `0600`, owned by the user. Any local process owned by that user can connect (desktop, TUI, scripts). This is the model today.

### 11.2 SSH transport

Auth = SSH auth. Whatever `ssh2` would accept (key file, agent socket, password if the user really wants). No additional layer.

The remote's `~/.ade/bin/ade` and `~/.ade/` directory inherit the SSH user's permissions. The agent runs as the SSH user (D5).

### 11.3 Mobile pairing

Existing flow unchanged: bootstrap token + QR + PIN. Now machine-scoped instead of project-scoped (Phase 2.3).

### 11.4 Agent CLI auth (D13)

ADE never sees agent CLI credentials. The CLIs handle their own auth in their own config dirs. ADE only orchestrates the install + the auth invocation.

### 11.5 What's deliberately not in scope

- Per-project access control (one user pairing scoped to project subset).
- Audit logging of which user invoked which agent action.
- Multi-tenant remote machines.

These are reasonable v2 features but explicitly out for v1.

---

## 12. Known Risks & Gotchas

### 12.1 Native deps in the static binary

`node-pty` and `@cursor/sdk` ship as native modules. Node SEA supports asset injection but requires careful packaging (see `apps/desktop/scripts/after-pack-runtime-fixes.cjs` for the existing prebuilt-binary handling pattern; use as a reference).

`onnxruntime-node` is explicitly excluded from the remote binary (D16); the runtime gracefully degrades by not exposing memory-related RPC methods on remotes.

### 12.2 In-flight state across daemon restart

Silent updates (D10) require that an active agent run survives a daemon process restart. The orchestrator already supports mission-checkpoint resume, but **chat session state, PTY buffers, and in-flight tool calls** may not all persist today. **Per user direction, we are not implementing checkpoint-survives-restart in v1.** Active agent runs may be lost on update. Once user base grows, revisit and add a "drain to disk on shutdown" path. This is acceptable risk during the transition phase.

### 12.3 Multi-window state coherence

The merge from main brought multi-window scaffolding (#273). Each window holds its own `(runtime, projectId)` binding. State coherence between windows of the same `(runtime, projectId)` is handled by the existing CRDT layer (cr-sqlite). State across different `(runtime, projectId)` pairs is intentionally not synced.

### 12.4 mDNS visibility on cellular

Outside of LAN (or Tailscale-extended networks), mDNS does not reach. We document the Tailscale path; it is not an in-app feature.

### 12.5 Branch name collisions across runtimes (D15)

Two runtimes with copies of the same project may push lanes targeting the same upstream branch and collide on `git push`. Treated as a normal git collaboration concern. Surface git's own error message; do not invent prevention.

### 12.6 SSH key UX

First-connect requires a working SSH key chain. If the user has password-only auth, the bootstrap flow needs to handle prompting (or refuse with a clear error). Recommend keys; document setting up SSH key-based auth.

### 12.7 Long mDNS-instance-name collisions on same host

Existing behaviour: instance names include port suffix to disambiguate multiple runtimes on the same host (e.g. when a user has both desktop-embedded runtime and a separate `ade serve` running). Verify this still holds after Phase 2 when port allocation moves to runtime-scope.

### 12.8 Service install failure modes

If launchd/systemd registration fails (permissions, unsupported platform), fall back to "spawn-on-launch, die when last UI disconnects" mode. Surface a non-blocking notice in Settings.

---

## 13. Parallelization Tracks

The phases are sequential at a high level, but within them work can be split across the following independent tracks:

### Track A — Runtime extraction (Phase 1 core)

Owner-area: `apps/ade-cli/src/services/`, `apps/ade-cli/src/bootstrap.ts`, `apps/ade-cli/src/adeRpcServer.ts`.

Tasks: Move services 1.1, abstract Electron APIs 1.2, project registry 1.3, project-scope refactor 1.4, RPC envelope 1.5, CLI unification 1.6.

Dependencies: none. Can start immediately.

### Track B — Static binary build pipeline (independent)

Owner-area: `apps/ade-cli/scripts/`, CI workflows, release tooling.

Tasks: 3.3 in its entirety. Can be done in parallel with Tracks A and C; needs Track A's CLI shape (D9) finalized before producing artifacts.

Dependencies: Track A's package layout.

### Track C — Sync layer migration (Phase 2.3)

Owner-area: `apps/ade-cli/src/services/sync/` (new), `apps/desktop/src/main/services/sync/` (deletion), `apps/ade-cli/src/bootstrap.ts`.

Tasks: File move, dependency wiring, TXT-record additions, project-scope routing in `syncRemoteCommandService.ts`.

Dependencies: Track A's project registry and project-scope abstractions exist.

### Track D — Desktop IPC façade rewrite (Phase 2.1, 2.2)

Owner-area: `apps/desktop/src/main/services/ipc/`, `apps/desktop/src/main/main.ts`.

Tasks: Daemon spawning, RPC client integration, mass-rewrite of IPC handlers to RPC dispatchers, separation of UI-only vs runtime channels.

Dependencies: Track A's RPC method set is stable. Can prototype against an embedded runtime; switch to spawned daemon when both are ready.

### Track E — Service manager (Phase 2.4)

Owner-area: `apps/ade-cli/src/serviceManager/` (new).

Tasks: launchd, systemd, Windows Task Scheduler integration. Uninstall hooks. Migration logic (Section 7).

Dependencies: none for the platform integration code; Section 7 migration depends on Track C completion.

### Track F — SSH transport (Phase 3.1, 3.2)

Owner-area: `apps/ade-cli/src/transports/stdioTransport.ts` (new), `apps/desktop/src/main/services/remoteRuntime/` (new).

Tasks: stdio transport in ade-cli, ssh2-based transport in desktop, target registry, bootstrap flow, connection pool.

Dependencies: Track A (`ade rpc --stdio` subcommand exists), Track B (binaries to upload).

### Track G — Desktop UI (Phase 3.5)

Owner-area: `apps/desktop/src/renderer/components/`.

Tasks: HomePage modification, RemoteTargetForm, RemoteTargetList, tab labels, AgentCliAuthCard.

Dependencies: Track F's `remoteTargetRegistry` types and bootstrap flow defined.

### Track H — Mobile UI updates (Phase 4)

Owner-area: `apps/ios/`.

Tasks: discovery list copy, project picker, Tailscale help screen.

Dependencies: Track C completion (TXT records include project list).

### Track I — Documentation

Owner-area: `docs/`.

Tasks: User-facing guides — installing, adding remote machine, Tailscale setup for mobile, agent CLI auth troubleshooting. Internal docs — daemon lifecycle, transport architecture, project model. Update existing `docs/ARCHITECTURE.md`.

Dependencies: none; can shadow each track and write docs as the relevant code lands.

### Recommended initial parallelization

Phase 1 work fans out across A, B, I in parallel from day one.
Phase 2 work (C, D, E) starts as soon as A is far enough along that the RPC method set and project model are stable.
Phase 3 work (F, G) starts as soon as B has buildable artifacts and A's stdio mode is in place.
Phase 4 work (H) starts after C completes.

---

## 14. Explicit Non-Goals (v1)

These are valuable features that are deliberately out of scope:

1. **Cloud-agent / per-chat dispatch (Cursor Background Agents).** Sending one chat in an otherwise-local lane to a remote machine to run on the same exact code state. Requires file sync infrastructure or ephemeral branches. Revisit as a separate feature.
2. **Mobile direct SSH.** Mobile only sees network-reachable runtimes. NAT traversal is documented Tailscale.
3. **Memory / embeddings on remote runtimes.** `onnxruntime-node` not in static binary. Memory features unavailable when active runtime is remote.
4. **Cross-machine project federation.** No "show me all my projects across all my runtimes" aggregate view. User picks a runtime, sees its projects.
5. **Multi-tenant remote machines.** Run-as-SSH-user only. No per-ADE-user separation when multiple humans share a remote.
6. **Branch collision protection.** Treated as a git-level concern.
7. **Per-project access control on a runtime.** A paired device sees all projects on that runtime.
8. **In-flight agent run survival across daemon restart.** Drain-to-disk path deferred. Active runs may be lost on update during this transition.
9. **Audit logging.** No structured logs of which user did what on which remote.
10. **Runtime auto-update without app update.** Runtime version is tied to desktop version. Headless users update via brew/curl manually.

---

## 15. Acceptance / Definition of Done

For the v1 release shipping this work:

### End-to-end scenario 1 — Local refactor invisible to user
- User upgrades desktop from pre-v2 to v2.
- One-time onboarding modal appears.
- User opens an existing project — works identically to before.
- User closes desktop — daemon is still running.
- User reopens desktop — reattaches to same daemon, same state.
- All existing tests pass; manual smoke covers lane creation, agent chat, git operations, PR creation.

### End-to-end scenario 2 — Mobile reaches runtime without desktop
- User closes desktop.
- User opens mobile app on the same Wi-Fi.
- Discovery shows the user's machine with project list.
- User pairs (one-time QR) and opens a project.
- Mobile chat works, lane operations work.

### End-to-end scenario 3 — Remote target via SSH
- User adds Mac Studio as a remote target (hostname, SSH user, key).
- First connect: desktop detects arch, uploads `ade-darwin-arm64`, version-checks, succeeds.
- User opens a project that exists on Mac Studio.
- Lane creation, agent chat, git operations all succeed against the Mac Studio runtime.
- User closes desktop. SSH connection drops. Long-running mission keeps running on Mac Studio (visible via `ssh user@mac-studio ade lanes list`).
- User reopens desktop, reconnects. Mission status reflects progress made while disconnected.

### End-to-end scenario 4 — Agent CLI not authenticated on remote
- User connects to a fresh VPS, opens a project.
- User sends a chat in a lane.
- Desktop renders the auth card with **Install** and **Authenticate** buttons.
- Install runs successfully via terminal pane; auth runs successfully via terminal pane (user completes device code flow in local browser).
- Subsequent chat completes normally.

### End-to-end scenario 5 — Three UIs on one runtime
- User has desktop open on their MacBook.
- User opens TUI in a terminal on the same MacBook (`ade code`).
- User opens mobile app, paired with the MacBook runtime.
- All three reflect the same lane state, the same chat history, in real time as edits happen.
- Closing any one of them does not disrupt the others.

---

## 16. Open Implementation Questions

Items that may surface during development and need a call:

1. **Where does the runtime persist `currentProjectId` per-window for the desktop?** Could be window state in Electron, or a `windowSession` registry inside the runtime. Probably the latter for consistency, but the former is simpler. Decide during Phase 2.
2. **Reconnect semantics for SSH transport.** When the SSH connection drops, should we auto-reconnect and resume in-flight RPC calls, or fail-fast? Recommend fail-fast for v1 (idempotent retries by the caller); revisit if it's annoying in practice.
3. **Static binary size budget.** Target: under 100 MB per platform. If it bloats above 150 MB, audit dependencies and consider splitting `@cursor/sdk` into a separately-fetched module.
4. **Service-install permissions on Linux.** systemd user units don't require root. Verify on common distros (Ubuntu LTS, Fedora, Arch). Document the manual fallback for edge cases.
5. **Onboarding modal copy.** First-run-after-upgrade text needs product-side wording. Engineering ships the trigger and the placeholder; product owns the words.
6. **Telemetry boundary.** Does the runtime emit telemetry events independently of the desktop, or pipe them through? Existing usage tracking needs reattachment after the split.

---

## 17. Glossary

- **Runtime** — the `ade` daemon process. Holds all state (lanes, sessions, missions, sync server, project registry). One per machine.
- **Project** — a registered repository root with a `.ade/` directory. A runtime manages many projects.
- **UI / Client** — desktop, mobile, or TUI. Connects to a runtime; holds no durable state.
- **Local runtime** — the runtime running on the same machine as the UI.
- **Remote runtime** — a runtime running on a different machine, accessed via SSH.
- **Target** — a registered (machine, optional path) entry that a UI can connect to.
- **Project scope** — the per-project service tree inside a runtime, lazily instantiated.
- **Runtime scope** — services and operations not tied to a single project (project registry, credential store, machine identity).

---

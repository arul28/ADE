# ADE Architecture Reference

Consolidated technical reference for the ADE (Agentic Development Environment) system. This document is the entry point for engineers and AI agents who need to understand the shape of the system before reading feature-specific docs. Deeper, subsystem-specific documentation lives in `docs/architecture/*.md`.

---

## 1. System at a Glance

ADE is a local-first development control plane that orchestrates AI-assisted software engineering across parallel worktrees. It combines worktree-per-lane git isolation, a multi-provider AI runtime, a deterministic orchestrator for multi-step missions, a Linear-integrated CTO agent acting as a team lead, a pipeline builder for visual automations, stacked pull requests with conflict simulation, computer-use proofs, a SQLite-backed memory system, and multi-device sync via cr-sqlite CRDTs. Nothing leaves the user's machine by default: AI work runs through user-authenticated CLIs (Claude Code, Codex), local API-key routes (OpenCode server), or local model endpoints (Ollama, LM Studio, vLLM).

ADE ships as four coordinated apps:

```
                       ┌─────────────────────────┐
                       │ apps/web (marketing +   │
                       │ download landing page)  │
                       └─────────────────────────┘
                                  ▲
                                  │ static hosting
                                  │
┌──────────────────────────┐      │        ┌──────────────────────────┐
│                          │      │        │                          │
│ apps/desktop (Electron)  │──────┴───────▶│ apps/ios (SwiftUI)      │
│                          │  WebSocket    │                          │
│  main  ───  preload ─── renderer         │ SwiftUI tabs + local     │
│  │                                       │ cr-sqlite CRR emulation  │
│  │  └── IPC bridge `window.ade`          │ (never runs agents)      │
│  │                                       │                          │
│  SQLite + cr-sqlite (ade.db)             │                          │
│  │                                       │                          │
│  │─── spawns ─────────────────────┐      │                          │
│  │                                ▼      │                          │
│  │                ┌──────────────────────┐                          │
│  │                │ apps/ade-cli      │                          │
│  │                │ (JSON-RPC over stdio │◀──── headless mode ──────┤
│  │                │  or .ade/ade.sock)   │                          │
│  │                └──────────────────────┘                          │
│  │                                                                   │
│  └── spawns CLI runtimes:                                             │
│       claude (Claude Agent SDK) · codex CLI · opencode server        │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       ┌─────────────────────────┐
                       │ User code: git worktrees │
                       │ under .ade/worktrees/    │
                       └─────────────────────────┘
```

Live runtime state is replicated between connected devices through cr-sqlite changesets carried over WebSocket. Source code crosses desktops through plain git. The iOS app is always a controller attached to a desktop host.

Product positioning and workflows live in [`docs/PRD.md`](../docs/PRD.md). This document is strictly technical.

---

## 2. Apps & Processes

### 2.1 Electron desktop (`apps/desktop/`)

The desktop app is the execution host. It owns the trusted main process, a narrow typed preload bridge, the React renderer, and shared contracts.

| Directory | Role |
|-----------|------|
| `apps/desktop/src/main/` | Node process with full OS access. Bootstraps project context, registers IPC handlers, owns SQLite, spawns child processes and CLI runtimes. Entry: `main.ts`. |
| `apps/desktop/src/preload/` | Typed bridge. Entry: `preload.ts`. Uses `contextBridge.exposeInMainWorld("ade", { ... })` and is the only code that crosses the isolated-world boundary. |
| `apps/desktop/src/renderer/` | React 18 SPA. No Node access, no filesystem access, no direct process/network. Everything goes through `window.ade`. Entry: `main.tsx`. |
| `apps/desktop/src/shared/` | Types, IPC channel constants (`ipc.ts`), model registry (`modelRegistry.ts`), keybindings, and other DTOs shared between main and renderer. |
| `apps/desktop/src/generated/` | Build-time generated code (e.g., bootstrap SQL snapshots). |
| `apps/desktop/src/test/` | Shared vitest setup and fixtures. |
| `apps/desktop/src/types/` | Ambient type declarations. |

Build outputs (configured in `apps/desktop/tsup.config.ts`):

| Entry | Source | Purpose |
|-------|--------|---------|
| `main/main.cjs` | `src/main/main.ts` | Electron main process |
| `main/packagedRuntimeSmoke.cjs` | `src/main/packagedRuntimeSmoke.ts` | Post-package smoke test for PTY spawn, Claude SDK init, Codex availability, and ADE CLI readiness. |
| `preload/preload.cjs` | `src/preload/preload.ts` | Renderer bridge. |

### 2.2 ADE CLI (`apps/ade-cli/`)

A standalone Node CLI that exposes ADE actions over a private JSON-RPC
bridge.

- **Socket mode** — when ADE desktop is running, `ade` connects to the
  project IPC endpoint. On macOS/Linux that is `.ade/ade.sock`; on
  Windows it is a named pipe under `\\.\pipe\ade-<hash>` where `<hash>`
  is a SHA-256 prefix of the lowercased absolute project root
  (`apps/desktop/src/shared/adeMcpIpc.ts`). Both platforms share the
  same JSON-RPC framing.
- **Headless mode** — with `--headless`, the CLI bootstraps the same
  project services directly from the repository.
- **Windows packaging** — the installer lays down `ade-cli-windows-wrapper.cmd`
  plus an `ade-cli-install-path.cmd` helper alongside the bundled Node
  runtime so that `ade` works from a normal Windows shell without a
  global Node install. See §14.4 for the packaging flow.
- **Install + PATH wiring (`adeCliService`)** — on macOS / Linux the
  desktop installer drops the launcher at `$HOME/.local/bin/ade`; on
  Windows it lands at `%LOCALAPPDATA%\ADE\bin\ade.cmd`. After a
  successful install on POSIX, `ensureUserBinOnShellPath` appends a
  marked `export PATH="$HOME/.local/bin:$PATH"` block to the user's
  shell rc (`.zshrc` for zsh, `.bashrc` for bash, `.profile` otherwise)
  iff (a) the install dir isn't already on the inherited `PATH` and
  (b) the file doesn't already contain the marker / line / target dir.
  The install IPC reply tells the renderer which profile was edited
  so the Settings/Onboarding UI can prompt the user to open a new
  terminal or `source` it.
- **Session identity** — the CLI resolves caller role from ADE context
  environment variables and command flags. Role vocabulary: `cto`,
  `orchestrator`, `agent`, `external`, `evaluator`.
- **Action surface** — first-class command families cover lanes, git,
  diffs, files, PRs, path-to-merge, runs, shells, chats, agents, CTO,
  Linear, tests, proof, memory, settings, and a generic
  `ade actions run <domain.action>` escape hatch for every registered
  ADE service action.

### 2.3 Web app (`apps/web/`)

A Vite/React SPA that serves the public marketing site and download page. Four pages: `HomePage`, `DownloadPage`, `PrivacyPage`, `TermsPage`. Independent package (`ade-web`), deployed via Vercel (`apps/web/vercel.json`). Not a runtime dependency of the desktop app. Shared-origin with the Mintlify docs site (`docs.json` at repo root).

### 2.4 iOS companion (`apps/ios/`)

Native SwiftUI app acting as a controller for an ADE host. It reads live desktop state from a local cr-sqlite-backed SQLite database and sends commands to the host for execution. The phone never runs agents.

- Stack: native SwiftUI + `SQLite3` C API + iOS system SQLite.
- CRDT: pure-SQL CRR emulation layer (trigger-based change tracking) since iOS blocks `sqlite3_load_extension()`/`sqlite3_auto_extension()`. Changesets are wire-compatible with desktop cr-sqlite.
- Core services: `Database.swift`, `SyncService.swift`, `KeychainService.swift`,
  `LiveActivityCoordinator.swift`.
- Shipped tabs: Lanes, Files, Work, PRs, CTO, Settings.
- Shipped: APNs push pipeline (desktop `apnsService` + `notificationEventBus` →
  iOS `AppDelegate` + `NotificationCategories` + Notification Service Extension),
  workspace Live Activity (Lock Screen + Dynamic Island), Home Screen / Lock
  Screen / Control Center widgets.
- Planned: Missions, Automations, Graph, History tabs; iPad layout; Spotlight.
- Target: iOS 26+, iPhone + iPad.

---

## 3. Data Plane

### 3.1 SQLite + cr-sqlite CRDT layer

ADE uses Node's native `node:sqlite` driver (no better-sqlite3 dependency) with a vendored cr-sqlite loadable extension:

- **Engine source**: `apps/desktop/src/main/services/state/kvDb.ts` (schema bootstrap, CRR enablement, sync API) and `crsqliteExtension.ts` (extension loader).
- **Database file**: `<project_root>/.ade/ade.db`.
- **WAL mode** handles durability; `flushNow()` is a no-op.
- **CRRs**: eligible tables are marked via `SELECT crsql_as_crr('table_name')` at startup. Virtual/internal tables (`sqlite_%`, `crsql_%`, `unified_memories_fts%`) are excluded. Marking is dynamic — new tables are picked up automatically unless excluded.
- **Sync API** (`AdeDb.sync`): `getSiteId()`, `getDbVersion()`, `exportChangesSince(version)`, `applyChanges(changes)`. Used by the sync transport.
- **Merge semantics**: last-writer-wins per column with Lamport timestamps; each device has a site ID at `.ade/secrets/sync-site-id`.
- **Engineering rule under CRR retrofit**: app-level `ON CONFLICT(...)` upserts must target PK only; secondary UNIQUE constraints do not survive CRR marking.

### 3.2 Schema highlights

Schema bootstrap in `kvDb.ts` creates ~103 tables. Anchor tables for agents reading this doc:

| Table | Purpose |
|-------|---------|
| `projects` | One row per opened repo. Keyed by `root_path`. |
| `lanes` | Worktree-backed units of work. Types: `primary`, `worktree`, `attached`. Supports parent/child stacks, mission binding, color/icon/tags. |
| `terminal_sessions` | Tracked PTY sessions per lane with transcript path and head SHAs. |
| `session_deltas` | Post-session diff stats + touched files + failure lines. Input to pack generation. |
| `operations` | Audit log of every significant mutation (git, pack updates). Pre/post HEAD SHAs enable undo. |
| `process_definitions` / `process_runtime` / `process_runs` | Managed-process lifecycle (derived from `ade.yaml`). |
| `test_suites` / `test_runs` | Declared test suites and their execution history. |
| `missions` / `mission_runs` / `mission_steps` / `mission_step_attempts` | Mission lifecycle with runs, steps, attempts. |
| `pull_requests` / `pr_review_threads` / `pr_checks` | GitHub PR projections with queue and stack metadata. |
| `integration_proposals` | PR merge-plan simulations. Stores source lanes, pairwise results, sequential resolution state, optional adopted merge target (`preferred_integration_lane_id`), and merge-target drift snapshot (`merge_into_head_sha`). |
| `unified_memories` + `unified_memories_fts` + `unified_memory_embeddings` | Primary memory store + FTS4 index + vector embeddings. |
| `memory_procedure_*`, `memory_skill_index`, `knowledge_capture_ledger` | Procedural memories and ingestion dedupe. |
| `cto_core_memory_state` | Per-project CTO core-memory blob. |
| `computer_use_artifacts` + `computer_use_artifact_links` | Canonical proof-artifact records and cross-domain ownership. |
| `devices` + `sync_cluster_state` | Device registry and singleton host-authority row (host is `brain_device_id` internally; legacy naming). |
| `kv` | Generic key-value store for UI layout, config trust hashes, misc settings, and short-lived recovery records such as `agent-chat-parallel-launch:<projectRoot>:<laneId>`. |

Types for these tables are split into domain modules under `apps/desktop/src/shared/types/`. The barrel `index.ts` re-exports `core`, `models`, `git`, `lanes`, `conflicts`, `prs`, `files`, `sessions`, `chat`, `missions`, `orchestrator`, `config`, `automations`, `packs`, `budget`, `usage`, and more. Full schema coverage lives in [`docs/architecture/DATA_MODEL.md`](../docs/architecture/DATA_MODEL.md).

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
│   ├── context/                 # Generated agent bootstrap docs (ignored)
│   │   ├── PRD.ade.md
│   │   └── ARCHITECTURE.ade.md
│   ├── memory/                  # Promoted-memory markdown mirror (ignored)
│   ├── cto/
│   │   ├── identity.yaml        # Shared CTO identity (tracked)
│   │   ├── core-memory.json     # Runtime CTO core memory (ignored)
│   │   ├── CURRENT.md           # Running status markdown (ignored)
│   │   ├── MEMORY.md            # Runtime memory mirror (ignored)
│   │   └── daily/<YYYY-MM-DD>.md
│   ├── agents/<slug>/           # Per-worker identity + core memory (runtime, ignored)
│   ├── templates/               # Lane/mission templates (tracked when human-authored)
│   ├── skills/                  # Exported skill markdown (tracked when human-authored)
│   ├── workflows/linear/        # Linear workflow config (tracked when present)
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

1. **Git-tracked shared scaffold** — `.ade/.gitignore`, `ade.yaml`, `cto/identity.yaml`, human-authored `templates/**`, `skills/**`, `workflows/linear/**`. This is the only `.ade/` subset that flows through normal clone/pull.
2. **ADE sync state** — the replicated `ade.db` tables that flow through cr-sqlite over WebSocket when devices join the same host.
3. **Machine-local runtime** — worktrees, caches, transcripts, artifacts, secrets, sockets, generated context/memory markdown. Never leaves the device.

### 3.4 Migration strategy

- Schema is defined idempotently — `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`.
- One-time schema-compat migration at startup: retrofits `NOT NULL` on PKs and strips UNIQUE/FK constraints incompatible with cr-sqlite CRRs. A pre-cr-sqlite backup (`<db>.pre-crsqlite-w1.bak`) is written on first CRR enablement.
- Feature migrations add columns via `ALTER TABLE ADD COLUMN`, wrapped by `crsql_begin_alter`/`crsql_commit_alter` to stay CRR-safe.
- Targeted per-domain migrations live alongside their domain tests: `kvDb.missionsMigration.test.ts`, `kvDb.orchestratorMigration.test.ts`, `kvDb.workerAgentsMigration.test.ts`.
- The canonical iOS bootstrap schema is exported from desktop `kvDb.ts` to `apps/ios/ADE/Resources/DatabaseBootstrap.sql` so iOS stays schema-compatible.

---

## 4. AI Integration Layer

Service entry points live under `apps/desktop/src/main/services/ai/`. The subsystem has four parts: provider-routed execution, permission profiles, ADE CLI-backed tool surfaces, and a deterministic orchestrator on top of those.

### 4.1 Provider routing

- **Router** — `aiIntegrationService.ts` resolves a task → model → provider class and dispatches.
- **Model registry** — `apps/desktop/src/shared/modelRegistry.ts` is the single source of truth. Each `ModelDescriptor` carries identity (`id`, `shortId`, `providerRoute`, `providerModelId`), capabilities, pricing, context sizing, auth type (`cli-subscription`, `api-key`, `openrouter`, `local`), and optional `harnessProfile`/`discoverySource` for safety metadata.
- **Classes**:
  - **CLI-wrapped** (Claude CLI via `@anthropic-ai/claude-agent-sdk`, Codex CLI via `@openai/codex-sdk`) — spawned as subprocesses; authentication inherits from the user's own CLI login. ADE context is exposed through environment variables, and agents can call back into ADE with the `ade` CLI.
  - **API-key / OpenRouter** (Anthropic, OpenAI, Google, Mistral, DeepSeek, xAI, Groq, Together AI, OpenRouter) — routed through the **OpenCode server** (`opencode` binary, user-installed or bundled). Discovery via `openCodeInventory.ts`; replaces dynamic portion of the registry.
  - **Local** (Ollama, LM Studio, vLLM) — OpenAI-compatible local endpoints through OpenCode. Discovery via `localModelDiscovery.ts`.
- **Detection pipeline**:
  - `authDetector.ts` — detects subscriptions, API keys, OpenRouter, local endpoints.
  - `providerCredentialSources.ts` — reads Claude OAuth credentials, Codex tokens, macOS Keychain.
  - `providerConnectionStatus.ts` — builds the `AiProviderConnections` snapshot surfaced to the renderer.
  - `providerRuntimeHealth.ts` — per-provider health (`ready`, `auth-failed`, `runtime-failed`).
  - `claudeRuntimeProbe.ts` — lightweight SDK probe on force-refresh to confirm the Claude CLI + ADE CLI path can actually start.
  - `modelsDevService.ts` — non-blocking 6-hour refresh that enriches pricing and context-window metadata in the registry from `models.dev`.
- **Fallback**: if no usable provider is present, ADE runs in **guest mode** — deterministic features (packs, diffs, conflicts) continue; AI surfaces are disabled with explanatory UI.

### 4.2 Permission modes (provider-native + ADE)

Permission configuration is class-based, not provider-bucketed:

- `permissionConfig.cli` — for CLI-wrapped models. Claude uses `claudePermissionMode` (`default`, `acceptEdits`, `bypassPermissions`, `plan`); Codex uses `approvalMode` (`untrusted`, `on-request`, `on-failure`, `never`) + `sandboxPermissions` (`read-only`, `workspace-write`, `danger-full-access`).
- `permissionConfig.inProcess` — for API/local models. ADE-defined planning/coding tool profiles constitute the full tool surface.
- **ADE-owned tools** (repo mutation, mission control, context export) always enforce ADE's own permission and policy layers regardless of provider mode — preserving the audit boundary.
- **Sandbox budgets**: `maxBudgetUsd` per-session cap for Claude; per-task daily budgets for narratives/PR descriptions/terminal summaries/mission planning/orchestrator.

### 4.3 Tool system

Agent tools are split by domain:

| File | Domain |
|------|--------|
| `ai/tools/universalTools.ts` | Turn-level memory guard + mutating tools (`bash`, `writeFile`, `editFile`); gates on `TurnMemoryPolicyState` for `required` turns. |
| `ai/tools/memoryTools.ts` | `memoryAdd`, `memorySearch`; `resolveAgentMemoryWritePolicy()`; `MemoryWriteEvent` emission. |
| `ai/tools/workflowTools.ts` | Mission / workflow interaction tools. |
| `ai/tools/ctoOperatorTools.ts` | CTO-only operator tools. |
| `ai/tools/linearTools.ts` | Linear integration tool surface. |
| `ai/tools/webFetch.ts` / `webSearch.ts` | Outbound web access. |
| `ai/tools/readFileRange.ts` / `globSearch.ts` / `grepSearch.ts` | Read-only file tools shared across all roles. |
| `ai/tools/editFile.ts` | Edit-path tool wired to ADE-controlled write flow. |
| `ai/tools/systemPrompt.ts` | Base system prompt; memory usage instructions baked in. |

**ADE CLI is the cross-process action surface.** Workers spawned as CLI children inherit ADE context env vars and can call the `ade` command to invoke ADE-owned actions layered on top of their native provider tools.

**Turn classification** (`universalTools.ts`): the chat service classifies each user turn as `required` (mentions fix/debug/implement/refactor → memory search mandatory before mutations), `soft` (explain/review/design → memory auto-injected but not gated), or `none` (meta/greeting → no injection/gating).

### 4.4 Model registry specifics

`apps/desktop/src/shared/modelRegistry.ts` + `apps/desktop/src/shared/modelProfiles.ts`:

- `MODEL_REGISTRY` — static CLI-wrapped entries + dynamically populated API-key/local entries. Includes the Claude Opus 4.7 1M-context entry (`anthropic/claude-opus-4-7-1m`, aliases `opus[1m]` / `claude-opus-4-7[1m]`, 1,000,000 context / 128,000 max output, `costTier: "very_high"`, full `low|medium|high|max` reasoning tiers).
- `ModelProviderGroup` = `"claude" | "codex" | "opencode" | "cursor"`.
- Helpers: `getModelById`, `getModelPricing`, `updateModelPricingInRegistry`, `replaceDynamicOpenCodeModelDescriptors`, `resolveProviderGroupForModel`, `resolveModelDescriptorForProvider`, `getRuntimeModelRefForDescriptor`.
- Reasoning tier passthrough (`providerOptions.ts`) maps tier strings directly to each provider's native config (`thinking.type`, `reasoningEffort`, `thinkingConfig.thinkingLevel`, etc.) — no arbitrary token budgets. The Claude vocabulary is `low | medium | high | max`.
- Model profiles (`modelProfiles.ts`) derive the Missions UI model catalog and per-call-type intelligence defaults from `MODEL_REGISTRY` rather than maintaining parallel lists.

### 4.5 AI Orchestrator (deterministic runtime)

`apps/desktop/src/main/services/orchestrator/` contains the deterministic state machine that tracks mission runs, steps, attempts, and claims:

- `aiOrchestratorService.ts` — orchestrator API.
- `coordinatorAgent.ts` + `coordinatorTools.ts` + `coordinatorSession.ts` — the intelligent coordinator that makes strategic decisions (spawn, replan, validation routing, lane transfer, escalation).
- `orchestrationRuntime.ts`, `missionLifecycle.ts`, `missionStateDoc.ts`, `executionPolicy.ts`, `phaseEngine.ts` — runtime invariants and state.
- `adaptiveRuntime.ts`, `metaReasoner.ts` — smart fan-out and adaptive behavior.
- `modelConfigResolver.ts` — strict phase-authoritative model resolution (explicit override → current phase model; no role-level fallback).
- `delegationContracts.ts`, `missionBudgetService.ts` — contract + budget enforcement.
- Validation baseline: required validation contracts are runtime-enforced. Auto-spawned validator steps per target step. Missing validation blocks phase transitions with signals `validation_contract_unfulfilled`, `validation_self_check_reminder`, `validation_auto_spawned`, `validation_gate_blocked`.

Interactive chat (Terminals, Work) bypasses mission runtime semantics but still flows through the unified executor with the same memory/permission plumbing.

Full contract: [`docs/architecture/AI_INTEGRATION.md`](../docs/architecture/AI_INTEGRATION.md) and `docs/ORCHESTRATOR_OVERHAUL.md`.

---

## 5. IPC Contract (the glue)

### 5.1 Typed preload

`apps/desktop/src/preload/preload.ts` (~2,590 lines) exposes ~550 methods on `window.ade`:

- `contextBridge.exposeInMainWorld("ade", { ... })` — the only cross-isolated-world surface.
- Methods are typed via TypeScript imports from `apps/desktop/src/shared/types/`.
- Two categories: **invoke methods** (`ipcRenderer.invoke(channel, args)` returning `Promise<T>`) and **event subscriptions** (`ipcRenderer.on(channel, handler)`).
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: false` (required for preload functionality).
- Global window type: `apps/desktop/src/preload/global.d.ts`.
- `window.ade.project.getDroppedPath(file)` wraps Electron's `webUtils.getPathForFile()` so renderer drag-drop handlers can resolve the absolute path of a `File` payload without the renderer needing Node APIs. Used by the Command Palette project browser to accept dropped folders.

### 5.2 Channel design

`apps/desktop/src/shared/ipc.ts` defines the single `IPC` const with ~550 named channel strings in a `ade.<domain>.<action>` namespace:

```
ade.app.*                    # app lifecycle, clipboard, paths
ade.project.*                # project open/close/switch/state, in-app directory browser (browseDirectories, getDetail)
ade.onboarding.*
ade.lanes.*                  # lane list/create/delete/stack/template/env/port/proxy/rebase
ade.files.*                  # file tree, read, write, search, watch
ade.pty.*                    # PTY spawn/write/kill, data/exit events
ade.git.*                    # stage/commit/push/sync/revert/cherry-pick/stash
ade.github.*                 # PR list, review, merge, checks
ade.prs.*                    # stacked PR queue, integration, issue inventory
ade.conflicts.*              # risk matrix, simulation, proposals
ade.context.*                # context doc generation, status events
ade.memory.*                 # memory CRUD, search, health, embeddings
ade.missions.* / ade.orchestrator.*
ade.cto.*                    # identity, core memory, agent roster, Linear
ade.sessions.*               # terminal session CRUD
ade.agentChat.*              # agent chat sessions, model inventory, parallel launch state
ade.automations.*
ade.processes.* / ade.tests.*
ade.config.*                 # project config get/save/trust
ade.keybindings.*
ade.sync.*                   # device registry, PIN pairing (getPin/setPin/clearPin), QR payload, lane presence announce (setActiveLanePresence), host transfer
ade.usage.*                  # token/cost accounting
ade.layout.* / ade.graph.*
ade.computerUse.*
ade.updates.*
```

### 5.3 Main-process handlers

`apps/desktop/src/main/services/ipc/registerIpc.ts` (~6,400 lines) is the single registration point:

- `ipcMain.handle(IPC.channelName, async (event, args) => { ... })` for invoke channels.
- Every handler is wrapped with a **30-second timeout** — if it does not resolve, the call rejects with a timeout error rather than hanging the renderer.
- Every handler emits structured tracing: `ipc.invoke.begin`, `ipc.invoke.done`, `ipc.invoke.failed` with call ID, channel, window ID, duration, and summarized args/results.
- `AppContext` indirection: handlers close over a context pointer that swaps atomically on project switch, so IPC channels remain registered across project transitions.

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
| `ade.missions.event` / `ade.orchestrator.event` | missionService / orchestrator | useMissionsStore (debounced) |
| `ade.agents.event` | CTO/worker services | CTO tab feed |
| `ade.lanes.rebaseSuggestions.event` / `ade.lanes.autoRebase.event` / `ade.lanes.rebase.event` | rebase services | Lanes + Graph |
| `ade.project.missing` | projectService | Shell banner |
| `ade.project.state.event` | projectState | Startup flow |
| `ade.context.statusChanged` | contextDocService | Settings → Context |
| `ade.memory.*` events | memory services | Settings → Memory |
| `ade.sync.*` events | syncService | Settings → Sync |

Consolidated reads: `getFullMissionView` returns metadata, run, steps, chat threads, interventions, artifacts, and usage in one IPC — replacing 5+ per-mission-selection calls.

Renderer telemetry events flow back to main: `renderer.route_change`, `renderer.tab_change`, `renderer.window_error`, `renderer.unhandled_rejection`, `renderer.event_loop_stall`.

---

## 6. Services Catalog (Main Process)

Every service lives under `apps/desktop/src/main/services/<domain>/`. Summary:

| Domain | Key files | Role |
|--------|-----------|------|
| `ai/` | `aiIntegrationService.ts`, `authDetector.ts`, `providerConnectionStatus.ts`, `claudeRuntimeProbe.ts`, `modelsDevService.ts`, `compactionEngine.ts`, `tools/*` | Provider routing, detection, tool definitions, compaction. |
| `agentTools/` | `agentToolsService.ts` | Agent tool registry metadata surfaced to the renderer. |
| `automations/` | `automationService.ts`, `automationPlannerService.ts`, `automationIngressService.ts`, `automationSecretService.ts` | Rule lifecycle, NL → rule planner, inbound triggers, per-rule secrets. |
| `chat/` | `agentChatService.ts`, `buildClaudeV2Message.ts`, `cursorAcp*`, `sessionRecovery.ts` | Agent chat sessions (lane-scoped + mission worker/coordinator). Builds Claude messages, manages Cursor ACP pool, recovers sessions on restart, and derives prompt-based lane names for parallel model launches. |
| `computerUse/` | `computerUseArtifactBrokerService.ts`, `controlPlane.ts`, `localComputerUse.ts`, `agentBrowserArtifactAdapter.ts`, `syntheticToolResult.ts` | Proof-artifact broker (ingests, owner links, review state, routing), control-plane snapshot helpers, macOS capture capability descriptor, agent-browser payload parser, and the synthetic-tool-result helper used by the Claude compaction path. `proofObserver.ts` was removed in the rebuild — there is no passive auto-ingest. |
| `config/` | `projectConfigService.ts`, `laneOverlayMatcher.ts` | Load/save `.ade/ade.yaml` + `local.yaml`; trust enforcement; lane overlays. |
| `conflicts/` | `conflictService.ts` | Pairwise dry-merge simulation, risk matrix, proposal generation. |
| `context/` | `contextDocService.ts`, `contextDocBuilder.ts` | Generate `.ade/context/PRD.ade.md` + `ARCHITECTURE.ade.md` with budgets and quality gates. |
| `cto/` | `ctoStateService.ts`, `workerAgentService.ts`, `workerBudgetService.ts`, `workerHeartbeatService.ts`, `linearSyncService.ts`, `linearIngressService.ts`, `linearOAuthService.ts`, `linearRoutingService.ts`, `linearDispatcherService.ts`, `linearCloseoutService.ts`, `openclawBridgeService.ts`, `flowPolicyService.ts` | CTO identity + core memory; worker agents; Linear sync/ingress/OAuth/routing/dispatcher/closeout; OpenClaw bridge. |
| `devTools/` | `devToolsService.ts` | Probe for git + `gh` CLI availability. |
| `diffs/` | `diffService.ts` | Diff computation for file panes. |
| `feedback/` | `feedbackReporterService.ts` | In-app feedback reporting. Two-stage: `prepareDraft` generates a structured issue title + labels (AI-assisted when a model is selected, deterministic fallback otherwise) so the user can review before posting; `submitPreparedDraft` files the GitHub issue. Each submission records `generationMode` and a `generationWarning` so the UI can flag deterministic drafts. |
| `files/` | `fileService.ts`, `fileWatcherService.ts`, `fileSearchIndexService.ts` | Workspace file tree, read/write, watch, index. |
| `git/` | `git.ts`, `gitOperationsService.ts`, `gitConflictState.ts` | Low-level git runner, high-level lane-scoped ops, conflict state queries. |
| `github/` | `githubService.ts` | GitHub REST/GraphQL access; PR CRUD; checks; reviewers. |
| `history/` | `operationService.ts` | Operation audit records (one row per mutation). |
| `ipc/` | `registerIpc.ts` | Single registration point for all IPC handlers. |
| `jobs/` | `jobEngine.ts` | Event-driven background scheduler for lane refresh + conflict prediction. Coalesced, debounced. |
| `keybindings/` | `keybindingsService.ts` | User keybindings read/write. |
| `lanes/` | `laneService.ts`, `laneEnvironmentService.ts`, `laneTemplateService.ts`, `laneProxyService.ts`, `portAllocationService.ts`, `autoRebaseService.ts`, `rebaseSuggestionService.ts`, `laneLaunchContext.ts`, `oauthRedirectService.ts`, `runtimeDiagnosticsService.ts` | Worktree lifecycle, env bootstrap, templates, reverse proxy, port leases, auto-rebase, suggestions, OAuth redirect, diagnostics. |
| `logging/` | `logger.ts` | File-backed structured logger. |
| `memory/` | `unifiedMemoryService.ts` (canonical; listed under `memory/memoryService.ts`), `memoryBriefingService.ts`, `memoryLifecycleService.ts`, `batchConsolidationService.ts`, `embeddingService.ts`, `embeddingWorkerService.ts`, `hybridSearchService.ts`, `episodicSummaryService.ts`, `knowledgeCaptureService.ts`, `humanWorkDigestService.ts`, `proceduralLearningService.ts`, `compactionFlushPrompt.ts`, `skillRegistryService.ts`, `memoryFilesService.ts`, `memoryRepairService.ts`, `missionMemoryLifecycleService.ts` | Unified memory subsystem — see §10. |
| `missions/` | `missionService.ts`, `missionPreflightService.ts`, `phaseEngine.ts` | Mission CRUD, preflight validation, phase lifecycle. |
| `onboarding/` | `onboardingService.ts` | First-run flow, defaults detection, existing lane discovery. |
| `opencode/` | `openCodeRuntime.ts`, `openCodeServerManager.ts`, `openCodeBinaryManager.ts`, `openCodeInventory.ts`, `openCodeModelCatalog.ts` | OpenCode server spawn, binary resolution, model discovery. |
| `orchestrator/` | See §4.5. | Deterministic mission runtime + intelligent coordinator. |
| `processes/` | `processService.ts` | Managed-process lifecycle per lane, readiness probes, restart policies. |
| `projects/` | `adeProjectService.ts`, `configReloadService.ts`, `projectService.ts`, `logIntegrityService.ts`, `recentProjectSummary.ts`, `projectBrowserService.ts`, `projectDetailService.ts` | Project detection + `.ade` repair/bootstrap, reload on config change, recent-project metadata. `projectBrowserService` is the in-app directory autocomplete used by the Command Palette project browser (typed-path completion, `.git` detection, home expansion, system-picker fallback); `projectDetailService` returns repo metadata (branch, dirty count, ahead/behind, last commit, README excerpt, language mix, lane count, last-opened) for the palette's preview pane. |
| `prs/` | `prService.ts`, `prPollingService.ts`, `prSummaryService.ts`, `queueLandingService.ts`, `issueInventoryService.ts`, `prIssueResolver.ts`, `prRebaseResolver.ts`, `integrationPlanning.ts`, `integrationValidation.ts` | PR CRUD, polling (with per-PR `last_polled_at` cursor), AI summary cache keyed by `(prId, head_sha)`, stacked-queue landing, issue inventory, AI-assisted resolution, integration planning, and merge-into-existing-lane proposal adoption. |
| `pty/` | `ptyService.ts` | `node-pty` spawn, PTY I/O bridging, transcript writing. |
| `runtime/` | `tempCleanupService.ts` | Runtime temp cleanup. |
| `sessions/` | `sessionService.ts`, `sessionDeltaService.ts` | Terminal session CRUD, post-session delta computation. |
| `shared/` | `utils.ts`, `queueRebase.ts`, `packLegacyUtils.ts`, `transcriptInsights.ts` | Cross-domain utilities. |
| `state/` | `kvDb.ts`, `crsqliteExtension.ts`, `globalState.ts`, `projectState.ts`, `onConflictAudit.ts` | SQLite schema + open, CRR extension loader, global state file, per-project state init. |
| `sync/` | `syncService.ts`, `syncHostService.ts`, `syncPeerService.ts`, `syncRemoteCommandService.ts`, `syncProtocol.ts`, `deviceRegistryService.ts`, `syncPairingStore.ts` | WebSocket host, peer client, remote command routing, protocol framing, device registry, pairing secrets. |
| `notifications/` | `apnsService.ts`, `notificationMapper.ts`, `notificationEventBus.ts` | APNs HTTP/2 client (ES256 JWT, encrypted `.p8`), pure domain-event → `MappedNotification` mapping (13 categories / 4 families), event bus routing to APNs alert pushes + Live Activity update pushes + in-app WS delivery, filtered by per-device `NotificationPreferences`. |
| `tests/` | `testService.ts` | Test-suite execution + run history. |
| `updates/` | `autoUpdateService.ts` | Electron auto-update. |
| `usage/` | `usageTrackingService.ts`, `budgetCapService.ts` | Token/cost accounting, budget enforcement. |

Startup sequencing: every background service goes through `scheduleBackgroundProjectTask()` in `main.ts`, which provides explicit labels, `ADE_ENABLE_*` env gates, `project.startup_task_begin`/`_done`/`_enabled`/`_skipped` telemetry, and per-task delays. Integrations stay **dormant-until-configured**.

Project-init step timing goes through `measureProjectInitStep(step, task)` — a wrapper that logs `project.init_step { projectRoot, step, durationMs }` around each hot-path operation (`db_open`, `lane.ensure_primary`, `ade_rpc.socket_server_start`, `memory.files.initial_sync`, `sync.initialize`, etc.) so cold-start latency shows up in the logs by phase. The memory-file mirror sync and sync-service initialization are now scheduled through `scheduleBackgroundProjectTask` rather than awaited inline, gated by `ADE_ENABLE_MEMORY_FILE_SYNC` and `ADE_ENABLE_SYNC_INIT` respectively (both default-on).

Shutdown pipeline: `main.ts` owns a single `requestAppShutdown({ reason, exitCode, fastKillFirst?, forceAfterMs? })` path driving a central state machine (`shutdownRequested` → `shutdownPromise` → `shutdownFinalized`). Hooks into `before-quit`, `window close`, `SIGINT`, `SIGTERM`, `process.exit`, `will-quit`, and `uncaughtException` all funnel through it. `runImmediateProcessCleanup()` disposes the orchestrator, automations, tests, processes, PTYs, agent chat runtimes, DB flush, and then calls `shutdownOpenCodeServers()`. A `forceAfterMs` timer (default 8 s, 5 s for signals/uncaught) hard-exits if cleanup hangs. User-initiated quit (main window close or `before-quit`) routes through `confirmQuitWarning()` — a modal dialog that explains that closing will stop OpenCode servers, terminal sessions, and test runs.

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

Electron renderer runtime does **not** wrap the app in `React.StrictMode`. Browser-mock development (outside Electron) still uses Strict Mode.

### 7.2 Global store

`apps/desktop/src/renderer/state/appStore.ts` (~868 lines) — Zustand store holding project, lanes, selected lane, theme, provider mode, keybindings, per-project work-view state. Patterns:

- Narrow selectors on components to minimize re-renders.
- Per-project work-view state keyed by project root (`WorkProjectViewState`).
- Store-owned event subscriptions for high-frequency streams (e.g., missions).
- `projectRevision` is a monotonically incrementing counter bumped inside `setProject` whenever the active project root actually changes. Long-lived renderer-side caches (most notably the module-level xterm runtime cache in `TerminalView.tsx`) subscribe to it and tear down any entries whose `projectRoot`/`projectRevision` no longer match, so PTYs never bleed between projects. All project-transition paths (`refreshProject`, `openRepo`, `switchProjectToPath`, `closeProject`) go through `setProject` to keep the counter honest.

Domain stores co-located with their pages:

- `useMissionsStore` (`components/missions/useMissionsStore.ts`, ~596 lines) — mission list, selected mission, debounced event handling, store-owned timers.
- `chatDraftStore.ts` — draft messages per chat session.

### 7.3 Component organization

Feature-grouped under `apps/desktop/src/renderer/components/`:

```
app/            # shell, App.tsx, TopBar, TabNav, startup, splash
project/        # Play tab, run/test/process controls
lanes/          # list/detail/inspector, stacks, laneDesignTokens.ts
files/          # tree, editor, diffs
terminals/      # TerminalView, WorkViewArea (PaneTilingLayout-backed grid), workSessionTiling, LaneCombobox
conflicts/      # risk matrix, simulation, resolution
context/        # shared helpers (contextShared.ts)
graph/          # WorkspaceGraphPage (decomposed into nodes/edges/dialogs)
prs/            # PR list/detail, stacked queue, shared/
history/        # operation timeline
automations/    # rule list, pipeline builder
missions/       # MissionsPage + decomposed sub-modules
cto/            # CTO page, identity editor, team panel, pipeline, shared/designTokens.ts
onboarding/     # first-run flows
settings/       # keybindings, agents, data, context, memory, sync
chat/           # AgentChatPane + composer + subpanels
shared/         # MentionInput, shared interactive bits
ui/             # pure presentation primitives
```

Design tokens have been intentionally trimmed. The CTO design tokens at `apps/desktop/src/renderer/components/cto/shared/designTokens.ts` are the example style: a small set of Tailwind class constants (`cardCls`, `surfaceCardCls`, `shellBodyCls`, `inputCls`, `labelCls`, etc.) and a constrained accent palette (`ACCENT.purple/blue/green/pink/amber`). Lane design tokens live at `lanes/laneDesignTokens.ts` and are imported across missions/lanes/PRs/settings.

### 7.4 Layout patterns

- `PaneTilingLayout` — recursive pane trees for high-density workspaces, backed by pure ops in `paneTreeOps.ts` (`reconcilePaneTree`, `splitPaneAtEdge`, `swapPanes`, `detectDropEdge`). Trees persist per `layoutId` via `window.ade.tilingTree`; panel sizes persist separately via `DockLayoutState` and are reset whenever the tree mutates.
- `SplitPane` / resizable panels — structured 2/3-pane views.
- Work view's grid mode is `PaneTilingLayout` seeded by `buildWorkSessionTilingTree(sessionIds)` (in `renderer/components/terminals/workSessionTiling.ts`); every session becomes a `FloatingPane` leaf with `grid-tile` chrome.
- Layout state persists to SQLite (`layout`, `tilingTree`, `graphState` domains via the `kv` table).

### 7.5 Performance contract

Enforced rules (from the stability overhaul):

1. All background services go through `scheduleBackgroundProjectTask()` — no raw `setTimeout` for service startup.
2. New integrations are dormant-until-configured.
3. Feature pages stage data: cheapest (list/summary/topology) first, heavy (dashboard/settings/model metadata/overlays) on delay.
4. Never mount expensive trees eagerly — settings dialogs, advanced launcher sections unmount when closed.
5. Renderer polling is route-scoped; terminal attention only polls on terminal routes; lane panels only poll while live sessions exist.
6. Shared caches for high-frequency calls (`sessionListCache`, GitHub fingerprint-based snapshots).
7. Memoize expensive renderer computations (`useMemo`, `React.memo`); isolate frequently-refreshing subtrees (e.g., budget footers).
8. `Promise.allSettled` over `Promise.all` for parallel startup — one failing service must not block others.

Themes: six shipped themes (`e-paper`, `bloomberg`, `github`, `rainbow`, `sky`, `pats`), persisted in `localStorage.ade.theme`, applied via `data-theme` on root. Token-based palettes in `apps/desktop/src/renderer/index.css`.

### 7.6 Renderer primitives

- `renderer/lib/dialogBus.ts` — tiny pub/sub that lets the onboarding tour engine (and anyone else) open/close dialogs by a stable id (`lanes.create`, `missions.create`, etc.) without prop-drilling. Dialogs subscribe by id; a `subscribeAll` channel exists for devtools. Default singleton export `dialogBus`.
- `renderer/onboarding/waitForTarget.ts` — polls for a DOM target (ref or `data-onboarding-target`) with a visibility check so tour steps anchor reliably to async-mounted UI.
- `renderer/onboarding/TourController.ts` — imperative driver for the onboarding tour state machine.
- `renderer/onboarding/docsLinks.ts` — typed registry of internal/public doc URLs (`docs.lanes`, `docs.missions`, …) that tour steps and the `HelpMenu` link to.
- `renderer/components/onboarding/fx/*` — shared motion-FX primitives (`ActIntro`, `AnimatedField`, `Confetti`, `GhostCursor`, `MorphingTree`, `Spotlight`, `StaggeredText`, `TourIllustration`) with a `useReducedMotion` hook. Used by the 13-act first-session tutorial and per-tab tours.

Full UI rules: [`docs/architecture/UI_FRAMEWORK.md`](../docs/architecture/UI_FRAMEWORK.md).

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

Every IPC handler **validates** its arguments; invalid args return structured errors, never crash. Every handler has a **30s timeout**. Every handler emits structured tracing.

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

Full surface: [`docs/architecture/SECURITY_AND_PRIVACY.md`](../docs/architecture/SECURITY_AND_PRIVACY.md).

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

Full detail: [`docs/architecture/GIT_ENGINE.md`](../docs/architecture/GIT_ENGINE.md).

---

## 10. Memory System

### 10.1 Scopes

Memory is partitioned into three scopes (`UnifiedMemoryScope`):

| Scope | Visibility | Writer |
|-------|-----------|--------|
| `project` | All runtimes in the project | Agents with active claims + policy grant |
| `agent` | Runtimes using the same agent identity | Policy-filtered by `scope_owner_id = agent.id` |
| `mission` | Runtimes in the current run/mission | Agents in the run, `scope_owner_id = run/mission.id` |

Legacy aliases `user` → `agent`, `lane` → `mission` (normalized on read/write). CTO **core memory** sits outside this model as a per-project always-in-context JSON blob.

Categories: `fact`, `preference`, `pattern`, `decision`, `gotcha`, `convention`, `episode`, `procedure`, `digest`, `handoff`.

### 10.2 Storage

SQLite tables:

- `unified_memories` — primary entries with scope, tier (1/2/3), category, content, importance, confidence, access_score, composite_score, pinned, status (`candidate`/`promoted`/`archived`), dedupe_key, timestamps.
- `unified_memories_fts` — FTS4 index kept in sync via triggers. Used for BM25 lexical search.
- `unified_memory_embeddings` — vector embeddings per `(memory_id, embedding_model)`. Model: `Xenova/all-MiniLM-L6-v2`, 384 dim, mean-pooled and normalized.
- `memory_procedure_*` — extended metadata for procedure memories (trigger, steps markdown, confidence history, export state).
- `memory_skill_index` — file registry for exported/imported skill markdown.
- `knowledge_capture_ledger` — dedupe ledger.
- `cto_core_memory_state` — per-project CTO blob.

### 10.3 Write paths and quality controls

Services under `apps/desktop/src/main/services/memory/`:

- `memoryTools.ts` — agent `memoryAdd` tool + `resolveAgentMemoryWritePolicy()` (pin → tier 1/promoted; strict gate → tier 2/promoted; otherwise candidate at tier 3 with confidence 0.6).
- `episodicSummaryService.ts` — builds `EpisodicMemory` after agent sessions.
- `knowledgeCaptureService.ts` — processes interventions/errors/PR feedback into convention/preference/pattern/gotcha.
- `humanWorkDigestService.ts` — builds `ChangeDigest` from git commits (no longer writes digest rows to memory; surfaces state instead).
- `memoryFilesService.ts` — mirrors promoted project memory to `.ade/memory/MEMORY.md` + topic files.
- `proceduralLearningService.ts` — identifies repeatable workflows from episode memories.
- `batchConsolidationService.ts` — clusters similar memories (Jaccard threshold 0.7), merges via AI, archives originals.
- `compactionFlushPrompt.ts` — `DEFAULT_FLUSH_PROMPT` fed to the Claude SDK `PreCompact` hook so durable findings are saved before compaction. Claude-only; other providers don't currently expose an equivalent hook.

Quality controls:

- **Dedup** — Jaccard ≥ 0.85 on normalized content merges into the existing entry; exact `dedupe_key` always merges.
- **Write gate** — `WriteGateMode` (`default` | `strict`); strict accepts only `convention`/`pattern`/`gotcha`/`decision`.
- **Code-derivable rejection** — `rejectCodeDerivableContent()` runs heuristic checks: `looksLikeRawDiffOrCodeDump`, `looksLikeRawStackTrace`, `looksLikeSessionSummary`, `looksLikeRawGitHistory`, `looksLikePathDump`.
- **Category allowlist** — only the 10 defined categories accepted.

### 10.4 Read paths

- **Memory briefing** (`memoryBriefingService.ts`) — builds `MemoryBriefing` for mission workers with sections `l0`/`l1`/`l2`/`mission` + shared facts + tracking arrays. Budgets: `lite` (3), `standard` (8), `deep` (20). Modes: `mission_worker`, `heartbeat`, `wake_on_demand`, `prompt_preview`.
- **Direct-source injection** — briefing service also injects synthetic memories from `git log`, `CLAUDE.md`/`agents.md`/`AGENTS.md`, and `.ade/memory/MEMORY.md` (all as tier-1 promoted synthetic entries).
- **Agent tool** — `memorySearch` supports `lexical` (BM25) and `hybrid` (BM25 + cosine with MMR λ=0.7 for diversity; min 40 vector candidates).
- **IPC** — renderer Settings → Memory panel for list/search/inspect.

### 10.5 Compaction / synthesis / lifecycle

- **Decay**: `nextScore = currentScore * 0.5^(daysSinceAccess / halfLifeDays)`, halfLife default 30 days. Exempt: `preference`, `convention`, pinned.
- **Sweep** (`memoryLifecycleService.ts`) — applies decay, demotes below threshold, promotes qualifying candidates, archives above scope limits (project 2000, agent 500, mission 200). Processes in chunks of 250.
- **Consolidation** (`batchConsolidationService.ts`) — targets scopes at 80%+ capacity; groups by `(scope, scope_owner_id, category)`; clusters at Jaccard 0.7; merges via AI.
- **Stale detection** — entries not accessed in 24h flagged for demotion.
- **Turn-level guard** (`universalTools.ts`) — for `required` turns, mutating tools are blocked until the agent calls `memorySearch`.

Embedding worker (`embeddingWorkerService.ts`) processes unembedded entries in batches; states `idle → loading → ready` (or `unavailable`). Health polled every 10s in Settings → Memory. Probe cache auto-loads model from local HuggingFace cache when present.

Full surface: [`docs/architecture/MEMORY.md`](../docs/architecture/MEMORY.md).

---

## 11. Context Contract

### 11.1 Two layers

- **Canonical docs** (`docs/`) — human-owned, broad-coverage. `docs/PRD.md` owns product; `docs/architecture/*` owns technical design.
- **Generated bootstrap cards** (`.ade/context/`) — agent-facing summaries, bounded token budget.

### 11.2 Generated docs

| File | Required headings | Default budget |
|------|-------------------|----------------|
| `.ade/context/PRD.ade.md` | `## What this is`, `## Who it's for`, `## Feature areas`, `## Current state`, `## Working norms` | 8,000 chars |
| `.ade/context/ARCHITECTURE.ade.md` | `## System shape`, `## Core services`, `## Data and state`, `## Integration points`, `## Key patterns` | 8,000 chars |

Generation inputs (hybrid source-digest model):

- Product sources: `docs/PRD.md`, `docs/features/*`, `README.md`, `AGENTS.md`.
- Technical sources: `docs/architecture/*`, selected shared contracts + IPC/preload surfaces, selected main-process anchors, recent git history.
- Each source is summarized into a `ContextSourceDigest` (title, blurb, headings) before bundling — no raw doc is shipped to the AI.

### 11.3 Quality gates

- Fit inside per-doc char budget (overflow → proportional per-section trimming, not outright rejection).
- Required heading scaffold present.
- PRD ↔ architecture token-level Jaccard < 0.72.
- Validation is **per-doc independent** — PRD can succeed while architecture falls back.

Fallback order when AI path fails: `previous_good` → `deterministic`. Status model: health ∈ `{missing, incomplete, fallback, stale, ready}`; source ∈ `{ai, deterministic, previous_good}`. Helpers in `apps/desktop/src/renderer/components/context/contextShared.ts` (`isContextDocReady`, `describeContextDocHealth`, etc.) keep shell banners + Settings + onboarding consistent.

### 11.4 What gets shipped to each AI call

| Call type | Payload |
|-----------|---------|
| Narrative generation | `LaneExportStandard` (lane, bounded) |
| Conflict proposal | `LaneExportLite` (lane) + `LaneExportLite` (peer, optional) + `ConflictExportStandard` |
| PR description | `LaneExportStandard` with commit history |
| Mission planning | Generated `.ade/context/*` bootstrap cards + memory briefing + mission-scoped data |
| Memory briefing (worker turn) | `MemoryBriefing` (l0/l1/l2/mission sections + shared facts + direct-source injections) |
| Initial context (repo scan) | Targeted file/commit digests |

Runtime health is **pushed**, not polled — `contextStatusChanged` IPC event fires whenever generation status or doc health changes. Stale generations (>5 min in `pending`/`running` without an active promise) auto-reset to `failed`.

Full spec: [`docs/architecture/CONTEXT_CONTRACT.md`](../docs/architecture/CONTEXT_CONTRACT.md).

---

## 12. Proof (Computer-Use Artifacts)

### 12.1 Principle

Proof is **intentional**. Agents run computer use through whatever tool they already have — Claude's `computer_use`, Codex shell, a scripted browser, a headless Playwright run, a local screenshot. ADE stays out of that loop. When the agent reaches a checkpoint worth showing, it files an artifact through the broker (directly or via `ade proof capture` / `attach`), optionally with a caption. That record is what the drawer UI renders and what reviewers see.

The previous control-plane model — `ComputerUsePolicy` (`off`/`auto`/`enabled`, `allowLocalFallback`, `retainProof`, `preferredBackend`), per-phase `evidenceRequirements`, mission-preflight coverage gates, the passive `proofObserver` that auto-ingested from chat `tool_result` events, and the Settings > Computer Use panel — was removed. There is **one path** now: intentional ingest via the broker.

### 12.2 Broker and backends

`apps/desktop/src/main/services/computerUse/computerUseArtifactBrokerService.ts` is the ingest boundary. It accepts `ComputerUseArtifactInput[]` (path, remote URI, inline text, inline JSON), materializes on-disk sources into the project artifacts dir via `secureCopyFromDescriptor` (uses `O_NOFOLLOW` + atomic rename to resist symlink tricks), writes the canonical `computer_use_artifacts` row, and links to one or more owners (`lane`, `mission`, `orchestrator_run/_step/_attempt`, `chat_session`, `automation_run`, `github_pr`, `linear_issue`).

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
- `computer_use_artifact_links` — cross-domain ownership, so the same artifact can graduate from exploratory chat evidence to a mission artifact to a PR comment without losing provenance.

### 12.4 IPC + UI

Channels (under `ade.proof.*`, renamed from `ade.computerUse.*`):

- `ade.proof.listArtifacts`, `ade.proof.getOwnerSnapshot`, `ade.proof.routeArtifact`, `ade.proof.updateArtifactReview`, `ade.proof.readArtifactPreview`, plus a `ade.proof.event` push channel.
- `ade proof capture` / `attach` / `list` in the ADE CLI are the cross-process surface; they call into the broker.

Renderer surfaces:

- `ChatComputerUsePanel` (drawer under the chat composer) and `MissionComputerUsePanel` / `MissionProofPanel` (mission detail Proof tab).
- Review actions (`accepted` / `needs_more` / `dismissed` / `published`) remain as first-class per-artifact actions.
- Computer-use readiness moved into `IntegrationsSettingsSection` — the standalone `ComputerUseSection.tsx` is gone.

---

## 13. Multi-Device Sync

### 13.1 cr-sqlite CRDT + WebSocket

- **Desktop**: native cr-sqlite loadable extension (`.dylib`) loaded via `openKvDb(...)` in `kvDb.ts`.
- **iOS**: pure-SQL CRR emulation in `apps/ios/ADE/Services/Database.swift` — `crsql_master`, `crsql_site_id`, `crsql_changes`, per-table `<table>__crsql_clock` tables replicated as plain SQLite, with INSERT/UPDATE/DELETE triggers writing Lamport-versioned rows to `crsql_changes`. Custom SQLite functions (`ade_next_db_version()`, `ade_local_site_id()`, `ade_capture_local_changes()`) provide trigger context. Changesets are wire-compatible with desktop cr-sqlite.
- **Merge**: last-writer-wins per column. Each device has a unique site ID; Lamport timestamps per column.
- **Sync API** (`AdeDb.sync`): `getSiteId`, `getDbVersion`, `exportChangesSince(version)`, `applyChanges(changes)`.
- **Transport**: WebSocket on port 8787 (configurable); JSON-framed changesets + zlib compression for large batches; 30s ping/pong. The same envelope channel carries project catalog and project-switch handoff messages before the phone reconnects to a project-specific sync host.

### 13.2 Device model

- **Host**: one reachable desktop-class machine owns live execution side effects (agents, missions, PTYs, processes). Stored in the synced `sync_cluster_state` singleton row (`brain_device_id` is the legacy internal column name; user-facing language is "host"). Transfer requires a clean preflight (no active missions, running turns, live PTYs, running processes). Paused missions, CTO history, and idle chats are durable and survive handoff.
- **Controllers**: other connected devices (phones always; a second desktop optionally). Controllers read synced state and send commands to the host.
- **Independent desktops**: a second Mac can work independently through git without joining an ADE sync session. The tracked `.ade/` scaffold/config layer makes a clone look like an ADE project immediately.

### 13.3 iOS companion sync model

- App launch reads pairing secret from iOS Keychain.
- Opens WebSocket to host; sends local `db_version`; host sends catch-up changesets.
- `hello_ok` can include the host's mobile project catalog. The iOS app shows a native project home until an active project is selected, then requests a `project_switch_result` containing a project-specific bootstrap token and address candidates.
- Bidirectional sync continues; on disconnect, exponential-backoff reconnect with version catch-up. `reconnectIfPossible` is guarded against overlapping runs.
- All reads are local and scoped to the active project id — the iOS tab is instant and offline-capable after the selected project's row has hydrated.
- Writes from user actions: write locally, replicate to host. Execution commands (create PR, run command) are routed to the host via the `command`/`command_ack`/`command_result` message flow.
- Sub-protocols: changeset sync, project catalog/switch, file access, terminal stream, chat stream (live `chat_event` push from host), command routing, lane presence announce/release.
- Pairing is a **user-set 6-digit PIN** stored at `.ade/secrets/sync-pin.json` on the host. The phone sends the PIN once; the host returns a durable per-device secret. QR payload is v2 (host identity + port + address candidates, no pairing code).
- APNs pipeline: iOS registers device tokens (alert + push-to-start + per-activity update) via `SyncService.registerPushToken`. The host's `notificationEventBus` routes domain events (chat, PR, CTO, system) to `apnsService` for alert pushes and Live Activity update pushes, filtered by per-device `NotificationPreferences` stored in the iOS App Group `UserDefaults`.
- Widgets: `ADEWorkspaceWidget` (Home Screen), `ADELockScreenWidget`, `ADEControlWidget` (Control Center, iOS 18+) read from a shared `WorkspaceSnapshot` in the App Group container. `LiveActivityCoordinator` manages the single workspace Live Activity.
- Tabs: Lanes, Files, Work, PRs, CTO, Settings.

### 13.4 Conflict resolution semantics

- LWW per column via Lamport timestamps is the default merge.
- `ON CONFLICT(...)` upserts must target PK only (non-PK UNIQUE does not survive CRR retrofit).
- Non-PK merge cases use explicit select-then-update.
- After applying remote changesets that touch `unified_memories`, the local FTS index is rebuilt.

### 13.5 Secret isolation

- `.ade/local.secret.yaml` (API keys, ADE CLI configs), sync site ID, sync device ID, sync bootstrap token: **never sync**.
- Each device stores its own pairing secret in OS Keychain.
- Linear creds, GitHub tokens, provider API keys stay on the host.
- Commands from non-host devices validated and executed by the host only.

Full detail: [`docs/architecture/MULTI_DEVICE_SYNC.md`](../docs/architecture/MULTI_DEVICE_SYNC.md) and [`docs/architecture/IOS_APP.md`](../docs/architecture/IOS_APP.md).

---

## 14. Build, Test, Deploy

### 14.1 Monorepo layout

```
ADE/
├── apps/
│   ├── desktop/        # Electron main/preload/renderer (primary product)
│   ├── ade-cli/     # Headless ADE CLI (Node, JSON-RPC over stdio)
│   ├── web/            # Marketing + download landing (Vite + React)
│   └── ios/            # Native SwiftUI controller
├── docs/
│   ├── PRD.md
│   ├── architecture/   # Deep subsystem docs (source for this file)
│   ├── features/
│   └── final-plan/
├── new-docs/           # This file + feature docs
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

Root `package.json` is a thin aggregator: `npm test` runs desktop + ade-cli; `npm run test:ci` runs coverage on desktop + ade-cli.

Per-app scripts:

| App | Key scripts |
|-----|-------------|
| `apps/desktop` | `dev`, `build` (tsup + vite), `typecheck`, `test` (vitest), `lint` (ESLint), `dist:mac`, `dist:mac:universal:signed:zip`, `notarize:mac:dmg`, `validate:mac:artifacts`, `rebuild:native`, `version:ci`, `version:release`, `ade:dev`, `ade:build`, `ade:test`. |
| `apps/ade-cli` | `dev`, `build`, `typecheck`, `test`. |
| `apps/web` | `dev`, `build`, `preview`, `typecheck`. |
| `apps/ios` | Xcode project; tests via `xcodebuild test` / Xcode. |

### 14.2 CI (`.github/workflows/ci.yml`)

Stages:

1. **Install** (`install` job) — checkout, setup Node 22, parallel `npm ci` across desktop/ade-cli/web with shared cache keyed on all three lockfiles.
2. **Parallel checks**:
   - `secret-scan` — gitleaks on full history.
   - `typecheck-desktop` — `cd apps/desktop && npm run typecheck`.
   - `typecheck-ade-cli` — `cd apps/ade-cli && npm run typecheck`.
   - `typecheck-web` — `cd apps/web && npm run typecheck`.
   - `lint-desktop` — ESLint on `src/**/*.{ts,tsx}`.
   - `test-desktop` — **8-way shard matrix**: `npx vitest run --shard=${{ matrix.shard }}/8` across shards 1–8.
   - `test-ade-cli` — full ade-cli vitest.
   - `build` — all three apps built sequentially after install.
   - `validate-docs` — `node scripts/validate-docs.mjs`.
3. **Gate** (`ci-pass`) — all required jobs must pass (`if: always()` with failure/cancelled detection).

Sharding is required because the desktop suite is large enough to be slow in a single process. See memory: always shard test runs.

### 14.3 Test organization

- **Tooling**: Vitest with `node` environment, `pool: "forks"`, `maxForks: 4`, 20s test/hook timeouts.
- **Config**: `apps/desktop/vitest.config.ts` (base), plus project-specific configs for `unit-main`, `unit-renderer`, `unit-shared` when needed.
- **Test locations**: colocated with source (`*.test.ts` / `*.test.tsx`) under `src/**`.
- **Setup**: `apps/desktop/src/test/setup.ts` (browser/DOM mocks via `browserMock.ts`).
- **Philosophy** (from memory): only tests that carry real value; aggressive removal of brittle UI/render tests; keep mutation + integration coverage solid.
- **Smoke tests**: `orchestratorSmoke.test.ts` for complex mock orchestration flows; `packagedRuntimeSmoke.test.ts` for packaged runtime.

### 14.4 Packaging (Electron Builder)

macOS:

- `npm run dist:mac` — notarized .dmg for local distribution.
- `npm run dist:mac:universal:signed` — universal x64+arm64 signed builds.
- `npm run dist:mac:universal:signed:zip` — zip archive variant.

Windows:

- `npm run dist:win` — x64 installer via `electron-builder --win --x64`, wrapped with `validate:win:artifacts` (preflight) and `validate:win:release` (post-build) checks in `apps/desktop/scripts/validate-win-artifacts.mjs`.
- Windows-only wrappers for the bundled `ade` CLI ship in `apps/desktop/scripts/`: `ade-cli-windows-wrapper.cmd` (launcher) and `ade-cli-install-path.cmd` (idempotent PATH install helper). The platform-agnostic `.sh` wrapper covers macOS/Linux.
- The Windows installer bundles the prebuilt `cr-sqlite` native binary from `apps/desktop/vendor/crsqlite/win32-x64/` plus a Windows node-pty ConPTY worker.
- GitHub Actions `release-core.yml` builds and validates Windows artifacts; they are not currently code-signed or notarized.
- Ongoing Windows integration lane (rebase with `main`, smoke tests, backlog): `docs/development/windows-port-lane.md`.

Post-packaging hardening (`apps/desktop/scripts/`):

- `runtimeBinaryPermissions.cjs` — restores exec bits on `node-pty` spawn helpers, Codex vendor binaries, Claude SDK ripgrep helpers; patches `node-pty` `unixTerminal.js` for ASAR-unpacked paths.
- `after-pack-runtime-fixes.cjs` — electron-builder after-pack hook. Covers both platforms: runs the permissions pass on macOS and stages CLI wrappers + runtime shims on Windows.
- `validate-mac-artifacts.mjs` / `validate-win-artifacts.mjs` — per-platform artifact validators; confirm expected binaries and signing state.
- `notarize-mac-dmg.mjs` — Apple notarization.

### 14.5 Documentation

- **Internal docs** (this directory + `docs/`) — for engineers and agents. Not published.
- **Public docs site** — Mintlify, configured in `docs.json` at repo root. Content lives alongside the repo (`introduction.mdx`, `quickstart.mdx`, `welcome.mdx`, `key-concepts.mdx`, plus subdirs `getting-started/`, `guides/`, `lanes/`, `chat/`, `missions/`, `cto/`, `pull-requests/`, `configuration/`, `tools/`, `computer-use/`, `automations/`, `context-packs/`, `ai-tools/`). Theme `maple`, brand primary `#7C3AED`.
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
- **Usage tracking** — `usageTrackingService.ts` + `budgetCapService.ts` account for tokens and cost per provider/model/call-type; surfaced in Missions UI + Settings.
- **No external telemetry** — ADE does not ship analytics to any cloud service. All telemetry is local.

### 15.3 Error surfaces

- Every cleanup step is `try/catch` isolated — one failing service must not block shutdown.
- IPC handlers return structured errors, never crash the renderer.
- Mission and CTO UI components use try/catch around async loads with `isLoading`/`error` state and retry actions.
- Graceful degradation: when no provider is configured, AI surfaces show explanatory disabled state rather than spinning.
- Explicit fallbacks: Linear sync skips when no credentials/workflows; Linear ingress stays dormant without config; trivial session summaries skip AI entirely.

### 15.4 Observability / dev tools

- **Dev tools probe** — `devToolsService.ts` checks for `git` and `gh` CLI availability at startup, surfacing warnings in UI.
- **Port allocation** — `portAllocationService.ts` manages per-lane port leases with orphan recovery.
- **Runtime diagnostics** — `runtimeDiagnosticsService.ts` surfaces lane launch context and runtime state.
- **Context status stream** — push-based (`contextStatusChanged`) replaces earlier poll loop.
- **Embedding health** — polled at 10s intervals in Settings → Memory (raised from 1.5s to reduce renderer churn).
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

- System overview · [`docs/architecture/SYSTEM_OVERVIEW.md`](../docs/architecture/SYSTEM_OVERVIEW.md)
- Desktop runtime + startup · [`docs/architecture/DESKTOP_APP.md`](../docs/architecture/DESKTOP_APP.md)
- Data model + schema · [`docs/architecture/DATA_MODEL.md`](../docs/architecture/DATA_MODEL.md)
- AI integration + orchestrator · [`docs/architecture/AI_INTEGRATION.md`](../docs/architecture/AI_INTEGRATION.md)
- Configuration + trust · [`docs/architecture/CONFIGURATION.md`](../docs/architecture/CONFIGURATION.md)
- Security + privacy · [`docs/architecture/SECURITY_AND_PRIVACY.md`](../docs/architecture/SECURITY_AND_PRIVACY.md)
- Git engine · [`docs/architecture/GIT_ENGINE.md`](../docs/architecture/GIT_ENGINE.md)
- Memory · [`docs/architecture/MEMORY.md`](../docs/architecture/MEMORY.md)
- Context contract · [`docs/architecture/CONTEXT_CONTRACT.md`](../docs/architecture/CONTEXT_CONTRACT.md)
- Computer-use broker · [`docs/architecture/COMPUTER_USE_ARTIFACT_BROKER.md`](../docs/architecture/COMPUTER_USE_ARTIFACT_BROKER.md)
- Job engine · [`docs/architecture/JOB_ENGINE.md`](../docs/architecture/JOB_ENGINE.md)
- UI framework · [`docs/architecture/UI_FRAMEWORK.md`](../docs/architecture/UI_FRAMEWORK.md)
- Multi-device sync · [`docs/architecture/MULTI_DEVICE_SYNC.md`](../docs/architecture/MULTI_DEVICE_SYNC.md)
- iOS app · [`docs/architecture/IOS_APP.md`](../docs/architecture/IOS_APP.md)
- Feature docs (this directory) · [`new-docs/features/`](./features/)
- Product spec · [`docs/PRD.md`](../docs/PRD.md)

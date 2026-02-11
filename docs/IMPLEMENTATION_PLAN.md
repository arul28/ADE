# Implementation Plan

Last updated: 2026-02-11

This plan is the build order for ADE MVP. It is intentionally explicit about:

- what to build (desktop core, renderer UI, backend)
- which docs define the expected behavior
- exit criteria per phase so you know when to move on

UI source of truth:

- `features/UI_SPEC_LOCKED.md`
- `features/UI_COMPONENT_INVENTORY.md`
- `architecture/SYSTEM_OVERVIEW.md`

Coverage notes:

- Authentication is explicitly scoped to **Phase 5** (`authService` + Cognito Hosted UI + GitHub OAuth federation).
- All docs listed in `features/INDEX.md` and `architecture/INDEX.md` are represented in this plan.

## Phase -1: Repo + Desktop Scaffold (Start From Nothing)

Status: DONE (2026-02-10)

References:

- Desktop structure: `architecture/DESKTOP_APP.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- UI component inventory: `features/UI_COMPONENT_INVENTORY.md`
- Onboarding/trust: `features/ONBOARDING_TRUST.md`

Scope:

- Create a production-shaped desktop app structure even if most features are stubs.
- Set up the renderer tech stack locked in `UI_SPEC_LOCKED.md`.

Desktop core (main process):

- Create the Electron main process skeleton with secure defaults.
- Create preload bridge with strict allowlist.
- Add an internal logging utility (structured logs; write to `.ade/logs/`).

Renderer UI:

- Implement `AppShell` with:
  - top bar (project selector placeholder)
  - left tab nav (initial core tabs exist; feature tabs can be added in later phases)
  - main content area
- Implement Lanes cockpit layout skeleton:
  - 3 resizable panes + right inspector with sub-tabs
- Add a minimal command palette (modal with a few actions).

Persistence:

- Add local DB bootstrap (SQLite file stored under `.ade/` local state).
- Persist pane sizes/layout per project.

Exit criteria:

- App launches and shows initial core shell/navigation with tab routing.
- Resizable 3-pane layout works and persists after restart (even with placeholder content).

Checklist:

- [x] Scaffold `apps/desktop` with dev scripts (`dev`, `build`, `typecheck`)
- [x] Install UI stack deps per `UI_SPEC_LOCKED.md` (routing/state/panes/primitives/icons)
- [x] Implement `AppShell`, `TopBar`, `TabNav`
- [x] Implement split pane primitives and persist sizes per project
- [x] Create component folder structure per `UI_COMPONENT_INVENTORY.md`
- [x] Preload bridge with `app.ping() -> "pong"`
- [x] Settings tab placeholder (shows versions + environment)

Verification:

- `cd apps/desktop && npm run dev`
- Open **Lanes**, resize the 3 panes, quit/relaunch, confirm layout persists.
- Open **Settings**, confirm versions/environment render.

## Phase 0: Terminals + Session Tracking (Gating)

Status: DONE (2026-02-11)

References:

- Terminals: `features/TERMINALS_AND_SESSIONS.md`
- Terminal command center: `features/TERMINAL_COMMAND_CENTER.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- UI component inventory: `features/UI_COMPONENT_INVENTORY.md`
- Security/privacy: `architecture/SECURITY_PRIVACY.md`

Scope:

- Make embedded terminals reliable and scalable first. Everything else depends on this.

Desktop core (main process):

- Implement `ptyService`:
  - create PTY session (cwd = lane worktree path)
  - stream output to renderer
  - accept input from renderer
  - resize
  - dispose
- Implement `sessionService`:
  - store session metadata (start/end, exit code, tool type, label/goal)
  - capture transcript to `.ade/transcripts/` (local-only by default)

IPC (typed):

- `pty.create({ laneId, cols, rows, title }) -> { ptyId }`
- `pty.write({ ptyId, data }) -> void`
- `pty.resize({ ptyId, cols, rows }) -> void`
- `pty.dispose({ ptyId }) -> void`
- Event: `pty.data({ ptyId, data })`
- Event: `pty.exit({ ptyId, exitCode })`

Security defaults (Phase 0):

- Renderer cannot read files or spawn processes directly.
- Preload exposes only explicit terminal/session APIs (strict allowlist).
- Transcripts remain local unless the user explicitly enables uploads/redaction. See `architecture/SECURITY_PRIVACY.md`.

Renderer UI:

- Implement `TerminalView` (xterm wrapper) and connect it to PTY IPC.
- Implement Terminals tab list view:
  - global session list with filters
  - jump-to-lane behavior (navigates to Lanes tab and focuses session)
- Implement Lanes inspector Terminals tab:
  - lane-scoped session tabs
  - only render an active xterm for the focused session (others show lightweight preview)

Exit criteria:

- Can run 3 concurrent terminals and type/resize reliably.
- Session end events are captured with metadata + transcript path.

Checklist:

- [x] IPC channels for PTY streaming are implemented and typed
- [x] Global Terminals list supports high session volume (filters + lightweight rows)
- [x] Transcript capture persists to local `.ade/transcripts/` (local-only by default)
- [x] Lane-scoped session list works in the Lanes inspector Terminals tab

## Phase 1: Project Onboarding + Lanes Cockpit + Diffs

Status: DONE (2026-02-11)

References:

- Navigation/layout: `features/NAVIGATION_AND_LAYOUT.md`
- Lanes: `features/LANES.md`
- File viewer/diff/quick edit: `features/FILE_VIEWER_DIFF_QUICK_EDIT.md`
- Onboarding/trust: `features/ONBOARDING_TRUST.md`
- Git engine: `architecture/GIT_ENGINE.md`
- Data model: `architecture/DATA_MODEL.md`
- Configuration: `architecture/CONFIGURATION.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- User can open a repo, create lanes (worktrees), see changes, and operate from the Lanes tab.

Desktop core:

- Implement `projectService`:
  - open repo path
  - detect default base branch
  - initialize local `.ade/` state and `.git/info/exclude` rule
- Implement `laneService`:
  - create lane (branch + worktree)
  - rename, archive
  - compute status:
    - dirty
    - ahead/behind
    - base ref
- Implement `diffService`:
  - working tree diff and staged diff
  - commit diff (latest N)

Renderer UI:

- Lanes tab:
  - lane list (`LaneList`, `LaneRow`, badges)
  - lane inspector tabs exist and can deep link to Conflicts/PR
- Center pane changes view:
  - diff viewer (MVP: monaco diff or simpler diff list)
  - file tree toggle
  - quick edit for small changes

Exit criteria:

- Can open a repo, create 2-3 lanes, run terminals in each lane, and see accurate dirty/ahead/behind.
- Diff viewer shows lane changes and supports small quick edits.

Checklist:

- [x] Lane list shows badges per `UI_SPEC_LOCKED.md` (dirty, ahead/behind)
- [x] Lane “open folder” works
- [x] Lane inspector exists with sub-tabs (Terminals/Packs/Conflicts/PR)
- [x] Diff viewer for working tree + staged (Monaco diff + quick edit for unstaged files)

## Phase 1.5: Workspace Topology + Lane Modes (Primary, Worktree, Attached)

Status: NOT STARTED

References:

- Workspace graph: `features/WORKSPACE_GRAPH.md`
- Navigation/layout: `features/NAVIGATION_AND_LAYOUT.md`
- Lanes: `features/LANES.md`
- Data model: `architecture/DATA_MODEL.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Support all lane/workspace modes:
  - primary lane (main repository directory)
  - dedicated worktree lanes
  - attached existing worktree lanes
- Add workspace topology model and graph/canvas foundations.

Desktop core:

- Implement workspace service/model:
  - register primary workspace on onboarding
  - discover and import git worktrees
  - attach existing worktree paths as lanes
- Extend `laneService`:
  - lane type metadata (`primary|worktree|attached`)
  - lane -> workspace linkage
  - safe archive semantics for primary lane

Renderer UI:

- Lanes left panel:
  - topology mode toggle (`list`, `stack graph`, `workspace canvas`)
- Workspace canvas MVP:
  - centered primary node
  - connected worktree nodes
  - click to focus lane details

Exit criteria:

- User can work in main directory as a first-class lane.
- User can create/import attached worktree lanes and manage them from same UI.
- Workspace topology view reflects all known lanes and directories.

Checklist:

- [ ] Primary lane created automatically on project import
- [ ] Worktree discovery and attach flow
- [ ] Lane type badges in lane list
- [ ] Workspace canvas MVP rendering + focus interactions

## Phase 1.6: Files Workbench Tab (Explorer + Editor)

Status: NOT STARTED

References:

- Files workbench: `features/FILE_VIEWER_DIFF_QUICK_EDIT.md`
- Navigation/layout: `features/NAVIGATION_AND_LAYOUT.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- UI inventory: `features/UI_COMPONENT_INVENTORY.md`
- Git operations: `features/GIT_OPERATIONS.md`

Scope:

- Add dedicated Files tab for IDE-style explorer/editing workflows.
- Support selecting primary workspace and all open lane workspaces.
- Keep lane center quick edit, but move deeper editing workflows to Files tab.

Desktop core:

- Implement files service additions:
  - list tree for selected workspace scope
  - read/write file content (atomic save)
  - diff endpoints (working/staged/commit)
  - scoped stage/unstage helpers
- Ensure save and stage operations emit lane status/conflict refresh triggers.

Renderer UI:

- Add Files tab route in app shell.
- Implement workbench layout:
  - workspace scope selector
  - file explorer tree
  - Monaco editor and diff panes
  - context panel with quick stage/unstage and jump links

Exit criteria:

- User can browse/edit files in main directory and any open lane workspace.
- User can view staged/unstaged/commit diffs from Files tab.
- Save operations are atomic and reflected in lane/conflict status quickly.

Checklist:

- [ ] Files tab exists in nav and routing
- [ ] Workspace scope selector (primary + lanes + attached worktrees)
- [ ] Explorer tree + file open/edit/save flow
- [ ] Diff panes for working/staged/commit
- [ ] Quick stage/unstage in Files context panel

## Phase 2: Project Home (Processes + Test Buttons) (SoloTerm-like)

Status: DONE (2026-02-11)

References:

- Processes/tests: `features/PROCESSES_AND_TESTS.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- Configuration: `architecture/CONFIGURATION.md`
- Data model: `architecture/DATA_MODEL.md`
- Security/privacy: `architecture/SECURITY_PRIVACY.md`

Scope:

- Provide a SoloTerm-like project control plane:
  - process visibility and lifecycle controls (including kill)
  - stack buttons (`Backend`, `Frontend`, `Full Stack`, etc.)
  - test suite buttons with persisted run history
  - persistent config with shared + local overrides

Desktop core:

- Implement `processService`:
  - spawn/stop/restart/kill managed processes
  - capture logs to `.ade/logs/`
  - runtime status events + persisted process run records
  - readiness checks (MVP supports none/port/logRegex)
  - stack-button start/stop orchestration
- Implement `testService`:
  - run test suites
  - store run history, duration, timestamps, and exit codes
  - persist logs to `.ade/logs/tests/`
  - emit live run events for Home tab updates
- Implement `projectConfigService`:
  - read/validate/save `.ade/ade.yaml` + `.ade/local.yaml`
  - merge effective config
  - trust confirmation flow when shared config changes

Renderer UI:

- Projects (Home) tab:
  - stack button row + `Start all`/`Stop all`
  - managed process list + per-process controls (`Start/Stop/Restart/Kill`)
  - process detail/log viewer (tail + search)
  - test suite buttons with last run badges
- Settings/config:
  - edit process definitions, stack buttons, and test suites
  - write validated config to `.ade/` files

Exit criteria:

- Can start/stop/restart/kill any managed process from Home tab.
- Can execute stack buttons that target configured process subsets.
- Can run unit/lint/integration/e2e/custom test suites via buttons and see persisted last run status.
- Process/test logs are searchable in UI and persisted to `.ade/logs/`.

Checklist:

- [x] `processService` supports start/stop/restart/kill + runtime event streaming
- [x] Stack button engine supports named process subsets + start all/stop all
- [x] `testService` supports suite runs with persisted history/logs
- [x] Home tab renders process controls, stack buttons, and test suite buttons
- [x] Process/test config editor writes validated `.ade/` config
- [x] Trust prompt blocks execution of changed shared config until confirmed
- [x] Logs viewer supports search across process and test logs
- [x] Theme toggle supports dark/light UI modes in Projects (Home)
- [x] Theme preference persists locally across renderer reload/restart

Verification:

- `cd apps/desktop && npm run typecheck`
- `cd apps/desktop && npm run build`
- `cd apps/desktop && npm run dev` (manual smoke)
- Manual smoke:
  - Start/stop/restart/kill single process.
  - Start/stop stack subset and start/stop all.
  - Run/rerun/stop test suites and verify persisted history badges.
  - Confirm trust prompt blocks execution after shared config mutation.
  - Confirm process/test logs stream and search.
  - Confirm dark/light toggle applies and persists after app restart.

## Phase 2.5: In-App Git Operations (Stage/Commit/Stash/Push)

Status: NOT STARTED

References:

- Git operations: `features/GIT_OPERATIONS.md`
- Lanes: `features/LANES.md`
- File viewer/diff/quick edit: `features/FILE_VIEWER_DIFF_QUICK_EDIT.md`
- Git engine: `architecture/GIT_ENGINE.md`
- Security/privacy: `architecture/SECURITY_PRIVACY.md`

Scope:

- Expose routine git actions directly in ADE UI (lane-scoped where applicable).
- Keep renderer untrusted; execute git operations in main process via typed intents.
- Support branch management inside lanes (including primary lane safeguards).

Desktop core:

- Extend git/lane services for in-app source control actions:
  - stage/unstage
  - commit/amend/revert/cherry-pick
  - stash push/pop/apply/drop
  - fetch/sync/push/force-with-lease
  - branch create/switch/rename/delete
- Persist operation metadata for history/undo surfaces (pre/post SHA where possible).

Renderer UI:

- Add source control action surfaces in Lanes:
  - file-level stage/unstage/discard actions
  - commit composer + amend flow
  - stash controls
  - push/sync actions with confirmations for destructive ops
  - branch switcher and branch management actions

Exit criteria:

- User can complete daily git workflow (stage -> commit -> push -> sync) from ADE without dropping to external terminal.
- User can switch and manage branches in-lane with safety checks for dirty/running-session states.

Checklist:

- [ ] Stage/unstage file actions are wired in UI
- [ ] Commit/amend UI flow works lane-scoped
- [ ] Stash operations work with list/apply/pop/drop
- [ ] Push + force-with-lease flow works with explicit confirmation
- [ ] Revert and cherry-pick actions are available from UI
- [ ] Branch create/switch/rename/delete flows exist in lane UI
- [ ] Dirty/running-session branch-switch safeguards work reliably
- [ ] Operations are recorded for History timeline

## Phase 3: Comprehensive Packs + Checkpoints + Plan Versioning (All At Once)

Status: NOT STARTED

References:

- Packs: `features/PACKS.md`
- Job engine: `architecture/JOB_ENGINE.md`
- Terminal command center: `features/TERMINAL_COMMAND_CENTER.md`
- Data model: `architecture/DATA_MODEL.md`
- History graph: `features/HISTORY_GRAPH.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Deliver the full packs system in one implementation phase:
  - immutable checkpoints
  - append-only pack events
  - immutable pack versions + pack heads
  - materialized current views
  - plan versioning with compare/revert
  - feature history timeline foundations

Desktop core:

- Implement checkpoint capture service:
  - create immutable checkpoint on session end and commit boundaries
  - include SHAs, deterministic deltas, tool/session metadata, validation context
- Expand `packService` to versioned model:
  - write immutable pack versions for project/lane/feature/conflict/plan packs
  - update pack head pointers atomically
  - maintain fast materialized current pack files
- Implement planning version service:
  - immutable plan versions
  - activate/revert versions
  - emit plan lifecycle events
- Expand `jobEngine` pipeline:
  - checkpoint creation + event append + materialization
  - feature pack updates when issue/feature linkage exists
- Persist all lifecycle events for history graph queries.

Renderer UI:

- Lane inspector Packs tab:
  - current pack viewer
  - pack version history
  - compare selected versions
  - source traceability (which checkpoints/events fed this version)
- Plan surfaces:
  - plan version list
  - activate/revert controls
  - handoff prompt blocks per phase and full plan
- History tab (MVP foundation in this phase):
  - timeline of checkpoints + pack events + plan revisions
  - filters by lane/feature/event type

Exit criteria:

- Every completed terminal session yields a durable checkpoint with SHA anchors.
- Pack data is append-only and auditable (no in-place history mutation).
- Lane/project/feature/conflict/plan packs materialize within seconds after session end.
- User can compare plan versions and switch active version.
- User can inspect feature history derived from all sessions so far.

Checklist:

- [ ] Checkpoint schema + writer + validation
- [ ] Pack events append-only log
- [ ] Pack versions storage + head pointers
- [ ] Materializers for all pack types (project/lane/feature/conflict/plan)
- [ ] Plan versioning (create/compare/activate/revert)
- [ ] Packs UI: current + history + diff + traceability
- [ ] History timeline foundation wired to checkpoints/events/plan versions
- [ ] Backfill/migration path from existing `packs_index` model

## Phase 4: Conflict Radar + Guided Sync + Conflicts UI

References:

- Conflict radar: `features/CONFLICT_RADAR.md`
- Conflict resolution: `features/CONFLICT_RESOLUTION.md`
- Workspace graph: `features/WORKSPACE_GRAPH.md`
- Git engine: `architecture/GIT_ENGINE.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`
- History graph: `features/HISTORY_GRAPH.md` (operations timeline data)

Scope:

- Predict conflicts early and show GitButler-like lane badges.
- Provide guided sync and conflict packs (deterministic).
- Add pairwise lane-lane conflict risk and merge simulation.
- Add near-real-time conflict updates from staged/dirty changes.

Desktop core:

- Implement `conflictPredictionService` (dry-run):
  - per lane vs base
  - pairwise lane vs lane risk snapshots
  - store predicted conflict files
- Implement staged/dirty change watchers with coalesced prediction refresh.
- Implement `mergeSimulationService`:
  - lane -> lane and lane -> branch dry-run simulations
- Implement `syncService`:
  - merge default, rebase optional
  - operation records with pre/post SHA for undo
- Implement `conflictPackService`:
  - build conflict pack for predicted conflicts
  - build conflict pack for active merge/rebase conflicts

Renderer UI:

- Lanes tab:
  - conflict predicted/active badges on `LaneRow`
  - pairwise overlap/risk hints in workspace canvas
  - lane Conflicts inspector tab shows file list + CTA to open conflicts window
- Conflicts tab:
  - aggregate list + pairwise risk matrix + detail viewer + merge simulation panel + pack viewer

Exit criteria:

- Conflicts appear in Lanes tab without the user clicking anything.
- Risk updates react within seconds to staged/dirty changes (coalesced).
- Sync lane with base is guided and undoable.

Checklist:

- [ ] Conflict prediction runs on session end and base updates (best-effort)
- [ ] Pairwise lane risk matrix is computed and visible
- [ ] Merge simulation supports lane -> lane and lane -> branch
- [ ] Staged/dirty watchers trigger coalesced prediction refresh
- [ ] Conflicts tab is navigable and shows conflict packs + simulation
- [ ] Undo last sync works reliably

## Phase 5: Hosted Agent (AWS) + Auth + Mirror Sync + Proposal Flow

References:

- Hosted agent: `architecture/HOSTED_AGENT.md`
- Cloud backend (AWS): `architecture/CLOUD_BACKEND.md`
- AWS stack decision: `architecture/AWS_STACK_DECISION.md`
- Security/privacy: `architecture/SECURITY_PRIVACY.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Deploy AWS backend with SST.
- Desktop authenticates via Cognito Hosted UI GitHub login.
- Mirror sync uploads blobs/manifests to S3.
- Conflicts tab can request a proposal job and display proposals.

Backend (AWS via SST):

- Cognito user pool + hosted UI + GitHub OAuth federation.
- API Gateway + Lambda endpoints:
  - create/register project
  - presigned S3 uploads for blobs
  - upload manifest (snapshot)
  - enqueue job
  - poll jobs
  - fetch artifact metadata + signed download
- DynamoDB tables for metadata + jobs + artifacts.
- SQS queue + worker Lambda that:
  - reads mirror state from S3
  - calls provider-agnostic LLM gateway module
  - writes artifacts (narratives, patch diffs) back to S3

Desktop core:

- Implement `authService`:
  - open browser to hosted UI
  - loopback callback capture
  - token storage in OS keychain
- Implement `mirrorSyncService`:
  - exclude patterns
  - forced sync on session end
  - coalesced sync (threshold)
- Implement `hostedJobsClient`:
  - enqueue proposal job for a conflict pack
  - poll status and download artifacts

Renderer UI:

- Settings:
  - hosted agent enable/disable
  - mirror excludes editor
- Conflicts tab:
  - “Generate proposals” + progress
  - proposals list + diff viewer + apply controls

Exit criteria:

- Can sign in via GitHub and register a project.
- Can sync a lane snapshot to S3.
- Can request a conflict proposal job and display the proposed patch.

Checklist:

- [ ] SST deploy works for `dev` stage
- [ ] Cognito GitHub login works from desktop
- [ ] Presigned upload path works for blobs and manifests
- [ ] Worker consumes jobs and writes artifacts
- [ ] Desktop can fetch proposals and show them as diffs

## Phase 6: GitHub PR Integration

References:

- PRs: `features/PULL_REQUESTS_GITHUB.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Create/link PR per lane and show status; global PRs tab shows stacked chains + parallel list.

Desktop core:

- Implement `prService`:
  - link PR metadata to lane
  - create PR (GitHub API)
  - poll checks/reviews status
- Implement `prDescriptionService`:
  - draft from deterministic packs
  - optionally add hosted narrative sections

Renderer UI:

- Lane inspector PR tab:
  - create/link, status, update description
- PRs tab:
  - stacked chain view (aligned to stack graph)
  - parallel PR list

Exit criteria:

- Lane -> PR flow works end-to-end.

Checklist:

- [ ] PR create/link/update
- [ ] Status chips for checks/reviews
- [ ] PRs tab skeleton and navigation

## Phase 7: Stacks + Restack + Land Stack (V1)

References:

- Stacks/restack: `features/STACKS_AND_RESTACK.md`
- PR stacking: `features/PULL_REQUESTS_GITHUB.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Make stacked lanes and restack flows first-class and aligned with PR chains.
- Support stacks where parent lane can be primary/worktree/attached.

Desktop core:

- Implement stack model persistence (parent/child).
- Implement restack operation (dependency order).

Renderer UI:

- Stack graph is real (not placeholder) and shows blocked lanes.
- PRs tab chain aligns with stack graph.

Exit criteria:

- Parent changes can be propagated to children with a single restack action.

Checklist:

- [ ] Create stacked lane flow
- [ ] Attach existing lane as child in stack
- [ ] Restack action with progress UI
- [ ] Land stack flow (guided) (V1)

## Phase 8: Automations + Actions

References:

- Automations: `features/AUTOMATIONS_ACTIONS.md`
- Job engine: `architecture/JOB_ENGINE.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Allow users to wire triggers to actions (packs/tests/sync).

Desktop core:

- Implement scheduler (cron-like or presets).
- Implement action runner and logs.

Renderer UI:

- Settings tab includes automations enable/disable and last-run status.

Exit criteria:

- A scheduled test run works and is visible in UI.

Checklist:

- [ ] `actions.yaml` schema and persistence
- [ ] Scheduler + logs

## Phase 9: History Graph V1 (Advanced Views and Replay)

References:

- History graph: `features/HISTORY_GRAPH.md`
- Locked UI spec: `features/UI_SPEC_LOCKED.md`

Scope:

- Build advanced graph visualizations on top of Phase 3 history foundations.
- Add replay and deep search experiences.

Desktop core:

- Add optimized query/index helpers for large history volumes.
- Add context replay helpers (checkpoint to new session seed).

Renderer UI:

- Graph view (stack + operations + feature links)
- Advanced search across checkpoints/events/pack versions/plan versions
- Context replay action from history detail views

Exit criteria:

- User can visualize and navigate complex multi-lane and multi-feature history.
- User can replay prior context into a fresh session without manual copy/paste.

Checklist:

- [ ] Graph view
- [ ] Search across history artifacts
- [ ] Context replay entrypoint
